import fs from "node:fs/promises";
import path from "node:path";
import { type NextFunction, type Request, type Response, Router } from "express";
import {
  ENTIDADES_FEDERATIVAS_TODAS,
  fetchComprasmxSnapshot,
  fechaIsoAMexicoDdMmYyyy,
  listarDocumentosLocalesComprasmx,
  parseEntidadesFederativasCliente,
  parseFechaFiltradoDdMmYyyy,
  resolverDocumentoLocalComprasmx,
} from "../services/comprasmx.js";
import {
  esNombreArchivoConvertibleVistaPdf,
  resolverPdfVistaPrevia,
} from "../services/officePdfPreview.js";

function extArchivoLower(nombre: string): string {
  const base = path.basename(nombre.trim());
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

function esAbortoClienteSendfile(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as NodeJS.ErrnoException & { message?: string };
  if (e.code === "ECONNABORTED") return true;
  const m = typeof e.message === "string" ? e.message : "";
  return /aborted/i.test(m);
}

export const comprasmxRouter = Router();

/** Nombres canónicos de las 32 entidades (mismo criterio que valida POST /snapshot). */
comprasmxRouter.get("/entidades", (_req: Request, res: Response) => {
  res.json({ entidades: [...ENTIDADES_FEDERATIVAS_TODAS] });
});

function requestBodyRecord(req: Request): Record<string, unknown> {
  const b = req.body;
  if (b && typeof b === "object" && !Array.isArray(b)) return b as Record<string, unknown>;
  return {};
}

function firstBodyString(req: Request, key: string): string | undefined {
  const v = requestBodyRecord(req)[key];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
}

function firstQueryString(q: unknown): string | undefined {
  const raw = Array.isArray(q) ? q[0] : q;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

/** `undefined` si no viene query → headless por defecto; `?headed=1` para ventana visible. */
function parseHeadedQuery(q: unknown): boolean | undefined {
  const raw = Array.isArray(q) ? q[0] : q;
  if (typeof raw !== "string") return undefined;
  const v = raw.toLowerCase();
  if (["1", "true", "yes"].includes(v)) return true;
  if (["0", "false", "no", "headless"].includes(v)) return false;
  return undefined;
}

/** Body JSON tiene prioridad sobre query: `fechaISO` | `fecha` | `fechaDesde`+`fechaHasta` */
function parseFechasFromRequest(req: Request): { desde: string; hasta: string } | undefined {
  const iso = firstBodyString(req, "fechaISO") ?? firstQueryString(req.query.fechaISO);
  if (iso) {
    const p = fechaIsoAMexicoDdMmYyyy(iso);
    if (!p) return undefined;
    return { desde: p, hasta: p };
  }
  const fecha = firstBodyString(req, "fecha") ?? firstQueryString(req.query.fecha);
  if (fecha) {
    const p = parseFechaFiltradoDdMmYyyy(fecha);
    if (!p) return undefined;
    return { desde: p, hasta: p };
  }
  const fd = firstBodyString(req, "fechaDesde") ?? firstQueryString(req.query.fechaDesde);
  const fh = firstBodyString(req, "fechaHasta") ?? firstQueryString(req.query.fechaHasta);
  if (!fd && !fh) return undefined;
  const pd = fd ? parseFechaFiltradoDdMmYyyy(fd) : null;
  const ph = fh ? parseFechaFiltradoDdMmYyyy(fh) : null;
  if (!pd || !ph) return undefined;
  return { desde: pd, hasta: ph };
}

function fechaIsoSource(req: Request): string | undefined {
  return firstBodyString(req, "fechaISO") ?? firstQueryString(req.query.fechaISO);
}

/**
 * Lista PDF/archivos guardados localmente para un número de identificación (misma carpeta que el crawler).
 * Query obligatorio: `numeroIdentificacion` (como en el listado de Compras MX).
 * Los archivos existen tras un `/snapshot` con `palabrasClave` que haya descargado anexos.
 */
comprasmxRouter.get("/documentos", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = firstQueryString(req.query.numeroIdentificacion);
    if (!id) {
      res.status(400).json({
        error:
          "Query obligatorio: numeroIdentificacion. Ej. GET /comprasmx/documentos?numeroIdentificacion=AA-012345678",
      });
      return;
    }
    const data = await listarDocumentosLocalesComprasmx(id);
    const qs = (nombre: string) =>
      `${req.baseUrl}/documentos/archivo?${new URLSearchParams({ numeroIdentificacion: data.numeroIdentificacion, nombre }).toString()}`;
    const qsVistaPdf = (nombre: string) =>
      `${req.baseUrl}/documentos/archivo?${new URLSearchParams({
        numeroIdentificacion: data.numeroIdentificacion,
        nombre,
        vista: "pdf",
      }).toString()}`;
    res.json({
      ...data,
      documentos: data.documentos.map((d) => {
        const nombreLower = d.nombre.trim().toLowerCase();
        const esPdf = nombreLower.endsWith(".pdf");
        const urlVistaPdf =
          esNombreArchivoConvertibleVistaPdf(d.nombre) || esPdf ? qsVistaPdf(d.nombre) : undefined;
        return {
          ...d,
          urlDescarga: qs(d.nombre),
          ...(urlVistaPdf ? { urlVistaPdf } : {}),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Sirve un archivo de la carpeta del expediente. Queries: `numeroIdentificacion`, `nombre` (nombre exacto en disco).
 * Opcional: `disposition=attachment` para forzar descarga.
 * Opcional: `vista=pdf` — PDF nativo se envía igual sin conversión; Word/Excel/PowerPoint y similares se convierten
 * a PDF con LibreOffice (`soffice`) solo en esa petición (caché en disco). Requiere LibreOffice en el servidor.
 */
comprasmxRouter.get("/documentos/archivo", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = firstQueryString(req.query.numeroIdentificacion);
    const nombre = firstQueryString(req.query.nombre);
    if (!id || !nombre) {
      res.status(400).json({
        error:
          "Queries obligatorios: numeroIdentificacion y nombre (ej. 01_documento.pdf). Lista con GET /comprasmx/documentos?numeroIdentificacion=…",
      });
      return;
    }
    const meta = await resolverDocumentoLocalComprasmx(id, nombre);
    if (!meta) {
      res.status(404).json({ error: "Archivo no encontrado o ruta no permitida." });
      return;
    }
    const attachment = firstQueryString(req.query.disposition)?.toLowerCase() === "attachment";
    const vistaPdf = firstQueryString(req.query.vista)?.toLowerCase() === "pdf";

    /** Vista PDF en navegador: PDF nativo se sirve tal cual; el resto (Office, etc.) pasa por LibreOffice solo aquí. */
    if (vistaPdf) {
      const ext = extArchivoLower(nombre);
      if (ext === "pdf") {
        const base = path.basename(meta.absolutePath);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `${attachment ? "attachment" : "inline"}; filename="${base.replace(/"/g, "")}"`);
        res.sendFile(meta.absolutePath, (err) => {
          if (err && !esAbortoClienteSendfile(err) && !res.headersSent) next(err);
        });
        return;
      }
      if (!esNombreArchivoConvertibleVistaPdf(nombre)) {
        res.status(400).json({
          error:
            "vista=pdf solo convierte formatos Office u hoja de cálculo admitidos. Los PDF se sirven sin vista=pdf (o con vista=pdf se reenvía el mismo archivo sin conversión).",
        });
        return;
      }
      try {
        const pdfAbs = await resolverPdfVistaPrevia(meta.absolutePath);
        const stem = path.basename(nombre, path.extname(nombre));
        const fname = `${stem}.pdf`.replace(/"/g, "");
        const buf = await fs.readFile(pdfAbs);
        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `${attachment ? "attachment" : "inline"}; filename="${fname}"`);
        res.setHeader("Content-Length", String(buf.length));
        res.send(buf);
        return;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const code = msg.includes("ENOENT") || msg.toLowerCase().includes("spawn") ? 503 : 500;
        res.status(code).json({
          error:
            code === 503
              ? "No se pudo ejecutar LibreOffice (`soffice`). Instálalo o define LIBREOFFICE_SOFFICE con la ruta al binario."
              : msg,
        });
        return;
      }
    }

    const base = path.basename(meta.absolutePath);
    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Content-Disposition", `${attachment ? "attachment" : "inline"}; filename="${base.replace(/"/g, "")}"`);
    res.sendFile(meta.absolutePath, (err) => {
      if (err && !esAbortoClienteSendfile(err) && !res.headersSent) next(err);
    });
  } catch (err) {
    next(err);
  }
});

comprasmxRouter.post("/snapshot", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const headedExplicit = parseHeadedQuery(req.query.headed);

    const fechas = parseFechasFromRequest(req);
    if (fechaIsoSource(req) && !fechas) {
      res.status(400).json({ error: "fechaISO inválida. Usa YYYY-MM-DD en el body o query, ej. 2026-05-08" });
      return;
    }
    if ((firstBodyString(req, "fecha") ?? firstQueryString(req.query.fecha)) && !fechas) {
      res.status(400).json({
        error: "fecha inválida. Usa DD/MM/AAAA en el body o query, ej. 08/05/2026",
      });
      return;
    }
    if (
      (firstBodyString(req, "fechaDesde") ||
        firstBodyString(req, "fechaHasta") ||
        firstQueryString(req.query.fechaDesde) ||
        firstQueryString(req.query.fechaHasta)) &&
      !fechas
    ) {
      res.status(400).json({
        error:
          "Usa ambos 'fechaDesde' y 'fechaHasta' en DD/MM/AAAA, o un solo 'fecha' / 'fechaISO' para el mismo día.",
      });
      return;
    }

    const body = requestBodyRecord(req);

    const entidadesInBody = Object.prototype.hasOwnProperty.call(body, "entidadesFederativas");
    const entidadesParsed = parseEntidadesFederativasCliente(
      entidadesInBody ? body["entidadesFederativas"] : undefined,
    );
    if (entidadesParsed.error) {
      res.status(400).json({ error: entidadesParsed.error });
      return;
    }

    const palabrasClaveRaw = body["palabrasClave"];
    let palabrasClave: string[] | undefined;
    if (palabrasClaveRaw !== undefined) {
      if (!Array.isArray(palabrasClaveRaw) || palabrasClaveRaw.some((p) => typeof p !== "string")) {
        res.status(400).json({ error: "palabrasClave debe ser un arreglo de cadenas, ej. [\"mantenimiento\", \"limpieza\"]" });
        return;
      }
      palabrasClave = (palabrasClaveRaw as string[]).map((p) => p.trim()).filter(Boolean);
      if (palabrasClave.length === 0) {
        res.status(400).json({ error: "Si envías palabrasClave, incluye al menos una cadena no vacía." });
        return;
      }
    }

    const data = await fetchComprasmxSnapshot({
      ...(headedExplicit !== undefined ? { headed: headedExplicit } : {}),
      ...(fechas ? { fechaPublicacionDesde: fechas.desde, fechaPublicacionHasta: fechas.hasta } : {}),
      ...(entidadesParsed.values ? { entidadesFederativas: entidadesParsed.values } : {}),
      ...(palabrasClave ? { palabrasClave } : {}),
    });
    res.json(data);
  } catch (err) {
    next(err);
  }
});
