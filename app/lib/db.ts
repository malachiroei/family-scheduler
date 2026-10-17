import postgres, { type SerializableParameter } from "postgres";

export type DatabaseUrlSource =
  | "SUPABASE_POSTGRES_URL"
  | "SUPABASE_DATABASE_URL"
  | "POSTGRES_URL"
  | "POSTGRES_PRISMA_URL"
  | "DATABASE_URL"
  | "MISSING";

/**
 * Trim and strip one pair of surrounding quotes only. Does not encode — passwords with `!` must
 * already be percent-encoded in env (e.g. %21) like on Vercel; we never run encodeURIComponent on the URL.
 */
const normalizeConnectionString = (raw: string | undefined): string => {
  let s = (raw ?? "").trim();
  if (s.length >= 2 && ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'")))) {
    s = s.slice(1, -1);
  }
  s = s.replace(/^psql\s+/i, "").trim();
  return s;
};

const projectRefFromHostname = (hostname: string): string | null => {
  const host = hostname.toLowerCase();
  const direct = host.match(/^db\.([a-z0-9]+)\.supabase\.co$/);
  if (direct) return direct[1];
  const api = host.match(/^([a-z0-9]+)\.supabase\.co$/);
  if (api && api[1] !== "www") return api[1];
  return null;
};

const projectRefFromUsername = (username: string): string | null => {
  const match = decodeURIComponent(username || "").match(/^postgres\.([a-z0-9]+)$/i);
  return match ? match[1] : null;
};

/** Supabase project ref, from any configured URL / user. Needed so the pooler accepts the login. */
const extractSupabaseProjectRef = (): string | null => {
  const explicit = (process.env.SUPABASE_PROJECT_REF || process.env.NEXT_PUBLIC_SUPABASE_PROJECT_REF || "").trim();
  if (/^[a-z0-9]+$/i.test(explicit)) {
    return explicit.toLowerCase();
  }
  const userEnv = process.env.POSTGRES_USER || process.env.POSTGRES_USER_NAME || "";
  const fromUserEnv = projectRefFromUsername(userEnv);
  if (fromUserEnv) {
    return fromUserEnv;
  }
  const rawCandidates = [
    process.env.NEXT_PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_URL,
    process.env.POSTGRES_URL_NON_POOLING,
    process.env.SUPABASE_POSTGRES_URL,
    process.env.SUPABASE_DATABASE_URL,
    process.env.POSTGRES_URL,
    process.env.POSTGRES_PRISMA_URL,
    process.env.DATABASE_URL,
  ];
  for (const raw of rawCandidates) {
    const url = normalizeConnectionString(raw);
    if (!url) continue;
    try {
      const parsed = new URL(url.includes("://") ? url : `https://${url}`);
      const fromHost = projectRefFromHostname(parsed.hostname);
      if (fromHost) return fromHost;
      const fromUser = projectRefFromUsername(parsed.username);
      if (fromUser) return fromUser;
    } catch {
      // ignore unparseable env values
    }
  }
  return null;
};

/** Pooler rejects user `postgres`; it needs `postgres.<project-ref>`. */
const rewritePoolerUsername = (url: string): string => {
  if (classifyDatabaseUrl(url) !== "pooled") {
    return url;
  }
  const parsed = parseDbUrl(url);
  if (!parsed) {
    return url;
  }
  const username = decodeURIComponent(parsed.username || "");
  if (!/^postgres$/i.test(username)) {
    return url;
  }
  const ref = extractSupabaseProjectRef();
  if (!ref) {
    console.warn("[db] pooler URL user is 'postgres'; expected postgres.PROJECT_REF and no project ref was found in env");
    return url;
  }
  parsed.username = `postgres.${ref}`;
  console.log(`[db] pooler username rewritten to postgres.${ref}`);
  return parsed.toString();
};

type UrlKind = "pooled" | "direct" | "other";

const parseDbUrl = (url: string): URL | null => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

/** Direct host `db.<ref>.supabase.co` is IPv6-only / often ENOTFOUND on Vercel. Use the pooler instead. */
const classifyDatabaseUrl = (url: string): UrlKind => {
  const parsed = parseDbUrl(url);
  if (!parsed) {
    return "other";
  }
  const host = parsed.hostname.toLowerCase();
  const port = parsed.port || "5432";
  if (
    host.includes("pooler.supabase.com") ||
    port === "6543" ||
    parsed.searchParams.get("pgbouncer") === "true"
  ) {
    return "pooled";
  }
  if (/^db\.[a-z0-9]+\.supabase\.co$/.test(host)) {
    return "direct";
  }
  return "other";
};

type DatabaseCandidate = { url: string; source: Exclude<DatabaseUrlSource, "MISSING"> };

const collectDatabaseCandidates = (): DatabaseCandidate[] => {
  const entries: DatabaseCandidate[] = [
    { url: normalizeConnectionString(process.env.SUPABASE_DATABASE_URL), source: "SUPABASE_DATABASE_URL" },
    { url: normalizeConnectionString(process.env.POSTGRES_URL), source: "POSTGRES_URL" },
    { url: normalizeConnectionString(process.env.POSTGRES_PRISMA_URL), source: "POSTGRES_PRISMA_URL" },
    { url: normalizeConnectionString(process.env.SUPABASE_POSTGRES_URL), source: "SUPABASE_POSTGRES_URL" },
    { url: normalizeConnectionString(process.env.DATABASE_URL), source: "DATABASE_URL" },
  ];
  // Never use the Vercel/Supabase "non-pooling" / Direct URL on serverless.
  return entries.filter((entry) => entry.url.length > 0);
};

const pickDatabaseCandidate = (candidates: DatabaseCandidate[]): DatabaseCandidate | null => {
  if (!candidates.length) {
    return null;
  }
  const pooled = candidates.filter((entry) => classifyDatabaseUrl(entry.url) === "pooled");
  if (pooled.length) {
    return pooled[0];
  }
  const notDirect = candidates.filter((entry) => classifyDatabaseUrl(entry.url) !== "direct");
  if (notDirect.length) {
    return notDirect[0];
  }
  return candidates[0];
};

// Resolve connection string. Prefer a Supabase transaction pooler URL over Direct `db.*.supabase.co`,
// which fails DNS on Vercel (ENOTFOUND) even when the password is correct.
const resolveDatabaseUrl = (): { url: string; source: DatabaseUrlSource } => {
  const chosen = pickDatabaseCandidate(collectDatabaseCandidates());
  if (!chosen) {
    return { url: "", source: "MISSING" };
  }
  return { url: rewritePoolerUsername(chosen.url), source: chosen.source };
};

export const getDatabaseConfig = () => resolveDatabaseUrl();

export const ensureDatabaseConnectionString = () => {
  const config = resolveDatabaseUrl();
  return config.url ? config : null;
};

/** Supabase table for calendar events (`public.schedule`). See `scheduleTable.ts` for metadata JSON shape. */
export const SCHEDULE_TABLE_NAME = "schedule" as const;

type PgRow = Record<string, unknown>;

type PgClient = ReturnType<typeof postgres>;
// Keep one connection pool per server instance, also across dev hot reloads (module re-evaluation),
// so requests reuse warm connections instead of opening a new one each time.
const globalForPg = globalThis as unknown as { __familySchedulerPg?: PgClient };
let pg: PgClient | null = globalForPg.__familySchedulerPg ?? null;

function getPostgres() {
  const { url, source } = resolveDatabaseUrl();
  if (!url) {
    return null;
  }
  if (!pg) {
    const parsed = parseDbUrl(url);
    const needsSsl = parsed ? !/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname) : true;
    const username = parsed ? decodeURIComponent(parsed.username || "") : "";
    const database = parsed
      ? decodeURIComponent((parsed.pathname || "/postgres").replace(/^\//, "") || "postgres")
      : "postgres";
    console.log(`[db] env=${source}`);
    if (parsed) {
      console.log("[db] Attempting connection to host:", parsed.host, "port:", parsed.port || "5432", "user:", username);
    } else {
      console.log(`[db] env=${source} (unparseable URL)`);
    }
    if (classifyDatabaseUrl(url) === "direct") {
      console.warn(
        "[db] Direct Supabase host (db.*.supabase.co) is not reachable from Vercel. Set DATABASE_URL / POSTGRES_URL to the Transaction pooler URI (*.pooler.supabase.com:6543).",
      );
    }
    // Pass host/user/password as fields so special characters in the password are not lost to URL encoding.
    pg = parsed
      ? postgres({
          host: parsed.hostname,
          port: Number(parsed.port || "5432"),
          database,
          username,
          password: parsed.password,
          max: 5,
          idle_timeout: 2,
          connect_timeout: 10,
          prepare: false,
          ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        })
      : postgres(url, {
          max: 5,
          idle_timeout: 2,
          connect_timeout: 10,
          prepare: false,
          ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
        });
    globalForPg.__familySchedulerPg = pg;
  }
  return pg;
}

/**
 * Tagged template SQL — same call style as before, but result is `{ rows, rowCount }` (node-pg shape)
 * for compatibility with the rest of the codebase.
 */
export function sql<T extends PgRow = PgRow>(
  strings: TemplateStringsArray,
  ...values: SerializableParameter[]
): Promise<{ rows: T[]; rowCount: number }> {
  const client = getPostgres();
  if (!client) {
    return Promise.reject(new Error("Missing database configuration"));
  }
  return client(strings, ...values).then(
    (result) => {
      const rows = Array.from(result) as T[];
      return { rows, rowCount: result.count };
    },
    (error: unknown) => {
      logDbError(error);
      throw error;
    },
  );
}

/** Classify and log connection/query errors (never logs credentials). */
function logDbError(error: unknown) {
  const e = (error ?? {}) as { code?: string; errno?: string | number; message?: string; address?: string; port?: number; detail?: string; hint?: string };
  const code = String(e.code ?? e.errno ?? "");
  let kind = "QUERY_ERROR";
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH") kind = "NETWORK_UNREACHABLE (likely IPv6 / no route)";
  else if (code === "CONNECT_TIMEOUT" || code === "ETIMEDOUT") kind = "CONNECT_TIMEOUT (network stuck)";
  else if (code === "ENOTFOUND" || code === "EAI_AGAIN") kind = "DNS_FAILURE";
  else if (code === "ECONNREFUSED" || code === "ECONNRESET") kind = "CONNECTION_REFUSED_OR_RESET";
  else if (code === "28P01" || code === "28000" || /password authentication|Tenant or user not found/i.test(e.message ?? "")) kind = "AUTH_ERROR";
  else if (/SSL|TLS|certificate/i.test(e.message ?? "")) kind = "SSL_ERROR";
  let host = "unknown";
  try {
    const u = new URL(resolveDatabaseUrl().url);
    host = `${u.hostname}:${u.port}`;
  } catch {
    // ignore
  }
  console.error(`[db] ${kind}`, {
    code,
    message: e.message,
    address: e.address,
    port: e.port,
    detail: e.detail,
    hint: e.hint,
    host,
  });
}

/** Client-facing DB error (no credentials). ENOTFOUND on db.*.supabase.co is DNS, not a bad password. */
export function formatPublicDbError(error: unknown): string {
  const e = (error ?? {}) as { code?: string; errno?: string | number; message?: string };
  const message = String(e.message ?? (error instanceof Error ? error.message : error ?? ""));
  const code = String(e.code ?? e.errno ?? "");
  const parsed = parseDbUrl(resolveDatabaseUrl().url);
  const host = parsed?.hostname ?? "";
  const isDns =
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message);

  if (isDns && /^db\./i.test(host) && /supabase\.co$/i.test(host)) {
    return "הסיסמה תקינה, אבל זה Direct connection (db.…supabase.co) ש-Vercel לא מצליח לפתור. ב-Supabase: Connect → Transaction pooler, והדביקי ב-Vercel URI עם מארח pooler.supabase.com ופורט 6543.";
  }
  if (isDns) {
    return `לא נמצא שרת המסד (DNS${host ? `: ${host}` : ""}). בדקי שה-URI הוא של ה-pooler, לא Direct.`;
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || /ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    return "אין נתיב לשרת המסד (לרוב Direct/IPv6). השתמשי ב-Transaction pooler של Supabase.";
  }
  if (/Tenant or user not found/i.test(message)) {
    const user = decodeURIComponent(parsed?.username || "") || "postgres";
    const ref = extractSupabaseProjectRef();
    const expected = ref ? `postgres.${ref}` : "postgres ומזהה הפרויקט (כמו postgres.abcdefghijklmnop)";
    return `ה-pooler לא מזהה את המשתמש "${user}". ב-URI שם המשתמש חייב להיות ${expected}, לא postgres בלבד.`;
  }
  if (code === "28P01" || code === "28000" || /password authentication/i.test(message)) {
    return "אימות למסד נכשל. בדקי את הסיסמה ב-URI ב-Vercel; תווים מיוחדים בסיסמה צריכים קידוד (למשל ! הופך ל-%21).";
  }
  return message || "שגיאת מסד נתונים";
}

/** Safe JSON/JSONB parameter for `sql\`...\`` (prefer over string + `::jsonb`). */
export function sqlJson(value: unknown) {
  const client = getPostgres();
  if (!client) {
    throw new Error("Missing database configuration");
  }
  return client.json(value as never);
}
