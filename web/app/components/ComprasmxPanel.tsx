"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { comprasmxApiBase, proxiedComprasmxUrl } from "@/lib/comprasmx-api";
import {
  DEFAULT_ENTIDADES_FEDERATIVAS,
  DEFAULT_PALABRAS_CLAVE,
  ENTIDADES_TODAS_FALLBACK,
} from "@/lib/comprasmx-defaults";
import { esFechaIsoValida, fechaIsoHoyMexico } from "@/lib/fecha-mexico";

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
  filtros?: Record<string, unknown>;
  error?: string;
};

type DocumentoRow = {
  nombre: string;
  sizeBytes: number;
  modificadoIso: string;
  urlDescarga: string;
  /** PDF para iframe: nativos o Office convertido en el API (`vista=pdf`). */
  urlVistaPdf?: string;
};

type DocumentosResponse = {
  numeroIdentificacion: string;
  documentos: DocumentoRow[];
  error?: string;
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

function categoriaVista(nombre: string): "pdf" | "imagen" | "texto" | "otro" {
  const e = extDeNombre(nombre);
  if (e === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg"].includes(e)) return "imagen";
  if (["txt", "csv", "json", "xml", "log", "md"].includes(e)) return "texto";
  return "otro";
}

export function ComprasmxPanel() {
  const api = useMemo(() => comprasmxApiBase(), []);

  const [fechaISO, setFechaISO] = useState(fechaIsoHoyMexico);
  const [entidadesLista, setEntidadesLista] = useState<string[]>([...ENTIDADES_TODAS_FALLBACK]);
  const [entSel, setEntSel] = useState<Set<string>>(() => new Set(DEFAULT_ENTIDADES_FEDERATIVAS));
  const [palabrasTexto, setPalabrasTexto] = useState(DEFAULT_PALABRAS_CLAVE.join("\n"));
  const [headed, setHeaded] = useState(false);

  const [loadingSnap, setLoadingSnap] = useState(false);
  const [snapError, setSnapError] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<SnapshotResponse | null>(null);

  const [docModal, setDocModal] = useState<string | null>(null);
  const [docs, setDocs] = useState<DocumentoRow[]>([]);
  const [docsError, setDocsError] = useState<string | null>(null);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [preview, setPreview] = useState<{
    nombre: string;
    url: string;
    texto?: string;
    /** true = PDF en iframe (archivo .pdf o conversión `vista=pdf` del backend). */
    modoPdf?: boolean;
  } | null>(null);
  const [pdfBlobUrl, setPdfBlobUrl] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfFetchError, setPdfFetchError] = useState<string | null>(null);

  useEffect(() => {
    let cancel = false;
    (async () => {
      try {
        const r = await fetch(`${api}/entidades`);
        if (!r.ok) return;
        const j = (await r.json()) as { entidades?: string[] };
        if (cancel || !Array.isArray(j.entidades) || j.entidades.length === 0) return;
        setEntidadesLista(j.entidades);
      } catch {
        /* fallback ENTIDADES_TODAS_FALLBACK */
      }
    })();
    return () => {
      cancel = true;
    };
  }, [api]);

  useEffect(() => {
    if (!preview?.modoPdf || !preview.url) {
      setPdfBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      setPdfLoading(false);
      setPdfFetchError(null);
      return;
    }

    const ac = new AbortController();
    let objectUrl: string | null = null;

    setPdfLoading(true);
    setPdfFetchError(null);
    setPdfBlobUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });

    void (async () => {
      try {
        const r = await fetch(preview.url, { signal: ac.signal });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t.slice(0, 500) || `HTTP ${r.status}`);
        }
        const blob = await r.blob();
        objectUrl = URL.createObjectURL(blob);
        if (ac.signal.aborted) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        setPdfBlobUrl(objectUrl);
        objectUrl = null;
      } catch (e) {
        if (ac.signal.aborted) return;
        setPdfFetchError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!ac.signal.aborted) setPdfLoading(false);
      }
    })();

    return () => {
      ac.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [preview?.modoPdf, preview?.url]);

  const toggleEnt = useCallback((nombre: string) => {
    setEntSel((prev) => {
      const n = new Set(prev);
      if (n.has(nombre)) n.delete(nombre);
      else n.add(nombre);
      return n;
    });
  }, []);

  const palabrasClavePayload = useCallback(
    () =>
      palabrasTexto
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean),
    [palabrasTexto],
  );

  const ejecutarSnapshot = useCallback(async () => {
    setSnapError(null);
    setSnapshot(null);
    setLoadingSnap(true);
    try {
      const entidadesFederativas = [...entSel].sort((a, b) => a.localeCompare(b, "es"));
      if (entidadesFederativas.length === 0) {
        setSnapError("Selecciona al menos una entidad federativa.");
        return;
      }
      if (!esFechaIsoValida(fechaISO)) {
        setSnapError("La fecha debe ser válida en formato YYYY-MM-DD (ej. 2026-05-14).");
        return;
      }
      const palabrasClave = palabrasClavePayload();
      if (palabrasClave.length === 0) {
        setSnapError("Escribe al menos una palabra clave (una por línea).");
        return;
      }
      const body = {
        fechaISO: fechaISO.trim(),
        entidadesFederativas,
        palabrasClave,
      };
      const qs = headed ? "?headed=1" : "";
      const r = await fetch(`${api}/snapshot${qs}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = (await r.json()) as SnapshotResponse & { error?: string };
      if (!r.ok) {
        setSnapError(j.error ?? `Error ${r.status}`);
        return;
      }
      setSnapshot(j);
    } catch (e) {
      setSnapError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingSnap(false);
    }
  }, [api, entSel, fechaISO, headed, palabrasClavePayload]);

  const abrirDocumentos = useCallback(
    async (numeroIdentificacion: string) => {
      setDocModal(numeroIdentificacion);
      setDocs([]);
      setDocsError(null);
      setPreview(null);
      setLoadingDocs(true);
      try {
        const r = await fetch(`${api}/documentos?${new URLSearchParams({ numeroIdentificacion }).toString()}`);
        const j = (await r.json()) as DocumentosResponse & { error?: string };
        if (!r.ok) {
          setDocsError(j.error ?? `Error ${r.status}`);
          return;
        }
        setDocs(
          j.documentos.map((d) => ({
            ...d,
            urlDescarga: proxiedComprasmxUrl(d.urlDescarga),
            ...(d.urlVistaPdf ? { urlVistaPdf: proxiedComprasmxUrl(d.urlVistaPdf) } : {}),
          })),
        );
      } catch (e) {
        setDocsError(e instanceof Error ? e.message : String(e));
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
      if (cat === "pdf" || d.urlVistaPdf) {
        setPreview({ nombre: d.nombre, url: d.urlVistaPdf ?? d.urlDescarga, modoPdf: true });
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
              className="w-44 rounded-lg border border-zinc-300 bg-white px-3 py-2 font-mono text-sm text-zinc-900 shadow-sm outline-none ring-zinc-400/40 focus:border-emerald-600 focus:ring-2 dark:border-zinc-600 dark:bg-zinc-900 dark:text-zinc-100 dark:focus:border-emerald-500"
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
          <div className="max-h-56 overflow-y-auto rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
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
                    {e}
                  </label>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <label htmlFor="kw" className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
            Palabras clave (una por línea → arreglo `palabrasClave`)
          </label>
          <textarea
            id="kw"
            rows={8}
            value={palabrasTexto}
            onChange={(e) => setPalabrasTexto(e.target.value)}
            className="w-full rounded-lg border border-zinc-300 bg-white p-3 font-mono text-sm dark:border-zinc-700 dark:bg-zinc-900"
          />
        </div>

        <label className="flex items-center gap-2 text-sm text-zinc-700 dark:text-zinc-300">
          <input type="checkbox" checked={headed} onChange={(e) => setHeaded(e.target.checked)} className="size-4" />
          Ejecutar con navegador visible (`?headed=1`) — útil para depurar en el servidor.
        </label>

        <button
          type="button"
          disabled={loadingSnap}
          onClick={() => void ejecutarSnapshot()}
          className="inline-flex items-center justify-center rounded-lg bg-emerald-700 px-4 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 disabled:opacity-60"
        >
          {loadingSnap ? "Buscando…" : "Buscar licitaciones (snapshot)"}
        </button>

        {snapError ? (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {snapError}
          </p>
        ) : null}
      </section>

      {snapshot ? (
        <section className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 sm:p-6">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
            Resultados ({snapshot.totalFilas ?? snapshot.filas?.length ?? 0})
          </h2>
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
            <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800 sm:px-5">
              <h2 id="doc-modal-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">
                Documentos — {docModal}
              </h2>
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
                onClick={() => {
                  setDocModal(null);
                  setPreview(null);
                  setPdfBlobUrl((prev) => {
                    if (prev) URL.revokeObjectURL(prev);
                    return null;
                  });
                  setPdfFetchError(null);
                  setPdfLoading(false);
                }}
              >
                Cerrar
              </button>
            </div>
            <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[minmax(280px,22%)_1fr] md:gap-0">
              <div className="flex max-h-[40vh] min-h-0 flex-col overflow-hidden border-b border-zinc-200 dark:border-zinc-800 md:max-h-none md:border-b-0 md:border-r">
                <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-4">
                  {loadingDocs ? <p className="text-sm text-zinc-500">Cargando…</p> : null}
                  {docsError ? <p className="text-sm text-red-600">{docsError}</p> : null}
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
              <div className="relative flex min-h-0 flex-1 flex-col bg-zinc-50 dark:bg-zinc-900">
                {!preview ? (
                  <p className="p-4 text-sm text-zinc-500">Selecciona un archivo para previsualizarlo.</p>
                ) : preview.modoPdf ? (
                  <div className="flex min-h-0 flex-1 flex-col">
                    {pdfLoading && !pdfBlobUrl ? (
                      <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
                        <p className="text-sm font-medium text-zinc-700 dark:text-zinc-300">Generando vista PDF…</p>
                        <p className="max-w-md text-xs text-zinc-500">
                          La conversión puede tardar más de un minuto en documentos grandes. No cierres el modal hasta
                          que termine.
                        </p>
                      </div>
                    ) : null}
                    {pdfFetchError ? (
                      <div className="flex flex-1 flex-col gap-3 p-4 text-sm text-red-700 dark:text-red-300">
                        <p>No se pudo cargar la vista PDF: {pdfFetchError}</p>
                        <a
                          href={preview.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex w-fit rounded-lg bg-zinc-900 px-3 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
                        >
                          Abrir URL en pestaña nueva
                        </a>
                      </div>
                    ) : null}
                    {pdfBlobUrl ? (
                      <iframe
                        title={preview.nombre}
                        src={pdfBlobUrl}
                        className="min-h-[min(85dvh,880px)] w-full flex-1 border-0 md:min-h-0"
                      />
                    ) : null}
                  </div>
                ) : categoriaVista(preview.nombre) === "imagen" ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={preview.url}
                    alt={preview.nombre}
                    className="max-h-[min(85vh,900px)] w-full flex-1 object-contain p-2"
                  />
                ) : categoriaVista(preview.nombre) === "texto" ? (
                  <pre className="min-h-0 flex-1 overflow-auto p-4 font-mono text-xs leading-relaxed text-zinc-800 dark:text-zinc-200">
                    {preview.texto ?? "Cargando…"}
                  </pre>
                ) : (
                  <div className="flex flex-col gap-3 p-4 text-sm text-zinc-700 dark:text-zinc-300">
                    <p>
                      Vista previa no disponible para <strong>{extDeNombre(preview.nombre) || "este formato"}</strong>.
                      Convierte a PDF en el servidor si necesitas verlo aquí, o descarga y ábrelo en Word / PowerPoint /
                      Excel.
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
    </div>
  );
}
