import { createHmac, timingSafeEqual } from "node:crypto";

const DEFAULT_TTL_SEC = 3600;

function secret(): string | null {
  const s =
    process.env.COMPRASMX_VIEWER_TOKEN_SECRET?.trim() ||
    process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim();
  return s || null;
}

function ttlSec(): number {
  const raw = process.env.COMPRASMX_VIEWER_TOKEN_TTL_SEC?.trim();
  const n = raw ? parseInt(raw, 10) : DEFAULT_TTL_SEC;
  if (!Number.isFinite(n) || n < 60) return DEFAULT_TTL_SEC;
  return Math.min(n, 86_400);
}

/** Token HMAC para que Google Docs Viewer pueda descargar el archivo vía URL pública del API. */
export function signArchivoViewerToken(numeroIdentificacion: string, nombre: string): string | null {
  const key = secret();
  if (!key) return null;
  const exp = Math.floor(Date.now() / 1000) + ttlSec();
  const payload = `${numeroIdentificacion}\n${nombre}\n${exp}`;
  const sig = createHmac("sha256", key).update(payload).digest("base64url");
  return Buffer.from(`${exp}.${sig}`).toString("base64url");
}

export function verifyArchivoViewerToken(
  token: string,
  numeroIdentificacion: string,
  nombre: string,
): boolean {
  const key = secret();
  if (!key || !token.trim()) return false;
  try {
    const decoded = Buffer.from(token, "base64url").toString("utf8");
    const dot = decoded.indexOf(".");
    if (dot < 0) return false;
    const exp = parseInt(decoded.slice(0, dot), 10);
    const sig = decoded.slice(dot + 1);
    if (!Number.isFinite(exp) || exp < Math.floor(Date.now() / 1000)) return false;
    const payload = `${numeroIdentificacion}\n${nombre}\n${exp}`;
    const expected = createHmac("sha256", key).update(payload).digest("base64url");
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
