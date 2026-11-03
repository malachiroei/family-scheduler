export const NOTIFICATION_CATEGORIES = ["general", "training", "game", "medical"] as const;

export type NotificationCategory = (typeof NOTIFICATION_CATEGORIES)[number];

export type NotificationImportance = "low" | "normal" | "high";

export type PushUrgency = "low" | "normal" | "high";

export const NOTIFICATION_CATEGORY_OPTIONS: Array<{ value: NotificationCategory; label: string }> = [
  { value: "general", label: "כללי — שקטה" },
  { value: "training", label: "אימון — רגילה" },
  { value: "game", label: "משחק — גבוהה" },
  { value: "medical", label: "רפואי — דחופה" },
];

const categorySet = new Set<string>(NOTIFICATION_CATEGORIES);

export const normalizeNotificationCategory = (value: unknown): NotificationCategory | null => {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return categorySet.has(raw) ? (raw as NotificationCategory) : null;
};

/** Explicit category wins. Otherwise sport/משחק → game, practice → training, clinic words → medical. */
export const inferNotificationCategory = (input: {
  category?: unknown;
  type?: string | null;
  title?: string | null;
}): NotificationCategory => {
  const explicit = normalizeNotificationCategory(input.category);
  if (explicit) return explicit;

  const type = String(input.type || "").trim().toLowerCase();
  const title = String(input.title || "");
  if (type === "medical" || /תור|מרפאה|רופא|חיסון|וטרינר|בית חולים/.test(title)) {
    return "medical";
  }
  if (type === "sport" || /משחק/.test(title)) {
    return "game";
  }
  if (
    type === "gym" ||
    type === "lesson" ||
    type === "dance" ||
    type === "tutoring" ||
    /אימון|שיעור|ריקוד|תגבור/.test(title)
  ) {
    return "training";
  }
  return "general";
};

export const sharedNotificationCategory = (
  items: Array<{
    category?: unknown;
    notificationCategory?: unknown;
    type?: string | null;
    title?: string | null;
  }>,
): NotificationCategory => {
  if (!items.length) return "general";
  const categories = items.map((item) => inferNotificationCategory({
    category: item.category ?? item.notificationCategory,
    type: item.type,
    title: item.title,
  }));
  const first = categories[0];
  return categories.every((category) => category === first) ? first : "general";
};

/** Device grouping key, vibration, and delivery urgency for one channel. */
export const notificationChannelProfile = (category: NotificationCategory) => {
  switch (category) {
    case "medical":
      return {
        tag: "medical",
        vibrate: [400, 150, 400, 150, 400],
        importance: "high" as NotificationImportance,
        urgency: "high" as PushUrgency,
        requireInteraction: true,
        renotify: true,
      };
    case "game":
      return {
        tag: "game",
        vibrate: [200, 80, 200, 80, 500],
        importance: "high" as NotificationImportance,
        urgency: "high" as PushUrgency,
        requireInteraction: true,
        renotify: true,
      };
    case "training":
      return {
        tag: "training",
        vibrate: [120, 70, 120],
        importance: "normal" as NotificationImportance,
        urgency: "normal" as PushUrgency,
        requireInteraction: false,
        renotify: true,
      };
    default:
      return {
        tag: "general",
        vibrate: [80, 40, 80],
        importance: "low" as NotificationImportance,
        urgency: "low" as PushUrgency,
        requireInteraction: false,
        renotify: false,
      };
  }
};
