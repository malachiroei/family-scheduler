import { sql } from "@vercel/postgres";
import webpush from "web-push";

type PushPayload = {
  title: string;
  body: string;
  url?: string;
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
};

const childUserNames = ["רביד", "עמית", "אלין"] as const;
const parentUserNames = ["סיוון", "רועי"] as const;

type ChildUserName = (typeof childUserNames)[number];
type ParentUserName = (typeof parentUserNames)[number];
type AllowedUserName = ChildUserName | ParentUserName;

const childNameSet = new Set<string>(childUserNames);
const parentNameSet = new Set<string>(parentUserNames);

const isChildUserName = (value: string): value is ChildUserName => childNameSet.has(value);
const isParentUserName = (value: string): value is ParentUserName => parentNameSet.has(value);

const childKeyToName: Record<string, ChildUserName> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  "רביד": "רביד",
  "עמית": "עמית",
  "אלין": "אלין",
};

const normalizeTaskChildNames = (rawChild: string): ChildUserName[] => {
  const normalized = rawChild.trim().toLowerCase();
  if (!normalized) {
    return [];
  }

  const values = normalized
    .split("_")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => childKeyToName[token])
    .filter(Boolean) as ChildUserName[];

  if (/רביד/.test(rawChild)) {
    values.push("רביד");
  }
  if (/עמית/.test(rawChild)) {
    values.push("עמית");
  }
  if (/אלין/.test(rawChild)) {
    values.push("אלין");
  }

  return [...new Set(values)];
};

const reminderLeadOptions = [5, 10, 15, 30] as const;
type ReminderLeadMinutes = (typeof reminderLeadOptions)[number];
const defaultReminderLeadMinutes: ReminderLeadMinutes = 10;

const normalizeReminderLeadMinutes = (value: unknown): ReminderLeadMinutes => {
  const numeric = Number(value);
  return reminderLeadOptions.includes(numeric as ReminderLeadMinutes)
    ? (numeric as ReminderLeadMinutes)
    : defaultReminderLeadMinutes;
};

const isVerboseReminderLogs = process.env.PUSH_REMINDER_VERBOSE === "1";
const debugReminderLog = (...args: unknown[]) => {
  if (isVerboseReminderLogs) {
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

export const ensurePushTables = async () => {
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

  const meta = (subscription as Record<string, unknown>) ?? {};
  const userNameRaw = typeof meta.userName === "string" ? meta.userName.trim() : "";
  const userName = (childNameSet.has(userNameRaw) || parentNameSet.has(userNameRaw))
    ? (userNameRaw as AllowedUserName)
    : null;

  const receiveAllRaw = Boolean(meta.receiveAll);
  const incomingWatchChildren = Array.isArray(meta.watchChildren)
    ? meta.watchChildren
    : [];
  const watchChildren = incomingWatchChildren
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => childNameSet.has(value));

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

const sendToSubscription = async (row: SubscriptionRow, payload: PushPayload) => {
  if (!initVapid()) {
    console.error("[PUSH] Missing VAPID config; cannot send notification");
    return { ok: false as const, removed: false, reason: "missing-vapid" };
  }

  try {
    console.log("Sending Push Notification for:", payload.confirmTask?.eventTitle || payload.title);
    console.log("Sending push to:", row.endpoint);
    await webpush.sendNotification(
      {
        endpoint: row.endpoint,
        keys: {
          p256dh: row.p256dh,
          auth: row.auth,
        },
      },
      JSON.stringify(payload)
    );

    return { ok: true as const, removed: false };
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown })?.statusCode === "number"
      ? ((error as { statusCode: number }).statusCode)
      : 0;
    const message = error instanceof Error ? error.message : String(error);

    if (statusCode === 404 || statusCode === 410) {
      await removePushSubscription(row.endpoint);
      console.warn("[PUSH] Subscription expired and removed", {
        statusCode,
        endpointPrefix: row.endpoint.slice(0, 40),
      });
      return { ok: false as const, removed: true, reason: "expired-subscription" };
    }

    console.error("[PUSH] Failed to send notification", {
      statusCode,
      message,
      endpointPrefix: row.endpoint.slice(0, 40),
    });

    return { ok: false as const, removed: false, reason: "send-failed" };
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
  for (const row of targets) {
    const result = await sendToSubscription(row, payload);
    if (result.ok) {
      sent += 1;
    }
  }

  return { sent, skipped: (rowsResult.rowCount || 0) - targets.length };
};

export const sendPushToParents = async (
  payload: PushPayload,
  targetParents: ParentUserName[] = [...parentUserNames]
) => {
  await ensurePushTables();

  const rowsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
    FROM push_subscriptions
  `;

  const targetSet = new Set<string>(targetParents);
  const targets = rowsResult.rows.filter((row) => {
    const userName = (row.user_name || "").trim();
    return isParentUserName(userName) && targetSet.has(userName);
  });

  if (!targets.length) {
    return { sent: 0, skipped: rowsResult.rowCount || 0 };
  }

  let sent = 0;
  for (const row of targets) {
    const result = await sendToSubscription(row, payload);
    if (result.ok) {
      sent += 1;
    }
  }

  return { sent, skipped: (rowsResult.rowCount || 0) - targets.length };
};

const getTaskAudienceChildren = (task: TaskRow): ChildUserName[] => {
  const rawChild = (task.child || "").trim();
  return normalizeTaskChildNames(rawChild);
};

const shouldSubscriptionReceiveTask = (
  subscription: SubscriptionRow,
  audienceChildren: ChildUserName[]
) => {
  if (audienceChildren.length === 0) {
    return false;
  }

  const userName = (subscription.user_name || "").trim();
  if (!userName) {
    return true;
  }

  if (childNameSet.has(userName)) {
    return audienceChildren.includes(userName as ChildUserName);
  }

  if (parentNameSet.has(userName)) {
    if (Boolean(subscription.receive_all)) {
      return true;
    }

    const trackedChildren = String(subscription.watch_children || "")
      .split(",")
      .map((value) => value.trim())
      .filter((value): value is ChildUserName => childNameSet.has(value));

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

const parseTaskDateKey = (value: string) => {
  const trimmed = value.trim();
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
  const day = dayValue.trim();
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

const wasReminderDispatched = async (dispatchKey: string) => {
  const existing = await sql`
    SELECT dispatch_key
    FROM push_reminder_dispatches
    WHERE dispatch_key = ${dispatchKey}
    LIMIT 1
  `;
  return Boolean(existing.rowCount);
};

const markReminderDispatched = async (dispatchKey: string) => {
  await sql`
    INSERT INTO push_reminder_dispatches (dispatch_key, sent_at)
    VALUES (${dispatchKey}, NOW())
    ON CONFLICT (dispatch_key) DO NOTHING
  `;
};

export const sendUpcomingTaskReminders = async (
  options?: {
    windowForwardMinutes?: number;
    strictChildUserOnly?: boolean;
    timeZone?: string;
    onAttempt?: (attempt: { userName: string; eventTitle: string }) => void;
  }
) => {
  await ensurePushTables();
  try {
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS send_notification BOOLEAN NOT NULL DEFAULT TRUE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS require_confirmation BOOLEAN NOT NULL DEFAULT FALSE`;
    await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS needs_ack BOOLEAN NOT NULL DEFAULT FALSE`;
  } catch {
    // no-op: handled by schedule bootstrap route in normal flow
  }

  const windowForwardMinutesRaw = Number(options?.windowForwardMinutes);
  const windowForwardMinutes = Number.isFinite(windowForwardMinutesRaw)
    ? Math.max(0, Math.min(15, Math.floor(windowForwardMinutesRaw)))
    : 15;
  const strictChildUserOnly = options?.strictChildUserOnly === true;
  const timeZone = typeof options?.timeZone === "string" && options.timeZone.trim()
    ? options.timeZone.trim()
    : "";
  const nowUtc = new Date();
  const nowUtcMs = nowUtc.getTime();
  const nowInTimeZone = timeZone ? getNowInTimeZone(timeZone) : null;

  const subscriptionsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children, reminder_lead_minutes
    FROM push_subscriptions
  `;

  const subscriptions = subscriptionsResult.rows;
  if (!subscriptions.length) {
    debugReminderLog("no subscriptions");
    return { scanned: 0, sent: 0 };
  }

  const tasksResult = await sql<TaskRow>`
    SELECT
      id,
      COALESCE(title, text) AS text,
      COALESCE(event_date, day) AS day,
      COALESCE(event_time, time) AS time,
      child,
      COALESCE(event_type, type) AS type,
      COALESCE(is_recurring, is_weekly, FALSE) AS is_weekly,
      completed,
      COALESCE(notified, FALSE) AS notified,
      COALESCE(send_notification, TRUE) AS send_notification,
      COALESCE(require_confirmation, FALSE) AS require_confirmation,
      COALESCE(needs_ack, require_confirmation, FALSE) AS needs_ack
    FROM family_schedule
    WHERE COALESCE(send_notification, TRUE) = TRUE
      AND COALESCE(completed, FALSE) = FALSE
      AND COALESCE(notified, FALSE) = FALSE
  `;

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
      if (!taskDateKey || taskDateKey !== nowInTimeZone.dateKey) {
        skippedByReason.date_mismatch += 1;
        debugReminderLog("skip date_mismatch", { taskId: task.id, taskDateKey, nowDateKey: nowInTimeZone.dateKey });
        continue;
      }

      diffMinutes = taskMinutes - nowInTimeZone.minutes;
    }

    if (diffMinutes < 0 || diffMinutes > 45) {
      skippedByReason.outside_window += 1;
      debugReminderLog("skip outside_window", { taskId: task.id, diffMinutes, taskTime: task.time, nowUtc: nowUtc.toISOString() });
      continue;
    }

    const audienceChildren = getTaskAudienceChildren(task);
    const taskChildNames = normalizeTaskChildNames(String(task.child || ""));
    const targetSubscriptions = subscriptions.filter((subscription) => {
      const inAudience = shouldSubscriptionReceiveTask(subscription, audienceChildren);
      if (!inAudience) {
        return false;
      }

      if (!strictChildUserOnly) {
        return true;
      }

      const userName = (subscription.user_name || "").trim();
      return isChildUserName(userName) && taskChildNames.includes(userName);
    });

    if (!targetSubscriptions.length) {
      skippedByReason.no_audience_subscriptions += 1;
      debugReminderLog("skip no_audience_subscriptions", { taskId: task.id, audienceChildren });
      continue;
    }

    let deliveredForTask = 0;
    let hadDueByOffset = false;
    const defaultChildName = audienceChildren[0] || "הילד";
    for (const subscription of targetSubscriptions) {
      const reminderLeadMinutes = normalizeReminderLeadMinutes(subscription.reminder_lead_minutes);
      const minDue = reminderLeadMinutes;
      const maxDue = reminderLeadMinutes + windowForwardMinutes;
      if (diffMinutes < minDue || diffMinutes > maxDue) {
        continue;
      }

      hadDueByOffset = true;
      const dispatchKey = `${task.id}:${taskStartUtc.toISOString()}:${reminderLeadMinutes}:${subscription.endpoint}`;
      if (await wasReminderDispatched(dispatchKey)) {
        skippedByReason.already_dispatched += 1;
        debugReminderLog("skip already_dispatched", { taskId: task.id, dispatchKey });
        continue;
      }

      const childSubscriptionName = (subscription.user_name || "").trim();
      const childDisplayName = isChildUserName(childSubscriptionName) ? childSubscriptionName : defaultChildName;
      console.log("Pushing to device of:", childSubscriptionName || "(unknown)");
      options?.onAttempt?.({
        userName: childSubscriptionName || "(unknown)",
        eventTitle: String(task.text || "משימה"),
      });
      const sendResult = await sendToSubscription(subscription, {
        title: "תזכורת למשימה",
        body: `${task.text} מתחילה ב-${diffMinutes} דקות (${task.time})`,
        url: "/",
        actions: [{ action: "confirm", title: "אישרתי שראיתי" }],
        confirmTask: {
          eventId: String(task.id),
          eventTitle: String(task.text || "משימה"),
          childName: childDisplayName,
        },
      });

      if (sendResult.ok) {
        await markReminderDispatched(dispatchKey);
        deliveredForTask += 1;
      }
    }

    if (!hadDueByOffset) {
      skippedByReason.offset_not_due += 1;
      debugReminderLog("skip offset_not_due", { taskId: task.id, diffMinutes, audienceSubscriptions: targetSubscriptions.length });
      continue;
    }

    if (deliveredForTask > 0) {
      await sql`
        UPDATE family_schedule
        SET notified = TRUE,
            updated_at = NOW()
        WHERE id = ${task.id}
      `;
      sent += deliveredForTask;
      debugReminderLog("sent", { taskId: task.id, deliveredForTask, diffMinutes, audienceChildren });
    } else {
      skippedByReason.delivery_failed += 1;
      debugReminderLog("skip delivery_failed", { taskId: task.id, audienceChildren, subscriptions: targetSubscriptions.length });
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
