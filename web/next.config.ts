import type { NextConfig } from "next";

const backend = process.env.BACKEND_PROXY_URL ?? "http://127.0.0.1:8000";

/** El proxy del `next dev` corta por defecto (~30s); el snapshot de Playwright puede tardar varios minutos. */
const proxyTimeoutMs = Number(process.env.NEXT_DEV_PROXY_TIMEOUT_MS) || 1_800_000;

const nextConfig: NextConfig = {
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
