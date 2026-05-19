"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import {
  comprasmxApiBase,
  errorUiDesdeJson,
  fetchComprasmxConTimeout,
  proxiedComprasmxUrl,
  readComprasmxJsonResponse,
} from "@/lib/comprasmx-api";
import {
  COMPRASMX_STREAM_CONEXION_INICIAL_MS,
  COMPRASMX_STREAM_SIN_AVANCE_MS,
  esErrorStallStream,
  leerStreamConLimiteInactividad,
} from "@/lib/comprasmx-stream";
import {
  errorValidacionComprasmx,
  LEYENDA_SERVICIO_NO_DISPONIBLE,
  resolverErrorComprasmxUsuario,
  TITULO_SERVICIO_NO_DISPONIBLE,
  type ComprasmxUiError,
} from "@/lib/comprasmx-servicio";
import { ComprasmxErrorAviso } from "@/app/components/ComprasmxErrorAviso";
import {
  appendSnapshotHistoryEntry,
  clearSnapshotHistory,
  getHistoryEntry,
  listSnapshotHistory,
  mergeDocumentosIntoHistoryEntry,
  removeHistoryEntry,
  type ComprasmxHistoryEntry,
} from "@/lib/comprasmx-snapshot-history";
import {
  DEFAULT_ENTIDADES_FEDERATIVAS,
  DEFAULT_PALABRAS_CLAVE,
  ENTIDADES_TODAS_FALLBACK,
  etiquetaEntidadFederativa,
} from "@/lib/comprasmx-defaults";
import { esFechaIsoValida, fechaIsoHoyMexico } from "@/lib/fecha-mexico";
import { formatoDuracionSegundos } from "@/lib/formato-duracion";
import { officeClienteTipo } from "@/lib/office-client-preview";
import { DocumentoPreviewLoading } from "@/app/components/DocumentoPreviewLoading";
import { PalabrasClaveChips } from "@/app/components/PalabrasClaveChips";
import {
  ExportacionPersonalizadaModal,
  type DocumentoExportRow,
} from "@/app/components/ExportacionPersonalizadaModal";
import {
  ExportacionProgresoOverlay,
  type ProgresoOverlayConfig,
} from "@/app/components/ExportacionProgresoOverlay";
import { OfficeClientPreview } from "@/app/components/OfficeClientPreview";

type DetalleProcedimientoResumen = {
  numeroProcedimientoContratacion?: string | null;
  datosGenerales?: {
    dependenciaOEntidad?: string | null;
    descripcionDetallada?: string | null;
    nombreProcedimiento?: string | null;
  };
  cronograma?: {
    presentacionAperturaProposiciones?: string | null;
    limiteAclaracionesComprasmx?: string | null;
    aplicaJuntaAclaraciones?: string | null;
    fechaHoraActoFallo?: string | null;
  };
  entidadFederativaContratacion?: string | null;
  error?: string;
};

type ComprasmxFila = {
  numeroIdentificacion: string;
  nombre: string;
  urlProcedimiento?: string;
  detalleProcedimiento?: DetalleProcedimientoResumen;
};

type SnapshotResponse = {
  filas: ComprasmxFila[];
  totalFilas: number;
  totalEnPieDePortal?: number;
  filtros?: Record<string, unknown>;
  /** Viene del API al completar el snapshot. */
  fetchedAt?: string;
  /** Id en Google Drive del JSON guardado por el backend. */
  snapshotPersistId?: string;
  source?: string;
  error?: string;
};

type DocumentoRow = {
  nombre: string;
  sizeBytes: number;
  modificadoIso: string;
  urlDescarga: string;
  /** PDF para iframe: nativos o Office convertido en el API (`vista=pdf`). */
  urlVistaPdf?: string;
  /** Google Docs Viewer (Word, Excel, PowerPoint, etc.). */
  urlVistaGoogle?: string;
  vistaGoogleModo?: "drive-preview" | "gview";
  urlVistaGoogleDrive?: string;
  avisoVistaGoogle?: string;
};

type DocumentosResponse = {
  numeroIdentificacion: string;
  documentos: DocumentoRow[];
  /** Ruta absoluta del API para GET `/documentos/zip` de este expediente. */
  urlZip?: string;
  error?: string;
};

type NdJsonStreamBuffer = { rest: string };

function appendNdjsonChunk(chunk: string, buf: NdJsonStreamBuffer, onObject: (obj: unknown) => void): void {
  buf.rest += chunk;
  const lines = buf.rest.split("\n");
  buf.rest = lines.pop() ?? "";
  for (const line of lines) {
    const t = line.trim();
    if (!t) continue;
    try {
      onObject(JSON.parse(t) as unknown);
    } catch {
      /* línea incompleta o basura */
    }
  }
}

type SnapshotProgressLine = {
  phase: string;
  message: string;
  at: string;
  detalle?: string;
};

function extDeNombre(nombre: string): string {
  const i = nombre.lastIndexOf(".");
  return i >= 0 ? nombre.slice(i + 1).toLowerCase() : "";
}

function textoOGuion(v: string | null | undefined): string {
  const t = typeof v === "string" ? v.trim() : "";
  return t || "—";
}

function DetalleProcedimientoBloque({ detalle }: { detalle: DetalleProcedimientoResumen }) {
  if (detalle.error) {
    return (
      <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/50 dark:text-amber-100">
        Detalle: {detalle.error}
      </p>
    );
  }
  const dg = detalle.datosGenerales;
  const cr = detalle.cronograma;
  const filas: { k: string; v: string }[] = [
    { k: "Número de procedimiento de contratación", v: textoOGuion(detalle.numeroProcedimientoContratacion) },
    { k: "Dependencia o entidad", v: textoOGuion(dg?.dependenciaOEntidad) },
    { k: "Nombre del procedimiento", v: textoOGuion(dg?.nombreProcedimiento) },
    { k: "Descripción detallada", v: textoOGuion(dg?.descripcionDetallada) },
    { k: "Presentación y apertura de proposiciones", v: textoOGuion(cr?.presentacionAperturaProposiciones) },
    { k: "Límite aclaraciones (Compras MX)", v: textoOGuion(cr?.limiteAclaracionesComprasmx) },
    { k: "Aplica junta de aclaraciones", v: textoOGuion(cr?.aplicaJuntaAclaraciones) },
    { k: "Fecha y hora del acto del fallo", v: textoOGuion(cr?.fechaHoraActoFallo) },
    { k: "Entidad federativa de contratación", v: textoOGuion(detalle.entidadFederativaContratacion) },
  ];
  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Detalle del procedimiento
      </h3>
      <dl className="mt-3 grid gap-3 sm:grid-cols-1">
        {filas.map(({ k, v }) => (
          <div key={k}>
            <dt className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">{k}</dt>
            <dd className="mt-0.5 text-sm leading-snug text-zinc-800 dark:text-zinc-200">{v}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function esZipAnexoListado(nombre: string): boolean {
  return nombre.toLowerCase().endsWith(".zip");
}

function resumenFiltrosSnapshot(snap: SnapshotResponse): string | null {
  const filtros = snap.filtros;
  if (!filtros) return null;
  const partes: string[] = [];
  const desde = filtros.fechaPublicacionDesde;
  const hasta = filtros.fechaPublicacionHasta;
  if (typeof desde === "string" && typeof hasta === "string") {
    partes.push(`fecha ${desde}${desde !== hasta ? `–${hasta}` : ""}`);
  }
  const entidades = filtros.entidadesFederativas;
  if (Array.isArray(entidades)) {
    partes.push(`${entidades.length} entidad(es)`);
  }
  const kws = filtros.palabrasClave;
  if (Array.isArray(kws)) {
    partes.push(`${kws.length} palabra(s) clave`);
  }
  const coincidencias = filtros.coincidenciasListadoKeyword;
  if (typeof coincidencias === "number") {
    partes.push(`${coincidencias} coincidencia(s) en el listado del portal`);
  }
  const pie = snap.totalEnPieDePortal;
  if (typeof pie === "number" && pie > 0) {
    partes.push(`${pie} filas totales en Compras MX (sin filtro de palabras)`);
  }
  const omitidos = filtros.detallesOmitidosPorLimite;
  if (typeof omitidos === "number" && omitidos > 0) {
    partes.push(`${omitidos} omitida(s) por límite de detalle`);
  }
  return partes.length > 0 ? partes.join(" · ") : null;
}

function categoriaVista(nombre: string): "pdf" | "imagen" | "texto" | "otro" {
  const e = extDeNombre(nombre);
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "imagen";
  if (["txt", "csv", "json", "xml", "log", "md"].includes(e)) return "texto";
  return "otro";
}

function nombreLocalDescargaSeguro(nombre: string): string {
  const t = nombre.trim() || "documento";
  return t.replace(/[/\\?*:"<>|]/g, "_").slice(0, 240);
}

export function ComprasmxPanel() {
  const api = useMemo(() => comprasmxApiBase(), []);

  const [fechaISO, setFechaISO] = useState(fechaIsoHoyMexico);
  const [entidadesLista, setEntidadesLista] = useState<string[]>([...ENTIDADES_TODAS_FALLBACK]);
  const [entSel, setEntSel] = useState<Set<string>>(() => new Set(DEFAULT_ENTIDADES_FEDERATIVAS));
  const [palabrasClave, setPalabrasClave] = useState<string[]>([...DEFAULT_PALABRAS_CLAVE]);
  const [headed, setHeaded] = useState(false);

  const [loadingSnap, setLoadingSnap] = useState(false);
  const [snapError, setSnapError] = useState<ComprasmxUiError | null>(null);
  const [apiServicioCaido, setApiServicioCaido] = useState(false);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);

  const [docModal, setDocModal] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentoRow[]>([]);
  const [docsError, setDocsError] = useState<ComprasmxUiError | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [preview, setPreview] = useState<{
    nombre: string;
    url: string;
    texto?: string;
    /** true = PDF en iframe (archivo .pdf o conversión `vista=pdf` del backend). */
    modoPdf?: boolean;
    /** Office u hoja vía `vista=pdf`: el servidor puede estar convirtiendo. */
    conversionEnServidor?: boolean;
    modoOfficeCliente?: boolean;
    officeClienteTipo?: import("@/lib/office-client-preview").OfficeClienteTipo;
  } | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [downloadingAllDocs, setDownloadingAllDocs] = useState(false);
  const [downloadingZip, setDownloadingZip] = useState(false);
  const [docZipHref, setDocZipHref] = useState<string | null>(null);
  const [progresoOverlay, setProgresoOverlay] = useState<ProgresoOverlayConfig | null>(null);

  const [snapshotProgressOpen, setSnapshotProgressOpen] = useState(false);
  const [snapshotProgressLog, setSnapshotProgressLog] = useState<SnapshotProgressLine[]>([]);
  const [snapshotStreamDone, setSnapshotStreamDone] = useState(false);
  const [snapshotElapsedSec, setSnapshotElapsedSec] = useState(0);
  const snapshotAbortRef = useRef<AbortController | null>(null);
  const snapshotProgressEndRef = useRef<HTMLDivElement | null>(null);
  const snapshotProcessStartedAtRef = useRef<number | null>(null);
  /** Entrada de `localStorage` asociada al último snapshot guardado o al elegido en Historial. */
  const activeHistoryEntryIdRef = useRef<string | null>(null);

  const [historialOpen, setHistorialOpen] = useState(false);
  const [historialLista, setHistorialLista] = useState<ComprasmxHistoryEntry[]>([]);

  const [exportingAll, setExportingAll] = useState(false);
  const [exportError, setExportError] = useState<ComprasmxUiError | null>(null);
  const [exportPersonalizadoOpen, setExportPersonalizadoOpen] = useState(false);
  const [exportHistorialDocs, setExportHistorialDocs] = useState<
    Record<string, DocumentoExportRow[]> | undefined
  >(undefined);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`${api}/entidades`);
        const parsed = await readComprasmxJsonResponse<{ entidades?: string[] }>(r);
        if (!parsed.ok || cancel) {
          if (!parsed.ok && !cancel) setApiServicioCaido(true);
          return;
        }
        if (!Array.isArray(parsed.data.entidades) || parsed.data.entidades.length === 0) return;
        setEntidadesLista(parsed.data.entidades);
        setApiServicioCaido(false);
      } catch {
        if (!cancel) setApiServicioCaido(true);
        /* fallback ENTIDADES_TODAS_FALLBACK */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [api]);

  useEffect(() => {
    if (!preview?.modoPdf || !preview.url) {
      setPdfLoading(false);
      return;
    }
    setPdfLoading(true);
  }, [preview?.modoPdf, preview?.url]);

  useEffect(() => {
    if (!preview || preview.modoPdf || preview.modoOfficeCliente || categoriaVista(preview.nombre) !== "imagen") {
      setImgLoading(false);
      return;
    }
    setImgLoading(true);
  }, [preview?.nombre, preview?.url, preview?.modoPdf, preview?.modoOfficeCliente]);

  const descargarZipExpediente = useCallback(async () => {
    if (!docZipHref || !docModal || docs.length === 0 || loadingDocs) return;
    const expediente = docModal;
    setDownloadingZip(true);
    setProgresoOverlay({ tipo: "descarga-zip", expediente, archivosCount: docs.length });
    setDocsError(null);
    try {
      const r = await fetchComprasmxConTimeout(docZipHref, undefined, 300_000);
      if (!r.ok) {
        let msg = `No se pudo descargar el ZIP (${r.status})`;
        try {
          const j = (await r.json()) as { error?: string };
          if (typeof j.error === "string") msg = j.error;
        } catch {
          /* ignore */
        }
        setDocsError(resolverErrorComprasmxUsuario({ status: r.status, error: msg }, "descarga"));
        return;
      }
      const blob = await r.blob();
      const disp = r.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";\n]+)"?/i.exec(disp);
      const filename = m?.[1]?.trim() || `${expediente.replace(/[^\w.-]+/g, "_")}-anexos.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setDocsError(resolverErrorComprasmxUsuario({ err: e, sinRespuesta: esErrorStallStream(e) }, "descarga"));
    } finally {
      setDownloadingZip(false);
      setProgresoOverlay(null);
    }
  }, [docModal, docZipHref, docs.length, loadingDocs]);

  const descargarTodosDocumentos = useCallback(async () => {
    if (docs.length === 0 || !docModal) return;
    const expediente = docModal;
    setDownloadingAllDocs(true);
    setProgresoOverlay({ tipo: "descarga-individuales", expediente, archivosCount: docs.length });
    try {
      for (const d of docs) {
        try {
          const r = await fetch(d.urlDescarga);
          if (!r.ok) continue;
          const blob = await r.blob();
          const u = URL.createObjectURL(blob);
          const a = document.createElement("a");
          a.href = u;
          a.download = nombreLocalDescargaSeguro(d.nombre);
          a.rel = "noopener";
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(u);
          await new Promise((res) => setTimeout(res, 450));
        } catch {
          /* continuar con el siguiente */
        }
      }
    } finally {
      setDownloadingAllDocs(false);
      setProgresoOverlay(null);
    }
  }, [docModal, docs]);

  useEffect(() => {
    if (!snapshotProgressOpen || snapshotProgressLog.length === 0) return;
    snapshotProgressEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [snapshotProgressOpen, snapshotProgressLog]);

  useEffect(() => {
    if (!snapshotProgressOpen) return;
    const start = snapshotProcessStartedAtRef.current;
    if (start == null) return;
    const tick = () => setSnapshotElapsedSec(Math.floor((Date.now() - start) / 1000));
    tick();
    if (!loadingSnap) return;
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [snapshotProgressOpen, loadingSnap]);

  const toggleEnt = useCallback((nombre: string) => {
    setEntSel((prev) => {
      const n = new Set(prev);
      if (n.has(nombre)) n.delete(nombre);
      else n.add(nombre);
      return n;
    });
  }, []);

  const palabrasClavePayload = useCallback(() => palabrasClave, [palabrasClave]);

  const requisitosBusqueda = useMemo(() => {
    const faltantes: string[] = [];
    if (!esFechaIsoValida(fechaISO.trim())) {
      faltantes.push("fecha de publicación válida (YYYY-MM-DD)");
    }
    if (entSel.size === 0) {
      faltantes.push("al menos una entidad federativa");
    }
    if (palabrasClavePayload().length === 0) {
      faltantes.push("al menos una palabra clave");
    }
    return { ok: faltantes.length === 0, faltantes };
  }, [fechaISO, entSel, palabrasClavePayload]);

  const ejecutarSnapshot = useCallback(async () => {
    setSnapError(null);
    setSnapshot(null);
    activeHistoryEntryIdRef.current = null;
    snapshotAbortRef.current?.abort();

    const entidadesFederativas = [...entSel].sort((a, b) => a.localeCompare(b, "es"));
    if (entidadesFederativas.length === 0) {
      setSnapError(errorValidacionComprasmx("Selecciona al menos una entidad federativa antes de buscar."));
      return;
    }
    if (!esFechaIsoValida(fechaISO.trim())) {
      setSnapError(errorValidacionComprasmx("Indica una fecha de publicación válida (YYYY-MM-DD) antes de buscar."));
      return;
    }
    const palabrasClave = palabrasClavePayload();
    if (palabrasClave.length === 0) {
      setSnapError(errorValidacionComprasmx("Agrega al menos una palabra clave antes de buscar."));
      return;
    }

    const body = {
      fechaISO: fechaISO.trim(),
      entidadesFederativas,
      palabrasClave,
    };
    const qs = headed ? "?headed=1" : "";

    setSnapshotProgressLog([]);
    setSnapshotStreamDone(false);
    setSnapshotProgressOpen(true);
    setLoadingSnap(true);
    snapshotProcessStartedAtRef.current = Date.now();
    setSnapshotElapsedSec(0);

    const ac = new AbortController();
    snapshotAbortRef.current = ac;

    const buf: NdJsonStreamBuffer = { rest: "" };
    const hora = () =>
      new Date().toLocaleTimeString("es-MX", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });

    try {
      const r = await fetch(`${api}/snapshot/stream${qs}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson, application/json",
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });

      if (!r.ok) {
        const t = await r.text().catch(() => "");
        let msg = `Error ${r.status}`;
        try {
          const j = JSON.parse(t) as { error?: string };
          if (j.error) msg = j.error;
        } catch {
          if (t.trim()) msg = t.slice(0, 400);
        }
        const uiErr = resolverErrorComprasmxUsuario({ status: r.status, error: msg }, "busqueda");
        setSnapError(uiErr);
        setSnapshotProgressLog((prev) => [
          ...prev,
          {
            phase: "error",
            message: uiErr.servicioNoDisponible ? TITULO_SERVICIO_NO_DISPONIBLE : uiErr.mensaje,
            at: hora(),
          },
        ]);
        setSnapshotStreamDone(true);
        return;
      }

      const reader = r.body?.getReader();
      if (!reader) {
        const uiErr = errorValidacionComprasmx("El navegador no permitió leer la respuesta en streaming.");
        setSnapError(uiErr);
        setSnapshotProgressLog((prev) => [...prev, { phase: "error", message: uiErr.mensaje, at: hora() }]);
        setSnapshotStreamDone(true);
        return;
      }

      const dec = new TextDecoder();
      let streamFinishedWithDone = false;
      let streamHadTerminalError = false;
      let recibioEventoStream = false;
      const lastStreamEventAtRef = { current: Date.now() };

      const handleObject = (obj: unknown) => {
        if (!obj || typeof obj !== "object") return;
        lastStreamEventAtRef.current = Date.now();
        recibioEventoStream = true;
        const o = obj as Record<string, unknown>;
        if (o.type === "progress") {
          const phase = o.phase;
          const message = o.message;
          if (typeof phase === "string" && typeof message === "string") {
            const idx = typeof o.index === "number" ? o.index : undefined;
            const tot = typeof o.total === "number" ? o.total : undefined;
            const id = typeof o.numeroIdentificacion === "string" ? o.numeroIdentificacion : undefined;
            const docTitle = typeof o.documentoTitulo === "string" ? o.documentoTitulo : undefined;
            let detalle: string | undefined;
            if (idx !== undefined && tot !== undefined) detalle = `${idx} de ${tot}`;
            if (id) detalle = detalle ? `${detalle} · ${id}` : id;
            if (docTitle) {
              const short = docTitle.length > 100 ? `${docTitle.slice(0, 97)}…` : docTitle;
              detalle = detalle ? `${detalle} · ${short}` : short;
            }
            const line: SnapshotProgressLine = {
              phase,
              message,
              at: hora(),
              ...(detalle ? { detalle } : {}),
            };
            setSnapshotProgressLog((prev) => [...prev, line]);
          }
          return;
        }
        if (o.type === "done" && o.payload && typeof o.payload === "object") {
          setExportError(null);
          setSnapshot(o.payload as SnapshotResponse);
          const persisted = appendSnapshotHistoryEntry(o.payload);
          activeHistoryEntryIdRef.current = persisted.ok ? persisted.id : null;
          if (!persisted.ok) {
            console.warn(
              "[comprasmx] No se pudo guardar el snapshot en historial local (p. ej. cuota de almacenamiento).",
            );
          }
          setSnapshotProgressLog((prev) => [...prev, { phase: "fin", message: "Resultado recibido.", at: hora() }]);
          streamFinishedWithDone = true;
          setSnapshotStreamDone(true);
          return;
        }
        if (o.type === "error") {
          const message = o.message;
          if (typeof message === "string") {
            streamHadTerminalError = true;
            const uiErr = resolverErrorComprasmxUsuario({ error: message }, "busqueda");
            setSnapError(uiErr);
            setSnapshotProgressLog((prev) => [
              ...prev,
              {
                phase: "error",
                message: uiErr.servicioNoDisponible ? TITULO_SERVICIO_NO_DISPONIBLE : uiErr.mensaje,
                at: hora(),
              } satisfies SnapshotProgressLine,
            ]);
            setSnapshotStreamDone(true);
          }
        }
      };

      try {
        while (true) {
          const inactivityMs = recibioEventoStream
            ? COMPRASMX_STREAM_SIN_AVANCE_MS
            : COMPRASMX_STREAM_CONEXION_INICIAL_MS;
          const { done, value } = await leerStreamConLimiteInactividad(reader, {
            inactivityMs,
            getLastEventAt: () => lastStreamEventAtRef.current,
            signal: ac.signal,
          });
          appendNdjsonChunk(dec.decode(value ?? new Uint8Array(), { stream: !done }), buf, handleObject);
          if (done) break;
        }
        appendNdjsonChunk(dec.decode(), buf, handleObject);
      } catch (streamErr) {
        await reader.cancel().catch(() => {});
        throw streamErr;
      }

      if (!streamFinishedWithDone && !streamHadTerminalError) {
        const uiErr = resolverErrorComprasmxUsuario(
          { error: "La respuesta terminó sin datos de resultado.", servicioNoDisponible: true },
          "busqueda",
        );
        setSnapError(uiErr);
        setSnapshotProgressLog((prev) => [
          ...prev,
          { phase: "error", message: TITULO_SERVICIO_NO_DISPONIBLE, at: hora() },
        ]);
        setSnapshotStreamDone(true);
      }
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        setSnapshotProgressLog((prev) => [...prev, { phase: "cancelado", message: "Consulta cancelada.", at: hora() }]);
        setSnapshotStreamDone(true);
        return;
      }
      const uiErr = resolverErrorComprasmxUsuario(
        { err: e, sinRespuesta: esErrorStallStream(e) },
        "busqueda",
      );
      setSnapError(uiErr);
      setSnapshotProgressLog((prev) => [
        ...prev,
        {
          phase: "error",
          message: uiErr.servicioNoDisponible ? TITULO_SERVICIO_NO_DISPONIBLE : uiErr.mensaje,
          at: hora(),
        },
      ]);
      setSnapshotStreamDone(true);
    } finally {
      setLoadingSnap(false);
      snapshotAbortRef.current = null;
    }
  }, [api, entSel, fechaISO, headed, palabrasClavePayload]);

  const cerrarProgresoSnapshot = useCallback(() => {
    snapshotAbortRef.current?.abort();
    setSnapshotProgressOpen(false);
    setSnapshotProgressLog([]);
    setSnapshotStreamDone(true);
    setLoadingSnap(false);
    snapshotAbortRef.current = null;
  }, []);

  const abrirHistorial = useCallback(() => {
    setHistorialLista(listSnapshotHistory());
    setHistorialOpen(true);
  }, []);

  const aplicarEntradaHistorial = useCallback((id: string) => {
    const e = getHistoryEntry(id);
    if (!e) return;
    setSnapError(null);
    setSnapshot(e.snapshotJson as SnapshotResponse);
    activeHistoryEntryIdRef.current = e.id;
    setHistorialOpen(false);
  }, []);

  const eliminarEntradaHistorial = useCallback((id: string, ev?: MouseEvent) => {
    ev?.stopPropagation();
    removeHistoryEntry(id);
    setHistorialLista(listSnapshotHistory());
    if (activeHistoryEntryIdRef.current === id) {
      activeHistoryEntryIdRef.current = null;
      setSnapshot(null);
    }
  }, []);

  const vaciarHistorialCompleto = useCallback(() => {
    clearSnapshotHistory();
    setHistorialLista([]);
    activeHistoryEntryIdRef.current = null;
    setSnapshot(null);
  }, []);

  const exportarTodasLicitaciones = useCallback(async () => {
    const filas = snapshot?.filas ?? [];
    if (filas.length === 0) return;
    setExportingAll(true);
    setExportError(null);
    try {
      const r = await fetchComprasmxConTimeout(
        `${api}/export`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            filas,
            fetchedAt: snapshot?.fetchedAt,
            filtros: snapshot?.filtros,
          }),
        },
        1_800_000,
      );
      if (!r.ok) {
        let msg = `Exportación falló (${r.status})`;
        try {
          const j = (await r.json()) as { error?: string };
          if (typeof j.error === "string") msg = j.error;
        } catch {
          /* ignore */
        }
        setExportError(resolverErrorComprasmxUsuario({ status: r.status, error: msg }, "exportacion"));
        return;
      }
      const blob = await r.blob();
      const disp = r.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";\n]+)"?/i.exec(disp);
      const filename = m?.[1]?.trim() || `comprasmx-export-${fechaISO.trim() || "busqueda"}.zip`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (e) {
      setExportError(resolverErrorComprasmxUsuario({ err: e, sinRespuesta: esErrorStallStream(e) }, "exportacion"));
    } finally {
      setExportingAll(false);
    }
  }, [api, fechaISO, snapshot]);

  const abrirExportacionPersonalizada = useCallback(() => {
    const hid = activeHistoryEntryIdRef.current;
    const entry = hid ? getHistoryEntry(hid) : null;
    setExportHistorialDocs(entry?.documentosPorExpediente);
    setExportPersonalizadoOpen(true);
  }, []);

  const abrirDocumentos = useCallback(
    async (numeroIdentificacion: string) => {
      const idTrim = numeroIdentificacion.trim();
      setDocModal(idTrim);
      setDocs([]);
      setDocsError(null);
      setDocZipHref(null);
      setPreview(null);

      const hid = activeHistoryEntryIdRef.current;
      if (hid) {
        const entry = getHistoryEntry(hid);
        const cached = entry?.documentosPorExpediente?.[idTrim];
        if (cached && cached.length > 0) {
          const zipHref = proxiedComprasmxUrl(
            `/comprasmx/documentos/zip?${new URLSearchParams({ numeroIdentificacion: idTrim }).toString()}`,
          );
          setDocZipHref(zipHref);
          setDocs((cached as DocumentoRow[]).filter((d) => !esZipAnexoListado(d.nombre)));
          setLoadingDocs(false);
          return;
        }
      }

      setLoadingDocs(true);
      try {
        const r = await fetch(`${api}/documentos?${new URLSearchParams({ numeroIdentificacion: idTrim }).toString()}`);
        const parsed = await readComprasmxJsonResponse<DocumentosResponse>(r);
        if (!parsed.ok) {
          setDocsError(errorUiDesdeJson(parsed, "documentos"));
          return;
        }
        const j = parsed.data;
        const zipHref =
          typeof j.urlZip === "string"
            ? proxiedComprasmxUrl(j.urlZip)
            : proxiedComprasmxUrl(
                `/comprasmx/documentos/zip?${new URLSearchParams({ numeroIdentificacion: idTrim }).toString()}`,
              );
        setDocZipHref(zipHref);
        const mapped = j.documentos
          .filter((d) => !esZipAnexoListado(d.nombre))
          .map((d) => ({
            ...d,
            urlDescarga: proxiedComprasmxUrl(d.urlDescarga),
            ...(d.urlVistaPdf ? { urlVistaPdf: proxiedComprasmxUrl(d.urlVistaPdf) } : {}),
            /* urlVistaGoogle es https://docs.google.com/... — no pasa por el proxy */
          }));
        setDocs(mapped);
        mergeDocumentosIntoHistoryEntry(activeHistoryEntryIdRef.current, idTrim, mapped);
      } catch (e) {
        setDocsError(resolverErrorComprasmxUsuario({ err: e }, "documentos"));
      } finally {
        setLoadingDocs(false);
      }
    },
    [api],
  );

  const cargarTextoPreview = useCallback(async (nombre: string, url: string) => {
    setPreview({ nombre, url, modoPdf: false });
    try {
      const r = await fetch(url);
      const t = await r.text();
      setPreview({ nombre, url, texto: t.slice(0, 500_000), modoPdf: false });
    } catch {
      setPreview({ nombre, url, texto: "(No se pudo cargar el texto.)", modoPdf: false });
    }
  }, []);

  const seleccionarPreview = useCallback(
    (d: DocumentoRow) => {
      const cat = categoriaVista(d.nombre);
      if (cat === "texto") {
        void cargarTextoPreview(d.nombre, d.urlDescarga);
        return;
      }
      if (cat === "pdf") {
        setPreview({
          nombre: d.nombre,
          url: d.urlDescarga,
          modoPdf: true,
          conversionEnServidor: false,
        });
        return;
      }
      const officeTipo = officeClienteTipo(d.nombre);
      if (officeTipo) {
        setPreview({
          nombre: d.nombre,
          url: d.urlDescarga,
          modoOfficeCliente: true,
          officeClienteTipo: officeTipo,
        });
        return;
      }
      if (d.urlVistaPdf) {
        setPreview({
          nombre: d.nombre,
          url: d.urlVistaPdf,
          modoPdf: true,
          conversionEnServidor: true,
        });
        return;
      }
      if (cat === "imagen") {
        setPreview({ nombre: d.nombre, url: d.urlDescarga });
        return;
      }
      setPreview({ nombre: d.nombre, url: d.urlDescarga });
    },
    [cargarTextoPreview],
  );

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-8 px-4 py-10 sm:px-6">
      {apiServicioCaido ? (
        <ComprasmxErrorAviso
          error={{
            servicioNoDisponible: true,
            mensaje: LEYENDA_SERVICIO_NO_DISPONIBLE,
            detalle: "No se pudo contactar al API al cargar la página. Revisa que el backend esté en marcha.",
          }}
        />
      ) : null}
      {snapshotProgressOpen ? (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/55 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="snapshot-progress-title"
          aria-busy={loadingSnap && !snapshotStreamDone}
        >
          <div className="flex max-h-[min(90dvh,720px)] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-950">
            <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
              <h2 id="snapshot-progress-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                {snapError?.servicioNoDisponible
                  ? "Servicio interrumpido"
                  : snapshotStreamDone && snapError
                    ? "Consulta con error"
                    : "Consulta en curso"}
              </h2>
              <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">
                {snapError?.servicioNoDisponible
                  ? "El servidor dejó de responder. Revisa el aviso abajo e intenta más tarde."
                  : "El servidor envía cada paso mientras obtiene datos de Compras MX."}
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
              {snapshotProgressLog.length === 0 ? (
                <p className="px-1 py-6 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  {loadingSnap ? "Conectando…" : "Sin eventos aún."}
                </p>
              ) : (
                <ol className="flex flex-col gap-2">
                  {snapshotProgressLog.map((row, i) => {
                    const err = row.phase === "error";
                    const ok = row.phase === "fin";
                    const cancel = row.phase === "cancelado";
                    const descarga = row.phase === "descarga";
                    const drive = row.phase === "drive";
                    return (
                      <li
                        key={`${row.at}-${i}-${row.phase}-${row.detalle ?? row.message}`}
                        className={`rounded-lg border px-3 py-2 text-sm ${
                          err
                            ? "border-red-200 bg-red-50 text-red-900 dark:border-red-900 dark:bg-red-950/40 dark:text-red-100"
                            : ok
                              ? "border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-100"
                              : cancel
                                ? "border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100"
                                : drive
                                  ? "border-violet-200 bg-violet-50 text-violet-950 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100"
                                  : descarga
                                    ? "border-sky-200 bg-sky-50 text-sky-950 dark:border-sky-800 dark:bg-sky-950/35 dark:text-sky-100"
                                    : "border-zinc-200 bg-zinc-50 text-zinc-800 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-200"
                        }`}
                      >
                        <div className="flex flex-wrap items-baseline justify-between gap-x-2 gap-y-0.5">
                          <span className="font-mono text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                            {row.at}
                          </span>
                          <span className="font-mono text-[10px] text-zinc-500 dark:text-zinc-400">
                            {row.phase === "drive" ? "Google Drive" : row.phase}
                          </span>
                        </div>
                        <p className="mt-1 leading-snug">{row.message}</p>
                        {row.detalle ? (
                          <p className="mt-1 font-mono text-[11px] text-zinc-600 dark:text-zinc-400">{row.detalle}</p>
                        ) : null}
                      </li>
                    );
                  })}
                  <div ref={snapshotProgressEndRef} />
                </ol>
              )}
            </div>
            <div className="shrink-0 space-y-3 border-t border-zinc-200 bg-zinc-50/90 px-3 py-3 dark:border-zinc-800 dark:bg-zinc-900/50 sm:px-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Tiempo transcurrido</span>
                <span
                  className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
                  aria-live="polite"
                  aria-label={`Tiempo transcurrido: ${formatoDuracionSegundos(snapshotElapsedSec)}`}
                >
                  {formatoDuracionSegundos(snapshotElapsedSec)}
                </span>
              </div>
              {snapError ? <ComprasmxErrorAviso error={snapError} /> : null}
              {loadingSnap && !snapshotStreamDone && !snapError ? (
                <div className="space-y-2">
                  <div
                    className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
                    role="progressbar"
                    aria-valuetext="En progreso"
                  >
                    <div className="comprasmx-indeterminate-bar h-full rounded-full bg-gradient-to-r from-emerald-700 via-emerald-400 to-emerald-600 dark:from-emerald-500 dark:via-emerald-300 dark:to-emerald-500" />
                  </div>
                  <p className="flex items-center gap-2 text-xs font-medium text-emerald-800 dark:text-emerald-300">
                    <span className="inline-flex items-center gap-0.5" aria-hidden>
                      <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.25s] dark:bg-emerald-400" />
                      <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.12s] dark:bg-emerald-400" />
                      <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 dark:bg-emerald-400" />
                    </span>
                    Obteniendo datos del portal…
                  </p>
                </div>
              ) : snapshotStreamDone ? (
                <p className="text-[11px] text-zinc-600 dark:text-zinc-400">
                  Proceso terminado en{" "}
                  <span className="font-mono font-medium text-zinc-800 dark:text-zinc-200">
                    {formatoDuracionSegundos(snapshotElapsedSec)}
                  </span>
                  .
                </p>
              ) : null}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800 sm:px-4">
              {loadingSnap ? (
                <button
                  type="button"
                  className="rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-800 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  onClick={() => snapshotAbortRef.current?.abort()}
                >
                  Cancelar
                </button>
              ) : null}
              <button
                type="button"
                className="rounded-lg bg-emerald-700 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                onClick={() => cerrarProgresoSnapshot()}
                disabled={loadingSnap && !snapshotStreamDone && !snapError}
              >
                {loadingSnap && !snapshotStreamDone && !snapError ? "Espera…" : "Cerrar"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {historialOpen ? (
        <div
          className="fixed inset-0 z-[58] flex items-center justify-center bg-black/50 p-3 sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="historial-local-title"
        >
          <div className="flex max-h-[min(88dvh,640px)] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-950">
            <div className="shrink-0 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
              <h2 id="historial-local-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
                Historial local
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">
                Cada búsqueda exitosa se guarda en este navegador. Los documentos siguen en el API; hace falta que el{" "}
                <strong>backend esté en marcha</strong> para listarlos o previsualizarlos.
              </p>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
              {historialLista.length === 0 ? (
                <p className="py-8 text-center text-sm text-zinc-500 dark:text-zinc-400">
                  Aún no hay snapshots guardados en este navegador. Ejecuta una búsqueda para crear el primero.
                </p>
              ) : (
                <ul className="flex flex-col gap-2">
                  {historialLista.map((row) => {
                    const nDocs = row.documentosPorExpediente
                      ? Object.values(row.documentosPorExpediente).reduce((a, d) => a + d.length, 0)
                      : 0;
                    const storedLabel = new Date(row.storedAt).toLocaleString("es-MX", {
                      dateStyle: "short",
                      timeStyle: "short",
                    });
                    return (
                      <li
                        key={row.id}
                        className="rounded-lg border border-zinc-200 bg-zinc-50/80 px-3 py-2.5 dark:border-zinc-700 dark:bg-zinc-900/40"
                      >
                        <div className="flex flex-wrap items-start justify-between gap-2">
                          <div className="min-w-0 flex-1">
                            <p className="text-sm font-medium text-zinc-900 dark:text-zinc-100">{row.resumen}</p>
                            <p className="mt-0.5 text-[11px] text-zinc-500 dark:text-zinc-400">
                              Guardado: {storedLabel}
                              {row.serverFetchedAt ? (
                                <span className="block font-mono text-[10px] text-zinc-400 dark:text-zinc-500">
                                  Servidor: {row.serverFetchedAt}
                                </span>
                              ) : null}
                              {nDocs > 0 ? (
                                <span className="mt-0.5 block text-emerald-700 dark:text-emerald-400">
                                  {nDocs} documento(s) en caché de URLs
                                </span>
                              ) : null}
                            </p>
                          </div>
                          <div className="flex shrink-0 flex-wrap gap-1.5">
                            <button
                              type="button"
                              className="rounded-md bg-emerald-700 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-800"
                              onClick={() => aplicarEntradaHistorial(row.id)}
                            >
                              Ver
                            </button>
                            <button
                              type="button"
                              className="rounded-md border border-zinc-300 px-2.5 py-1.5 text-xs text-zinc-700 hover:bg-zinc-100 dark:border-zinc-600 dark:text-zinc-300 dark:hover:bg-zinc-800"
                              onClick={(ev) => eliminarEntradaHistorial(row.id, ev)}
                            >
                              Quitar
                            </button>
                          </div>
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-zinc-200 px-3 py-3 dark:border-zinc-800 sm:px-4">
              <button
                type="button"
                className="rounded-lg border border-red-200 px-3 py-2 text-xs font-medium text-red-800 hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-200 dark:hover:bg-red-950/40"
                disabled={historialLista.length === 0}
                onClick={() => {
                  if (typeof window !== "undefined" && window.confirm("¿Borrar todo el historial local?")) {
                    vaciarHistorialCompleto();
                  }
                }}
              >
                Vaciar historial
              </button>
              <button
                type="button"
                className="rounded-lg bg-zinc-900 px-3 py-2 text-sm font-semibold text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                onClick={() => setHistorialOpen(false)}
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <header className="border-b border-zinc-200 pb-6 dark:border-zinc-800">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Compras MX — consulta
        </h1>
        <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-600 dark:text-zinc-400">
          Filtros enviados a tu API en el mismo formato JSON que definiste. Los documentos se sirven desde el backend;
          PDF e imágenes se pueden ver aquí; Word, Excel y PowerPoint se previsualizan como PDF solo cuando el API
          convierte bajo demanda (LibreOffice); los PDF originales no se reconvierten.
        </p>
      </header>

      <section className="grid gap-6 rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-6">
        <div className="flex flex-wrap items-end gap-4">
          <div className="flex flex-col gap-1">
            <label htmlFor="fechaISO" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
              Fecha de publicación (`fechaISO`)
            </label>
            <input
              id="fechaISO"
              type="text"
              inputMode="numeric"
              autoComplete="off"
              spellCheck={false}
              placeholder="YYYY-MM-DD"
              pattern="\d{4}-\d{2}-\d{2}"
              maxLength={10}
              value={fechaISO}
              onChange={(e) => setFechaISO(e.target.value)}
              aria-invalid={!esFechaIsoValida(fechaISO.trim())}
              className={`w-44 rounded-lg border bg-white px-3 py-2 font-mono text-sm text-zinc-900 shadow-sm outline-none ring-zinc-400/40 focus:ring-2 dark:bg-zinc-900 dark:text-zinc-100 ${
                esFechaIsoValida(fechaISO.trim())
                  ? "border-zinc-300 focus:border-emerald-600 dark:border-zinc-600 dark:focus:border-emerald-500"
                  : "border-amber-500 focus:border-amber-600 dark:border-amber-600 dark:focus:border-amber-500"
              }`}
            />
          </div>
          <button
            type="button"
            onClick={() => setFechaISO(fechaIsoHoyMexico())}
            className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white hover:bg-zinc-800 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
          >
            Hoy (México)
          </button>
        </div>
        <p className="text-xs text-zinc-500 dark:text-zinc-500">
          Escribe la fecha en formato <span className="font-mono">YYYY-MM-DD</span> (zona de referencia al pulsar
          &quot;Hoy&quot;: America/Mexico_City). Puedes editarla en cualquier momento.
        </p>

        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Entidades federativas</span>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                onClick={() => setEntSel(new Set(entidadesLista))}
              >
                Todas
              </button>
              <button
                type="button"
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                onClick={() => setEntSel(new Set())}
              >
                Ninguna
              </button>
              <button
                type="button"
                className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                onClick={() => setEntSel(new Set(DEFAULT_ENTIDADES_FEDERATIVAS))}
              >
                Valores por defecto
              </button>
            </div>
          </div>
          <div
            className={`max-h-56 overflow-y-auto rounded-lg border p-3 dark:border-zinc-800 ${
              entSel.size > 0 ? "border-zinc-200" : "border-amber-500 dark:border-amber-600"
            }`}
            role="group"
            aria-label="Entidades federativas"
          >
            <ul className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {entidadesLista.map((e) => (
                <li key={e} className="flex items-center gap-2 text-sm">
                  <input
                    id={`ent-${e}`}
                    type="checkbox"
                    checked={entSel.has(e)}
                    onChange={() => toggleEnt(e)}
                    className="size-4 rounded border-zinc-400"
                  />
                  <label htmlFor={`ent-${e}`} className="cursor-pointer select-none text-zinc-800 dark:text-zinc-200">
                    {etiquetaEntidadFederativa(e)}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <PalabrasClaveChips palabras={palabrasClave} onChange={setPalabrasClave} />

        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} className="size-4" />
          Ejecutar con navegador visible (`?headed=1`) — útil para depurar en el servidor.
        </label>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={loadingSnap || !requisitosBusqueda.ok}
            title={
              !requisitosBusqueda.ok && !loadingSnap
                ? `Falta: ${requisitosBusqueda.faltantes.join("; ")}.`
                : undefined
            }
            onClick={() => void ejecutarSnapshot()}
            className="inline-flex items-center justify-center rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
          >
            {loadingSnap ? "Buscando…" : "Buscar licitaciones (snapshot)"}
          </button>
          <button
            type="button"
            onClick={abrirHistorial}
            className="inline-flex items-center justify-center rounded-lg border border-zinc-300 bg-white px-4 py-2.5 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:hover:bg-zinc-800"
          >
            Historial local
          </button>
        </div>

        {!requisitosBusqueda.ok && !loadingSnap ? (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-950 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-100">
            Para buscar necesitas:{" "}
            <span className="font-medium">{requisitosBusqueda.faltantes.join(" · ")}</span>.
          </p>
        ) : null}

        {requisitosBusqueda.ok && !loadingSnap ? (
          <p className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/60 dark:text-zinc-300">
            Se enviará al API:{" "}
            <span className="font-medium">
              {fechaISO.trim()} · {entSel.size} entidad(es) · {palabrasClavePayload().length} palabra(s) clave
            </span>
            . Debe coincidir con Postman (misma fecha, mismas entidades y el mismo arreglo de palabras clave).
          </p>
        ) : null}

        <ComprasmxErrorAviso error={snapError} />
      </section>

      {snapshot ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-6">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Resultados ({snapshot.totalFilas ?? snapshot.filas?.length ?? 0})
            </h2>
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                disabled={(snapshot.filas?.length ?? 0) === 0}
                onClick={abrirExportacionPersonalizada}
                className="rounded-lg border border-violet-600 bg-violet-50 px-4 py-2 text-sm font-semibold text-violet-900 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-500 dark:bg-violet-950/40 dark:text-violet-200 dark:hover:bg-violet-900/50"
              >
                Exportación personalizada…
              </button>
              <button
                type="button"
                disabled={exportingAll || (snapshot.filas?.length ?? 0) === 0}
                onClick={() => void exportarTodasLicitaciones()}
                className="rounded-lg border border-emerald-700 bg-white px-4 py-2 text-sm font-semibold text-emerald-800 hover:bg-emerald-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-emerald-500 dark:bg-zinc-950 dark:text-emerald-300 dark:hover:bg-emerald-950/40"
              >
                {exportingAll ? "Generando ZIP…" : "Exportar todo (ZIP + Word)"}
              </button>
            </div>
          </div>
          <ComprasmxErrorAviso error={exportError} className="mt-3" />
          {resumenFiltrosSnapshot(snapshot) ? (
            <p className="mt-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900/50 dark:text-zinc-300">
              <span className="font-medium text-zinc-900 dark:text-zinc-100">Filtros aplicados en esta consulta:</span>{" "}
              {resumenFiltrosSnapshot(snapshot)}
            </p>
          ) : null}
          <ul className="mt-6 flex flex-col gap-6">
            {(snapshot.filas ?? []).map((f) => (
              <li
                key={f.numeroIdentificacion}
                className="rounded-xl border border-zinc-200 bg-zinc-50/50 p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900/30 sm:p-5"
              >
                <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs font-medium text-emerald-800 dark:text-emerald-300">
                      {f.numeroIdentificacion}
                    </p>
                    <p className="mt-1 text-sm font-medium leading-snug text-zinc-900 dark:text-zinc-50">{f.nombre}</p>
                  </div>
                  <button
                    type="button"
                    className="shrink-0 rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 dark:bg-emerald-600 dark:hover:bg-emerald-500"
                    onClick={() => void abrirDocumentos(f.numeroIdentificacion)}
                  >
                    Ver documentos descargados
                  </button>
                </div>
                {f.detalleProcedimiento ? <DetalleProcedimientoBloque detalle={f.detalleProcedimiento} /> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {docModal ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-2 sm:p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="doc-modal-title"
        >
          <div className="flex h-[min(96vh,calc(100dvh-1rem))] w-[min(100vw-1rem,1680px)] max-w-[1680px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-zinc-950">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
              <h2 id="doc-modal-title" className="min-w-0 flex-1 truncate text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Documentos — {docModal}
              </h2>
              <div className="flex shrink-0 flex-wrap items-center gap-2">
                <button
                  type="button"
                  disabled={
                    !docZipHref || docs.length === 0 || loadingDocs || downloadingZip || downloadingAllDocs
                  }
                  onClick={() => void descargarZipExpediente()}
                  className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-white"
                >
                  {downloadingZip ? "Descargando ZIP…" : "Descargar ZIP"}
                </button>
                <button
                  type="button"
                  disabled={loadingDocs || docs.length === 0 || downloadingAllDocs || downloadingZip}
                  onClick={() => void descargarTodosDocumentos()}
                  className="rounded-lg border border-emerald-600 bg-emerald-50 px-3 py-1.5 text-sm font-medium text-emerald-900 hover:bg-emerald-100 disabled:opacity-50 dark:border-emerald-500 dark:bg-emerald-950/50 dark:text-emerald-100 dark:hover:bg-emerald-900/60"
                >
                  {downloadingAllDocs ? "Descargando…" : "Descargar todos (sin comprimir)"}
                </button>
                <button
                  type="button"
                  className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                  onClick={() => {
                    setDocModal(null);
                    setDownloadingAllDocs(false);
                    setDownloadingZip(false);
                    setProgresoOverlay(null);
                    setDocZipHref(null);
                    setPreview(null);
                    setPdfLoading(false);
                    setImgLoading(false);
                  }}
                >
                  Cerrar
                </button>
              </div>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,22%)_1fr] md:gap-0">
              <div className="flex max-h-[40vh] min-h-0 flex-col overflow-hidden border-b border-zinc-200 dark:border-zinc-800 md:max-h-none md:border-b-0 md:border-r">
                <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                  {loadingDocs ? <p className="text-sm text-zinc-500">Cargando…</p> : null}
                  <ComprasmxErrorAviso error={docsError} />
                  <ul className="flex flex-col gap-1">
                    {docs.map((d) => (
                      <li key={d.nombre}>
                        <button
                          type="button"
                          onClick={() => seleccionarPreview(d)}
                          className={`w-full rounded-lg px-2 py-2 text-left text-xs hover:bg-zinc-100 dark:hover:bg-zinc-900 ${
                            preview?.nombre === d.nombre ? "bg-zinc-100 dark:bg-zinc-900" : ""
                          }`}
                        >
                          <span className="font-mono text-[11px] text-zinc-800 dark:text-zinc-200">{d.nombre}</span>
                          <span className="mt-0.5 block text-[10px] text-zinc-500">
                            {(d.sizeBytes / 1024).toFixed(1)} KB
                          </span>
                        </button>
                        <a
                          href={`${d.urlDescarga}${d.urlDescarga.includes("?") ? "&" : "?"}disposition=attachment`}
                          className="ml-2 text-[10px] text-emerald-700 underline dark:text-emerald-400"
                          download
                        >
                          Descargar
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
              <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden bg-zinc-50 dark:bg-zinc-900">
                {!preview ? (
                  <div className="flex min-h-[min(50vh,420px)] flex-1 flex-col items-center justify-center px-6 py-12 text-center">
                    <div
                      className="flex size-16 items-center justify-center rounded-2xl border border-emerald-200/80 bg-emerald-50 shadow-sm dark:border-emerald-800/60 dark:bg-emerald-950/40"
                      aria-hidden
                    >
                      <svg
                        className="size-8 text-emerald-700 dark:text-emerald-400"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={1.5}
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          d="M19.5 14.25v-2.625a3.375 3.375 0 00-3.375-3.375h-1.5A1.125 1.125 0 0113.5 7.125v-1.5a3.375 3.375 0 00-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 00-9-9z"
                        />
                      </svg>
                    </div>
                    <p className="mt-5 text-base font-semibold text-zinc-800 dark:text-zinc-100">
                      Selecciona un archivo para previsualizarlo
                    </p>
                    <p className="mt-2 max-w-sm text-sm leading-relaxed text-zinc-500 dark:text-zinc-400">
                      Elige un documento de la lista de la izquierda. Podrás ver PDF, Word, Excel o imágenes aquí mismo.
                    </p>
                  </div>
                ) : preview.modoOfficeCliente && preview.officeClienteTipo ? (
                  <OfficeClientPreview
                    key={`${preview.url}:${preview.nombre}`}
                    nombre={preview.nombre}
                    url={preview.url}
                    tipo={preview.officeClienteTipo}
                  />
                ) : preview.modoPdf ? (
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    {pdfLoading ? (
                      <DocumentoPreviewLoading conversionEnServidor={preview.conversionEnServidor} />
                    ) : null}
                    <iframe
                      title={preview.nombre}
                      src={preview.url}
                      className={`min-h-[min(85dvh,880px)] w-full flex-1 border-0 md:min-h-0 ${pdfLoading ? "invisible absolute inset-0 h-0 w-0 overflow-hidden" : ""}`}
                      onLoad={() => setPdfLoading(false)}
                    />
                  </div>
                ) : categoriaVista(preview.nombre) === "imagen" ? (
                  <div className="relative flex min-h-0 flex-1 flex-col">
                    {imgLoading ? <DocumentoPreviewLoading titulo="Cargando imagen desde el servidor…" /> : null}
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={preview.url}
                      alt={preview.nombre}
                      className={`max-h-[min(85vh,900px)] w-full flex-1 object-contain p-2 ${imgLoading ? "invisible" : ""}`}
                      onLoad={() => setImgLoading(false)}
                      onError={() => setImgLoading(false)}
                    />
                  </div>
                ) : categoriaVista(preview.nombre) === "texto" ? (
                  preview.texto ? (
                    <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                      {preview.texto}
                    </pre>
                  ) : (
                    <div className="relative min-h-[220px] flex-1">
                      <DocumentoPreviewLoading titulo="Cargando texto desde el servidor…" />
                    </div>
                  )
                ) : (
                  <div className="flex flex-col gap-3 p-4 text-sm text-zinc-700 dark:text-zinc-300">
                    <p>
                      Vista previa no disponible para <strong>{extDeNombre(preview.nombre) || "este formato"}</strong>{" "}
                      (p. ej. PowerPoint). Descarga el archivo y ábrelo en Office.
                    </p>
                    <a
                      href={preview.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="inline-flex w-fit rounded-lg bg-zinc-900 px-3 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
                    >
                      Abrir en pestaña nueva
                    </a>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {exportPersonalizadoOpen && snapshot ? (
        <ExportacionPersonalizadaModal
          open={exportPersonalizadoOpen}
          onClose={() => setExportPersonalizadoOpen(false)}
          filas={snapshot.filas ?? []}
          fetchedAt={snapshot.fetchedAt}
          filtros={snapshot.filtros}
          documentosHistorial={exportHistorialDocs}
        />
      ) : null}

      {progresoOverlay ? (
        <ExportacionProgresoOverlay open config={progresoOverlay} />
      ) : exportingAll ? (
        <ExportacionProgresoOverlay
          open
          config={{
            tipo: "export-completa",
            licitacionesCount: snapshot?.filas?.length ?? 0,
          }}
        />
      ) : null}
    </div>
  );
}
