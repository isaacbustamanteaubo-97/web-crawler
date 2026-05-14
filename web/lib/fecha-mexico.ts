/** Fecha civil en zona `America/Mexico_City` como `YYYY-MM-DD` (útil para `fechaISO` del API). */
export function fechaIsoHoyMexico(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Mexico_City",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value])) as Record<
    "year" | "month" | "day",
    string
  >;
  return `${map.year}-${map.month}-${map.day}`;
}

/** Valida `YYYY-MM-DD` civil (UTC mediodía para evitar saltos de día). */
export function esFechaIsoValida(s: string): boolean {
  const t = s.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!Number.isFinite(y) || !Number.isFinite(mo) || !Number.isFinite(d)) return false;
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
