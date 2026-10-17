export type DatabaseUrlSource =
  | "SUPABASE_POSTGRES_URL"
  | "SUPABASE_DATABASE_URL"
  | "POSTGRES_URL"
  | "DATABASE_URL"
  | "MISSING";

export type ResolvedDatabaseUrl = {
  url: string;
  source: DatabaseUrlSource;
};

/**
 * Trim, strip one pair of surrounding quotes, and drop a leading `psql ` prefix.
 * Does not encode the password — special characters must already be percent-encoded in env.
 */
export const normalizeConnectionString = (raw: string | undefined): string => {
  let s = (raw ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/^psql\s+/i, "").trim();
  return s;
};

type EnvMap = Record<string, string | undefined>;

/**
 * First non-empty connection string, in the historical order this app has always used.
 * No pooler-vs-direct ranking and no username rewriting — the chosen URI is returned as-is.
 */
export const resolveDatabaseUrlFromEnv = (env: EnvMap): ResolvedDatabaseUrl => {
  const candidates: Array<{ source: Exclude<DatabaseUrlSource, "MISSING">; url: string }> = [
    { source: "SUPABASE_DATABASE_URL", url: normalizeConnectionString(env.SUPABASE_DATABASE_URL) },
    { source: "DATABASE_URL", url: normalizeConnectionString(env.DATABASE_URL) },
    { source: "SUPABASE_POSTGRES_URL", url: normalizeConnectionString(env.SUPABASE_POSTGRES_URL) },
    { source: "POSTGRES_URL", url: normalizeConnectionString(env.POSTGRES_URL) },
  ];
  const chosen = candidates.find((entry) => entry.url.length > 0);
  if (!chosen) {
    return { url: "", source: "MISSING" };
  }
  return { url: chosen.url, source: chosen.source };
};

export const redactDatabaseUrl = (url: string): string => {
  try {
    const parsed = new URL(url);
    if (parsed.password) {
      parsed.password = "***";
    }
    return `${parsed.protocol}//${parsed.username ? `${parsed.username}:***@` : ""}${parsed.host}${parsed.pathname}`;
  } catch {
    return "(unparseable)";
  }
};
