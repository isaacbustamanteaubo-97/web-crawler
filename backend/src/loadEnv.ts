import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(backendRoot, ".env") });

/** Ruta absoluta al JSON de la cuenta de servicio (si está configurado). */
export function resolveGoogleCredentialsPath(): string | undefined {
  const raw = process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim();
  if (!raw) return undefined;
  return path.isAbsolute(raw) ? raw : path.join(backendRoot, raw);
}
