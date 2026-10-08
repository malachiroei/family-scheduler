import { NextRequest, NextResponse } from "next/server";
import { sql, sqlJson } from "@/app/lib/db";
import { buildMetadataFromIncoming, ensureScheduleMetadataColumn } from "@/app/lib/scheduleTable";
import { sendPushToAll } from "@/app/lib/push";

export const revalidate = 0;
export const maxDuration = 60;

const CHILDREN = ["ravid", "amit", "alin"] as const;
type Child = (typeof CHILDREN)[number];
const CHILD_LABEL: Record<Child, string> = { ravid: "רביד", amit: "עמית", alin: "אלין" };
const TYPES = ["dog", "gym", "sport", "lesson", "dance"] as const;
type EventType = (typeof TYPES)[number];
const TYPE_LABEL: Record<EventType, string> = {
  dog: "כלב",
  gym: "חדר כושר",
  sport: "ספורט",
  lesson: "שיעור",
  dance: "ריקוד",
};

type Draft = {
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:mm
  child_name: Child | null;
  title: string | null;
  type: EventType | null;
  keyword: string | null;
};

type ChatTurn = { role: "user" | "assistant"; content: string };

const emptyDraft = (): Draft => ({
  date: null,
  time: null,
  child_name: null,
  title: null,
  type: null,
  keyword: null,
});

const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));

/* ---------- date helpers (Asia/Jerusalem) ---------- */

const israelNow = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jerusalem",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "long",
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { iso: `${get("year")}-${get("month")}-${get("day")}`, weekday: get("weekday") };
};

const dayIndexOf = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
};

const normalizeDate = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const dt = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return Number.isNaN(dt.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`;
};

const normalizeTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

const normalizeChild = (v: unknown): Child | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  if ((CHILDREN as readonly string[]).includes(s)) return s as Child;
  for (const c of CHILDREN) {
    if (s === CHILD_LABEL[c]) return c;
  }
  return null;
};

const normalizeType = (v: unknown): EventType | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().toLowerCase();
  return (TYPES as readonly string[]).includes(s) ? (s as EventType) : null;
};

const str = (v: unknown, max = 120) =>
  typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null;

const sanitizeDraft = (raw: unknown): Draft => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    date: normalizeDate(o.date),
    time: normalizeTime(o.time),
    child_name: normalizeChild(o.child_name ?? o.child),
    title: str(o.title),
    type: normalizeType(o.type),
    keyword: str(o.keyword, 40),
  };
};

/* ---------- learned patterns (family_learned_patterns) ---------- */

let patternsTableReady = false;
const ensurePatternsTable = async () => {
  if (patternsTableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS family_learned_patterns (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL UNIQUE,
      child_name TEXT NOT NULL,
      event_type TEXT,
      hits INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  patternsTableReady = true;
};

type Pattern = { keyword: string; child_name: string; event_type: string | null; hits: number };

const loadPatterns = async (): Promise<Pattern[]> => {
  try {
    await ensurePatternsTable();
    const r = await sql<Pattern>`
      SELECT keyword, child_name, event_type, hits FROM family_learned_patterns ORDER BY hits DESC
    `;
    return r.rows;
  } catch (e) {
    console.error("[agent] loadPatterns failed", e);
    return [];
  }
};

const learnPattern = async (keywords: Array<string | null>, child: Child, type: EventType | null) => {
  try {
    await ensurePatternsTable();
    const uniq = [...new Set(keywords.map((k) => (k ?? "").trim().toLowerCase()).filter((k) => k.length >= 2))];
    for (const keyword of uniq) {
      await sql`
        INSERT INTO family_learned_patterns (keyword, child_name, event_type, hits)
        VALUES (${keyword}, ${child}, ${type}, 1)
        ON CONFLICT (keyword) DO UPDATE SET
          hits = CASE WHEN family_learned_patterns.child_name = EXCLUDED.child_name
                      THEN family_learned_patterns.hits + 1 ELSE 1 END,
          child_name = EXCLUDED.child_name,
          event_type = COALESCE(EXCLUDED.event_type, family_learned_patterns.event_type),
          updated_at = NOW()
      `;
    }
  } catch (e) {
    console.error("[agent] learnPattern failed", e);
  }
};

const matchPattern = (patterns: Pattern[], haystacks: Array<string | null>): Pattern | null => {
  const hay = haystacks.filter(Boolean).join(" ").toLowerCase();
  if (!hay) return null;
  return patterns.find((p) => hay.includes(p.keyword)) ?? null;
};

/* ---------- LLM ---------- */

const buildPrompt = (text: string, draft: Draft, history: ChatTurn[], patterns: Pattern[]) => {
  const now = israelNow();
  const learned = patterns.length
    ? patterns.slice(0, 40).map((p) => `"${p.keyword}" => ${CHILD_LABEL[p.child_name as Child] ?? p.child_name}`).join("; ")
    : "אין";
  const hist = history.slice(-8).map((h) => `${h.role === "user" ? "משתמש" : "סוכן"}: ${h.content}`).join("\n");
  return `אתה סוכן לו"ז משפחתי. חלץ פרטי אירוע מהקלט (טקסט ו/או תמונה) ומזג עם הטיוטה הקיימת.
היום: ${now.iso} (${now.weekday}), אזור זמן Asia/Jerusalem. פענח "מחר", "ביום שלישי הבא" וכו' לתאריך YYYY-MM-DD מדויק.
ילדים אפשריים: ravid (רביד), amit (עמית), alin (אלין). אם לא ברור במפורש מי הילד - החזר null, אל תנחש.
סוגים: dog, gym, sport, lesson, dance. בחר את הקרוב ביותר (כדורסל/כדורגל = sport).
keyword = מילה אחת/שתיים שמזהות את הפעילות או האדם (למשל "מאמן", "כדורסל", "קרל") לצורך למידה.
דפוסים שנלמדו: ${learned}
טיוטה נוכחית: ${JSON.stringify(draft)}
${hist ? `היסטוריית שיחה:\n${hist}\n` : ""}קלט חדש מהמשתמש: ${text || "(ללא טקסט — ראה תמונה)"}

אם הקלט החדש הוא תשובה קצרה (למשל "רביד" או "18:00") — עדכן רק את השדה המתאים בטיוטה.
החזר JSON בלבד בפורמט:
{"date": "YYYY-MM-DD"|null, "time": "HH:mm"|null, "child_name": "ravid"|"amit"|"alin"|null, "title": string|null, "type": "dog|gym|sport|lesson|dance"|null, "keyword": string|null}`;
};

const extractJsonObject = (t: string) => {
  const s = t.indexOf("{");
  const e = t.lastIndexOf("}");
  if (s === -1 || e <= s) return null;
  try {
    return JSON.parse(t.slice(s, e + 1));
  } catch {
    return null;
  }
};

const callOpenAI = async (prompt: string, img: { data: string; mime: string } | null) => {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  const content: Array<Record<string, unknown>> = [{ type: "text", text: prompt }];
  if (img) content.push({ type: "image_url", image_url: { url: `data:${img.mime};base64,${img.data}` } });
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{ role: "user", content }],
    }),
  });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return String(data?.choices?.[0]?.message?.content ?? "");
};

const callGemini = async (prompt: string, img: { data: string; mime: string } | null) => {
  const key = process.env.GEMINI_API_KEY || process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!key) return null;
  const parts: Array<Record<string, unknown>> = [{ text: prompt }];
  if (img) parts.push({ inlineData: { mimeType: img.mime, data: img.data } });
  let lastErr = "";
  for (const model of ["gemini-2.5-flash", "gemini-2.0-flash"]) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ role: "user", parts }],
          generationConfig: { temperature: 0, responseMimeType: "application/json" },
        }),
      },
    );
    if (res.ok) {
      const data = await res.json();
      return String(
        data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p?.text || "").join("") ?? "",
      );
    }
    const errBody = await res.text();
    lastErr = `Gemini ${model} ${res.status}: ${errBody}`;
    console.error(`[agent] Gemini error (model=${model}, status=${res.status}):`, errBody);
  }
  throw new Error(lastErr);
};

const runModel = async (prompt: string, img: { data: string; mime: string } | null) => {
  const out = (await callOpenAI(prompt, img)) ?? (await callGemini(prompt, img));
  if (out === null) throw new Error("Missing OPENAI_API_KEY / GEMINI_API_KEY");
  return extractJsonObject(out);
};

/* ---------- questions ---------- */

const buildQuestion = (draft: Draft, missing: string[], suggestedChild: Child | null) => {
  const what = draft.title || (draft.type ? TYPE_LABEL[draft.type] : "אירוע");
  const when = [draft.date, draft.time ? `ב-${draft.time}` : ""].filter(Boolean).join(" ");
  if (missing.length === 1 && missing[0] === "child_name") {
    if (suggestedChild) {
      return `מזהה ${what}${when ? ` ${when}` : ""}, לרשום עבור ${CHILD_LABEL[suggestedChild]}?`;
    }
    return `עבור מי ${what}${when ? ` (${when})` : ""}?`;
  }
  const labels: Record<string, string> = {
    date: "באיזה תאריך/יום",
    time: "באיזו שעה",
    child_name: "עבור מי (רביד / עמית / אלין)",
    title: "מה שם הפעילות",
  };
  return `חסר לי מידע: ${missing.map((m) => labels[m] ?? m).join(", ")}. אפשר להשלים?`;
};

/* ---------- handler ---------- */

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const text = typeof body.text === "string" ? body.text.trim() : "";
    const imageBase64 =
      typeof body.imageBase64 === "string" ? body.imageBase64.replace(/^data:[^;]+;base64,/, "").trim() : "";
    const imageMime = typeof body.imageMimeType === "string" && body.imageMimeType ? body.imageMimeType : "image/png";
    const history: ChatTurn[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .map((h) => h as Record<string, unknown>)
          .filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string")
          .map((h) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 500) }))
      : [];
    const previousDraft = sanitizeDraft(body.draft);
    const suggestedChildFromClient = normalizeChild(body.suggestedChild);
    const senderEndpoint = typeof body.senderSubscriptionEndpoint === "string" ? body.senderSubscriptionEndpoint : "";

    if (!text && !imageBase64) {
      return NextResponse.json({ success: false, error: "Text or image is required" }, { status: 400 });
    }

    const patterns = await loadPatterns();

    // Shortcut: a bare child name answering a pending question, no LLM needed.
    const bareChild = normalizeChild(text);
    let draft: Draft;
    if (bareChild && !imageBase64 && previousDraft.title) {
      draft = { ...previousDraft, child_name: bareChild };
    } else if (/^(כן|בטח|אישור|סבבה|אוקיי|אוקי|ok)\.?$/i.test(text) && suggestedChildFromClient && !imageBase64) {
      draft = { ...previousDraft, child_name: suggestedChildFromClient };
    } else {
      const prompt = buildPrompt(text, previousDraft, history, patterns);
      const parsed = await runModel(prompt, imageBase64 ? { data: imageBase64, mime: imageMime } : null);
      const fromModel = sanitizeDraft(parsed);
      draft = {
        date: fromModel.date ?? previousDraft.date,
        time: fromModel.time ?? previousDraft.time,
        child_name: fromModel.child_name ?? previousDraft.child_name,
        title: fromModel.title ?? previousDraft.title,
        type: fromModel.type ?? previousDraft.type,
        keyword: fromModel.keyword ?? previousDraft.keyword,
      };
    }

    // Child still unknown -> consult learned memory first.
    const suggestedChild: Child | null = suggestedChildFromClient;
    let childFromMemory = false;
    if (!draft.child_name) {
      const hit = matchPattern(patterns, [draft.keyword, draft.title, text]);
      const c = hit ? normalizeChild(hit.child_name) : null;
      if (c) {
        draft.child_name = c;
        childFromMemory = true;
      }
    }

    const missing: string[] = [];
    if (!draft.date) missing.push("date");
    if (!draft.time) missing.push("time");
    if (!draft.child_name) missing.push("child_name");
    if (!draft.title) missing.push("title");

    if (missing.length > 0) {
      return NextResponse.json({
        success: false,
        missing_fields: missing,
        question: buildQuestion(draft, missing, suggestedChild),
        draft,
        quick_replies: missing.includes("child_name") ? CHILDREN.map((c) => CHILD_LABEL[c]) : [],
      });
    }

    // Complete. Save.
    const child = draft.child_name as Child;
    const date = draft.date as string;
    const time = draft.time as string;
    const title = draft.title as string;
    const type: EventType = draft.type ?? "sport";
    const id = crypto.randomUUID();

    await ensureScheduleMetadataColumn();
    const metadata = buildMetadataFromIncoming({
      dayIndex: dayIndexOf(date),
      time,
      child,
      type,
      isRecurring: false,
      completed: false,
      sendNotification: true,
      requireConfirmation: false,
      needsAck: false,
      reminderLeadMinutes: null,
      userId: "agent",
      notified: false,
    });
    await sql`
      INSERT INTO schedule (id, title, "date", metadata)
      VALUES (${id}, ${title}, ${date}, ${sqlJson(metadata)})
    `;

    // Learn for next time.
    await learnPattern([draft.keyword, title], child, type);

    try {
      await sendPushToAll(
        {
          title: "משימה חדשה נוספה",
          body: `נוספה משימה ל${CHILD_LABEL[child]}: ${title} - ${time}`,
          url: "/",
        },
        { excludeEndpoint: senderEndpoint },
      );
    } catch (e) {
      console.error("[agent] push failed", e);
    }

    return NextResponse.json({
      success: true,
      message: `נרשם: ${title} עבור ${CHILD_LABEL[child]}, ${date} בשעה ${time}${
        childFromMemory ? " (שייכתי לפי מה שלמדתי)" : ""
      }`,
      event: { id, title, date, time, child, type },
      draft: emptyDraft(),
    });
  } catch (error) {
    console.error("[API] POST /api/agent failed", error);
    return NextResponse.json({ success: false, error: errMsg(error) }, { status: 500 });
  }
}
