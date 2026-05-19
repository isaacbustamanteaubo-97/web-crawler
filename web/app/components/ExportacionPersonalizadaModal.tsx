"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { DocumentoPreviewLoading } from "@/app/components/DocumentoPreviewLoading";
import { ExportacionProgresoOverlay } from "@/app/components/ExportacionProgresoOverlay";
import { OfficeClientPreview } from "@/app/components/OfficeClientPreview";
import {
  comprasmxApiBase,
  mensajeErrorConexionComprasmxApi,
  proxiedComprasmxUrl,
  readComprasmxJsonResponse,
} from "@/lib/comprasmx-api";
import {
  categoriaVistaDocumento,
  claveDocumentoExport,
  esZipAnexoListado,
} from "@/lib/comprasmx-documento-vista";
import { officeClienteTipo } from "@/lib/office-client-preview";

export type FilaExportable = {
  numeroIdentificacion: string;
  nombre: string;
  detalleProcedimiento?: unknown;
};

export type DocumentoExportRow = {
  nombre: string;
  sizeBytes: number;
  urlDescarga: string;
  urlVistaPdf?: string;
};

type DocumentosResponse = {
  documentos: DocumentoExportRow[];
  error?: string;
};

type PreviewState = {
  nombre: string;
  url: string;
  modoPdf?: boolean;
  conversionEnServidor?: boolean;
  modoOfficeCliente?: boolean;
  officeClienteTipo?: import("@/lib/office-client-preview").OfficeClienteTipo;
  texto?: string;
};

type Props = {
  open: boolean;
  onClose: () => void;
  filas: FilaExportable[];
  fetchedAt?: string;
  filtros?: Record<string, unknown>;
  documentosHistorial?: Record<string, DocumentoExportRow[]>;
};

export function ExportacionPersonalizadaModal({
  open,
  onClose,
  filas,
  fetchedAt,
  filtros,
  documentosHistorial,
}: Props) {
  const api = useMemo(() => comprasmxApiBase(), []);

  const [paso, setPaso] = useState<"licitaciones" | "documentos">("licitaciones");
  const [licSel, setLicSel] = useState<Set<string>>(() => new Set());
  const [docsPorExpediente, setDocsPorExpediente] = useState<Record<string, DocumentoExportRow[]>>({});
  const [docsSel, setDocsSel] = useState<Set<string>>(() => new Set());
  const [expedienteActivo, setExpedienteActivo] = useState<string | null>(null);
  const [preview, setPreview] = useState<PreviewState | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [imgLoading, setImgLoading] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [exportando, setExportando] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setPaso("licitaciones");
    setLicSel(new Set(filas.map((f) => f.numeroIdentificacion)));
    setDocsPorExpediente({});
    setDocsSel(new Set());
    setExpedienteActivo(null);
    setPreview(null);
    setDocsError(null);
    setExportError(null);
    setPdfLoading(false);
    setImgLoading(false);
  }, [open, filas]);

  useEffect(() => {
    if (!preview?.modoPdf || !preview.url) {
      setPdfLoading(false);
      return;
    }
    setPdfLoading(true);
  }, [preview?.modoPdf, preview?.url]);

  useEffect(() => {
    if (!preview || preview.modoPdf || preview.modoOfficeCliente || categoriaVistaDocumento(preview.nombre) !== "imagen") {
      setImgLoading(false);
      return;
    }
    setImgLoading(true);
  }, [preview?.nombre, preview?.url, preview?.modoPdf, preview?.modoOfficeCliente]);

  const toggleLic = useCallback((id: string) => {
    setLicSel((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }, []);

  const toggleDoc = useCallback((expediente: string, nombre: string) => {
    const k = claveDocumentoExport(expediente, nombre);
    setDocsSel((prev) => {
      const n = new Set(prev);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  }, []);

  const mapearDocumentos = useCallback((j: DocumentosResponse): DocumentoExportRow[] => {
    return j.documentos
      .filter((d) => !esZipAnexoListado(d.nombre))
      .map((d) => ({
        ...d,
        urlDescarga: proxiedComprasmxUrl(d.urlDescarga),
        ...(d.urlVistaPdf ? { urlVistaPdf: proxiedComprasmxUrl(d.urlVistaPdf) } : {}),
      }));
  }, []);

  const continuarADocumentos = useCallback(async () => {
    const ids = [...licSel];
    if (ids.length === 0) {
      setDocsError("Selecciona al menos una licitación.");
      return;
    }
    setDocsError(null);
    setLoadingDocs(true);
    const map: Record<string, DocumentoExportRow[]> = {};
    const seleccionInicial = new Set<string>();

    try {
      for (const id of ids) {
        const cached = documentosHistorial?.[id];
        if (cached && cached.length > 0) {
          map[id] = cached;
          for (const d of cached) {
            seleccionInicial.add(claveDocumentoExport(id, d.nombre));
          }
          continue;
        }
        const r = await fetch(`${api}/documentos?${new URLSearchParams({ numeroIdentificacion: id }).toString()}`);
        const parsed = await readComprasmxJsonResponse<DocumentosResponse>(r);
        if (!parsed.ok) {
          throw new Error(`${id}: ${parsed.error}`);
        }
        const lista = mapearDocumentos(parsed.data);
        map[id] = lista;
        for (const d of lista) {
          seleccionInicial.add(claveDocumentoExport(id, d.nombre));
        }
      }
      setDocsPorExpediente(map);
      setDocsSel(seleccionInicial);
      setExpedienteActivo(ids[0] ?? null);
      setPreview(null);
      setPaso("documentos");
    } catch (e) {
      setDocsError(mensajeErrorConexionComprasmxApi(e, "documentos"));
    } finally {
      setLoadingDocs(false);
    }
  }, [api, documentosHistorial, licSel, mapearDocumentos]);

  const seleccionarPreview = useCallback((expediente: string, d: DocumentoExportRow) => {
    const cat = categoriaVistaDocumento(d.nombre);
    if (cat === "texto") {
      setPreview({ nombre: d.nombre, url: d.urlDescarga });
      void (async () => {
        try {
          const r = await fetch(d.urlDescarga);
          const t = await r.text();
          setPreview({ nombre: d.nombre, url: d.urlDescarga, texto: t.slice(0, 500_000) });
        } catch {
          setPreview({ nombre: d.nombre, url: d.urlDescarga, texto: "(No se pudo cargar el texto.)" });
        }
      })();
      return;
    }
    if (cat === "pdf") {
      setPreview({ nombre: d.nombre, url: d.urlDescarga, modoPdf: true });
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
  }, []);

  const documentosActivos = expedienteActivo ? (docsPorExpediente[expedienteActivo] ?? []) : [];

  const exportarSeleccion = useCallback(async () => {
    const filasExport = filas.filter((f) => licSel.has(f.numeroIdentificacion));
    if (filasExport.length === 0) return;
    if (docsSel.size === 0) {
      setExportError("Selecciona al menos un documento para incluir en el ZIP.");
      return;
    }

    const documentosPorExpediente: Record<string, string[]> = {};
    for (const f of filasExport) {
      const nombres = (docsPorExpediente[f.numeroIdentificacion] ?? [])
        .filter((d) => docsSel.has(claveDocumentoExport(f.numeroIdentificacion, d.nombre)))
        .map((d) => d.nombre);
      if (nombres.length > 0) documentosPorExpediente[f.numeroIdentificacion] = nombres;
    }

    setExportando(true);
    setExportError(null);
    try {
      const r = await fetch(`${api}/export`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          filas: filasExport,
          fetchedAt,
          filtros,
          documentosPorExpediente,
        }),
      });
      if (!r.ok) {
        let msg = `Exportación falló (${r.status})`;
        try {
          const j = (await r.json()) as { error?: string };
          if (typeof j.error === "string") msg = j.error;
        } catch {
          /* ignore */
        }
        throw new Error(msg);
      }
      const blob = await r.blob();
      const disp = r.headers.get("Content-Disposition") ?? "";
      const m = /filename="?([^";\n]+)"?/i.exec(disp);
      const filename = m?.[1]?.trim() || "comprasmx-export-personalizado.zip";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.rel = "noopener";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      onClose();
    } catch (e) {
      setExportError(mensajeErrorConexionComprasmxApi(e, "generico"));
    } finally {
      setExportando(false);
    }
  }, [api, docsPorExpediente, docsSel, fetchedAt, filas, filtros, licSel, onClose]);

  if (!open) return null;

  const totalDocsSel = docsSel.size;

  return (
    <>
    <div
      className="fixed inset-0 z-[62] flex items-center justify-center bg-black/55 p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="export-personalizado-title"
    >
      <div className="flex h-[min(96vh,calc(100dvh-1rem))] w-[min(100vw-1rem,1680px)] max-w-[1680px] flex-col overflow-hidden rounded-xl bg-white shadow-2xl dark:bg-zinc-950">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
          <div className="min-w-0">
            <h2 id="export-personalizado-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
              Exportación personalizada
            </h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {paso === "licitaciones"
                ? "Paso 1: elige las licitaciones"
                : `Paso 2: elige documentos (${totalDocsSel} marcado(s)) · vista previa al hacer clic`}
            </p>
          </div>
          <button
            type="button"
            className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            onClick={onClose}
          >
            Cerrar
          </button>
        </div>

        {paso === "licitaciones" ? (
          <div className="flex min-h-0 flex-1 flex-col">
            <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-100 px-4 py-2 dark:border-zinc-800">
              <span className="text-xs text-zinc-600 dark:text-zinc-400">
                {licSel.size} de {filas.length} licitación(es)
              </span>
              <div className="flex gap-2">
                <button
                  type="button"
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                  onClick={() => setLicSel(new Set(filas.map((f) => f.numeroIdentificacion)))}
                >
                  Todas
                </button>
                <button
                  type="button"
                  className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                  onClick={() => setLicSel(new Set())}
                >
                  Ninguna
                </button>
              </div>
            </div>
            <ul className="min-h-0 flex-1 overflow-y-auto p-4">
              {filas.map((f) => (
                <li
                  key={f.numeroIdentificacion}
                  className="mb-2 flex items-start gap-3 rounded-lg border border-zinc-200 px-3 py-2.5 dark:border-zinc-800"
                >
                  <input
                    type="checkbox"
                    className="mt-1 size-4 rounded"
                    checked={licSel.has(f.numeroIdentificacion)}
                    onChange={() => toggleLic(f.numeroIdentificacion)}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="font-mono text-xs text-emerald-800 dark:text-emerald-300">{f.numeroIdentificacion}</p>
                    <p className="text-sm text-zinc-800 dark:text-zinc-200">{f.nombre}</p>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(200px,22%)_minmax(240px,28%)_1fr]">
            <div className="flex max-h-[35vh] min-h-0 flex-col border-b border-zinc-200 dark:border-zinc-800 md:max-h-none md:border-b-0 md:border-r">
              <p className="shrink-0 border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                Licitaciones
              </p>
              <ul className="min-h-0 flex-1 overflow-y-auto p-2">
                {[...licSel].map((id) => {
                  const f = filas.find((x) => x.numeroIdentificacion === id);
                  const n = (docsPorExpediente[id] ?? []).length;
                  return (
                    <li key={id}>
                      <button
                        type="button"
                        onClick={() => {
                          setExpedienteActivo(id);
                          setPreview(null);
                        }}
                        className={`mb-1 w-full rounded-lg px-2 py-2 text-left text-xs ${
                          expedienteActivo === id
                            ? "bg-emerald-100 text-emerald-900 dark:bg-emerald-950/60 dark:text-emerald-200"
                            : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
                        }`}
                      >
                        <span className="block font-mono text-[10px]">{id}</span>
                        <span className="line-clamp-2 text-zinc-600 dark:text-zinc-400">{f?.nombre ?? ""}</span>
                        <span className="mt-0.5 block text-[10px] text-zinc-500">{n} archivo(s)</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
            <div className="flex max-h-[40vh] min-h-0 flex-col border-b border-zinc-200 dark:border-zinc-800 md:max-h-none md:border-b-0 md:border-r">
              <p className="shrink-0 border-b border-zinc-100 px-3 py-2 text-xs font-medium text-zinc-600 dark:border-zinc-800 dark:text-zinc-400">
                Documentos
              </p>
              <ul className="min-h-0 flex-1 overflow-y-auto p-2">
                {documentosActivos.length === 0 ? (
                  <li className="px-2 py-4 text-center text-xs text-zinc-500">Sin archivos para este expediente.</li>
                ) : (
                  documentosActivos.map((d) => {
                    const k = claveDocumentoExport(expedienteActivo!, d.nombre);
                    return (
                      <li key={d.nombre} className="mb-1">
                        <div
                          className={`flex items-start gap-2 rounded-lg border px-2 py-2 ${
                            preview?.nombre === d.nombre
                              ? "border-emerald-500 bg-emerald-50/80 dark:border-emerald-600 dark:bg-emerald-950/30"
                              : "border-transparent hover:bg-zinc-100 dark:hover:bg-zinc-900"
                          }`}
                        >
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 rounded"
                            checked={docsSel.has(k)}
                            onChange={() => toggleDoc(expedienteActivo!, d.nombre)}
                          />
                          <button
                            type="button"
                            className="min-w-0 flex-1 text-left"
                            onClick={() => seleccionarPreview(expedienteActivo!, d)}
                          >
                            <span className="block font-mono text-[10px] text-zinc-800 dark:text-zinc-200">
                              {d.nombre}
                            </span>
                            <span className="text-[10px] text-zinc-500">{(d.sizeBytes / 1024).toFixed(1)} KB</span>
                          </button>
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </div>
            <div className="relative flex min-h-[280px] min-h-0 flex-col bg-zinc-50 dark:bg-zinc-900">
              {!preview ? (
                <div className="flex flex-1 flex-col items-center justify-center px-6 py-10 text-center">
                  <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Vista previa</p>
                  <p className="mt-1 max-w-xs text-xs text-zinc-500">Haz clic en un documento para revisarlo antes de exportar.</p>
                </div>
              ) : preview.modoOfficeCliente && preview.officeClienteTipo ? (
                <OfficeClientPreview
                  key={`${expedienteActivo}:${preview.url}`}
                  nombre={preview.nombre}
                  url={preview.url}
                  tipo={preview.officeClienteTipo}
                />
              ) : preview.modoPdf ? (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {pdfLoading ? <DocumentoPreviewLoading conversionEnServidor={preview.conversionEnServidor} /> : null}
                  <iframe
                    title={preview.nombre}
                    src={preview.url}
                    className={`min-h-0 w-full flex-1 border-0 ${pdfLoading ? "invisible absolute inset-0 h-0 w-0" : ""}`}
                    onLoad={() => setPdfLoading(false)}
                  />
                </div>
              ) : categoriaVistaDocumento(preview.nombre) === "imagen" ? (
                <div className="relative flex min-h-0 flex-1 flex-col">
                  {imgLoading ? <DocumentoPreviewLoading titulo="Cargando imagen…" /> : null}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={preview.url}
                    alt={preview.nombre}
                    className={`max-h-full w-full flex-1 object-contain p-2 ${imgLoading ? "invisible" : ""}`}
                    onLoad={() => setImgLoading(false)}
                    onError={() => setImgLoading(false)}
                  />
                </div>
              ) : categoriaVistaDocumento(preview.nombre) === "texto" ? (
                <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs text-zinc-800 dark:text-zinc-200">
                  {preview.texto ?? <DocumentoPreviewLoading titulo="Cargando texto…" />}
                </pre>
              ) : (
                <div className="flex flex-1 flex-col items-center justify-center gap-2 p-4 text-sm text-zinc-600">
                  <p>Vista previa no disponible para este formato.</p>
                  <a
                    href={preview.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-700 underline dark:text-emerald-400"
                  >
                    Abrir archivo
                  </a>
                </div>
              )}
            </div>
          </div>
        )}

        <div className="shrink-0 border-t border-zinc-200 px-4 py-3 dark:border-zinc-800">
          {docsError ? (
            <p className="mb-2 text-sm text-red-600 dark:text-red-400">{docsError}</p>
          ) : null}
          {exportError ? (
            <p className="mb-2 text-sm text-red-600 dark:text-red-400">{exportError}</p>
          ) : null}
          {paso === "documentos" && totalDocsSel === 0 && !exportando ? (
            <p className="mb-2 text-xs text-amber-800 dark:text-amber-200">
              Marca al menos un documento o usa «Todos los docs» para poder exportar.
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            {paso === "documentos" ? (
              <button
                type="button"
                className="rounded-lg border border-zinc-300 px-3 py-2 text-sm dark:border-zinc-600"
                onClick={() => setPaso("licitaciones")}
              >
                ← Licitaciones
              </button>
            ) : (
              <span />
            )}
            <div className="flex flex-wrap gap-2">
              {paso === "licitaciones" ? (
                <button
                  type="button"
                  disabled={loadingDocs || licSel.size === 0}
                  onClick={() => void continuarADocumentos()}
                  className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-50"
                >
                  {loadingDocs ? "Cargando documentos…" : "Continuar a documentos →"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                    onClick={() => {
                      const todos = new Set<string>();
                      for (const id of licSel) {
                        for (const d of docsPorExpediente[id] ?? []) {
                          todos.add(claveDocumentoExport(id, d.nombre));
                        }
                      }
                      setDocsSel(todos);
                      setExportError(null);
                    }}
                  >
                    Todos los docs
                  </button>
                  <button
                    type="button"
                    className="rounded-md border border-zinc-300 px-2 py-1 text-xs dark:border-zinc-600"
                    onClick={() => {
                      setDocsSel(new Set());
                      setExportError(null);
                    }}
                  >
                    Ningún documento
                  </button>
                  <button
                    type="button"
                    disabled={exportando || totalDocsSel === 0}
                    title={totalDocsSel === 0 ? "Selecciona al menos un documento para exportar." : undefined}
                    onClick={() => void exportarSeleccion()}
                    className="rounded-lg bg-emerald-700 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {exportando ? "Generando ZIP…" : `Exportar ZIP + resumen (${licSel.size} lic., ${totalDocsSel} docs)`}
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
    <ExportacionProgresoOverlay
      open={exportando}
      config={{
        tipo: "export-personalizada",
        licitacionesCount: licSel.size,
        documentosCount: totalDocsSel,
      }}
    />
    </>
  );
}