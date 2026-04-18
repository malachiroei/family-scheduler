import { sql } from "@vercel/postgres";

export type DatabaseUrlSource =
  | "SUPABASE_POSTGRES_URL"
  | "SUPABASE_DATABASE_URL"
  | "POSTGRES_URL"
  | "DATABASE_URL"
  | "MISSING";

// @vercel/postgres reads POSTGRES_URL only. Resolve connection string (Supabase envs first), then
// assign process.env.POSTGRES_URL before any sql`…`. Import sql from this file so this runs first.
const resolveDatabaseUrl = (): { url: string; source: DatabaseUrlSource } => {
  const supabasePostgres = process.env.SUPABASE_POSTGRES_URL?.trim();
  const supabaseDatabase = process.env.SUPABASE_DATABASE_URL?.trim();
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();

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

export { sql };
