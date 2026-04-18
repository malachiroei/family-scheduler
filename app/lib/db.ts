import { sql } from "@vercel/postgres";

// @vercel/postgres reads POSTGRES_URL only. Sync from DATABASE_URL as soon as this module loads
// (before any sql`…`), so API routes always see a connection string when .env.local defines DATABASE_URL.
const dbUrl = process.env.DATABASE_URL?.trim();
const pgUrl = process.env.POSTGRES_URL?.trim();
if (dbUrl && !pgUrl) {
  process.env.POSTGRES_URL = dbUrl;
}

const resolveDatabaseUrl = () => {
  const postgresUrl = process.env.POSTGRES_URL?.trim();
  const databaseUrl = process.env.DATABASE_URL?.trim();

  if (postgresUrl) {
    return { url: postgresUrl, source: "POSTGRES_URL" as const };
  }

  if (databaseUrl) {
    process.env.POSTGRES_URL = databaseUrl;
    return { url: databaseUrl, source: "DATABASE_URL" as const };
  }

  return { url: "", source: "MISSING" as const };
};

export const getDatabaseConfig = () => resolveDatabaseUrl();

export const ensureDatabaseConnectionString = () => {
  const config = resolveDatabaseUrl();
  return config.url ? config : null;
};

export { sql };
