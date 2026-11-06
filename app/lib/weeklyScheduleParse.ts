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

export type WeeklyEventType = "dog" | "gym" | "sport" | "game" | "lesson" | "dance" | "other";

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

const HOME_AWAY_RE = /משחק\s+(?:חוץ|בית)(?:\s+ב[\u0590-\u05FF]{2,})?/u;
const GROUP_RE = /(?:נערים|נערות|ילדות)\s+[א-ת]['׳]?|בוגרות|בוגרים/u;
const GROUP_ONLY_RE = /^(?:(?:נערים|נערות|ילדות)\s+[א-ת]['׳]?|בוגרות|בוגרים)$/u;
const SHUTTLE_RE = /הסע[הת][^\n]*/u;

const formatCompactClock = (raw: string): string | null => {
  const digits = raw.replace(/\D/g, "");
  if (digits.length !== 3 && digits.length !== 4) return null;
  const padded = digits.padStart(4, "0");
  return clock(`${padded.slice(0, 2)}:${padded.slice(2)}`);
};

const formatClockToken = (raw: string): string | null =>
  raw.includes(":") ? clock(raw) : formatCompactClock(raw);

/** "הסעה בשעה 1715 מעירוני ט'" → "הסעה בשעה 17:15 מעירוני ט'". */
const normalizeShuttleText = (raw: string): string => {
  let text = raw.replace(/\s+/g, " ").trim().replace(/[.]+$/u, "");
  text = text.replace(/בשעה\s*(\d{1,2}:\d{2}|\d{3,4})/u, (_, token: string) => {
    const formatted = formatClockToken(token);
    return formatted ? `בשעה ${formatted}` : `בשעה ${token}`;
  });
  text = text.replace(/הסע[הת]\s+(\d{1,2}:\d{2}|\d{3,4})/u, (full, token: string) => {
    const formatted = formatClockToken(token);
    return formatted ? `הסעה בשעה ${formatted}` : full;
  });
  return text;
};

const splitShuttle = (text: string): { rest: string; shuttle: string | null } => {
  const match = text.match(SHUTTLE_RE);
  if (!match || match.index == null) return { rest: text.trim(), shuttle: null };
  const shuttle = normalizeShuttleText(match[0]);
  const rest = `${text.slice(0, match.index)} ${text.slice(match.index + match[0].length)}`
    .replace(/\s+/g, " ")
    .trim();
  return { rest, shuttle };
};

const buildMatchTitle = (phrase: string, group: string | null): string => {
  const clean = phrase.replace(/\s+/g, " ").trim();
  if (!group) return clean;
  const label = group.replace(/\s+/g, " ").trim();
  if (!label || clean.includes(label)) return clean;
  return `${clean} — ${label}`;
};

const appendNote = (current: string | null, extra: string | null): string | null => {
  const next = extra?.trim() ?? "";
  if (!next) return current;
  if (!current) return next;
  if (current.includes(next)) return current;
  return `${current} · ${next}`;
};

const looksLikeMatchContext = (line: string): boolean => {
  const text = line.trim();
  if (!text || text.length > 80) return false;
  return /הסע[הת]|משחק/u.test(text) || GROUP_ONLY_RE.test(text);
};

/**
 * A home/away match is a game, even when the same day also names a team or a practice hour.
 * "Come and cheer" without a home/away fixture stays a reminder.
 */
const classifyScheduleLine = (
  description: string,
): { type: WeeklyEventType; title: string; keyword: string | null; notes: string | null } => {
  const { rest, shuttle } = splitShuttle(description.trim());
  const text = rest.trim();
  if (!text) {
    return { type: "other", title: "אירוע", keyword: null, notes: shuttle };
  }
  const homeAway = text.match(HOME_AWAY_RE)?.[0]?.replace(/\s+/g, " ").trim() ?? null;
  const group = text.match(GROUP_RE)?.[0]?.replace(/\s+/g, " ").trim() ?? null;
  const cheer = /לבוא|לעודד|תזכורת/u.test(text);
  if (homeAway || (/משחק/u.test(text) && !cheer)) {
    const phrase = homeAway ?? text;
    return { type: "game", title: buildMatchTitle(phrase, group), keyword: "משחק", notes: shuttle };
  }
  if (cheer) {
    return { type: "other", title: text, keyword: "תזכורת", notes: shuttle ?? text };
  }
  if (/ריקוד/u.test(text)) {
    return { type: "dance", title: text, keyword: "ריקוד", notes: shuttle };
  }
  if (/שיעור|תגבור|אנגלית/u.test(text)) {
    return { type: "lesson", title: text, keyword: "שיעור", notes: shuttle };
  }
  if (/כלב|גוני|ג'וני/u.test(text)) {
    return { type: "dog", title: text, keyword: "כלב", notes: shuttle };
  }
  if (/נערים|נערות|ילדות|אימון|אולם|כדורסל/u.test(text)) {
    return { type: "gym", title: text, keyword: text.slice(0, 40), notes: shuttle };
  }
  return { type: "other", title: text, keyword: null, notes: shuttle };
};

/** Fold a following (or preceding) match / bus line into the day's timed event. */
const attachContinuation = (event: WeeklyScheduleEvent, rawLine: string): boolean => {
  const line = cleanDescription(rawLine);
  if (!line) return false;
  const { rest, shuttle } = splitShuttle(line);
  if (/^הסע[הת]/u.test(line)) {
    event.notes = appendNote(event.notes, shuttle ?? normalizeShuttleText(line));
    return true;
  }
  const homeAway = rest.match(HOME_AWAY_RE)?.[0]?.replace(/\s+/g, " ").trim() ?? null;
  const cheer = /לבוא|לעודד|תזכורת/u.test(rest);
  if (homeAway || (/משחק/u.test(rest) && !cheer)) {
    const phrase = homeAway ?? rest;
    const group =
      rest.match(GROUP_RE)?.[0]?.replace(/\s+/g, " ").trim()
      ?? event.title.match(GROUP_RE)?.[0]?.replace(/\s+/g, " ").trim()
      ?? null;
    event.type = "game";
    event.keyword = "משחק";
    event.title = buildMatchTitle(phrase, group);
    event.notes = appendNote(event.notes, shuttle);
    return true;
  }
  if (GROUP_ONLY_RE.test(line) && (event.type === "game" || /משחק/u.test(event.title))) {
    event.title = buildMatchTitle(event.title, line);
    return true;
  }
  return false;
};

const applyMatchDetails = (event: WeeklyScheduleEvent, details: string) => {
  const parts = details.split("\n").map((part) => part.trim()).filter(Boolean);
  for (const part of parts) {
    if (/משחק|הסע[הת]/u.test(part)) attachContinuation(event, part);
  }
  for (const part of parts) {
    if (!/משחק|הסע[הת]/u.test(part)) attachContinuation(event, part);
  }
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
  let pendingIndex: number | null = null;
  let pendingDetail: string | null = null;
  const events: WeeklyScheduleEvent[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    if (/^שבוע\s+אימונים\b/u.test(line) || /^שבת\s+שלום\b/u.test(line)) continue;

    const dayOnly = line.match(DAY_ONLY_RE);
    if (dayOnly) {
      currentDay = weekdayIndex(dayOnly[1] ?? "");
      pendingIndex = null;
      pendingDetail = null;
      continue;
    }

    const dayBody = line.match(DAY_BODY_RE);
    const dayIndex = dayBody ? weekdayIndex(dayBody[1] ?? "") : currentDay;
    const body = dayBody ? dayBody[2] : line;
    const timed = leadingClockRange(body);
    if (dayIndex == null || !timed) {
      if (dayIndex != null && looksLikeMatchContext(body)) {
        if (
          pendingIndex != null
          && events[pendingIndex]?.dayIndex === dayIndex
          && attachContinuation(events[pendingIndex], body)
        ) {
          currentDay = dayIndex;
          continue;
        }
        if (/משחק|הסע[הת]/u.test(body) || GROUP_ONLY_RE.test(body.trim())) {
          pendingDetail = pendingDetail ? `${pendingDetail}\n${body}` : body;
          currentDay = dayIndex;
          continue;
        }
      }
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
    const draft: WeeklyScheduleEvent = {
      date: "",
      dayIndex,
      time: timed.start,
      title: classified.title,
      type: classified.type,
      keyword: classified.keyword,
      notes: classified.notes,
    };
    if (pendingDetail) {
      applyMatchDetails(draft, pendingDetail);
      pendingDetail = null;
    }
    if (draft.type !== "game" && timed.end) {
      draft.title = `${draft.title} (${timed.start}–${timed.end})`;
    }
    const date = resolveEventDate(dayIndex, range, options);
    // A named month range must not be replaced with the week currently on screen.
    if (!date) continue;
    draft.date = date;
    const key = `${date}|${timed.start}|${draft.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    events.push(draft);
    pendingIndex = events.length - 1;
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
