import { sql } from "@vercel/postgres";
import webpush from "web-push";

type PushPayload = {
  title: string;
  body: string;
  url?: string;
};

type SubscriptionRow = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

type TaskRow = {
  id: string;
  text: string;
  day: string;
  time: string;
  child: string;
  type: string;
  is_weekly?: boolean;
};

const shouldSendReminderForTask = (task: TaskRow) => {
  const type = (task.type || "").toLowerCase();
  const title = (task.text || "").toLowerCase();

  if (type === "lesson") {
    return true;
  }

  return /שיעור|אנגלית|תגבור|lesson|english|tutoring/i.test(title);
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
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;

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
  await sql`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, created_at, updated_at)
    VALUES (${endpoint}, ${p256dh}, ${auth}, NOW(), NOW())
    ON CONFLICT (endpoint)
    DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
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
    return { ok: false as const, removed: false, reason: "missing-vapid" };
  }

  try {
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

    if (statusCode === 404 || statusCode === 410) {
      await removePushSubscription(row.endpoint);
      return { ok: false as const, removed: true, reason: "expired-subscription" };
    }

    return { ok: false as const, removed: false, reason: "send-failed" };
  }
};

export const sendPushToAll = async (
  payload: PushPayload,
  options?: { excludeEndpoint?: string }
) => {
  await ensurePushTables();

  const rowsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth
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

const parseTaskDate = (value: string) => {
  const trimmed = value.trim();

  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const parsed = new Date(`${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const parsed = new Date(`${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
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

const toDateKey = (date: Date) => {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
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

export const sendUpcomingTaskReminders = async () => {
  await ensurePushTables();

  const tasksResult = await sql<TaskRow>`
    SELECT id, text, day, time, child, type, is_weekly
    FROM family_schedule
  `;

  const now = new Date();
  const nowDateKey = toDateKey(now);
  const nowMinutes = now.getHours() * 60 + now.getMinutes();

  let sent = 0;

  for (const task of tasksResult.rows) {
    if (!shouldSendReminderForTask(task)) {
      continue;
    }

    const taskDate = parseTaskDate(task.day || "");
    if (!taskDate) {
      continue;
    }

    if (toDateKey(taskDate) !== nowDateKey) {
      continue;
    }

    const taskMinutes = parseTimeToMinutes(task.time || "");
    if (taskMinutes === null) {
      continue;
    }

    const diffMinutes = taskMinutes - nowMinutes;
    if (diffMinutes < 0 || diffMinutes > 15) {
      continue;
    }

    const dispatchKey = `${task.id}:${toDateKey(taskDate)}:${task.time}`;
    if (await wasReminderDispatched(dispatchKey)) {
      continue;
    }

    const result = await sendPushToAll({
      title: "תזכורת למשימה",
      body: `${task.text} מתחילה ב-${diffMinutes} דקות (${task.time})`,
      url: "/",
    });

    if (result.sent > 0) {
      await markReminderDispatched(dispatchKey);
      sent += result.sent;
    }
  }

  return { scanned: tasksResult.rowCount || 0, sent };
};
