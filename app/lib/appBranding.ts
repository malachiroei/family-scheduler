import { isOriginalHouseholdEnabled } from "@/app/lib/familyMembers";

export const APP_BRANDING_STATE_KEY = "app_branding";

export type AppBranding = {
  app_title: string;
  app_icon: string;
};

export const APP_ICON_PRESETS = ["📅", "🏡", "👨‍👩‍👧‍👦", "⭐", "🚀", "❤️", "🐶", "🌈"] as const;

export const ORIGINAL_APP_TITLE = "Malachi Family Time";
export const GENERIC_APP_TITLE = "הלו״ז המשפחתי שלנו";
export const ORIGINAL_APP_ICON = "logo";
export const GENERIC_APP_ICON = "📅";
export const ORIGINAL_LOGO_SRC = "/logo.png";

export const defaultAppBranding = (): AppBranding =>
  isOriginalHouseholdEnabled()
    ? { app_title: ORIGINAL_APP_TITLE, app_icon: ORIGINAL_APP_ICON }
    : { app_title: GENERIC_APP_TITLE, app_icon: GENERIC_APP_ICON };

const MAX_TITLE_LENGTH = 80;
const MAX_ICON_LENGTH = 180_000;

export const isImageAppIcon = (icon: string) =>
  icon === ORIGINAL_APP_ICON ||
  icon.startsWith("data:image/") ||
  /^https?:\/\//i.test(icon) ||
  icon.startsWith("/");

export const appIconSrc = (icon: string) => (icon === ORIGINAL_APP_ICON ? ORIGINAL_LOGO_SRC : icon);

export const parseAppBranding = (raw: unknown): Partial<AppBranding> | null => {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return null;
  }
  const row = payload as Record<string, unknown>;
  const app_title = typeof row.app_title === "string" ? row.app_title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const app_icon = typeof row.app_icon === "string" ? row.app_icon.trim().slice(0, MAX_ICON_LENGTH) : "";
  if (!app_title && !app_icon) {
    return null;
  }
  return {
    ...(app_title ? { app_title } : {}),
    ...(app_icon ? { app_icon } : {}),
  };
};

export const mergeAppBranding = (stored: Partial<AppBranding> | null | undefined): AppBranding => {
  const defaults = defaultAppBranding();
  return {
    app_title: stored?.app_title?.trim() || defaults.app_title,
    app_icon: stored?.app_icon?.trim() || defaults.app_icon,
  };
};

export const sanitizeAppBrandingInput = (input: { app_title?: unknown; app_icon?: unknown }): AppBranding => {
  const defaults = defaultAppBranding();
  const title = typeof input.app_title === "string" ? input.app_title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  const icon = typeof input.app_icon === "string" ? input.app_icon.trim().slice(0, MAX_ICON_LENGTH) : "";
  return {
    app_title: title || defaults.app_title,
    app_icon: icon || defaults.app_icon,
  };
};
