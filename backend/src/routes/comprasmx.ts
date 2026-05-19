import fs from "node:fs/promises";
import path from "node:path";
import archiver from "archiver";
import { pipeline } from "node:stream/promises";
import { type NextFunction, type Request, type Response, Router } from "express";
import {
  crearReadStreamDocumento,
  materializarDocumentoATemp,
  resolverDocumentoComprasmx,
} from "../services/anexoStorage.js";
import {
  ENTIDADES_FEDERATIVAS_TODAS,
  esCancelacionCliente,
  fetchComprasmxSnapshot,
  fechaIsoAMexicoDdMmYyyy,
  listarDocumentosLocalesComprasmx,
  parseEntidadesFederativasCliente,
  parseFechaFiltradoDdMmYyyy,
  type ComprasmxSnapshot,
  type FetchComprasmxOptions,
} from "../services/comprasmx.js";
import {
  getPersistedSnapshot,
  listPersistedSnapshots,
  persistSnapshotResponse,
  snapshotsPersistenceAvailable,
} from "../services/snapshotPersistence.js";
import {
  parseExportRequestBody,
  streamExportLicitacionesZip,
} from "../services/exportLicitaciones.js";
import { verifyArchivoViewerToken } from "../services/archivoViewerToken.js";
import {
  buildPublicArchivoUrl,
  publicApiOrigin,
  resolverUrlsGoogleDocsViewer,
} from "../services/googleDocsViewer.js";
import {
  esNombreArchivoConvertibleVistaPdf,
  resolverPdfVistaPrevia,
} from "../services/officePdfPreview.js";
import { listarDocumentosComprasmx } from "../services/anexoStorage.js";

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

type ParseSnapshotResult =
  | { ok: true; fetchOpts: FetchComprasmxOptions }
  | { ok: false; status: number; body: { error: string } };

function parseSnapshotFetchOptions(req: Request): ParseSnapshotResult {
  const headedExplicit = parseHeadedQuery(req.query.headed);

  const fechas = parseFechasFromRequest(req);
  if (fechaIsoSource(req) && !fechas) {
    return { ok: false, status: 400, body: { error: "fechaISO inválida. Usa YYYY-MM-DD en el body o query, ej. 2026-05-08" } };
  }
  if ((firstBodyString(req, "fecha") ?? firstQueryString(req.query.fecha)) && !fechas) {
    return { ok: false, status: 400, body: { error: "fecha inválida. Usa DD/MM/AAAA en el body o query, ej. 08/05/2026" } };
  }
  if (
    (firstBodyString(req, "fechaDesde") ||
      firstBodyString(req, "fechaHasta") ||
      firstQueryString(req.query.fechaDesde) ||
      firstQueryString(req.query.fechaHasta)) &&
    !fechas
  ) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "Usa ambos 'fechaDesde' y 'fechaHasta' en DD/MM/AAAA, o un solo 'fecha' / 'fechaISO' para el mismo día.",
      },
    };
  }

  if (!fechas) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "La búsqueda requiere fecha explícita: envía fechaISO (YYYY-MM-DD) o fecha (DD/MM/AAAA) o fechaDesde y fechaHasta (DD/MM/AAAA) en el body o query.",
      },
    };
  }

  const body = requestBodyRecord(req);

  const entidadesInBody = Object.prototype.hasOwnProperty.call(body, "entidadesFederativas");
  if (!entidadesInBody) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "El body debe incluir entidadesFederativas: un arreglo no vacío de estados (nombres canónicos, véase GET /comprasmx/entidades).",
      },
    };
  }
  const entidadesParsed = parseEntidadesFederativasCliente(
    entidadesInBody ? body["entidadesFederativas"] : undefined,
  );
  if (entidadesParsed.error) {
    return { ok: false, status: 400, body: { error: entidadesParsed.error } };
  }
  if (!entidadesParsed.values || entidadesParsed.values.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: "entidadesFederativas debe incluir al menos un estado reconocido." },
    };
  }

  const palabrasInBody = Object.prototype.hasOwnProperty.call(body, "palabrasClave");
  if (!palabrasInBody) {
    return {
      ok: false,
      status: 400,
      body: {
        error:
          "El body debe incluir palabrasClave: un arreglo con al menos una cadena no vacía (filtro sobre el nombre de la licitación).",
      },
    };
  }
  const palabrasClaveRaw = body["palabrasClave"];
  if (!Array.isArray(palabrasClaveRaw) || palabrasClaveRaw.some((p) => typeof p !== "string")) {
    return {
      ok: false,
      status: 400,
      body: { error: 'palabrasClave debe ser un arreglo de cadenas, ej. ["mantenimiento", "limpieza"]' },
    };
  }
  const palabrasClave = (palabrasClaveRaw as string[]).map((p) => p.trim()).filter(Boolean);
  if (palabrasClave.length === 0) {
    return {
      ok: false,
      status: 400,
      body: { error: "palabrasClave debe contener al menos una palabra o frase no vacía." },
    };
  }

  const fetchOpts: FetchComprasmxOptions = {
    ...(headedExplicit !== undefined ? { headed: headedExplicit } : {}),
    fechaPublicacionDesde: fechas.desde,
    fechaPublicacionHasta: fechas.hasta,
    entidadesFederativas: entidadesParsed.values,
    palabrasClave,
  };

  return { ok: true, fetchOpts };
}

export const comprasmxRouter = Router();

/** Nombres canónicos de las 32 entidades (mismo criterio que valida POST /snapshot). */
comprasmxRouter.get("/entidades", (_req: Request, res: Response) => {
  res.json({ entidades: [...ENTIDADES_FEDERATIVAS_TODAS] });
});

/** Sube el JSON a Drive sin bloquear la respuesta HTTP al cliente. */
function programarPersistenciaSnapshotEnDrive(data: ComprasmxSnapshot): void {
  if (!snapshotsPersistenceAvailable()) return;
  void persistSnapshotResponse(data)
    .then((id) => {
      console.log(`[comprasmx] Snapshot JSON guardado en Drive (background): ${id}`);
    })
    .catch((err) => {
      console.error("[comprasmx] Error guardando snapshot JSON en Drive (background):", err);
    });
}

/** Lista snapshots guardados en Google Drive (`_comprasmx_snapshots/`). */
comprasmxRouter.get("/snapshots", async (_req: Request, res: Response) => {
  try {
    if (!snapshotsPersistenceAvailable()) {
      res.status(503).json({
        error: "Snapshots en Drive no disponibles. Activa GOOGLE_DRIVE_ENABLED y credenciales.",
      });
      return;
    }
    const snapshots = await listPersistedSnapshots();
    res.json({ snapshots, storage: "drive" as const });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(503).json({ error: `No se pudo listar snapshots en Drive: ${msg}` });
  }
});

/** Recupera el JSON completo de un snapshot guardado en Drive. */
comprasmxRouter.get("/snapshots/:id", async (req: Request, res: Response, next: NextFunction) => {
  try {
    if (!snapshotsPersistenceAvailable()) {
      res.status(503).json({
        error: "Snapshots en Drive no disponibles. Activa GOOGLE_DRIVE_ENABLED y credenciales.",
      });
      return;
    }
    const id = typeof req.params.id === "string" ? req.params.id.trim() : "";
    const record = await getPersistedSnapshot(id);
    if (!record) {
      res.status(404).json({ error: "Snapshot no encontrado en Drive." });
      return;
    }
    res.json(record);
  } catch (err) {
    next(err);
  }
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
    let listed;
    try {
      listed = await listarDocumentosComprasmx(id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      res.status(503).json({
        error: `No se pudo listar documentos (Drive/local): ${msg}`,
      });
      return;
    }
    const data = {
      numeroIdentificacion: listed.numeroIdentificacion,
      carpetaEnDisco: listed.ubicacion,
      almacenamiento: listed.almacenamiento,
      total: listed.total,
      documentos: listed.documentos,
    };
    const apiOrigin = publicApiOrigin();
    const qs = (nombre: string) =>
      `${req.baseUrl}/documentos/archivo?${new URLSearchParams({ numeroIdentificacion: data.numeroIdentificacion, nombre }).toString()}`;
    const qsVistaPdf = (nombre: string) =>
      `${req.baseUrl}/documentos/archivo?${new URLSearchParams({
        numeroIdentificacion: data.numeroIdentificacion,
        nombre,
        vista: "pdf",
      }).toString()}`;
    const urlZip = `${req.baseUrl}/documentos/zip?${new URLSearchParams({ numeroIdentificacion: data.numeroIdentificacion }).toString()}`;
    res.json({
      ...data,
      urlZip,
      documentos: data.documentos.map((d) => {
        const officePreview =
          process.env.COMPRASMX_OFFICE_PDF_PREVIEW === "1" && esNombreArchivoConvertibleVistaPdf(d.nombre);
        const urlVistaPdf = officePreview ? qsVistaPdf(d.nombre) : undefined;
        const publicArchivoUrl =
          apiOrigin &&
          buildPublicArchivoUrl({
            apiOrigin,
            basePath: req.baseUrl,
            numeroIdentificacion: data.numeroIdentificacion,
            nombre: d.nombre,
          });
        const google = resolverUrlsGoogleDocsViewer({
          nombreArchivo: d.nombre,
          numeroIdentificacion: data.numeroIdentificacion,
          driveFileId: d.driveFileId,
          publicArchivoUrl,
        });
        return {
          ...d,
          urlDescarga: qs(d.nombre),
          ...(urlVistaPdf ? { urlVistaPdf } : {}),
          ...(google
            ? {
                urlVistaGoogle: google.embedUrl,
                vistaGoogleModo: google.embedModo,
                urlVistaGoogleDrive: google.alternativaDrivePreview,
                avisoVistaGoogle: google.aviso,
              }
            : {}),
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Descarga un solo `.zip` con todos los archivos locales del expediente (misma carpeta que `/documentos`).
 * Query: `numeroIdentificacion`. Los nombres dentro del ZIP coinciden con los archivos en disco.
 */
comprasmxRouter.get("/documentos/zip", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = firstQueryString(req.query.numeroIdentificacion);
    if (!id) {
      res.status(400).json({
        error:
          "Query obligatorio: numeroIdentificacion. Ej. GET /comprasmx/documentos/zip?numeroIdentificacion=AA-012345678",
      });
      return;
    }
    const data = await listarDocumentosLocalesComprasmx(id);
    if (data.total === 0) {
      res.status(404).json({ error: "No hay archivos para este expediente. Ejecuta un snapshot con descarga de anexos primero." });
      return;
    }

    const stem = id
      .replace(/[^\p{L}\p{N}._-]+/gu, "_")
      .replace(/_+/g, "_")
      .slice(0, 80);
    const zipName = `comprasmx-${stem || "expediente"}.zip`.replace(/"/g, "");

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${zipName}"`);

    const archive = archiver("zip", { zlib: { level: 6 } });
    const onArchiveErr = (err: Error) => {
      if (!res.headersSent) next(err);
      else {
        try {
          archive.abort();
        } catch {
          /* ignore */
        }
      }
    };
    archive.on("error", onArchiveErr);
    archive.pipe(res);

    const onClose = () => {
      try {
        archive.abort();
      } catch {
        /* ignore */
      }
    };
    req.on("close", onClose);
    try {
      for (const d of data.documentos) {
        const meta = await resolverDocumentoComprasmx(data.numeroIdentificacion, d.nombre);
        if (!meta) continue;
        const stream = await crearReadStreamDocumento(meta);
        archive.append(stream, { name: d.nombre });
      }
      await archive.finalize();
    } finally {
      req.off("close", onClose);
    }
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
    const viewerToken = firstQueryString(req.query.viewerToken);
    if (viewerToken && !verifyArchivoViewerToken(viewerToken, id, nombre)) {
      res.status(403).json({ error: "Token de vista inválido o expirado." });
      return;
    }

    const meta = await resolverDocumentoComprasmx(id, nombre);
    if (!meta) {
      res.status(404).json({ error: "Archivo no encontrado o ruta no permitida." });
      return;
    }
    const attachment = firstQueryString(req.query.disposition)?.toLowerCase() === "attachment";
    const vistaPdf = firstQueryString(req.query.vista)?.toLowerCase() === "pdf";
    const fnameSafe = path.basename(meta.nombre).replace(/"/g, "");

    /** Vista PDF en navegador: PDF nativo se sirve tal cual; el resto (Office, etc.) pasa por LibreOffice solo aquí. */
    if (vistaPdf) {
      const ext = extArchivoLower(nombre);
      if (ext === "pdf") {
        res.redirect(
          302,
          `${req.baseUrl}/documentos/archivo?${new URLSearchParams({
            numeroIdentificacion: id,
            nombre,
            ...(attachment ? { disposition: "attachment" } : {}),
          }).toString()}`,
        );
        return;
      }
      if (process.env.COMPRASMX_OFFICE_PDF_PREVIEW !== "1") {
        res.status(501).json({
          error:
            "Vista PDF de Office desactivada. Usa la descarga directa o define COMPRASMX_OFFICE_PDF_PREVIEW=1 y LibreOffice.",
        });
        return;
      }
      if (!esNombreArchivoConvertibleVistaPdf(nombre)) {
        res.status(400).json({
          error: "vista=pdf solo aplica a formatos Office admitidos o archivos PDF (use la URL sin vista=pdf).",
        });
        return;
      }
      let tempOrigen: string | null = null;
      try {
        tempOrigen =
          meta.storage === "local" && meta.absolutePath
            ? meta.absolutePath
            : await materializarDocumentoATemp(meta);
        const pdfAbs = await resolverPdfVistaPrevia(tempOrigen);
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
        const errno = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
        const sinLibreOffice =
          errno === "ENOENT" || msg.includes("ENOENT") || msg.toLowerCase().includes("spawn");
        res.status(sinLibreOffice ? 503 : 500).json({
          error: sinLibreOffice
            ? "No se pudo ejecutar LibreOffice (`soffice`). Instálalo o define LIBREOFFICE_SOFFICE con la ruta al binario."
            : msg,
        });
        return;
      } finally {
        if (tempOrigen && meta.storage === "drive") {
          await fs.rm(path.dirname(tempOrigen), { recursive: true, force: true }).catch(() => {});
        }
      }
    }

    res.setHeader("Content-Type", meta.mime);
    res.setHeader("Content-Disposition", `${attachment ? "attachment" : "inline"}; filename="${fnameSafe}"`);
    if (meta.storage === "local" && meta.absolutePath) {
      res.sendFile(meta.absolutePath, (err) => {
        if (err && !esAbortoClienteSendfile(err) && !res.headersSent) next(err);
      });
      return;
    }
    try {
      const stream = await crearReadStreamDocumento(meta);
      await pipeline(stream, res);
    } catch (e) {
      if (!res.headersSent) {
        const msg = e instanceof Error ? e.message : String(e);
        res.status(502).json({ error: `No se pudo leer el archivo: ${msg}` });
      }
    }
  } catch (err) {
    next(err);
  }
});

comprasmxRouter.post("/export", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = parseExportRequestBody(req.body);
    if (!parsed.ok) {
      res.status(400).json({ error: parsed.error });
      return;
    }
    await streamExportLicitacionesZip(parsed.input, res);
  } catch (err) {
    next(err);
  }
});

comprasmxRouter.post("/snapshot", async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parsed = parseSnapshotFetchOptions(req);
    if (!parsed.ok) {
      res.status(parsed.status).json(parsed.body);
      return;
    }
    const ac = new AbortController();
    /** `req` puede emitir `close` al terminar de leer el body; usar `res` y solo abortar si la respuesta no terminó. */
    const onClientDisconnected = () => {
      if (!res.writableEnded) ac.abort();
    };
    res.on("close", onClientDisconnected);
    try {
      const data = await fetchComprasmxSnapshot({ ...parsed.fetchOpts, signal: ac.signal });
      programarPersistenciaSnapshotEnDrive(data);
      res.json(data);
    } finally {
      res.off("close", onClientDisconnected);
    }
  } catch (err) {
    next(err);
  }
});

/**
 * Igual que POST /snapshot pero responde con **NDJSON** (una línea JSON por evento):
 * `{"type":"progress",...}` avances; al terminar `{"type":"done","payload":{...}}` o `{"type":"error","message":"..."}`.
 * Útil para mostrar progreso en el cliente sin WebSockets.
 */
comprasmxRouter.post("/snapshot/stream", async (req: Request, res: Response, next: NextFunction) => {
  const parsed = parseSnapshotFetchOptions(req);
  if (!parsed.ok) {
    res.status(parsed.status).json(parsed.body);
    return;
  }

  res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  const resFlush = res as Response & { flushHeaders?: () => void };
  if (typeof resFlush.flushHeaders === "function") resFlush.flushHeaders();

  const writeNdjson = (obj: object) => {
    if (res.writableEnded) return;
    res.write(`${JSON.stringify(obj)}\n`);
  };

  const ac = new AbortController();
  const onClientDisconnected = () => {
    if (!res.writableEnded) ac.abort();
  };
  res.on("close", onClientDisconnected);

  try {
    const data = await fetchComprasmxSnapshot({
      ...parsed.fetchOpts,
      signal: ac.signal,
      onProgress: (ev) => writeNdjson({ type: "progress", ...ev }),
    });
    programarPersistenciaSnapshotEnDrive(data);
    writeNdjson({ type: "done", payload: data });
    res.end();
  } catch (e) {
    const msg = esCancelacionCliente(e)
      ? "Consulta cancelada por el cliente."
      : e instanceof Error
        ? e.message
        : String(e);
    if (!res.writableEnded) {
      writeNdjson({ type: "error", message: msg });
      res.end();
    } else {
      next(e);
    }
  } finally {
    res.off("close", onClientDisconnected);
  }
});
