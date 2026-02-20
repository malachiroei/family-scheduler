import { sql } from "@vercel/postgres";

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
