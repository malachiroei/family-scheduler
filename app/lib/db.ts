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

// Resolve connection string (Supabase envs first). Works with Supabase / Neon / any Postgres.
const resolveDatabaseUrl = (): { url: string; source: DatabaseUrlSource } => {
  const supabasePostgres = normalizeConnectionString(process.env.SUPABASE_POSTGRES_URL);
  const supabaseDatabase = normalizeConnectionString(process.env.SUPABASE_DATABASE_URL);
  const postgresUrl = normalizeConnectionString(process.env.POSTGRES_URL);
  const databaseUrl = normalizeConnectionString(process.env.DATABASE_URL);

  if (supabasePostgres) {
    return { url: supabasePostgres, source: "SUPABASE_POSTGRES_URL" };
  }
  if (supabaseDatabase) {
    return { url: supabaseDatabase, source: "SUPABASE_DATABASE_URL" };
  }
  if (postgresUrl) {
    return { url: postgresUrl, source: "POSTGRES_URL" };
  }
  if (databaseUrl) {
    return { url: databaseUrl, source: "DATABASE_URL" };
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

let pg: ReturnType<typeof postgres> | null = null;

function getPostgres() {
  const { url } = resolveDatabaseUrl();
  if (!url) {
    return null;
  }
  if (!pg) {
    const needsSsl = !/^postgres(ql)?:\/\/[^@]+@(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);
    pg = postgres(url, {
      max: 1,
      idle_timeout: 20,
      connect_timeout: 30,
      ...(needsSsl ? { ssl: "require" as const } : {}),
    });
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
  return client(strings, ...values).then((result) => {
    const rows = Array.from(result) as T[];
    return { rows, rowCount: result.count };
  });
}
