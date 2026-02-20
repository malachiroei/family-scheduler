import { NextRequest, NextResponse } from "next/server";
import { ensureDatabaseConnectionString, getDatabaseConfig, sql } from "@/app/lib/db";
import { sendPushToAll, sendPushToParents } from "@/app/lib/push";

export const revalidate = 0;

const dbConfig = getDatabaseConfig();
const activeDatabaseUrl = dbConfig.url;
const isVerboseScheduleLogs = process.env.SCHEDULE_VERBOSE_LOGS === "1";
const debugScheduleLog = (...args: unknown[]) => {
  if (isVerboseScheduleLogs) {
    console.log(...args);
  }
};

debugScheduleLog("Syncing with Neon DB: ", activeDatabaseUrl ? "CONNECTED" : "MISSING");
debugScheduleLog("DB URL source:", dbConfig.source);
debugScheduleLog("Saving to DB:", activeDatabaseUrl ? activeDatabaseUrl.substring(0, 15) + "..." : "(missing)");
debugScheduleLog("Current ENV keys:", Object.keys(process.env));

const allowedModels = ["gemini-1.5-flash", "gemini-2.0-flash"] as const;
type SupportedModel = (typeof allowedModels)[number];
const defaultModel: SupportedModel = "gemini-1.5-flash";
const defaultFallbackModel: SupportedModel = "gemini-1.5-flash";
const modelAliasMap: Record<string, SupportedModel> = {
  "gemini-1.5-flash-latest": "gemini-1.5-flash",
  "gemini-2.0-flash-exp": "gemini-2.0-flash",
};
const allowedChildren = ["ravid", "amit", "alin"] as const;
const allowedTypes = ["dog", "gym", "sport", "lesson", "dance"] as const;
const allowedScheduleChildren = [
  "ravid",
  "amit",
  "alin",
  "amit_alin",
  "alin_ravid",
  "amit_ravid",
] as const;
const childLabelMap: Record<string, string> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
};

type ChildKey = (typeof allowedChildren)[number];
type EventType = (typeof allowedTypes)[number];

type AiEvent = {
  dayIndex: number;
  time: string;
  child: ChildKey;
  title: string;
  type: EventType;
  recurringWeekly?: boolean;
};

const extractJsonArray = (text: string) => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
};

const getErrorMessage = (error: unknown) => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const parseBooleanValue = (value: unknown) => {
  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "") {
      return false;
    }
  }

  if (typeof value === "number") {
    return value === 1;
  }

  return false;
};

const ensurePostgresEnv = () => {
  const config = ensureDatabaseConnectionString();
  if (!config?.url) {
    return "MISSING_POSTGRES_ENV";
  }

  return null;
};

const requiredInsertColumns = [
  "id",
  "text",
  "day",
  "time",
  "type",
  "child",
  "is_weekly",
  "event_id",
  "event_date",
  "day_index",
  "event_time",
  "title",
  "event_type",
  "is_recurring",
  "recurring_template_id",
  "completed",
  "send_notification",
  "require_confirmation",
  "needs_ack",
  "user_id",
  "updated_at",
] as const;

const ensureInsertColumnsExist = async () => {
  try {
    const result = await sql`
      SELECT column_name
      FROM information_schema.columns
      WHERE table_name = 'family_schedule'
    `;

    const existingColumns = new Set(result.rows.map((row) => String(row.column_name || "").trim().toLowerCase()));
    const missingColumns = requiredInsertColumns.filter((columnName) => !existingColumns.has(columnName));

    if (missingColumns.length > 0) {
      return {
        ok: false as const,
        code: "MISSING_TABLE_COLUMNS",
        error: `family_schedule is missing required columns: ${missingColumns.join(", ")}`,
      };
    }

    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      code: "COLUMN_VERIFICATION_FAILED",
      error: `Failed to verify family_schedule columns: ${getErrorMessage(error)}`,
    };
  }
};

const formatDbError = (error: unknown) => {
  if (!error || typeof error !== "object") {
    return getErrorMessage(error);
  }

  const candidate = error as Record<string, unknown>;
  const details: string[] = [];

  if (typeof candidate.message === "string" && candidate.message.trim()) {
    details.push(`message=${candidate.message.trim()}`);
  }
  if (typeof candidate.code === "string" && candidate.code.trim()) {
    details.push(`code=${candidate.code.trim()}`);
  }
  if (typeof candidate.detail === "string" && candidate.detail.trim()) {
    details.push(`detail=${candidate.detail.trim()}`);
  }
  if (typeof candidate.hint === "string" && candidate.hint.trim()) {
    details.push(`hint=${candidate.hint.trim()}`);
  }
  if (typeof candidate.table === "string" && candidate.table.trim()) {
    details.push(`table=${candidate.table.trim()}`);
  }
  if (typeof candidate.column === "string" && candidate.column.trim()) {
    details.push(`column=${candidate.column.trim()}`);
  }
  if (typeof candidate.constraint === "string" && candidate.constraint.trim()) {
    details.push(`constraint=${candidate.constraint.trim()}`);
  }

  return details.length ? details.join(" | ") : getErrorMessage(error);
};

const ensureFamilyScheduleTable = async () => {
  const envError = ensurePostgresEnv();
  if (envError) {
    return { ok: false as const, code: envError, error: envError };
  }

  try {
    await sql`
      CREATE TABLE IF NOT EXISTS family_schedule (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        day TEXT NOT NULL,
        time TEXT NOT NULL,
        type TEXT NOT NULL,
        child TEXT NOT NULL,
        is_weekly BOOLEAN NOT NULL DEFAULT FALSE
      )
    `;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS id TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS text TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS day TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS time TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS type TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS child TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS event_id TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS event_date TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS day_index INT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS event_time TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS title TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS event_type TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS is_recurring BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS recurring_template_id TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS send_notification BOOLEAN NOT NULL DEFAULT TRUE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS require_confirmation BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS needs_ack BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS user_id TEXT`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
    await sql`UPDATE family_schedule SET completed = FALSE WHERE completed IS NULL`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN completed SET DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN completed SET NOT NULL`;
    await sql`UPDATE family_schedule SET send_notification = TRUE WHERE send_notification IS NULL`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN send_notification SET DEFAULT TRUE`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN send_notification SET NOT NULL`;
    await sql`UPDATE family_schedule SET require_confirmation = FALSE WHERE require_confirmation IS NULL`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN require_confirmation SET DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN require_confirmation SET NOT NULL`;
    await sql`UPDATE family_schedule SET needs_ack = COALESCE(needs_ack, require_confirmation, FALSE)`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN needs_ack SET DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN needs_ack SET NOT NULL`;
    await sql`UPDATE family_schedule SET require_confirmation = COALESCE(needs_ack, require_confirmation, FALSE)`;
    await sql`UPDATE family_schedule SET user_id = 'system' WHERE user_id IS NULL OR BTRIM(user_id) = ''`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN user_id SET DEFAULT 'system'`;
    await sql`ALTER TABLE family_schedule ALTER COLUMN user_id SET NOT NULL`;
    await sql`
      ALTER TABLE family_schedule
      ADD COLUMN IF NOT EXISTS is_weekly BOOLEAN NOT NULL DEFAULT FALSE
    `;
    try {
      await sql`
        UPDATE family_schedule
        SET
          id = COALESCE(id, event_id),
          text = COALESCE(text, title),
          day = COALESCE(day, event_date),
          time = COALESCE(time, event_time),
          type = COALESCE(type, event_type),
          is_weekly = COALESCE(is_weekly, is_recurring, FALSE)
      `;
    } catch {
    }
    await sql`
      CREATE UNIQUE INDEX IF NOT EXISTS family_schedule_id_unique
      ON family_schedule(id)
    `;

    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      code: "TABLE_BOOTSTRAP_FAILED",
      error: `Failed to ensure family_schedule table: ${getErrorMessage(error)}`,
    };
  }
};

const createId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const fixedWeekDateByDayIndex: Partial<Record<number, string>> = {
  0: "2026-02-22",
  2: "2026-02-24",
  4: "2026-02-26",
};

const toIsoDate = (value: string) => {
  const trimmed = value.trim();
  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    return `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}`;
  }

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    return `${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}`;
  }

  return "";
};

const normalizeDateStrict = (rawDate: string, dayIndex: number) => {
  const fixedDate = fixedWeekDateByDayIndex[dayIndex];
  if (fixedDate) {
    return fixedDate;
  }

  const isoDate = toIsoDate(rawDate);
  if (isoDate) {
    return isoDate;
  }

  return "";
};

const normalizeClock = (value: string) => {
  const trimmed = value.trim();
  const hhmm = trimmed.match(/^(\d{1,2}):(\d{2})$/);
  if (hhmm) {
    const hours = Number(hhmm[1]);
    const minutes = Number(hhmm[2]);
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}`;
    }
  }

  const compact = trimmed.match(/^(\d{3,4})$/);
  if (compact) {
    const raw = compact[1].padStart(4, "0");
    const hours = Number(raw.slice(0, 2));
    const minutes = Number(raw.slice(2));
    if (hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59) {
      return `${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}`;
    }
  }

  return null;
};

const tryParseJsonBody = async (request: NextRequest) => {
  try {
    const rawBody = await request.text();
    if (!rawBody || !rawBody.trim()) {
      return { ok: true as const, data: {} as Record<string, unknown> };
    }

    const parsed = JSON.parse(rawBody);
    if (!parsed || typeof parsed !== "object") {
      return { ok: true as const, data: {} as Record<string, unknown> };
    }

    return { ok: true as const, data: parsed as Record<string, unknown> };
  } catch (error) {
    return { ok: false as const, error };
  }
};

const sanitizeDbEvent = (event: unknown) => {
  if (!event || typeof event !== "object") {
    return null;
  }

  const candidate = event as Record<string, unknown>;
  const eventId = typeof candidate.id === "string" && candidate.id.trim()
    ? candidate.id.trim()
    : (typeof candidate.eventId === "string" && candidate.eventId.trim() ? candidate.eventId.trim() : createId());

  const dateRaw = typeof candidate.date === "string"
    ? candidate.date.trim()
    : (typeof candidate.day === "string"
      ? candidate.day.trim()
      : (typeof candidate.event_date === "string"
        ? candidate.event_date.trim()
        : (typeof candidate.eventDate === "string" ? candidate.eventDate.trim() : "")));

  const dayIndexRaw = Number(
    candidate.dayIndex ?? candidate.day_index ?? (typeof dateRaw === "string" && dateRaw ? toDayIndex(dateRaw, 0) : Number.NaN)
  );

  const date = normalizeDateStrict(dateRaw || "", dayIndexRaw);

  const timeRaw = typeof candidate.time === "string"
    ? candidate.time.trim()
    : (typeof candidate.event_time === "string"
      ? candidate.event_time.trim()
      : (typeof candidate.eventTime === "string" ? candidate.eventTime.trim() : ""));
  const time = normalizeClock(timeRaw);

  const child = typeof candidate.child === "string" ? candidate.child.trim().toLowerCase() : "";
  const title = typeof candidate.title === "string"
    ? candidate.title.trim()
    : (typeof candidate.text === "string" ? candidate.text.trim() : "");
  const type = typeof candidate.type === "string"
    ? candidate.type.trim().toLowerCase()
    : (typeof candidate.event_type === "string" ? candidate.event_type.trim().toLowerCase() : "");

  const isRecurring = parseBooleanValue(candidate.isRecurring ?? candidate.is_recurring ?? candidate.is_weekly);
  const recurringTemplateId = typeof candidate.recurringTemplateId === "string" && candidate.recurringTemplateId.trim()
    ? candidate.recurringTemplateId.trim()
    : (typeof candidate.recurring_template_id === "string" && candidate.recurring_template_id.trim()
      ? candidate.recurring_template_id.trim()
      : undefined);
  const completed = parseBooleanValue(candidate.completed);
  const sendNotification = parseBooleanValue(candidate.sendNotification ?? candidate.send_notification ?? true);
  const requireConfirmation = parseBooleanValue(
    candidate.requireConfirmation ?? candidate.require_confirmation ?? candidate.needsAck ?? candidate.needs_ack ?? false
  );
  const needsAck = parseBooleanValue(candidate.needsAck ?? candidate.needs_ack ?? requireConfirmation);
  const userId = typeof candidate.userId === "string" && candidate.userId.trim()
    ? candidate.userId.trim()
    : (typeof candidate.user_id === "string" && candidate.user_id.trim() ? candidate.user_id.trim() : "system");

  if (
    !date ||
    !Number.isInteger(dayIndexRaw) ||
    dayIndexRaw < 0 ||
    dayIndexRaw > 6 ||
    !time ||
    !title ||
    !allowedScheduleChildren.includes(child as (typeof allowedScheduleChildren)[number]) ||
    !type
  ) {
    return null;
  }

  return {
    eventId,
    date,
    dayIndex: dayIndexRaw,
    time,
    child,
    title,
    type,
    isRecurring,
    recurringTemplateId,
    completed,
    sendNotification,
    requireConfirmation,
    needsAck,
    userId,
  };
};

const createIncomingFromFlatBody = (body: Record<string, unknown>) => {
  const day = typeof body.day === "string" ? body.day.trim() : "";
  const time = typeof body.time === "string" ? body.time.trim() : "";
  const child = typeof body.child === "string" ? body.child.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const id = typeof body.id === "string" && body.id.trim()
    ? body.id.trim()
    : (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  if (!day || !time || !child || !type || !text) {
    return null;
  }

  if (!allowedScheduleChildren.includes(child as (typeof allowedScheduleChildren)[number])) {
    return null;
  }

  return sanitizeDbEvent({
    id,
    date: day,
    dayIndex: toDayIndex(day, 0),
    time,
    child,
    title: text,
    type,
    isRecurring: false,
    completed: false,
    sendNotification: true,
    requireConfirmation: false,
    needsAck: false,
  });
};

const toDayIndex = (dayValue: string, fallback: number) => {
  const trimmed = dayValue.trim();
  const numericDay = Number(trimmed);
  if (Number.isInteger(numericDay) && numericDay >= 0 && numericDay <= 6) {
    return numericDay;
  }

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const parsed = new Date(`${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getDay();
    }
  }

  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const parsed = new Date(`${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00`);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.getDay();
    }
  }

  return fallback;
};

const parseBulkEventsFromText = (text: string) => {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) {
    return [] as Array<{
      date: string;
      dayIndex: number;
      time: string;
      child: string;
      title: string;
      type: string;
    }>;
  }

  const dayWordToIndex: Record<string, number> = {
    ראשון: 0,
    שני: 1,
    שלישי: 2,
    רביעי: 3,
    חמישי: 4,
    שישי: 5,
    שבת: 6,
  };
  const events: Array<{
    date: string;
    dayIndex: number;
    time: string;
    child: string;
    title: string;
    type: string;
  }> = [];
  const seenKeys = new Set<string>();

  for (const line of lines) {
    const pairRegex = /(?:^|\s|ב)(?:יום\s*)?(ראשון|שני|שלישי|רביעי|חמישי|שישי|שבת)[^\d]*(\d{1,2}:\d{2}|\d{3,4})/g;
    const pairMatches = [...line.matchAll(pairRegex)];
    if (!pairMatches.length) {
      continue;
    }

    for (const pairMatch of pairMatches) {
      const dayWord = (pairMatch[1] || "").trim();
      const dayIndex = Object.prototype.hasOwnProperty.call(dayWordToIndex, dayWord)
        ? dayWordToIndex[dayWord]
        : -1;
      const normalizedTime = normalizeClock((pairMatch[2] || "").trim());

      if (dayIndex < 0 || !normalizedTime) {
        continue;
      }

      const fixedDate = fixedWeekDateByDayIndex[dayIndex];
      if (!fixedDate) {
        continue;
      }

      const key = `${dayIndex}|${normalizedTime}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      events.push({
        date: fixedDate,
        dayIndex,
        time: normalizedTime,
        child: "amit",
        title: "אימון",
        type: "gym",
      });
    }
  }

  return events;
};

const upsertScheduleEvent = async (incoming: ReturnType<typeof sanitizeDbEvent>) => {
  if (!incoming) {
    return { ok: false as const, error: "Invalid event payload" };
  }

  const tableStatus = await ensureFamilyScheduleTable();
  if (!tableStatus.ok) {
    return tableStatus;
  }

  const columnsStatus = await ensureInsertColumnsExist();
  if (!columnsStatus.ok) {
    return columnsStatus;
  }

  try {
    const newEvent = {
      id: incoming.eventId,
      text: incoming.title,
      day: incoming.date,
      time: incoming.time,
      type: incoming.type,
      child: incoming.child,
      is_weekly: incoming.isRecurring ?? false,
      event_id: incoming.eventId,
      event_date: incoming.date,
      day_index: incoming.dayIndex,
      event_time: incoming.time,
      title: incoming.title,
      event_type: incoming.type,
      is_recurring: incoming.isRecurring ?? false,
      recurring_template_id: incoming.recurringTemplateId ?? null,
      completed: incoming.completed ?? false,
      send_notification: incoming.sendNotification ?? true,
      require_confirmation: incoming.requireConfirmation ?? false,
      needs_ack: incoming.needsAck ?? incoming.requireConfirmation ?? false,
      user_id: incoming.userId ?? "system",
    };
    debugScheduleLog("Data to save:", newEvent);
    console.log("Inserting event:", newEvent);

    let newRow;
    try {
      newRow = await sql`
        INSERT INTO family_schedule (
          id,
          text,
          day,
          time,
          type,
          child,
          is_weekly,
          event_id,
          event_date,
          day_index,
          event_time,
          title,
          event_type,
          is_recurring,
          recurring_template_id,
          completed,
          send_notification,
          require_confirmation,
          needs_ack,
          user_id,
          updated_at
        )
        VALUES (
          ${newEvent.id},
          ${newEvent.text},
          ${newEvent.day},
          ${newEvent.time},
          ${newEvent.type},
          ${newEvent.child},
          ${newEvent.is_weekly},
          ${newEvent.event_id},
          ${newEvent.event_date},
          ${newEvent.day_index},
          ${newEvent.event_time},
          ${newEvent.title},
          ${newEvent.event_type},
          ${newEvent.is_recurring},
          ${newEvent.recurring_template_id},
          ${newEvent.completed},
          ${newEvent.send_notification},
          ${newEvent.require_confirmation},
          ${newEvent.needs_ack},
          ${newEvent.user_id},
          NOW()
        )
        ON CONFLICT (id)
        DO UPDATE SET
          text = EXCLUDED.text,
          day = EXCLUDED.day,
          time = EXCLUDED.time,
          type = EXCLUDED.type,
          child = EXCLUDED.child,
          is_weekly = EXCLUDED.is_weekly,
          event_id = EXCLUDED.event_id,
          event_date = EXCLUDED.event_date,
          day_index = EXCLUDED.day_index,
          event_time = EXCLUDED.event_time,
          title = EXCLUDED.title,
          event_type = EXCLUDED.event_type,
          is_recurring = EXCLUDED.is_recurring,
          recurring_template_id = EXCLUDED.recurring_template_id,
          completed = EXCLUDED.completed,
          send_notification = EXCLUDED.send_notification,
          require_confirmation = EXCLUDED.require_confirmation,
          needs_ack = EXCLUDED.needs_ack,
          user_id = EXCLUDED.user_id,
          updated_at = NOW()
        RETURNING *
      `;
    } catch (error) {
      const dbError = formatDbError(error);
      console.error("[API] SQL insert into family_schedule failed", {
        dbError,
        rawError: error,
        newEvent,
      });
      return {
        ok: false as const,
        error: `DB insert failed: ${dbError}`,
      };
    }

    debugScheduleLog("DB Action Success:", newRow.rowCount);

    if (!newRow.rowCount || newRow.rowCount < 1) {
      return { ok: false as const, error: "Insert did not return a positive DB response" };
    }

    const saved = newRow.rows[0];
    if (!saved) {
      return { ok: false as const, error: "Saved row was not found" };
    }

    debugScheduleLog("Saved successfully:", newRow.rows[0]);

    const savedDateRaw = String(saved.event_date ?? saved.day ?? "").trim();
    const savedDate = toIsoDate(savedDateRaw) || savedDateRaw;
    const savedChildRaw = String(saved.child ?? "").trim().toLowerCase();
    const savedChild = allowedScheduleChildren.includes(savedChildRaw as (typeof allowedScheduleChildren)[number])
      ? savedChildRaw
      : "amit";

    return {
      ok: true as const,
      row: newRow.rows[0],
      event: {
        id: String(saved.id),
        date: savedDate,
        dayIndex: toDayIndex(savedDate, incoming.dayIndex),
        time: String(saved.time),
        child: savedChild,
        title: String(saved.text),
        type: String(saved.type),
        isRecurring: parseBooleanValue(saved.is_recurring ?? saved.is_weekly),
        recurringTemplateId: typeof saved.recurring_template_id === "string" && saved.recurring_template_id.trim()
          ? saved.recurring_template_id.trim()
          : undefined,
        completed: parseBooleanValue(saved.completed),
        sendNotification: parseBooleanValue(saved.send_notification),
        requireConfirmation: parseBooleanValue(saved.needs_ack ?? saved.require_confirmation),
      },
    };
  } catch (error) {
    console.error("[API] SQL upsert failed", {
      error,
      message: getErrorMessage(error),
      incoming,
    });
    return {
      ok: false as const,
      error: `Failed to upsert event: ${getErrorMessage(error)}`,
    };
  }
};

export async function GET() {
  try {
    debugScheduleLog('[API] GET /api/schedule');
    const tableStatus = await ensureFamilyScheduleTable();
    if (!tableStatus.ok) {
      if (tableStatus.code === "MISSING_POSTGRES_ENV") {
        return NextResponse.json([]);
      }
      return NextResponse.json({ error: tableStatus.error }, { status: 500 });
    }

    const result = await sql`
      SELECT
        id,
        COALESCE(event_date, day) AS event_date,
        day_index,
        COALESCE(event_time, time) AS event_time,
        child,
        COALESCE(title, text) AS title,
        COALESCE(event_type, type) AS event_type,
        COALESCE(is_recurring, is_weekly, FALSE) AS is_recurring,
        recurring_template_id,
        COALESCE(completed, FALSE) AS completed,
        COALESCE(send_notification, TRUE) AS send_notification,
        COALESCE(require_confirmation, FALSE) AS require_confirmation,
        COALESCE(needs_ack, require_confirmation, FALSE) AS needs_ack
      FROM family_schedule
      ORDER BY COALESCE(event_time, time) ASC
    `;
    debugScheduleLog("DB Action Success:", result.rowCount);

    const rows = result.rows;
    debugScheduleLog("Events found in DB:", rows);

    const events = rows.map((row) => {
      const rawDate = String(row.event_date ?? "").trim();
      const normalizedDate = toIsoDate(rawDate) || rawDate;
      const rawChild = String(row.child ?? "").trim().toLowerCase();
      const normalizedChild = allowedScheduleChildren.includes(rawChild as (typeof allowedScheduleChildren)[number])
        ? rawChild
        : "amit";

      return {
        id: row.id,
        date: normalizedDate,
        dayIndex: toDayIndex(normalizedDate, Number.isInteger(Number(row.day_index)) ? Number(row.day_index) : 0),
        time: row.event_time,
        child: normalizedChild,
        title: row.title,
        type: row.event_type,
        isRecurring: parseBooleanValue(row.is_recurring),
        recurringTemplateId: typeof row.recurring_template_id === "string" && row.recurring_template_id.trim()
          ? row.recurring_template_id.trim()
          : undefined,
        completed: parseBooleanValue(row.completed),
        sendNotification: parseBooleanValue(row.send_notification),
        requireConfirmation: parseBooleanValue(row.needs_ack ?? row.require_confirmation),
      };
    });

    return NextResponse.json({ events });
  } catch (error) {
    console.error('[API] GET /api/schedule failed', error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    console.log('[API] PUT /api/schedule');
    const parsedBody = await tryParseJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const body = parsedBody.data;
    const incoming = sanitizeDbEvent(body?.event);
    if (!incoming) {
      return NextResponse.json({ error: "Invalid event payload" }, { status: 400 });
    }

    const upsertResult = await upsertScheduleEvent(incoming);
    if (!upsertResult.ok) {
      return NextResponse.json({ error: upsertResult.error }, { status: 500 });
    }

    return NextResponse.json({ ok: true, event: upsertResult.event });
  } catch (error) {
    console.error('[API] PUT /api/schedule failed', error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    console.log('[API] DELETE /api/schedule');
    const tableStatus = await ensureFamilyScheduleTable();
    if (!tableStatus.ok) {
      if (tableStatus.code === "MISSING_POSTGRES_ENV") {
        return NextResponse.json([]);
      }
      return NextResponse.json({ error: tableStatus.error }, { status: 500 });
    }

    const url = new URL(request.url);
    const queryId = url.searchParams.get("id")?.trim() || "";
    const queryRecurringTemplateId = url.searchParams.get("recurringTemplateId")?.trim() || "";
    const queryClearAllRaw = url.searchParams.get("clearAll")?.trim().toLowerCase() || "";
    const queryClearAll = queryClearAllRaw === "1" || queryClearAllRaw === "true";
    const queryPassword = url.searchParams.get("password")?.trim() || "";
    const headerPassword = request.headers.get("x-delete-password")?.trim() || "";

    const parsedBody = await tryParseJsonBody(request);
    if (!parsedBody.ok && !queryId && !queryRecurringTemplateId && !queryClearAll) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const body = parsedBody.ok ? parsedBody.data : {};
    const bodyClearAll = Boolean(body?.clearAll);
    const bodyEventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
    const bodyRecurringTemplateId = typeof body?.recurringTemplateId === "string" ? body.recurringTemplateId.trim() : "";
    const bodyPassword = typeof body?.password === "string" ? body.password.trim() : "";

    const providedDeletePassword = headerPassword || queryPassword || bodyPassword;
    const expectedDeletePassword = process.env.DELETE_PASSWORD?.trim() || "2101";
    if (!providedDeletePassword || providedDeletePassword !== expectedDeletePassword) {
      return NextResponse.json({ error: "Invalid delete password" }, { status: 403 });
    }

    const clearAll = queryClearAll || bodyClearAll;
    const eventId = queryId || bodyEventId;
    const recurringTemplateId = queryRecurringTemplateId || bodyRecurringTemplateId;

    if (!clearAll && !eventId && !recurringTemplateId) {
      return NextResponse.json({ error: "id (or eventId) or recurringTemplateId is required" }, { status: 400 });
    }

    if (clearAll) {
      await sql`DELETE FROM family_schedule`;
      return NextResponse.json({ ok: true });
    }

    if (recurringTemplateId) {
      await sql`
        DELETE FROM family_schedule
        WHERE id = ${recurringTemplateId}
           OR id = ${eventId}
      `;
    } else {
      await sql`
        DELETE FROM family_schedule
        WHERE id = ${eventId}
      `;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error('[API] DELETE /api/schedule failed', error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const tableStatus = await ensureFamilyScheduleTable();
    if (!tableStatus.ok) {
      if (tableStatus.code === "MISSING_POSTGRES_ENV") {
        return NextResponse.json({ error: "Missing database configuration" }, { status: 500 });
      }
      return NextResponse.json({ error: tableStatus.error }, { status: 500 });
    }

    const parsedBody = await tryParseJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const body = parsedBody.data;
    const action = typeof body?.action === "string" ? body.action.trim() : "";
    if (action !== "confirm" && action !== "unconfirm") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
    if (!eventId) {
      return NextResponse.json({ error: "eventId is required" }, { status: 400 });
    }

    const confirmedByRaw = typeof body?.confirmedBy === "string" ? body.confirmedBy.trim() : "";
    const nextCompleted = action === "confirm";

    const updated = await sql`
      UPDATE family_schedule
      SET completed = ${nextCompleted},
          updated_at = NOW()
      WHERE id = ${eventId}
      RETURNING id, COALESCE(title, text) AS title, child, completed
    `;

    const row = updated.rows[0];
    if (!row) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const childKey = String(row.child || "").trim().toLowerCase();
    const fallbackConfirmer = childLabelMap[childKey] || "הילד";
    const confirmer = confirmedByRaw || fallbackConfirmer;
    const taskTitle = String(row.title || "משימה").trim() || "משימה";

    if (nextCompleted) {
      await sendPushToParents({
        title: "אישור משימה",
        body: `${confirmer} אישר את המשימה: ${taskTitle}`,
        url: "/",
      });
    }

    return NextResponse.json({ ok: true, eventId, completed: nextCompleted, confirmedBy: confirmer, title: taskTitle });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

const sanitizeEvents = (events: unknown): AiEvent[] => {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.reduce<AiEvent[]>((acc, item) => {
      if (!item || typeof item !== "object") {
        return acc;
      }

      const candidate = item as Record<string, unknown>;
      const dayIndex = Number(candidate.dayIndex);
      const time = typeof candidate.time === "string" ? candidate.time.trim() : "";
      const child = typeof candidate.child === "string" ? candidate.child : "";
      const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
      const type = typeof candidate.type === "string" ? candidate.type : "";
      const recurringWeekly = typeof candidate.recurringWeekly === "boolean"
        ? candidate.recurringWeekly
        : (typeof candidate.isRecurring === "boolean" ? candidate.isRecurring : false);

      if (
        !Number.isInteger(dayIndex) ||
        dayIndex < 0 ||
        dayIndex > 6 ||
        !time ||
        !title ||
        !allowedChildren.includes(child as ChildKey) ||
        !allowedTypes.includes(type as EventType)
      ) {
        return acc;
      }

      acc.push({
        dayIndex,
        time,
        child: child as ChildKey,
        title,
        type: type as EventType,
        recurringWeekly,
      });

      return acc;
    }, []);
};

const isSupportedModel = (value: unknown): value is SupportedModel =>
  typeof value === "string" && allowedModels.includes(value as SupportedModel);

const normalizeModel = (value: unknown, fallback: SupportedModel): SupportedModel => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (isSupportedModel(normalized)) {
    return normalized;
  }

  return modelAliasMap[normalized] ?? fallback;
};

export async function POST(request: NextRequest) {
  console.log('[API] POST /api/schedule');

  try {
    const tableStatus = await ensureFamilyScheduleTable();
    if (!tableStatus.ok) {
      if (tableStatus.code === "MISSING_POSTGRES_ENV") {
        return NextResponse.json({ error: "Missing database configuration" }, { status: 500 });
      }
      return NextResponse.json({ error: tableStatus.error }, { status: 500 });
    }

    const parsedBody = await tryParseJsonBody(request);
    if (!parsedBody.ok) {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    const body = parsedBody.data as Record<string, unknown>;
    const senderSubscriptionEndpoint = typeof body?.senderSubscriptionEndpoint === "string"
      ? body.senderSubscriptionEndpoint.trim()
      : "";

    const bulkEventsPayload = Array.isArray(body?.bulkEvents)
      ? body.bulkEvents as Array<Record<string, unknown>>
      : [];
    if (bulkEventsPayload.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let upsertResults: any[] = [];
      try {
        upsertResults = await Promise.all(bulkEventsPayload.map(async (bulkItem) => {
          const incoming = sanitizeDbEvent(bulkItem);
          if (!incoming) {
            return { ok: false as const, error: "Invalid bulk event payload" };
          }
          const upsertResult = await upsertScheduleEvent(incoming);
          if (!upsertResult.ok) {
            console.error("[API] POST /api/schedule bulk upsert failed", {
              error: upsertResult.error,
              bulkItem,
            });
            return { ok: false as const, error: upsertResult.error };
          }
          return { ok: true as const, row: upsertResult.row, event: upsertResult.event };
        }));
      } catch (error) {
        console.error("[API] POST /api/schedule bulk save crashed", {
          error,
          message: getErrorMessage(error),
          bulkEventsPayload,
        });
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
      }

      if (!upsertResults || upsertResults.length === 0) {
        return NextResponse.json({ error: "Bulk upsert returned no results" }, { status: 500 });
      }

      const failed = upsertResults.find((result) => !result?.ok);
      if (failed) {
        return NextResponse.json({ error: failed.error }, { status: 500 });
      }

      const savedEvents = upsertResults
        .filter((result) => result?.ok === true && result?.event)
        .map((result) => result.event);

      return NextResponse.json({ ok: true, events: savedEvents });
    }

    const flatIncoming = createIncomingFromFlatBody(body);
    if (flatIncoming) {
      const upsertResult = await upsertScheduleEvent(flatIncoming);
      if (!upsertResult.ok) {
        console.error("[API] POST /api/schedule upsert failed (flatIncoming)", {
          error: upsertResult.error,
          flatIncoming,
        });
        return NextResponse.json({ error: upsertResult.error }, { status: 500 });
      }

      await sendPushToAll(
        {
          title: "משימה חדשה נוספה",
          body: `${flatIncoming.title} - ${flatIncoming.time}`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      return NextResponse.json(upsertResult.row);
    }

    const nestedEvent = body?.event && typeof body.event === "object"
      ? (body.event as Record<string, unknown>)
      : null;
    const nestedFlatIncoming = nestedEvent ? createIncomingFromFlatBody(nestedEvent) : null;
    const incoming = sanitizeDbEvent(body?.event) ?? nestedFlatIncoming;
    if (incoming) {
      const upsertResult = await upsertScheduleEvent(incoming);
      if (!upsertResult.ok) {
        console.error("[API] POST /api/schedule upsert failed (incoming)", {
          error: upsertResult.error,
          incoming,
        });
        return NextResponse.json({ error: upsertResult.error }, { status: 500 });
      }

      await sendPushToAll(
        {
          title: "משימה חדשה נוספה",
          body: `${incoming.title} - ${incoming.time}`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      return NextResponse.json(upsertResult.row);
    }

    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const weekStart = typeof body?.weekStart === "string" ? body.weekStart.trim() : "";
    const systemPrompt = typeof body?.systemPrompt === "string" ? body.systemPrompt.trim() : "";
    const requestedModel = normalizeModel(body?.model, defaultModel);
    const fallbackModel = normalizeModel(body?.fallbackModel, defaultFallbackModel);
    const imagePart = body?.imagePart as Record<string, unknown> | undefined;
    const incomingInlineData = imagePart?.inlineData as Record<string, unknown> | undefined;
    const imageBase64 = typeof incomingInlineData?.data === "string"
      ? incomingInlineData.data.trim()
      : (typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : "");
    const imageMimeType = typeof incomingInlineData?.mimeType === "string"
      ? incomingInlineData.mimeType.trim()
      : (typeof body?.imageMimeType === "string" ? body.imageMimeType.trim() : "image/png");

    const bulkFromText = text ? parseBulkEventsFromText(text) : [];
    if (bulkFromText.length > 0) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let upsertResults: any[] = [];
      try {
        upsertResults = await Promise.all(bulkFromText.map(async (item) => {
          const generatedId = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
            ? crypto.randomUUID()
            : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
          const incoming = sanitizeDbEvent({
            id: generatedId,
            date: item.date,
            dayIndex: item.dayIndex,
            time: item.time,
            child: "amit",
            title: item.title,
            type: item.type,
            isRecurring: false,
            completed: false,
            sendNotification: true,
            requireConfirmation: false,
            needsAck: false,
          });
          if (!incoming) {
            return { ok: false as const, error: "Invalid bulk text event payload" };
          }

          const upsertResult = await upsertScheduleEvent(incoming);
          if (!upsertResult.ok) {
            console.error("[API] POST /api/schedule bulk-text upsert failed", {
              error: upsertResult.error,
              item,
              incoming,
            });
            return { ok: false as const, error: upsertResult.error };
          }
          return { ok: true as const, row: upsertResult.row, event: upsertResult.event };
        }));
      } catch (error) {
        console.error("[API] POST /api/schedule bulk-text save crashed", {
          error,
          message: getErrorMessage(error),
          bulkFromText,
        });
        return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
      }

      if (!upsertResults || upsertResults.length === 0) {
        return NextResponse.json({ error: "Bulk text upsert returned no results" }, { status: 500 });
      }

      const failed = upsertResults.find((result) => !result?.ok);
      if (failed) {
        return NextResponse.json({ error: failed.error }, { status: 500 });
      }

      const successfulCount = upsertResults.filter((result) => result?.ok === true).length;
 
      const savedEvents = upsertResults
        .filter((result) => result?.ok === true && result?.event)
        .map((result) => result.event);

      if (!savedEvents.length || savedEvents.length !== successfulCount) {
        return NextResponse.json({ error: "No valid bulk events were found" }, { status: 400 });
      }

      await sendPushToAll(
        {
          title: "משימות חדשות נוספו",
          body: `נוספו ${savedEvents.length} אימונים לעמית לשבוע הקרוב`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      return NextResponse.json({ ok: true, events: savedEvents });
    }

    if (!text && !imageBase64) {
      return NextResponse.json({ error: "Text or image is required" }, { status: 400 });
    }

    const apiKey = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
    if (!apiKey) {
      return NextResponse.json(
        { error: "Missing GEMINI_API_KEY (or NEXT_PUBLIC_GEMINI_API_KEY) on server" },
        { status: 500 }
      );
    }

    const basePrompt = `אתה עוזר לו"ז משפחתי. נתח את הטקסט והחזר רק JSON תקין של מערך אירועים.
שבוע העבודה הוא:
0=יום ראשון, 1=יום שני, 2=יום שלישי, 3=יום רביעי, 4=יום חמישי, 5=יום שישי, 6=שבת
ילדים מותרים: ravid, amit, alin
סוגים מותרים: dog, gym, sport, lesson, dance
פורמט חובה לכל איבר:
{ "dayIndex": number, "time": string, "child": "ravid|amit|alin", "title": string, "type": "dog|gym|sport|lesson|dance" }

אם מתקבלת תמונה, בצע OCR וחלץ ממנה ימים/שעות/ילד.
החזר תמיד אך ורק מערך JSON, גם אם יש אירוע יחיד. ללא טקסט נוסף.
  תאריך תחילת השבוע שמוצג כרגע: ${weekStart || "לא ידוע"}
טקסט משתמש:
${text}`;

    const prompt = systemPrompt ? `${systemPrompt}\n\n${basePrompt}` : basePrompt;

    const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: prompt }];
    if (imageBase64) {
      userParts.push({
        inlineData: {
          mimeType: imageMimeType || "image/png",
          data: imageBase64,
        },
      });
    }

    const requestBody = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: userParts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
      },
    });

    const callGemini = async (version: "v1beta" | "v1", model: string) =>
      fetch(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: requestBody,
        }
      );

    const modelChain: SupportedModel[] = requestedModel === fallbackModel
      ? [requestedModel]
      : [requestedModel, fallbackModel];

    let response: Response | null = null;

    for (const model of modelChain) {
      response = await callGemini("v1beta", model);
      if (response.status !== 404) {
        break;
      }

      response = await callGemini("v1", model);
      if (response.status !== 404) {
        break;
      }
    }

    if (!response) {
      return NextResponse.json(
        { error: "Gemini request failed: no response" },
        { status: 502 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Gemini request failed: ${errorText}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const textOutput: string =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part?.text || "")
        .join("") || "";

    const rawJson = extractJsonArray(textOutput);
    if (!rawJson) {
      return NextResponse.json({ events: [] });
    }

    const parsed = JSON.parse(rawJson);
    const events = sanitizeEvents(parsed);

    return NextResponse.json({ events });
  } catch (error) {
    console.error('[API] POST /api/schedule failed', error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
