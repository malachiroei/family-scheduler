// One-off data fix: "ניקיון עם לימור".
//
//   1. Deletes every ONE-OFF event whose title contains "לימור" from public.schedule
//      (the agent had created dozens of single-date copies, including duplicates on the same Sunday).
//   2. Creates ONE recurring task: every other Sunday at 08:00 for Roei & Sivan.
//      First occurrence = --first (default 2026-11-01), so the coming Sunday (2026-10-25) has no cleaning.
//
// Safe by default: without --apply it only prints what it WOULD do (dry run). Everything runs in one transaction.
//
//   node scripts/setup-limor-cleaning.mjs                       # dry run against the DB in .env.local / env
//   node scripts/setup-limor-cleaning.mjs --apply               # apply
//   node scripts/setup-limor-cleaning.mjs --apply --first=2026-11-01
//   node scripts/setup-limor-cleaning.mjs --rollback-test       # runs the real writes, then rolls them back
//
// The DB URL is read from the environment (SUPABASE_DATABASE_URL, DATABASE_URL, SUPABASE_POSTGRES_URL,
// POSTGRES_URL - same order as the app) or from .env.local. Point it at the PRODUCTION database to fix production.
import postgres from "postgres";
import fs from "node:fs";

const args = process.argv.slice(2);
const rollbackTest = args.includes("--rollback-test");
const apply = args.includes("--apply") || rollbackTest;
class RollbackTest extends Error {}
const firstArg = args.find((a) => a.startsWith("--first="))?.split("=")[1] ?? "2026-11-01";

const TITLE = "ניקיון עם לימור";
const TIME = "08:00";
const RULE_ID = "recurring-limor-cleaning";
const INTERVAL_WEEKS = 2;

if (!/^\d{4}-\d{2}-\d{2}$/.test(firstArg) || new Date(`${firstArg}T00:00:00Z`).getUTCDay() !== 0) {
  console.error(`--first must be a Sunday in YYYY-MM-DD format (got "${firstArg}")`);
  process.exit(1);
}

const loadEnvFile = () => {
  const env = {};
  try {
    const raw = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (m) env[m[1]] = m[2].replace(/^"|"$/g, "").replace(/^'|'$/g, "").trim();
    }
  } catch {
    // no .env.local - rely on process.env
  }
  return env;
};

const fileEnv = loadEnvFile();
const pick = (name) => (process.env[name] || fileEnv[name] || "").replace(/^psql\s+/i, "").trim();
const url =
  pick("SUPABASE_DATABASE_URL") || pick("DATABASE_URL") || pick("SUPABASE_POSTGRES_URL") || pick("POSTGRES_URL");
if (!url) {
  console.error("No database URL found (SUPABASE_DATABASE_URL / DATABASE_URL / POSTGRES_URL).");
  process.exit(1);
}

const parsed = new URL(url);
console.log(`Database: ${parsed.host}${parsed.pathname}`);
console.log(
  rollbackTest
    ? "Mode: ROLLBACK TEST (writes are executed, then rolled back)"
    : apply
      ? "Mode: APPLY (changes will be committed)"
      : "Mode: DRY RUN (no changes)",
);

const sql = postgres(url, {
  max: 1,
  prepare: false,
  connect_timeout: 15,
  ssl: /^(localhost|127\.0\.0\.1)$/i.test(parsed.hostname) ? false : { rejectUnauthorized: false },
});

const isOneOff = sql`COALESCE(metadata->>'isRecurring', 'false') <> 'true'`;

try {
  // Resolve the assignee keys from the stored family roster (falls back to the original keys).
  let roiKey = "roi";
  let sivanKey = "sivan";
  const rosterRows = await sql`SELECT payload FROM scheduler_state WHERE state_key = 'family_roster' LIMIT 1`.catch(
    () => [],
  );
  const members = rosterRows[0]?.payload?.members;
  if (Array.isArray(members) && members.length) {
    const find = (names) => members.find((m) => names.includes(String(m?.name ?? "").trim()));
    const roi = find(["רועי"]);
    const sivan = find(["סיון", "סיוון"]);
    if (!roi || !sivan) {
      throw new Error("Roster does not contain both רועי and סיון - aborting so nothing is assigned to a wrong key.");
    }
    roiKey = roi.key || roiKey;
    sivanKey = sivan.key || sivanKey;
  } else {
    console.log("No stored roster found; using default keys roi / sivan.");
  }
  const child = `${roiKey}_${sivanKey}`;

  const toDelete = await sql`
    SELECT id, title, "date"::text AS date, metadata->>'time' AS time, metadata->>'child' AS child
    FROM schedule
    WHERE title ILIKE ${"%לימור%"} AND ${isOneOff}
    ORDER BY "date"`;
  console.log(`\nOne-off events containing "לימור" to delete: ${toDelete.length}`);
  for (const r of toDelete) console.log(`  - ${r.date} ${r.time ?? ""} ${r.child ?? ""} | ${r.title} | ${r.id}`);

  const existingRule = await sql`SELECT id FROM schedule WHERE id = ${RULE_ID}`;
  console.log(
    `\nRecurring rule "${TITLE}": Sunday ${TIME}, child=${child}, every ${INTERVAL_WEEKS} weeks, first occurrence ${firstArg} ` +
      `(${existingRule.length ? "will be updated" : "will be created"})`,
  );

  if (!apply) {
    console.log("\nDry run only. Re-run with --apply to commit.");
  } else {
    await sql.begin(async (tx) => {
      const deleted = await tx`
        DELETE FROM schedule WHERE title ILIKE ${"%לימור%"} AND COALESCE(metadata->>'isRecurring', 'false') <> 'true'`;
      console.log(`\nDeleted ${deleted.count} one-off events.`);

      const metadata = {
        dayIndex: 0,
        time: TIME,
        child,
        type: "other",
        zoomLink: null,
        isRecurring: true,
        recurringTemplateId: RULE_ID,
        recurrenceIntervalWeeks: INTERVAL_WEEKS,
        recurrenceAnchorDate: firstArg,
        completed: false,
        sendNotification: true,
        requireConfirmation: false,
        needsAck: false,
        reminderLeadMinutes: null,
        userId: "system",
        notified: false,
        league: null,
        eventDate: firstArg,
        source: "recurring-setup",
      };

      const extra = await tx`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'schedule'
          AND column_name IN ('start_time', 'child_id', 'notified')`;
      if (extra.length >= 3) {
        await tx`
          INSERT INTO schedule (id, title, "date", metadata, start_time, child_id, notified)
          VALUES (${RULE_ID}, ${TITLE}, ${firstArg}, ${tx.json(metadata)}, ${TIME}, ${child}, false)
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title, "date" = EXCLUDED."date", metadata = EXCLUDED.metadata,
            start_time = EXCLUDED.start_time, child_id = EXCLUDED.child_id, notified = false`;
      } else {
        await tx`
          INSERT INTO schedule (id, title, "date", metadata)
          VALUES (${RULE_ID}, ${TITLE}, ${firstArg}, ${tx.json(metadata)})
          ON CONFLICT (id) DO UPDATE SET
            title = EXCLUDED.title, "date" = EXCLUDED."date", metadata = EXCLUDED.metadata`;
      }
      console.log(`Upserted recurring rule ${RULE_ID}.`);

      if (rollbackTest) {
        const check = await tx`
          SELECT id, title, "date"::text AS date, metadata->>'child' AS child,
                 metadata->>'recurrenceIntervalWeeks' AS every, metadata->>'recurrenceAnchorDate' AS anchor
          FROM schedule WHERE id = ${RULE_ID}`;
        console.log("Inside transaction:", JSON.stringify(check[0]));
        throw new RollbackTest();
      }
    }).catch((error) => {
      if (error instanceof RollbackTest) {
        console.log("\n--rollback-test: everything above executed, then was rolled back. Nothing was changed.");
        return;
      }
      throw error;
    });

    const after = await sql`
      SELECT id, title, "date"::text AS date, metadata->>'child' AS child,
             metadata->>'recurrenceIntervalWeeks' AS every, metadata->>'recurrenceAnchorDate' AS anchor
      FROM schedule WHERE title ILIKE ${"%לימור%"} ORDER BY "date"`;
    console.log("\nRows now containing 'לימור':");
    for (const r of after) console.log(" ", JSON.stringify(r));
  }
} catch (error) {
  console.error("\nFAILED (transaction rolled back):", error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 5 });
}
