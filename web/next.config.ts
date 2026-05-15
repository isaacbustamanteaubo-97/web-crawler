import type { NextConfig } from "next";

const backend = process.env.BACKEND_PROXY_URL ?? "http://127.0.0.1:8000";

/** El proxy del `next dev` corta por defecto (~30s); el snapshot de Playwright puede tardar varios minutos. */
const proxyTimeoutMs = Number(process.env.NEXT_DEV_PROXY_TIMEOUT_MS) || 1_800_000;

/**
 * Orígenes extra para HMR en `next dev` (p. ej. abrir desde el móvil o `http://192.168.x.x:3000`).
 * Lista separada por comas en `ALLOWED_DEV_ORIGINS`.
 */
const allowedDevOrigins = (process.env.ALLOWED_DEV_ORIGINS ?? "192.168.100.186")
  .split(/[,;\s]+/)
  .map((s) => s.trim())
  .filter(Boolean);

const nextConfig: NextConfig = {
  allowedDevOrigins,
  async rewrites() {
    return [
      {
        source: "/api/comprasmx/:path*",
        destination: `${backend.replace(/\/$/, "")}/comprasmx/:path*`,
      },
    ];
  },
  experimental: {
    proxyTimeout: proxyTimeoutMs,
  },
};

export default nextConfig;
