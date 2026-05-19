"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { DocumentoPreviewLoading } from "@/app/components/DocumentoPreviewLoading";
import { etiquetaOfficeCliente, type OfficeClienteTipo } from "@/lib/office-client-preview";
import { mensajeErrorConexionComprasmxApi } from "@/lib/comprasmx-api";

const DOCX_ZOOM_MIN = 0.5;
const DOCX_ZOOM_MAX = 2;
const DOCX_ZOOM_STEP = 0.1;

type Props = {
  nombre: string;
  url: string;
  tipo: OfficeClienteTipo;
};

function btnZoomClass(disabled: boolean): string {
  return `inline-flex size-8 items-center justify-center rounded-md border text-sm font-medium transition-colors ${
    disabled
      ? "cursor-not-allowed border-zinc-200 text-zinc-300 dark:border-zinc-800 dark:text-zinc-600"
      : "border-zinc-300 text-zinc-700 hover:bg-zinc-200 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
  }`;
}

export function OfficeClientPreview({ nombre, url, tipo }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [docxZoom, setDocxZoom] = useState(1);

  const acercarDocx = useCallback(() => {
    setDocxZoom((z) => Math.min(DOCX_ZOOM_MAX, Math.round((z + DOCX_ZOOM_STEP) * 10) / 10));
  }, []);

  const alejarDocx = useCallback(() => {
    setDocxZoom((z) => Math.max(DOCX_ZOOM_MIN, Math.round((z - DOCX_ZOOM_STEP) * 10) / 10));
  }, []);

  useEffect(() => {
    setDocxZoom(1);
  }, [url, tipo, nombre]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const ac = new AbortController();
    let cancelled = false;

    setLoading(true);
    setError(null);
    host.innerHTML = "";

    void (async () => {
      try {
        const r = await fetch(url, { signal: ac.signal });
        if (!r.ok) {
          const t = await r.text().catch(() => "");
          throw new Error(t.slice(0, 400) || `HTTP ${r.status}`);
        }
        const buf = await r.arrayBuffer();

        if (tipo === "docx") {
          const { renderAsync } = await import("docx-preview");
          if (cancelled || !hostRef.current) return;
          await renderAsync(buf, hostRef.current, undefined, {
            className: "docx-preview",
            inWrapper: true,
            ignoreWidth: false,
            ignoreHeight: true,
          });
        } else {
          const XLSX = await import("xlsx");
          if (cancelled || !hostRef.current) return;
          const wb = XLSX.read(buf, { type: "array" });
          const sheetName = wb.SheetNames[0];
          if (!sheetName) throw new Error("El archivo no tiene hojas.");
          const sheet = wb.Sheets[sheetName];
          if (!sheet) throw new Error("No se pudo leer la primera hoja.");
          const html = XLSX.utils.sheet_to_html(sheet, { id: "cmx-sheet-preview" });
          hostRef.current.innerHTML = `<div class="cmx-xlsx-wrap overflow-auto p-2 text-sm text-zinc-900 dark:text-zinc-100">${html}</div>`;
        }
      } catch (e) {
        if (ac.signal.aborted) return;
        setError(mensajeErrorConexionComprasmxApi(e, "pdf"));
      } finally {
        if (!ac.signal.aborted) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      ac.abort();
    };
  }, [url, tipo, nombre]);

  const mostrarZoomDocx = tipo === "docx" && !loading && !error;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-200 bg-zinc-100/80 px-4 py-2 dark:border-zinc-800 dark:bg-zinc-900/80">
        <p className="text-xs text-zinc-600 dark:text-zinc-400">
          Vista previa en el navegador ({etiquetaOfficeCliente(tipo)}). El formato puede no coincidir al 100 % con
          Office.
        </p>
        {mostrarZoomDocx ? (
          <div
            className="flex shrink-0 items-center gap-1.5"
            role="toolbar"
            aria-label="Zoom del documento Word"
          >
            <button
              type="button"
              className={btnZoomClass(docxZoom <= DOCX_ZOOM_MIN)}
              onClick={alejarDocx}
              disabled={docxZoom <= DOCX_ZOOM_MIN}
              aria-label="Alejar"
              title="Alejar"
            >
              −
            </button>
            <span className="min-w-[3.25rem] text-center font-mono text-xs tabular-nums text-zinc-700 dark:text-zinc-300">
              {Math.round(docxZoom * 100)}%
            </span>
            <button
              type="button"
              className={btnZoomClass(docxZoom >= DOCX_ZOOM_MAX)}
              onClick={acercarDocx}
              disabled={docxZoom >= DOCX_ZOOM_MAX}
              aria-label="Acercar"
              title="Acercar"
            >
              +
            </button>
            <button
              type="button"
              className="rounded-md border border-zinc-300 px-2 py-1 text-[11px] font-medium text-zinc-700 hover:bg-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 dark:border-zinc-600 dark:text-zinc-200 dark:hover:bg-zinc-800"
              onClick={() => setDocxZoom(1)}
              disabled={docxZoom === 1}
              aria-label="Restablecer zoom"
            >
              100%
            </button>
          </div>
        ) : null}
      </div>
      <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
        {loading ? (
          <DocumentoPreviewLoading
            titulo="Preparando vista previa en el navegador…"
            subtitulo="Descargando el archivo desde el servidor y generando la vista."
          />
        ) : null}
      {error ? (
        <div className="flex flex-1 flex-col gap-3 p-4 text-sm text-red-700 dark:text-red-300">
          <p>No se pudo generar la vista previa: {error}</p>
          <a
            href={url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex w-fit rounded-lg bg-zinc-900 px-3 py-2 text-white dark:bg-zinc-100 dark:text-zinc-900"
          >
            Descargar archivo
          </a>
        </div>
      ) : null}
        <div
          ref={scrollRef}
          className={`min-h-0 flex-1 overflow-x-auto overflow-y-auto bg-white dark:bg-zinc-950 ${loading || error ? "hidden" : ""}`}
        >
          <div
            className="cmx-docx-scroll inline-block min-w-full"
            style={tipo === "docx" ? { zoom: docxZoom } : undefined}
          >
            <div ref={hostRef} />
          </div>
        </div>
      </div>
    </div>
  );
}
