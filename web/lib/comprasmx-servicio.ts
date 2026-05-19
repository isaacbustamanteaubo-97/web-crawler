import { esErrorStallStream } from "@/lib/comprasmx-stream";

export type ComprasmxErrorContexto = "busqueda" | "documentos" | "exportacion" | "descarga" | "pdf" | "generico";

export type ComprasmxUiError = {
  servicioNoDisponible: boolean;
  mensaje: string;
  /** Detalle técnico breve (solo si el servicio no está disponible). */
  detalle?: string;
};

export const TITULO_SERVICIO_NO_DISPONIBLE = "Servicio no disponible por el momento";

export const LEYENDA_SERVICIO_NO_DISPONIBLE =
  "En este momento no podemos atender tu solicitud: el servidor de Compras MX no responde o está en mantenimiento. Intenta de nuevo en unos minutos. Si el problema continúa, avisa al administrador del sistema.";

/** HTTP que suele indicar caída, saturación o proxy sin backend. */
export function httpStatusIndicaServicioCaido(status: number): boolean {
  return status === 0 || status === 408 || status === 502 || status === 503 || status === 504 || status >= 500;
}

export function esErrorRedFetch(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const t = err.message.toLowerCase();
  return (
    err.name === "TypeError" &&
    (t.includes("fetch") || t.includes("failed to load") || t.includes("network") || t.includes("load failed"))
  );
}

function detalleContexto(ctx: ComprasmxErrorContexto): string | undefined {
  switch (ctx) {
    case "busqueda":
      return "No se pudo ejecutar la consulta al portal.";
    case "documentos":
      return "No se pudo listar ni descargar documentos del expediente.";
    case "exportacion":
      return "No se pudo generar el archivo de exportación.";
    case "descarga":
      return "No se pudo completar la descarga.";
    case "pdf":
      return "No se pudo obtener el archivo para la vista previa.";
    default:
      return undefined;
  }
}

function pareceRespuestaSinBackend(error?: string): boolean {
  if (!error) return false;
  const t = error.toLowerCase();
  return (
    t.includes("internal server error") ||
    t.includes("no se pudo conectar con el api") ||
    t.includes("respuesta no es json") ||
    t.includes("backend esté en marcha") ||
    t.includes("backend esté corriendo") ||
    t.includes("respuesta vacía del api")
  );
}

export function errorValidacionComprasmx(mensaje: string): ComprasmxUiError {
  return { servicioNoDisponible: false, mensaje };
}

export function resolverErrorComprasmxUsuario(
  fuente: { err?: unknown; status?: number; error?: string; servicioNoDisponible?: boolean; sinRespuesta?: boolean },
  contexto: ComprasmxErrorContexto = "generico",
): ComprasmxUiError {
  const status = fuente.status ?? 0;
  const errorTexto =
    typeof fuente.error === "string" && fuente.error.trim()
      ? fuente.error.trim()
      : fuente.err instanceof Error
        ? fuente.err.message
        : fuente.err != null
          ? String(fuente.err)
          : "";

  const sinRespuesta = fuente.sinRespuesta === true || (fuente.err != null && esErrorStallStream(fuente.err));

  const servicioNoDisponible =
    fuente.servicioNoDisponible === true ||
    sinRespuesta ||
    httpStatusIndicaServicioCaido(status) ||
    (fuente.err != null && esErrorRedFetch(fuente.err)) ||
    pareceRespuestaSinBackend(errorTexto);

  if (servicioNoDisponible) {
    const detalleCtx = detalleContexto(contexto);
    const detalleSinRespuesta = sinRespuesta
      ? "El servidor dejó de responder (conexión interrumpida o proceso detenido)."
      : undefined;
    const detalleTecnico =
      errorTexto && !errorTexto.includes(LEYENDA_SERVICIO_NO_DISPONIBLE.slice(0, 40))
        ? errorTexto.length > 220
          ? `${errorTexto.slice(0, 217)}…`
          : errorTexto
        : undefined;
    return {
      servicioNoDisponible: true,
      mensaje: LEYENDA_SERVICIO_NO_DISPONIBLE,
      detalle: detalleSinRespuesta ?? detalleCtx ?? detalleTecnico,
    };
  }

  if (errorTexto) {
    const t = errorTexto.toLowerCase();
    if (t.includes("aborted") || t.includes("cancelad")) {
      return { servicioNoDisponible: false, mensaje: "Solicitud cancelada." };
    }
    return {
      servicioNoDisponible: false,
      mensaje: errorTexto.length > 800 ? `${errorTexto.slice(0, 797)}…` : errorTexto,
    };
  }

  return {
    servicioNoDisponible: false,
    mensaje: "Ocurrió un error inesperado. Vuelve a intentarlo.",
  };
}
