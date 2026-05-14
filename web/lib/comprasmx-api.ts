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
