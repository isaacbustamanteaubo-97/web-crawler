import { httpStatusIndicaServicioCaido, resolverErrorComprasmxUsuario, type ComprasmxErrorContexto } from "@/lib/comprasmx-servicio";

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
export type ComprasmxJsonResult<T> =
  | { ok: true; status: number; data: T }
  | { ok: false; status: number; data: null; error: string; servicioNoDisponible?: boolean };

/**
 * Lee el cuerpo como JSON sin lanzar si el proxy devolvió texto ("Internal Server Error").
 */
export async function readComprasmxJsonResponse<T>(r: Response): Promise<ComprasmxJsonResult<T>> {
  const text = await r.text();
  const trimmed = text.trim();

  if (!trimmed) {
    const vacio = r.ok ? "Respuesta vacía del API." : `Error ${r.status} (respuesta vacía).`;
    const caido = !r.ok && httpStatusIndicaServicioCaido(r.status);
    return { ok: false, status: r.status, data: null, error: vacio, servicioNoDisponible: caido };
  }

  const pareceHtmlOProxy =
    trimmed.startsWith("Internal Server Error") ||
    trimmed.startsWith("<!DOCTYPE") ||
    trimmed.startsWith("<html");

  if (pareceHtmlOProxy) {
    return {
      ok: false,
      status: r.status || 502,
      data: null,
      error:
        "No se pudo conectar con el API Compras MX. Arranca el backend (cd backend && yarn dev, puerto 8000 por defecto) y deja Next en marcha para el proxy /api/comprasmx.",
      servicioNoDisponible: true,
    };
  }

  try {
    const data = JSON.parse(trimmed) as T;
    if (!r.ok) {
      const errField = (data as { error?: unknown })?.error;
      const msg = typeof errField === "string" && errField.trim() ? errField : `Error ${r.status}`;
      return {
        ok: false,
        status: r.status,
        data: null,
        error: msg,
        servicioNoDisponible: httpStatusIndicaServicioCaido(r.status),
      };
    }
    return { ok: true, status: r.status, data };
  } catch {
    return {
      ok: false,
      status: r.status,
      data: null,
      error: `Respuesta no es JSON válido (HTTP ${r.status}). Revisa que el backend esté en marcha en ${process.env.BACKEND_PROXY_URL ?? "http://127.0.0.1:8000"}.`,
      servicioNoDisponible: true,
    };
  }
}

export function errorUiDesdeJson<T>(
  parsed: ComprasmxJsonResult<T>,
  contexto: ComprasmxErrorContexto = "generico",
) {
  if (parsed.ok) return null;
  return resolverErrorComprasmxUsuario(
    {
      status: parsed.status,
      error: parsed.error,
      servicioNoDisponible: parsed.servicioNoDisponible,
    },
    contexto,
  );
}

export function proxiedComprasmxUrl(pathOrUrl: string): string {
  const base = comprasmxApiBase().replace(/\/$/, "");
  const raw = pathOrUrl.trim();
  if (!raw) return base;

  /** Ya es ruta del proxy Next o URL del API del front — no duplicar prefijo. */
  if (raw.startsWith("/api/comprasmx/") || raw === "/api/comprasmx") {
    return raw;
  }
  if (base.startsWith("/") && (raw.startsWith(`${base}/`) || raw === base)) {
    return raw;
  }

  if (raw.startsWith("http://") || raw.startsWith("https://")) {
    try {
      const u = new URL(raw);
      if (u.pathname.startsWith("/comprasmx/")) {
        const rest = u.pathname.slice("/comprasmx".length) || "";
        return `${base}${rest}${u.search}`;
      }
      if (u.pathname.startsWith("/api/comprasmx/")) {
        return `${u.pathname}${u.search}`;
      }
    } catch {
      /* ignore */
    }
    return raw;
  }

  if (raw.startsWith("/comprasmx/")) {
    return `${base}${raw.slice("/comprasmx".length)}`;
  }

  if (raw.startsWith("/")) {
    if (base.startsWith("http://") || base.startsWith("https://")) {
      return `${base}${raw}`;
    }
    return `${base}${raw}`;
  }

  return `${base}/${raw}`;
}

/**
 * Mensaje claro cuando `fetch` al API falla por red (backend apagado, proxy de Next sin destino, etc.).
 * El historial en `localStorage` solo guarda URLs; los bytes siguen en el servidor.
 */
export { fetchComprasmxConTimeout } from "@/lib/comprasmx-stream";

/** @deprecated Preferir `resolverErrorComprasmxUsuario` + `ComprasmxErrorAviso`. */
export function mensajeErrorConexionComprasmxApi(
  err: unknown,
  context: "pdf" | "documentos" | "generico" = "generico",
): string {
  const ctx: ComprasmxErrorContexto =
    context === "pdf" ? "pdf" : context === "documentos" ? "documentos" : "generico";
  return resolverErrorComprasmxUsuario({ err }, ctx).mensaje;
}
