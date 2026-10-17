import { inflateRawSync } from "zlib";
import { classifyFixtureLeague, compactLeagueLabel } from "./fixtureLeague";

/** Family team this importer is built around. */
export const FIXTURE_TEAM_NAME = "בני יהודה";
export const FIXTURE_TEAM_RE = /בני[\s\-]*יהודה/i;

export type FixtureGame = {
  date: string; // YYYY-MM-DD
  time: string; // HH:mm
  round: string | null;
  homeAway: "בית" | "חוץ";
  opponent: string;
  venue: string | null;
  league: string | null;
  title: string;
};

export type FixtureParseResult = {
  games: FixtureGame[];
  league: string | null;
  team: string;
  sourceLabel: string;
};

const OUR_TEAM = FIXTURE_TEAM_RE;

const cellText = (value: unknown): string => {
  if (value == null) return "";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return String(value).replace(/\s+/g, " ").trim();
};

const normalizeHeader = (value: unknown) =>
  cellText(value)
    .toLowerCase()
    .replace(/["'״׳]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const looksLikeOurTeam = (value: string) => OUR_TEAM.test(value);

export const normalizeLeagueKey = (raw: string | null | undefined) => {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  return s
    .replace(/תל[\s\-]*אביב/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
};

export const fixtureSenderKey = (league: string | null | undefined) => {
  const leagueKey = normalizeLeagueKey(league) || "כללי";
  return `fixtures:${FIXTURE_TEAM_NAME}|${leagueKey}`;
};

const excelSerialToIso = (serial: number): string | null => {
  if (!Number.isFinite(serial) || serial < 20000 || serial > 80000) return null;
  const utc = Date.UTC(1899, 11, 30) + Math.round(serial) * 86400000;
  const d = new Date(utc);
  const y = d.getUTCFullYear();
  if (y < 2000 || y > 2100) return null;
  return `${y}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
};

const parseDateCell = (value: unknown): string | null => {
  if (typeof value === "number") return excelSerialToIso(value);
  const text = cellText(value);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dmy = text.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return null;
};

const parseTimeCell = (value: unknown): string | null => {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 0 && value < 1) {
      const total = Math.round(value * 24 * 60);
      const h = Math.floor(total / 60) % 24;
      const min = total % 60;
      return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    }
  }
  const text = cellText(value);
  const m = text.match(/^(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

const parseHomeAwayLabel = (value: string): "בית" | "חוץ" | null => {
  const s = value.trim().toLowerCase();
  if (!s) return null;
  if (/(^| )בית( |$)|home/.test(s) && !/חוץ|away/.test(s)) return "בית";
  if (/חוץ|away|guest/.test(s)) return "חוץ";
  return null;
};

type ColMap = {
  date: number;
  time: number;
  round: number;
  homeTeam: number;
  awayTeam: number;
  venue: number;
  league: number;
  homeAway: number;
  opponent: number;
};

const HEADER_ALIASES: Record<keyof ColMap, string[]> = {
  date: ["תאריך", "date", "game date"],
  time: ["time", "שעה", "שעת משחק", "kickoff"],
  round: ["מחזור", "round", "cycle", "gw"],
  homeTeam: ["home team", "קבוצת בית"],
  awayTeam: ["away team", "קבוצת חוץ", "אורחת"],
  venue: ["venue", "אולם", "מגרש", "כתובת", "מיקום", "hall", "address"],
  league: ["ליגה", "league", "division"],
  homeAway: ["בית או חוץ", "בית/חוץ", "home/away", "ha"],
  opponent: ["יריבה", "מול מי", "opponent", "versus"],
};

const scoreHeader = (header: string, aliases: string[]) => {
  for (const alias of aliases) {
    if (header === alias) return 3;
    if (header.includes(alias) || alias.includes(header)) return 2;
  }
  return 0;
};

const detectColumns = (rows: unknown[][]): ColMap => {
  const fallback: ColMap = {
    date: 3,
    round: 4,
    time: 5,
    homeTeam: 6,
    opponent: 8,
    awayTeam: 8,
    venue: 10,
    league: 0,
    homeAway: -1,
  };

  let best: { score: number; map: ColMap } | null = null;
  const scan = Math.min(rows.length, 12);
  for (let r = 0; r < scan; r += 1) {
    const row = rows[r] ?? [];
    const map: ColMap = { ...fallback, homeAway: -1, opponent: -1 };
    const bestHit: Partial<Record<keyof ColMap, number>> = {};
    let score = 0;
    for (let c = 0; c < row.length; c += 1) {
      const header = normalizeHeader(row[c]);
      if (!header) continue;
      if (/\bcode\b|קוד/.test(header)) continue;
      (Object.keys(HEADER_ALIASES) as Array<keyof ColMap>).forEach((key) => {
        const hit = scoreHeader(header, HEADER_ALIASES[key]);
        if (hit > (bestHit[key] ?? 0)) {
          map[key] = c;
          bestHit[key] = hit;
          score += hit;
        }
      });
    }
    if (!best || score > best.score) best = { score, map };
  }

  return best && best.score >= 6 ? best.map : fallback;
};

const headerRowIndex = (rows: unknown[][], cols: ColMap) => {
  const scan = Math.min(rows.length, 12);
  for (let r = 0; r < scan; r += 1) {
    const dateHeader = normalizeHeader(rows[r]?.[cols.date]);
    if (dateHeader.includes("תאריך") || dateHeader === "date") return r;
  }
  return 0;
};

const buildTitle = (game: Omit<FixtureGame, "title">): string => {
  const roundBit = game.round ? ` (מחזור ${game.round})` : "";
  const where = `${game.homeAway} מול ${game.opponent}${roundBit}`;
  const label = compactLeagueLabel(game.league);
  const kind = classifyFixtureLeague(game.league);
  const head =
    kind === "katsal"
      ? `${label || "קט-סל"} · תגבור · ${where}`
      : label
        ? `${label} · ${where}`
        : `משחק ${where}`;
  return game.venue ? `${head}\n${game.venue}` : head;
};

const pickOpponent = (homeTeam: string, awayTeam: string, explicitOpponent: string) => {
  if (explicitOpponent && !looksLikeOurTeam(explicitOpponent)) return explicitOpponent;
  if (looksLikeOurTeam(homeTeam) && awayTeam) return awayTeam;
  if (looksLikeOurTeam(awayTeam) && homeTeam) return homeTeam;
  return explicitOpponent || awayTeam || homeTeam;
};

const pickHomeAway = (
  labeled: "בית" | "חוץ" | null,
  homeTeam: string,
  awayTeam: string,
): "בית" | "חוץ" | null => {
  if (labeled) return labeled;
  if (looksLikeOurTeam(homeTeam)) return "בית";
  if (looksLikeOurTeam(awayTeam)) return "חוץ";
  return null;
};

export const isSpreadsheetUpload = (fileName?: string | null, mime?: string | null) => {
  const name = (fileName ?? "").toLowerCase();
  const type = (mime ?? "").toLowerCase();
  if (/\.(xlsx|xls|csv)$/.test(name)) return true;
  return /spreadsheet|excel|csv/.test(type);
};

/* ---------- minimal xlsx (OOXML) reader — no extra npm dependency ---------- */

const decodeXmlEntities = (s: string) => {
  let prev = s;
  for (let i = 0; i < 3; i += 1) {
    const next = prev
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, "&")
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">");
    if (next === prev) return next;
    prev = next;
  }
  return prev;
};

const colIndexFromRef = (ref: string) => {
  const letters = (ref.match(/^[A-Z]+/i) || [""])[0].toUpperCase();
  let n = 0;
  for (let i = 0; i < letters.length; i += 1) {
    n = n * 26 + (letters.charCodeAt(i) - 64);
  }
  return Math.max(0, n - 1);
};

const findEocd = (buffer: Buffer) => {
  // EOCD is at the end; comment can be up to 64k.
  const start = Math.max(0, buffer.length - 22 - 65535);
  for (let i = buffer.length - 22; i >= start; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
};

const readZip = (buffer: Buffer) => {
  const files = new Map<string, string>();
  const eocd = findEocd(buffer);
  if (eocd < 0) throw new Error("not-a-zip");
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  const cdEntries = buffer.readUInt16LE(eocd + 10);
  let offset = cdOffset;
  for (let n = 0; n < cdEntries && offset + 46 <= buffer.length; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.subarray(offset + 46, offset + 46 + nameLen).toString("utf8").replace(/\\/g, "/");
    offset += 46 + nameLen + extraLen + commentLen;

    if (localOffset + 30 > buffer.length) continue;
    const localNameLen = buffer.readUInt16LE(localOffset + 26);
    const localExtraLen = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    let data: Buffer;
    try {
      if (method === 0) data = Buffer.from(compressed);
      else if (method === 8) data = inflateRawSync(compressed);
      else continue;
    } catch {
      continue;
    }
    files.set(name, data.toString("utf8"));
  }
  return files;
};

const parseSharedStrings = (xml: string) => {
  const strings: string[] = [];
  const siBlocks = xml.split(/<si[>\s]/i).slice(1);
  for (const block of siBlocks) {
    const texts: string[] = [];
    const re = /<t[^>]*>([^<]*)<\/t>/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(block))) {
      texts.push(decodeXmlEntities(m[1]));
    }
    strings.push(texts.join(""));
  }
  return strings;
};

const parseSheetRows = (xml: string, shared: string[]) => {
  const rows: unknown[][] = [];
  const rowRe = /<row\b[^>]*>([\s\S]*?)<\/row>/gi;
  let rowMatch: RegExpExecArray | null;
  while ((rowMatch = rowRe.exec(xml))) {
    const rowXml = rowMatch[1];
    const cells: unknown[] = [];
    const cellRe = /<c\b([^>]*)>([\s\S]*?)<\/c>|<c\b([^>]*)\/>/gi;
    let cellMatch: RegExpExecArray | null;
    while ((cellMatch = cellRe.exec(rowXml))) {
      const attrs = cellMatch[1] || cellMatch[3] || "";
      const inner = cellMatch[2] || "";
      const ref = (attrs.match(/\br="([A-Z]+\d+)"/i) || [])[1] || "";
      const type = (attrs.match(/\bt="([^"]+)"/i) || [])[1] || "";
      const raw = ((inner.match(/<v[^>]*>([\s\S]*?)<\/v>/i) || inner.match(/<t[^>]*>([\s\S]*?)<\/t>/i) || [])[1] || "").trim();
      const idx = colIndexFromRef(ref);
      let value: unknown = "";
      if (type === "s") {
        const n = Number(raw);
        value = Number.isInteger(n) ? shared[n] ?? raw : decodeXmlEntities(raw);
      } else if (type === "inlineStr") {
        value = decodeXmlEntities(raw);
      } else if (raw === "") {
        value = "";
      } else if (/^-?\d+(\.\d+)?$/.test(raw)) {
        value = Number(raw);
      } else {
        value = decodeXmlEntities(raw);
      }
      cells[idx] = value;
    }
    rows.push(cells);
  }
  return rows;
};

const parseCsv = (text: string): unknown[][] => {
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim());
  return lines.map((line) => {
    const cells: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if ((ch === "," || ch === "\t" || ch === ";") && !inQuotes) {
        cells.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    cells.push(cur.trim());
    return cells;
  });
};

const sheetsFromWorkbook = (buffer: Buffer): unknown[][][] => {
  const looksZip = buffer.length >= 4 && buffer[0] === 0x50 && buffer[1] === 0x4b;
  if (!looksZip) {
    const text = buffer.toString("utf8");
    if (text.includes(",") || text.includes("\t") || text.includes("תאריך")) {
      return [parseCsv(text)];
    }
    throw new Error("unsupported-spreadsheet");
  }

  const files = readZip(buffer);
  const sharedXml = files.get("xl/sharedStrings.xml") || "";
  const shared = sharedXml ? parseSharedStrings(sharedXml) : [];
  const sheets: unknown[][][] = [];
  const sheetFiles = [...files.keys()]
    .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
    .sort();
  for (const name of sheetFiles) {
    const xml = files.get(name);
    if (!xml) continue;
    sheets.push(parseSheetRows(xml, shared));
  }
  if (!sheets.length) throw new Error("no-sheets");
  return sheets;
};

const gamesFromRows = (rows: unknown[][]): FixtureGame[] => {
  if (!rows.length) return [];
  const cols = detectColumns(rows);
  const start = headerRowIndex(rows, cols) + 1;
  const games: FixtureGame[] = [];

  for (let r = start; r < rows.length; r += 1) {
    const row = rows[r] ?? [];
    const date = parseDateCell(row[cols.date]);
    const time = parseTimeCell(row[cols.time]);
    if (!date || !time) continue;

    const homeTeam = cellText(row[cols.homeTeam]);
    const awayTeam = cellText(row[cols.awayTeam]);
    const explicitOpponent = cols.opponent >= 0 ? cellText(row[cols.opponent]) : "";
    const labeledHomeAway = cols.homeAway >= 0 ? parseHomeAwayLabel(cellText(row[cols.homeAway])) : null;
    const involvesUs =
      looksLikeOurTeam(homeTeam) ||
      looksLikeOurTeam(awayTeam) ||
      looksLikeOurTeam(explicitOpponent) ||
      labeledHomeAway !== null;

    if (!involvesUs) continue;

    const homeAway = pickHomeAway(labeledHomeAway, homeTeam, awayTeam);
    if (!homeAway) continue;

    const opponent = pickOpponent(homeTeam, awayTeam, explicitOpponent);
    if (!opponent || looksLikeOurTeam(opponent)) continue;

    const league = cellText(row[cols.league]) || null;
    const venue = cellText(row[cols.venue]) || null;
    const roundRaw = cellText(row[cols.round]);
    const round = roundRaw && roundRaw !== "0" ? roundRaw : null;
    const game: FixtureGame = {
      date,
      time,
      round,
      homeAway,
      opponent,
      venue,
      league,
      title: "",
    };
    game.title = buildTitle(game);
    games.push(game);
  }
  return games;
};

export const parseFixtureWorkbook = (buffer: Buffer, fileName?: string): FixtureParseResult => {
  const sheets = sheetsFromWorkbook(buffer);
  const games: FixtureGame[] = [];
  const leagueCounts = new Map<string, number>();

  for (const rows of sheets) {
    for (const game of gamesFromRows(rows)) {
      games.push(game);
      if (game.league) {
        leagueCounts.set(game.league, (leagueCounts.get(game.league) ?? 0) + 1);
      }
    }
  }

  const unique: FixtureGame[] = [];
  const seen = new Set<string>();
  for (const game of games) {
    const key = `${game.date}|${game.time}|${game.opponent}|${game.homeAway}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(game);
  }
  unique.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

  let topLeague: string | null = null;
  let topCount = 0;
  for (const [league, count] of leagueCounts) {
    if (count > topCount) {
      topLeague = league;
      topCount = count;
    }
  }

  return {
    games: unique,
    league: topLeague,
    team: FIXTURE_TEAM_NAME,
    sourceLabel: fileName?.trim() || "קובץ אקסל",
  };
};
