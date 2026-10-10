import postgres, { type SerializableParameter } from "postgres";

export type DatabaseUrlSource =
  | "SUPABASE_POSTGRES_URL"
  | "SUPABASE_DATABASE_URL"
  | "POSTGRES_URL"
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
  return s.trim();
};

/** Port 6543 (transaction pooler) -> 5432 (session pooler, reachable over IPv4). Credentials untouched. */
// DISABLED: keep the URL exactly as configured. Transaction pooler (6543) + prepare:false + max:1 is the
// right setup for serverless; session mode (5432) exhausted pooler slots (EMAXCONNSESSION) / timed out.
const forceSessionPort = (url: string): string => url;

// Resolve connection string (Supabase envs first). Works with Supabase / Neon / any Postgres.
const resolveDatabaseUrl = (): { url: string; source: DatabaseUrlSource } => {
  const supabasePostgres = normalizeConnectionString(process.env.SUPABASE_POSTGRES_URL);
  const supabaseDatabase = normalizeConnectionString(process.env.SUPABASE_DATABASE_URL);
  const postgresUrl = normalizeConnectionString(process.env.POSTGRES_URL);
  const databaseUrl = normalizeConnectionString(process.env.DATABASE_URL);

  // Priority: SUPABASE_DATABASE_URL first.
  if (supabaseDatabase) {
    return { url: forceSessionPort(supabaseDatabase), source: "SUPABASE_DATABASE_URL" };
  }
  if (supabasePostgres) {
    return { url: forceSessionPort(supabasePostgres), source: "SUPABASE_POSTGRES_URL" };
  }
  if (postgresUrl) {
    return { url: forceSessionPort(postgresUrl), source: "POSTGRES_URL" };
  }
  if (databaseUrl) {
    return { url: forceSessionPort(databaseUrl), source: "DATABASE_URL" };
  }

  return { url: "", source: "MISSING" };
};

const initialConfig = resolveDatabaseUrl();
if (initialConfig.url) {
  process.env.POSTGRES_URL = initialConfig.url;
}

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
    try {
      const u = new URL(url);
      console.log(`[db] connecting: env=${source} host=${u.hostname} port=${u.port || "5432"}`);
    } catch {
      console.log(`[db] connecting: env=${source} (unparseable URL)`);
    }
    const needsSsl = !/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
    pg = postgres(url, {
      max: 2, // two connections: an edit save and a background refresh must not block each other
      idle_timeout: 2, // seconds; release the pooler slot right after the query finishes
      connect_timeout: 5, // seconds; fail fast if the network route is stuck (e.g. IPv6 unreachable)
      // Required behind a Transaction-mode pooler (Supabase :6543 / PgBouncer), which breaks on prepared statements.
      prepare: false,
      // SSL is mandatory for Supabase's pooler (PgBouncer).
      ...(needsSsl ? { ssl: "require" as const } : {}),
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

/** Safe JSON/JSONB parameter for `sql\`...\`` (prefer over string + `::jsonb`). */
export function sqlJson(value: unknown) {
  const client = getPostgres();
  if (!client) {
    throw new Error("Missing database configuration");
  }
  return client.json(value as never);
}
