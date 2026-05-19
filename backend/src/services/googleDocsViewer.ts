import { esNombreArchivoConvertibleVistaPdf } from "./officePdfPreview.js";
import { signArchivoViewerToken } from "./archivoViewerToken.js";

export type GoogleDocsViewerEmbedModo = "drive-preview" | "gview";

export type GoogleDocsViewerUrls = {
  embedUrl: string;
  embedModo: GoogleDocsViewerEmbedModo;
  /** Misma URL en pestaña nueva (Drive) o enlace gview si aplica. */
  alternativaDrivePreview?: string;
  aviso?: string;
};

export function googleDocsViewerHabilitado(): boolean {
  return process.env.COMPRASMX_GOOGLE_DOCS_VIEWER === "1";
}

export function publicApiOrigin(): string | null {
  const raw = process.env.COMPRASMX_PUBLIC_API_URL?.trim();
  if (!raw) return null;
  return raw.replace(/\/$/, "");
}

/** URL absoluta del archivo para que los servidores de Google la descarguen. */
export function buildPublicArchivoUrl(opts: {
  apiOrigin: string;
  basePath: string;
  numeroIdentificacion: string;
  nombre: string;
}): string | null {
  const token = signArchivoViewerToken(opts.numeroIdentificacion, opts.nombre);
  if (!token) return null;
  const q = new URLSearchParams({
    numeroIdentificacion: opts.numeroIdentificacion,
    nombre: opts.nombre,
    viewerToken: token,
  });
  const base = opts.basePath.startsWith("/") ? opts.basePath : `/${opts.basePath}`;
  return `${opts.apiOrigin}${base}/documentos/archivo?${q.toString()}`;
}

export function buildGoogleDocsGviewEmbedUrl(fileUrl: string): string {
  return `https://docs.google.com/gview?url=${encodeURIComponent(fileUrl)}&embedded=true`;
}

export function buildDriveFilePreviewUrl(driveFileId: string): string {
  return `https://drive.google.com/file/d/${driveFileId.trim()}/preview`;
}

/**
 * Word, Excel, PowerPoint, etc.
 * - Archivos en Drive (OAuth): vista previa nativa de Drive en iframe (misma sesión de Google).
 * - Con `COMPRASMX_PUBLIC_API_URL`: Google Docs Viewer (gview) contra URL pública del API.
 */
export function resolverUrlsGoogleDocsViewer(opts: {
  nombreArchivo: string;
  numeroIdentificacion: string;
  driveFileId?: string;
  publicArchivoUrl?: string | null;
}): GoogleDocsViewerUrls | null {
  if (!googleDocsViewerHabilitado()) return null;
  if (!esNombreArchivoConvertibleVistaPdf(opts.nombreArchivo)) return null;

  const publicUrl = opts.publicArchivoUrl?.trim() || null;
  const driveId = opts.driveFileId?.trim() || "";

  if (publicUrl) {
    return {
      embedUrl: buildGoogleDocsGviewEmbedUrl(publicUrl),
      embedModo: "gview",
      alternativaDrivePreview: driveId ? buildDriveFilePreviewUrl(driveId) : undefined,
    };
  }

  if (driveId) {
    const preview = buildDriveFilePreviewUrl(driveId);
    return {
      embedUrl: preview,
      embedModo: "drive-preview",
      alternativaDrivePreview: preview,
      aviso:
        "Vista en Google Drive. Inicia sesión en el navegador con la misma cuenta de Google que autorizaste en OAuth.",
    };
  }

  return null;
}
