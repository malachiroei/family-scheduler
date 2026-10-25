import postgres, { type SerializableParameter } from "postgres";
import {
  redactDatabaseUrl,
  resolveDatabaseUrlFromEnv,
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
    pg = postgres(connectionUrl, {
      max: 1,
      idle_timeout: 5,
      connect_timeout: 5,
      prepare: false,
      connection: { statement_timeout: 8000 },
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

export function sqlJson(value: unknown) {
  const client = getPostgres();
  if (!client) {
    throw new Error("Missing database configuration");
  }
  return client.json(value as never);
}
