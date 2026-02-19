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
  user_name: string | null;
  receive_all: boolean | null;
  watch_children: string | null;
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

const childUserNames = ["רביד", "עמית", "אלין"] as const;
const parentUserNames = ["סיוון", "רועי"] as const;

type ChildUserName = (typeof childUserNames)[number];
type ParentUserName = (typeof parentUserNames)[number];
type AllowedUserName = ChildUserName | ParentUserName;

const childNameSet = new Set<string>(childUserNames);
const parentNameSet = new Set<string>(parentUserNames);

const childKeyToName: Record<string, ChildUserName> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  "רביד": "רביד",
  "עמית": "עמית",
  "אלין": "אלין",
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
  const normalizedWatchChildren = isParent && !receiveAll
    ? [...new Set(watchChildren)]
    : null;
  const watchChildrenValue = normalizedWatchChildren ? normalizedWatchChildren.join(",") : null;

  await sql`
    INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_name, receive_all, watch_children, created_at, updated_at)
    VALUES (${endpoint}, ${p256dh}, ${auth}, ${userName}, ${receiveAll}, ${watchChildrenValue}, NOW(), NOW())
    ON CONFLICT (endpoint)
    DO UPDATE SET
      p256dh = EXCLUDED.p256dh,
      auth = EXCLUDED.auth,
      user_name = EXCLUDED.user_name,
      receive_all = EXCLUDED.receive_all,
      watch_children = EXCLUDED.watch_children,
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
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children
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

const getTaskAudienceChildren = (task: TaskRow): ChildUserName[] => {
  const rawChild = (task.child || "").trim();
  if (!rawChild) {
    return [];
  }

  const normalized = rawChild.toLowerCase();
  const candidates = normalized.split("_").map((token) => token.trim()).filter(Boolean);
  const names = candidates
    .map((token) => childKeyToName[token])
    .filter(Boolean) as ChildUserName[];

  if (/רביד/.test(rawChild)) {
    names.push("רביד");
  }
  if (/עמית/.test(rawChild)) {
    names.push("עמית");
  }
  if (/אלין/.test(rawChild)) {
    names.push("אלין");
  }

  return [...new Set(names)];
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

    return trackedChildren.some((name) => audienceChildren.includes(name));
  }

  return false;
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

  const subscriptionsResult = await sql<SubscriptionRow>`
    SELECT endpoint, p256dh, auth, user_name, receive_all, watch_children
    FROM push_subscriptions
  `;

  const subscriptions = subscriptionsResult.rows;
  if (!subscriptions.length) {
    return { scanned: 0, sent: 0 };
  }

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

    const audienceChildren = getTaskAudienceChildren(task);
    const targetSubscriptions = subscriptions.filter((subscription) =>
      shouldSubscriptionReceiveTask(subscription, audienceChildren)
    );

    if (!targetSubscriptions.length) {
      continue;
    }

    let deliveredForTask = 0;
    for (const subscription of targetSubscriptions) {
      const sendResult = await sendToSubscription(subscription, {
        title: "תזכורת למשימה",
        body: `${task.text} מתחילה ב-${diffMinutes} דקות (${task.time})`,
        url: "/",
      });

      if (sendResult.ok) {
        deliveredForTask += 1;
      }
    }

    if (deliveredForTask > 0) {
      await markReminderDispatched(dispatchKey);
      sent += deliveredForTask;
    }
  }

  return { scanned: tasksResult.rowCount || 0, sent };
};
