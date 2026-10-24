"use client";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { Bot, ChevronDown, FileSpreadsheet, ImagePlus, RotateCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import { childDisplayNames as fallbackChildDisplayNames } from "@/app/lib/familyMembers";
import { AGENT_EXAMPLE_PROMPTS } from "@/app/lib/agentExamples";

type Msg = {
  role: "user" | "assistant";
  content: string;
  image?: string;
  fileName?: string;
  /** Epoch ms when the message was created. */
  ts?: number;
  /** True when the message carried a screenshot; the image itself is never persisted. */
  hasImage?: boolean;
  /** True for failure replies; these are not sent back to the model as context. */
  isError?: boolean;
  /** Tool actions: events the agent saved to the schedule on this turn. */
  actions?: AgentSavedEvent[];
  /**
   * Set on messages seeded from the server that are not real past turns: "schedule" (rebuilt from events the
   * agent saved earlier) or "example" (typical requests). They are never sent to the model as context.
   */
  source?: "schedule" | "example";
};

const CHAT_HISTORY_STORAGE_KEY = "family-scheduler-agent-chat-history-v1";
const CHAT_HISTORY_MAX_MESSAGES = 40;
const CHAT_CONTEXT_MAX_MESSAGES = 10;
const WELCOME_MESSAGE =
  "היי! כתבו, העלו צילום מסך, או קובץ אקסל של משחקים ואני אשבץ בלו״ז אחרי שתאשרו מה שזיהיתי.";

const trimHistory = (list: Msg[]): Msg[] => list.slice(-CHAT_HISTORY_MAX_MESSAGES);

// The persisted copy drops heavy image data URLs and keeps only a flag.
const toStoredMsg = (m: Msg): Msg => {
  const { image, ...rest } = m;
  return image ? { ...rest, hasImage: true } : rest;
};

const isValidMsg = (m: unknown): m is Msg =>
  Boolean(m) &&
  typeof m === "object" &&
  ((m as Msg).role === "user" || (m as Msg).role === "assistant") &&
  typeof (m as Msg).content === "string";

/** Identity of a message across devices; must match the server's key (role + ts + start of the text). */
const msgKey = (m: Pick<Msg, "role" | "ts" | "content">) => `${m.role}|${m.ts ?? 0}|${m.content.slice(0, 200)}`;

/** What is sent to the shared server history (never image data). */
const toServerMsg = (m: Msg) => ({
  role: m.role,
  content: m.content,
  ts: m.ts,
  ...(m.isError ? { isError: true } : {}),
  ...(m.hasImage || m.image ? { hasImage: true } : {}),
  ...(m.fileName ? { fileName: m.fileName } : {}),
  ...(m.actions?.length ? { actions: m.actions } : {}),
});

/**
 * Combines the server conversation with this device: everything the server has, plus messages not yet
 * uploaded (pending) and rebuilt "schedule" placeholders. Local messages that are neither on the server nor
 * pending were cleared/trimmed on another device and are dropped. Local copies win so images stay visible.
 */
const mergeWithServer = (local: Msg[], server: Msg[], pending: Map<string, Msg>): Msg[] => {
  const localByKey = new Map(local.filter((m) => !m.source).map((m) => [msgKey(m), m] as const));
  const out = new Map<string, Msg>();
  for (const m of local) if (m.source === "schedule") out.set(`seed|${msgKey(m)}`, m);
  for (const s of server) out.set(msgKey(s), localByKey.get(msgKey(s)) ?? s);
  for (const [key, m] of pending) if (!out.has(key)) out.set(key, localByKey.get(key) ?? m);
  return trimHistory([...out.values()].sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0)));
};

const sameMessageList = (a: Msg[], b: Msg[]) =>
  a.length === b.length && a.every((m, i) => m === b[i] || (msgKey(m) === msgKey(b[i]) && m.source === b[i].source));

/** "רועי", "רועי וסיון", "רועי, סיון ועמית" — a reply the agent understands as several owners. */
const joinNamesHebrew = (names: string[]) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} ו${names[names.length - 1]}`;

const fallbackExampleMessages = (): Msg[] =>
  AGENT_EXAMPLE_PROMPTS.map((content) => ({ role: "user", content, source: "example" }));

/** Returns null when this device has never stored a history. */
const loadHistory = (): Msg[] | null => {
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return trimHistory(parsed.filter(isValidMsg));
  } catch {
    return [];
  }
};

const formatTime = (ts?: number) => {
  if (!ts) return "";
  try {
    return new Date(ts).toLocaleTimeString("he-IL", { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
};
type MsgGroup = {
  key: string;
  label: string;
  icon: string;
  /** Short hint shown next to the count while the group is collapsed. */
  hint?: string;
  items: { msg: Msg; index: number }[];
};

const DAY_MS = 24 * 60 * 60 * 1000;

const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/** Date bucket for a real conversation message. */
const dateBucket = (ts: number | undefined, now: number): { key: string; label: string; icon: string } => {
  if (!ts) return { key: "older", label: "ישן יותר", icon: "🗂️" };
  const diffDays = Math.floor((startOfDay(new Date(now)) - startOfDay(new Date(ts))) / DAY_MS);
  if (diffDays <= 0) return { key: "today", label: "היום", icon: "💬" };
  if (diffDays < 7) return { key: "week", label: "השבוע", icon: "📅" };
  if (diffDays <= 30) return { key: "month", label: "החודש האחרון", icon: "🗓️" };
  return { key: "older", label: "ישן יותר", icon: "🗂️" };
};

/**
 * Splits the history into accordion groups: events rebuilt from the schedule, example prompts, and real
 * conversations by date (today / this week / last month / older). Order follows first appearance, so the
 * newest conversation is always last.
 */
const groupMessages = (list: Msg[], now: number): MsgGroup[] => {
  const groups: MsgGroup[] = [];
  const byKey = new Map<string, MsgGroup>();
  list.forEach((msg, index) => {
    let meta: { key: string; label: string; icon: string; hint?: string };
    if (msg.source === "schedule") {
      meta = { key: "restored", label: "אירועים ששוחזרו מהלו״ז", icon: "📂", hint: "לחצו לצפייה" };
    } else if (msg.source === "example") {
      meta = { key: "examples", label: "דוגמאות לבקשות", icon: "💡", hint: "לחצו לצפייה" };
    } else {
      meta = dateBucket(msg.ts, now);
    }
    let group = byKey.get(meta.key);
    if (!group) {
      group = { ...meta, items: [] };
      byKey.set(meta.key, group);
      groups.push(group);
    }
    group.items.push({ msg, index });
  });
  return groups;
};

type SpreadsheetAttach = { dataUrl: string; name: string; mime: string };

const SPREADSHEET_RE = /\.(xlsx|xls|csv)$/i;
const isSpreadsheetFile = (file: File) =>
  SPREADSHEET_RE.test(file.name) || /spreadsheet|excel|csv/i.test(file.type);
type Draft = Record<string, unknown> | null;


const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

type AgentResponse = {
  success?: boolean;
  message?: string;
  error?: string;
  question?: string;
  missing_fields?: unknown;
  quick_replies?: string[];
  /** Individual people the owner question can be answered with (several may be chosen). */
  assignee_options?: string[];
  draft?: Draft;
  events?: AgentSavedEvent[];
};

export type AgentSavedEvent = {
  id: string;
  title: string;
  date: string;
  time: string;
  child: string;
  type: string;
};

export default function AgentChat({
  onSaved,
  childNames,
  onClearImported,
}: {
  onSaved?: (events: AgentSavedEvent[]) => void;
  childNames?: string[];
  onClearImported?: (childName: string) => Promise<{ deleted: number } | null>;
}) {
  const CHILD_BUTTONS = childNames?.length ? childNames : fallbackChildDisplayNames;
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [historyLoaded, setHistoryLoaded] = useState(false);
  const [confirmClearHistory, setConfirmClearHistory] = useState(false);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null); // data URL
  const [spreadsheet, setSpreadsheet] = useState<SpreadsheetAttach | null>(null);
  const [draft, setDraft] = useState<Draft>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  // Who the agent is asking to assign to: several can be toggled, then confirmed in one reply.
  const [assigneeOptions, setAssigneeOptions] = useState<string[]>([]);
  const [selectedAssignees, setSelectedAssignees] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [clearPick, setClearPick] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  // Manual expand/collapse choices per group key; groups without an entry use the default (see below).
  const [groupOverrides, setGroupOverrides] = useState<Record<string, boolean>>({});

  // Messages created on this device that the server does not have yet (key -> message).
  const pendingRef = useRef<Map<string, Msg>>(new Map());
  const messagesRef = useRef<Msg[]>([]);
  const flushingRef = useRef(false);
  const pushTimerRef = useRef<number | null>(null);

  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  // Upload messages the server has not seen yet. Failures keep them pending; the next sync retries.
  const flushPending = useCallback(async () => {
    if (flushingRef.current) return;
    const batch = [...pendingRef.current.entries()];
    if (batch.length === 0) return;
    flushingRef.current = true;
    try {
      const res = await fetch("/api/agent/history", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ append: batch.map(([, m]) => toServerMsg(m)) }),
      });
      if (res.ok) {
        for (const [key] of batch) pendingRef.current.delete(key);
      } else {
        console.warn("[AgentChat] history upload failed:", res.status);
      }
    } catch (error) {
      console.warn("[AgentChat] history upload failed", error);
    } finally {
      flushingRef.current = false;
    }
  }, []);

  const schedulePush = useCallback(() => {
    if (pushTimerRef.current !== null) window.clearTimeout(pushTimerRef.current);
    pushTimerRef.current = window.setTimeout(() => {
      pushTimerRef.current = null;
      void flushPending();
    }, 300);
  }, [flushPending]);

  // Pull the shared conversation from the server and merge it with this device (see mergeWithServer).
  const syncFromServer = useCallback(async () => {
    await flushPending();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const res = await fetch("/api/agent/history", { cache: "no-store", signal: controller.signal });
      const data = (await res.json()) as { ok?: boolean; origin?: string; messages?: unknown };
      if (!res.ok || !data?.ok) return;
      const fetched = (Array.isArray(data.messages) ? data.messages.filter(isValidMsg) : []) as Msg[];
      console.info("[AgentChat] /api/agent/history ->", data.origin, fetched.length, "messages");

      if (data.origin === "chat" || data.origin === "empty") {
        setMessages((prev) => {
          const merged = mergeWithServer(prev, fetched, pendingRef.current);
          return sameMessageList(prev, merged) ? prev : merged;
        });
        return;
      }

      // Server has no shared log yet (first use): keep this device's real messages and upload them so
      // other devices get them; otherwise show the one-time seed (recorded requests / rebuilt / examples).
      const localReal = messagesRef.current.filter((m) => !m.source);
      if (localReal.length > 0) {
        for (const m of localReal) {
          const withTs = m.ts ? m : { ...m, ts: Date.now() };
          pendingRef.current.set(msgKey(withTs), withTs);
        }
        void flushPending();
        return;
      }
      setMessages((prev) => {
        if (prev.some((m) => !m.source)) return prev; // the user typed while we were fetching
        const next = fetched.length > 0 ? trimHistory(fetched) : fallbackExampleMessages();
        return sameMessageList(prev, next) ? prev : next;
      });
    } catch (error) {
      console.warn("[AgentChat] history sync failed", error);
    } finally {
      clearTimeout(timeout);
    }
  }, [flushPending]);

  // Restore this device's cached conversation once; the server copy is merged in right after (below).
  useEffect(() => {
    const storedHistory = loadHistory();
    const hasRealHistory = Boolean(storedHistory?.some((m) => m.source !== "example"));
    console.info("[AgentChat] cached local history:", storedHistory?.length ?? 0, "messages");
    // Never show a blank box: with no real history yet, seed the fallback examples until the server answers.
    setMessages(hasRealHistory ? (storedHistory ?? []) : fallbackExampleMessages());
    setHistoryLoaded(true);
  }, []);

  // Always read the latest shared conversation when the agent opens, then keep it fresh (mobile <-> desktop):
  // poll while open and re-sync whenever the tab/app becomes visible again.
  useEffect(() => {
    if (!historyLoaded) return;
    // Sync once in the background on load too, so a device that never opens the chat still caches it.
    void syncFromServer();
    if (!open) return;
    const run = () => {
      if (document.visibilityState === "hidden") return;
      void syncFromServer();
    };
    const id = window.setInterval(run, 15000);
    document.addEventListener("visibilitychange", run);
    window.addEventListener("focus", run);
    return () => {
      window.clearInterval(id);
      document.removeEventListener("visibilitychange", run);
      window.removeEventListener("focus", run);
    };
  }, [open, historyLoaded, syncFromServer]);

  // Cache the last N messages locally (without image payloads) for instant display next time.
  // Example prompts are never cached.
  useEffect(() => {
    if (!historyLoaded) return;
    const toSave = messages.filter((m) => m.source !== "example");
    try {
      window.localStorage.setItem(
        CHAT_HISTORY_STORAGE_KEY,
        JSON.stringify(trimHistory(toSave).map(toStoredMsg)),
      );
    } catch {
      // storage full / unavailable: keep working without persistence
    }
  }, [messages, historyLoaded]);

  // Jump straight to the latest message when the chat opens (or history finishes loading).
  useEffect(() => {
    if (!open) return;
    const id = requestAnimationFrame(() => endRef.current?.scrollIntoView({ behavior: "auto" }));
    return () => cancelAnimationFrame(id);
  }, [open, historyLoaded]);

  // Smoothly follow new messages and the typing indicator.
  useEffect(() => {
    if (!open) return;
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, open]);

  // Adds a message to the chat and queues it for the shared server history (so other devices see it).
  const addMessage = (m: Msg) => {
    const msg: Msg = { ...m, ts: m.ts ?? Date.now() };
    pendingRef.current.set(msgKey(msg), msg);
    setMessages((prev) => [...prev, msg]);
    schedulePush();
  };

  const clearHistory = () => {
    setMessages([]);
    setDraft(null);
    setQuickReplies([]);
    setAssigneeOptions([]);
    setSelectedAssignees([]);
    setConfirmClearHistory(false);
    pendingRef.current.clear();
    try {
      window.localStorage.setItem(CHAT_HISTORY_STORAGE_KEY, "[]");
    } catch {
      // ignore
    }
    // Clear the shared copy too, otherwise the next sync would bring the old conversation back.
    void fetch("/api/agent/history", { method: "DELETE" }).catch((error) => {
      console.warn("[AgentChat] clearing the shared history failed", error);
    });
  };

  // Lock background scroll while the chat is open (prevents double scroll / jumping).
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  const attach = async (file: File | undefined | null) => {
    if (!file) return;
    if (file.type.startsWith("image/")) {
      setSpreadsheet(null);
      setImage(await fileToBase64(file));
      return;
    }
    if (isSpreadsheetFile(file)) {
      setImage(null);
      setSpreadsheet({
        dataUrl: await fileToBase64(file),
        name: file.name,
        mime: file.type || "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      });
    }
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if ((!text && !image && !spreadsheet) || busy) return;
    const sentImage = image;
    const sentFile = spreadsheet;
    // Recent turns (failed replies excluded) so the model keeps multi-turn context.
    const history = messages
      .filter((m) => !m.isError && !m.source)
      .slice(-CHAT_CONTEXT_MAX_MESSAGES)
      .map((m) => ({ role: m.role, content: m.content }));
    addMessage({
      role: "user",
      content: text || (sentFile ? `קובץ: ${sentFile.name}` : "(צילום מסך)"),
      image: sentImage ?? undefined,
      fileName: sentFile?.name,
    });
    setInput("");
    setImage(null);
    setSpreadsheet(null);
    setSelectedAssignees([]);
    // Quick replies stay visible until the server answers (and come back if the request fails),
    // so the question never loses its buttons.
    setBusy(true);
    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text,
          history,
          draft,
          imageBase64: sentImage ?? undefined,
          imageMimeType: sentImage?.match(/^data:([^;]+);/)?.[1],
          fileBase64: sentFile?.dataUrl,
          fileName: sentFile?.name,
          fileMimeType: sentFile?.mime,
        }),
      });
      const raw = await res.text();
      let data: AgentResponse = {};
      try {
        data = raw ? JSON.parse(raw) : {};
      } catch {
        // non-JSON body (e.g. a platform timeout page)
      }
      if (data?.success) {
        setQuickReplies([]);
        setAssigneeOptions([]);
        setSelectedAssignees([]);
        addMessage({
          role: "assistant",
          content: `✅ ${data.message}`,
          actions: Array.isArray(data.events) ? data.events : undefined,
        });
        setDraft(null);
        onSaved?.(Array.isArray(data.events) ? data.events : []);
        return;
      } else if (Array.isArray(data?.missing_fields)) {
        setDraft(data.draft ?? null);
        setQuickReplies(Array.isArray(data.quick_replies) ? data.quick_replies : []);
        setAssigneeOptions(Array.isArray(data.assignee_options) ? data.assignee_options : []);
        setSelectedAssignees([]);
        addMessage({ role: "assistant", content: data.question || "חסר לי מידע נוסף." });
      } else {
        const detail = data?.error || raw.replace(/<[^>]*>/g, " ").trim().slice(0, 200) || res.statusText || "אין פירוט";
        addMessage({ role: "assistant", content: `⚠️ משהו השתבש (${res.status}): ${detail}`, isError: true });
      }
    } catch (e) {
      addMessage({
        role: "assistant",
        content: `⚠️ שגיאת רשת: ${e instanceof Error ? e.message : String(e)}`,
        isError: true,
      });
    } finally {
      setBusy(false);
    }
  };

  const messageGroups = groupMessages(messages, Date.now());

  const renderMessage = (m: Msg, i: number) => (
    <div key={i} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
      <div
        onClick={m.source === "example" ? () => setInput(m.content) : undefined}
        title={m.source === "example" ? "לחצו כדי להשתמש בניסוח הזה" : undefined}
        className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
          m.role === "user"
            ? "rounded-tr-sm bg-indigo-600 text-white"
            : "rounded-tl-sm border border-slate-200 bg-white text-slate-800"
        } ${m.source === "example" ? "cursor-pointer opacity-80 hover:opacity-100" : ""}`}
      >
        {m.image && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={m.image} alt="צילום מסך" className="mb-1 max-h-32 rounded-lg" />
        )}
        {!m.image && m.hasImage && <div className="mb-1 text-xs opacity-90">🖼️ צילום מסך</div>}
        {m.fileName && (
          <div className="mb-1 flex items-center gap-1 text-xs opacity-90">
            <FileSpreadsheet size={14} /> {m.fileName}
          </div>
        )}
        {m.content}
        {m.ts ? (
          <div className={`mt-1 text-[10px] ${m.role === "user" ? "text-indigo-200" : "text-slate-400"}`}>
            {formatTime(m.ts)}
          </div>
        ) : null}
      </div>
    </div>
  );

  return (
    <div className="print:hidden fixed bottom-5 right-5 z-40" dir="rtl">
      {open && (
        <div
          className={`mb-3 flex h-[min(70dvh,540px)] w-[min(92vw,390px)] flex-col overflow-hidden rounded-2xl border bg-white shadow-2xl ${
            dragging ? "border-indigo-500 ring-2 ring-indigo-300" : "border-slate-200"
          }`}
          onDragOver={(e) => {
            e.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragging(false);
            void attach(e.dataTransfer.files?.[0]);
          }}
        >
          <div className="flex items-center justify-between bg-gradient-to-l from-indigo-600 to-violet-600 px-4 py-3 text-white">
            <span className="flex items-center gap-2 text-sm font-semibold">
              <Sparkles size={16} /> סוכן הלו״ז
            </span>
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setConfirmClearHistory((v) => !v)}
                disabled={busy || messages.length === 0}
                className="rounded-md bg-white/15 p-1 transition hover:bg-white/25 disabled:opacity-40"
                aria-label="נקה היסטוריה"
                title="נקה היסטוריה"
              >
                <RotateCcw size={16} />
              </button>
              {onClearImported ? (
                <button
                  type="button"
                  onClick={() => setClearPick((openPicker) => !openPicker)}
                  className="rounded-md bg-white/15 p-1 transition hover:bg-white/25"
                  aria-label="מחק משחקים מיובאים"
                  title="מחק משחקים מיובאים"
                >
                  <Trash2 size={16} />
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded-md bg-white/15 p-1 transition hover:bg-white/25"
                aria-label="סגור"
              >
                <X size={16} />
              </button>
            </div>
          </div>

          {confirmClearHistory && (
            <div className="flex items-center justify-between gap-2 border-b border-red-200 bg-red-50 px-3 py-2">
              <span className="text-xs font-semibold text-red-800">למחוק את כל היסטוריית השיחה?</span>
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={clearHistory}
                  className="rounded-full bg-red-600 px-3 py-1 text-xs font-semibold text-white hover:bg-red-700"
                >
                  נקה היסטוריה
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmClearHistory(false)}
                  className="rounded-full border border-slate-300 bg-white px-3 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"
                >
                  ביטול
                </button>
              </div>
            </div>
          )}

          <div className="flex-1 space-y-2 overflow-y-auto overscroll-contain bg-slate-50 p-3">
            <div className="flex justify-end">
              <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-tl-sm border border-slate-200 bg-white px-3 py-2 text-sm text-slate-800">
                {WELCOME_MESSAGE}
              </div>
            </div>
            {messageGroups.map((group, groupIndex) => {
              // Default: only the newest group (and today's chat) is open; older folders stay collapsed.
              // Events rebuilt from the schedule are not a conversation, so they always start collapsed.
              const defaultOpen =
                group.key !== "restored" && (groupIndex === messageGroups.length - 1 || group.key === "today");
              const isOpen = groupOverrides[group.key] ?? defaultOpen;
              return (
                <section key={group.key} className="rounded-xl border border-slate-200 bg-white/70">
                  <button
                    type="button"
                    onClick={() => setGroupOverrides((prev) => ({ ...prev, [group.key]: !isOpen }))}
                    aria-expanded={isOpen}
                    className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-right transition hover:bg-slate-100"
                  >
                    <ChevronDown
                      size={16}
                      className={`shrink-0 text-slate-500 transition-transform duration-200 ${isOpen ? "rotate-0" : "rotate-90"}`}
                    />
                    <span className="min-w-0 flex-1 truncate text-xs font-bold text-slate-700">
                      {group.icon} {group.label}
                      {!isOpen && group.hint ? (
                        <span className="mr-1 font-normal text-slate-400">({group.hint})</span>
                      ) : null}
                    </span>
                    <span className="shrink-0 rounded-full bg-indigo-100 px-2 py-0.5 text-[11px] font-bold text-indigo-700">
                      {group.items.length}
                    </span>
                  </button>
                  <div
                    className={`grid transition-[grid-template-rows,visibility] duration-200 ease-out ${
                      isOpen ? "visible grid-rows-[1fr]" : "invisible grid-rows-[0fr]"
                    }`}
                    aria-hidden={!isOpen}
                  >
                    <div className="min-h-0 overflow-hidden">
                      <div className="space-y-2 px-2 pb-2 pt-1">
                        {group.items.map(({ msg: m, index }) => renderMessage(m, index))}
                      </div>
                    </div>
                  </div>
                </section>
              );
            })}
            {busy && (
              <div className="flex justify-end">
                <div className="flex items-center gap-1 rounded-2xl border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500">
                  <Bot size={14} /> חושב...
                </div>
              </div>
            )}
            <div ref={endRef} />
          </div>

          {clearPick && onClearImported && (
            <div className="flex flex-wrap gap-2 border-t border-amber-200 bg-amber-50 px-3 py-2">
              <span className="w-full text-[11px] font-semibold text-amber-950">למי למחוק משחקים מיובאים?</span>
              {CHILD_BUTTONS.map((name) => (
                <button
                  key={`clear-${name}`}
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setClearPick(false);
                    void onClearImported(name).then((result) => {
                      if (!result) return;
                      addMessage({
                        role: "assistant",
                        content: `נמחקו ${result.deleted} משחקים מיובאים של ${name}. אפשר להעלות את קובץ האקסל מחדש.`,
                      });
                    });
                  }}
                  className="rounded-full border border-amber-300 bg-white px-3 py-1 text-sm font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-60"
                >
                  {name}
                </button>
              ))}
            </div>
          )}
          {assigneeOptions.length > 0 && (
            <div className="border-t border-slate-200 bg-white px-3 pt-2">
              <div className="mb-1.5 text-[11px] font-semibold text-slate-500">
                לבחירת כמה אנשים סמנו את כולם ולחצו &quot;אישור / המשך&quot;
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {assigneeOptions.map((name) => {
                  const selected = selectedAssignees.includes(name);
                  return (
                    <button
                      key={`assignee-${name}`}
                      type="button"
                      disabled={busy}
                      aria-pressed={selected}
                      onClick={() =>
                        setSelectedAssignees((prev) =>
                          prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name],
                        )
                      }
                      className={`rounded-full border px-3 py-1 text-sm font-semibold transition disabled:opacity-60 ${
                        selected
                          ? "border-indigo-600 bg-indigo-600 text-white"
                          : "border-indigo-300 bg-indigo-50 text-indigo-700 hover:bg-indigo-100"
                      }`}
                    >
                      {selected ? "✓ " : ""}
                      {name}
                    </button>
                  );
                })}
                <button
                  type="button"
                  disabled={busy || selectedAssignees.length === 0}
                  onClick={() => void send(joinNamesHebrew(assigneeOptions.filter((n) => selectedAssignees.includes(n))))}
                  className="rounded-full bg-emerald-600 px-4 py-1 text-sm font-bold text-white transition hover:bg-emerald-700 disabled:opacity-40"
                >
                  אישור / המשך{selectedAssignees.length > 1 ? ` (${selectedAssignees.length})` : ""}
                </button>
              </div>
            </div>
          )}
          {quickReplies.length > 0 && (
            <div className="flex flex-wrap gap-2 border-t border-slate-200 bg-white px-3 pt-2">
              {quickReplies.map((q) => (
                <button
                  key={q}
                  type="button"
                  disabled={busy}
                  onClick={() => void send(q)}
                  className="rounded-full border border-indigo-300 bg-indigo-50 px-3 py-1 text-sm font-semibold text-indigo-700 transition hover:bg-indigo-100 disabled:opacity-60"
                >
                  {q}
                </button>
              ))}
            </div>
          )}

          <div className="border-t border-slate-200 bg-white p-2 pb-[env(safe-area-inset-bottom,16px)]">
            {image && (
              <div className="mb-2 flex items-center gap-2">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={image} alt="תצוגה מקדימה" className="h-12 w-12 rounded-lg border object-cover" />
                <button type="button" onClick={() => setImage(null)} className="text-xs text-slate-500 underline">
                  הסר תמונה
                </button>
              </div>
            )}
            {spreadsheet && (
              <div className="mb-2 flex items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50 px-2 py-1">
                <FileSpreadsheet size={16} className="text-indigo-600" />
                <span className="min-w-0 flex-1 truncate text-xs font-semibold text-indigo-800">{spreadsheet.name}</span>
                <button type="button" onClick={() => setSpreadsheet(null)} className="text-xs text-slate-500 underline">
                  הסר קובץ
                </button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <label className="cursor-pointer rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
                <ImagePlus size={18} />
                <input
                  type="file"
                  accept="image/*,.xlsx,.xls,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel,text/csv"
                  className="hidden"
                  onChange={(e) => {
                    void attach(e.target.files?.[0]);
                    e.target.value = "";
                  }}
                />
              </label>
              <input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.nativeEvent.isComposing) void send();
                }}
                onPaste={(e) => {
                  const f = Array.from(e.clipboardData.files).find((x) => x.type.startsWith("image/"));
                  if (f) {
                    e.preventDefault();
                    void attach(f);
                  }
                }}
                placeholder={quickReplies.length ? `${CHILD_BUTTONS.join(" / ")} או הקלידו תשובה...` : "הקלידו, גררו תמונה או קובץ אקסל..."}
                className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || (!input.trim() && !image && !spreadsheet)}
                className="rounded-xl bg-indigo-600 p-2 text-white transition hover:bg-indigo-700 disabled:opacity-50"
                aria-label="שלח"
              >
                <Send size={18} />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FAB is not rendered while the chat is open (close with the X in the chat header). */}
      {!open && (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex h-14 w-14 items-center justify-center rounded-full bg-gradient-to-br from-indigo-600 to-violet-600 text-white shadow-xl transition hover:scale-105"
        aria-label={open ? "סגור סוכן" : "פתח סוכן AI"}
      >
        <Sparkles size={24} />
      </button>
      )}
    </div>
  );
}
