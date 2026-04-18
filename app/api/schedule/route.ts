import { NextRequest, NextResponse } from "next/server";
import { ensureDatabaseConnectionString, getDatabaseConfig, sql, sqlJson } from "@/app/lib/db";
import {
  buildMetadataFromIncoming,
  ensureScheduleMetadataColumn,
  parseScheduleMetadata,
} from "@/app/lib/scheduleTable";
import { sendPushToAll, sendPushToParents, sendUpcomingTaskReminders } from "@/app/lib/push";

export const revalidate = 0;

const dbConfig = getDatabaseConfig();
const activeDatabaseUrl = dbConfig.url;
const isVerboseScheduleLogs = process.env.SCHEDULE_VERBOSE_LOGS === "1";
const debugScheduleLog = (...args: unknown[]) => {
  if (isVerboseScheduleLogs) {
    console.log(...args);
  }
};

debugScheduleLog("Syncing with Postgres: ", activeDatabaseUrl ? "CONNECTED" : "MISSING");
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

const childTargetLabelMap: Record<string, string> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  amit_alin: "עמית ואלין",
  alin_ravid: "אלין ורביד",
  amit_ravid: "עמית ורביד",
};

const getChildTargetLabel = (rawChild: unknown) => {
  const key = typeof rawChild === "string" ? rawChild.trim().toLowerCase() : "";
  return childTargetLabelMap[key] || "הילדים";
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

const reminderLeadOptions = [5, 10, 15, 30] as const;
const parseReminderLeadMinutes = (value: unknown) => {
  const numeric = Number(value);
  return reminderLeadOptions.includes(numeric as (typeof reminderLeadOptions)[number]) ? numeric : null;
};

const ensurePostgresEnv = () => {
  const config = ensureDatabaseConnectionString();
  if (!config?.url) {
    return "MISSING_POSTGRES_ENV";
  }

  return null;
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

/** Supabase: use pre-created `public.schedule` (id, title, date) + JSONB metadata. No CREATE TABLE here. */
const ensureScheduleTableReady = async () => {
  const envError = ensurePostgresEnv();
  if (envError) {
    return { ok: false as const, code: envError, error: envError };
  }

  try {
    await ensureScheduleMetadataColumn();
    return { ok: true as const };
  } catch (error) {
    return {
      ok: false as const,
      code: "TABLE_BOOTSTRAP_FAILED",
      error: `Failed to ensure schedule.metadata column: ${getErrorMessage(error)}`,
    };
  }
};

const createId = () => (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
  ? crypto.randomUUID()
  : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

const toIsoDate = (value: string) => {
  const trimmed = value.trim();
  // Postgres / JS may serialize dates as full ISO strings (e.g. 2026-04-20T00:00:00.000Z).
  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (yyyyMmDd) {
    return `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}`;
  }

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    return `${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}`;
  }

  return "";
};

const normalizeDateStrict = (rawDate: string, _dayIndex: number) => {
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
  const zoomLink = typeof candidate.zoomLink === "string"
    ? candidate.zoomLink.trim()
    : (typeof candidate.zoom_link === "string" ? candidate.zoom_link.trim() : "");
  const type = typeof candidate.type === "string"
    ? candidate.type.trim().toLowerCase()
    : (typeof candidate.event_type === "string" ? candidate.event_type.trim().toLowerCase() : "");

  /** Do not read `is_weekly` — legacy key can wrongly mark rows as recurring. */
  const isRecurring = parseBooleanValue(candidate.isRecurring ?? candidate.is_recurring);
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
  const reminderLeadMinutes = parseReminderLeadMinutes(
    candidate.reminderLeadMinutes ?? candidate.reminder_lead_minutes
  );
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
    zoomLink: zoomLink || undefined,
    type,
    isRecurring,
    recurringTemplateId,
    completed,
    sendNotification,
    requireConfirmation,
    needsAck,
    reminderLeadMinutes,
    userId,
  };
};

const createIncomingFromFlatBody = (body: Record<string, unknown>) => {
  const day = typeof body.day === "string" ? body.day.trim() : "";
  const time = typeof body.time === "string" ? body.time.trim() : "";
  const child = typeof body.child === "string" ? body.child.trim() : "";
  const type = typeof body.type === "string" ? body.type.trim() : "";
  const text = typeof body.text === "string" ? body.text.trim() : "";
  const zoomLink = typeof body.zoomLink === "string"
    ? body.zoomLink.trim()
    : (typeof body.zoom_link === "string" ? body.zoom_link.trim() : "");
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
    zoomLink,
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

/** Calendar date for dayIndex (0=Sun..6=Sat) within the week that starts on weekStartYyyyMmDd (Sunday). */
const dateForWeekDay = (weekStartYyyyMmDd: string, dayIndex: number): string | null => {
  const iso = toIsoDate(weekStartYyyyMmDd);
  if (!iso || dayIndex < 0 || dayIndex > 6) {
    return null;
  }
  const [y, m, d] = iso.split("-").map(Number);
  const base = new Date(y, m - 1, d);
  if (Number.isNaN(base.getTime())) {
    return null;
  }
  base.setDate(base.getDate() + dayIndex);
  const yy = base.getFullYear();
  const mm = `${base.getMonth() + 1}`.padStart(2, "0");
  const dd = `${base.getDate()}`.padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const defaultWeekStartIso = (): string => {
  const now = new Date();
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - start.getDay());
  const yy = start.getFullYear();
  const mm = `${start.getMonth() + 1}`.padStart(2, "0");
  const dd = `${start.getDate()}`.padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
};

const parseBulkEventsFromText = (text: string, weekStartIso: string) => {
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

      const resolvedDate = dateForWeekDay(weekStartIso, dayIndex);
      if (!resolvedDate) {
        continue;
      }

      const key = `${dayIndex}|${normalizedTime}`;
      if (seenKeys.has(key)) {
        continue;
      }
      seenKeys.add(key);

      events.push({
        date: resolvedDate,
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

  const tableStatus = await ensureScheduleTableReady();
  if (!tableStatus.ok) {
    return tableStatus;
  }

  try {
    const existingRow = await sql`
      SELECT metadata FROM schedule WHERE id = ${incoming.eventId} LIMIT 1
    `;
    const previousMeta =
      existingRow.rows[0] && existingRow.rows[0].metadata != null
        ? parseScheduleMetadata(existingRow.rows[0].metadata)
        : null;

    const metadataPayload = buildMetadataFromIncoming({
      ...incoming,
      notified: previousMeta?.notified ?? false,
    });

    debugScheduleLog("Data to save:", { id: incoming.eventId, title: incoming.title, date: incoming.date, metadataPayload });
    console.log("Inserting event:", incoming.eventId);

    let newRow;
    try {
      newRow = await sql`
        INSERT INTO schedule (id, title, "date", metadata)
        VALUES (
          ${incoming.eventId},
          ${incoming.title},
          ${incoming.date},
          ${sqlJson(metadataPayload)}
        )
        ON CONFLICT (id)
        DO UPDATE SET
          title = EXCLUDED.title,
          "date" = EXCLUDED."date",
          metadata = EXCLUDED.metadata
        RETURNING *
      `;
    } catch (error) {
      const dbError = formatDbError(error);
      console.error("[API] SQL insert into schedule failed", {
        dbError,
        rawError: error,
        incoming,
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

    const saved = newRow.rows[0] as Record<string, unknown>;
    if (!saved) {
      return { ok: false as const, error: "Saved row was not found" };
    }

    debugScheduleLog("Saved successfully:", saved);

    const savedDateRaw = String(saved.date ?? "").trim();
    const savedDate = toIsoDate(savedDateRaw) || savedDateRaw;
    const meta = parseScheduleMetadata(saved.metadata);
    const savedChildRaw = meta.child.trim().toLowerCase();
    const savedChild = allowedScheduleChildren.includes(savedChildRaw as (typeof allowedScheduleChildren)[number])
      ? savedChildRaw
      : "amit";

    return {
      ok: true as const,
      row: saved,
      event: {
        id: String(saved.id),
        date: savedDate,
        dayIndex: toDayIndex(savedDate, meta.dayIndex),
        time: meta.time,
        child: savedChild,
        title: String(saved.title),
        zoomLink: meta.zoomLink?.trim() ? meta.zoomLink.trim() : undefined,
        type: meta.type,
        isRecurring: meta.isRecurring,
        recurringTemplateId: meta.recurringTemplateId?.trim() ? meta.recurringTemplateId.trim() : undefined,
        completed: meta.completed,
        sendNotification: meta.sendNotification,
        requireConfirmation: meta.needsAck ?? meta.requireConfirmation,
        reminderLeadMinutes: parseReminderLeadMinutes(meta.reminderLeadMinutes),
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

const runReminderSweep = async (source: string) => {
  try {
    const reminderResult = await sendUpcomingTaskReminders();
    console.log(`[API] Reminder sweep (${source}):`, reminderResult);
  } catch (error) {
    console.error(`[API] Reminder sweep failed (${source})`, error);
  }
};

export async function GET() {
  try {
    debugScheduleLog('[API] GET /api/schedule');
    const tableStatus = await ensureScheduleTableReady();
    if (!tableStatus.ok) {
      if (tableStatus.code === "MISSING_POSTGRES_ENV") {
        return NextResponse.json([]);
      }
      return NextResponse.json({ error: tableStatus.error }, { status: 500 });
    }

    // Reminders run on /api/notifications/check (client interval) and cron routes — do not block every schedule read.
    void sendUpcomingTaskReminders().then(
      (reminderResult) => {
        debugScheduleLog("Reminder sweep (async after GET):", reminderResult);
      },
      (error) => {
        console.error("[API] Reminder sweep failed (async after GET)", error);
      },
    );

    const result = await sql`
      SELECT id, title, "date", metadata
      FROM schedule
      ORDER BY "date" ASC, COALESCE(metadata->>'time', '00:00') ASC
    `;
    debugScheduleLog("DB Action Success:", result.rowCount);

    const rows = result.rows;
    debugScheduleLog("Events found in DB:", rows);

    const events = rows.map((row) => {
      const r = row as { id: string; title: string; date: string; metadata: unknown };
      const rawDate = String(r.date ?? "").trim();
      const normalizedDate = toIsoDate(rawDate) || rawDate;
      const meta = parseScheduleMetadata(r.metadata);
      const rawChild = meta.child.trim().toLowerCase();
      const normalizedChild = allowedScheduleChildren.includes(rawChild as (typeof allowedScheduleChildren)[number])
        ? rawChild
        : "amit";

      return {
        id: r.id,
        date: normalizedDate,
        dayIndex: toDayIndex(normalizedDate, meta.dayIndex),
        time: meta.time,
        child: normalizedChild,
        title: r.title,
        zoomLink: meta.zoomLink?.trim() ? meta.zoomLink.trim() : undefined,
        type: meta.type,
        isRecurring: meta.isRecurring,
        recurringTemplateId: meta.recurringTemplateId?.trim() ? meta.recurringTemplateId.trim() : undefined,
        completed: meta.completed,
        sendNotification: meta.sendNotification,
        requireConfirmation: meta.needsAck ?? meta.requireConfirmation,
        reminderLeadMinutes: parseReminderLeadMinutes(meta.reminderLeadMinutes),
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
    const tableStatus = await ensureScheduleTableReady();
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
      await sql`DELETE FROM schedule`;
      return NextResponse.json({ ok: true });
    }

    if (recurringTemplateId) {
      const removed = await sql`
        DELETE FROM schedule
        WHERE id = ${recurringTemplateId}
           OR id = ${eventId}
           OR metadata->>'recurringTemplateId' = ${recurringTemplateId}
        RETURNING id
      `;
      return NextResponse.json({ ok: true, deleted: removed.rowCount ?? removed.rows?.length ?? 0 });
    }

    const removed = await sql`
      DELETE FROM schedule
      WHERE id = ${eventId}
      RETURNING id
    `;
    return NextResponse.json({ ok: true, deleted: removed.rowCount ?? removed.rows?.length ?? 0 });
  } catch (error) {
    console.error('[API] DELETE /api/schedule failed', error);
    return Response.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const tableStatus = await ensureScheduleTableReady();
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

    const completedJson = JSON.stringify(nextCompleted);
    const updated = await sql`
      UPDATE schedule
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{completed}',
        ${completedJson}::jsonb,
        true
      )
      WHERE id = ${eventId}
      RETURNING id, title, metadata
    `;

    const row = updated.rows[0] as { id?: string; title?: string; metadata?: unknown } | undefined;
    if (!row) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const meta = parseScheduleMetadata(row.metadata);
    const childKey = meta.child.trim().toLowerCase();
    const fallbackConfirmer = childLabelMap[childKey] || "הילד";
    const confirmer = confirmedByRaw || fallbackConfirmer;
    const taskTitle = String(row?.title || "משימה").trim() || "משימה";

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
    const tableStatus = await ensureScheduleTableReady();
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

      await runReminderSweep("POST bulkEvents");

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
          body: `נוספה משימה ל${getChildTargetLabel(flatIncoming.child)}: ${flatIncoming.title} - ${flatIncoming.time}`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      await runReminderSweep("POST flatIncoming");

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
          body: `נוספה משימה ל${getChildTargetLabel(incoming.child)}: ${incoming.title} - ${incoming.time}`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      await runReminderSweep("POST incoming");

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

    const bulkWeekStart = weekStart || defaultWeekStartIso();
    const bulkFromText = text ? parseBulkEventsFromText(text, bulkWeekStart) : [];
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

      const bulkChildren = [...new Set(savedEvents.map((event) => getChildTargetLabel(event.child)))];
      const bulkChildrenText = bulkChildren.length > 0 ? bulkChildren.join(", ") : "הילדים";
      await sendPushToAll(
        {
          title: "משימות חדשות נוספו",
          body: `נוספו ${savedEvents.length} משימות עבור: ${bulkChildrenText}`,
          url: "/",
        },
        { excludeEndpoint: senderSubscriptionEndpoint }
      );

      await runReminderSweep("POST bulkFromText");

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
