type Props = {
  /** Conversión LibreOffice en el servidor (`vista=pdf`). */
  conversionEnServidor?: boolean;
  titulo?: string;
  subtitulo?: string;
};

export function DocumentoPreviewLoading({ conversionEnServidor, titulo, subtitulo }: Props) {
  const tituloFinal =
    titulo ??
    (conversionEnServidor ? "Convirtiendo a PDF en el servidor…" : "Cargando documento desde el servidor…");
  const subtituloFinal =
    subtitulo ??
    (conversionEnServidor
      ? "En documentos grandes puede tardar más de un minuto. No cierres el modal hasta que termine."
      : "Obteniendo el archivo para mostrarlo aquí.");

  return (
    <div
      className="absolute inset-0 z-10 flex min-h-[220px] flex-col justify-center gap-3 bg-zinc-50/95 px-6 py-10 dark:bg-zinc-900/95"
      role="status"
      aria-busy="true"
      aria-label={tituloFinal}
    >
      <div className="mx-auto h-1.5 w-full max-w-md overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
        <div className="comprasmx-indeterminate-bar h-full rounded-full bg-gradient-to-r from-emerald-700 via-emerald-400 to-emerald-600 dark:from-emerald-500 dark:via-emerald-300 dark:to-emerald-500" />
      </div>
      <p className="flex flex-wrap items-center justify-center gap-2 text-center text-sm font-medium text-emerald-800 dark:text-emerald-300">
        <span className="inline-flex items-center gap-0.5" aria-hidden>
          <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.25s] dark:bg-emerald-400" />
          <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 [animation-delay:-0.12s] dark:bg-emerald-400" />
          <span className="inline-block size-1.5 animate-bounce rounded-full bg-emerald-600 dark:bg-emerald-400" />
        </span>
        {tituloFinal}
      </p>
      <p className="mx-auto max-w-md text-center text-xs leading-relaxed text-zinc-500 dark:text-zinc-400">
        {subtituloFinal}
      </p>
    </div>
  );
}
