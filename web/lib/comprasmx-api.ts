/**
 * Base del API Compras MX.
 * Por defecto usa el rewrite de Next (`/api/comprasmx` → backend).
 * El proxy de `next dev` tenía ~30s de timeout; en `next.config.ts` se sube con `experimental.proxyTimeout`
 * (30 min por defecto, variable `NEXT_DEV_PROXY_TIMEOUT_MS`).
 * Alternativa sin proxy: `NEXT_PUBLIC_COMPRASMX_API_BASE=http://127.0.0.1:8000/comprasmx` (requiere CORS en el API).
 */
export function comprasmxApiBase(): string {
  const raw = process.env.NEXT_PUBLIC_COMPRASMX_API_BASE?.trim();
  if (raw) return raw.replace(/\/$/, "");
  return "/api/comprasmx";
}

/** Convierte rutas que devuelve Express (`/comprasmx/...`) en URL usable desde el front. */
export function proxiedComprasmxUrl(pathOrUrl: string): string {
  const base = comprasmxApiBase();
  if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
    try {
      const u = new URL(pathOrUrl);
      if (u.pathname.startsWith("/comprasmx/")) {
        return `${base}${u.pathname}${u.search}`;
      }
    } catch {
      /* ignore */
    }
    return pathOrUrl;
  }
  if (pathOrUrl.startsWith("/comprasmx/")) {
    return `${base}${pathOrUrl.slice("/comprasmx".length)}`;
  }
  if (pathOrUrl.startsWith("/")) {
    return `${base}${pathOrUrl}`;
  }
  return `${base}/${pathOrUrl}`;
}

/**
 * Mensaje claro cuando `fetch` al API falla por red (backend apagado, proxy de Next sin destino, etc.).
 * El historial en `localStorage` solo guarda URLs; los bytes siguen en el servidor.
 */
export function mensajeErrorConexionComprasmxApi(err: unknown, context: "pdf" | "documentos" | "generico" = "generico"): string {
  const raw = err instanceof Error ? err.message : String(err);
  const t = raw.toLowerCase();
  const pareceRed =
    raw === "proxy" ||
    (err instanceof TypeError && (t.includes("fetch") || t.includes("failed to load"))) ||
    t.includes("failed to fetch") ||
    t.includes("networkerror") ||
    t.includes("network request failed") ||
    t.includes("load failed") ||
    t.includes("econnrefused");

  if (pareceRed) {
    const detalle =
      context === "pdf"
        ? "No se pudo obtener el archivo para la vista previa."
        : context === "documentos"
          ? "No se pudo listar los documentos del expediente."
          : "No se pudo completar la petición al API.";
    return `${detalle} El navegador solo tiene enlaces guardados; el backend (p. ej. http://127.0.0.1:8000) debe estar en marcha para que el proxy de Next (/api/comprasmx) pueda servirlos. Si usas otro host o puerto, revisa next.config y las variables de entorno del front.`;
  }
  if (t.includes("aborted")) return "Solicitud cancelada.";
  return raw.length > 800 ? `${raw.slice(0, 797)}…` : raw;
}
