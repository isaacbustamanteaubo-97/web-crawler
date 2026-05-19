/**
 * Historial de snapshots Compras MX en localStorage (sin BD).
 * Incluye opcionalmente listas de documentos con URLs ya resueltas (proxy) por expediente.
 */

const STORAGE_KEY = "comprasmx.snapshotHistory.v1";
export const COMPRASMX_SNAPSHOT_HISTORY_MAX = 12;

export type HistorialDocumentoFila = {
  nombre: string;
  sizeBytes: number;
  modificadoIso: string;
  urlDescarga: string;
  urlVistaPdf?: string;
  urlVistaGoogle?: string;
  urlVistaGoogleDrive?: string;
  avisoVistaGoogle?: string;
};

export type ComprasmxHistoryEntry = {
  id: string;
  /** Cuando el cliente guardó la entrada. */
  storedAt: string;
  /** `fetchedAt` del payload del servidor, si existe. */
  serverFetchedAt?: string;
  /** Id del JSON en Google Drive (`GET /comprasmx/snapshots/:id`). */
  serverPersistId?: string;
  resumen: string;
  snapshotJson: unknown;
  documentosPorExpediente?: Record<string, HistorialDocumentoFila[]>;
};

type PersistedShape = { entries: ComprasmxHistoryEntry[] };

function readEntries(): ComprasmxHistoryEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as PersistedShape;
    return Array.isArray(p.entries) ? p.entries : [];
  } catch {
    return [];
  }
}

function writeEntries(entries: ComprasmxHistoryEntry[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ entries } satisfies PersistedShape));
    return true;
  } catch {
    return false;
  }
}

function resumenDesdePayload(snapshot: unknown): string {
  if (!snapshot || typeof snapshot !== "object") return "Snapshot";
  const o = snapshot as Record<string, unknown>;
  const filas = Array.isArray(o.filas) ? o.filas : [];
  const filtros = o.filtros && typeof o.filtros === "object" ? (o.filtros as Record<string, unknown>) : {};
  const desde =
    typeof filtros.fechaPublicacionDesde === "string" ? filtros.fechaPublicacionDesde.trim() : "";
  const hasta =
    typeof filtros.fechaPublicacionHasta === "string" ? filtros.fechaPublicacionHasta.trim() : "";
  const fechas =
    desde && hasta && desde !== hasta ? `${desde} → ${hasta}` : desde || hasta || "fecha ?";
  return `${fechas} · ${filas.length} expediente(s)`;
}

/**
 * Añade una entrada al inicio del historial. Si no cabe por cuota, recorta entradas viejas y reintenta.
 */
export function appendSnapshotHistoryEntry(
  snapshot: unknown,
  serverPersistId?: string,
): { ok: boolean; id: string } {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `snap-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  const payload = snapshot && typeof snapshot === "object" ? (snapshot as Record<string, unknown>) : {};
  const serverFetchedAt = typeof payload.fetchedAt === "string" ? payload.fetchedAt : undefined;
  const persistIdFromPayload =
    typeof payload.snapshotPersistId === "string" ? payload.snapshotPersistId.trim() : undefined;

  const entry: ComprasmxHistoryEntry = {
    id,
    storedAt: new Date().toISOString(),
    serverFetchedAt,
    serverPersistId: serverPersistId?.trim() || persistIdFromPayload || undefined,
    resumen: resumenDesdePayload(snapshot),
    snapshotJson: snapshot,
    documentosPorExpediente: {},
  };

  const prev = readEntries();
  let combined: ComprasmxHistoryEntry[] = [entry, ...prev];

  while (combined.length > 0) {
    combined = combined.slice(0, COMPRASMX_SNAPSHOT_HISTORY_MAX);
    if (writeEntries(combined)) return { ok: true, id };
    combined = combined.slice(0, -1);
  }

  return { ok: false, id };
}

export function listSnapshotHistory(): ComprasmxHistoryEntry[] {
  return readEntries();
}

export function getHistoryEntry(id: string): ComprasmxHistoryEntry | undefined {
  return readEntries().find((e) => e.id === id);
}

export function mergeDocumentosIntoHistoryEntry(
  entryId: string | null | undefined,
  numeroIdentificacion: string,
  docs: HistorialDocumentoFila[],
): void {
  if (!entryId || docs.length === 0) return;
  const cur = readEntries();
  const i = cur.findIndex((e) => e.id === entryId);
  if (i < 0) return;
  const prev = cur[i]!;
  const merged: ComprasmxHistoryEntry = {
    ...prev,
    documentosPorExpediente: {
      ...(prev.documentosPorExpediente ?? {}),
      [numeroIdentificacion.trim()]: docs,
    },
  };
  const next = [...cur];
  next[i] = merged;
  writeEntries(next);
}

export function removeHistoryEntry(id: string): void {
  writeEntries(readEntries().filter((e) => e.id !== id));
}

export function clearSnapshotHistory(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
