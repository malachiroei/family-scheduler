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

/**
 * Supabase session mode (pooler host, port 5432) holds a backend until the client disconnects,
 * which is what stalls Vercel. Transaction mode is the same host and user on port 6543.
 * Direct `db.*.supabase.co` URLs are left unchanged — the region is not in that host.
 */
export const toTransactionPoolerUrl = (raw: string): string => {
  const url = normalizeConnectionString(raw);
  if (!url) return url;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  const host = parsed.hostname.toLowerCase();
  if (!host.endsWith(".pooler.supabase.com")) return url;
  const port = parsed.port || "5432";
  if (port === "6543") return url;
  if (parsed.port) {
    return url.replace(/(\.pooler\.supabase\.com):5432\b/i, "$1:6543");
  }
  return url.replace(/(\.pooler\.supabase\.com)(?=\/)/i, "$1:6543");
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
