import { NextRequest, NextResponse } from "next/server";
import { sql, sqlJson } from "@/app/lib/db";
import { buildMetadataFromIncoming, ensureScheduleMetadataColumn } from "@/app/lib/scheduleTable";
import { sendPushToAll } from "@/app/lib/push";

export const revalidate = 0;
export const maxDuration = 60;

// Family members the agent can schedule for: the three children plus the parents.
const CHILDREN = ["roi", "sivan", "ravid", "amit", "alin"] as const;
type Child = (typeof CHILDREN)[number];
const CHILD_LABEL: Record<Child, string> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  roi: "רועי",
  sivan: "סיון",
};
const TYPES = ["dog", "gym", "sport", "lesson", "dance", "other"] as const;
type EventType = (typeof TYPES)[number];
const TYPE_LABEL: Record<EventType, string> = {
  dog: "כלב",
  gym: "חדר כושר",
  sport: "ספורט",
  lesson: "שיעור",
  dance: "ריקוד",
  other: "אירוע",
};

type DraftEvent = {
  date: string | null; // YYYY-MM-DD
  time: string | null; // HH:mm (start time)
  title: string | null;
  type: EventType | null;
  keyword: string | null;
};

type Draft = {
  events: DraftEvent[];
  child_name: Child | null; // one child for the whole batch
  sender_or_group: string | null; // WhatsApp group / chat title / contact name
};

type ChatTurn = { role: "user" | "assistant"; content: string };

const emptyDraft = (): Draft => ({ events: [], child_name: null, sender_or_group: null });

/** Readable one-liner including Postgres fields (code/detail/hint/table/column) when present. */
const describeError = (e: unknown): string => {
  if (!e || typeof e !== "object") return String(e) || "Unknown error";
  const o = e as Record<string, unknown>;
  const parts: string[] = [];
  const msg = e instanceof Error ? e.message : typeof o.message === "string" ? o.message : "";
  if (msg) parts.push(msg);
  for (const k of ["code", "detail", "hint", "table", "column", "constraint"]) {
    if (typeof o[k] === "string" && o[k]) parts.push(`${k}=${o[k]}`);
  }
  return parts.join(" | ") || e.constructor?.name || "Unknown error";
};

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

const sanitizeEvent = (raw: unknown): DraftEvent => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    date: normalizeDate(o.date),
    time: normalizeTime(o.time),
    title: str(o.title),
    type: normalizeType(o.type),
    keyword: str(o.keyword, 40),
  };
};

const dedupeEvents = (events: DraftEvent[]) => {
  const seen = new Set<string>();
  return events.filter((e) => {
    // Fully empty rows are noise; rows missing date/time are kept so we can ask about them.
    if (!e.date && !e.time && !e.title) return false;
    const key = `${e.date}|${e.time}|${(e.title ?? "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

const sanitizeDraft = (raw: unknown): Draft => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.events) ? o.events : [];
  return {
    events: dedupeEvents(list.slice(0, 30).map(sanitizeEvent)),
    child_name: normalizeChild(o.child_name ?? o.child),
    sender_or_group: str(o.sender_or_group, 80),
  };
};

/* ---------- learned patterns (family_learned_patterns) ---------- */

const AUTO_ASSIGN_THRESHOLD = 3;
/** keyword value meaning "any message from this sender_or_group". */
const SOURCE_WILDCARD = "*";

let patternsTableReady = false;
const ensurePatternsTable = async () => {
  if (patternsTableReady) return;
  await sql`
    CREATE TABLE IF NOT EXISTS family_learned_patterns (
      id SERIAL PRIMARY KEY,
      keyword TEXT NOT NULL,
      child_name TEXT NOT NULL,
      event_type TEXT,
      hits INTEGER NOT NULL DEFAULT 1,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
  // Migrations for tables created by the earlier version.
  await sql`ALTER TABLE family_learned_patterns ADD COLUMN IF NOT EXISTS sender_or_group TEXT NOT NULL DEFAULT ''`;
  await sql`ALTER TABLE family_learned_patterns ADD COLUMN IF NOT EXISTS confirmations_count INTEGER NOT NULL DEFAULT 0`;
  await sql`ALTER TABLE family_learned_patterns ADD COLUMN IF NOT EXISTS auto_assign BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE family_learned_patterns DROP CONSTRAINT IF EXISTS family_learned_patterns_keyword_key`;
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS family_learned_patterns_kw_sender_child_idx
    ON family_learned_patterns (keyword, sender_or_group, child_name)
  `;
  patternsTableReady = true;
};

type Pattern = {
  keyword: string;
  sender_or_group: string;
  child_name: string;
  event_type: string | null;
  confirmations_count: number;
  auto_assign: boolean;
};

const normSender = (s: string | null | undefined) => (s ?? "").trim().toLowerCase();

const loadPatterns = async (): Promise<Pattern[]> => {
  try {
    await ensurePatternsTable();
    const r = await sql<Pattern>`
      SELECT keyword, sender_or_group, child_name, event_type, confirmations_count, auto_assign
      FROM family_learned_patterns
      ORDER BY confirmations_count DESC
    `;
    return r.rows;
  } catch (e) {
    console.error("[agent] loadPatterns failed", e);
    return [];
  }
};

/**
 * Called each time the user confirms (explicitly names the child, or answers a confirmation question).
 * Learning is keyed by keyword + sender_or_group + child. auto_assign flips to true only at
 * AUTO_ASSIGN_THRESHOLD confirmations, and only for a known (non-empty) source.
 */
const learnPattern = async (
  keywords: Array<string | null>,
  sender: string | null,
  child: Child,
  type: EventType | null,
) => {
  try {
    await ensurePatternsTable();
    const senderKey = normSender(sender);
    const uniq = [...new Set(keywords.map((k) => (k ?? "").trim().toLowerCase()).filter((k) => k.length >= 2))];
    // Source-level record: lets the next screenshot from the same group suggest this child directly.
    if (senderKey) uniq.push(SOURCE_WILDCARD);
    for (const keyword of uniq) {
      await sql`
        INSERT INTO family_learned_patterns
          (keyword, sender_or_group, child_name, event_type, hits, confirmations_count, auto_assign)
        VALUES (${keyword}, ${senderKey}, ${child}, ${type}, 1, 1, FALSE)
        ON CONFLICT (keyword, sender_or_group, child_name) DO UPDATE SET
          hits = family_learned_patterns.hits + 1,
          confirmations_count = family_learned_patterns.confirmations_count + 1,
          event_type = COALESCE(EXCLUDED.event_type, family_learned_patterns.event_type),
          updated_at = NOW()
      `;
      if (senderKey) {
        await sql`
          UPDATE family_learned_patterns
          SET auto_assign = TRUE
          WHERE keyword = ${keyword} AND sender_or_group = ${senderKey} AND child_name = ${child}
            AND confirmations_count >= ${AUTO_ASSIGN_THRESHOLD}
        `;
      }
    }
  } catch (e) {
    console.error("[agent] learnPattern failed", e);
  }
};

/** Patterns whose keyword appears in the input AND whose source equals the draft's source. */
const matchPatterns = (patterns: Pattern[], sender: string | null, haystacks: Array<string | null>) => {
  const hay = haystacks.filter(Boolean).join(" ").toLowerCase();
  const senderKey = normSender(sender);
  return patterns.filter(
    (p) =>
      p.sender_or_group === senderKey &&
      ((p.keyword === SOURCE_WILDCARD && senderKey !== "") || (hay !== "" && hay.includes(p.keyword))),
  );
};

/* ---------- LLM ---------- */

const buildPrompt = (text: string, draft: Draft, history: ChatTurn[], patterns: Pattern[]) => {
  const now = israelNow();
  const learned = patterns.length
    ? patterns
        .filter((p) => p.keyword !== SOURCE_WILDCARD)
        .slice(0, 40)
        .map((p) => `"${p.keyword}"${p.sender_or_group ? ` מ-"${p.sender_or_group}"` : ""} => ${CHILD_LABEL[p.child_name as Child] ?? p.child_name}`)
        .join("; ") || "אין"
    : "אין";
  const hist = history.slice(-8).map((h) => `${h.role === "user" ? "משתמש" : "סוכן"}: ${h.content}`).join("\n");
  return `אתה סוכן לו"ז משפחתי. חלץ את כל האירועים מהקלט (טקסט ו/או צילום מסך, לרוב הודעת וואטסאפ) ומזג עם הטיוטה הקיימת.
היום: ${now.iso} (${now.weekday}), אזור זמן Asia/Jerusalem.

כללי חילוץ (קרא בקפידה, שורה אחר שורה):
- הודעה אחת יכולה להכיל לו"ז שבועי עם כמה ימים ושעות, למשל "יום שני 16:30, שלישי 15:30, רביעי 16:00". החזר אירוע נפרד לכל יום/שעה. אל תדלג על אף בלוק ואל תמזג שני ימים לאירוע אחד.
- חפש בלוקים בצורת "יום X - שעה Y" (או "X ב-Y", "X בשעה Y", "X Y"). time = שעת ההתחלה בלבד בפורמט HH:mm (בטווח "16:30-17:30" קח 16:30). שעה "4" אחה"צ = 16:00 בהקשר של פעילות ילדים.
- date = תאריך YYYY-MM-DD מדויק. אם כתוב רק יום בשבוע (ראשון..שבת) — זה המופע הקרוב הבא של אותו יום החל מהיום (או מהשבוע שצוין בהודעה). פענח גם "מחר", "מחרתיים", "ביום שלישי הבא".
- אל תמציא שעה או יום שלא כתובים. אם חסר — החזר null לשדה הזה.
- sender_or_group = שם קבוצת הוואטסאפ / כותרת השיחה / שם איש הקשר שמופיע בראש צילום המסך (או מוזכר בטקסט), בדיוק כפי שהוא כתוב. אם אין - null.
- הבחנה בין פנייה לשיוך: פנייה מנומסת לנמען השיחה, כמו "היי רועי", "רועי רשמתי", "שלום סיון", היא רק פנייה לנמען ואינה אומרת שהאירוע שייך לו! אל תקבע child_name על סמך פנייה/ברכה כזו. child_name נקבע רק כשברור שהאירוע עצמו מיועד לאותו אדם (למשל "אימון לרביד", "תרשום לרועי פגישה").
- שלילה מוחלטת של הסקת בעלים מביטויי אישור/ברכה: "רועי רשמתי", "היי רועי", "שלום סיון", "תודה רועי" — אלה לעולם אינם אומרים שהאירוע שייך לאדם. אל תסיק מהם child_name.
- כלל ברזל: תספורת / וטרינר / בדיקה / טיפול / חיסון, כל אירוע של הכלב, וכל מקרה ש"ג'וני"/"גוני" מופיע בשם איש הקשר או השיחה (למשל "מירב גוני ספרית") — לעולם child_name: null, גם אם כתוב "רועי רשמתי". כותרת האירוע יכולה להיות פשוט "תספורת". לאירועי כלב type="dog". אירועים משפחתיים כלליים — גם הם null.
- child_name = בן משפחה אחד לכל ההודעה: ravid (רביד), amit (עמית), alin (אלין), roi (רועי - אבא), sivan (סיון - אמא) — רק אם מוזכר במפורש בקלט החדש או בטיוטה (למשל "תרשום לרועי פגישה ב-10:00"). אחרת null. אל תנחש ואל תסיק לפי סוג הפעילות או לפי הדפוסים (ההחלטה בצד השרת).
- סוגים: dog, gym, sport, lesson, dance. בחר את הקרוב ביותר (כדורסל/כדורגל = sport).
- title = כותרת קצרה לאירוע (למשל "אימון כדורסל"). keyword = מילה אחת/שתיים שמזהות את הפעילות או האדם (למשל "מאמן", "כדורסל", "קרל").

דפוסים שנלמדו (לידיעתך בלבד): ${learned}
טיוטה נוכחית: ${JSON.stringify(draft)}
${hist ? `היסטוריית שיחה:\n${hist}\n` : ""}קלט חדש מהמשתמש: ${text || "(ללא טקסט — ראה תמונה)"}

אם הקלט החדש הוא תיקון/השלמה (למשל "18:00" או "ביום חמישי") — עדכן את האירוע המתאים בטיוטה והחזר את הרשימה המלאה של האירועים (כולל אלה שלא השתנו).
החזר JSON בלבד בפורמט:
{"sender_or_group": string|null, "child_name": "ravid"|"amit"|"alin"|"roi"|"sivan"|null, "events": [{"date": "YYYY-MM-DD"|null, "time": "HH:mm"|null, "title": string|null, "type": "dog|gym|sport|lesson|dance|other"|null, "keyword": string|null}]}`;
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

const shortDate = (iso: string | null) => {
  const m = (iso ?? "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[1]}` : iso ?? "";
};

const describeEvent = (e: DraftEvent) =>
  `${e.title || (e.type ? TYPE_LABEL[e.type] : "אירוע")} ב-${shortDate(e.date)} ב-${e.time}`;

/** Dog (Johnny) and general family events must never be auto-assigned: always ask who it is for. */
const GENERAL_EVENT_RE =
  /ג['׳’]?וני|וטרינר|כלב|חיסון|תספורת|ספרי?ת|מספרה|בדיקה|טיפול|כל המשפחה|ארוחת משפחה|אירוע משפחתי|משפחתי/;
/**
 * Iron rule: haircut / vet / check-up / treatment events, anything about Johnny (including when "גוני/ג'וני"
 * is only the sender or chat name, e.g. "מירב גוני ספרית"), and general family events are NEVER assigned
 * automatically, whatever else the message says ("רועי רשמתי", "היי רועי", ...).
 */
const isGeneralEvent = (e: DraftEvent, text: string, sender: string | null) =>
  e.type === "dog" ||
  GENERAL_EVENT_RE.test(`${e.title ?? ""} ${e.keyword ?? ""}`) ||
  GENERAL_EVENT_RE.test(sender ?? "") ||
  GENERAL_EVENT_RE.test(text);

/**
 * A name is only an owner when it appears outside greetings / acknowledgements such as
 * "היי רועי", "שלום סיון", "תודה רועי", "רועי רשמתי". Removes those phrases and checks what is left.
 */
const ACK_WORDS = "(?:היי|הי|שלום|תודה רבה|תודה|בוקר טוב|ערב טוב|אחלה)";
const ACK_AFTER = "(?:רשמתי|רשמנו|רשום|תודה|שלום|היי|הי|שמעת|בבקשה|ok|אוקי|אוקיי)";
const isExplicitOwnerMention = (text: string, child: Child) => {
  const name = CHILD_LABEL[child];
  const cleaned = text
    .replace(new RegExp(`${ACK_WORDS}\\s*,?\\s*${name}`, "gi"), " ")
    .replace(new RegExp(`${name}\\s*,?\\s*${ACK_AFTER}`, "gi"), " ");
  return cleaned.includes(name) || cleaned.toLowerCase().includes(child);
};

const buildQuestion = (draft: Draft, missing: string[], suggestedChild: Child | null) => {
  const complete = draft.events.filter((e) => e.date && e.time);
  if (missing.length === 1 && missing[0] === "child_name") {
    const summary =
      complete.length === 1
        ? `זיהיתי ${describeEvent(complete[0])}.`
        : `זיהיתי ${complete.length} אירועים:\n${complete.map((e) => `• ${describeEvent(e)}`).join("\n")}`;
    if (suggestedChild) {
      return complete.length === 1
        ? `${summary} לשבץ עבור ${CHILD_LABEL[suggestedChild]}?`
        : `${summary}\nלשבץ את כולם עבור ${CHILD_LABEL[suggestedChild]}?`;
    }
    return complete.length === 1 ? `${summary} עבור מי לשבץ?` : `${summary}\nעבור מי לשבץ את כולם?`;
  }
  const labels: Record<string, string> = {
    events: "איזה אירוע/ים (יום ושעה)",
    date: "באיזה תאריך/יום",
    time: "באיזו שעה",
    child_name: "עבור מי (רביד / עמית / אלין / רועי / סיון)",
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
          .map((h) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 800) }))
      : [];
    const previousDraft = sanitizeDraft(body.draft);
    const senderEndpoint = typeof body.senderSubscriptionEndpoint === "string" ? body.senderSubscriptionEndpoint : "";

    if (!text && !imageBase64) {
      return NextResponse.json({ success: false, error: "Text or image is required" }, { status: 400 });
    }

    const patterns = await loadPatterns();

    // Shortcut: a short reply ("עמית", "כן, עבור רביד", "עבור אלין", or a bare "כן" to the last
    // suggestion) answering the pending child question. No LLM needed; counts as a confirmation.
    const replyChild = (() => {
      // Only while a draft is waiting for its owner, and only for a short free-text reply that does not
      // itself carry a new time (so a new schedule pasted mid-conversation still goes to the model).
      if (imageBase64 || previousDraft.events.length === 0 || text.length > 100) return null;
      if (/\d{1,2}[:.]\d{2}/.test(text)) return null;
      const named = CHILDREN.filter((c) => text.includes(CHILD_LABEL[c]));
      // Free text like "זה תספורת לגוני תשבצי על רועי": the pending date/time stay as they are, and the
      // reply is NOT re-parsed for date/time. One mentioned name is enough.
      if (named.length === 1) return named[0];
      if (named.length === 0 && /^(כן|בטח|אישור|סבבה|אוקיי|אוקי|ok)[.!]?$/i.test(text)) {
        const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")?.content ?? "";
        const m = lastAssistant.match(/לשבץ[^?]*עבור (רביד|עמית|אלין|רועי|סיון)\?/);
        return m ? normalizeChild(m[1]) : null;
      }
      return null;
    })();

    let draft: Draft;
    if (replyChild) {
      draft = { ...previousDraft, child_name: replyChild };
      // The user clarified it is for Johnny: make the saved title say so ("תספורת" -> "תספורת לג'וני").
      if (/ג['׳’]?וני/.test(text)) {
        draft.events = draft.events.map((e) => {
          const base = (e.title ?? "").trim() || TYPE_LABEL[e.type ?? "dog"];
          return {
            ...e,
            title: /ג['׳’]?וני/.test(base) ? base : `${base} לג'וני`,
            type: e.type ?? "dog",
          };
        });
      }
    } else {
      const prompt = buildPrompt(text, previousDraft, history, patterns);
      const parsed = (await runModel(prompt, imageBase64 ? { data: imageBase64, mime: imageMime } : null)) as
        | Record<string, unknown>
        | null;
      const fromModel = sanitizeDraft(parsed);
      // Never infer an owner from a greeting/acknowledgement ("היי רועי", "רועי רשמתי", "תודה רועי").
      // For plain text we can verify it; for screenshots the prompt rule applies (plus the general-event rule below).
      const verifiedModelChild =
        fromModel.child_name && !imageBase64 && !isExplicitOwnerMention(text, fromModel.child_name)
          ? null
          : fromModel.child_name;
      draft = {
        // The model returns the full merged list; if it returns none, keep what we had.
        events: fromModel.events.length > 0 ? fromModel.events : previousDraft.events,
        child_name: verifiedModelChild ?? previousDraft.child_name,
        sender_or_group: fromModel.sender_or_group ?? previousDraft.sender_or_group,
      };
    }

    // Dog / general family events on first sight: never trust a guessed owner (e.g. from "היי רועי"),
    // never use memory. Always ask. Once the user answers (next turn) the answer is trusted.
    const mustAsk =
      !replyChild &&
      previousDraft.events.length === 0 &&
      draft.events.some((e) => isGeneralEvent(e, text, draft.sender_or_group));
    if (mustAsk) {
      draft.child_name = null;
    }

    // Child not stated by the user -> consult learned memory (keyword/source).
    // A generic keyword alone never causes a silent save: only a pattern with auto_assign=true
    // (3+ confirmations for this exact source+child) does. Otherwise it becomes a question.
    let suggestedChild: Child | null = null;
    let childFromMemory = false;
    if (!draft.child_name && !mustAsk) {
      const hay = [text, ...draft.events.flatMap((e) => [e.keyword, e.title])];
      const matches = matchPatterns(patterns, draft.sender_or_group, hay);
      const autoKids = [...new Set(matches.filter((p) => p.auto_assign).map((p) => normalizeChild(p.child_name)))].filter(
        (c): c is Child => c !== null,
      );
      if (autoKids.length === 1) {
        draft.child_name = autoKids[0];
        childFromMemory = true;
      } else if (matches.length > 0) {
        suggestedChild = normalizeChild(matches[0].child_name); // highest confirmations
      }
    }

    const missing: string[] = [];
    if (draft.events.length === 0) missing.push("events");
    if (draft.events.some((e) => !e.date)) missing.push("date");
    if (draft.events.some((e) => !e.time)) missing.push("time");
    if (!draft.child_name) missing.push("child_name");

    if (missing.length > 0) {
      const confirmOnly = missing.length === 1 && missing[0] === "child_name" && suggestedChild;
      const quick = !missing.includes("child_name")
        ? []
        : confirmOnly && suggestedChild
          ? [
              `כן, עבור ${CHILD_LABEL[suggestedChild]}`,
              ...CHILDREN.filter((c) => c !== suggestedChild).map((c) => `עבור ${CHILD_LABEL[c]}`),
            ]
          : CHILDREN.map((c) => CHILD_LABEL[c]);
      return NextResponse.json({
        success: false,
        missing_fields: missing,
        question: buildQuestion(draft, missing, suggestedChild),
        draft,
        quick_replies: quick,
      });
    }

    // Everything is known. Save all events at once.
    const child = draft.child_name as Child;
    await ensureScheduleMetadataColumn();

    const saved: Array<{ id: string; title: string; date: string; time: string; child: Child; type: EventType }> = [];
    for (const e of draft.events) {
      const date = e.date as string;
      const time = e.time as string;
      const type: EventType = e.type ?? (child === "roi" || child === "sivan" ? "other" : "sport");
      const title = e.title ?? e.keyword ?? TYPE_LABEL[type];
      const id = crypto.randomUUID();
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
      try {
        await sql`
          INSERT INTO schedule (id, title, "date", metadata)
          VALUES (${id}, ${title}, ${date}, ${sqlJson(metadata)})
        `;
      } catch (dbError) {
        console.error("[agent] INSERT INTO schedule failed", { id, title, date, time, child, details: describeError(dbError) });
        throw new Error(`DB insert failed: ${describeError(dbError)}`);
      }
      saved.push({ id, title, date, time, child, type });
    }

    // Learn immediately: keywords + the source (sender_or_group) => this child.
    // Each batch counts as one confirmation; auto_assign flips on at 3 for a known source.
    await learnPattern(
      draft.events.flatMap((e) => [e.keyword, e.title]),
      draft.sender_or_group,
      child,
      draft.events.find((e) => e.type)?.type ?? null,
    );

    try {
      await sendPushToAll(
        {
          title: saved.length > 1 ? "משימות חדשות נוספו" : "משימה חדשה נוספה",
          body:
            saved.length > 1
              ? `נוספו ${saved.length} משימות עבור ${CHILD_LABEL[child]}`
              : `נוספה משימה ל${CHILD_LABEL[child]}: ${saved[0].title} - ${saved[0].time}`,
          url: "/",
        },
        { excludeEndpoint: senderEndpoint },
      );
    } catch (e) {
      console.error("[agent] push failed", e);
    }

    const lines = saved.map((s) => `• ${s.title} — ${s.date} ב-${s.time}`).join("\n");
    return NextResponse.json({
      success: true,
      message: `נרשמו ${saved.length} אירועים עבור ${CHILD_LABEL[child]}${
        childFromMemory ? " (שובץ אוטומטית לפי למידה מאושרת)" : ""
      }:\n${lines}`,
      events: saved,
      draft: emptyDraft(),
    });
  } catch (error) {
    // Full detail goes to the server log (visible in Vercel); the client gets a readable, non-empty message.
    console.error("[API] POST /api/agent failed:", describeError(error), error);
    return NextResponse.json({ success: false, error: describeError(error) }, { status: 500 });
  }
}
