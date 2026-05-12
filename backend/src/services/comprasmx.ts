import fs from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Download, type Locator, type Page } from "playwright";

const SOURCE_URL =
  "https://comprasmx.buengobierno.gob.mx/sitiopublico/#/";
const TZ = "America/Mexico_City";

/** Máximo de páginas de detalle `/procedimiento` a abrir por petición cuando hay `palabrasClave`. */
export const DEFAULT_MAX_PROCEDIMIENTO_DETALLE = 25;

function maxProcedimientoDetalle(): number {
  const raw = process.env.COMPRASMX_MAX_PROCEDIMIENTO_DETALLE?.trim();
  const n = raw ? parseInt(raw, 10) : DEFAULT_MAX_PROCEDIMIENTO_DETALLE;
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_PROCEDIMIENTO_DETALLE;
  return Math.min(n, 100);
}

/** Evita dos snapshots a la vez (misma CPU, timeouts y estado del SPA → respuestas distintas). */
let snapshotRunLock: Promise<unknown> = Promise.resolve();

/** Nombres exactos como aparecen en el multiselect del sitio */
export const ENTIDADES_FEDERATIVAS_FILTRO = [
  "BAJA CALIFORNIA",
  "BAJA CALIFORNIA SUR",
  "SONORA",
  "CIUDAD DE MÉXICO",
  "CHIHUAHUA",
  "COLIMA",
  "DURANGO",
  "JALISCO",
  "NAYARIT",
  "SINALOA",
  "YUCATÁN",
] as const;

function normEntidadNombre(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
}

const ENTIDAD_CANONICA_POR_NORMALIZADO: ReadonlyMap<string, string> = new Map(
  ENTIDADES_FEDERATIVAS_FILTRO.map((e) => [normEntidadNombre(e), e]),
);

/**
 * Interpreta `entidadesFederativas` del cliente.
 * Sin campo / `null` → el caller usa el arreglo por defecto del servicio.
 * Arreglo vacío o valores inválidos → `error`.
 */
export function parseEntidadesFederativasCliente(raw: unknown): { values?: string[]; error?: string } {
  if (raw === undefined || raw === null) return {};
  if (!Array.isArray(raw)) {
    return { error: "entidadesFederativas debe ser un arreglo de cadenas (nombres de estado)" };
  }
  if (raw.length === 0) {
    return {
      error:
        "Si envías entidadesFederativas, incluye al menos un estado; omite la propiedad para usar el filtro predeterminado del servicio.",
    };
  }
  const out: string[] = [];
  const invalid: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string" || !item.trim()) {
      invalid.push(typeof item === "string" ? "(vacío)" : String(item));
      continue;
    }
    const canon = ENTIDAD_CANONICA_POR_NORMALIZADO.get(normEntidadNombre(item));
    if (canon) {
      if (!out.includes(canon)) out.push(canon);
    } else {
      invalid.push(item.trim());
    }
  }
  if (invalid.length) {
    return {
      error: `Entidades no reconocidas: ${invalid.join(", ")}. Valores admitidos: ${ENTIDADES_FEDERATIVAS_FILTRO.join(", ")}.`,
    };
  }
  return { values: out };
}

export type ComprasmxAnexo = {
  titulo: string;
  /** Enlace directo si el DOM lo expone (poco frecuente en ANEXOS). */
  urlDescarga?: string;
  /** Ruta absoluta tras hacer clic en el icono PrimeNG `pi-download` (Playwright `download.saveAs`). */
  archivoLocal?: string;
};

export type ComprasmxDetalleProcedimiento = {
  numeroProcedimientoContratacion: string | null;
  datosGenerales: {
    dependenciaOEntidad: string | null;
    descripcionDetallada: string | null;
    nombreProcedimiento: string | null;
  };
  cronograma: {
    presentacionAperturaProposiciones: string | null;
    limiteAclaracionesComprasmx: string | null;
    aplicaJuntaAclaraciones: string | null;
    fechaHoraActoFallo: string | null;
  };
  entidadFederativaContratacion: string | null;
  anexos: ComprasmxAnexo[];
  error?: string;
};

export type ComprasmxFila = {
  numeroIdentificacion: string;
  nombre: string;
  /** URL absoluta del detalle (columna expediente / número de identificación), si existe enlace. */
  urlProcedimiento?: string;
  detalleProcedimiento?: ComprasmxDetalleProcedimiento;
};

export type ComprasmxSnapshot = {
  source: string;
  fetchedAt: string;
  filtros: {
    fechaPublicacionDesde: string;
    fechaPublicacionHasta: string;
    entidadesFederativas: string[];
    /** Pestaña de resultados usada antes de aplicar filtros (`COMPRASMX_TAB`) */
    pestanaResultados: "vigentes" | "seguimiento" | "concluidos";
    /** Solo cuando el cliente envía palabras clave: filas devueltas = coincidencias (hasta el límite de detalle). */
    palabrasClave?: string[];
    /** Límite aplicado al abrir vistas de detalle (por defecto 25, `COMPRASMX_MAX_PROCEDIMIENTO_DETALLE`). */
    detalleProcedimientoMax?: number;
    /** Filas del listado cuyo nombre coincide con alguna palabra clave (antes del recorte por límite). */
    coincidenciasListadoKeyword?: number;
    /** Coincidencias que no se procesaron por superar el límite. */
    detallesOmitidosPorLimite?: number;
  };
  /** Valores de los inputs de fecha antes de Buscar (si están vacíos, el filtro de publicación no se aplicará). */
  valoresFormularioDetectados: {
    fechaDesdePublicacion: string;
    fechaHastaPublicacion: string;
  };
  /** Una entrada por fila visible en la página actual del resultado */
  filas: ComprasmxFila[];
  totalFilas: number;
  /** Total leído del texto "Total: N" bajo la tabla (null si no se detectó a tiempo). */
  totalEnPieDePortal: number | null;
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** `COMPRASMX_FAST=0` usa las pausas literales (más estable, más lento). */
function fastMode(): boolean {
  return process.env.COMPRASMX_FAST !== "0";
}

/** En modo rápido (default) escala ~10%: prioriza velocidad; use `COMPRASMX_FAST=0` si falla en red lenta. */
function delay(ms: number): Promise<void> {
  if (!fastMode()) return sleep(ms);
  const scaled = Math.floor(ms * 0.1);
  return sleep(scaled > 0 ? scaled : ms > 0 ? 1 : 0);
}

function fechaHoyDdMmYyyy(): string {
  const parts = new Intl.DateTimeFormat("es-MX", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    timeZone: TZ,
  }).formatToParts(new Date());
  const pick = Object.fromEntries(
    parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]),
  ) as Record<"day" | "month" | "year", string>;
  return `${pick.day}/${pick.month}/${pick.year}`;
}

/** Valida y normaliza `DD/MM/AAAA` para el filtro del portal. */
export function parseFechaFiltradoDdMmYyyy(s: string): string | null {
  const t = s.trim();
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  if (!m) return null;
  const d = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  const y = parseInt(m[3]!, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`;
}

/** `YYYY-MM-DD` → `DD/MM/AAAA` (mismo día civil, sin ambigüedad de zona). */
export function fechaIsoAMexicoDdMmYyyy(iso: string): string | null {
  const t = iso.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return null;
  const y = parseInt(m[1]!, 10);
  const mo = parseInt(m[2]!, 10);
  const d = parseInt(m[3]!, 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || y < 2000 || y > 2100) return null;
  return `${String(d).padStart(2, "0")}/${String(mo).padStart(2, "0")}/${y}`;
}

function pestanaEnv(): "vigentes" | "seguimiento" | "concluidos" {
  const raw = (process.env.COMPRASMX_TAB ?? "vigentes").toLowerCase();
  if (raw === "seguimiento") return "seguimiento";
  if (raw === "concluidos") return "concluidos";
  return "vigentes";
}

/**
 * En el sitio, "Anuncios vigentes" suele ser un **checkbox**; "en seguimiento" / "concluidos" son **tabs**.
 */
async function configurarVistaListado(page: Page, pestana: "vigentes" | "seguimiento" | "concluidos") {
  if (pestana === "vigentes") {
    const cb = page.getByRole("checkbox", { name: /Anuncios vigentes/i }).first();
    if (await cb.isVisible().catch(() => false)) {
      if (!(await cb.isChecked().catch(() => false))) {
        await cb.check({ force: true });
        await delay(120);
      }
    }
    return;
  }
  if (pestana === "seguimiento") {
    const tab = page.getByRole("tab", { name: /Anuncios en seguimiento/i }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 15_000 });
    await delay(160);
    return;
  }
  const tab = page.getByRole("tab", { name: /Anuncios concluidos/i }).first();
  if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 15_000 });
  await delay(160);
}

function soloDigitosFecha(s: string): string {
  return s.replace(/\D/g, "");
}

function fechasValorEquivalentes(valorInput: string, esperadoDdMmYyyy: string): boolean {
  const a = valorInput.trim();
  const e = esperadoDdMmYyyy.trim();
  if (!a || !e) return false;
  return a === e || soloDigitosFecha(a) === soloDigitosFecha(e);
}

async function establecerValorInputAngular(page: Page, name: string, val: string): Promise<void> {
  await page.evaluate(
    `(function(p){var el=document.querySelector('input[name="'+p.n+'"]');if(!el||el.tagName!=='INPUT')return;el.focus();el.value=p.v;['input','change','blur'].forEach(function(ev){el.dispatchEvent(new Event(ev,{bubbles:true}))})})(${JSON.stringify({ n: name, v: val })})`,
  );
}

/** Si PrimeNG acepta el valor vía DOM, evita calendario y tecleo lento. */
async function intentarEstablecerFechasPublicacionEvaluate(
  page: Page,
  fechaDesde: string,
  fechaHasta: string,
): Promise<boolean> {
  await establecerValorInputAngular(page, "fechaDesdeP", fechaDesde);
  await establecerValorInputAngular(page, "fechaHastaP", fechaHasta);
  await delay(fastMode() ? 12 : 35);
  const d = (await page.locator('input[name="fechaDesdeP"]').inputValue().catch(() => "")).trim();
  const h = (await page.locator('input[name="fechaHastaP"]').inputValue().catch(() => "")).trim();
  return fechasValorEquivalentes(d, fechaDesde) && fechasValorEquivalentes(h, fechaHasta);
}

/** PrimeNG/ngModel suele ignorar sólo .fill(): teclado + disparo DOM + último recurso clic en calendario. */
async function establecerFechaPublicacionCampo(page: Page, name: string, fecha: string): Promise<void> {
  const { day, month, year } = (() => {
    const parts = fecha.split("/").map((x) => parseInt(x, 10));
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) throw new Error("fecha debe ser DD/MM/AAAA");
    return { day: parts[0]!, month: parts[1]!, year: parts[2]! };
  })();

  const loc = page.locator(`input[name="${name}"]`);
  await loc.waitFor({ state: "visible" });
  await loc.click();
  await loc.press("Control+a");
  await loc.pressSequentially(fecha, { delay: fastMode() ? 4 : 14 });
  await loc.press("Tab");
  await delay(140);

  if (fechasValorEquivalentes(await loc.inputValue(), fecha)) return;

  await establecerValorInputAngular(page, name, fecha);
  await delay(90);
  if (fechasValorEquivalentes(await loc.inputValue(), fecha)) return;

  await loc.click({ force: true });
  await page.keyboard.press("Escape").catch(() => {});
  await delay(50);
  await loc.click({ force: true });
  await page.locator(".p-datepicker").first().waitFor({ state: "visible", timeout: 15_000 });
  await delay(90);

  for (let _g = 0; _g < 32; _g++) {
    const title = await page.locator(".p-datepicker .p-datepicker-title").first().textContent().catch(() => "") ?? "";
    const t = title.toLowerCase().replace(/\./g, "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");

    let curM = 0;
    let curY = 0;
    const meses = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
    const mesNorm = meses.map((m) => m.normalize("NFD").replace(/[\u0300-\u036f]/g, ""));

    let idx = mesNorm.findIndex((m) => t.includes(m));
    if (idx < 0) {
      idx = meses.findIndex((m) => title.toLowerCase().includes(m.slice(0, 3)));
    }

    curM = idx >= 0 ? idx + 1 : 0;
    const ym = /\b(20\d{2})\b/.exec(title);
    if (ym) curY = parseInt(ym[1]!, 10);

    if (curY === year && curM === month) break;

    const goNext =
      curY === 0 || curM === 0
        ? true
        : curY < year || (curY === year && curM < month);

    const nextBt = page
      .locator(
        "[data-pc-section='monthnavigator'] button:last-child,[data-pc-section='nextbutton'],button.p-datepicker-next,[aria-label*='Next'],[aria-label*='Siguiente']",
      )
      .first();
    const prevBt = page
      .locator(
        "[data-pc-section='monthnavigator'] button:first-child,[data-pc-section='prevbutton'],button.p-datepicker-prev,[aria-label*='Previous'],[aria-label*='Anterior']",
      )
      .first();

    await (goNext ? nextBt : prevBt).click({ timeout: 4000 }).catch(async () => {
      await (goNext ? page.locator("button.p-datepicker-next").first() : page.locator("button.p-datepicker-prev").first()).click({
        timeout: 4000,
      });
    });
    await delay(70);
  }

  await page
    .locator(".p-datepicker-calendar td:not(.p-datepicker-other-month)")
    .locator("span,a")
    .filter({ hasText: new RegExp(`^${day}$`) })
    .first()
    .click({ timeout: 8000 })
    .catch(async () => {
      await page
        .getByRole("gridcell", { name: String(day), exact: true })
        .first()
        .click({ timeout: 8000 })
        .catch(() => {});
    });

  await page.keyboard.press("Escape").catch(() => {});
  await delay(110);
}

async function limpiarFormularioFiltros(page: Page): Promise<void> {
  if (process.env.COMPRASMX_SKIP_LIMPIAR === "1") return;
  const btn = page.getByRole("button", { name: /^limpiar$/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await delay(fastMode() ? 160 : 280);
  }
}

const LEE_TOTAL_PIE_SCRIPT = `(() => {
  var root = document.querySelector(".layout-main") || document.querySelector("main") || document.body;
  var m = (root && (root.innerText || "")).match(/Total:\\s*(\\d+)/i);
  return m ? parseInt(m[1], 10) : null;
})()`;

async function leerTotalPiePortal(page: Page): Promise<number | null> {
  const v = await page.evaluate(LEE_TOTAL_PIE_SCRIPT);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Espera resultado de Buscar: spinner y luego sondeo corto (no acumula pausas largas). */
async function esperarRespuestaBusqueda(
  page: Page,
  navTimeoutMs: number,
  totalPieAntes?: number | null,
): Promise<{ totalPie: number | null; sinResultados: boolean }> {
  const vacio = page.getByText(/No se encontraron resultados\s+para tu búsqueda|No se encontraron resultados/i);
  const start = Date.now();
  const loading = page.locator(".p-datatable-loading, .p-blockui").first();

  if (await loading.isVisible().catch(() => false)) {
    await loading.waitFor({ state: "hidden", timeout: navTimeoutMs }).catch(() => {});
  }

  const poll = fastMode() ? 16 : 42;
  let mismoPrevAcum = 0;

  while (Date.now() - start < navTimeoutMs) {
    if (await vacio.isVisible().catch(() => false)) {
      return { totalPie: 0, sinResultados: true };
    }

    if (await loading.isVisible().catch(() => false)) {
      await loading.waitFor({ state: "hidden", timeout: Math.min(20_000, navTimeoutMs) }).catch(() => {});
      mismoPrevAcum = 0;
      continue;
    }

    const totalPie = await leerTotalPiePortal(page);
    if (totalPie !== null) {
      if (
        totalPieAntes !== undefined &&
        totalPieAntes !== null &&
        Number.isFinite(totalPieAntes) &&
        totalPie === totalPieAntes
      ) {
        mismoPrevAcum += poll;
        await sleep(poll);
        if (mismoPrevAcum > (fastMode() ? 2000 : 5000)) {
          return { totalPie, sinResultados: false };
        }
        continue;
      }
      await sleep(fastMode() ? 22 : 55);
      const total2 = await leerTotalPiePortal(page);
      if (total2 !== null && total2 === totalPie) {
        return { totalPie, sinResultados: false };
      }
    }

    await sleep(poll);
  }
  return { totalPie: await leerTotalPiePortal(page), sinResultados: false };
}

async function extraerFilasConReintentos(
  page: Page,
  totalEsperado: number | null,
  sinResultados: boolean,
): Promise<ComprasmxFila[]> {
  if (sinResultados) return [];
  if (totalEsperado === 0) return [];
  const maxRounds = fastMode() ? 5 : 8;
  let filas: ComprasmxFila[] = [];
  for (let r = 0; r < maxRounds; r++) {
    filas = await extraerFilasNumeroyNombre(page);
    if (totalEsperado !== null && totalEsperado > 0) {
      if (filas.length >= totalEsperado) return filas.slice(0, totalEsperado);
      if (filas.length > 0 && filas.length < totalEsperado) {
        await delay(200);
        continue;
      }
    }
    if (filas.length > 0) break;
    await delay(200);
  }
  if (totalEsperado !== null && totalEsperado > 0 && filas.length > totalEsperado) {
    return filas.slice(0, totalEsperado);
  }
  return filas;
}

async function leerValoresFechaPublicacionDom(page: Page): Promise<{ desde: string; hasta: string }> {
  return {
    desde: (await page.locator('input[name="fechaDesdeP"]').inputValue().catch(() => "")).trim(),
    hasta: (await page.locator('input[name="fechaHastaP"]').inputValue().catch(() => "")).trim(),
  };
}

/** Marca varias entidades en un solo tick (evita N round-trips de Playwright). */
async function marcarEntidadesMultiselectEnDom(page: Page, entidades: string[]): Promise<void> {
  const list = entidades.map((e) => e.trim()).filter(Boolean);
  if (list.length === 0) return;
  await page.evaluate(
    `(function(names){
      function norm(s){return (s||"").replace(/\\s+/g," ").trim().toLowerCase().normalize("NFD").replace(/[\\u0300-\\u036f]/g,"");}
      var set = {};
      for (var i=0;i<names.length;i++) set[norm(names[i])]=1;
      var sel = ".p-multiselect-panel .p-multiselect-item, .p-multiselect-items .p-multiselect-item, .p-overlay-open .p-multiselect-item, .p-multiselect-item";
      var items = document.querySelectorAll(sel);
      for (var j=0;j<items.length;j++){
        var el = items[j];
        var t = norm(el.textContent||"");
        if (set[t]) el.click();
      }
    })(${JSON.stringify(list)})`,
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Tamaño razonable en portátiles; evita 1920×1080 si el monitor es más chico (ventana recortada). */
function resolveViewportSize(): { width: number; height: number } {
  const raw = process.env.COMPRASMX_VIEWPORT?.trim();
  if (raw) {
    const parts = raw.split(/[x,]/).map((s) => parseInt(s.trim(), 10));
    if (parts.length >= 2 && parts.every((n) => Number.isFinite(n) && n > 0)) {
      return { width: parts[0]!, height: parts[1]! };
    }
  }
  return { width: 1440, height: 900 };
}

/** Vuelve arriba el scroll del panel de menú/filtros (no dejar el usuario “perdido” abajo). */
async function scrollPanelFiltrosAlInicio(page: Page): Promise<void> {
  await page.evaluate(`(function(){
    var nodes = document.querySelectorAll('.layout-menu-container, .layout-menu, app-menu');
    for (var i = 0; i < nodes.length; i++) {
      try { nodes[i].scrollTop = 0; } catch (e) {}
    }
  })()`);
  await delay(40);
}

/**
 * Lleva el botón Buscar al viewport sin forzar todo el panel al final
 * (scrollHeight en el menú ocultaba fechas y podía dejar Buscar fuera según el contenedor).
 */
async function asegurarBotonBuscarVisible(page: Page): Promise<void> {
  const buscar = page.locator("form.sizetext").getByRole("button", { name: /^buscar$/i });
  await buscar.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
  await delay(25);
}

async function clickBuscar(page: Page, navTimeoutMs: number): Promise<void> {
  await asegurarBotonBuscarVisible(page);
  const buscar = page.locator("form.sizetext").getByRole("button", { name: /^buscar$/i });
  const visible = await buscar.isVisible().catch(() => false);
  if (visible) {
    await buscar.click({ timeout: navTimeoutMs });
    return;
  }
  await page.evaluate(
    `(function(){var f=document.querySelector('form.sizetext');if(f&&typeof f.requestSubmit==='function')f.requestSubmit();})()`,
  );
  await delay(50);
}

async function abrirPanelFiltros(page: Page): Promise<void> {
  const filtros = page.getByRole("button", { name: /filtros/i }).first();
  await filtros.waitFor({ state: "visible", timeout: 90_000 });
  const fechaInput = page.locator('input[name="fechaDesdeP"]');
  const panelPause = fastMode() ? 260 : 420;
  if (!(await fechaInput.isVisible().catch(() => false))) {
    await filtros.click();
    await delay(panelPause);
  }
  if (!(await fechaInput.isVisible().catch(() => false))) {
    await filtros.click();
    await delay(panelPause);
  }
  await fechaInput.waitFor({ state: "visible", timeout: 60_000 });
}

/** Cierra el panel del multiselect sin pausas artificiales; luego el caller pulsa Buscar. */
async function cerrarOverlayMultiselect(page: Page, multiselect: ReturnType<Page["locator"]>): Promise<void> {
  await page.keyboard.press("Escape").catch(() => {});
  await multiselect.locator(".p-multiselect").click().catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
}

/**
 * El contenido debe ir como string+IIFE: si pasas una función desde TS/tsx el bundler puede
 * inyectar `__name` y en el navegador falla con ReferenceError.
 */
const EXTRACT_FILAS_UI_SCRIPT = `(() => {
  const norm = (s) => s.replace(/\\s+/g, " ").trim();
  function pickTable() {
    var candidates = Array.from(document.querySelectorAll("p-table table, .p-datatable table, .layout-main table, main table"));
    var best = null;
    var bestN = -1;
    for (var i = 0; i < candidates.length; i++) {
      var table = candidates[i];
      var rect = table.getBoundingClientRect ? table.getBoundingClientRect() : null;
      if (rect && rect.width === 0 && rect.height === 0) continue;

      var headerCells = Array.from(table.querySelectorAll("thead th"));
      var headers = headerCells.map(function (th) { return norm(th.textContent || ""); });
      var idxNum = headers.findIndex(function (h) { return /n[uú]mero\\s+de\\s+identificaci[oó]n/i.test(h); });
      if (idxNum < 0) idxNum = headers.findIndex(function (h) { return /^expediente$/i.test(h); });
      if (idxNum < 0) idxNum = headers.findIndex(function (h) { return /expediente/i.test(h) && !/c[oó]digo/i.test(h); });

      var idxNombre = headerCells.findIndex(function (th) {
        return (th.getAttribute("psortablecolumn") || "") === "nombre_procedimiento";
      });
      if (idxNombre < 0) idxNombre = headers.findIndex(function (h) { return /^nombre$/i.test(h) && !/identificaci[oó]/i.test(h); });
      if (idxNombre < 0) idxNombre = headers.findIndex(function (h) { return /^descripci[oó]n$/i.test(h); });

      if (idxNum < 0 || idxNombre < 0) continue;

      var tb = table.querySelector("tbody");
      var n = tb ? tb.querySelectorAll("tr").length : 0;
      if (n > bestN) { best = table; bestN = n; }
    }
    return best || document.querySelector("table");
  }
  var table = pickTable();
  if (!table) return [];
  var headerCells = Array.from(table.querySelectorAll("thead th"));
  var headers = headerCells.map(function (th) { return norm(th.textContent || ""); });
  var idxNum = headers.findIndex(function (h) { return /n[uú]mero\\s+de\\s+identificaci[oó]n/i.test(h); });
  if (idxNum < 0) idxNum = headers.findIndex(function (h) { return /^expediente$/i.test(h); });
  if (idxNum < 0) idxNum = headers.findIndex(function (h) { return /expediente/i.test(h) && !/c[oó]digo/i.test(h); });
  var idxNombre = headerCells.findIndex(function (th) {
    return (th.getAttribute("psortablecolumn") || "") === "nombre_procedimiento";
  });
  if (idxNombre < 0) idxNombre = headers.findIndex(function (h) { return /^nombre$/i.test(h) && !/identificaci[oó]/i.test(h); });
  if (idxNombre < 0) idxNombre = headers.findIndex(function (h) { return /^descripci[oó]n$/i.test(h); });
  if (idxNum < 0) throw new Error("Sin columna expediente/identificación; " + headers.join(" | "));
  if (idxNombre < 0) throw new Error("Sin columna nombre/descripción; " + headers.join(" | "));
  var filas = [];
  var trs = table.querySelectorAll("tbody tr");
  for (var j = 0; j < trs.length; j++) {
    var tr = trs[j];
    var tds = tr.querySelectorAll("td");
    var cells = Array.from(tds).map(function (td) { return norm(td.textContent || ""); });
    var numeroIdentificacion = cells[idxNum] || "";
    var nombre = cells[idxNombre] || "";
    if (numeroIdentificacion !== "" || nombre !== "") {
      filas.push({ numeroIdentificacion: numeroIdentificacion, nombre: nombre });
    }
  }
  return filas;
})()`;

function extraerFilasNumeroyNombre(page: Pick<Page, "evaluate">): Promise<ComprasmxFila[]> {
  return page.evaluate(EXTRACT_FILAS_UI_SCRIPT);
}

/**
 * Clic en el expediente del listado: suele abrir una nueva pestaña; si no, navega en la misma ventana.
 * `COMPRASMX_PROCEDIMIENTO_POPUP_TIMEOUT_MS`: tiempo máximo a esperar la nueva pestaña (por defecto 15000).
 */
async function abrirDetalleProcedimientoDesdeListado(
  listPage: Page,
  numeroIdentificacion: string,
  popupTimeoutMs: number,
  navTimeoutMs: number,
): Promise<{ detailPage: Page; mode: "popup" | "same" }> {
  const ident = numeroIdentificacion.trim();
  if (!ident) throw new Error("Sin número de identificación");

  const row = listPage.locator("tbody tr").filter({ hasText: ident }).first();
  await row.waitFor({ state: "visible", timeout: navTimeoutMs });

  const link = row.getByRole("link", { name: new RegExp(`^${escapeRegex(ident)}$`, "i") });
  const clickTarget =
    (await link.count()) > 0
      ? link.first()
      : row.locator("td").filter({ hasText: new RegExp(`^\\s*${escapeRegex(ident)}\\s*$`, "i") }).first();

  await clickTarget.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});

  const ctx = listPage.context();
  let detailPage: Page;
  let mode: "popup" | "same";
  try {
    const [np] = await Promise.all([
      ctx.waitForEvent("page", { timeout: popupTimeoutMs }),
      clickTarget.click({ timeout: 15_000 }),
    ]);
    detailPage = np;
    mode = "popup";
    await detailPage.waitForLoadState("domcontentloaded", { timeout: navTimeoutMs }).catch(() => {});
    await instalarBloqueoRecursosLigeros(detailPage);
    detailPage.setDefaultTimeout(navTimeoutMs);
    detailPage.setDefaultNavigationTimeout(navTimeoutMs);
  } catch {
    await listPage.waitForURL(/procedimiento/i, { timeout: navTimeoutMs });
    detailPage = listPage;
    mode = "same";
    await listPage.waitForLoadState("domcontentloaded", { timeout: navTimeoutMs }).catch(() => {});
  }
  return { detailPage, mode };
}

async function cerrarDetalleYLiberarListado(listPage: Page, detailPage: Page, mode: "popup" | "same"): Promise<void> {
  if (mode === "popup") {
    await detailPage.close().catch(() => {});
    await listPage.bringToFront().catch(() => {});
    await delay(fastMode() ? 60 : 120);
    return;
  }
  await listPage.goBack({ waitUntil: "domcontentloaded" }).catch(() => {});
  await delay(fastMode() ? 180 : 300);
  await listPage.locator("tbody tr").first().waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
}

function detalleProcedimientoVacio(): ComprasmxDetalleProcedimiento {
  return {
    numeroProcedimientoContratacion: null,
    datosGenerales: {
      dependenciaOEntidad: null,
      descripcionDetallada: null,
      nombreProcedimiento: null,
    },
    cronograma: {
      presentacionAperturaProposiciones: null,
      limiteAclaracionesComprasmx: null,
      aplicaJuntaAclaraciones: null,
      fechaHoraActoFallo: null,
    },
    entidadFederativaContratacion: null,
    anexos: [],
  };
}

type RawDetalleProcedimiento = {
  numeroProcedimientoContratacion: string | null;
  dependenciaOEntidad: string | null;
  descripcionDetallada: string | null;
  nombreProcedimiento: string | null;
  presentacionAperturaProposiciones: string | null;
  limiteAclaracionesComprasmx: string | null;
  aplicaJuntaAclaraciones: string | null;
  fechaHoraActoFallo: string | null;
  entidadFederativaContratacion: string | null;
  anexos: Array<{ titulo: string; urlDescarga: string }>;
};

function expedienteParaNombreCarpeta(id: string): string {
  const s = id
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return s.length ? s : "sin-expediente";
}

/** Por defecto carpeta bajo `process.cwd()` para que los PDF aparezcan junto al proyecto al desarrollar. */
function baseDirAnexosComprasmx(): string {
  const fromEnv = process.env.COMPRASMX_ANEXOS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), "comprasmx-anexos");
}

/**
 * Icono de descarga en ANEXOS (PrimeIcons + PrimeNG): clase `pi pi-download`, tooltip «Descargar archivo».
 * No suele ir dentro de `<button>`; el `(click)` va en el `<i>`.
 */
const SEL_ICONO_DESCARGA_ANEXO_STRICT = 'tbody i.pi.pi-download[ptooltip="Descargar archivo"]';
const SEL_ICONO_DESCARGA_ANEXO_FALLBACK =
  "tbody i.pi.pi-download, tbody i.pi-download.p-element, tbody i.p-element.pi-download, tbody i.pi-download";

function locatorIconosDescargaAnexos(widget: Locator): Locator {
  return widget.locator(`${SEL_ICONO_DESCARGA_ANEXO_STRICT}, ${SEL_ICONO_DESCARGA_ANEXO_FALLBACK}`);
}

/**
 * PrimeNG a menudo pone `<thead>` en una tabla y `<tbody>` en otra (scrollable / frozen).
 * Filtrar un solo `<table>` falla siempre → hay que anclar al widget `p-table` / `.p-datatable`.
 */
async function localizarWidgetTablaAnexos(page: Page): Promise<Locator | null> {
  const head = page.getByText(/^\s*ANEXOS\s*$/i).first();
  if (await head.count()) await head.scrollIntoViewIfNeeded().catch(() => {});

  const panel = page.locator(".p-panel, .p-fieldset, section").filter({ has: page.getByText(/^\s*ANEXOS\s*$/i) }).first();
  if (await panel.count()) {
    const scoped = panel.locator("p-table, .p-datatable").filter({
      has: panel.locator("th").filter({ hasText: /Tipo de documento/i }),
    }).filter({
      has: panel.locator("th").filter({ hasText: /Acci[oó]n(es)?/i }),
    }).filter({
      has: panel.locator(SEL_ICONO_DESCARGA_ANEXO_FALLBACK),
    });
    if ((await scoped.count()) > 0) return scoped.first();
    const scopedLoose = panel.locator("p-table, .p-datatable").filter({
      has: panel.locator(SEL_ICONO_DESCARGA_ANEXO_FALLBACK),
    });
    if ((await scopedLoose.count()) > 0) return scopedLoose.first();
  }

  const widgets = page.locator("p-table, .p-datatable").filter({
    has: page.locator("th").filter({ hasText: /Tipo de documento/i }),
  }).filter({
    has: page.locator("th").filter({ hasText: /Acci[oó]n(es)?/i }),
  }).filter({
    has: page.locator(SEL_ICONO_DESCARGA_ANEXO_FALLBACK),
  });
  if ((await widgets.count()) > 0) return widgets.first();

  const loose = page.locator("p-table, .p-datatable").filter({
    has: page.locator(SEL_ICONO_DESCARGA_ANEXO_FALLBACK),
  });
  if ((await loose.count()) > 0) return loose.first();
  return null;
}

/** Tablas PrimeNG scrollables a veces dejan la columna de acción fuera del viewport horizontal. */
async function revelarScrollHorizontalTablaAnexos(widget: Locator): Promise<void> {
  await widget
    .evaluate((root) => {
      if (!(root instanceof HTMLElement)) return;
      const candidates = root.querySelectorAll(
        ".p-datatable-scrollable-body, .p-datatable-wrapper, .p-scroller, .p-scroller-content",
      );
      candidates.forEach((el) => {
        if (el instanceof HTMLElement && el.scrollWidth > el.clientWidth + 1) {
          el.scrollLeft = el.scrollWidth;
        }
      });
    })
    .catch(() => {});
  await delay(fastMode() ? 50 : 100);
}

async function prepararSeccionAnexosVisible(page: Page): Promise<void> {
  const head = page.getByText(/^\s*ANEXOS\s*$/i).first();
  if (await head.count()) await head.scrollIntoViewIfNeeded().catch(() => {});
  await delay(fastMode() ? 70 : 140);
  await page
    .locator(`${SEL_ICONO_DESCARGA_ANEXO_STRICT}, ${SEL_ICONO_DESCARGA_ANEXO_FALLBACK}, i.pi.pi-download`)
    .first()
    .waitFor({ state: "visible", timeout: 35_000 })
    .catch(() => {});
}

/**
 * ANEXOS: solo se pulsa el control de descarga; Playwright captura el evento `download` del navegador
 * (cualquier pestaña del mismo contexto) y guarda con `saveAs` en la carpeta del expediente.
 * `COMPRASMX_SKIP_ANEXO_DOWNLOAD=1` lo desactiva. `COMPRASMX_ANEXOS_DIR`: carpeta base.
 */
async function esperarPrimerDownloadEnContexto(ctx: BrowserContext, timeoutMs: number): Promise<Download | null> {
  return new Promise((resolve) => {
    let listo = false;
    const fin = (d: Download | null) => {
      if (listo) return;
      listo = true;
      clearTimeout(timer);
      ctx.off("page", alNueva);
      for (const p of ctx.pages()) {
        p.off("download", alDownload);
      }
      resolve(d);
    };
    const timer = setTimeout(() => fin(null), timeoutMs);
    const alDownload = (d: Download) => fin(d);
    const alNueva = (p: Page) => {
      p.on("download", alDownload);
    };
    ctx.on("page", alNueva);
    for (const p of ctx.pages()) {
      p.on("download", alDownload);
    }
  });
}

async function guardarArchivoTrasClicDescarga(
  page: Page,
  clickTarget: Locator,
  sessionDir: string,
  filePrefix: string,
  perFileMs: number,
): Promise<string | null> {
  const ctx = page.context();
  const desdeCtx = esperarPrimerDownloadEnContexto(ctx, perFileMs);
  const popupMs = Math.min(4_000, Math.max(1_200, Math.floor(perFileMs * 0.08)));
  const desdePopup = ctx
    .waitForEvent("page", { timeout: popupMs })
    .then((p) => p.waitForEvent("download", { timeout: Math.max(8_000, perFileMs - popupMs) }))
    .catch(() => new Promise<Download>(() => {}));
  const espera = Promise.race([desdeCtx, desdePopup]);

  await clickTarget.scrollIntoViewIfNeeded().catch(() => {});
  try {
    await clickTarget.click({ timeout: 15_000, force: true });
  } catch {
    await clickTarget.evaluate((el: HTMLElement) => el.click());
  }

  const download = await espera;
  if (!download) return null;
  const suggested = download.suggestedFilename() || `${filePrefix}.bin`;
  const dest = path.join(sessionDir, `${filePrefix}_${suggested.replace(/[/\\]/g, "_")}`);
  await download.saveAs(dest);
  return dest;
}

async function descargarAnexosPorIconosDescargar(page: Page, expedienteListadoId: string): Promise<ComprasmxAnexo[]> {
  if (process.env.COMPRASMX_SKIP_ANEXO_DOWNLOAD === "1") return [];
  const rawMax = parseInt(process.env.COMPRASMX_ANEXOS_MAX ?? "25", 10);
  const max = Math.min(100, Math.max(1, Number.isFinite(rawMax) ? rawMax : 25));
  const timeoutMs = Number(process.env.COMPRASMX_ANEXO_DOWNLOAD_TIMEOUT_MS);
  const perFileMs = Number.isFinite(timeoutMs) && timeoutMs > 5_000 ? timeoutMs : 75_000;

  let widget = await localizarWidgetTablaAnexos(page);
  if (!widget) {
    await page
      .locator(`${SEL_ICONO_DESCARGA_ANEXO_STRICT}, ${SEL_ICONO_DESCARGA_ANEXO_FALLBACK}, i.pi.pi-download`)
      .first()
      .waitFor({ state: "attached", timeout: 15_000 })
      .catch(() => {});
    widget = await localizarWidgetTablaAnexos(page);
  }
  if (!widget) return [];
  await revelarScrollHorizontalTablaAnexos(widget);

  const iconCount = await locatorIconosDescargaAnexos(widget).count();
  if (iconCount === 0) return [];

  const out: ComprasmxAnexo[] = [];
  const baseDir = baseDirAnexosComprasmx();
  const sessionDir = path.join(baseDir, expedienteParaNombreCarpeta(expedienteListadoId));
  await fs.mkdir(sessionDir, { recursive: true });

  let saved = 0;
  for (let i = 0; i < iconCount && saved < max; i++) {
    const icon = locatorIconosDescargaAnexos(widget).nth(i);
    const row = icon.locator("xpath=./ancestor::tr[1]");
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await icon.waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
    if ((await icon.count()) === 0) continue;

    const clickTarget = icon;

    const cells = row.locator("td");
    const cellText = async (idx: number) =>
      (await cells.nth(idx).innerText().catch(() => "")).replace(/\s+/g, " ").trim();

    const num = await cellText(0);
    const tipo = await cellText(1);
    const desc = await cellText(2);
    const titulo =
      [tipo, desc].filter(Boolean).join(" — ").slice(0, 240) ||
      (num ? `Anexo ${num}` : `Anexo ${saved + 1}`);

    const prefix = String(saved + 1).padStart(2, "0");
    const dest = await guardarArchivoTrasClicDescarga(page, clickTarget, sessionDir, prefix, perFileMs);
    if (dest) {
      out.push({ titulo, archivoLocal: dest });
      saved += 1;
    }
  }

  return out;
}

const EXTRACT_PROCEDIMIENTO_UI_SCRIPT = `(() => {
  function norm(s) { return (s || "").replace(/\\s+/g, " ").trim(); }
  function nfd(s) {
    return norm(s)
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\\u0300-\\u036f]/g, "");
  }
  var root =
    document.querySelector("[class*='detalle']") ||
    document.querySelector(".layout-content") ||
    document.querySelector(".layout-main") ||
    document.querySelector("main") ||
    document.querySelector("app-root") ||
    document.body;
  var pairs = [];

  function addPair(k, v) {
    k = norm(k);
    v = norm(v);
    if (!k || k.length > 320) return;
    if (!v) return;
    pairs.push({ k: k, v: v });
  }

  function looksLikeSectionHeader(label) {
    var n = nfd(label);
    if (n.length < 6) return true;
    if (n.indexOf("datos generales") >= 0 && n.length < 22) return true;
    if (n.indexOf("datos del ente") >= 0) return true;
    if (n.indexOf("unidades requirentes") >= 0) return true;
    if (n.indexOf("cronograma") >= 0 && n.indexOf("evento") >= 0) return true;
    if (n === "cronograma de eventos") return true;
    if (n.indexOf("anexos") >= 0 && n.length < 20) return true;
    if (n.indexOf("partidas especificas") >= 0 || n.indexOf("partidas específicas") >= 0) return true;
    if (label.length > 6 && label === label.toUpperCase() && label.length < 55 && label.indexOf(" ") > 0) return true;
    return false;
  }

  function looksLikeNewFieldLine(rawLine) {
    var t = norm(rawLine);
    var ix = t.indexOf(":");
    if (ix < 12 || ix > 140) return false;
    var left = norm(t.slice(0, ix));
    if (left.length < 10 || left.length > 130) return false;
    if (looksLikeSectionHeader(left)) return true;
    var right = norm(t.slice(ix + 1));
    return right.length >= 1;
  }

  function collectColonPairsFromInnerText(el) {
    if (!el) return;
    var raw = el.innerText || "";
    var parts = raw.split(/\\r?\\n/);
    for (var i = 0; i < parts.length; i++) {
      var line = norm(parts[i]);
      if (!line) continue;
      var ix = line.indexOf(":");
      if (ix <= 0 || ix > 150) continue;
      var label = norm(line.slice(0, ix)).replace(/:\\s*$/g, "");
      if (!label || looksLikeSectionHeader(label)) continue;
      var rightSame = norm(line.slice(ix + 1));
      if (rightSame.length >= 2) {
        addPair(label, rightSame);
        continue;
      }
      var buf = [];
      for (var j = i + 1; j < parts.length && j < i + 45; j++) {
        if (looksLikeNewFieldLine(parts[j])) break;
        var nxt = norm(parts[j]);
        if (!nxt) continue;
        buf.push(nxt);
      }
      var merged = norm(buf.join(" "));
      if (merged.length > 2) addPair(label, merged);
      i += buf.length;
    }
  }

  function collectFlexLabelBlocks(el) {
    if (!el) return;
    Array.from(el.querySelectorAll("div, section, article")).forEach(function (box) {
      if (!box || !box.children || box.children.length < 2) return;
      var ch = Array.from(box.children);
      if (ch.length > 6) return;
      var t0 = norm(ch[0].textContent || "");
      if (!t0 || t0.length < 8 || t0.length > 140) return;
      if (t0.indexOf(":") >= 0) return;
      if (looksLikeSectionHeader(t0)) return;
      var rest = norm(
        ch
          .slice(1)
          .map(function (c) { return c.textContent || ""; })
          .join(" "),
      );
      if (rest.length < 3 || rest.length > 4000) return;
      if (nfd(t0).indexOf("dependencia") >= 0 || nfd(t0).indexOf("nombre del procedimiento") >= 0 || nfd(t0).indexOf("descripcion") >= 0) {
        addPair(t0, rest);
      }
    });
  }

  if (root) {
    collectColonPairsFromInnerText(root);
    collectFlexLabelBlocks(root);

    Array.from(root.querySelectorAll("table tr")).forEach(function (tr) {
      var cells = tr.querySelectorAll("td, th");
      if (cells.length >= 2) {
        addPair(
          cells[0].textContent,
          Array.from(cells)
            .slice(1)
            .map(function (c) { return c.textContent || ""; })
            .join(" "),
        );
      }
    });

    Array.from(root.querySelectorAll("dl")).forEach(function (dl) {
      var ch = Array.from(dl.children);
      for (var i = 0; i < ch.length; i++) {
        if (ch[i].tagName !== "DT") continue;
        var vals = [];
        for (var j = i + 1; j < ch.length; j++) {
          if (ch[j].tagName === "DD") vals.push(ch[j].textContent || "");
          else if (ch[j].tagName === "DT") break;
        }
        if (vals.length) addPair(ch[i].textContent, vals.join(" "));
      }
    });

    Array.from(root.querySelectorAll(".p-field, .field")).forEach(function (row) {
      var lab = row.querySelector("label, .label, span.p-float-label > label");
      var inp = row.querySelector("input, textarea, .p-inputtext, .p-inputtextarea");
      if (lab && inp) addPair(lab.textContent || "", inp.value || inp.textContent || "");
    });

    Array.from(root.querySelectorAll(".grid .col-12, .grid .col-6, .grid .col-4, .grid .col-8")).forEach(function (col) {
      var strong = col.querySelector("strong, b, label, .font-bold");
      if (!strong) return;
      var k = norm(strong.textContent || "");
      if (!k || k.length > 200) return;
      var clone = col.cloneNode(true);
      var sr = clone.querySelector("strong, b, label, .font-bold");
      if (sr) sr.remove();
      var v = norm(clone.textContent || "");
      if (v && v.length > 0 && v.length < 4000) addPair(k, v);
    });
  }

  var blob = norm((root && root.innerText) || "");
  var lines = blob.split(/\\n+/).map(norm).filter(function (x) { return x.length > 0; });

  function pickLine(needles) {
    var nn = needles.map(nfd);
    for (var l = 0; l < lines.length; l++) {
      var cur = nfd(lines[l]);
      for (var j = 0; j < nn.length; j++) {
        if (cur.indexOf(nn[j]) < 0) continue;
        var ix = lines[l].indexOf(":");
        if (ix >= 0) {
          var after = norm(lines[l].slice(ix + 1));
          if (after.length > 1) return after;
        }
        for (var k = l + 1; k < lines.length && k < l + 12; k++) {
          var cand = lines[k];
          var candN = nfd(cand);
          var isLabel = false;
          for (var z = 0; z < nn.length; z++) {
            if (candN.indexOf(nn[z]) >= 0 && cand.length < 140) {
              isLabel = true;
              break;
            }
          }
          if (isLabel) continue;
          if (looksLikeNewFieldLine(cand)) break;
          if (cand.length > 2) return cand.length > 800 ? cand.slice(0, 800) : cand;
        }
      }
    }
    return null;
  }

  function pick(pairs, needles) {
    var nneedles = needles.map(nfd);
    for (var i = 0; i < pairs.length; i++) {
      var kn = nfd(pairs[i].k);
      for (var j = 0; j < nneedles.length; j++) {
        if (kn.indexOf(nneedles[j]) >= 0) return pairs[i].v || null;
      }
    }
    return pickLine(needles);
  }

  /** Valor del segundo <label> (sin font-bold) bajo el encabezado, como en Cronograma de eventos. */
  function valorBajoEncabezadoBoldLabels(r, needles) {
    if (!r) return null;
    var nneedles = needles.map(nfd);
    var bolds = r.querySelectorAll("label.font-bold");
    for (var i = 0; i < bolds.length; i++) {
      var lb = bolds[i];
      var ht = nfd(norm(lb.textContent || ""));
      var hit = false;
      for (var j = 0; j < nneedles.length; j++) {
        if (ht.indexOf(nneedles[j]) >= 0) {
          hit = true;
          break;
        }
      }
      if (!hit) continue;
      var el = lb.nextElementSibling;
      while (el) {
        if (el.tagName === "BR") {
          el = el.nextElementSibling;
          continue;
        }
        if (el.tagName === "LABEL") {
          var cl = el.getAttribute("class") || "";
          if (cl.indexOf("font-bold") >= 0) break;
          var v = norm(el.textContent || "");
          return v || null;
        }
        el = el.nextElementSibling;
      }
    }
    return null;
  }

  function saneaJuntaAclaraciones(v) {
    if (!v) return null;
    var t = norm(v);
    if (t.length > 6) return null;
    if (!/^(SI|NO|SÍ)$/i.test(t)) return null;
    return /^sí$/i.test(t) ? "SÍ" : t.toUpperCase();
  }

  function saneaFechaHoraActoFallo(v) {
    if (!v) return null;
    var t = norm(v);
    if (t.length > 28) return null;
    if (/datos\\s+espec|participaci[oó]n\\s+de\\s+testigo/i.test(t)) return null;
    if (!/\\d{1,2}\\/\\d{1,2}\\/\\d{4}/.test(t)) return null;
    return t;
  }

  var anexos = [];
  var seen = {};
  function pushAnexo(tit, href) {
    if (!href || href === "#") return;
    if (href.toLowerCase().indexOf("javascript:") === 0) return;
    var abs = "";
    try {
      abs = new URL(href, location.href).href;
    } catch (e) {
      return;
    }
    if (abs.indexOf("comprasmx.buengobierno.gob.mx") < 0) return;
    var t = norm(tit) || abs.split("/").pop().split("?")[0];
    if (seen[abs]) return;
    seen[abs] = 1;
    anexos.push({ titulo: t, urlDescarga: abs });
  }

  if (root) {
    var headings = root.querySelectorAll("h2, h3, h4, .p-panel-title, legend, .p-fieldset-legend");
    for (var h = 0; h < headings.length; h++) {
      var ht = norm(headings[h].textContent || "");
      if (!ht) continue;
      if (nfd(ht).indexOf("anexo") < 0) continue;
      var scope = headings[h].closest(".p-panel, .p-fieldset, .p-card, .card, section") || root;
      Array.from(scope.querySelectorAll("a[href]")).forEach(function (a) {
        pushAnexo(a.textContent || "", a.getAttribute("href") || "");
      });
      break;
    }
    if (anexos.length === 0) {
      Array.from(root.querySelectorAll("a[href]")).forEach(function (a) {
        var href = (a.getAttribute("href") || "").trim();
        var lo = href.toLowerCase();
        if (lo.indexOf(".pdf") >= 0 || lo.indexOf("download") >= 0 || lo.indexOf("anexo") >= 0 || lo.indexOf("archivo") >= 0) {
          pushAnexo(a.textContent || "", href);
        }
      });
    }
  }

  return {
    numeroProcedimientoContratacion: pick(pairs, [
      "número de procedimiento de contratación",
      "numero de procedimiento de contratacion",
    ]),
    dependenciaOEntidad: pick(pairs, ["dependencia o entidad", "ente contratante"]),
    descripcionDetallada: pick(pairs, [
      "descripción detallada del procedimiento de contratación",
      "descripcion detallada del procedimiento de contratacion",
    ]),
    nombreProcedimiento: pick(pairs, [
      "nombre del procedimiento de contratación",
      "nombre del procedimiento de contratacion",
    ]),
    presentacionAperturaProposiciones: pick(pairs, [
      "fecha y hora de presentación y apertura de proposiciones",
      "fecha y hora de presentacion y apertura de proposiciones",
      "presentacion y apertura de proposiciones",
    ]),
    limiteAclaracionesComprasmx: pick(pairs, [
      "fecha y hora límite para envío de aclaraciones",
      "fecha y hora limite para envio de aclaraciones",
      "aclaraciones a través de compras mx",
      "aclaraciones a traves de compras mx",
    ]),
    aplicaJuntaAclaraciones: saneaJuntaAclaraciones(
      valorBajoEncabezadoBoldLabels(root, ["aplica junta de aclaraciones"]),
    ),
    fechaHoraActoFallo: saneaFechaHoraActoFallo(
      valorBajoEncabezadoBoldLabels(root, ["fecha y hora del acto del fallo"]),
    ),
    entidadFederativaContratacion: pick(pairs, [
      "entidad federativa donde se llevará a cabo la contratación",
      "entidad federativa donde se llevara a cabo la contratacion",
    ]),
    anexos: anexos,
  };
})()`;

async function extraerDetalleProcedimientoDesdePage(
  page: Page,
  expedienteListadoId?: string,
): Promise<ComprasmxDetalleProcedimiento> {
  try {
    await page.locator(".layout-main, main, app-root").first().waitFor({ state: "visible", timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("domcontentloaded", { timeout: 10_000 }).catch(() => {});
    await delay(fastMode() ? 80 : 160);
    await prepararSeccionAnexosVisible(page);
    const id = expedienteListadoId?.trim() ?? "";
    const anexosDescargados = id ? await descargarAnexosPorIconosDescargar(page, id) : [];
    const raw = (await page.evaluate(EXTRACT_PROCEDIMIENTO_UI_SCRIPT)) as RawDetalleProcedimiento;
    const anexosLinks: ComprasmxAnexo[] = Array.isArray(raw?.anexos)
      ? raw.anexos.map((a) => ({ titulo: a.titulo, urlDescarga: a.urlDescarga }))
      : [];
    const urlsEnDescargados = new Set(
      anexosDescargados.map((a) => a.urlDescarga).filter((u): u is string => Boolean(u)),
    );
    const anexos = [
      ...anexosDescargados,
      ...anexosLinks.filter((a) => a.urlDescarga && !urlsEnDescargados.has(a.urlDescarga)),
    ];
    return {
      numeroProcedimientoContratacion: raw?.numeroProcedimientoContratacion ?? null,
      datosGenerales: {
        dependenciaOEntidad: raw?.dependenciaOEntidad ?? null,
        descripcionDetallada: raw?.descripcionDetallada ?? null,
        nombreProcedimiento: raw?.nombreProcedimiento ?? null,
      },
      cronograma: {
        presentacionAperturaProposiciones: raw?.presentacionAperturaProposiciones ?? null,
        limiteAclaracionesComprasmx: raw?.limiteAclaracionesComprasmx ?? null,
        aplicaJuntaAclaraciones: raw?.aplicaJuntaAclaraciones ?? null,
        fechaHoraActoFallo: raw?.fechaHoraActoFallo ?? null,
      },
      entidadFederativaContratacion: raw?.entidadFederativaContratacion ?? null,
      anexos,
    };
  } catch (e) {
    return {
      ...detalleProcedimientoVacio(),
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

export type FetchComprasmxOptions = {
  /**
   * `true`/`false`: forzar modo con o sin ventana.
   * `undefined`: headless por defecto (rápido). `PLAYWRIGHT_HEADED=1` o `?headed=1` para ventana visible.
   */
  headed?: boolean;
  /** Fecha publicación «desde», formato `DD/MM/AAAA`. Si no viene, se usa hoy (CDMX). */
  fechaPublicacionDesde?: string;
  /** Fecha publicación «hasta». Si no viene, coincide con `fechaPublicacionDesde`. */
  fechaPublicacionHasta?: string;
  /**
   * Estados a marcar en el multiselect (nombres canónicos como en el portal).
   * Si se omite o queda vacío, se usa `ENTIDADES_FEDERATIVAS_FILTRO`.
   */
  entidadesFederativas?: string[];
  /**
   * Si se envía, la respuesta solo incluye filas cuyo `nombre` contiene alguna palabra (sin distinguir mayúsculas).
   * Por cada una (hasta el límite) se hace clic en el expediente en el listado, se lee el detalle en la pestaña nueva o en la misma ventana, y se vuelve al listado.
   */
  palabrasClave?: string[];
};

/** Reutiliza Chromium entre peticiones (mismo modo headed/headless). Ahorra varios segundos por request. */
const sharedBrowsers = new Map<string, Browser>();

function chromiumLaunchArgs(width: number, height: number): string[] {
  return [
    `--window-size=${width},${height}`,
    "--disable-extensions",
    "--no-first-run",
    "--disable-background-networking",
  ];
}

async function obtainSharedBrowser(headed: boolean, width: number, height: number): Promise<Browser> {
  const key = headed ? "headed" : "headless";
  const cur = sharedBrowsers.get(key);
  if (cur?.isConnected()) return cur;
  const b = await chromium.launch({
    headless: !headed,
    args: chromiumLaunchArgs(width, height),
  });
  sharedBrowsers.set(key, b);
  return b;
}

/**
 * Precalienta Chromium solo si `COMPRASMX_WARM_BROWSER=1` (no arranca navegador al levantar el API por defecto).
 */
export async function warmComprasmxBrowser(): Promise<void> {
  if (process.env.COMPRASMX_WARM_BROWSER !== "1") return;
  if (process.env.COMPRASMX_REUSE_BROWSER === "0") return;
  ensureBrowserShutdownHooks();
  const headed = resolveHeaded(undefined);
  const { width, height } = resolveViewportSize();
  await obtainSharedBrowser(headed, width, height);
}

/**
 * Bloquea imágenes y media (ahorro de ancho de banda). Las fuentes no se bloquean por defecto:
 * PrimeIcons (`pi-download` en ANEXOS) depende de `@font-face`; bloquearlas deja la columna Acción vacía.
 * `COMPRASMX_BLOCK_FONT_RESOURCES=1` restaura el bloqueo de fuentes. `COMPRASMX_NO_BLOCK_RESOURCES=1` desactiva todo.
 */
async function instalarBloqueoRecursosLigeros(page: Page): Promise<void> {
  if (process.env.COMPRASMX_NO_BLOCK_RESOURCES === "1") return;
  const blockFonts = process.env.COMPRASMX_BLOCK_FONT_RESOURCES === "1";
  await page.route("**/*", (route) => {
    const rt = route.request().resourceType();
    if (rt === "image" || rt === "media") return route.abort();
    if (blockFonts && rt === "font") return route.abort();
    return route.continue();
  });
}

/**
 * SPAs con `#/` a veces no disparan bien la señal de `domcontentloaded` en el plazo esperado.
 * Por defecto: `waitUntil: "commit"` + espera a `domcontentloaded` con timeout acotado.
 * `COMPRASMX_GOTO_WAIT_UNTIL=domcontentloaded|load` restaura otro modo. `COMPRASMX_GOTO_RETRIES` (1–8, default 3).
 */
function gotoWaitUntilEnv(): "commit" | "domcontentloaded" | "load" {
  const w = (process.env.COMPRASMX_GOTO_WAIT_UNTIL ?? "").trim().toLowerCase();
  if (w === "domcontentloaded" || w === "load") return w;
  return "commit";
}

function gotoMaxAttempts(): number {
  const raw = process.env.COMPRASMX_GOTO_RETRIES?.trim();
  const n = raw ? parseInt(raw, 10) : 3;
  if (!Number.isFinite(n) || n < 1) return 3;
  return Math.min(8, Math.max(1, n));
}

async function navegarSitioPublicoComprasmx(page: Page, navTimeoutMs: number): Promise<void> {
  const waitUntil = gotoWaitUntilEnv();
  const attempts = gotoMaxAttempts();
  const secondaryWait = Math.min(60_000, Math.max(15_000, Math.floor(navTimeoutMs / 2)));

  let lastErr: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await page.goto(SOURCE_URL, { waitUntil, timeout: navTimeoutMs });
      if (waitUntil === "commit") {
        await page.waitForLoadState("domcontentloaded", { timeout: secondaryWait }).catch(() => {});
      }
      await page
        .locator("app-root, .layout-main, body")
        .first()
        .waitFor({ state: "attached", timeout: 15_000 })
        .catch(() => {});
      return;
    } catch (e) {
      lastErr = e;
      if (attempt >= attempts) break;
      await delay(Math.min(4_000, 350 * attempt));
    }
  }
  const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
  throw new Error(
    `No se pudo abrir Compras MX (${msg}). Revisa red o VPN; opciones: COMPRASMX_NAV_TIMEOUT_MS=180000, COMPRASMX_GOTO_RETRIES=5, COMPRASMX_GOTO_WAIT_UNTIL=domcontentloaded, ?headed=1 o PLAYWRIGHT_HEADED=1 para ver el navegador.`,
    { cause: lastErr instanceof Error ? lastErr : undefined },
  );
}

let browserShutdownHooks = false;
function ensureBrowserShutdownHooks(): void {
  if (browserShutdownHooks) return;
  browserShutdownHooks = true;
  const closeAll = () => {
    void Promise.all([...sharedBrowsers.values()].map((b) => b.close().catch(() => {}))).finally(() => {
      sharedBrowsers.clear();
    });
  };
  process.once("SIGINT", closeAll);
  process.once("SIGTERM", closeAll);
}

/** Por defecto headless (rápido en API/Postman). `PLAYWRIGHT_HEADED=1` o `?headed=1` para ver el navegador. */
function resolveHeaded(explicit?: boolean): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  if (process.env.PLAYWRIGHT_HEADED === "1") return true;
  if (process.env.PLAYWRIGHT_HEADLESS === "1") return false;
  return false;
}

export async function fetchComprasmxSnapshot(opts?: FetchComprasmxOptions): Promise<ComprasmxSnapshot> {
  const run = snapshotRunLock.then(() => ejecutarComprasmxSnapshot(opts));
  snapshotRunLock = run.catch(() => {});
  return run;
}

async function ejecutarComprasmxSnapshot(opts?: FetchComprasmxOptions): Promise<ComprasmxSnapshot> {
  const fechaDesde = opts?.fechaPublicacionDesde ?? fechaHoyDdMmYyyy();
  const fechaHasta = opts?.fechaPublicacionHasta ?? fechaDesde;
  const entidades =
    opts?.entidadesFederativas && opts.entidadesFederativas.length > 0
      ? [...opts.entidadesFederativas]
      : [...ENTIDADES_FEDERATIVAS_FILTRO];

  const headed = resolveHeaded(opts?.headed);
  const reuseBrowser = process.env.COMPRASMX_REUSE_BROWSER !== "0";
  let page: Page | undefined;
  let browserContext: BrowserContext | undefined;
  let disposableBrowser: Browser | undefined;

  try {
    ensureBrowserShutdownHooks();
    const { width, height } = resolveViewportSize();
    let browser: Browser;
    if (reuseBrowser) {
      browser = await obtainSharedBrowser(headed, width, height);
    } else {
      disposableBrowser = await chromium.launch({
        headless: !headed,
        args: chromiumLaunchArgs(width, height),
      });
      browser = disposableBrowser;
    }

    browserContext = await browser.newContext({
      acceptDownloads: true,
      locale: "es-MX",
      timezoneId: TZ,
      viewport: { width, height },
    });
    page = await browserContext.newPage();

    await instalarBloqueoRecursosLigeros(page);

    const navTimeoutMs = Number(process.env.COMPRASMX_NAV_TIMEOUT_MS) || 120_000;
    page.setDefaultTimeout(navTimeoutMs);
    page.setDefaultNavigationTimeout(navTimeoutMs);

    await navegarSitioPublicoComprasmx(page, navTimeoutMs);

    await abrirPanelFiltros(page);

    await scrollPanelFiltrosAlInicio(page);

    await limpiarFormularioFiltros(page);

    const pestana = pestanaEnv();
    await configurarVistaListado(page, pestana);

    if (!(await intentarEstablecerFechasPublicacionEvaluate(page, fechaDesde, fechaHasta))) {
      await establecerFechaPublicacionCampo(page, "fechaDesdeP", fechaDesde);
      await establecerFechaPublicacionCampo(page, "fechaHastaP", fechaHasta);
    }

    const domFechas = await leerValoresFechaPublicacionDom(page);

    const multiselect = page.locator('p-multiselect[name="entidades"]');
    await multiselect.locator(".p-multiselect").click();
    await page.locator(".p-multiselect-item").first().waitFor({ state: "visible", timeout: 12_000 }).catch(() => {});
    await marcarEntidadesMultiselectEnDom(page, entidades);

    await cerrarOverlayMultiselect(page, multiselect);

    // Antes del click guardamos el total para poder detectar si la SPA todavía está mostrando el estado anterior.
    const totalPieAntesBusqueda = await leerTotalPiePortal(page);
    await clickBuscar(page, navTimeoutMs);

    const { totalPie, sinResultados } = await esperarRespuestaBusqueda(page, navTimeoutMs, totalPieAntesBusqueda);

    const filas = await extraerFilasConReintentos(page, totalPie, sinResultados);

    const baseFiltros = {
      fechaPublicacionDesde: fechaDesde,
      fechaPublicacionHasta: fechaHasta,
      entidadesFederativas: entidades,
      pestanaResultados: pestana,
    };

    const palabrasRespuesta = (opts?.palabrasClave ?? []).map((k) => k.trim()).filter(Boolean);
    const kws = palabrasRespuesta.map((k) => k.toLowerCase());

    if (kws.length === 0) {
      return {
        source: SOURCE_URL,
        fetchedAt: new Date().toISOString(),
        filtros: baseFiltros,
        valoresFormularioDetectados: {
          fechaDesdePublicacion: domFechas.desde,
          fechaHastaPublicacion: domFechas.hasta,
        },
        filas,
        totalFilas: filas.length,
        totalEnPieDePortal: sinResultados ? 0 : totalPie,
      };
    }

    const lim = maxProcedimientoDetalle();
    const coincidencias = filas.filter((f) => kws.some((kw) => f.nombre.toLowerCase().includes(kw)));
    const omitidos = Math.max(0, coincidencias.length - lim);
    const procesar = coincidencias.slice(0, lim);

    const detMs = Number(process.env.COMPRASMX_PROCEDIMIENTO_TIMEOUT_MS) || 60_000;
    const popupTimeoutMs = Number(process.env.COMPRASMX_PROCEDIMIENTO_POPUP_TIMEOUT_MS) || 15_000;

    const enriched: ComprasmxFila[] = [];
    for (const row of procesar) {
      try {
        const { detailPage, mode } = await abrirDetalleProcedimientoDesdeListado(
          page,
          row.numeroIdentificacion,
          popupTimeoutMs,
          detMs,
        );
        const det = await extraerDetalleProcedimientoDesdePage(detailPage, row.numeroIdentificacion);
        enriched.push({ ...row, detalleProcedimiento: det });
        await cerrarDetalleYLiberarListado(page, detailPage, mode);
      } catch (e) {
        enriched.push({
          ...row,
          detalleProcedimiento: {
            ...detalleProcedimientoVacio(),
            error: e instanceof Error ? e.message : String(e),
          },
        });
      }
    }

    return {
      source: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      filtros: {
        ...baseFiltros,
        palabrasClave: palabrasRespuesta,
        detalleProcedimientoMax: lim,
        coincidenciasListadoKeyword: coincidencias.length,
        detallesOmitidosPorLimite: omitidos,
      },
      valoresFormularioDetectados: {
        fechaDesdePublicacion: domFechas.desde,
        fechaHastaPublicacion: domFechas.hasta,
      },
      filas: enriched,
      totalFilas: enriched.length,
      totalEnPieDePortal: sinResultados ? 0 : totalPie,
    };
  } finally {
    await browserContext?.close().catch(() => {});
    if (disposableBrowser) await disposableBrowser.close().catch(() => {});
  }
}
