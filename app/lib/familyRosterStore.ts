import { getDatabaseConfig, sql, sqlJson } from "@/app/lib/db";
import {
  APP_BRANDING_STATE_KEY,
  mergeAppBranding,
  parseAppBranding,
  sanitizeAppBrandingInput,
  type AppBranding,
} from "@/app/lib/appBranding";
import {
  canonicalHebrewName,
  createFamilyRoster,
  fallbackRoster,
  FAMILY_ROSTER_STATE_KEY,
  hydrateStoredMembers,
  isPlaceholderMemberName,
  looksLikeMemberId,
  runtimeEnvFamilyMemberNames,
  serializeFamilyMembers,
  specForName,
  type FamilyMember,
  type FamilyRoster,
  type StoredFamilyMember,
} from "@/app/lib/familyMembers";

type StoredPayload = {
  members?: StoredFamilyMember[];
};

let stateTableReady = false;
let rosterCache: { roster: FamilyRoster; at: number } | null = null;
let brandingCache: { branding: AppBranding; at: number } | null = null;
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

export const ensureSchedulerStateTable = async () => {
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

const coerceStoredMember = (item: unknown): StoredFamilyMember | null => {
  if (typeof item === "string") {
    const name = item.trim();
    if (!name) return null;
    const spec = specForName(name);
    return { name, role: spec.role, key: spec.key };
  }
  if (!item || typeof item !== "object") return null;
  const row = item as Record<string, unknown>;
  const nameRaw = [row.name, row.label, row.displayName, row.title].find(
    (value) => typeof value === "string" && value.trim(),
  );
  const name = typeof nameRaw === "string" ? nameRaw.trim() : "";
  if (!name) return null;
  const spec = specForName(name);
  const role = row.role === "parent" || row.role === "child" ? row.role : spec.role;
  const key = typeof row.key === "string" && row.key.trim() ? row.key.trim() : spec.key;
  const color = typeof row.color === "string" ? row.color : undefined;
  return { name, role, key, color };
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
  if (Array.isArray(payload)) {
    return payload.map(coerceStoredMember).filter((item): item is StoredFamilyMember => Boolean(item));
  }
  if (!payload || typeof payload !== "object") {
    return [];
  }
  const obj = payload as Record<string, unknown> & StoredPayload;
  const buckets: unknown[] = [];
  for (const key of ["members", "family", "family_members", "roster"]) {
    if (Array.isArray(obj[key])) buckets.push(...(obj[key] as unknown[]));
  }
  if (Array.isArray(obj.children)) {
    for (const child of obj.children) {
      buckets.push(typeof child === "string" ? child : { ...(child as object), role: "child" });
    }
  }
  if (Array.isArray(obj.parents)) {
    for (const parent of obj.parents) {
      buckets.push(typeof parent === "string" ? parent : { ...(parent as object), role: "parent" });
    }
  }
  return buckets.map(coerceStoredMember).filter((item): item is StoredFamilyMember => Boolean(item));
};

const readRosterRow = async (): Promise<StoredFamilyMember[] | null> => {
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
};

export const readStoredFamilyRoster = async (): Promise<StoredFamilyMember[] | null> => {
  try {
    return await readRosterRow();
  } catch (firstError) {
    const tableStatus = await ensureSchedulerStateTable();
    if (!tableStatus.ok) {
      console.error("[family-roster] failed to read scheduler_state", firstError);
      return null;
    }
    try {
      return await readRosterRow();
    } catch (error) {
      console.error("[family-roster] failed to read scheduler_state", error);
      return null;
    }
  }
};

/** When settings were never saved, recover real names already stored on this instance's events. */
const inferMembersFromSchedule = async (): Promise<StoredFamilyMember[] | null> => {
  try {
    const result = await sql`
      SELECT DISTINCT metadata->>'child' AS child
      FROM schedule
      WHERE COALESCE(metadata->>'child', '') <> ''
      LIMIT 24
    `;
    const seen = new Set<string>();
    const members: StoredFamilyMember[] = [];
    for (const raw of result.rows as Array<{ child?: unknown }>) {
      const name = typeof raw.child === "string" ? raw.child.trim() : "";
      if (!name || isPlaceholderMemberName(name)) continue;
      const parts = name.split(/[_+]+/).filter(Boolean);
      const englishParts =
        parts.length > 1 && parts.every((part) => looksLikeMemberId(part) && canonicalHebrewName(part))
          ? parts
          : [];
      if (englishParts.length > 1) {
        const key = englishParts.map((part) => specForName(part).key).join("_");
        if (seen.has(key) || isPlaceholderMemberName(key)) continue;
        seen.add(key);
        members.push({
          name: englishParts.map((part) => canonicalHebrewName(part) ?? part).join(" ו"),
          role: specForName(englishParts[0]).role,
          key,
        });
        continue;
      }
      const spec = specForName(name);
      if (seen.has(spec.key) || isPlaceholderMemberName(spec.key)) continue;
      seen.add(spec.key);
      members.push({
        name: looksLikeMemberId(name) ? canonicalHebrewName(name) ?? name : name,
        role: spec.role,
        key: spec.key,
      });
    }
    return members.length ? members : null;
  } catch (error) {
    console.warn("[family-roster] schedule infer failed", error);
    return null;
  }
};

/** In-memory roster only — never touches the database. */
export const peekFamilyRoster = (): FamilyRoster | null => rosterCache?.roster ?? null;

export const loadFamilyRoster = async (): Promise<FamilyRoster> => {
  try {
    if (rosterCache && Date.now() - rosterCache.at < ROSTER_CACHE_MS) {
      return rosterCache.roster;
    }
    const stored = await readStoredFamilyRoster();
    const storedHasRealNames = Boolean(stored?.some((member) => !isPlaceholderMemberName(member.name)));
    if (stored?.length && storedHasRealNames) {
      const members = hydrateStoredMembers(stored);
      const roster = createFamilyRoster(members, "db");
      rosterCache = { roster, at: Date.now() };
      const shouldRewriteEnglishIds = stored.some(
        (member) => looksLikeMemberId(member.name) && Boolean(canonicalHebrewName(member.name)),
      );
      const rewritten = serializeFamilyMembers(members);
      if (shouldRewriteEnglishIds && rewritten.some((member) => !isPlaceholderMemberName(member.name))) {
        try {
          await saveFamilyRoster(rewritten);
        } catch (error) {
          console.warn("[family-roster] hebrew name cleanup save skipped", error);
        }
      }
      return roster;
    }
    const envNames = runtimeEnvFamilyMemberNames().filter((name) => !isPlaceholderMemberName(name));
    if (envNames.length) {
      const roster = createFamilyRoster(hydrateStoredMembers(envNames.map((name) => ({ name, role: specForName(name).role }))), "env");
      rosterCache = { roster, at: Date.now() };
      return roster;
    }
    const inferred = await inferMembersFromSchedule();
    if (inferred?.length) {
      const members = hydrateStoredMembers(inferred);
      const roster = createFamilyRoster(members, "schedule");
      rosterCache = { roster, at: Date.now() };
      try {
        await saveFamilyRoster(serializeFamilyMembers(members));
      } catch (error) {
        console.warn("[family-roster] schedule restore save skipped", error);
      }
      return roster;
    }
    rosterCache = { roster: fallbackRoster, at: Date.now() };
    return fallbackRoster;
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

export const loadAppBranding = async (): Promise<AppBranding> => {
  const fallback = mergeAppBranding(null);
  try {
    if (brandingCache && Date.now() - brandingCache.at < ROSTER_CACHE_MS) {
      return brandingCache.branding;
    }
    const tableStatus = await ensureSchedulerStateTable();
    if (!tableStatus.ok) {
      return fallback;
    }
    const result = await sql`
      SELECT payload
      FROM scheduler_state
      WHERE state_key = ${APP_BRANDING_STATE_KEY}
      LIMIT 1
    `;
    const row = result.rows[0] as { payload?: unknown } | undefined;
    const branding = mergeAppBranding(parseAppBranding(row?.payload));
    brandingCache = { branding, at: Date.now() };
    return branding;
  } catch (error) {
    console.error("[app-branding] load failed; using default", error);
    return fallback;
  }
};

export const saveAppBranding = async (input: { app_title?: unknown; app_icon?: unknown }): Promise<AppBranding> => {
  const branding = sanitizeAppBrandingInput(input);
  const tableStatus = await ensureSchedulerStateTable();
  if (!tableStatus.ok) {
    throw new Error(
      tableStatus.code === "MISSING_POSTGRES_ENV"
        ? "חסר חיבור למסד הנתונים"
        : tableStatus.error || "שמירת עיצוב הלוח נכשלה",
    );
  }
  try {
    await sql`
      INSERT INTO scheduler_state (state_key, payload, updated_at)
      VALUES (${APP_BRANDING_STATE_KEY}, ${sqlJson(branding)}, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;
  } catch (error) {
    console.error("[app-branding] save failed", error);
    throw new Error(getErrorMessage(error) || "שמירת עיצוב הלוח נכשלה");
  }
  brandingCache = { branding, at: Date.now() };
  return branding;
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
