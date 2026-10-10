import { sql } from "@/app/lib/db";
import { normalizeMetadataTime, parseMetadataBoolean } from "@/app/lib/scheduleTime";

export type ScheduleEventMetadata = {
  dayIndex: number;
  time: string;
  child: string;
  type: string;
  zoomLink?: string | null;
  isRecurring: boolean;
  recurringTemplateId?: string | null;
  completed: boolean;
  sendNotification: boolean;
  requireConfirmation: boolean;
  needsAck: boolean;
  reminderLeadMinutes: number | null;
  userId: string;
  /** Set by reminder sweep after a push was sent */
  notified?: boolean;
};

const defaultMetadata = (): ScheduleEventMetadata => ({
  dayIndex: 0,
  time: "08:00",
  child: "amit",
  type: "lesson",
  zoomLink: null,
  isRecurring: false,
  recurringTemplateId: null,
  completed: false,
  sendNotification: true,
  requireConfirmation: false,
  needsAck: false,
  reminderLeadMinutes: null,
  userId: "system",
  notified: false,
});

export const parseScheduleMetadata = (raw: unknown): ScheduleEventMetadata => {
  const base = defaultMetadata();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return base;
  }
  const o = raw as Record<string, unknown>;
  const dayIndex = Number(o.dayIndex ?? o.day_index);
  const reminderRaw = o.reminderLeadMinutes ?? o.reminder_lead_minutes;
  const reminderNum = Number(reminderRaw);
  /** Ignore `is_weekly` in JSON — legacy / push payloads may set it incorrectly. */
  const isRecurring =
    parseMetadataBoolean(o.isRecurring) || parseMetadataBoolean(o.is_recurring);
  const recurringTemplateIdRaw =
    typeof o.recurringTemplateId === "string" && o.recurringTemplateId.trim()
      ? o.recurringTemplateId.trim()
      : typeof o.recurring_template_id === "string" && o.recurring_template_id.trim()
        ? o.recurring_template_id.trim()
        : null;
  return {
    dayIndex: Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex <= 6 ? dayIndex : base.dayIndex,
    time: normalizeMetadataTime(o.time, base.time),
    child: typeof o.child === "string" && o.child.trim() ? o.child.trim().toLowerCase() : base.child,
    type: typeof o.type === "string" && o.type.trim() ? o.type.trim().toLowerCase() : base.type,
    zoomLink: typeof o.zoomLink === "string" ? o.zoomLink : typeof o.zoom_link === "string" ? o.zoom_link : null,
    isRecurring,
    recurringTemplateId: isRecurring ? recurringTemplateIdRaw : null,
    completed: parseMetadataBoolean(o.completed),
    sendNotification: (() => {
      const v = o.sendNotification ?? o.send_notification;
      if (v === undefined) {
        return true;
      }
      return parseMetadataBoolean(v);
    })(),
    requireConfirmation:
      parseMetadataBoolean(o.requireConfirmation) ||
      parseMetadataBoolean(o.require_confirmation) ||
      parseMetadataBoolean(o.needsAck) ||
      parseMetadataBoolean(o.needs_ack),
    needsAck:
      parseMetadataBoolean(o.needsAck) ||
      parseMetadataBoolean(o.needs_ack) ||
      parseMetadataBoolean(o.requireConfirmation) ||
      parseMetadataBoolean(o.require_confirmation),
    reminderLeadMinutes:
      reminderRaw === null || reminderRaw === undefined || Number.isNaN(reminderNum)
        ? null
        : ([5, 10, 15, 30, 60, 120, 1440] as const).includes(reminderNum as 5 | 10 | 15 | 30 | 60 | 120 | 1440)
          ? (reminderNum as 5 | 10 | 15 | 30 | 60 | 120 | 1440)
          : null,
    userId: typeof o.userId === "string" && o.userId.trim() ? o.userId.trim() : typeof o.user_id === "string" && o.user_id.trim() ? o.user_id.trim() : base.userId,
    notified: parseMetadataBoolean(o.notified),
  };
};

export const buildMetadataFromIncoming = (incoming: {
  dayIndex: number;
  time: string;
  child: string;
  type: string;
  zoomLink?: string;
  isRecurring: boolean;
  recurringTemplateId?: string;
  completed: boolean;
  sendNotification: boolean;
  requireConfirmation: boolean;
  needsAck: boolean;
  reminderLeadMinutes: number | null;
  userId: string;
  notified?: boolean;
}): ScheduleEventMetadata => {
  const recurring = parseMetadataBoolean(incoming.isRecurring);
  return {
    dayIndex: incoming.dayIndex,
    time: incoming.time,
    child: incoming.child,
    type: incoming.type,
    zoomLink: incoming.zoomLink ?? null,
    isRecurring: recurring,
    recurringTemplateId: recurring ? (incoming.recurringTemplateId ?? null) : null,
    completed: incoming.completed,
    sendNotification: incoming.sendNotification,
    requireConfirmation: incoming.requireConfirmation,
    needsAck: incoming.needsAck,
    reminderLeadMinutes: incoming.reminderLeadMinutes,
    userId: incoming.userId,
    notified: incoming.notified ?? false,
  };
};

/**
 * Ensures JSONB `metadata` exists on `schedule` (user-created id/title/date).
 * Does not CREATE the table — only adds the column if missing.
 */
let extraColumnsPromise: Promise<boolean> | null = null;

/**
 * Dedicated columns mirroring metadata: start_time (HH:MM), child_id, notified.
 * Cheap information_schema check first; ALTER only when something is missing. Cached per instance.
 * Resolves false (never throws) if the columns can't be created, so callers fall back to metadata only.
 */
export const ensureScheduleExtraColumns = (): Promise<boolean> => {
  if (!extraColumnsPromise) {
    extraColumnsPromise = (async () => {
      try {
        const existing = await sql`
          SELECT column_name FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = 'schedule'
            AND column_name IN ('start_time', 'child_id', 'notified')
        `;
        if ((existing.rowCount ?? existing.rows.length) >= 3) {
          return true;
        }
        await sql`
          ALTER TABLE schedule
            ADD COLUMN IF NOT EXISTS start_time TEXT,
            ADD COLUMN IF NOT EXISTS child_id TEXT,
            ADD COLUMN IF NOT EXISTS notified BOOLEAN NOT NULL DEFAULT false
        `;
        return true;
      } catch (error) {
        console.error("[schedule] could not ensure start_time/child_id/notified columns; using metadata only", error);
        extraColumnsPromise = null; // retry on a later request
        return false;
      }
    })();
  }
  return extraColumnsPromise;
};

export const ensureScheduleMetadataColumn = async (): Promise<true> => {
  // DISABLED: the table and its `metadata` JSONB column already exist in production. Running DDL checks
  // on every serverless request wastes pooler (PgBouncer) session slots (EMAXCONNSESSION).
  // For a fresh database run this SQL once manually:
  //   CREATE TABLE IF NOT EXISTS schedule (id TEXT PRIMARY KEY, title TEXT NOT NULL,
  //     "date" TEXT NOT NULL, metadata JSONB NOT NULL DEFAULT '{}'::jsonb);
  return true;
};
