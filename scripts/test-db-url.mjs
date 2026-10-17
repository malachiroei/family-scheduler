import { normalizeConnectionString, redactDatabaseUrl, resolveDatabaseUrlFromEnv } from "../app/lib/dbUrl.ts";

const assert = (condition, message) => {
  if (!condition) {
    throw new Error(message);
  }
};

const originalPooler =
  "postgresql://postgres.awolohfkegyrumpkjxiu:Secret%21Pass@aws-0-eu-central-1.pooler.supabase.com:6543/postgres";
const originalDirect =
  "postgresql://postgres:SecretPass@db.originalproject.supabase.co:5432/postgres";
const quoted = `"${originalDirect}"`;
const withPsql = `psql ${originalPooler}`;

assert(normalizeConnectionString(quoted) === originalDirect, "should strip surrounding quotes");
assert(normalizeConnectionString(withPsql) === originalPooler, "should strip psql prefix");
assert(normalizeConnectionString("  ") === "", "empty stays empty");

const prefersSupabaseDatabase = resolveDatabaseUrlFromEnv({
  SUPABASE_DATABASE_URL: originalDirect,
  DATABASE_URL: originalPooler,
  POSTGRES_URL: "postgresql://postgres:other@aws-0-eu-central-1.pooler.supabase.com:6543/postgres",
});
assert(prefersSupabaseDatabase.source === "SUPABASE_DATABASE_URL", "SUPABASE_DATABASE_URL must win");
assert(prefersSupabaseDatabase.url === originalDirect, "winning URL must be used as-is");

const prefersDatabaseOverPostgres = resolveDatabaseUrlFromEnv({
  DATABASE_URL: originalDirect,
  POSTGRES_URL: originalPooler,
});
assert(prefersDatabaseOverPostgres.source === "DATABASE_URL", "DATABASE_URL must beat POSTGRES_URL");
assert(prefersDatabaseOverPostgres.url === originalDirect, "must not swap in a pooler URL");
assert(
  prefersDatabaseOverPostgres.url.includes("postgres:SecretPass@db.originalproject.supabase.co"),
  "must not rewrite the original username",
);

const poolerUnchanged = resolveDatabaseUrlFromEnv({
  DATABASE_URL: originalPooler,
});
assert(poolerUnchanged.url === originalPooler, "pooler URI must stay verbatim");
assert(poolerUnchanged.url.includes("postgres.awolohfkegyrumpkjxiu:"), "must not rewrite pooler user");

const missing = resolveDatabaseUrlFromEnv({});
assert(missing.source === "MISSING" && missing.url === "", "empty env is MISSING");

const redacted = redactDatabaseUrl(originalPooler);
assert(!redacted.includes("Secret"), "redaction must hide the password");
assert(redacted.includes("aws-0-eu-central-1.pooler.supabase.com"), "redaction must keep the host");

console.log("db URL parsing tests passed");
