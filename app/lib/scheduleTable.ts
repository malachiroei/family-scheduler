import { sql } from "@/app/lib/db";

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
  return {
    dayIndex: Number.isInteger(dayIndex) && dayIndex >= 0 && dayIndex <= 6 ? dayIndex : base.dayIndex,
    time: typeof o.time === "string" && o.time.trim() ? o.time.trim() : base.time,
    child: typeof o.child === "string" && o.child.trim() ? o.child.trim().toLowerCase() : base.child,
    type: typeof o.type === "string" && o.type.trim() ? o.type.trim().toLowerCase() : base.type,
    zoomLink: typeof o.zoomLink === "string" ? o.zoomLink : typeof o.zoom_link === "string" ? o.zoom_link : null,
    isRecurring: Boolean(o.isRecurring ?? o.is_recurring ?? o.is_weekly),
    recurringTemplateId:
      typeof o.recurringTemplateId === "string" && o.recurringTemplateId.trim()
        ? o.recurringTemplateId.trim()
        : typeof o.recurring_template_id === "string" && o.recurring_template_id.trim()
          ? o.recurring_template_id.trim()
          : null,
    completed: Boolean(o.completed),
    sendNotification: o.sendNotification === false || o.send_notification === false ? false : true,
    requireConfirmation: Boolean(o.requireConfirmation ?? o.require_confirmation ?? o.needsAck ?? o.needs_ack),
    needsAck: Boolean(o.needsAck ?? o.needs_ack ?? o.requireConfirmation ?? o.require_confirmation),
    reminderLeadMinutes:
      reminderRaw === null || reminderRaw === undefined || Number.isNaN(reminderNum)
        ? null
        : ([5, 10, 15, 30] as const).includes(reminderNum as 5 | 10 | 15 | 30)
          ? (reminderNum as 5 | 10 | 15 | 30)
          : null,
    userId: typeof o.userId === "string" && o.userId.trim() ? o.userId.trim() : typeof o.user_id === "string" && o.user_id.trim() ? o.user_id.trim() : base.userId,
    notified: Boolean(o.notified),
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
}): ScheduleEventMetadata => ({
  dayIndex: incoming.dayIndex,
  time: incoming.time,
  child: incoming.child,
  type: incoming.type,
  zoomLink: incoming.zoomLink ?? null,
  isRecurring: incoming.isRecurring,
  recurringTemplateId: incoming.recurringTemplateId ?? null,
  completed: incoming.completed,
  sendNotification: incoming.sendNotification,
  requireConfirmation: incoming.requireConfirmation,
  needsAck: incoming.needsAck,
  reminderLeadMinutes: incoming.reminderLeadMinutes,
  userId: incoming.userId,
  notified: incoming.notified ?? false,
});

/**
 * Ensures JSONB `metadata` exists on `schedule` (user-created id/title/date).
 * Does not CREATE the table — only adds the column if missing.
 */
export const ensureScheduleMetadataColumn = async () => {
  await sql`
    ALTER TABLE schedule
    ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb
  `;
};
