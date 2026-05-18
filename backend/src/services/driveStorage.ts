import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip, createGzip } from "node:zlib";
import { google, type drive_v3 } from "googleapis";
import { resolveGoogleCredentialsPath } from "../loadEnv.js";

export const MANIFEST_DRIVE_NAME = "_comprasmx_manifest.json";

export type DriveManifestEntry = {
  nombre: string;
  driveFileId: string;
  storedName: string;
  sizeBytes: number;
  compressed: boolean;
  uploadedAt: string;
};

export type DriveManifest = {
  version: 1;
  numeroIdentificacion: string;
  entries: DriveManifestEntry[];
};

let driveClient: drive_v3.Drive | null = null;

function oauthRefreshConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_OAUTH_CLIENT_ID?.trim() &&
      process.env.GOOGLE_OAUTH_CLIENT_SECRET?.trim() &&
      process.env.GOOGLE_OAUTH_REFRESH_TOKEN?.trim(),
  );
}

export function driveAuthMode(): "oauth" | "service_account" | "none" {
  if (process.env.GOOGLE_DRIVE_ENABLED !== "1") return "none";
  if (!process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim()) return "none";
  if (oauthRefreshConfigured()) return "oauth";
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS?.trim() || process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim()) {
    return "service_account";
  }
  return "none";
}

export function isGoogleDriveConfigured(): boolean {
  return driveAuthMode() !== "none";
}

function rootFolderId(): string {
  const id = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
  if (!id) throw new Error("GOOGLE_DRIVE_ROOT_FOLDER_ID no definido.");
  return id;
}

function escapeDriveQueryString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

async function loadServiceAccountCredentials(): Promise<{
  client_email: string;
  private_key: string;
}> {
  const jsonInline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON?.trim();
  if (jsonInline) {
    const c = JSON.parse(jsonInline) as { client_email?: string; private_key?: string };
    if (!c.client_email || !c.private_key) throw new Error("JSON de cuenta de servicio incompleto.");
    return { client_email: c.client_email, private_key: c.private_key };
  }
  const keyFile = resolveGoogleCredentialsPath();
  if (!keyFile) {
    throw new Error(
      "Credenciales Google: define GOOGLE_OAUTH_* (recomendado Gmail) o GOOGLE_APPLICATION_CREDENTIALS.",
    );
  }
  await fs.access(keyFile);
  const raw = await fs.readFile(keyFile, "utf8");
  const c = JSON.parse(raw) as { client_email?: string; private_key?: string };
  if (!c.client_email || !c.private_key) throw new Error("JSON de cuenta de servicio incompleto.");
  return { client_email: c.client_email, private_key: c.private_key };
}

async function buildAuth() {
  if (oauthRefreshConfigured()) {
    const { OAuth2Client } = await import("google-auth-library");
    const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID!.trim();
    const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET!.trim();
    const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN!.trim();
    const redirect =
      process.env.GOOGLE_OAUTH_REDIRECT_URI?.trim() || "http://127.0.0.1:53682/oauth2callback";
    const oauth2 = new OAuth2Client(clientId, clientSecret, redirect);
    oauth2.setCredentials({ refresh_token: refreshToken });
    return oauth2;
  }

  const { client_email, private_key } = await loadServiceAccountCredentials();
  const subject = process.env.GOOGLE_DRIVE_IMPERSONATE_USER?.trim();
  if (subject) {
    return new google.auth.JWT({
      email: client_email,
      key: private_key,
      scopes: ["https://www.googleapis.com/auth/drive"],
      subject,
    });
  }

  return new google.auth.GoogleAuth({
    credentials: { client_email, private_key },
    scopes: ["https://www.googleapis.com/auth/drive"],
  });
}

export async function getDriveClient(): Promise<drive_v3.Drive> {
  if (driveClient) return driveClient;
  const auth = await buildAuth();
  driveClient = google.drive({ version: "v3", auth });
  return driveClient;
}

async function findChildFolder(parentId: string, folderName: string): Promise<string | null> {
  const drive = await getDriveClient();
  const q = `name='${escapeDriveQueryString(folderName)}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

async function findChildFile(parentId: string, fileName: string): Promise<string | null> {
  const drive = await getDriveClient();
  const q = `name='${escapeDriveQueryString(fileName)}' and '${parentId}' in parents and mimeType!='application/vnd.google-apps.folder' and trashed=false`;
  const res = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  return res.data.files?.[0]?.id ?? null;
}

export async function ensureExpedienteFolder(expedienteFolderName: string): Promise<string> {
  const root = rootFolderId();
  const existing = await findChildFolder(root, expedienteFolderName);
  if (existing) return existing;

  const drive = await getDriveClient();
  const created = await drive.files.create({
    requestBody: {
      name: expedienteFolderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [root],
    },
    fields: "id",
    supportsAllDrives: true,
  });
  const id = created.data.id;
  if (!id) throw new Error("No se pudo crear carpeta de expediente en Drive.");
  return id;
}

export async function readManifest(folderId: string): Promise<DriveManifest | null> {
  const manifestFileId = await findChildFile(folderId, MANIFEST_DRIVE_NAME);
  if (!manifestFileId) return null;

  const drive = await getDriveClient();
  const res = await drive.files.get(
    { fileId: manifestFileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" },
  );
  const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
  try {
    return JSON.parse(text) as DriveManifest;
  } catch {
    return null;
  }
}

async function writeManifest(folderId: string, manifest: DriveManifest): Promise<void> {
  const drive = await getDriveClient();
  const body = JSON.stringify(manifest, null, 2);
  const existingId = await findChildFile(folderId, MANIFEST_DRIVE_NAME);

  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: "application/json", body },
      supportsAllDrives: true,
    });
    return;
  }

  await drive.files.create({
    requestBody: {
      name: MANIFEST_DRIVE_NAME,
      parents: [folderId],
    },
    media: { mimeType: "application/json", body },
    fields: "id",
    supportsAllDrives: true,
  });
}

export async function uploadAnexoToDrive(opts: {
  expedienteFolderName: string;
  numeroIdentificacion: string;
  localPath: string;
  nombreLogico: string;
  compress: boolean;
}): Promise<DriveManifestEntry> {
  const folderId = await ensureExpedienteFolder(opts.expedienteFolderName);
  const st = await fs.stat(opts.localPath);
  if (!st.isFile()) throw new Error("Ruta de subida no es un archivo.");

  let uploadPath = opts.localPath;
  let storedName = opts.nombreLogico;
  let compressed = false;
  const tempGz = `${opts.localPath}.upload.gz`;

  try {
    if (opts.compress) {
      await pipeline(createReadStream(opts.localPath), createGzip({ level: 6 }), createWriteStream(tempGz));
      uploadPath = tempGz;
      storedName = `${opts.nombreLogico}.gz`;
      compressed = true;
    }

    const drive = await getDriveClient();
    const created = await drive.files.create({
      requestBody: {
        name: storedName,
        parents: [folderId],
      },
      media: {
        mimeType: compressed ? "application/gzip" : "application/octet-stream",
        body: createReadStream(uploadPath),
      },
      fields: "id, size, modifiedTime",
      supportsAllDrives: true,
    });

    const fileId = created.data.id;
    if (!fileId) throw new Error("Drive no devolvió id de archivo subido.");

    const entry: DriveManifestEntry = {
      nombre: opts.nombreLogico,
      driveFileId: fileId,
      storedName,
      sizeBytes: st.size,
      compressed,
      uploadedAt: new Date().toISOString(),
    };

    const manifest =
      (await readManifest(folderId)) ??
      ({
        version: 1,
        numeroIdentificacion: opts.numeroIdentificacion,
        entries: [],
      } satisfies DriveManifest);

    manifest.numeroIdentificacion = opts.numeroIdentificacion;
    const idx = manifest.entries.findIndex((e) => e.nombre === opts.nombreLogico);
    if (idx >= 0) manifest.entries[idx] = entry;
    else manifest.entries.push(entry);
    manifest.entries.sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));

    await writeManifest(folderId, manifest);
    return entry;
  } finally {
    await fs.rm(tempGz, { force: true }).catch(() => {});
  }
}

export async function listManifestEntries(expedienteFolderName: string): Promise<{
  folderId: string | null;
  entries: DriveManifestEntry[];
}> {
  const root = rootFolderId();
  const folderId = await findChildFolder(root, expedienteFolderName);
  if (!folderId) return { folderId: null, entries: [] };
  const manifest = await readManifest(folderId);
  return { folderId, entries: manifest?.entries ?? [] };
}

export async function findManifestEntry(
  expedienteFolderName: string,
  nombreLogico: string,
): Promise<(DriveManifestEntry & { folderId: string }) | null> {
  const { folderId, entries } = await listManifestEntries(expedienteFolderName);
  if (!folderId) return null;
  const entry = entries.find((e) => e.nombre === nombreLogico);
  if (!entry) return null;
  return { ...entry, folderId };
}

export async function getDriveFileReadStream(fileId: string): Promise<Readable> {
  const drive = await getDriveClient();
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "stream" },
  );
  const stream = res.data as Readable;
  if (!stream || typeof stream.pipe !== "function") {
    throw new Error("Respuesta de Drive sin stream.");
  }
  return stream;
}

export async function downloadDriveFileToPath(fileId: string, destPath: string, gunzip: boolean): Promise<void> {
  const raw = await getDriveFileReadStream(fileId);
  if (gunzip) {
    await pipeline(raw, createGunzip(), createWriteStream(destPath));
  } else {
    await pipeline(raw, createWriteStream(destPath));
  }
}

export async function deleteAllUnderRootFolder(): Promise<{ eliminados: number; base: string }> {
  const root = rootFolderId();
  const drive = await getDriveClient();
  let eliminados = 0;
  let pageToken: string | undefined;

  do {
    const list = await drive.files.list({
      q: `'${root}' in parents and trashed=false`,
      fields: "nextPageToken, files(id)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of list.data.files ?? []) {
      if (!f.id) continue;
      await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
      eliminados += 1;
    }
    pageToken = list.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { eliminados, base: `drive:${root}` };
}
