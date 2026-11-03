import { sql } from "@/app/lib/db";
import { parseScheduleMetadata } from "@/app/lib/scheduleTable";
import { fallbackRoster, type FamilyRoster } from "@/app/lib/familyMembers";
import { loadFamilyRoster, peekFamilyRoster } from "@/app/lib/familyRosterStore";
import {
  inferNotificationCategory,
  notificationChannelProfile,
  type NotificationCategory,
} from "@/app/lib/notificationCategory";
import webpush from "web-push";

type PushPayload = {
  title: string;
  body: string;
  url?: string;
  /** Channel the service worker groups by: game, medical, training, or general. */
  category?: NotificationCategory | string;
  tag?: string;
  actions?: Array<{ action: string; title: string }>;
  confirmTask?: {
    eventId: string;
    eventTitle: string;
    childName: string;
  };
};

type SubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
  user_name: string | null;
  receive_all: boolean | null;
  watch_children: string | null;
  reminder_lead_minutes: number | null;
};

type TaskRow = {
  id: string;
  text: string;
  day: string;
  time: string;
  child: string;
  type: string;
  is_weekly?: boolean;
  completed?: boolean;
  notified?: boolean;
  send_notification?: boolean;
  require_confirmation?: boolean;
  needs_ack?: boolean;
  reminder_lead_minutes?: number | null;
  notification_category?: NotificationCategory | null;
};

type ChildUserName = string;
type ParentUserName = string;
type AllowedUserName = string;

const childNameSetOf = (roster: FamilyRoster) => new Set<string>(roster.pushChildNames);
const parentNameSetOf = (roster: FamilyRoster) => new Set<string>(roster.pushParentNames);

const isChildUserName = (value: string, roster: FamilyRoster): value is ChildUserName => roster.isChildPushName(value);
const isParentUserName = (value: string, roster: FamilyRoster): value is ParentUserName => roster.isParentPushName(value);

const normalizeAllowedUserName = (value: unknown, roster: FamilyRoster = fallbackRoster): AllowedUserName | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const direct = roster.resolvePushName(trimmed);
  if (direct) {
    return direct;
  }

  try {
    const decoded = Buffer.from(trimmed, "latin1").toString("utf8").trim();
    return roster.resolvePushName(decoded);
  } catch {
    return null;
  }
};

const normalizeTaskParentNames = (rawChild: string, roster: FamilyRoster): ParentUserName[] =>
  roster.parentPushNamesFromField(rawChild);

const normalizeTaskChildNames = (rawChild: string, roster: FamilyRoster): ChildUserName[] => {
  const fromKeys = roster.childPushNamesFromField(rawChild);
  if (fromKeys.length) {
    return fromKeys;
  }
  return roster.pushChildNames.filter((name) => name && rawChild.includes(name));
};

const reminderLeadOptions = [5, 10, 15, 30, 60, 120, 1440] as const;

/** 90 -> "שעה ו-30 דקות", 1440 -> "יום", 45 -> "45 דקות" */
const formatMinutesHe = (total: number) => {
  if (total >= 1440) return total === 1440 ? "24 שעות" : `${Math.round(total / 60)} שעות`;
  if (total >= 120) return `${Math.floor(total / 60)} שעות${total % 60 ? ` ו-${total % 60} דקות` : ""}`;
  if (total >= 60) return `שעה${total % 60 ? ` ו-${total % 60} דקות` : ""}`;
  return `${total} דקות`;
};
type ReminderLeadMinutes = (typeof reminderLeadOptions)[number];
const defaultReminderLeadMinutes: ReminderLeadMinutes = 10;

const normalizeReminderLeadMinutes = (value: unknown): ReminderLeadMinutes => {
  const numeric = Number(value);
  return reminderLeadOptions.includes(numeric as ReminderLeadMinutes)
    ? (numeric as ReminderLeadMinutes)
    : defaultReminderLeadMinutes;
};

// A delayed cron may run after the exact reminder time; still deliver up to this many minutes past task start.
const REMINDER_GRACE_MINUTES = 15;
const isVerboseReminderLogs = process.env.PUSH_REMINDER_VERBOSE === "1";
const debugReminderLog = (...args: unknown[]) => {
  // Always on: Vercel logs are the only way to debug missed reminders.
  if (isVerboseReminderLogs || true) {
    console.log("[PUSH_REMIND]", ...args);
  }
};

const getEnv = () => ({
  vapidPublicKey: process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY?.trim() || "",
  vapidPrivateKey: process.env.VAPID_PRIVATE_KEY?.trim() || "",
  vapidSubject: process.env.VAPID_SUBJECT?.trim() || "mailto:admin@example.com",
});

let vapidInitialized = false;

const initVapid = () => {
  if (vapidInitialized) {
    return true;
  }

  const { vapidPublicKey, vapidPrivateKey, vapidSubject } = getEnv();
  if (!vapidPublicKey || !vapidPrivateKey) {
    return false;
  }

  webpush.setVapidDetails(vapidSubject, vapidPublicKey, vapidPrivateKey);
  vapidInitialized = true;
  return true;
};

export const hasPushConfig = () => {
  const { vapidPublicKey, vapidPrivateKey } = getEnv();
  return Boolean(vapidPublicKey && vapidPrivateKey);
};

export const getPublicVapidKey = () => getEnv().vapidPublicKey;

// DDL must run once per server instance, not on every request (it would hog pooler connections).
let pushTablesReady: Promise<void> | null = null;
export const ensurePushTables = (): Promise<void> => {
  if (!pushTablesReady) {
    pushTablesReady = ensurePushTablesUncached().catch((error) => {
      pushTablesReady = null;
      throw error;
    });
  }
  return pushTablesReady;
};

const ensurePushTablesUncached = async (): Promise<void> => {
  await sql`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_name TEXT,
      receive_all BOOLEAN NOT NULL DEFAULT FALSE,
      watch_children TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  await sql`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS user_name TEXT`;
  await sql`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS receive_all BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS watch_children TEXT`;
  await sql`ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS reminder_lead_minutes INT NOT NULL DEFAULT 10`;

  const roster = peekFamilyRoster();
  for (const userName of roster?.pushUserNames ?? []) {
    try {
      const mojibake = Buffer.from(userName, "utf8").toString("latin1");
      if (mojibake !== userName) {
        await sql`
          UPDATE push_subscriptions
          SET user_name = ${userName},
              updated_at = NOW()
          WHERE user_name = ${mojibake}
        `;
      }
    } catch {
      // no-op
    }
  }

  await sql`
    CREATE TABLE IF NOT EXISTS push_reminder_dispatches (
      dispatch_key TEXT PRIMARY KEY,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
};

export const savePushSubscription = async (subscription: unknown) => {
  if (!subscription || typeof subscription !== "object") {
    throw new Error("Invalid push subscription");
  }

  const data = subscription as Record<string, unknown>;
  const endpoint = typeof data.endpoint === "string" ? data.endpoint.trim() : "";
  const keys = (data.keys && typeof data.keys === "object" ? data.keys : {}) as Record<string, unknown>;
  const p256dh = typeof keys.p256dh === "string" ? keys.p256dh.trim() : "";
  const auth = typeof keys.auth === "string" ? keys.auth.trim() : "";

  if (!endpoint || !p256dh || !auth) {
    throw new Error("Subscription missing endpoint or keys");
  }

  await ensurePushTables();
  const roster = await loadFamilyRoster();
  const childNameSet = childNameSetOf(roster);
  const parentNameSet = parentNameSetOf(roster);

  const meta = (subscription as Record<string, unknown>) ?? {};
  const userName = normalizeAllowedUserName(meta.userName, roster);

  const receiveAllRaw = Boolean(meta.receiveAll);
  const incomingWatchChildren = Array.isArray(meta.watchChildren)
    ? meta.watchChildren
    : [];
  const watchChildren = incomingWatchChildren
    .filter((value): value is string => typeof value === "string")
    .map((value) => roster.resolvePushName(value.trim()))
    .filter((value): value is string => Boolean(value && childNameSet.has(value)));

  const isParent = userName ? parentNameSet.has(userName) : false;
  const receiveAll = isParent ? receiveAllRaw : false;
  const reminderLeadMinutes = normalizeReminderLeadMinutes(meta.reminderLeadMinutes);
  const normalizedWatchChildren = isParent && !receiveAll
    ? [...new Set(watchChildren)]
    : null;
  const watchChildrenValue = normalizedWatchChildren ? normalizedWatchChildren.join(",") : null;

  await sql`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes, created_at, updated_at)
    VALUES (${endpoint}, ${p256dh}, ${auth}, ${userName}, ${receiveAll}, ${watchChildrenValue}, ${reminderLeadMinutes}, NOW(), NOW())
    ON CONFLICT (endpoint)
    DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_name = EXCLUDED.user_name,
      receive_all = EXCLUDED.receive_all,
      watch_children = EXCLUDED.watch_children,
      reminder_lead_minutes = EXCLUDED.reminder_lead_minutes,
      updated_at = NOW()
  `;

  return { endpoint };
};

export const removePushSubscription = async (endpoint: string) => {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    return;
  }

  await ensurePushTables();
  await sql`DELETE FROM push_subscriptions WHERE endpoint = ${trimmed}`;
};

const PUSH_SEND_TIMEOUT_MS = 3_000;

const withTimeout = <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
  });
  // If the deadline wins, the original request must not surface later as an unhandled rejection.
  promise.catch(() => undefined);
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

/** One delete for every endpoint the push service reported as gone. Never throws. */
const dropSubscriptions = async (endpoints: string[]) => {
  const unique = [...new Set(endpoints.map((endpoint) => endpoint.trim()).filter(Boolean))];
  if (!unique.length) return;
  try {
    await withTimeout(
      sql`DELETE FROM push_subscriptions WHERE endpoint = ANY(${unique})`,
      2_000,
      "drop-subscriptions",
    );
  } catch {
    // A slow cleanup must not block the cron.
  }
};

const sendToSubscription = async (row: SubscriptionRow, payload: PushPayload) => {
  if (!initVapid()) {
    return { ok: false as const, removed: false, reason: "missing-vapid", statusCode: 0, message: "VAPID keys are not configured on the server" };
  }

  const category = inferNotificationCategory({ category: payload.category });
  const channel = notificationChannelProfile(category);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_SEND_TIMEOUT_MS);
  try {
    const details = webpush.generateRequestDetails(
      {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      },
      JSON.stringify({
        ...payload,
        category,
        level: category,
        tag: channel.tag,
        importance: channel.importance,
        silent: channel.silent,
      }),
      { TTL: 60, urgency: channel.urgency },
    );
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(details.headers as Record<string, unknown>)) {
      if (value != null) headers[key] = String(value);
    }
    const response = await fetch(details.endpoint, {
      method: "POST",
      headers,
      body: details.body ? new Uint8Array(details.body) : undefined,
      signal: controller.signal,
    });
    void response.body?.cancel().catch(() => undefined);
    if (response.status === 404 || response.status === 410) {
      return { ok: false as const, removed: true, reason: "expired-subscription", statusCode: response.status, message: "gone" };
    }
    if (!response.ok) {
      return { ok: false as const, removed: false, reason: "send-failed", statusCode: response.status, message: response.statusText || "push rejected" };
    }
    return { ok: true as const, removed: false };
  } catch (error) {
    const aborted = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
    return {
      ok: false as const,
      removed: false,
      reason: aborted ? "timeout" : "send-failed",
      statusCode: 0,
      message: aborted ? "push timed out" : (error instanceof Error ? error.message : String(error)),
    };
  } finally {
    clearTimeout(timer);
  }
};

export const sendPushToAll = async (
  payload: PushPayload,
  options?: { excludeEndpoint?: string }
) => {
  await ensurePushTables();

  const rowsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
    FROM push_subscriptions
  `;

  const excludeEndpoint = options?.excludeEndpoint?.trim() || "";
  const targets = rowsResult.rows.filter((row) => row.endpoint !== excludeEndpoint);

  if (!targets.length) {
    return { sent: 0, skipped: rowsResult.rowCount || 0 };
  }

  let sent = 0;
  const deadEndpoints: string[] = [];
  for (const row of targets) {
    const result = await sendToSubscription(row, payload);
    if (result.ok) {
      sent += 1;
    } else if (result.removed) {
      deadEndpoints.push(row.endpoint);
    }
  }
  await dropSubscriptions(deadEndpoints);

  return { sent, skipped: (rowsResult.rowCount || 0) - targets.length };
};

export const sendPushToEndpoint = async (endpoint: string, payload: PushPayload) => {
  const trimmedEndpoint = endpoint.trim();
  if (!trimmedEndpoint) {
    return { ok: false as const, reason: "missing-endpoint" };
  }

  await ensurePushTables();

  const rowResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
    FROM push_subscriptions
    WHERE endpoint = ${trimmedEndpoint}
    LIMIT 1
  `;

  const row = rowResult.rows[0];
  if (!row) {
    return { ok: false as const, reason: "endpoint-not-found" };
  }

  const result = await sendToSubscription(row, payload);
  if (result.removed) {
    await dropSubscriptions([row.endpoint]);
  }
  return result;
};

export const sendPushToParents = async (
  payload: PushPayload,
  targetParents?: ParentUserName[]
) => {
  await ensurePushTables();
  const roster = await loadFamilyRoster();
  const resolvedTargets = targetParents?.length ? targetParents : roster.pushParentNames;

  const rowsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
    FROM push_subscriptions
  `;

  const targetSet = new Set<string>(resolvedTargets);
  const targets = rowsResult.rows.filter((row) => {
    const userName = normalizeAllowedUserName(row.user_name, roster);
    return Boolean(userName && isParentUserName(userName, roster) && targetSet.has(userName));
  });

  if (!targets.length) {
    return { sent: 0, skipped: rowsResult.rowCount || 0 };
  }

  let sent = 0;
  const deadEndpoints: string[] = [];
  for (const row of targets) {
    const result = await sendToSubscription(row, payload);
    if (result.ok) {
      sent += 1;
    } else if (result.removed) {
      deadEndpoints.push(row.endpoint);
    }
  }
  await dropSubscriptions(deadEndpoints);

  return { sent, skipped: (rowsResult.rowCount || 0) - targets.length };
};

const getTaskAudienceChildren = (task: TaskRow, roster: FamilyRoster): ChildUserName[] => {
  const rawChild = (task.child || "").trim();
  return normalizeTaskChildNames(rawChild, roster);
};

const shouldSubscriptionReceiveTask = (
  subscription: SubscriptionRow,
  audienceChildren: ChildUserName[],
  roster: FamilyRoster,
) => {
  if (audienceChildren.length === 0) {
    return false;
  }

  const userName = normalizeAllowedUserName(subscription.user_name, roster);
  if (!userName) {
    return true;
  }

  const childNameSet = childNameSetOf(roster);
  const parentNameSet = parentNameSetOf(roster);

  if (childNameSet.has(userName)) {
    return audienceChildren.includes(userName as ChildUserName);
  }

  if (parentNameSet.has(userName)) {
    if (Boolean(subscription.receive_all)) {
      return true;
    }

    const trackedChildren = String(subscription.watch_children || "")
      .split(",")
      .map((value) => roster.resolvePushName(value.trim()))
      .filter((value): value is ChildUserName => Boolean(value && childNameSet.has(value)));

    if (trackedChildren.length === 0) {
      return true;
    }

    return trackedChildren.some((name) => audienceChildren.includes(name));
  }

  return false;
};

const parseTimeToMinutes = (value: string) => {
  const match = value.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!match) {
    return null;
  }

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  return hours * 60 + minutes;
};

const getNowInTimeZone = (timeZone: string) => {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });

  const parts = formatter.formatToParts(new Date());
  const getPart = (type: string) => parts.find((part) => part.type === type)?.value || "00";
  const dateKey = `${getPart("year")}-${getPart("month")}-${getPart("day")}`;
  const hours = Number(getPart("hour"));
  const minutes = Number(getPart("minute"));

  return {
    dateKey,
    minutes: (Number.isFinite(hours) ? hours : 0) * 60 + (Number.isFinite(minutes) ? minutes : 0),
  };
};

/** Calendar date after shifting a local YYYY-MM-DD + minute-of-day by deltaMinutes. */
const shiftIsoDate = (dateKey: string, minuteOfDay: number, deltaMinutes: number) => {
  const [year, month, day] = dateKey.split("-").map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day, 0, minuteOfDay) + deltaMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = `${shifted.getUTCMonth() + 1}`.padStart(2, "0");
  const d = `${shifted.getUTCDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
};

// Accepts YYYY-MM-DD, ISO timestamps, DD-MM-YYYY, DD.MM.YYYY and DD/MM/YYYY (1-2 digit day/month) -> YYYY-MM-DD or ISO as-is.
const normalizeDayString = (value: string) => {
  const trimmed = value.trim();
  const dmy = trimmed.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/);
  if (dmy) {
    return `${dmy[3]}-${dmy[2].padStart(2, "0")}-${dmy[1].padStart(2, "0")}`;
  }
  return trimmed;
};

const parseTaskDateKey = (value: string) => {
  const trimmed = normalizeDayString(value);
  const isoDateTime = trimmed.match(/^(\d{4}-\d{2}-\d{2})T/);
  if (isoDateTime) {
    return isoDateTime[1];
  }

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

const parseTaskStartUtc = (dayValue: string, timeValue: string) => {
  const day = normalizeDayString(dayValue);
  const time = timeValue.trim();

  if (!day || !time) {
    return null;
  }

  const timeMatch = time.match(/^(\d{1,2}):(\d{2})$/);
  if (!timeMatch) {
    return null;
  }

  const hours = Number(timeMatch[1]);
  const minutes = Number(timeMatch[2]);
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(day)) {
    const parsed = new Date(day);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const yyyyMmDd = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const isoUtc = `${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}:00.000Z`;
    const parsed = new Date(isoUtc);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const ddMmYyyy = day.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const isoUtc = `${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}T${`${hours}`.padStart(2, "0")}:${`${minutes}`.padStart(2, "0")}:00.000Z`;
    const parsed = new Date(isoUtc);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

export const sendUpcomingTaskReminders = async (
  options?: {
    windowForwardMinutes?: number;
    strictChildUserOnly?: boolean;
    timeZone?: string;
    onAttempt?: (attempt: { userName: string; eventTitle: string }) => void;
  }
) => {
  const roster = peekFamilyRoster() ?? await loadFamilyRoster();

  const windowForwardMinutesRaw = Number(options?.windowForwardMinutes);
  const windowForwardMinutes = Number.isFinite(windowForwardMinutesRaw)
    ? Math.max(1, Math.min(30, Math.floor(windowForwardMinutesRaw)))
    : 30;
  const strictChildUserOnly = options?.strictChildUserOnly === true;
  const timeZone = typeof options?.timeZone === "string" && options.timeZone.trim()
    ? options.timeZone.trim()
    : "";
  const nowUtc = new Date();
  const nowUtcMs = nowUtc.getTime();
  const nowInTimeZone = timeZone ? getNowInTimeZone(timeZone) : null;
  const emptyResult = {
    scanned: 0,
    sent: 0,
    windowForwardMinutes,
    timeZone: timeZone || null,
  };

  let subscriptions: SubscriptionRow[] = [];
  try {
    const subscriptionsResult = await sql<SubscriptionRow>`
      SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
      FROM push_subscriptions
    `;
    subscriptions = subscriptionsResult.rows;
  } catch (error) {
    console.error("[notifications:check] subscription query failed", error);
    return emptyResult;
  }

  console.log("[notifications:check] subscriptions found:", subscriptions.length);
  if (!subscriptions.length) {
    return emptyResult;
  }

  const windowAnchor = nowInTimeZone ?? {
    dateKey: nowUtc.toISOString().slice(0, 10),
    minutes: nowUtc.getUTCHours() * 60 + nowUtc.getUTCMinutes(),
  };
  const fromDate = shiftIsoDate(windowAnchor.dateKey, windowAnchor.minutes, -REMINDER_GRACE_MINUTES);
  const toDate = shiftIsoDate(windowAnchor.dateKey, windowAnchor.minutes, windowForwardMinutes);

  let tasksRaw: { rows: Array<Record<string, unknown>>; rowCount: number };
  try {
    tasksRaw = await sql`
      SELECT id, title, "date"::text AS day, metadata, start_time, child_id
      FROM schedule
      WHERE left("date"::text, 10) >= ${fromDate}
        AND left("date"::text, 10) <= ${toDate}
        AND COALESCE((metadata->'sendNotification')::boolean, true) = true
        AND COALESCE((metadata->'completed')::boolean, false) = false
        AND COALESCE((metadata->'notified')::boolean, false) = false
      LIMIT 80
    `;
  } catch (error) {
    console.error("[notifications:check] window query failed", error);
    return emptyResult;
  }

  const tasksResult = {
    rows: tasksRaw.rows.map((row) => {
      const r = row as {
        id: string;
        title: string;
        day?: string;
        date?: string;
        metadata: unknown;
        start_time?: string | null;
        child_id?: string | null;
      };
      const m = parseScheduleMetadata(r.metadata);
      const rawTime = r.start_time == null ? "" : String(r.start_time).trim();
      const columnTime = rawTime.length >= 5 ? rawTime.slice(0, 5) : rawTime;
      const columnChild = typeof r.child_id === "string" ? r.child_id.trim().toLowerCase() : "";
      return {
        id: r.id,
        text: r.title,
        day: r.day || r.date || "",
        time: parseTimeToMinutes(columnTime) !== null ? columnTime : m.time,
        child: columnChild || m.child,
        type: m.type,
        is_weekly: m.isRecurring,
        completed: m.completed,
        notified: m.notified,
        send_notification: m.sendNotification,
        require_confirmation: m.requireConfirmation,
        needs_ack: m.needsAck,
        reminder_lead_minutes: m.reminderLeadMinutes,
        notification_category: inferNotificationCategory({
          category: m.notificationCategory,
          type: m.type,
          title: r.title,
        }),
      } as TaskRow;
    }),
    rowCount: tasksRaw.rowCount,
  };

  console.log("[notifications:check] window tasks:", tasksResult.rows.length, fromDate, toDate);

  let sent = 0;
  const skippedByReason: Record<string, number> = {
    completed: 0,
    already_notified: 0,
    notifications_disabled: 0,
    type_not_eligible: 0,
    invalid_date: 0,
    date_mismatch: 0,
    invalid_time: 0,
    outside_window: 0,
    offset_not_due: 0,
    already_dispatched: 0,
    no_audience_subscriptions: 0,
    delivery_failed: 0,
  };

  const dueSends: Array<{
    taskId: string;
    taskTitle: string;
    taskTime: string;
    diffMinutes: number;
    subscription: SubscriptionRow;
    dispatchKey: string;
    childSubscriptionName: string;
    childDisplayName: string;
    category: NotificationCategory;
  }> = [];
  const taskOutcomes = new Map<string, {
    hadDue: boolean;
    delivered: number;
    diffMinutes: number;
    audienceChildren: string[];
  }>();

  for (const task of tasksResult.rows) {
    if (Boolean(task.completed)) {
      skippedByReason.completed += 1;
      debugReminderLog("skip completed", { taskId: task.id });
      continue;
    }

    if (Boolean(task.notified)) {
      skippedByReason.already_notified += 1;
      debugReminderLog("skip already_notified", { taskId: task.id });
      continue;
    }

    if (!Boolean(task.send_notification ?? true)) {
      skippedByReason.notifications_disabled += 1;
      debugReminderLog("skip notifications_disabled", { taskId: task.id });
      continue;
    }

    const taskStartUtc = parseTaskStartUtc(task.day || "", task.time || "");
    if (!taskStartUtc) {
      skippedByReason.invalid_date += 1;
      debugReminderLog("skip invalid_date", { taskId: task.id, day: task.day });
      continue;
    }

    const taskMinutes = parseTimeToMinutes(task.time || "");
    if (taskMinutes === null) {
      skippedByReason.invalid_time += 1;
      debugReminderLog("skip invalid_time", { taskId: task.id, time: task.time });
      continue;
    }

    let diffMinutes = Math.floor((taskStartUtc.getTime() - nowUtcMs) / 60000);
    if (nowInTimeZone) {
      const taskDateKey = parseTaskDateKey(String(task.day || ""));
      if (!taskDateKey) {
        skippedByReason.date_mismatch += 1;
        debugReminderLog("skip date_mismatch", { taskId: task.id, taskDateKey, nowDateKey: nowInTimeZone.dateKey });
        continue;
      }

      // Calendar-day distance in the target time zone (supports "day before" reminders), then minutes.
      const toDayNumber = (key: string) => {
        const [y, m, d] = key.split("-").map(Number);
        return Math.round(Date.UTC(y, m - 1, d) / 86400000);
      };
      const dayDelta = toDayNumber(taskDateKey) - toDayNumber(nowInTimeZone.dateKey);
      diffMinutes = dayDelta * 1440 + taskMinutes - nowInTimeZone.minutes;
    }

    // Widest possible lead is 24h; the per-subscription/per-task lead check below narrows it.
    if (diffMinutes < -REMINDER_GRACE_MINUTES || diffMinutes > windowForwardMinutes) {
      skippedByReason.outside_window += 1;
      debugReminderLog("skip outside_window", { taskId: task.id, diffMinutes, taskTime: task.time, nowUtc: nowUtc.toISOString() });
      continue;
    }

    const audienceChildren = getTaskAudienceChildren(task, roster);
    const taskChildNames = normalizeTaskChildNames(String(task.child || ""), roster);
    const taskParentNames = normalizeTaskParentNames(String(task.child || ""), roster);
    const targetSubscriptions = subscriptions.filter((subscription) => {
      // Task owned by a parent (e.g. "רועי"): deliver to that parent's devices.
      const subscriberName = normalizeAllowedUserName(subscription.user_name, roster);
      // receive_all subscribers always get every reminder, regardless of the task's child/owner.
      if (Boolean(subscription.receive_all)) {
        return true;
      }
      if (subscriberName && isParentUserName(subscriberName, roster) && taskParentNames.includes(subscriberName)) {
        return true;
      }

      const inAudience = shouldSubscriptionReceiveTask(subscription, audienceChildren, roster);
      if (!inAudience) {
        return false;
      }

      if (!strictChildUserOnly) {
        return true;
      }

      const userName = normalizeAllowedUserName(subscription.user_name, roster);
      return Boolean(userName && isChildUserName(userName, roster) && taskChildNames.includes(userName));
    });

    if (!targetSubscriptions.length) {
      skippedByReason.no_audience_subscriptions += 1;
      debugReminderLog("skip no_audience_subscriptions", { taskId: task.id, audienceChildren });
      continue;
    }

    console.log(
      "[notifications:check] task matched window:",
      task.id,
      task.text,
      "diffMinutes:",
      diffMinutes,
      "subscriptions:",
      JSON.stringify(targetSubscriptions.map((s) => ({ user: s.user_name, lead: s.reminder_lead_minutes, endpoint: String(s.endpoint).slice(0, 60) })))
    );

    const defaultChildName = audienceChildren[0] || "הילד";
    const taskReminderLeadMinutes = task.reminder_lead_minutes == null
      ? null
      : normalizeReminderLeadMinutes(task.reminder_lead_minutes);
    const outcome = taskOutcomes.get(String(task.id)) ?? { hadDue: false, delivered: 0, diffMinutes, audienceChildren };
    taskOutcomes.set(String(task.id), outcome);
    for (const subscription of targetSubscriptions) {
      const reminderLeadMinutes = taskReminderLeadMinutes ?? normalizeReminderLeadMinutes(subscription.reminder_lead_minutes);
      const minDue = -REMINDER_GRACE_MINUTES;
      const maxDue = reminderLeadMinutes;
      if (diffMinutes < minDue || diffMinutes > maxDue) {
        continue;
      }

      outcome.hadDue = true;
      const childSubscriptionName = normalizeAllowedUserName(subscription.user_name, roster) || "";
      const childDisplayName = isChildUserName(childSubscriptionName, roster) ? childSubscriptionName : defaultChildName;
      dueSends.push({
        taskId: String(task.id),
        taskTitle: String(task.text || "משימה"),
        taskTime: String(task.time || ""),
        diffMinutes,
        subscription,
        dispatchKey: `${task.id}:${taskStartUtc.toISOString()}:${reminderLeadMinutes}:${subscription.endpoint}`,
        childSubscriptionName,
        childDisplayName,
        category: task.notification_category || inferNotificationCategory({ type: task.type, title: task.text }),
      });
    }
  }

  const dispatchedKeys = new Set<string>();
  if (dueSends.length) {
    try {
      const existing = await sql<{ dispatch_key: string }>`
        SELECT dispatch_key
        FROM push_reminder_dispatches
        WHERE dispatch_key = ANY(${dueSends.map((job) => job.dispatchKey)})
      `;
      for (const row of existing.rows) {
        if (row.dispatch_key) dispatchedKeys.add(row.dispatch_key);
      }
    } catch (error) {
      console.error("[notifications:check] dispatch lookup failed", error);
    }
  }

  const pendingSends = dueSends.filter((job) => {
    if (!dispatchedKeys.has(job.dispatchKey)) return true;
    skippedByReason.already_dispatched += 1;
    debugReminderLog("skip already_dispatched", { taskId: job.taskId, dispatchKey: job.dispatchKey });
    return false;
  });

  const sendSettled = await Promise.allSettled(
    pendingSends.map(async (job) => {
      options?.onAttempt?.({
        userName: job.childSubscriptionName || "(unknown)",
        eventTitle: job.taskTitle,
      });
      const sendResult = await sendToSubscription(job.subscription, {
        title: "תזכורת למשימה",
        body: job.diffMinutes > 0
          ? `${job.taskTitle} מתחילה בעוד ${formatMinutesHe(job.diffMinutes)} (${job.taskTime})`
          : `${job.taskTitle} מתחילה עכשיו (${job.taskTime})`,
        url: "/",
        category: job.category,
        actions: [{ action: "confirm", title: "אישרתי שראיתי" }],
        confirmTask: {
          eventId: job.taskId,
          eventTitle: job.taskTitle,
          childName: job.childDisplayName,
        },
      });
      return {
        taskId: job.taskId,
        ok: sendResult.ok,
        removed: sendResult.removed,
        endpoint: job.subscription.endpoint,
        dispatchKey: job.dispatchKey,
      };
    }),
  );

  const deadEndpoints: string[] = [];
  const sentKeys: string[] = [];
  for (const item of sendSettled) {
    if (item.status !== "fulfilled") continue;
    if (item.value.removed) deadEndpoints.push(item.value.endpoint);
    if (!item.value.ok) continue;
    sentKeys.push(item.value.dispatchKey);
    const outcome = taskOutcomes.get(item.value.taskId);
    if (outcome) outcome.delivered += 1;
    sent += 1;
  }
  await dropSubscriptions(deadEndpoints);
  if (sentKeys.length) {
    try {
      await sql`
        INSERT INTO push_reminder_dispatches (dispatch_key, sent_at)
        SELECT key, NOW() FROM unnest(${sentKeys}::text[]) AS key
        ON CONFLICT (dispatch_key) DO NOTHING
      `;
    } catch (error) {
      console.error("[notifications:check] dispatch insert failed", error);
    }
  }

  const notifiedIds = [...taskOutcomes.entries()]
    .filter(([, outcome]) => outcome.delivered > 0)
    .map(([taskId]) => taskId);
  for (const [taskId, outcome] of taskOutcomes) {
    if (!outcome.hadDue) {
      skippedByReason.offset_not_due += 1;
    } else if (outcome.delivered <= 0) {
      skippedByReason.delivery_failed += 1;
    } else {
      debugReminderLog("sent", { taskId, deliveredForTask: outcome.delivered, diffMinutes: outcome.diffMinutes });
    }
  }
  if (notifiedIds.length) {
    try {
      await sql`
        UPDATE schedule
        SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{notified}', 'true'::jsonb, true),
            notified = true
        WHERE id = ANY(${notifiedIds})
      `;
    } catch {
      try {
        await sql`
          UPDATE schedule
          SET metadata = jsonb_set(COALESCE(metadata, '{}'::jsonb), '{notified}', 'true'::jsonb, true)
          WHERE id = ANY(${notifiedIds})
        `;
      } catch (error) {
        console.error("[notifications:check] mark notified failed", error);
      }
    }
  }

  const scanned = tasksResult.rowCount || 0;
  debugReminderLog("summary", {
    scanned,
    sent,
    skippedByReason,
    nowUtcIso: nowUtc.toISOString(),
    subscriptions: subscriptions.length,
    windowForwardMinutes,
    strictChildUserOnly,
    timeZone: timeZone || null,
  });
  return {
    scanned,
    sent,
    skippedByReason,
    nowUtcIso: nowUtc.toISOString(),
    subscriptions: subscriptions.length,
    windowForwardMinutes,
    strictChildUserOnly,
    timeZone: timeZone || null,
  };
};
