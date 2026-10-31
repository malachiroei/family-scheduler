import { isoDate, parseFlexibleDate, weekdayIndexUtc } from "@/app/lib/scheduleDate";

/** 0 = Sunday … 6 = Saturday, matching the rest of the scheduler. */
const WEEKDAYS: Array<[string, number]> = [
  ["ראשון", 0],
  ["שני", 1],
  ["שלישי", 2],
  ["רביעי", 3],
  ["חמישי", 4],
  ["שישי", 5],
  ["שבת", 6],
];

const HEBREW_MONTHS: Array<[string, number]> = [
  ["ינואר", 1],
  ["פברואר", 2],
  ["מרץ", 3],
  ["אפריל", 4],
  ["מאי", 5],
  ["יוני", 6],
  ["יולי", 7],
  ["אוגוסט", 8],
  ["ספטמבר", 9],
  ["אוקטובר", 10],
  ["נובמבר", 11],
  ["דצמבר", 12],
];

export type HebrewScheduleRange = {
  year: number;
  month: number;
  startDay: number;
  endDay: number;
};

export type WeeklyEventType = "dog" | "gym" | "sport" | "lesson" | "dance" | "other";

export type WeeklyScheduleEvent = {
  date: string;
  dayIndex: number;
  time: string;
  title: string;
  type: WeeklyEventType;
  keyword: string | null;
  /** Free-text reminder (for example "לבוא לעודד") kept with the event. */
  notes: string | null;
};

export type WeeklyScheduleParse = {
  range: HebrewScheduleRange | null;
  sender: string | null;
  /** Name after "מאמן/ת", when the schedule is for that person. */
  assigneeName: string | null;
  events: WeeklyScheduleEvent[];
};

export type WeeklyParseOptions = {
  now?: Date;
  /**
   * Week currently on screen. Used only when the message does not name a month range.
   * A header such as "1-7 בנובמבר" always wins over this week.
   */
  viewedWeekStart?: Date | string | null;
};

const MONTH_PATTERN = HEBREW_MONTHS.map(([name]) => name).join("|");
const WEEKDAY_PATTERN = WEEKDAYS.map(([name]) => name).join("|");
const RANGE_RE = new RegExp(
  `(\\d{1,2})\\s*[-–—]\\s*(\\d{1,2})\\s+ב?(${MONTH_PATTERN})(?:\\s+(\\d{4}))?`,
  "u",
);
const DAY_ONLY_RE = new RegExp(`^(?:יום\\s+)?(${WEEKDAY_PATTERN})\\s*[.:\\-–—]?\\s*$`, "u");
const DAY_BODY_RE = new RegExp(`^(?:יום\\s+)?(${WEEKDAY_PATTERN})\\s*[.:\\-–—]?\\s+(\\S[\\s\\S]*)$`, "u");

const pad2 = (n: number) => String(n).padStart(2, "0");

export const normalizeScheduleSource = (raw: string): string =>
  raw
    .replace(/\\r/g, "")
    .replace(/\\n/g, "\n")
    .replace(/\\t/g, " ")
    .replace(/\\"/g, '"')
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/[\u05F4\u201C\u201D\u2033]/g, '"')
    .replace(/[\u05F3\u2018\u2019]/g, "'");

const stripDecor = (line: string) =>
  line.replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, "").trim();

const clock = (value: string): string | null => {
  const match = value.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return `${pad2(hours)}:${pad2(minutes)}`;
};

export const leadingClockRange = (
  line: string,
): { start: string; end: string | null; rest: string } | null => {
  const match = line.trim().match(/^(\d{1,2}:\d{2})\s*(?:[-–—]\s*(\d{1,2}:\d{2}))?\s*([\s\S]*)$/u);
  if (!match) return null;
  const start = clock(match[1]);
  if (!start) return null;
  const end = match[2] ? clock(match[2]) : null;
  return { start, end, rest: (match[3] ?? "").trim() };
};

const weekdayIndex = (word: string): number | null => {
  const found = WEEKDAYS.find(([name]) => name === word.trim());
  return found ? found[1] : null;
};

const inferYear = (month: number, endDay: number, now: Date): number => {
  const year = now.getFullYear();
  const endUtc = Date.UTC(year, month - 1, endDay);
  const todayUtc = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  if (endUtc < todayUtc - 14 * 86400000) return year + 1;
  return year;
};

/** "לו\"ז שבועי | 1-7 בנובמבר" → the numbered days in that Hebrew month. */
export const parseHebrewScheduleRange = (
  text: string,
  now: Date = new Date(),
): HebrewScheduleRange | null => {
  const match = normalizeScheduleSource(text).match(RANGE_RE);
  if (!match) return null;
  const startDay = Number(match[1]);
  const endDay = Number(match[2]);
  const month = HEBREW_MONTHS.find(([name]) => name === match[3])?.[1];
  if (!month || startDay < 1 || endDay < startDay || endDay > 31) return null;
  const year = match[4] ? Number(match[4]) : inferYear(month, endDay, now);
  if (!isoDate(year, month, startDay) || !isoDate(year, month, endDay)) return null;
  return { year, month, startDay, endDay };
};

/** Calendar date of `weekdayIndex` (0=Sun) inside the header range. Never the on-screen week. */
export const dateForWeekdayInRange = (
  range: HebrewScheduleRange,
  weekday: number,
): string | null => {
  if (weekday < 0 || weekday > 6) return null;
  for (let day = range.startDay; day <= range.endDay; day += 1) {
    const iso = isoDate(range.year, range.month, day);
    if (iso && weekdayIndexUtc(iso) === weekday) return iso;
  }
  return null;
};

/** Sunday of the week that contains the first day of the header range. */
export const weekStartDateForRange = (range: HebrewScheduleRange): Date => {
  const anchor = isoDate(range.year, range.month, range.startDay);
  if (!anchor) return new Date();
  const [year, month, day] = anchor.split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() - date.getDay());
};

const dateInViewedWeek = (viewedWeekStart: Date | string, weekday: number): string | null => {
  let year: number;
  let month: number;
  let day: number;
  if (viewedWeekStart instanceof Date && !Number.isNaN(viewedWeekStart.getTime())) {
    year = viewedWeekStart.getFullYear();
    month = viewedWeekStart.getMonth() + 1;
    day = viewedWeekStart.getDate();
  } else {
    const iso = parseFlexibleDate(viewedWeekStart) ?? String(viewedWeekStart).slice(0, 10);
    const parsed = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!parsed) return null;
    year = Number(parsed[1]);
    month = Number(parsed[2]);
    day = Number(parsed[3]);
  }
  const anchor = new Date(year, month - 1, day);
  if (Number.isNaN(anchor.getTime())) return null;
  const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
  const target = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + weekday);
  return isoDate(target.getFullYear(), target.getMonth() + 1, target.getDate());
};

const nextWeekdayOnOrAfter = (weekday: number, now: Date): string | null => {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const delta = (weekday - start.getDay() + 7) % 7;
  const target = new Date(start.getFullYear(), start.getMonth(), start.getDate() + delta);
  return isoDate(target.getFullYear(), target.getMonth() + 1, target.getDate());
};

const cleanDescription = (rest: string): string => {
  const cut = rest.search(/"\s*[,}]/);
  const sliced = cut >= 0 ? rest.slice(0, cut) : rest;
  return sliced.replace(/[.!\s]+$/u, "").replace(/^[,.\s–—-]+/u, "").trim();
};

/**
 * A line that is not a regular practice (game + "come and cheer") is still an event.
 * It is stored as a reminder/note instead of failing the whole schedule.
 */
const classifyScheduleLine = (
  description: string,
): { type: WeeklyEventType; title: string; keyword: string | null; notes: string | null } => {
  const text = description.trim();
  if (!text) {
    return { type: "other", title: "אירוע", keyword: null, notes: null };
  }
  if (/לבוא|לעודד|תזכורת/.test(text)) {
    return { type: "other", title: text, keyword: "תזכורת", notes: text };
  }
  if (/משחק/.test(text)) {
    return { type: "sport", title: text, keyword: "משחק", notes: null };
  }
  if (/ריקוד/.test(text)) {
    return { type: "dance", title: text, keyword: "ריקוד", notes: null };
  }
  if (/שיעור|תגבור|אנגלית/.test(text)) {
    return { type: "lesson", title: text, keyword: "שיעור", notes: null };
  }
  if (/כלב|גוני|ג'וני/.test(text)) {
    return { type: "dog", title: text, keyword: "כלב", notes: null };
  }
  if (/נערים|נערות|ילדות|אימון|אולם|כדורסל/.test(text)) {
    return { type: "gym", title: text, keyword: text.slice(0, 40), notes: null };
  }
  return { type: "other", title: text, keyword: null, notes: null };
};

const assigneeFromCoachLine = (text: string): string | null => {
  const match = text.match(/מאמ[\u05DF\u05E0]ת?\s+([\u0590-\u05FF]{2,12})/u);
  const name = match?.[1]?.trim() ?? "";
  if (!name || WEEKDAYS.some(([day]) => day === name) || HEBREW_MONTHS.some(([month]) => month === name)) {
    return null;
  }
  return name;
};

const breakBeforeWeekdays = (text: string): string =>
  text.replace(
    new RegExp(`[ \\t]+(?=(?:יום\\s+)?(?:${WEEKDAY_PATTERN})(?![\\u0590-\\u05FF]))`, "gu"),
    "\n",
  );

const resolveEventDate = (
  dayIndex: number,
  range: HebrewScheduleRange | null,
  options: WeeklyParseOptions,
): string | null => {
  if (range) return dateForWeekdayInRange(range, dayIndex);
  if (options.viewedWeekStart) return dateInViewedWeek(options.viewedWeekStart, dayIndex);
  return nextWeekdayOnOrAfter(dayIndex, options.now ?? new Date());
};

export const parseWeeklyScheduleMessage = (
  text: string,
  options: WeeklyParseOptions = {},
): WeeklyScheduleParse | null => {
  const normalized = breakBeforeWeekdays(normalizeScheduleSource(text));
  if (!normalized.trim()) return null;
  const now = options.now ?? new Date();
  const range = parseHebrewScheduleRange(normalized, now);
  const lines = normalized
    .split(/\r?\n/)
    .map((line) => stripDecor(line))
    .filter(Boolean);

  let currentDay: number | null = null;
  let sender: string | null = null;
  const events: WeeklyScheduleEvent[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^שבוע\s+אימונים\b/u.test(line) || /^שבת\s+שלום\b/u.test(line)) continue;

    const dayOnly = line.match(DAY_ONLY_RE);
    if (dayOnly) {
      currentDay = weekdayIndex(dayOnly[1] ?? "");
      continue;
    }

    const dayBody = line.match(DAY_BODY_RE);
    const dayIndex = dayBody ? weekdayIndex(dayBody[1] ?? "") : currentDay;
    const body = dayBody ? dayBody[2] : line;
    const timed = leadingClockRange(body);
    if (dayIndex == null || !timed) {
      const isHeader =
        RANGE_RE.test(line) ||
        /^אולם(?:\s|$)/u.test(line) ||
        /לו\s*"?\s*ז|לוז/u.test(line);
      if (!sender && !isHeader && !/^\d/.test(line)) {
        sender = line.slice(0, 80);
      }
      continue;
    }

    const description = cleanDescription(timed.rest);
    const classified = classifyScheduleLine(description);
    const title = timed.end ? `${classified.title} (${timed.start}–${timed.end})` : classified.title;
    const date = resolveEventDate(dayIndex, range, options);
    // A named month range must not be replaced with the week currently on screen.
    if (!date) continue;
    const key = `${date}|${timed.start}|${title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push({
      date,
      dayIndex,
      time: timed.start,
      title,
      type: classified.type,
      keyword: classified.keyword,
      notes: classified.notes,
    });
    currentDay = dayIndex;
  }

  if (!events.length) return null;
  return {
    range,
    sender,
    assigneeName: assigneeFromCoachLine(normalized),
    events,
  };
};

export const scheduleSourceCandidates = (...parts: Array<string | null | undefined>): string[] => {
  const out: string[] = [];
  const push = (value: string) => {
    const trimmed = value.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  };
  for (const part of parts) {
    if (!part) continue;
    push(part);
    const unescaped = normalizeScheduleSource(part);
    if (unescaped !== part) push(unescaped);
  }
  return out;
};

/** Prefer a header range ("1-7 בנובמבר") over whatever week the model or the UI guessed. */
export const findHeaderWeeklySchedule = (
  sources: Array<string | null | undefined>,
  options: WeeklyParseOptions = {},
): WeeklyScheduleParse | null => {
  let best: WeeklyScheduleParse | null = null;
  for (const source of scheduleSourceCandidates(...sources)) {
    const parsed = parseWeeklyScheduleMessage(source, options);
    if (!parsed?.range || parsed.events.length === 0) continue;
    if (!best || parsed.events.length > best.events.length) best = parsed;
  }
  return best;
};

/** Move each event onto the weekday inside the header range, leaving unrelated schedules untouched. */
export const remapEventDatesToHeaderRange = (
  events: unknown[],
  sourceText: string,
  now: Date = new Date(),
): unknown[] => {
  const range = parseHebrewScheduleRange(sourceText, now);
  if (!range) return events;
  return events.map((event) => {
    if (!event || typeof event !== "object") return event;
    const record = event as { date?: unknown };
    const current = typeof record.date === "string" ? record.date : null;
    if (!current) return event;
    const weekday = weekdayIndexUtc(current);
    const next = dateForWeekdayInRange(range, weekday);
    if (!next || next === current) return event;
    return { ...record, date: next };
  });
};
