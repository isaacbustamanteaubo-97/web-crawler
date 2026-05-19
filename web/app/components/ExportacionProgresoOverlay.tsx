"use client";

import { useEffect, useState } from "react";
import { formatoDuracionSegundos } from "@/lib/formato-duracion";

export type ProgresoOverlayConfig =
  | { tipo: "export-completa"; licitacionesCount: number }
  | { tipo: "export-personalizada"; licitacionesCount: number; documentosCount: number }
  | { tipo: "descarga-zip"; expediente: string; archivosCount: number }
  | { tipo: "descarga-individuales"; expediente: string; archivosCount: number };

type Props = {
  open: boolean;
  config: ProgresoOverlayConfig;
};

function textosProgreso(config: ProgresoOverlayConfig): {
  titulo: string;
  detalle: string;
  activo: string;
  leyenda: string;
  progressLabel: string;
} {
  switch (config.tipo) {
    case "export-completa":
      return {
        titulo: "Exportando todo el snapshot",
        detalle: `${config.licitacionesCount} licitación(es) · todos los documentos disponibles`,
        activo: "Empaquetando ZIP y resumen Word…",
        leyenda:
          "El servidor recopila los archivos, arma las carpetas por expediente y genera resumen_licitaciones.docx. Según el volumen puede tardar varios minutos; no cierres esta ventana hasta que se descargue el archivo.",
        progressLabel: "Generando exportación",
      };
    case "export-personalizada":
      return {
        titulo: "Exportación personalizada en curso",
        detalle: `${config.licitacionesCount} licitación(es) · ${config.documentosCount} documento(s) seleccionado(s)`,
        activo: "Empaquetando ZIP y resumen Word…",
        leyenda:
          "El servidor recopila los archivos seleccionados y genera resumen_licitaciones.docx. Según el volumen puede tardar varios minutos; no cierres esta ventana hasta que se descargue el archivo.",
        progressLabel: "Generando exportación",
      };
    case "descarga-zip":
      return {
        titulo: "Descargando ZIP del expediente",
        detalle: `${config.expediente} · ${config.archivosCount} archivo(s)`,
        activo: "Generando y descargando archivo ZIP…",
        leyenda:
          "El servidor comprime los anexos de este expediente. Según el tamaño puede tardar; no cierres esta ventana hasta que se descargue el archivo.",
        progressLabel: "Descargando ZIP",
      };
    case "descarga-individuales":
      return {
        titulo: "Descargando documentos sin comprimir",
        detalle: `${config.expediente} · ${config.archivosCount} archivo(s)`,
        activo: "Descargando archivos uno por uno…",
        leyenda:
          "Se obtiene cada archivo del servidor y se guarda en tu equipo. Con muchos archivos puede tardar varios minutos; no cierres esta ventana hasta que termine.",
        progressLabel: "Descargando archivos",
      };
  }
}

export function ExportacionProgresoOverlay({ open, config }: Props) {
  const [elapsedSec, setElapsedSec] = useState(0);

  useEffect(() => {
    if (!open) {
      setElapsedSec(0);
      return;
    }
    const start = Date.now();
    const tick = () => setElapsedSec(Math.floor((Date.now() - start) / 1000));
    tick();
    const id = setInterval(tick, 500);
    return () => clearInterval(id);
  }, [open]);

  if (!open) return null;

  const { titulo, detalle, activo, leyenda, progressLabel } = textosProgreso(config);

  return (
    <div
      className="fixed inset-0 z-[70] flex items-center justify-center bg-black/60 p-3 sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="progreso-overlay-title"
      aria-busy="true"
    >
      <div className="w-full max-w-md overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-2xl dark:border-zinc-700 dark:bg-zinc-950">
        <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800 sm:px-5">
          <h2 id="progreso-overlay-title" className="text-base font-semibold text-zinc-900 dark:text-zinc-50">
            {titulo}
          </h2>
          <p className="mt-1 text-xs text-zinc-600 dark:text-zinc-400">{detalle}</p>
        </div>
        <div className="space-y-4 px-4 py-5 sm:px-5">
          <div
            className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800"
            role="progressbar"
            aria-valuetext={progressLabel}
          >
            <div className="comprasmx-indeterminate-bar h-full rounded-full bg-gradient-to-r from-emerald-700 via-emerald-400 to-emerald-600 dark:from-emerald-500 dark:via-emerald-300 dark:to-emerald-500" />
          </div>
          <p className="flex items-center gap-2 text-sm font-medium text-emerald-800 dark:text-emerald-300">
            <span className="inline-flex items-center gap-0.5" aria-hidden>
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.25s] dark:bg-emerald-400" />
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.12s] dark:bg-emerald-400" />
              <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 dark:bg-emerald-400" />
            </span>
            {activo}
          </p>
          <p className="text-xs leading-relaxed text-zinc-600 dark:text-zinc-400">{leyenda}</p>
          <div className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-900/50">
            <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Tiempo transcurrido</span>
            <span
              className="font-mono text-sm font-semibold tabular-nums text-zinc-900 dark:text-zinc-100"
              aria-live="polite"
            >
              {formatoDuracionSegundos(elapsedSec)}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
