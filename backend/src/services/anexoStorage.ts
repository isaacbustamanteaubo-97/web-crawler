import { createGunzip } from "node:zlib";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import {
  deleteAllUnderRootFolder,
  downloadDriveFileToPath,
  findManifestEntry,
  getDriveFileReadStream,
  isGoogleDriveConfigured,
  listManifestEntries,
  uploadAnexoToDrive,
} from "./driveStorage.js";
import { esArchivoZip, extraerZipAnexosHabilitado, extraerZipEnDirectorio } from "./zipAnexo.js";

export { esArchivoZip } from "./zipAnexo.js";

export function filtrarDocumentosVisibles(documentos: ComprasmxDocumentoInfo[]): ComprasmxDocumentoInfo[] {
  return documentos.filter((d) => !esArchivoZip(d.nombre));
}

export type ComprasmxDocumentoInfo = {
  nombre: string;
  sizeBytes: number;
  modificadoIso: string;
  /** Presente cuando el anexo está en Google Drive. */
  driveFileId?: string;
};

export function mimePorNombreArchivo(nombre: string): string {
  const ext = path.extname(nombre).toLowerCase();
  if (ext === ".pdf") return "application/pdf";
  if (ext === ".zip") return "application/zip";
  if (ext === ".xml") return "application/xml";
  if (ext === ".json") return "application/json";
  if (ext === ".csv") return "text/csv";
  if (ext === ".docx") return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  if (ext === ".xlsx") return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  if (ext === ".pptx") return "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  return "application/octet-stream";
}

export function expedienteParaNombreCarpeta(id: string): string {
  const s = id
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/_+/g, "_")
    .slice(0, 120);
  return s.length ? s : "sin-expediente";
}

export function comprasmxAnexosBaseDir(): string {
  const fromEnv = process.env.COMPRASMX_ANEXOS_DIR?.trim();
  if (fromEnv) return fromEnv;
  return path.join(process.cwd(), "comprasmx-anexos");
}

export function carpetaAbsolutaAnexosPorNumeroIdentificacion(numeroIdentificacion: string): string {
  const id = numeroIdentificacion.trim();
  return path.join(comprasmxAnexosBaseDir(), expedienteParaNombreCarpeta(id));
}

function rutaArchivoDentroDeCarpetaSeguro(dirAbs: string, nombreArchivo: string): string | null {
  const base = path.resolve(dirAbs);
  const safeName = path.basename(nombreArchivo.trim());
  if (!safeName || safeName.startsWith(".")) return null;
  const target = path.resolve(base, safeName);
  const rel = path.relative(base, target);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

async function listarDocumentosLocales(numeroIdentificacion: string): Promise<{
  numeroIdentificacion: string;
  carpetaEnDisco: string;
  total: number;
  documentos: ComprasmxDocumentoInfo[];
}> {
  const id = numeroIdentificacion.trim();
  if (!id) {
    return { numeroIdentificacion: "", carpetaEnDisco: "", total: 0, documentos: [] };
  }
  const carpeta = carpetaAbsolutaAnexosPorNumeroIdentificacion(id);
  let entries;
  try {
    entries = await fs.readdir(carpeta, { withFileTypes: true });
  } catch (e: unknown) {
    const code = e && typeof e === "object" && "code" in e ? String((e as NodeJS.ErrnoException).code) : "";
    if (code === "ENOENT") {
      return { numeroIdentificacion: id, carpetaEnDisco: carpeta, total: 0, documentos: [] };
    }
    throw e;
  }
  const documentos: ComprasmxDocumentoInfo[] = [];
  for (const ent of entries) {
    if (!ent.isFile() || ent.name.startsWith(".")) continue;
    const full = path.join(carpeta, ent.name);
    const st = await fs.stat(full);
    documentos.push({ nombre: ent.name, sizeBytes: st.size, modificadoIso: st.mtime.toISOString() });
  }
  documentos.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
  const visibles = filtrarDocumentosVisibles(documentos);
  return { numeroIdentificacion: id, carpetaEnDisco: carpeta, total: visibles.length, documentos: visibles };
}

async function resolverDocumentoLocal(
  numeroIdentificacion: string,
  nombreArchivo: string,
): Promise<{ absolutePath: string; mime: string; sizeBytes: number } | null> {
  const id = numeroIdentificacion.trim();
  if (!id) return null;
  const carpeta = carpetaAbsolutaAnexosPorNumeroIdentificacion(id);
  const target = rutaArchivoDentroDeCarpetaSeguro(carpeta, nombreArchivo);
  if (!target) return null;
  try {
    const st = await fs.stat(target);
    if (!st.isFile()) return null;
    return { absolutePath: target, mime: mimePorNombreArchivo(path.basename(target)), sizeBytes: st.size };
  } catch {
    return null;
  }
}

export type AlmacenAnexos = "local" | "drive";

export type ComprasmxDocumentoResuelto = {
  nombre: string;
  mime: string;
  sizeBytes: number;
  storage: AlmacenAnexos;
  absolutePath?: string;
  driveFileId?: string;
  compressed?: boolean;
};

export function almacenAnexosActivo(): AlmacenAnexos {
  return isGoogleDriveConfigured() ? "drive" : "local";
}

export function driveCompressEnabled(): boolean {
  return process.env.COMPRASMX_DRIVE_COMPRESS === "1";
}

export function comprasmxDriveTempDir(): string {
  const fromEnv = process.env.COMPRASMX_DRIVE_TEMP_DIR?.trim();
  if (fromEnv) return path.resolve(fromEnv);
  return path.join(os.tmpdir(), "comprasmx-upload");
}

export async function listarDocumentosComprasmx(numeroIdentificacion: string): Promise<{
  numeroIdentificacion: string;
  almacenamiento: AlmacenAnexos;
  ubicacion: string;
  total: number;
  documentos: ComprasmxDocumentoInfo[];
}> {
  const id = numeroIdentificacion.trim();
  if (!id) {
    return { numeroIdentificacion: "", almacenamiento: almacenAnexosActivo(), ubicacion: "", total: 0, documentos: [] };
  }

  if (almacenAnexosActivo() === "drive") {
    const folderName = expedienteParaNombreCarpeta(id);
    const { folderId, entries } = await listManifestEntries(folderName);
    const documentos = filtrarDocumentosVisibles(
      entries.map((e) => ({
        nombre: e.nombre,
        sizeBytes: e.sizeBytes,
        modificadoIso: e.uploadedAt,
        driveFileId: e.driveFileId,
      })),
    );
    return {
      numeroIdentificacion: id,
      almacenamiento: "drive",
      ubicacion: folderId ? `drive:${folderId}` : `drive:root/${folderName}`,
      total: documentos.length,
      documentos,
    };
  }

  const local = await listarDocumentosLocales(id);
  return {
    numeroIdentificacion: local.numeroIdentificacion,
    almacenamiento: "local",
    ubicacion: local.carpetaEnDisco,
    total: local.total,
    documentos: local.documentos,
  };
}

export async function resolverDocumentoComprasmx(
  numeroIdentificacion: string,
  nombreArchivo: string,
): Promise<ComprasmxDocumentoResuelto | null> {
  const id = numeroIdentificacion.trim();
  const nombre = path.basename(nombreArchivo.trim());
  if (!id || !nombre) return null;

  if (almacenAnexosActivo() === "drive") {
    const folderName = expedienteParaNombreCarpeta(id);
    const entry = await findManifestEntry(folderName, nombre);
    if (!entry) return null;
    return {
      nombre: entry.nombre,
      mime: mimePorNombreArchivo(entry.nombre),
      sizeBytes: entry.sizeBytes,
      storage: "drive",
      driveFileId: entry.driveFileId,
      compressed: entry.compressed,
    };
  }

  const local = await resolverDocumentoLocal(id, nombre);
  if (!local) return null;
  return {
    nombre,
    mime: local.mime,
    sizeBytes: local.sizeBytes,
    storage: "local",
    absolutePath: local.absolutePath,
    compressed: false,
  };
}

/**
 * Si el archivo descargado es `.zip`, lo expande en `destDir` y elimina el zip.
 * Devuelve las rutas a persistir (una o varias).
 */
export async function materializarArchivosTrasDescarga(
  localPath: string,
  destDir: string,
  filePrefix: string,
): Promise<string[]> {
  if (!extraerZipAnexosHabilitado() || !esArchivoZip(localPath)) {
    return [localPath];
  }
  const extraidos = await extraerZipEnDirectorio(localPath, destDir, filePrefix);
  await fs.rm(localPath, { force: true }).catch(() => {});
  if (extraidos.length === 0) {
    console.warn(`[comprasmx] ZIP sin archivos útiles: ${path.basename(localPath)}`);
    return [];
  }
  console.log(
    `[comprasmx] ZIP extraído (${path.basename(localPath)}): ${extraidos.length} archivo(s)`,
  );
  return extraidos;
}

export async function persistirAnexoDescargado(opts: {
  localPath: string;
  numeroIdentificacion: string;
  nombreEnDisco: string;
}): Promise<{ storage: AlmacenAnexos; archivoLocal?: string; driveFileId?: string; nombreArchivo: string }> {
  if (almacenAnexosActivo() === "drive") {
    try {
      const folderName = expedienteParaNombreCarpeta(opts.numeroIdentificacion);
      const entry = await uploadAnexoToDrive({
        expedienteFolderName: folderName,
        numeroIdentificacion: opts.numeroIdentificacion,
        localPath: opts.localPath,
        nombreLogico: opts.nombreEnDisco,
        compress: driveCompressEnabled(),
      });
      await fs.rm(opts.localPath, { force: true }).catch(() => {});
      return {
        storage: "drive",
        driveFileId: entry.driveFileId,
        nombreArchivo: entry.nombre,
      };
    } catch (err) {
      console.error(
        `[comprasmx] Error subiendo anexo a Drive (${opts.nombreEnDisco}); se conserva copia local:`,
        err,
      );
      return {
        storage: "local",
        archivoLocal: opts.localPath,
        nombreArchivo: opts.nombreEnDisco,
      };
    }
  }

  return {
    storage: "local",
    archivoLocal: opts.localPath,
    nombreArchivo: opts.nombreEnDisco,
  };
}

export async function crearReadStreamDocumento(meta: ComprasmxDocumentoResuelto): Promise<Readable> {
  if (meta.storage === "local") {
    if (!meta.absolutePath) throw new Error("Ruta local ausente.");
    return createReadStream(meta.absolutePath);
  }
  if (!meta.driveFileId) throw new Error("driveFileId ausente.");
  const raw = await getDriveFileReadStream(meta.driveFileId);
  if (meta.compressed) return raw.pipe(createGunzip());
  return raw;
}

/** Materializa el documento en disco temporal (p. ej. LibreOffice `vista=pdf`). */
export async function materializarDocumentoATemp(meta: ComprasmxDocumentoResuelto): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "cmx-doc-"));
  const dest = path.join(tmpDir, path.basename(meta.nombre));
  if (meta.storage === "local") {
    if (!meta.absolutePath) throw new Error("Ruta local ausente.");
    await fs.copyFile(meta.absolutePath, dest);
    return dest;
  }
  if (!meta.driveFileId) throw new Error("driveFileId ausente.");
  await downloadDriveFileToPath(meta.driveFileId, dest, Boolean(meta.compressed));
  return dest;
}

export async function vaciarAlmacenAnexosComprasmx(): Promise<{ eliminados: number; base: string }> {
  if (almacenAnexosActivo() === "drive") {
    return deleteAllUnderRootFolder();
  }
  const base = path.resolve(comprasmxAnexosBaseDir());
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
    await fs.rm(path.join(base, ent.name), { recursive: true, force: true });
    eliminados += 1;
  }
  return { eliminados, base };
}

/** Carpeta temporal para sesión de descargas Playwright (no persiste en Drive). */
export async function carpetaTempDescargaAnexos(numeroIdentificacion: string): Promise<string> {
  const dir = path.join(comprasmxDriveTempDir(), expedienteParaNombreCarpeta(numeroIdentificacion));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/** @deprecated Usar listarDocumentosComprasmx; expone carpetaEnDisco para compatibilidad de rutas. */
export async function listarDocumentosConUbicacion(numeroIdentificacion: string): Promise<{
  numeroIdentificacion: string;
  carpetaEnDisco: string;
  total: number;
  documentos: ComprasmxDocumentoInfo[];
}> {
  const listed = await listarDocumentosComprasmx(numeroIdentificacion);
  const carpetaEnDisco =
    listed.almacenamiento === "local"
      ? carpetaAbsolutaAnexosPorNumeroIdentificacion(numeroIdentificacion)
      : listed.ubicacion;
  return {
    numeroIdentificacion: listed.numeroIdentificacion,
    carpetaEnDisco,
    total: listed.total,
    documentos: listed.documentos,
  };
}
