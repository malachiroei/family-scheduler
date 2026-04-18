/**
 * JSONB booleans must not use `Boolean(x)` — in JS `Boolean("false") === true`.
 * Use this for metadata flags (isRecurring, completed, …).
 */
export const parseMetadataBoolean = (value: unknown): boolean => {
  if (value === true || value === 1) {
    return true;
  }
  if (value === false || value === 0 || value === null || value === undefined) {
    return false;
  }
  if (typeof value === "string") {
    const n = value.trim().toLowerCase();
    if (n === "true" || n === "1") {
      return true;
    }
    if (n === "false" || n === "0" || n === "") {
      return false;
    }
  }
  return false;
};

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
