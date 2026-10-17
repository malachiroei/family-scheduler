import { getDatabaseConfig, sql, sqlJson } from "@/app/lib/db";
import {
  createFamilyRoster,
  fallbackRoster,
  FAMILY_ROSTER_STATE_KEY,
  hydrateStoredMembers,
  serializeFamilyMembers,
  type FamilyMember,
  type FamilyRoster,
  type StoredFamilyMember,
} from "@/app/lib/familyMembers";

type StoredPayload = {
  members?: StoredFamilyMember[];
};

let stateTableReady = false;
let rosterCache: { roster: FamilyRoster; at: number } | null = null;
const ROSTER_CACHE_MS = 10_000;

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

export const invalidateFamilyRosterCache = () => {
  rosterCache = null;
};

const trySql = async (label: string, run: () => Promise<unknown>) => {
  try {
    await run();
    return true;
  } catch (error) {
    console.warn(`[family-roster] ${label}:`, getErrorMessage(error));
    return false;
  }
};

const applySchedulerStateAccess = async () => {
  // Server uses the database URL (often postgres / service_role). Also grant common Supabase roles
  // so a later switch to the pooler/anon role still works, and so RLS does not hide the row.
  await trySql("grant postgres", () => sql`GRANT ALL ON TABLE public.scheduler_state TO postgres`);
  await trySql("grant service_role", () => sql`GRANT ALL ON TABLE public.scheduler_state TO service_role`);
  await trySql("grant authenticated", () => sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduler_state TO authenticated`);
  await trySql("grant anon", () => sql`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.scheduler_state TO anon`);
  const disabledRls = await trySql(
    "disable rls",
    () => sql`ALTER TABLE public.scheduler_state DISABLE ROW LEVEL SECURITY`,
  );
  if (!disabledRls) {
    await trySql("enable rls", () => sql`ALTER TABLE public.scheduler_state ENABLE ROW LEVEL SECURITY`);
    await trySql(
      "drop old policy",
      () => sql`DROP POLICY IF EXISTS scheduler_state_all ON public.scheduler_state`,
    );
    await trySql(
      "create policy",
      () => sql`
        CREATE POLICY scheduler_state_all ON public.scheduler_state
        FOR ALL
        USING (true)
        WITH CHECK (true)
      `,
    );
  }
};

const ensureSchedulerStateTable = async () => {
  const { url } = getDatabaseConfig();
  if (!url) {
    return { ok: false as const, code: "MISSING_POSTGRES_ENV" as const };
  }
  if (stateTableReady) {
    return { ok: true as const };
  }
  await trySql(
    "create table",
    () => sql`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        state_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
  );
  await applySchedulerStateAccess();
  const readable = await trySql("probe table", () => sql`SELECT 1 FROM scheduler_state LIMIT 0`);
  if (!readable) {
    return {
      ok: false as const,
      code: "TABLE_BOOTSTRAP_FAILED" as const,
      error: "אין גישה לטבלת scheduler_state",
    };
  }
  stateTableReady = true;
  return { ok: true as const };
};

const parseStoredMembers = (raw: unknown): StoredFamilyMember[] => {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return [];
  }
  const members = (payload as StoredPayload).members;
  if (!Array.isArray(members)) {
    return [];
  }
  return members.filter(
    (item): item is StoredFamilyMember =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as StoredFamilyMember).name === "string" &&
      ((item as StoredFamilyMember).role === "child" || (item as StoredFamilyMember).role === "parent"),
  );
};

export const readStoredFamilyRoster = async (): Promise<StoredFamilyMember[] | null> => {
  const tableStatus = await ensureSchedulerStateTable();
  if (!tableStatus.ok) {
    return null;
  }
  try {
    const result = await sql`
      SELECT payload
      FROM scheduler_state
      WHERE state_key = ${FAMILY_ROSTER_STATE_KEY}
      LIMIT 1
    `;
    const row = result.rows[0] as { payload?: unknown } | undefined;
    if (!row?.payload) {
      return null;
    }
    const members = parseStoredMembers(row.payload);
    return members.length ? members : null;
  } catch (error) {
    console.error("[family-roster] failed to read scheduler_state", error);
    return null;
  }
};

export const loadFamilyRoster = async (): Promise<FamilyRoster> => {
  try {
    if (rosterCache && Date.now() - rosterCache.at < ROSTER_CACHE_MS) {
      return rosterCache.roster;
    }
    const stored = await readStoredFamilyRoster();
    const roster = stored?.length
      ? createFamilyRoster(hydrateStoredMembers(stored), "db")
      : fallbackRoster;
    rosterCache = { roster, at: Date.now() };
    return roster;
  } catch (error) {
    console.error("[family-roster] load failed; using fallback", error);
    return fallbackRoster;
  }
};

export const saveFamilyRoster = async (input: StoredFamilyMember[]): Promise<FamilyRoster> => {
  const members = hydrateStoredMembers(input);
  if (!members.length) {
    throw new Error("יש להזין לפחות בן משפחה אחד");
  }
  const tableStatus = await ensureSchedulerStateTable();
  if (!tableStatus.ok) {
    throw new Error(
      tableStatus.code === "MISSING_POSTGRES_ENV"
        ? "חסר חיבור למסד הנתונים"
        : tableStatus.error || "שמירת בני המשפחה נכשלה",
    );
  }
  const payload = { members: serializeFamilyMembers(members) };
  try {
    await sql`
      INSERT INTO scheduler_state (state_key, payload, updated_at)
      VALUES (${FAMILY_ROSTER_STATE_KEY}, ${sqlJson(payload)}, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;
  } catch (error) {
    console.error("[family-roster] save failed", error);
    throw new Error(getErrorMessage(error) || "שמירת בני המשפחה נכשלה");
  }
  const roster = createFamilyRoster(members, "db");
  rosterCache = { roster, at: Date.now() };
  return roster;
};

export const publicRosterPayload = (roster: FamilyRoster) => ({
  members: roster.members.map((member: FamilyMember) => ({
    key: member.key,
    name: member.name,
    role: member.role,
    color: member.color,
    iconColor: member.iconColor,
    pushName: member.pushName,
    aliases: member.aliases,
  })),
  source: roster.source,
  configured: roster.configured,
});
