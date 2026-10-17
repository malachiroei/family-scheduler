const truthy = (value: string | undefined) => {
  const raw = String(value ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
};

export const deploymentIdentity = () =>
  [
    process.env.VERCEL_PROJECT_NAME,
    process.env.VERCEL_URL,
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

export const isFriendDeployment = (host = "") =>
  /family-scheduler-friend/.test(`${deploymentIdentity()} ${host}`.toLowerCase());

export const isOriginalHouseholdEnabled = (host = "") => {
  if (isFriendDeployment(host)) {
    return false;
  }
  if (truthy(process.env.NEXT_PUBLIC_ENABLE_BUILTIN_JOHNNY)) {
    return true;
  }
  const identity = deploymentIdentity();
  if (/family-scheduler-topaz/.test(identity)) {
    return true;
  }
  return String(process.env.VERCEL_PROJECT_NAME ?? "").toLowerCase() === "family-scheduler";
};

export const appMetadataBase = (): URL => {
  const candidates = [
    process.env.VERCEL_PROJECT_PRODUCTION_URL,
    process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
    process.env.VERCEL_URL,
    process.env.NEXT_PUBLIC_VERCEL_URL,
  ].filter((value): value is string => Boolean(value));
  for (const value of candidates) {
    try {
      return new URL(value.includes("://") ? value : `https://${value}`);
    } catch {
      continue;
    }
  }
  return new URL("http://localhost:3000");
};

export const siteUrlFromHost = (host?: string | null): string => {
  const hostname = (host ?? "").split(",")[0].trim().replace(/^https?:\/\//i, "");
  if (!hostname) {
    return appMetadataBase().origin;
  }
  if (/^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostname)) {
    return `http://${hostname}`;
  }
  return `https://${hostname}`;
};
