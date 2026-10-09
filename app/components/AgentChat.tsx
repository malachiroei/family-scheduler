"use client";
import React, { useEffect, useRef, useState } from "react";
import { Bot, ImagePlus, Send, Sparkles, X } from "lucide-react";

type Msg = { role: "user" | "assistant"; content: string; image?: string };
type Draft = Record<string, unknown> | null;

const CHILD_BUTTONS = ["רביד", "עמית", "אלין"];

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

export default function AgentChat({ onSaved }: { onSaved?: (events: AgentSavedEvent[]) => void }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState<Msg[]>([
    {
      role: "assistant",
      content: "היי! כתבו או העלו צילום מסך של אירוע, ואני אשבץ אותו בלו״ז. למשל: ״אימון כדורסל מחר ב-18:00״.",
    },
  ]);
  const [input, setInput] = useState("");
  const [image, setImage] = useState<string | null>(null); // data URL
  const [draft, setDraft] = useState<Draft>(null);
  const [quickReplies, setQuickReplies] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, busy, open]);

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
    if (!file || !file.type.startsWith("image/")) return;
    setImage(await fileToBase64(file));
  };

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if ((!text && !image) || busy) return;
    const sentImage = image;
    const history = messages.slice(-8).map((m) => ({ role: m.role, content: m.content }));
    setMessages((prev) => [...prev, { role: "user", content: text || "(צילום מסך)", image: sentImage ?? undefined }]);
    setInput("");
    setImage(null);
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
        setMessages((prev) => [...prev, { role: "assistant", content: `✅ ${data.message}` }]);
        setDraft(null);
        onSaved?.(Array.isArray(data.events) ? data.events : []);
        return;
      } else if (Array.isArray(data?.missing_fields)) {
        setDraft(data.draft ?? null);
        setQuickReplies(Array.isArray(data.quick_replies) ? data.quick_replies : []);
        setMessages((prev) => [...prev, { role: "assistant", content: data.question || "חסר לי מידע נוסף." }]);
      } else {
        const detail = data?.error || raw.replace(/<[^>]*>/g, " ").trim().slice(0, 200) || res.statusText || "אין פירוט";
        setMessages((prev) => [...prev, { role: "assistant", content: `⚠️ משהו השתבש (${res.status}): ${detail}` }]);
      }
    } catch (e) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ שגיאת רשת: ${e instanceof Error ? e.message : String(e)}` },
      ]);
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
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded-md bg-white/15 p-1 transition hover:bg-white/25"
              aria-label="סגור"
            >
              <X size={16} />
            </button>
          </div>

          <div className="flex-1 space-y-2 overflow-y-auto overscroll-contain bg-slate-50 p-3">
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
                  {m.content}
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
            <div className="flex items-center gap-2">
              <label className="cursor-pointer rounded-xl border border-slate-200 p-2 text-slate-600 hover:bg-slate-50">
                <ImagePlus size={18} />
                <input
                  type="file"
                  accept="image/*"
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
                placeholder={quickReplies.length ? `${CHILD_BUTTONS.join(" / ")} או הקלידו תשובה...` : "הקלידו או גררו תמונה..."}
                className="min-w-0 flex-1 rounded-xl border border-slate-200 px-3 py-2 text-sm outline-none focus:border-indigo-400"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={busy || (!input.trim() && !image)}
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
