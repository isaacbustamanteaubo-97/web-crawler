import type { ComprasmxUiError } from "@/lib/comprasmx-servicio";
import { TITULO_SERVICIO_NO_DISPONIBLE } from "@/lib/comprasmx-servicio";

type Props = {
  error: ComprasmxUiError | null;
  className?: string;
};

export function ComprasmxErrorAviso({ error, className = "" }: Props) {
  if (!error) return null;

  if (error.servicioNoDisponible) {
    return (
      <div
        role="alert"
        className={`rounded-lg border border-amber-300 bg-amber-50 px-3 py-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100 ${className}`}
      >
        <p className="font-semibold text-amber-900 dark:text-amber-50">{TITULO_SERVICIO_NO_DISPONIBLE}</p>
        <p className="mt-1.5 leading-relaxed">{error.mensaje}</p>
        {error.detalle ? (
          <p className="mt-2 text-xs text-amber-800/90 dark:text-amber-200/80">{error.detalle}</p>
        ) : null}
      </div>
    );
  }

  return (
    <p
      role="alert"
      className={`rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200 ${className}`}
    >
      {error.mensaje}
    </p>
  );
}
