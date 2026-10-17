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
export const GENERIC_APP_ICON = "/generic-family-icon.png";
export const ORIGINAL_LOGO_SRC = "/logo.png";
export const ORIGINAL_FAVICON_SRC = "/favicon.ico";

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

export const appIconSrc = (icon: string) => {
  if (icon === ORIGINAL_APP_ICON) {
    return isOriginalHouseholdEnabled() ? ORIGINAL_LOGO_SRC : GENERIC_APP_ICON;
  }
  return icon;
};

export const defaultFaviconHref = () =>
  isOriginalHouseholdEnabled() ? ORIGINAL_FAVICON_SRC : GENERIC_APP_ICON;

const emojiFaviconDataUri = (emoji: string) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><text x="50%" y="56%" dominant-baseline="middle" text-anchor="middle" font-size="48">${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
};

export const brandingFaviconHref = (icon: string): string => {
  const resolved = appIconSrc(icon || defaultAppBranding().app_icon);
  if (!resolved) {
    return defaultFaviconHref();
  }
  if (resolved === ORIGINAL_APP_ICON) {
    return defaultFaviconHref();
  }
  if (isImageAppIcon(resolved)) {
    return resolved === ORIGINAL_LOGO_SRC ? ORIGINAL_FAVICON_SRC : resolved;
  }
  return emojiFaviconDataUri(resolved);
};

export const applyDocumentFavicon = (icon: string) => {
  if (typeof document === "undefined") {
    return;
  }
  const href = brandingFaviconHref(icon);
  const type = href.startsWith("data:image/svg")
    ? "image/svg+xml"
    : href.startsWith("data:image/")
      ? "image/png"
      : href.endsWith(".ico")
        ? "image/x-icon"
        : "image/png";
  let link = document.querySelector<HTMLLinkElement>("link[rel='icon'][data-app-branding='1']");
  if (!link) {
    link = document.createElement("link");
    link.rel = "icon";
    link.setAttribute("data-app-branding", "1");
    document.head.appendChild(link);
  }
  link.type = type;
  link.href = href;
  document.querySelectorAll("link[rel='icon']:not([data-app-branding])").forEach((node) => {
    node.setAttribute("href", href);
  });
};

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
  let icon = stored?.app_icon?.trim() || defaults.app_icon;
  if (!isOriginalHouseholdEnabled() && icon === ORIGINAL_APP_ICON) {
    icon = defaults.app_icon;
  }
  return {
    app_title: stored?.app_title?.trim() || defaults.app_title,
    app_icon: icon,
  };
};

export const sanitizeAppBrandingInput = (input: { app_title?: unknown; app_icon?: unknown }): AppBranding => {
  const defaults = defaultAppBranding();
  const title = typeof input.app_title === "string" ? input.app_title.trim().slice(0, MAX_TITLE_LENGTH) : "";
  let icon = typeof input.app_icon === "string" ? input.app_icon.trim().slice(0, MAX_ICON_LENGTH) : "";
  if (!isOriginalHouseholdEnabled() && icon === ORIGINAL_APP_ICON) {
    icon = defaults.app_icon;
  }
  return {
    app_title: title || defaults.app_title,
    app_icon: icon || defaults.app_icon,
  };
};
