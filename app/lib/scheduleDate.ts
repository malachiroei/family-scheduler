/** Shared calendar-date helpers. Always store and compare as YYYY-MM-DD. */

const pad2 = (n: number) => String(n).padStart(2, "0");

export const isoDate = (year: number, month: number, day: number): string | null => {
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  if (year < 2000 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (
    Number.isNaN(dt.getTime()) ||
    dt.getUTCFullYear() !== year ||
    dt.getUTCMonth() + 1 !== month ||
    dt.getUTCDate() !== day
  ) {
    return null;
  }
  return `${year}-${pad2(month)}-${pad2(day)}`;
};

/** Excel serial date (1900 system). Use the integer day; ignore a time fraction. */
export const excelSerialToIso = (serial: number): string | null => {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const days = Math.floor(serial);
  const utc = Date.UTC(1899, 11, 30) + days * 86400000;
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return isoDate(y, d.getUTCMonth() + 1, d.getUTCDate());
};

const expandYear = (year: number) => {
  if (year >= 100) return year;
  return year >= 70 ? 1900 + year : 2000 + year;
};

/**
 * Parse a fixture / DB date to YYYY-MM-DD.
 * Israeli Excel uses DD-MM-YYYY or DD/MM/YYYY; Postgres DATE values may arrive as Date objects.
 */
export const parseFlexibleDate = (value: unknown): string | null => {
  if (value == null || value === "") return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    if (value.getUTCHours() === 0 && value.getUTCMinutes() === 0 && value.getUTCSeconds() === 0) {
      return isoDate(value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate());
    }
    return isoDate(value.getFullYear(), value.getMonth() + 1, value.getDate());
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0 && value < 1) return null;
    return excelSerialToIso(value);
  }

  const text = String(value).replace(/\s+/g, " ").trim();
  if (!text) return null;

  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return isoDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})(?:\b|T|\s|$)/);
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    const year = expandYear(Number(dmy[3]));
    const asDmy = isoDate(year, month, day);
    if (asDmy) return asDmy;
    // US-style MM-DD-YYYY only when the first number cannot be a day-in-month under DMY.
    return isoDate(year, day, month);
  }

  if (/^\d+(\.\d+)?$/.test(text)) {
    return excelSerialToIso(Number(text));
  }

  return null;
};

export const weekdayIndexUtc = (iso: string): number => {
  const parsed = parseFlexibleDate(iso);
  if (!parsed) return 0;
  const [y, m, d] = parsed.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};
