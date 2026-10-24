import { sql, sqlJson } from "@/app/lib/db";
import { ensureSchedulerStateTable, loadFamilyRoster } from "@/app/lib/familyRosterStore";

/** scheduler_state key holding the most recent agent interactions (shared by every device). */
export const AGENT_HISTORY_STATE_KEY = "agent_chat_history";
export const AGENT_HISTORY_LIMIT = 10;

export type AgentHistoryEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  child: string;
  type: string;
};

type StoredInteraction = {
  prompt: string;
  reply: string;
  ts: number;
  events: AgentHistoryEvent[];
};

/** Chat message shape returned to the client (compatible with `Msg` in AgentChat). */
export type HydratedMessage = {
  role: "user" | "assistant";
  content: string;
  ts?: number;
  actions?: AgentHistoryEvent[];
  /** Set for messages that are not real past turns: "schedule" (rebuilt from saved events) or "example". */
  source?: "schedule" | "example";
};

export type HydratedHistory = {
  origin: "history" | "schedule" | "example";
  messages: HydratedMessage[];
};

const asString = (v: unknown) => (typeof v === "string" ? v : "");

const parseStored = (raw: unknown): StoredInteraction[] => {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const entries = (payload as { entries?: unknown } | null)?.entries;
  if (!Array.isArray(entries)) return [];
  return entries
    .map((e) => e as Record<string, unknown>)
    .filter((e) => e && typeof e.prompt === "string" && typeof e.reply === "string")
    .map((e) => ({
      prompt: String(e.prompt),
      reply: String(e.reply),
      ts: typeof e.ts === "number" ? e.ts : 0,
      events: Array.isArray(e.events) ? (e.events as AgentHistoryEvent[]) : [],
    }));
};

const readStoredInteractions = async (): Promise<StoredInteraction[]> => {
  const table = await ensureSchedulerStateTable();
  if (!table.ok) return [];
  const result = await sql`
    SELECT payload FROM scheduler_state WHERE state_key = ${AGENT_HISTORY_STATE_KEY} LIMIT 1
  `;
  const row = result.rows[0] as { payload?: unknown } | undefined;
  return row?.payload ? parseStored(row.payload) : [];
};

/** Appends one saved interaction and keeps only the latest AGENT_HISTORY_LIMIT. Never throws. */
export const recordAgentInteraction = async (entry: {
  prompt: string;
  reply: string;
  events: AgentHistoryEvent[];
}) => {
  try {
    const existing = await readStoredInteractions();
    const next = [
      ...existing,
      {
        prompt: entry.prompt.slice(0, 800),
        reply: entry.reply.slice(0, 1500),
        ts: Date.now(),
        events: entry.events.slice(0, 50).map((e) => ({
          id: e.id,
          title: e.title,
          date: e.date,
          time: e.time,
          child: e.child,
          type: e.type,
        })),
      },
    ].slice(-AGENT_HISTORY_LIMIT);
    await sql`
      INSERT INTO scheduler_state (state_key, payload, updated_at)
      VALUES (${AGENT_HISTORY_STATE_KEY}, ${sqlJson({ entries: next })}, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
    `;
  } catch (error) {
    console.error("[agent-history] record failed", error);
  }
};

const formatDate = (date: string) => date.split("-").reverse().join("-");

/**
 * Events the agent saved before prompts were recorded. The `schedule` table has no creation time, so the
 * newest are picked by event date; one-off events become one entry each, spreadsheet imports are grouped
 * per child + league.
 */
const deriveFromSchedule = async (
  excludeIds: Set<string>,
  limit: number,
): Promise<HydratedMessage[]> => {
  if (limit <= 0) return [];
  const roster = await loadFamilyRoster();
  const result = await sql`
    SELECT id, title, "date", metadata
    FROM schedule
    WHERE metadata->>'userId' = 'agent'
    ORDER BY "date" DESC
    LIMIT 300
  `;

  type Group = { key: string; rows: AgentHistoryEvent[]; league: string; fixtures: boolean };
  const groups: Group[] = [];
  const byKey = new Map<string, Group>();
  for (const raw of result.rows as Array<Record<string, unknown>>) {
    const id = asString(raw.id);
    if (!id || excludeIds.has(id)) continue;
    const meta = (raw.metadata && typeof raw.metadata === "object" ? raw.metadata : {}) as Record<string, unknown>;
    const child = asString(meta.child) || "";
    const event: AgentHistoryEvent = {
      id,
      title: asString(raw.title),
      date: String(raw.date ?? "").slice(0, 10),
      time: asString(meta.time) || "",
      child,
      type: asString(meta.type) || "other",
    };
    const fixtures = meta.source === "fixtures";
    const league = asString(meta.league);
    const key = fixtures ? `fixtures|${child}|${league}` : `one|${id}`;
    let group = byKey.get(key);
    if (!group) {
      if (groups.length >= limit) continue;
      group = { key, rows: [], league, fixtures };
      byKey.set(key, group);
      groups.push(group);
    }
    group.rows.push(event);
  }

  // Oldest first so the list reads chronologically, newest at the bottom.
  return groups.reverse().map((group): HydratedMessage => {
    const first = group.rows[0];
    const who = first.child ? roster.labelForMemberKey(first.child) : "";
    if (group.fixtures) {
      return {
        role: "assistant",
        source: "schedule",
        content: `✅ יובאו ${group.rows.length} משחקים${group.league ? ` (${group.league})` : ""}${who ? ` עבור ${who}` : ""}`,
        actions: group.rows,
      };
    }
    return {
      role: "assistant",
      source: "schedule",
      content: `✅ נרשם: ${first.title} — ${formatDate(first.date)}${first.time ? ` ב-${first.time}` : ""}${who ? ` עבור ${who}` : ""}`,
      actions: group.rows,
    };
  });
};

/** Typical requests shown only when the family has no agent activity at all yet. */
const EXAMPLE_PROMPTS = [
  "ייבוא משחקי הליגה מקובץ אקסל",
  "אימון כדורסל לעמית ביום שלישי ב-18:00",
  "תגבור במתמטיקה לאלין ביום רביעי ב-16:30",
  "משחק של רביד ביום שישי ב-10:00",
  "הטיול של ג'וני בשבת בבוקר ב-08:00",
  "תוסיף עוד אחד כזה מחר",
  "אימון ריקוד לאלין ביום חמישי ב-17:00",
  "שנה את האימון של עמית ל-19:00",
  "צילום מסך של הודעת וואטסאפ עם לו״ז שבועי",
  "ישיבת הורים ביום ראשון ב-20:00",
];

const exampleMessages = (): HydratedMessage[] =>
  EXAMPLE_PROMPTS.map((content) => ({ role: "user", content, source: "example" }));

/** Last AGENT_HISTORY_LIMIT interactions: recorded ones, padded with rebuilt ones, else examples. */
export const loadAgentHistory = async (): Promise<HydratedHistory> => {
  let stored: StoredInteraction[] = [];
  try {
    stored = await readStoredInteractions();
  } catch (error) {
    console.error("[agent-history] read failed", error);
  }

  let derived: HydratedMessage[] = [];
  if (stored.length < AGENT_HISTORY_LIMIT) {
    try {
      const knownIds = new Set(stored.flatMap((s) => s.events.map((e) => e.id)));
      derived = await deriveFromSchedule(knownIds, AGENT_HISTORY_LIMIT - stored.length);
    } catch (error) {
      console.error("[agent-history] schedule fallback failed", error);
    }
  }

  const recorded: HydratedMessage[] = stored.flatMap((s): HydratedMessage[] => [
    { role: "user", content: s.prompt, ts: s.ts || undefined },
    { role: "assistant", content: s.reply, ts: s.ts || undefined, actions: s.events.length ? s.events : undefined },
  ]);

  if (recorded.length || derived.length) {
    return { origin: recorded.length ? "history" : "schedule", messages: [...derived, ...recorded] };
  }
  return { origin: "example", messages: exampleMessages() };
};
