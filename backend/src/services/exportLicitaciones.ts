import path from "node:path";
import archiver from "archiver";
import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import type { Response } from "express";
import { crearReadStreamDocumento, resolverDocumentoComprasmx } from "./anexoStorage.js";
import type { ComprasmxDetalleProcedimiento, ComprasmxFila } from "./comprasmx.js";
import { expedienteParaNombreCarpeta, listarDocumentosLocalesComprasmx } from "./comprasmx.js";

export type ExportLicitacionesInput = {
  filas: ComprasmxFila[];
  fetchedAt?: string;
  filtros?: Record<string, unknown>;
  /** Si se envía, solo se incluyen estos nombres de archivo por expediente (clave = numeroIdentificacion). */
  documentosPorExpediente?: Record<string, string[]>;
};

const EXPORT_MAX_FILAS = Math.min(
  100,
  Math.max(1, Number(process.env.COMPRASMX_EXPORT_MAX_FILAS) || 50),
);

function textoO(v: string | null | undefined): string {
  const t = typeof v === "string" ? v.trim() : "";
  return t || "—";
}

function parrafoEtiqueta(etiqueta: string, valor: string): Paragraph {
  return new Paragraph({
    spacing: { after: 120 },
    children: [
      new TextRun({ text: `${etiqueta}: `, bold: true }),
      new TextRun({ text: valor }),
    ],
  });
}

function stringArrayFiltro(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean);
}

function parrafosFiltrosResumen(filtros: Record<string, unknown>): Paragraph[] {
  const out: Paragraph[] = [];

  const desde = typeof filtros.fechaPublicacionDesde === "string" ? filtros.fechaPublicacionDesde.trim() : "";
  const hasta = typeof filtros.fechaPublicacionHasta === "string" ? filtros.fechaPublicacionHasta.trim() : "";
  if (desde || hasta) {
    out.push(parrafoEtiqueta("Fecha de publicación", desde && hasta && desde !== hasta ? `${desde} → ${hasta}` : desde || hasta));
  }

  const entidades = stringArrayFiltro(filtros.entidadesFederativas);
  if (entidades.length > 0) {
    out.push(parrafoEtiqueta("Entidades federativas", entidades.join(", ")));
  }

  const palabrasClave = stringArrayFiltro(filtros.palabrasClave);
  if (palabrasClave.length > 0) {
    out.push(
      new Paragraph({
        spacing: { before: 80, after: 80 },
        children: [new TextRun({ text: "Palabras clave de la búsqueda:", bold: true })],
      }),
    );
    for (const p of palabrasClave) {
      out.push(
        new Paragraph({
          bullet: { level: 0 },
          spacing: { after: 40 },
          children: [new TextRun({ text: p })],
        }),
      );
    }
  }

  const pestana = typeof filtros.pestanaResultados === "string" ? filtros.pestanaResultados.trim() : "";
  if (pestana) out.push(parrafoEtiqueta("Pestaña de resultados", pestana));

  const maxDet = filtros.detalleProcedimientoMax;
  if (typeof maxDet === "number" && Number.isFinite(maxDet)) {
    out.push(parrafoEtiqueta("Límite de detalle por procedimiento", String(maxDet)));
  }

  const coincidencias = filtros.coincidenciasListadoKeyword;
  if (typeof coincidencias === "number" && Number.isFinite(coincidencias)) {
    out.push(parrafoEtiqueta("Coincidencias en listado (palabras clave)", String(coincidencias)));
  }

  const omitidos = filtros.detallesOmitidosPorLimite;
  if (typeof omitidos === "number" && omitidos > 0) {
    out.push(parrafoEtiqueta("Detalles omitidos por límite", String(omitidos)));
  }

  return out;
}

function seccionDetalle(detalle: ComprasmxDetalleProcedimiento): Paragraph[] {
  const dg = detalle.datosGenerales;
  const cr = detalle.cronograma;
  const out: Paragraph[] = [
    parrafoEtiqueta("Número de procedimiento", textoO(detalle.numeroProcedimientoContratacion)),
    parrafoEtiqueta("Dependencia o entidad", textoO(dg?.dependenciaOEntidad)),
    parrafoEtiqueta("Nombre del procedimiento", textoO(dg?.nombreProcedimiento)),
    parrafoEtiqueta("Descripción detallada", textoO(dg?.descripcionDetallada)),
    parrafoEtiqueta("Presentación y apertura de proposiciones", textoO(cr?.presentacionAperturaProposiciones)),
    parrafoEtiqueta("Límite aclaraciones (Compras MX)", textoO(cr?.limiteAclaracionesComprasmx)),
    parrafoEtiqueta("Aplica junta de aclaraciones", textoO(cr?.aplicaJuntaAclaraciones)),
    parrafoEtiqueta("Fecha y hora del acto del fallo", textoO(cr?.fechaHoraActoFallo)),
    parrafoEtiqueta("Entidad federativa de contratación", textoO(detalle.entidadFederativaContratacion)),
  ];
  if (detalle.error) out.push(parrafoEtiqueta("Error al leer detalle", detalle.error));
  return out;
}

async function buildResumenDocx(input: ExportLicitacionesInput, docCounts: Map<string, number>): Promise<Buffer> {
  const children: Paragraph[] = [
    new Paragraph({
      heading: HeadingLevel.TITLE,
      children: [new TextRun({ text: "Resumen de licitaciones — Compras MX", bold: true })],
    }),
  ];

  if (input.fetchedAt) children.push(parrafoEtiqueta("Consulta realizada", input.fetchedAt));
  if (input.filtros && Object.keys(input.filtros).length > 0) {
    children.push(...parrafosFiltrosResumen(input.filtros));
  }
  children.push(
    parrafoEtiqueta("Total de licitaciones en este export", String(input.filas.length)),
    new Paragraph({ spacing: { after: 240 }, children: [] }),
  );

  const nombresSeleccionados = input.documentosPorExpediente ?? {};

  for (let i = 0; i < input.filas.length; i++) {
    const f = input.filas[i]!;
    const nDocs = docCounts.get(f.numeroIdentificacion) ?? 0;
    const listaSel = nombresSeleccionados[f.numeroIdentificacion];
    const detalleDocs =
      listaSel && listaSel.length > 0
        ? `${nDocs} archivo(s) seleccionado(s): ${listaSel.join(", ")}`
        : nDocs > 0
          ? `${nDocs} archivo(s) en carpeta «${expedienteParaNombreCarpeta(f.numeroIdentificacion)}»`
          : "Sin archivos en esta exportación";
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 240, after: 120 },
        children: [new TextRun({ text: `${i + 1}. ${f.numeroIdentificacion}`, bold: true })],
      }),
      parrafoEtiqueta("Nombre en listado", textoO(f.nombre)),
      parrafoEtiqueta("Documentos en ZIP", detalleDocs),
    );
    if (f.detalleProcedimiento) children.push(...seccionDetalle(f.detalleProcedimiento));
    children.push(new Paragraph({ spacing: { after: 200 }, children: [] }));
  }

  return Packer.toBuffer(new Document({ sections: [{ properties: {}, children }] }));
}

function nombreZipExport(fetchedAt?: string): string {
  const d = fetchedAt ? new Date(fetchedAt) : new Date();
  const stamp = Number.isFinite(d.getTime())
    ? d.toISOString().slice(0, 19).replace(/[:T]/g, "-")
    : new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
  return `comprasmx-export-${stamp}.zip`.replace(/"/g, "");
}

function documentosAExportar(
  listado: { documentos: { nombre: string }[] },
  seleccion?: string[],
): { nombre: string }[] {
  if (!seleccion || seleccion.length === 0) return listado.documentos;
  const permitidos = new Set(seleccion);
  return listado.documentos.filter((d) => permitidos.has(d.nombre));
}

export async function streamExportLicitacionesZip(input: ExportLicitacionesInput, res: Response): Promise<void> {
  const filas = input.filas.slice(0, EXPORT_MAX_FILAS);
  const docCounts = new Map<string, number>();
  const seleccionGlobal = input.documentosPorExpediente ?? {};

  for (const f of filas) {
    const listed = await listarDocumentosLocalesComprasmx(f.numeroIdentificacion);
    const elegidos = documentosAExportar(listed, seleccionGlobal[f.numeroIdentificacion]);
    docCounts.set(f.numeroIdentificacion, elegidos.length);
  }

  const docxBuf = await buildResumenDocx({ ...input, filas }, docCounts);
  const jsonBuf = Buffer.from(
    JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        fetchedAt: input.fetchedAt ?? null,
        filtros: input.filtros ?? null,
        totalLicitaciones: filas.length,
        filas,
        documentosPorExpediente: await (async () => {
          const map: Record<string, string[]> = {};
          for (const f of filas) {
            const listed = await listarDocumentosLocalesComprasmx(f.numeroIdentificacion);
            map[f.numeroIdentificacion] = documentosAExportar(
              listed,
              seleccionGlobal[f.numeroIdentificacion],
            ).map((d) => d.nombre);
          }
          return map;
        })(),
      },
      null,
      2,
    ),
    "utf8",
  );

  res.setHeader("Content-Type", "application/zip");
  res.setHeader("Content-Disposition", `attachment; filename="${nombreZipExport(input.fetchedAt)}"`);

  const archive = archiver("zip", { zlib: { level: 6 } });
  archive.on("error", (err) => {
    if (!res.headersSent) throw err;
  });
  archive.pipe(res);

  archive.append(docxBuf, { name: "resumen_licitaciones.docx" });
  archive.append(jsonBuf, { name: "datos_licitaciones.json" });

  for (const f of filas) {
    const folder = expedienteParaNombreCarpeta(f.numeroIdentificacion);
    const listed = await listarDocumentosLocalesComprasmx(f.numeroIdentificacion);
    const aIncluir = documentosAExportar(listed, seleccionGlobal[f.numeroIdentificacion]);
    if (aIncluir.length === 0) {
      archive.append(
        `No hay archivos seleccionados para ${f.numeroIdentificacion}.\n`,
        { name: path.posix.join(folder, "LEEME_sin_documentos.txt") },
      );
      continue;
    }
    for (const d of aIncluir) {
      const meta = await resolverDocumentoComprasmx(f.numeroIdentificacion, d.nombre);
      if (!meta) continue;
      const stream = await crearReadStreamDocumento(meta);
      archive.append(stream, { name: path.posix.join(folder, d.nombre) });
    }
  }

  await archive.finalize();
}

function parseDocumentosPorExpediente(raw: unknown): Record<string, string[]> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string[]> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const id = k.trim();
    if (!id || !Array.isArray(v)) continue;
    const names = v
      .map((x) => (typeof x === "string" ? x.trim() : ""))
      .filter(Boolean);
    if (names.length > 0) out[id] = names;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export function parseExportRequestBody(
  body: unknown,
): { ok: true; input: ExportLicitacionesInput } | { ok: false; error: string } {
  const filasParsed = parseFilasExportBody(body);
  if (!filasParsed.ok) return filasParsed;
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body JSON inválido." };
  }
  const rec = body as Record<string, unknown>;
  const fetchedAt = typeof rec.fetchedAt === "string" ? rec.fetchedAt : undefined;
  const filtros =
    rec.filtros && typeof rec.filtros === "object" && !Array.isArray(rec.filtros)
      ? (rec.filtros as Record<string, unknown>)
      : undefined;
  const documentosPorExpediente = parseDocumentosPorExpediente(rec.documentosPorExpediente);
  if (documentosPorExpediente) {
    for (const f of filasParsed.filas) {
      const sel = documentosPorExpediente[f.numeroIdentificacion];
      if (!sel || sel.length === 0) {
        return {
          ok: false,
          error: `documentosPorExpediente: el expediente ${f.numeroIdentificacion} no tiene archivos seleccionados.`,
        };
      }
    }
  }
  return {
    ok: true,
    input: { filas: filasParsed.filas, fetchedAt, filtros, documentosPorExpediente },
  };
}

export function parseFilasExportBody(body: unknown): { ok: true; filas: ComprasmxFila[] } | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "Body JSON inválido." };
  }
  const rec = body as Record<string, unknown>;
  const raw = rec.filas;
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: "El body debe incluir filas: un arreglo no vacío de licitaciones del snapshot." };
  }
  if (raw.length > EXPORT_MAX_FILAS) {
    return { ok: false, error: `Demasiadas filas (${raw.length}). Máximo ${EXPORT_MAX_FILAS} por exportación.` };
  }
  const filas: ComprasmxFila[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Record<string, unknown>;
    const id = typeof o.numeroIdentificacion === "string" ? o.numeroIdentificacion.trim() : "";
    const nombre = typeof o.nombre === "string" ? o.nombre : "";
    if (!id) continue;
    const fila: ComprasmxFila = { numeroIdentificacion: id, nombre };
    if (typeof o.urlProcedimiento === "string") fila.urlProcedimiento = o.urlProcedimiento;
    if (o.detalleProcedimiento && typeof o.detalleProcedimiento === "object") {
      fila.detalleProcedimiento = o.detalleProcedimiento as ComprasmxDetalleProcedimiento;
    }
    filas.push(fila);
  }
  if (filas.length === 0) {
    return { ok: false, error: "Ninguna fila válida (cada una requiere numeroIdentificacion)." };
  }
  return { ok: true, filas };
}
