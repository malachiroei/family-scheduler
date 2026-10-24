"use client";
import React, { useEffect, useRef, useState } from "react";
import { Bot, FileSpreadsheet, ImagePlus, RotateCcw, Send, Sparkles, Trash2, X } from "lucide-react";
import { childDisplayNames as fallbackChildDisplayNames } from "@/app/lib/familyMembers";

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

const loadHistory = (): Msg[] => {
  try {
    const raw = window.localStorage.getItem(CHAT_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return trimHistory(
      parsed.filter(
        (m): m is Msg =>
          Boolean(m) &&
          typeof m === "object" &&
          ((m as Msg).role === "user" || (m as Msg).role === "assistant") &&
          typeof (m as Msg).content === "string",
      ),
    );
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
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [clearPick, setClearPick] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  // Restore the saved conversation once on the client.
  useEffect(() => {
    setMessages(loadHistory());
    setHistoryLoaded(true);
  }, []);

  // Persist the last N messages (without image payloads) whenever the conversation changes.
  useEffect(() => {
    if (!historyLoaded) return;
    try {
      window.localStorage.setItem(
        CHAT_HISTORY_STORAGE_KEY,
        JSON.stringify(trimHistory(messages).map(toStoredMsg)),
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

  const addMessage = (m: Msg) => setMessages((prev) => [...prev, { ...m, ts: m.ts ?? Date.now() }]);

  const clearHistory = () => {
    setMessages([]);
    setDraft(null);
    setQuickReplies([]);
    setConfirmClearHistory(false);
    try {
      window.localStorage.removeItem(CHAT_HISTORY_STORAGE_KEY);
    } catch {
      // ignore
    }
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
      .filter((m) => !m.isError)
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
            {messages.map((m, i) => (
              <div key={i} className={`flex ${m.role === "user" ? "justify-start" : "justify-end"}`}>
                <div
                  className={`max-w-[85%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm ${
                    m.role === "user"
                      ? "rounded-tr-sm bg-indigo-600 text-white"
                      : "rounded-tl-sm border border-slate-200 bg-white text-slate-800"
                  }`}
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
            ))}
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
