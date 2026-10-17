import { getDatabaseConfig, sql } from "@/app/lib/db";
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

const ensureSchedulerStateTable = async () => {
  const { url } = getDatabaseConfig();
  if (!url) {
    return { ok: false as const, code: "MISSING_POSTGRES_ENV" as const };
  }
  if (stateTableReady) {
    return { ok: true as const };
  }
  try {
    await sql`
      CREATE TABLE IF NOT EXISTS scheduler_state (
        state_key TEXT PRIMARY KEY,
        payload JSONB NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `;
    stateTableReady = true;
    return { ok: true as const };
  } catch (error) {
    return { ok: false as const, code: "TABLE_BOOTSTRAP_FAILED" as const, error: getErrorMessage(error) };
  }
};

const parseStoredMembers = (raw: unknown): StoredFamilyMember[] => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return [];
  }
  const payload = raw as StoredPayload;
  if (!Array.isArray(payload.members)) {
    return [];
  }
  return payload.members.filter(
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
  if (rosterCache && Date.now() - rosterCache.at < ROSTER_CACHE_MS) {
    return rosterCache.roster;
  }
  const stored = await readStoredFamilyRoster();
  const roster = stored?.length
    ? createFamilyRoster(hydrateStoredMembers(stored), "db")
    : fallbackRoster;
  rosterCache = { roster, at: Date.now() };
  return roster;
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
  await sql`
    INSERT INTO scheduler_state (state_key, payload, updated_at)
    VALUES (${FAMILY_ROSTER_STATE_KEY}, ${JSON.stringify(payload)}::jsonb, NOW())
    ON CONFLICT (state_key)
    DO UPDATE SET
      payload = EXCLUDED.payload,
      updated_at = NOW()
  `;
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
