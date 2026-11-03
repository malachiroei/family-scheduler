export const NOTIFICATION_LEVELS = ["silent", "normal", "medium", "urgent"] as const;

export type NotificationLevel = (typeof NOTIFICATION_LEVELS)[number];

/** Stored on events. Older rows may still say general, training, game, or medical. */
export type NotificationCategory = NotificationLevel;

export type NotificationImportance = "low" | "normal" | "high";

export type PushUrgency = "very-low" | "low" | "normal" | "high";

export const NOTIFICATION_LEVEL_OPTIONS: Array<{ value: NotificationLevel; label: string }> = [
  { value: "silent", label: "שקטה" },
  { value: "normal", label: "רגילה" },
  { value: "medium", label: "בינונית" },
  { value: "urgent", label: "חשובה" },
];

export const NOTIFICATION_CATEGORY_OPTIONS = NOTIFICATION_LEVEL_OPTIONS;

const levelSet = new Set<string>(NOTIFICATION_LEVELS);

const legacyLevel: Record<string, NotificationLevel> = {
  silent: "silent",
  quiet: "silent",
  general: "silent",
  normal: "normal",
  standard: "normal",
  training: "normal",
  medium: "medium",
  game: "medium",
  urgent: "urgent",
  important: "urgent",
  medical: "urgent",
};

export const normalizeNotificationCategory = (value: unknown): NotificationLevel | null => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return legacyLevel[raw] ?? (levelSet.has(raw) ? (raw as NotificationLevel) : null);
};

/** An explicit level wins. Missing values stay at the caller's fallback (usually the user's default, or רגילה). */
export const inferNotificationCategory = (input: {
  category?: unknown;
  type?: string | null;
  title?: string | null;
}): NotificationLevel => normalizeNotificationCategory(input.category) ?? "normal";

export const sharedNotificationCategory = (
  items: Array<{
    category?: unknown;
    notificationCategory?: unknown;
    type?: string | null;
    title?: string | null;
  }>,
): NotificationLevel => {
  if (!items.length) return "normal";
  const levels = items.map((item) => inferNotificationCategory({
    category: item.category ?? item.notificationCategory,
  }));
  const first = levels[0];
  return levels.every((level) => level === first) ? first : "normal";
};

/** Device grouping key, vibration, and delivery urgency for one level. */
export const notificationChannelProfile = (level: NotificationLevel) => {
  switch (level) {
    case "silent":
      return {
        tag: "silent",
        vibrate: [] as number[],
        importance: "low" as NotificationImportance,
        urgency: "very-low" as PushUrgency,
        requireInteraction: false,
        renotify: false,
        silent: true,
      };
    case "medium":
      return {
        tag: "medium",
        vibrate: [150, 100, 150],
        importance: "normal" as NotificationImportance,
        urgency: "normal" as PushUrgency,
        requireInteraction: false,
        renotify: true,
        silent: false,
      };
    case "urgent":
      return {
        tag: "urgent",
        vibrate: [300, 100, 300, 100, 400],
        importance: "high" as NotificationImportance,
        urgency: "high" as PushUrgency,
        requireInteraction: true,
        renotify: true,
        silent: false,
      };
    default:
      return {
        tag: "normal",
        vibrate: [100],
        importance: "normal" as NotificationImportance,
        urgency: "normal" as PushUrgency,
        requireInteraction: false,
        renotify: true,
        silent: false,
      };
  }
};
