import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import type { ComprasmxSnapshot } from "./comprasmx.js";
import { ensureExpedienteFolder, getDriveClient, isGoogleDriveConfigured } from "./driveStorage.js";

const SNAPSHOTS_FOLDER_NAME = "_comprasmx_snapshots";
const INDEX_FILE_NAME = "_index.json";

export type SnapshotPersistedMeta = {
  id: string;
  savedAt: string;
  serverFetchedAt?: string;
  resumen: string;
  totalFilas: number;
};

export type SnapshotPersistedRecord = SnapshotPersistedMeta & {
  payload: ComprasmxSnapshot;
};

type IndexShape = {
  version: 1;
  entries: SnapshotPersistedMeta[];
};

function snapshotsMax(): number {
  const raw = process.env.COMPRASMX_SNAPSHOTS_MAX?.trim();
  const n = raw ? parseInt(raw, 10) : 24;
  if (!Number.isFinite(n) || n < 1) return 24;
  return Math.min(n, 200);
}

function assertDriveConfigured(): void {
  if (!isGoogleDriveConfigured()) {
    throw new Error(
      "Persistencia de snapshots requiere Google Drive (GOOGLE_DRIVE_ENABLED=1, credenciales y GOOGLE_DRIVE_ROOT_FOLDER_ID).",
    );
  }
}

function resumenDesdeSnapshot(s: ComprasmxSnapshot): string {
  const filas = s.filas?.length ?? 0;
  const desde = s.filtros?.fechaPublicacionDesde?.trim() ?? "";
  const hasta = s.filtros?.fechaPublicacionHasta?.trim() ?? "";
  const fechas =
    desde && hasta && desde !== hasta ? `${desde} → ${hasta}` : desde || hasta || "fecha ?";
  return `${fechas} · ${filas} expediente(s)`;
}

function metaFromPayload(id: string, savedAt: string, payload: ComprasmxSnapshot): SnapshotPersistedMeta {
  return {
    id,
    savedAt,
    serverFetchedAt: payload.fetchedAt,
    resumen: resumenDesdeSnapshot(payload),
    totalFilas: payload.totalFilas ?? payload.filas?.length ?? 0,
  };
}

async function snapshotsFolderIdDrive(): Promise<string> {
  return ensureExpedienteFolder(SNAPSHOTS_FOLDER_NAME);
}

async function readIndexDrive(folderId: string): Promise<IndexShape> {
  const drive = await getDriveClient();
  const q = `name='${INDEX_FILE_NAME.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const fileId = list.data.files?.[0]?.id;
  if (!fileId) return { version: 1, entries: [] };
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" },
  );
  const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
  try {
    const j = JSON.parse(text) as IndexShape;
    if (j?.version === 1 && Array.isArray(j.entries)) return j;
  } catch {
    /* ignore */
  }
  return { version: 1, entries: [] };
}

async function writeIndexDrive(folderId: string, index: IndexShape): Promise<void> {
  const drive = await getDriveClient();
  const body = JSON.stringify(index, null, 2);
  const q = `name='${INDEX_FILE_NAME.replace(/'/g, "\\'")}' and '${folderId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const existingId = list.data.files?.[0]?.id;
  if (existingId) {
    await drive.files.update({
      fileId: existingId,
      media: { mimeType: "application/json", body },
      supportsAllDrives: true,
    });
    return;
  }
  await drive.files.create({
    requestBody: { name: INDEX_FILE_NAME, parents: [folderId] },
    media: { mimeType: "application/json", body },
    fields: "id",
    supportsAllDrives: true,
  });
}

function trimIndex(entries: SnapshotPersistedMeta[]): SnapshotPersistedMeta[] {
  const max = snapshotsMax();
  return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt)).slice(0, max);
}

/** Guarda el JSON de respuesta del snapshot en Google Drive (`_comprasmx_snapshots/`). */
export async function persistSnapshotResponse(payload: ComprasmxSnapshot): Promise<string> {
  assertDriveConfigured();
  const id = randomUUID();
  const savedAt = new Date().toISOString();
  const meta = metaFromPayload(id, savedAt, payload);
  const record: SnapshotPersistedRecord = { ...meta, payload };

  const folderId = await snapshotsFolderIdDrive();
  const drive = await getDriveClient();
  const jsonBody = Readable.from(Buffer.from(JSON.stringify(record), "utf8"));

  await drive.files.create({
    requestBody: { name: `${id}.json`, parents: [folderId] },
    media: { mimeType: "application/json", body: jsonBody },
    fields: "id",
    supportsAllDrives: true,
  });

  const index = await readIndexDrive(folderId);
  index.entries = trimIndex([meta, ...index.entries.filter((e) => e.id !== id)]);
  await writeIndexDrive(folderId, index);
  return id;
}

export function snapshotsPersistenceAvailable(): boolean {
  return isGoogleDriveConfigured();
}

/** Lista metadatos de snapshots guardados en Drive. */
export async function listPersistedSnapshots(): Promise<SnapshotPersistedMeta[]> {
  if (!isGoogleDriveConfigured()) return [];
  const folderId = await snapshotsFolderIdDrive();
  const index = await readIndexDrive(folderId);
  return index.entries;
}

/** Recupera el JSON completo de un snapshot por id. */
export async function getPersistedSnapshot(id: string): Promise<SnapshotPersistedRecord | null> {
  if (!isGoogleDriveConfigured()) return null;
  const safe = id.trim();
  if (!safe || !/^[0-9a-f-]{36}$/i.test(safe)) return null;

  const folderId = await snapshotsFolderIdDrive();
  const drive = await getDriveClient();
  const q = `name='${safe}.json' and '${folderId}' in parents and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const fileId = list.data.files?.[0]?.id;
  if (!fileId) return null;
  const res = await drive.files.get(
    { fileId, alt: "media", supportsAllDrives: true },
    { responseType: "text" },
  );
  const text = typeof res.data === "string" ? res.data : String(res.data ?? "");
  try {
    return JSON.parse(text) as SnapshotPersistedRecord;
  } catch {
    return null;
  }
}

/** Vacía la carpeta de snapshots en Drive (también se borra con la limpieza de la raíz de anexos). */
export async function vaciarSnapshotsPersistidos(): Promise<{ eliminados: number; base: string }> {
  if (!isGoogleDriveConfigured()) {
    return { eliminados: 0, base: "drive:no-config" };
  }
  const root = process.env.GOOGLE_DRIVE_ROOT_FOLDER_ID?.trim();
  if (!root) return { eliminados: 0, base: "drive:?" };

  const drive = await getDriveClient();
  const q = `name='${SNAPSHOTS_FOLDER_NAME.replace(/'/g, "\\'")}' and '${root}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`;
  const list = await drive.files.list({
    q,
    fields: "files(id)",
    pageSize: 1,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  const folderId = list.data.files?.[0]?.id;
  if (!folderId) return { eliminados: 0, base: `drive:${root}/${SNAPSHOTS_FOLDER_NAME}` };

  let eliminados = 0;
  let pageToken: string | undefined;
  do {
    const children = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "nextPageToken, files(id)",
      pageSize: 100,
      pageToken,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    for (const f of children.data.files ?? []) {
      if (!f.id) continue;
      await drive.files.delete({ fileId: f.id, supportsAllDrives: true });
      eliminados += 1;
    }
    pageToken = children.data.nextPageToken ?? undefined;
  } while (pageToken);

  return { eliminados, base: `drive:${folderId}` };
}
