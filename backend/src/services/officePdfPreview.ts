import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const EXT_CONVERTIBLES = new Set([
  "doc",
  "docm",
  "docx",
  "dot",
  "dotm",
  "dotx",
  "odt",
  "rtf",
  "ppt",
  "pptm",
  "pptx",
  "pot",
  "potm",
  "potx",
  "odp",
  "pps",
  "ppsx",
  "xls",
  "xlsb",
  "xlsm",
  "xlsx",
  "xlt",
  "xltm",
  "xltx",
  "ods",
  "csv",
]);

function extDeNombreArchivo(nombre: string): string {
  const base = path.basename(nombre.trim());
  const i = base.lastIndexOf(".");
  return i >= 0 ? base.slice(i + 1).toLowerCase() : "";
}

export function esNombreArchivoConvertibleVistaPdf(nombre: string): boolean {
  const e = extDeNombreArchivo(nombre);
  if (e === "pdf") return false;
  return e.length > 0 && EXT_CONVERTIBLES.has(e);
}

function hashCacheKey(absolutePath: string, mtimeMs: number, size: number): string {
  return createHash("sha256")
    .update(absolutePath)
    .update("|")
    .update(String(mtimeMs))
    .update("|")
    .update(String(size))
    .digest("hex");
}

/** Carpeta donde se guardan los PDF generados por LibreOffice para `vista=pdf` (caché por hash del origen). */
export function comprasmxOfficePdfCacheDir(): string {
  const fromEnv = process.env.COMPRASMX_OFFICE_PDF_CACHE_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), "comprasmx-office-pdf-cache");
}

function maxBytes(): number {
  const raw = process.env.COMPRASMX_OFFICE_PDF_MAX_BYTES?.trim();
  const n = raw ? parseInt(raw, 10) : 45 * 1024 * 1024;
  if (!Number.isFinite(n) || n < 1_000_000) return 45 * 1024 * 1024;
  return Math.min(n, 120 * 1024 * 1024);
}

function timeoutMs(): number {
  const raw = process.env.COMPRASMX_OFFICE_PDF_TIMEOUT_MS?.trim();
  const n = raw ? parseInt(raw, 10) : 300_000;
  if (!Number.isFinite(n) || n < 10_000) return 300_000;
  return Math.min(n, 900_000);
}

/** Cola por archivo en caché: evita varias conversiones simultáneas del mismo origen (y condiciones de carrera). */
const convertQueuePorCachePath = new Map<string, Promise<unknown>>();

function enqueueConversionPdf<T>(cachePath: string, work: () => Promise<T>): Promise<T> {
  const prev = convertQueuePorCachePath.get(cachePath) ?? Promise.resolve();
  const next = (prev.catch(() => {}) as Promise<void>).then(() => work()) as Promise<T>;
  convertQueuePorCachePath.set(cachePath, next);
  void next.finally(() => {
    if (convertQueuePorCachePath.get(cachePath) === next) convertQueuePorCachePath.delete(cachePath);
  });
  return next;
}

function sofficeBin(): string {
  return process.env.LIBREOFFICE_SOFFICE?.trim() || "soffice";
}

async function runSofficeConvertPdf(inputAbs: string, outDir: string): Promise<void> {
  const bin = sofficeBin();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      bin,
      [
        "--headless",
        "--norestore",
        "--nologo",
        "--nodefault",
        "--convert-to",
        "pdf",
        "--outdir",
        outDir,
        inputAbs,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stderr = "";
    child.stderr?.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    const t = setTimeout(() => {
      child.kill("SIGKILL");
    }, timeoutMs());
    child.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(t);
      if (err.code === "ENOENT") {
        reject(
          new Error(
            "LibreOffice (`soffice`) no está instalado o no está en PATH. Define LIBREOFFICE_SOFFICE en .env.",
          ),
        );
        return;
      }
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(t);
      if (code === 0) resolve();
      else reject(new Error(`LibreOffice (${bin}) terminó con código ${code}. ${stderr.slice(0, 800)}`));
    });
  });
}

/**
 * Devuelve la ruta absoluta de un PDF listo para enviar al cliente (caché o conversión con LibreOffice).
 * Requiere `soffice` en PATH o `LIBREOFFICE_SOFFICE` apuntando al binario.
 */
export async function resolverPdfVistaPrevia(absoluteOrigen: string): Promise<string> {
  const ext = extDeNombreArchivo(absoluteOrigen);
  if (ext === "pdf") {
    throw new Error("Los PDF no se convierten; sirve el archivo original con la URL sin vista=pdf.");
  }
  if (!EXT_CONVERTIBLES.has(ext)) {
    throw new Error("Este formato no está soportado para conversión a PDF.");
  }

  const st = await fs.stat(absoluteOrigen);
  if (!st.isFile()) throw new Error("La ruta de origen no es un archivo.");
  if (st.size > maxBytes()) {
    throw new Error(`Archivo demasiado grande para convertir (>${maxBytes()} bytes).`);
  }

  const dir = comprasmxOfficePdfCacheDir();
  const key = `${hashCacheKey(absoluteOrigen, st.mtimeMs, st.size)}.pdf`;
  const cached = path.join(dir, key);
  try {
    const cs = await fs.stat(cached);
    if (cs.isFile() && cs.size > 0) return cached;
  } catch {
    /* generar */
  }

  return enqueueConversionPdf(cached, async () => {
    const csHit = await fs.stat(cached).catch(() => null);
    if (csHit?.isFile() && csHit.size > 0) return cached;

    await fs.mkdir(dir, { recursive: true });
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "cmx-soffice-"));
    try {
      await runSofficeConvertPdf(absoluteOrigen, tmp);
      const { name: stem } = path.parse(absoluteOrigen);
      const generado = path.join(tmp, `${stem}.pdf`);
      await fs.access(generado);
      await fs.copyFile(generado, cached);
      return cached;
    } finally {
      await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
    }
  });
}
