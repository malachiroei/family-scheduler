import { sql, sqlJson } from "@/app/lib/db";
import { AGENT_EXAMPLE_PROMPTS } from "@/app/lib/agentExamples";
import { fallbackRoster } from "@/app/lib/familyMembers";
import { ensureSchedulerStateTable, loadFamilyRoster, peekFamilyRoster } from "@/app/lib/familyRosterStore";

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
  isError?: boolean;
  hasImage?: boolean;
  fileName?: string;
  actions?: AgentHistoryEvent[];
  /** Set for messages that are not real past turns: "schedule" (rebuilt from saved events) or "example". */
  source?: "schedule" | "example";
};

export type HydratedHistory = {
  /** "chat" = the shared conversation log; "empty" = cleared by a user; the rest are one-time seeds. */
  origin: "chat" | "empty" | "history" | "schedule" | "example";
  messages: HydratedMessage[];
};

const asString = (v: unknown) => (typeof v === "string" ? v : "");

/** Full chat log shared by every device (server copy of the conversation). */
export const AGENT_CHAT_LOG_LIMIT = 40;
const CHAT_CONTENT_MAX = 4000;

export type StoredChatMessage = {
  role: "user" | "assistant";
  content: string;
  ts: number;
  isError?: boolean;
  hasImage?: boolean;
  fileName?: string;
  actions?: AgentHistoryEvent[];
};

type StoredPayload = {
  /** Legacy: one entry per successfully saved request (kept as a fallback for the very first sync). */
  entries: StoredInteraction[];
  /** Full conversation, oldest first. */
  messages: StoredChatMessage[];
  /** Set when a user cleared the history, so rebuilt/example history is not shown again. */
  clearedAt: number | null;
};

const sanitizeChatMessage = (raw: unknown): StoredChatMessage | null => {
  const m = raw as Record<string, unknown> | null;
  if (!m || typeof m !== "object") return null;
  if ((m.role !== "user" && m.role !== "assistant") || typeof m.content !== "string") return null;
  const actions = Array.isArray(m.actions)
    ? (m.actions as Array<Record<string, unknown>>).slice(0, 50).map((e) => ({
        id: asString(e?.id),
        title: asString(e?.title),
        date: asString(e?.date),
        time: asString(e?.time),
        child: asString(e?.child),
        type: asString(e?.type),
      }))
    : undefined;
  return {
    role: m.role,
    content: m.content.slice(0, CHAT_CONTENT_MAX),
    ts: typeof m.ts === "number" && Number.isFinite(m.ts) ? m.ts : Date.now(),
    ...(m.isError === true ? { isError: true } : {}),
    ...(m.hasImage === true ? { hasImage: true } : {}),
    ...(typeof m.fileName === "string" && m.fileName ? { fileName: m.fileName.slice(0, 200) } : {}),
    ...(actions && actions.length ? { actions } : {}),
  };
};

const parsePayload = (raw: unknown): StoredPayload => {
  let payload: unknown = raw;
  if (typeof raw === "string") {
    try {
      payload = JSON.parse(raw);
    } catch {
      payload = null;
    }
  }
  const obj = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
  const entries = (Array.isArray(obj.entries) ? obj.entries : [])
    .map((e) => e as Record<string, unknown>)
    .filter((e) => e && typeof e.prompt === "string" && typeof e.reply === "string")
    .map((e) => ({
      prompt: String(e.prompt),
      reply: String(e.reply),
      ts: typeof e.ts === "number" ? e.ts : 0,
      events: Array.isArray(e.events) ? (e.events as AgentHistoryEvent[]) : [],
    }));
  const messages = (Array.isArray(obj.messages) ? obj.messages : [])
    .map((m) => sanitizeChatMessage(m))
    .filter((m): m is StoredChatMessage => m !== null);
  return { entries, messages, clearedAt: typeof obj.clearedAt === "number" ? obj.clearedAt : null };
};

/** Identity of a message across devices (the same ts + role + start of the text). */
const messageKey = (m: { role: string; ts?: number; content: string }) =>
  `${m.role}|${m.ts ?? 0}|${m.content.slice(0, 200)}`;

const readPayload = async (): Promise<StoredPayload> => {
  const table = await ensureSchedulerStateTable();
  if (!table.ok) return { entries: [], messages: [], clearedAt: null };
  const result = await sql`
    SELECT payload FROM scheduler_state WHERE state_key = ${AGENT_HISTORY_STATE_KEY} LIMIT 1
  `;
  const row = result.rows[0] as { payload?: unknown } | undefined;
  return parsePayload(row?.payload ?? null);
};

const writePayload = async (payload: StoredPayload) => {
  await sql`
    INSERT INTO scheduler_state (state_key, payload, updated_at)
    VALUES (${AGENT_HISTORY_STATE_KEY}, ${sqlJson(payload)}, NOW())
    ON CONFLICT (state_key)
    DO UPDATE SET payload = EXCLUDED.payload, updated_at = NOW()
  `;
};

/** Adds messages from any device to the shared chat log (deduplicated, last 40 kept). Throws on DB errors. */
export const appendChatMessages = async (incoming: unknown[]): Promise<StoredChatMessage[]> => {
  const fresh = incoming.map((m) => sanitizeChatMessage(m)).filter((m): m is StoredChatMessage => m !== null);
  const current = await readPayload();
  if (fresh.length === 0) return current.messages;
  const byKey = new Map<string, StoredChatMessage>();
  for (const m of [...current.messages, ...fresh]) byKey.set(messageKey(m), m);
  const messages = [...byKey.values()].sort((a, b) => a.ts - b.ts).slice(-AGENT_CHAT_LOG_LIMIT);
  await writePayload({ ...current, messages });
  return messages;
};

/** Clears the shared conversation on every device. Throws on DB errors. */
export const clearChatMessages = async () => {
  await writePayload({ entries: [], messages: [], clearedAt: Date.now() });
};

/** Appends one saved interaction and keeps only the latest AGENT_HISTORY_LIMIT. Never throws. */
export const recordAgentInteraction = async (entry: {
  prompt: string;
  reply: string;
  events: AgentHistoryEvent[];
}) => {
  try {
    const current = await readPayload();
    const existing = current.entries;
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
    // Keep the shared chat log and the cleared marker; only the legacy entries change here.
    await writePayload({ ...current, entries: next });
  } catch (error) {
    console.error("[agent-history] record failed", error);
  }
};

/** Typical requests shown only when the family has no agent activity at all yet. */
const exampleMessages = (): HydratedMessage[] =>
  AGENT_EXAMPLE_PROMPTS.map((content) => ({ role: "user", content, source: "example" }));

const formatDate = (date: string) => date.split("-").reverse().join("-");

/**
 * Rebuild summary cards from this environment's `public.schedule` (current DATABASE / SUPABASE URL).
 * Used only when the shared chat log is empty — not on calendar page load.
 */
const deriveFromSchedule = async (
  excludeIds: Set<string>,
  limit: number,
): Promise<HydratedMessage[]> => {
  if (limit <= 0) return [];
  let roster = peekFamilyRoster() ?? fallbackRoster;
  try {
    roster = await loadFamilyRoster();
  } catch {
    // keep fallback / cache
  }
  const result = await sql`
    SELECT id, title, "date", metadata
    FROM schedule
    ORDER BY "date" DESC
    LIMIT 80
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

/** Shared conversation, reconstructed events from this DB, or generic examples. */
export const loadAgentHistory = async (): Promise<HydratedHistory> => {
  let stored: StoredInteraction[] = [];
  try {
    const payload = await readPayload();
    if (payload.messages.length > 0) {
      return { origin: "chat", messages: payload.messages };
    }
    if (payload.clearedAt) {
      return { origin: "empty", messages: [] };
    }
    stored = payload.entries;
  } catch (error) {
    console.error("[agent-history] read failed", error);
  }

  const recorded: HydratedMessage[] = stored.flatMap((s): HydratedMessage[] => [
    { role: "user", content: s.prompt, ts: s.ts || undefined },
    { role: "assistant", content: s.reply, ts: s.ts || undefined, actions: s.events.length ? s.events : undefined },
  ]);

  let derived: HydratedMessage[] = [];
  if (recorded.length < AGENT_HISTORY_LIMIT) {
    try {
      const knownIds = new Set(stored.flatMap((s) => s.events.map((e) => e.id)));
      derived = await deriveFromSchedule(knownIds, AGENT_HISTORY_LIMIT - recorded.length);
    } catch (error) {
      console.error("[agent-history] schedule reconstruct failed", error);
    }
  }

  if (recorded.length || derived.length) {
    return { origin: recorded.length ? "history" : "schedule", messages: [...derived, ...recorded] };
  }
  return { origin: "example", messages: exampleMessages() };
};
