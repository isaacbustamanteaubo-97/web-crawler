import { chromium, type Browser, type Page } from "playwright";

const SOURCE_URL =
  "https://comprasmx.buengobierno.gob.mx/sitiopublico/#/";
const TZ = "America/Mexico_City";

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

export type ComprasmxFila = {
  numeroIdentificacion: string;
  nombre: string;
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

/** `COMPRASMX_FAST=0` desactiva acortar pausas (más estable, más lento). */
function fastMode(): boolean {
  return process.env.COMPRASMX_FAST !== "0";
}

function delay(ms: number): Promise<void> {
  const ms2 = fastMode() ? Math.max(25, Math.floor(ms * 0.45)) : ms;
  return sleep(ms2);
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
        await delay(600);
      }
    }
    return;
  }
  if (pestana === "seguimiento") {
    const tab = page.getByRole("tab", { name: /Anuncios en seguimiento/i }).first();
    if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 15_000 });
    await delay(900);
    return;
  }
  const tab = page.getByRole("tab", { name: /Anuncios concluidos/i }).first();
  if (await tab.isVisible().catch(() => false)) await tab.click({ timeout: 15_000 });
  await delay(900);
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
  await loc.pressSequentially(fecha, { delay: fastMode() ? 10 : 25 });
  await loc.press("Tab");
  await delay(500);

  if (fechasValorEquivalentes(await loc.inputValue(), fecha)) return;

  await establecerValorInputAngular(page, name, fecha);
  await delay(400);
  if (fechasValorEquivalentes(await loc.inputValue(), fecha)) return;

  await loc.click({ force: true });
  await page.keyboard.press("Escape").catch(() => {});
  await delay(200);
  await loc.click({ force: true });
  await page.locator(".p-datepicker").first().waitFor({ state: "visible", timeout: 15_000 });
  await delay(350);

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
    await delay(280);
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
  await delay(450);
}

async function limpiarFormularioFiltros(page: Page): Promise<void> {
  const btn = page.getByRole("button", { name: /^limpiar$/i }).first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.click();
    await delay(1000);
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

/** Espera a que el portal muestre "Total: N" para la búsqueda actual. */
async function esperarRespuestaBusqueda(
  page: Page,
  navTimeoutMs: number,
  totalPieAntes?: number | null,
): Promise<{ totalPie: number | null; sinResultados: boolean }> {
  const vacio = page.getByText(/No se encontraron resultados\s+para tu búsqueda|No se encontraron resultados/i);
  const start = Date.now();
  while (Date.now() - start < navTimeoutMs) {
    const loading = page.locator(".p-datatable-loading, .p-blockui");
    if ((await loading.count()) > 0) {
      await loading.first().waitFor({ state: "hidden", timeout: 8000 }).catch(() => {});
    }

    if (await vacio.isVisible().catch(() => false)) {
      await delay(400);
      return { totalPie: 0, sinResultados: true };
    }

    const totalPie = await leerTotalPiePortal(page);
    if (totalPie !== null) {
      // Si el total no cambió, normalmente leímos el estado anterior mientras la SPA terminaba de refrescar.
      if (
        totalPieAntes !== undefined &&
        totalPieAntes !== null &&
        Number.isFinite(totalPieAntes) &&
        totalPie === totalPieAntes
      ) {
        await delay(450);
        continue;
      }

      // Estabilidad: intentamos leer "Total" dos veces para evitar valores parciales.
      await delay(500);
      const total2 = await leerTotalPiePortal(page);
      if (total2 !== null && total2 === totalPie) {
        return { totalPie, sinResultados: false };
      }

      await delay(300);
      continue;
    }

    await delay(320);
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
  const maxRounds = fastMode() ? 6 : 10;
  let filas: ComprasmxFila[] = [];
  for (let r = 0; r < maxRounds; r++) {
    filas = await extraerFilasNumeroyNombre(page);
    if (totalEsperado !== null && totalEsperado > 0) {
      if (filas.length >= totalEsperado) return filas.slice(0, totalEsperado);
      if (filas.length > 0 && filas.length < totalEsperado) {
        await delay(900);
        continue;
      }
    }
    if (filas.length > 0) break;
    await delay(900);
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
  await delay(150);
}

/**
 * Lleva el botón Buscar al viewport sin forzar todo el panel al final
 * (scrollHeight en el menú ocultaba fechas y podía dejar Buscar fuera según el contenedor).
 */
async function asegurarBotonBuscarVisible(page: Page): Promise<void> {
  const buscar = page.locator("form.sizetext").getByRole("button", { name: /^buscar$/i });
  await buscar.scrollIntoViewIfNeeded({ timeout: 15_000 }).catch(() => {});
  await delay(200);
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
  await delay(400);
}

async function abrirPanelFiltros(page: Page): Promise<void> {
  const filtros = page.getByRole("button", { name: /filtros/i }).first();
  await filtros.waitFor({ state: "visible", timeout: 90_000 });
  const fechaInput = page.locator('input[name="fechaDesdeP"]');
  if (!(await fechaInput.isVisible().catch(() => false))) {
    await filtros.click();
    await delay(1600);
  }
  if (!(await fechaInput.isVisible().catch(() => false))) {
    await filtros.click();
    await delay(1600);
  }
  await fechaInput.waitFor({ state: "visible", timeout: 60_000 });
}

async function cerrarOverlayMultiselect(page: Page, multiselect: ReturnType<Page["locator"]>): Promise<void> {
  await page.keyboard.press("Escape");
  await delay(350);
  await multiselect.locator(".p-multiselect").click();
  await delay(250);
  await page.keyboard.press("Escape");
  await delay(450);
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
    var cells = Array.from(tr.querySelectorAll("td")).map(function (td) { return norm(td.textContent || ""); });
    var numeroIdentificacion = cells[idxNum] || "";
    var nombre = cells[idxNombre] || "";
    if (numeroIdentificacion !== "" || nombre !== "") filas.push({ numeroIdentificacion: numeroIdentificacion, nombre: nombre });
  }
  return filas;
})()`;

function extraerFilasNumeroyNombre(page: Pick<Page, "evaluate">): Promise<ComprasmxFila[]> {
  return page.evaluate(EXTRACT_FILAS_UI_SCRIPT);
}

export type FetchComprasmxOptions = {
  /**
   * `true`/`false`: forzar modo con o sin ventana.
   * `undefined`: modo automático (ver `resolveHeaded` abajo).
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
 * Arranca Chromium al levantar el API para que la primera petición no pague todo el cold start.
 * - `COMPRASMX_WARM_BROWSER=0`: nunca.
 * - `COMPRASMX_WARM_BROWSER=1`: siempre (incluye headed: abre ventana al iniciar el servidor).
 * - sin definir: solo en headless (p. ej. producción con `PLAYWRIGHT_HEADLESS` o `NODE_ENV=production`).
 */
export async function warmComprasmxBrowser(): Promise<void> {
  if (process.env.COMPRASMX_REUSE_BROWSER === "0") return;
  const raw = process.env.COMPRASMX_WARM_BROWSER?.trim();
  if (raw === "0") return;
  const headed = resolveHeaded(undefined);
  if (raw !== "1" && headed) return;
  ensureBrowserShutdownHooks();
  const { width, height } = resolveViewportSize();
  await obtainSharedBrowser(headed, width, height);
}

async function instalarBloqueoRecursosLigeros(page: Page): Promise<void> {
  if (process.env.COMPRASMX_NO_BLOCK_RESOURCES === "1") return;
  await page.route("**/*", (route) => {
    const rt = route.request().resourceType();
    if (rt === "image" || rt === "media" || rt === "font") return route.abort();
    return route.continue();
  });
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

/** Por defecto en desarrollo: navegador visible; en producción: headless. */
function resolveHeaded(explicit?: boolean): boolean {
  if (explicit === false) return false;
  if (explicit === true) return true;
  if (process.env.PLAYWRIGHT_HEADLESS === "1") return false;
  if (process.env.PLAYWRIGHT_HEADED === "1") return true;
  if (process.env.NODE_ENV === "production") return false;
  return true;
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

    page = await browser.newPage({
      locale: "es-MX",
      timezoneId: TZ,
      viewport: { width, height },
    });

    await instalarBloqueoRecursosLigeros(page);

    const navTimeoutMs = Number(process.env.COMPRASMX_NAV_TIMEOUT_MS) || 120_000;
    page.setDefaultTimeout(navTimeoutMs);
    page.setDefaultNavigationTimeout(navTimeoutMs);

    await page.goto(SOURCE_URL, { waitUntil: "domcontentloaded" });
    await delay(1500);

    await abrirPanelFiltros(page);

    await delay(800);

    await scrollPanelFiltrosAlInicio(page);

    await limpiarFormularioFiltros(page);

    const pestana = pestanaEnv();
    await configurarVistaListado(page, pestana);

    await establecerFechaPublicacionCampo(page, "fechaDesdeP", fechaDesde);
    await establecerFechaPublicacionCampo(page, "fechaHastaP", fechaHasta);

    const domFechas = await leerValoresFechaPublicacionDom(page);

    const multiselect = page.locator('p-multiselect[name="entidades"]');
    await multiselect.locator(".p-multiselect").click();
    await delay(800);

    for (const nombre of entidades) {
      const rx = new RegExp(`^${escapeRegex(nombre)}$`, "i");
      await page.locator(".p-multiselect-item").filter({ hasText: rx }).first().click();
      await delay(140);
    }

    await cerrarOverlayMultiselect(page, multiselect);

    // Antes del click guardamos el total para poder detectar si la SPA todavía está mostrando el estado anterior.
    const totalPieAntesBusqueda = await leerTotalPiePortal(page);
    await clickBuscar(page, navTimeoutMs);

    const { totalPie, sinResultados } = await esperarRespuestaBusqueda(page, navTimeoutMs, totalPieAntesBusqueda);

    const filas = await extraerFilasConReintentos(page, totalPie, sinResultados);

    return {
      source: SOURCE_URL,
      fetchedAt: new Date().toISOString(),
      filtros: {
        fechaPublicacionDesde: fechaDesde,
        fechaPublicacionHasta: fechaHasta,
        entidadesFederativas: entidades,
        pestanaResultados: pestana,
      },
      valoresFormularioDetectados: {
        fechaDesdePublicacion: domFechas.desde,
        fechaHastaPublicacion: domFechas.hasta,
      },
      filas,
      totalFilas: filas.length,
      totalEnPieDePortal: sinResultados ? 0 : totalPie,
    };
  } finally {
    await page?.close().catch(() => {});
    if (disposableBrowser) await disposableBrowser.close().catch(() => {});
  }
}
