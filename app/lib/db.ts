import postgres, { type SerializableParameter } from "postgres";
import {
  redactDatabaseUrl,
  resolveDatabaseUrlFromEnv,
  toTransactionPoolerUrl,
  type DatabaseUrlSource,
} from "@/app/lib/dbUrl";

export type { DatabaseUrlSource };

const resolveDatabaseUrl = () => resolveDatabaseUrlFromEnv(process.env);

export const getDatabaseConfig = () => resolveDatabaseUrl();

export const ensureDatabaseConnectionString = () => {
  const config = resolveDatabaseUrl();
  return config.url ? config : null;
};

/** Supabase table for calendar events (`public.schedule`). See `scheduleTable.ts` for metadata JSON shape. */
export const SCHEDULE_TABLE_NAME = "schedule" as const;

type PgRow = Record<string, unknown>;

type PgClient = ReturnType<typeof postgres>;
const globalForPg = globalThis as unknown as { __familySchedulerPg?: PgClient };
let pg: PgClient | null = globalForPg.__familySchedulerPg ?? null;

function getPostgres() {
  const { url, source } = resolveDatabaseUrl();
  if (!url) {
    return null;
  }
  if (!pg) {
    let connectionUrl = url;
    let needsSsl = true;
    try {
      const parsed = new URL(url);
      needsSsl = !/^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname);
      console.log(`[db] env=${source}`);
      console.log("[db] Attempting connection to host:", parsed.host, "port:", parsed.port || "5432");
      console.log("[db] url:", redactDatabaseUrl(url));
      if (needsSsl && !parsed.searchParams.has("sslmode")) {
        parsed.searchParams.set("sslmode", "require");
        connectionUrl = parsed.toString();
      }
    } catch {
      console.log(`[db] env=${source} (unparseable URL)`);
    }
    connectionUrl = toTransactionPoolerUrl(connectionUrl);
    let loggedPort = "6543";
    try {
      loggedPort = new URL(connectionUrl).port || "5432";
    } catch {
      // ignore
    }
    console.log("[db] pooled port:", loggedPort);
    pg = postgres(connectionUrl, {
      // Transaction pooler (port 6543). One client per serverless instance.
      max: 1,
      idle_timeout: 10,
      connect_timeout: 4,
      prepare: false,
      connection: { statement_timeout: 5000 },
      ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
    });
    globalForPg.__familySchedulerPg = pg;
  }
  return pg;
}

export function sql<T extends PgRow = PgRow>(
  strings: TemplateStringsArray,
  ...values: SerializableParameter[]
): Promise<{ rows: T[]; rowCount: number }> {
  const client = getPostgres();
  if (!client) {
    return Promise.reject(new Error("Missing database configuration"));
  }
  // Supavisor ignores statement_timeout as a startup parameter (it stays at 2 minutes).
  // Set it inside the transaction so a stuck query releases the single pooled connection.
  return client.begin(async (tx) => {
    await tx`SELECT set_config('statement_timeout', '5000', true)`;
    const result = await tx(strings, ...values);
    const rows = Array.from(result) as T[];
    return { rows, rowCount: result.count };
  }).then(
    (value) => value,
    (error: unknown) => {
      logDbError(error);
      throw error;
    },
  );
}

function logDbError(error: unknown) {
  const e = (error ?? {}) as {
    code?: string;
    errno?: string | number;
    message?: string;
    address?: string;
    port?: number;
    detail?: string;
    hint?: string;
  };
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
    const parsed = new URL(resolveDatabaseUrl().url);
    host = `${parsed.hostname}:${parsed.port || "5432"}`;
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

/** Client-facing DB error (no credentials). */
export function formatPublicDbError(error: unknown): string {
  const e = (error ?? {}) as { code?: string; errno?: string | number; message?: string };
  const message = String(e.message ?? (error instanceof Error ? error.message : error ?? ""));
  const code = String(e.code ?? e.errno ?? "");
  const isDns =
    code === "ENOTFOUND" ||
    code === "EAI_AGAIN" ||
    /ENOTFOUND|getaddrinfo|EAI_AGAIN/i.test(message);

  if (isDns) {
    return "לא נמצא שרת המסד (DNS). אם זה פרויקט חדש ב-Vercel, השתמשי ב-Transaction pooler (pooler.supabase.com:6543).";
  }
  if (code === "ENETUNREACH" || code === "EHOSTUNREACH" || /ENETUNREACH|EHOSTUNREACH/i.test(message)) {
    return "אין נתיב לשרת המסד. נסי שוב, או בדקי את מחרוזת החיבור ב-Vercel.";
  }
  if (code === "28P01" || code === "28000" || /password authentication|Tenant or user not found/i.test(message)) {
    return "אימות למסד נכשל. בדקי ש-DATABASE_URL / SUPABASE_DATABASE_URL ב-Vercel הוא אותו URI שעבד קודם, בלי שינוי שם משתמש.";
  }
  return message || "שגיאת מסד נתונים";
}

const TRANSIENT_DB_CODES = new Set([
  "CONNECT_TIMEOUT",
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
  "08000",
  "08001",
  "08003",
  "08004",
  "08006",
  "53300",
  "57014",
]);

/** Connection drops and statement timeouts while Supabase is waking up. Not auth or DNS. */
export function isTransientDbError(error: unknown): boolean {
  const e = (error ?? {}) as { code?: string; errno?: string | number; message?: string };
  const code = String(e.code ?? e.errno ?? "");
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "28P01" || code === "28000") return false;
  if (TRANSIENT_DB_CODES.has(code)) return true;
  const message = String(e.message ?? (error instanceof Error ? error.message : ""));
  return /timeout|timed out|Connection terminated|ECONNRESET|ECONNREFUSED|ETIMEDOUT|could not connect|Connection refused|server closed the connection|remaining connection slots|too many clients|statement timeout|canceling statement/i.test(message);
}

/** Drop the pooled socket so the next attempt opens a fresh connection. */
export function resetPostgresClient() {
  const dying = pg;
  pg = null;
  globalForPg.__familySchedulerPg = undefined;
  if (dying) {
    void Promise.resolve(dying.end({ timeout: 1 })).catch(() => undefined);
  }
}

/** One retry, 1s apart, after a cold-start connection or statement timeout. */
export async function withDbRetry<T>(run: () => Promise<T>, waitMs = 1000): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!isTransientDbError(error)) throw error;
    console.warn("[db] transient error, retrying once after 1s");
    resetPostgresClient();
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return await run();
  }
}

export function sqlJson(value: unknown) {
  const client = getPostgres();
  if (!client) {
    throw new Error("Missing database configuration");
  }
  return client.json(value as never);
}
