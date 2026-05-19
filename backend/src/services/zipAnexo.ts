import fs from "node:fs/promises";
import path from "node:path";
import AdmZip from "adm-zip";

export function esArchivoZip(nombre: string): boolean {
  return path.extname(nombre).toLowerCase() === ".zip";
}

export function extraerZipAnexosHabilitado(): boolean {
  return process.env.COMPRASMX_EXTRACT_ZIP !== "0";
}

/** Nombre de archivo seguro dentro del ZIP (evita zip-slip). */
export function nombreSeguroEntradaZip(entryName: string): string | null {
  const normalized = entryName.replace(/\\/g, "/");
  if (!normalized || normalized.includes("..")) return null;
  const base = path.basename(normalized);
  if (!base || base.startsWith(".")) return null;
  return base.replace(/[/\\]/g, "_");
}

/**
 * Extrae un `.zip` descargado de Compras MX en `destDir` con prefijo `filePrefix`.
 * Devuelve rutas absolutas de los archivos extraídos (sin carpetas vacías).
 */
export async function extraerZipEnDirectorio(
  zipPath: string,
  destDir: string,
  filePrefix: string,
): Promise<string[]> {
  const zip = new AdmZip(zipPath);
  const written: string[] = [];
  const usedNames = new Set<string>();

  await fs.mkdir(destDir, { recursive: true });

  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;
    const safe = nombreSeguroEntradaZip(entry.entryName);
    if (!safe) continue;

    let diskName = `${filePrefix}_${safe}`;
    if (usedNames.has(diskName)) {
      const ext = path.extname(safe);
      const stem = path.basename(safe, ext) || "archivo";
      let n = 2;
      do {
        diskName = `${filePrefix}_${stem}_${n}${ext}`;
        n += 1;
      } while (usedNames.has(diskName));
    }
    usedNames.add(diskName);

    const abs = path.join(destDir, diskName);
    await fs.writeFile(abs, entry.getData());
    written.push(abs);
  }

  return written;
}
