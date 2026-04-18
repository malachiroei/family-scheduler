/** HH:MM from HH:MM, H:MM, HH:MM:SS, or fractional seconds; invalid → fallback. */
export const normalizeMetadataTime = (raw: unknown, fallback: string): string => {
  if (typeof raw !== "string" || !raw.trim()) {
    return fallback;
  }
  const m = raw.trim().match(/^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?/);
  if (!m) {
    return fallback;
  }
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (!Number.isInteger(h) || !Number.isInteger(min) || h < 0 || h > 23 || min < 0 || min > 59) {
    return fallback;
  }
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};
