import fs from "node:fs/promises";
import path from "node:path";
import cron from "node-cron";
import { vaciarAlmacenAnexosComprasmx } from "../services/anexoStorage.js";
import { comprasmxOfficePdfCacheDir } from "../services/officePdfPreview.js";
import { vaciarSnapshotsPersistidos } from "../services/snapshotPersistence.js";

function hijoDentroDeBase(baseResuelto: string, nombreEntrada: string): string | null {
  const segmentos = path.normalize(nombreEntrada).split(path.sep).filter(Boolean);
  if (segmentos.some((s) => s === "..")) return null;
  const full = path.resolve(baseResuelto, nombreEntrada);
  const prefijo = baseResuelto.endsWith(path.sep) ? baseResuelto : `${baseResuelto}${path.sep}`;
  if (full !== baseResuelto && !full.startsWith(prefijo)) return null;
  return full;
}

async function vaciarContenidoDirectorioResuelto(base: string): Promise<{ eliminados: number; base: string }> {
  let entries;
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") return { eliminados: 0, base };
    throw e;
  }

  let eliminados = 0;
  for (const ent of entries) {
    const full = hijoDentroDeBase(base, ent.name);
    if (!full) continue;
    await fs.rm(full, { recursive: true, force: true });
    eliminados += 1;
  }
  return { eliminados, base };
}

/** Borra anexos (Google Drive bajo raíz configurada, o carpeta local `COMPRASMX_ANEXOS_DIR`). */
export async function vaciarCarpetaAnexosComprasmx(): Promise<{ eliminados: number; base: string }> {
  return vaciarAlmacenAnexosComprasmx();
}

/** Borra PDFs en caché generados por LibreOffice para vista previa (`COMPRASMX_OFFICE_PDF_CACHE_DIR` / tmp). */
export async function vaciarCachePdfLibreOffice(): Promise<{ eliminados: number; base: string }> {
  return vaciarContenidoDirectorioResuelto(path.resolve(comprasmxOfficePdfCacheDir()));
}

/**
 * Programa limpieza diaria a medianoche: anexos descargados y caché de PDF de LibreOffice.
 *
 * - `COMPRASMX_MIDNIGHT_CLEANUP=0` — desactiva el job.
 * - `COMPRASMX_CLEANUP_TZ` — zona IANA (default `America/Mexico_City`).
 * - `COMPRASMX_CLEANUP_CRON` — expresión cron (default `0 0 * * *` = 00:00 cada día en esa zona).
 */
export function iniciarLimpiezaNocturnaAnexos(): void {
  if (process.env.COMPRASMX_MIDNIGHT_CLEANUP === "0") {
    console.log("[comprasmx] Limpieza nocturna desactivada (COMPRASMX_MIDNIGHT_CLEANUP=0).");
    return;
  }

  const tz = process.env.COMPRASMX_CLEANUP_TZ?.trim() || "America/Mexico_City";
  const pattern = process.env.COMPRASMX_CLEANUP_CRON?.trim() || "0 0 * * *";

  cron.schedule(
    pattern,
    () => {
      void (async () => {
        try {
          const anexos = await vaciarCarpetaAnexosComprasmx();
          console.log(
            `[comprasmx] Limpieza nocturna anexos: ${anexos.eliminados} elemento(s) bajo ${anexos.base}`,
          );
        } catch (err) {
          console.error("[comprasmx] Error limpiando anexos:", err);
        }
        try {
          const snaps = await vaciarSnapshotsPersistidos();
          if (snaps.eliminados > 0) {
            console.log(
              `[comprasmx] Limpieza nocturna snapshots JSON (Drive): ${snaps.eliminados} archivo(s) bajo ${snaps.base}`,
            );
          }
        } catch (err) {
          console.error("[comprasmx] Error limpiando snapshots en Drive:", err);
        }
        try {
          const pdf = await vaciarCachePdfLibreOffice();
          console.log(
            `[comprasmx] Limpieza nocturna caché PDF (LibreOffice): ${pdf.eliminados} elemento(s) bajo ${pdf.base}`,
          );
        } catch (err) {
          console.error("[comprasmx] Error limpiando caché PDF:", err);
        }
      })();
    },
    { timezone: tz },
  );

  console.log(
    `[comprasmx] Limpieza nocturna programada (anexos + caché PDF LibreOffice): cron "${pattern}" (${tz}). Desactivar: COMPRASMX_MIDNIGHT_CLEANUP=0`,
  );
}
