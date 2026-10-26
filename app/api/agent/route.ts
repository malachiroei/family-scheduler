import { NextRequest, NextResponse, after } from "next/server";
import { sql, sqlJson } from "@/app/lib/db";
import { buildMetadataFromIncoming } from "@/app/lib/scheduleTable";
import { sendPushToAll } from "@/app/lib/push";
import {
  fixtureSenderKey,
  isSpreadsheetUpload,
  normalizeLeagueKey,
  parseFixtureWorkbook,
} from "@/app/lib/parseFixtureWorkbook";
import { classifyFixtureLeague } from "@/app/lib/fixtureLeague";
import {
  escapeRegExp,
  type FamilyRoster,
} from "@/app/lib/familyMembers";
import { loadFamilyRoster } from "@/app/lib/familyRosterStore";
import { recordAgentInteraction } from "@/app/lib/agentHistoryStore";
import { parseFlexibleDate, weekdayIndexUtc } from "@/app/lib/scheduleDate";
import { applyGeminiKeyToProcessEnv, resolveGeminiApiKey, resolveOpenAIApiKey } from "@/app/lib/llmKeys";

export const revalidate = 0;
export const maxDuration = 60;

const GEMINI_MODELS = ["gemini-2.0-flash"] as const;
const GEMINI_TIMEOUT_MS = 12_000;
const GEMINI_SAFETY = [
  { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
] as const;

type Child = string;
const childLabel = (roster: FamilyRoster, key: string | null | undefined) =>
  key ? roster.labelForMemberKey(key) : "";
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
  league?: string | null;
};

type Draft = {
  events: DraftEvent[];
  child_name: Child | null; // one child for the whole batch
  sender_or_group: string | null; // WhatsApp group / chat title / contact name
  /** Spreadsheet import: always confirm parsed games with the user before saving. */
  needs_confirm?: boolean;
  import_kind?: "fixtures" | null;
  league?: string | null;
  team?: string | null;
};

type ChatTurn = { role: "user" | "assistant"; content: string };

const emptyDraft = (): Draft => ({
  events: [],
  child_name: null,
  sender_or_group: null,
  needs_confirm: false,
  import_kind: null,
  league: null,
  team: null,
});

/** ["סיון","עמית","אלין"] -> "סיון, עמית ואלין" */
const joinNames = (names: string[]) =>
  names.length <= 1 ? names.join("") : `${names.slice(0, -1).join(", ")} ו${names[names.length - 1]}`;

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

const dayIndexOf = (iso: string) => weekdayIndexUtc(iso);

const normalizeDate = (v: unknown): string | null => parseFlexibleDate(v);

const normalizeTime = (v: unknown): string | null => {
  if (typeof v !== "string") return null;
  const m = v.trim().match(/^(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
};

const normalizeChild = (v: unknown, roster: FamilyRoster): Child | null => {
  if (typeof v !== "string") return null;
  return roster.resolveMemberKey(v);
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
    title: str(o.title, 280),
    type: normalizeType(o.type),
    keyword: str(o.keyword, 40),
    league: str(o.league, 80),
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

const sanitizeDraft = (raw: unknown, roster: FamilyRoster): Draft => {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const list = Array.isArray(o.events) ? o.events : [];
  return {
    events: dedupeEvents(list.slice(0, 80).map(sanitizeEvent)),
    child_name: normalizeChild(o.child_name ?? o.child, roster),
    sender_or_group: str(o.sender_or_group, 80),
    needs_confirm: o.needs_confirm === true,
    import_kind: o.import_kind === "fixtures" ? "fixtures" : null,
    league: str(o.league, 80),
    team: str(o.team, 80),
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

/** League boards (נערים ב / ילדות ב) are a one-shot mapping: after the user answers once, auto-assign next time. */
const learnFixtureAssignment = async (team: string | null, league: string | null, child: Child) => {
  const senderKey = fixtureSenderKey(team, league);
  const leagueKey = normalizeLeagueKey(league);
  try {
    await ensurePatternsTable();
    const keywords = leagueKey ? [SOURCE_WILDCARD, leagueKey] : [SOURCE_WILDCARD];
    for (const keyword of keywords) {
      await sql`
        INSERT INTO family_learned_patterns
          (keyword, sender_or_group, child_name, event_type, hits, confirmations_count, auto_assign)
        VALUES (${keyword}, ${senderKey}, ${child}, ${"sport"}, 1, 1, TRUE)
        ON CONFLICT (keyword, sender_or_group, child_name) DO UPDATE SET
          hits = family_learned_patterns.hits + 1,
          confirmations_count = family_learned_patterns.confirmations_count + 1,
          auto_assign = TRUE,
          event_type = 'sport',
          updated_at = NOW()
      `;
    }
  } catch (e) {
    console.error("[agent] learnFixtureAssignment failed", e);
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

// Number of recent conversation turns included in the model prompt (keep in sync with the client).
const MAX_CONTEXT_TURNS = 10;

const buildPrompt = (text: string, draft: Draft, history: ChatTurn[], patterns: Pattern[], roster: FamilyRoster) => {
  const now = israelNow();
  const learned = patterns.length
    ? patterns
        .filter((p) => p.keyword !== SOURCE_WILDCARD)
        .slice(0, 40)
        .map((p) => `"${p.keyword}"${p.sender_or_group ? ` מ-"${p.sender_or_group}"` : ""} => ${childLabel(roster, p.child_name) || p.child_name}`)
        .join("; ") || "אין"
    : "אין";
  const hist = history.slice(-MAX_CONTEXT_TURNS).map((h) => `${h.role === "user" ? "משתמש" : "סוכן"}: ${h.content}`).join("\n");
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
- כלל ברזל: תספורת / וטרינר / חיסון לכלב, כל אירוע של הכלב, וכל מקרה ש"ג'וני"/"גוני" מופיע בשם איש הקשר או השיחה (למשל "מירב גוני ספרית") — לעולם child_name: null, גם אם כתוב "רועי רשמתי". כותרת האירוע יכולה להיות פשוט "תספורת". לאירועי כלב type="dog".
- כרטיסיית תור מקופת חולים / מכבי / כללית / מאוחדת / "תור במרפאה" היא שיבוץ ליומן (לא ייעוץ רפואי). חלץ תאריך (גם 28/10/26), שעה, ושם המטופל אם כתוב על הכרטיס. אם השם הוא בן משפחה — זה child_name. כותרת: "תור במרפאה" (או שם הרופא/מכון אם כתוב), type="other".
- child_name = בן משפחה אחד לכל ההודעה: ${roster.members.map((m) => `${m.key} (${m.name})`).join(", ")} — רק אם מוזכר במפורש בקלט החדש או בטיוטה. אחרת null. אל תנחש ואל תסיק לפי סוג הפעילות או לפי הדפוסים (ההחלטה בצד השרת).
- סוגים: dog, gym, sport, lesson, dance. בחר את הקרוב ביותר (כדורסל/כדורגל = sport).
- בחן תמיד קודם כל את החלק העליון ביותר של צילום המסך (שם קבוצת הוואטסאפ, שם השולח או כותרת השיחה) — הוא נותן את ההקשר לכל האירועים בצילום.
- אסור להשתמש בכותרות גנריות כמו "פעילות", "אירוע", "פגישה" או "משימה". השתמש בשם הקבוצה/השיחה ובתוכן ההודעה כדי לתת כותרת משמעותית. אם הקבוצה עוסקת באימונים/משחקים (למשל "ילדות ב", "קט-סל", "נוער", "אימון", "משחקים") — כותרת האירוע "אימון כדורסל" (או "אימון" אם אין רמז לכדורסל), type="sport".
- הקשר משפחתי (שמות נוכחיים): ${roster.memberDisplayNames.join(", ")}. עדיין אין לקבוע child_name בלי אזכור מפורש — ההצעה לשיוך נעשית בצד השרת.
- title = כותרת קצרה לאירוע (למשל "אימון כדורסל"). keyword = מילה אחת/שתיים שמזהות את הפעילות או האדם (למשל "מאמן", "כדורסל", "קרל").

דפוסים שנלמדו (לידיעתך בלבד): ${learned}
טיוטה נוכחית: ${JSON.stringify(draft)}
${hist ? `היסטוריית שיחה:\n${hist}\n` : ""}קלט חדש מהמשתמש: ${text || "(ללא טקסט — ראה תמונה)"}

אם הקלט החדש מפנה לאירוע קודם בשיחה (למשל "תוסיף עוד אחד כזה מחר", "אותו דבר גם ביום שלישי"), שכפל את האירוע האחרון שנרשם בהיסטוריית השיחה (כותרת, שעה, ילד) עם התאריך/היום החדש שביקשו.
אם הקלט החדש הוא תיקון/השלמה (למשל "18:00" או "ביום חמישי") — עדכן את האירוע המתאים בטיוטה והחזר את הרשימה המלאה של האירועים (כולל אלה שלא השתנו).
החזר JSON בלבד בפורמט:
{"sender_or_group": string|null, "child_name": ${roster.memberKeys.map((k) => `"${k}"`).join("|")}|null, "events": [{"date": "YYYY-MM-DD"|null, "time": "HH:mm"|null, "title": string|null, "type": "dog|gym|sport|lesson|dance|other"|null, "keyword": string|null}]}`;
};

/** Short vision prompt: read whatever is in the screenshot, do not assume a specific person. */
const buildImagePrompt = (text: string, roster: FamilyRoster) => {
  const now = israelNow();
  const people = roster.members.map((m) => `${m.name}=${m.key}`).join(", ");
  return `קראי את צילום המסך וחלצי את האירועים שכתובים בו בלבד. אל תמציאי פרטים שלא נראים.
היום: ${now.iso} (${now.weekday}), Asia/Jerusalem.
כל כרטיס / הודעה / שורת יומן = אירוע נפרד.
date=YYYY-MM-DD (28/10/26 → 2026-10-28). time=HH:mm שעת התחלה.
title=הכותרת שכתובה (תור במרפאה, אימון, שיעור...).
אם כתוב על הכרטיס שם מאלה, זה הבעלים: ${people}. שימי את המפתח ב-child_name ואת השם ב-keyword.
type: מרפאה/תור/רופא=other, אימון/משחק=sport, שיעור=lesson, כלב=dog.
${text ? `הערת המשתמש: ${text}` : ""}
החזירי JSON בלבד:
{"sender_or_group": string|null, "child_name": string|null, "events":[{"date":"YYYY-MM-DD"|null,"time":"HH:mm"|null,"title":string|null,"type":"dog|gym|sport|lesson|dance|other"|null,"keyword":string|null}]}`;
};

const extractJsonObject = (t: string) => {
  if (!t) return null;
  const cleaned = t.replace(/```(?:json)?/gi, "").trim();
  const s = cleaned.indexOf("{");
  const e = cleaned.lastIndexOf("}");
  if (s !== -1 && e > s) {
    try {
      return JSON.parse(cleaned.slice(s, e + 1));
    } catch {
      // try the array form below
    }
  }
  const as = cleaned.indexOf("[");
  const ae = cleaned.lastIndexOf("]");
  if (as !== -1 && ae > as) {
    try {
      const arr = JSON.parse(cleaned.slice(as, ae + 1));
      if (Array.isArray(arr)) return { events: arr, child_name: null, sender_or_group: null };
    } catch {
      return null;
    }
  }
  return null;
};

const textFromGeminiPayload = (data: unknown): string => {
  if (!data || typeof data !== "object") return "";
  const obj = data as Record<string, unknown>;
  if (typeof obj.text === "string" && obj.text.trim()) return obj.text;
  const candidates = Array.isArray(obj.candidates) ? obj.candidates : [];
  const parts: string[] = [];
  for (const candidate of candidates) {
    const content = candidate && typeof candidate === "object" ? (candidate as Record<string, unknown>).content : null;
    const list =
      content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).parts)
        ? ((content as Record<string, unknown>).parts as unknown[])
        : [];
    for (const part of list) {
      if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
        parts.push(String((part as { text: string }).text));
      }
    }
  }
  return parts.join("").trim();
};

const callOpenAI = async (prompt: string, img: { data: string; mime: string } | null) => {
  const key = resolveOpenAIApiKey();
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

const callGeminiRest = async (
  key: string,
  model: string,
  parts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }>,
  signal: AbortSignal,
) => {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
          maxOutputTokens: 2048,
        },
        safetySettings: GEMINI_SAFETY,
      }),
    },
  );
  const raw = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini ${model} ${res.status}: ${raw.slice(0, 400)}`);
  }
  let data: unknown = null;
  try {
    data = raw ? JSON.parse(raw) : null;
  } catch {
    throw new Error(`Gemini ${model} non-JSON body`);
  }
  const text = textFromGeminiPayload(data);
  if (!text) {
    const feedback = data && typeof data === "object" ? (data as Record<string, unknown>).promptFeedback : null;
    throw new Error(`Gemini ${model} empty body ${feedback ? JSON.stringify(feedback).slice(0, 200) : ""}`.trim());
  }
  return text;
};

const callGemini = async (prompt: string, img: { data: string; mime: string } | null) => {
  const key = applyGeminiKeyToProcessEnv();
  if (!key) return null;
  const imagePart = img
    ? { inlineData: { mimeType: img.mime || "image/jpeg", data: img.data.replace(/\s+/g, "") } }
    : null;
  const parts = imagePart ? [imagePart, { text: prompt }] : [{ text: prompt }];
  const model = GEMINI_MODELS[0];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
  try {
    return await callGeminiRest(key, model, parts, controller.signal);
  } finally {
    clearTimeout(timer);
  }
};

const runModel = async (prompt: string, img: { data: string; mime: string } | null) => {
  const hasGemini = Boolean(resolveGeminiApiKey());
  const hasOpenAI = Boolean(resolveOpenAIApiKey());
  if (!hasGemini && !hasOpenAI) {
    throw new Error("Missing GEMINI_API_KEY / NEXT_PUBLIC_GEMINI_API_KEY");
  }
  if (img) {
    if (!hasGemini) throw new Error("Missing GEMINI_API_KEY / NEXT_PUBLIC_GEMINI_API_KEY");
    const raw = await callGemini(prompt, img);
    const parsed = raw ? extractJsonObject(raw) : null;
    if (parsed) return parsed;
    throw new Error("לא הצלחתי לקרוא את הצילום. נסי שוב עם אותה תמונה.");
  }
  const out = (await callOpenAI(prompt, null)) ?? (await callGemini(prompt, null));
  const parsed = out ? extractJsonObject(out) : null;
  if (parsed) return parsed;
  throw new Error(
    hasGemini
      ? "Gemini returned an empty or invalid response"
      : "Missing GEMINI_API_KEY / NEXT_PUBLIC_GEMINI_API_KEY",
  );
};

/* ---------- questions ---------- */

const shortDate = (iso: string | null) => {
  const m = (iso ?? "").match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m ? `${m[2]}/${m[1]}` : iso ?? "";
};

const describeEvent = (e: DraftEvent) => {
  const title = (e.title || (e.type ? TYPE_LABEL[e.type] : "אירוע")).split("\n")[0];
  return `${title} ב-${shortDate(e.date)} ב-${e.time}`;
};

const CONFIRM_YES_RE = /^(כן|בטח|אישור|סבבה|אוקיי|אוקי|ok)[.!]?$/i;

/** Dog (Johnny) and general family events must never be auto-assigned: always ask who it is for. */
const GENERAL_EVENT_RE =
  /ג['׳’]?וני|וטרינר|כלב|חיסון|תספורת|ספרי?ת|מספרה|בדיקה|טיפול|כל המשפחה|ארוחת משפחה|אירוע משפחתי|משפחתי/;
const CLINIC_APPT_RE = /תור|מרפאה|מכבי|כללית|מאוחדת|רופא|רופאת|קופ["׳']?ח/;
const isClinicAppointment = (e: DraftEvent, text: string, sender: string | null) =>
  CLINIC_APPT_RE.test(`${e.title ?? ""} ${e.keyword ?? ""} ${text} ${sender ?? ""}`);
/**
 * Iron rule: haircut / vet / check-up / treatment events, anything about Johnny (including when "גוני/ג'וני"
 * is only the sender or chat name, e.g. "מירב גוני ספרית"), and general family events are NEVER assigned
 * automatically, whatever else the message says ("רועי רשמתי", "היי רועי", ...).
 */
const isGeneralEvent = (e: DraftEvent, text: string, sender: string | null) => {
  if (isClinicAppointment(e, text, sender)) return false;
  return (
    e.type === "dog" ||
    GENERAL_EVENT_RE.test(`${e.title ?? ""} ${e.keyword ?? ""}`) ||
    GENERAL_EVENT_RE.test(sender ?? "") ||
    GENERAL_EVENT_RE.test(text)
  );
};

/**
 * A name is only an owner when it appears outside greetings / acknowledgements such as
 * "היי רועי", "שלום סיון", "תודה רועי", "רועי רשמתי". Removes those phrases and checks what is left.
 */
const ACK_WORDS = "(?:היי|הי|שלום|תודה רבה|תודה|בוקר טוב|ערב טוב|אחלה)";
const ACK_AFTER = "(?:רשמתי|רשמנו|רשום|תודה|שלום|היי|הי|שמעת|בבקשה|ok|אוקי|אוקיי)";
const isExplicitOwnerMention = (text: string, child: Child, roster: FamilyRoster) => {
  const name = childLabel(roster, child);
  if (!name) return text.toLowerCase().includes(child);
  const escaped = escapeRegExp(name);
  const cleaned = text
    .replace(new RegExp(`${ACK_WORDS}\\s*,?\\s*${escaped}`, "gi"), " ")
    .replace(new RegExp(`${escaped}\\s*,?\\s*${ACK_AFTER}`, "gi"), " ");
  return cleaned.includes(name) || cleaned.toLowerCase().includes(child);
};

/** Group names like "הורים ילדות ב" are the girls' team (amit / alin). */
const isGirlsGroup = (sender: string | null) => /ילדות\s*ב/.test(sender ?? "");
const SPORT_CONTEXT_RE = /ילדות\s*ב|קט[\s-]?סל|נוער|אימון|משחק|כדורסל/;
const GENERIC_TITLE_RE = /^\s*(פעילות|אירוע|פגישה|משימה|activity|event)?\s*$/i;

/** Replace generic/empty titles using the group name (e.g. "הורים ילדות ב" -> "אימון כדורסל", type sport). */
const enrichGenericTitles = (draft: Draft, text: string) => {
  const ctx = `${draft.sender_or_group ?? ""} ${text}`;
  if (!SPORT_CONTEXT_RE.test(ctx) || GENERAL_EVENT_RE.test(ctx)) return;
  const title = /כדורסל|קט[\s-]?סל|ילדות\s*ב/.test(ctx) ? "אימון כדורסל" : "אימון";
  draft.events = draft.events.map((e) =>
    GENERIC_TITLE_RE.test(e.title ?? "") ? { ...e, title, type: e.type && e.type !== "other" ? e.type : "sport" } : e,
  );
};

const buildQuestion = (draft: Draft, missing: string[], suggestedChild: Child | null, roster: FamilyRoster) => {
  const complete = draft.events.filter((e) => e.date && e.time);
  if (missing.length === 1 && missing[0] === "child_name") {
    const previewLimit = draft.import_kind === "fixtures" ? 12 : complete.length;
    const preview = complete.slice(0, previewLimit).map((e) => `• ${describeEvent(e)}`).join("\n");
    const extra = complete.length > previewLimit ? `\n(+${complete.length - previewLimit} נוספים)` : "";
    const kind = classifyFixtureLeague(draft.league);
    const kindHint =
      kind === "katsal"
        ? " — שנתון צעיר, תגבור (לא הליגה הראשית)"
        : kind === "girls"
          ? " — הליגה הראשית של הבנות"
          : "";
    const leagueBit = draft.league ? ` בליגת ${draft.league}${kindHint}` : kindHint;
    const teamName = draft.team?.trim() || "הקבוצה";
    const summary =
      draft.import_kind === "fixtures"
        ? `זיהיתי ${complete.length} משחקים עבור קבוצת ${teamName}${leagueBit}:\n${preview}${extra}`
        : complete.length === 1
          ? `זיהיתי ${describeEvent(complete[0])}.`
          : `זיהיתי ${complete.length} אירועים:\n${preview}`;
    if (draft.import_kind === "fixtures" && !suggestedChild) {
      return `${summary}\n\nלאיזה ילד/ה לשייך את המשחקים בלוח?`;
    }
    if (suggestedChild) {
      return complete.length === 1 && draft.import_kind !== "fixtures"
        ? `${summary} לשבץ עבור ${childLabel(roster, suggestedChild)}?`
        : `${summary}\nלשבץ את כולם עבור ${childLabel(roster, suggestedChild)}?`;
    }
    if (isGirlsGroup(draft.sender_or_group)) {
      return `${summary}\nעבור ${roster.childDisplayNames.join(" או ")}?`;
    }
    return complete.length === 1 ? `${summary} עבור מי לשבץ?` : `${summary}\nעבור מי לשבץ את כולם?`;
  }
  const labels: Record<string, string> = {
    events: "איזה אירוע/ים (יום ושעה)",
    date: "באיזה תאריך/יום",
    time: "באיזו שעה",
    child_name: `עבור מי (${roster.memberDisplayNames.join(" / ")})`,
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
    const fileBase64 =
      typeof body.fileBase64 === "string" ? body.fileBase64.replace(/^data:[^;]+;base64,/, "").trim() : "";
    const fileName = typeof body.fileName === "string" ? body.fileName.trim() : "";
    const fileMime = typeof body.fileMimeType === "string" ? body.fileMimeType.trim() : "";
    const history: ChatTurn[] = Array.isArray(body.history)
      ? (body.history as unknown[])
          .map((h) => h as Record<string, unknown>)
          .filter((h) => (h?.role === "user" || h?.role === "assistant") && typeof h.content === "string")
          .map((h) => ({ role: h.role as "user" | "assistant", content: String(h.content).slice(0, 800) }))
      : [];
    const roster = await loadFamilyRoster();
    const previousDraft = sanitizeDraft(body.draft, roster);
    const senderEndpoint = typeof body.senderSubscriptionEndpoint === "string" ? body.senderSubscriptionEndpoint : "";

    if (!text && !imageBase64 && !fileBase64) {
      return NextResponse.json({ success: false, error: "Text, image or spreadsheet is required" }, { status: 400 });
    }

    const spreadsheetUploaded = Boolean(fileBase64) && isSpreadsheetUpload(fileName, fileMime || imageMime);

    // Shortcut: a short reply ("עמית", "כן, עבור רביד", "עבור אלין", or a bare "כן" to the last
    // suggestion) answering the pending child question. No LLM needed; counts as a confirmation.
    // Names explicitly written by the user ("סיון, עמית ואלין", or "כולם" = the whole family).
    const mentionedKids: Child[] =
      imageBase64 || spreadsheetUploaded || text.length > 100
        ? []
        : /(^|\s)(כולם|כל המשפחה|כל בני המשפחה)(\s|$|[.,!])/.test(text)
          ? [...roster.memberKeys]
          : roster.findMembersMentionedInText(text).map((member) => member.key);

    const replyKids: Child[] | null = (() => {
      // Only while a draft is waiting for its owner, and only for a short free-text reply that does not
      // itself carry a new time (so a new schedule pasted mid-conversation still goes to the model).
      if (imageBase64 || spreadsheetUploaded || previousDraft.events.length === 0 || text.length > 100) return null;
      if (/\d{1,2}[:.]\d{2}/.test(text)) return null;
      // Free text like "זה תספורת לגוני תשבצי על רועי": the pending date/time stay as they are, and the
      // reply is NOT re-parsed for date/time. One or more mentioned names are enough.
      if (mentionedKids.length >= 1) return mentionedKids;
      if (CONFIRM_YES_RE.test(text)) {
        const lastAssistant = [...history].reverse().find((h) => h.role === "assistant")?.content ?? "";
        const m = lastAssistant.match(new RegExp(`לשבץ[^?]*עבור (${roster.memberAliasPattern})\\?`));
        const c = m ? normalizeChild(m[1], roster) : null;
        return c ? [c] : null;
      }
      return null;
    })();
    const replyChild: Child | null = replyKids?.[0] ?? null;
    // Several owners named explicitly: save the same event(s) for each of them, never ask again, no LLM fallback for the owner.
    const multiKids: Child[] | null =
      replyKids && replyKids.length > 1 ? replyKids : mentionedKids.length > 1 ? mentionedKids : null;

    // Fast path (owner reply / screenshot OCR) skips learned-pattern DB work.
    const patterns = replyChild || imageBase64 ? [] : await loadPatterns();

    let draft: Draft;
    if (spreadsheetUploaded) {
      let parsed;
      try {
        parsed = parseFixtureWorkbook(Buffer.from(fileBase64, "base64"), fileName);
      } catch (e) {
        console.error("[agent] spreadsheet parse failed", e);
        return NextResponse.json(
          { success: false, error: "לא הצלחתי לקרוא את קובץ האקסל. ודאו שזה xlsx/xls/csv תקין." },
          { status: 400 },
        );
      }
      if (!parsed.games.length) {
        const hint = parsed.team ? ` של ${parsed.team}` : "";
        return NextResponse.json({
          success: false,
          missing_fields: ["events"],
          question: `לא מצאתי משחקים${hint} בקובץ. חפשו עמודות ליגה, תאריך, שעה / Time, קבוצה ביתית / Home Team, קבוצה אורחת / Away Team ומגרש / Venue.`,
          draft: emptyDraft(),
          quick_replies: [],
        });
      }
      draft = {
        events: parsed.games.map((g) => ({
          date: g.date,
          time: g.time,
          title: g.title,
          type: "sport" as EventType,
          keyword: normalizeLeagueKey(g.league) || normalizeLeagueKey(parsed.league) || parsed.team,
          league: g.league,
        })),
        child_name: null,
        sender_or_group: fixtureSenderKey(parsed.team, parsed.league),
        needs_confirm: true,
        import_kind: "fixtures",
        league: parsed.league,
        team: parsed.team || null,
      };
    } else if (replyChild) {
      draft = { ...previousDraft, child_name: replyChild, needs_confirm: false };
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
    } else if (
      previousDraft.import_kind === "fixtures" &&
      previousDraft.events.length > 0 &&
      !imageBase64 &&
      text.length < 100 &&
      !/\d{1,2}[:.]\d{2}/.test(text)
    ) {
      draft = { ...previousDraft };
    } else {
      const prompt = imageBase64
        ? buildImagePrompt(text, roster)
        : buildPrompt(text, previousDraft, history, patterns, roster);
      const parsed = (await runModel(prompt, imageBase64 ? { data: imageBase64, mime: imageMime } : null)) as
        | Record<string, unknown>
        | null;
      const fromModel = sanitizeDraft(parsed, roster);
      // Never infer an owner from a greeting/acknowledgement ("היי רועי", "רועי רשמתי", "תודה רועי").
      // For screenshots, trust the name the model read on the card.
      const verifiedModelChild =
        fromModel.child_name && !imageBase64 && !isExplicitOwnerMention(text, fromModel.child_name, roster)
          ? null
          : fromModel.child_name;
      const ownerFromCard = imageBase64
        ? [...new Set(
            [fromModel.child_name, fromModel.sender_or_group, ...fromModel.events.flatMap((e) => [e.keyword, e.title])]
              .map((value) => normalizeChild(value, roster))
              .filter((value): value is Child => Boolean(value)),
          )]
        : [];
      draft = imageBase64
        ? {
            events: fromModel.events,
            child_name: verifiedModelChild ?? (ownerFromCard.length === 1 ? ownerFromCard[0] : null),
            sender_or_group: fromModel.sender_or_group,
            needs_confirm: false,
            import_kind: null,
            league: null,
            team: null,
          }
        : {
            events: fromModel.events.length > 0 ? fromModel.events : previousDraft.events,
            child_name: verifiedModelChild ?? previousDraft.child_name,
            sender_or_group: fromModel.sender_or_group ?? previousDraft.sender_or_group,
            needs_confirm: previousDraft.needs_confirm === true,
            import_kind: previousDraft.import_kind,
            league: previousDraft.league,
            team: previousDraft.team,
          };
    }

    if (multiKids) draft.child_name = multiKids[0];
    if (draft.import_kind !== "fixtures") enrichGenericTitles(draft, text);

    // Dog / general family events on first sight: never trust a guessed owner (e.g. from "היי רועי"),
    // never use memory. Always ask. Once the user answers (next turn) the answer is trusted.
    const mustAsk =
      !replyChild &&
      !multiKids &&
      draft.import_kind !== "fixtures" &&
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
      const hay = [text, draft.league ?? null, draft.team ?? null, ...draft.events.flatMap((e) => [e.keyword, e.title])];
      const matches = matchPatterns(patterns, draft.sender_or_group, hay);
      const autoKids = [...new Set(matches.filter((p) => p.auto_assign).map((p) => normalizeChild(p.child_name, roster)))].filter(
        (c): c is Child => c !== null,
      );
      if (autoKids.length === 1) {
        draft.child_name = autoKids[0];
        childFromMemory = true;
      } else if (matches.length > 0) {
        suggestedChild = normalizeChild(matches[0].child_name, roster); // highest confirmations
      }
    }

    if (draft.import_kind === "fixtures" && !draft.child_name && !suggestedChild && roster.children.length === 1) {
      suggestedChild = roster.children[0].key;
    }

    if (draft.import_kind === "fixtures" && draft.needs_confirm) {
      const confirming =
        Boolean(replyChild) ||
        Boolean(multiKids) ||
        (CONFIRM_YES_RE.test(text) && Boolean(draft.child_name || suggestedChild));
      if (confirming) {
        if (!draft.child_name && suggestedChild) draft.child_name = suggestedChild;
        draft.needs_confirm = false;
      } else if (draft.child_name) {
        suggestedChild = draft.child_name;
      }
    }

    const missing: string[] = [];
    if (draft.events.length === 0) missing.push("events");
    if (draft.events.some((e) => !e.date)) missing.push("date");
    if (draft.events.some((e) => !e.time)) missing.push("time");
    if (!draft.child_name || draft.needs_confirm) missing.push("child_name");

    if (missing.length > 0) {
      const confirmOnly = missing.length === 1 && missing[0] === "child_name" && suggestedChild;
      const askingOwner = missing.includes("child_name");
      const isFixtures = draft.import_kind === "fixtures";
      // Individual people: the client shows them as toggles (several can be picked) plus a confirm button.
      const assigneeOptions: string[] = !askingOwner
        ? []
        : isFixtures
          ? [...(roster.childDisplayNames.length ? roster.childDisplayNames : roster.memberDisplayNames)]
          : isGirlsGroup(draft.sender_or_group)
            ? [...roster.childDisplayNames, ...roster.memberDisplayNames.filter((n) => !roster.childDisplayNames.includes(n))]
            : [...roster.memberDisplayNames];
      // Joint choices that save for everyone in one tap ("רועי וסיון", "כולם"); the reply text names each person.
      const assigneeCombos: string[] = [];
      if (askingOwner && !isFixtures) {
        if (roster.parents.length >= 2) assigneeCombos.push(`${roster.parents[0].name} ו${roster.parents[1].name}`);
        if (isGirlsGroup(draft.sender_or_group)) {
          assigneeCombos.push(...roster.familyPairOptions.map((pair) => pair.label.replace(" (ביחד)", "")));
        }
        assigneeCombos.push("כולם");
      }
      const quick: string[] = !askingOwner
        ? []
        : confirmOnly && suggestedChild
          ? [`כן, עבור ${childLabel(roster, suggestedChild)}`, ...assigneeCombos]
          : assigneeCombos;
      return NextResponse.json({
        success: false,
        missing_fields: missing,
        question: buildQuestion(draft, missing, suggestedChild, roster),
        draft,
        quick_replies: quick,
        assignee_options: assigneeOptions,
      });
    }

    // Everything is known. Save all events at once.
    const child = draft.child_name as Child;
    const saved: Array<{ id: string; title: string; date: string; time: string; child: Child; type: EventType }> = [];
    const rowsToInsert: Array<{ id: string; title: string; date: string; metadata: ReturnType<typeof buildMetadataFromIncoming> }> = [];
    const kids: Child[] = multiKids ?? [child];
    for (const kid of kids) for (const e of draft.events) {
      const date = e.date as string;
      const time = e.time as string;
      const type: EventType = e.type ?? (roster.isParentMemberKey(kid) ? "other" : "sport");
      const title = e.title ?? e.keyword ?? TYPE_LABEL[type];
      const id = crypto.randomUUID();
      const metadata = buildMetadataFromIncoming({
        dayIndex: dayIndexOf(date),
        time,
        child: kid,
        type,
        isRecurring: false,
        completed: false,
        sendNotification: true,
        requireConfirmation: false,
        needsAck: false,
        reminderLeadMinutes: null,
        userId: "agent",
        notified: false,
        league: e.league ?? draft.league ?? null,
        eventDate: date,
        source: draft.import_kind === "fixtures" ? "fixtures" : "agent",
      });
      rowsToInsert.push({ id, title, date, metadata });
      saved.push({ id, title, date, time, child: kid, type });
    }

    // The only DB work on the critical path: INSERT(s), capped at 6s so we answer before Vercel's 504.
    const insertAll = (async () => {
      for (const r of rowsToInsert) {
        // Idempotent: re-running the same request must not create a second identical event.
        const duplicate = await sql`
          SELECT 1 FROM schedule
          WHERE title = ${r.title}
            AND "date"::text = ${r.date}
            AND metadata->>'time' = ${r.metadata.time}
            AND metadata->>'child' = ${r.metadata.child}
          LIMIT 1
        `;
        if (duplicate.rowCount > 0) continue;
        await sql`
          INSERT INTO schedule (id, title, "date", metadata)
          VALUES (${r.id}, ${r.title}, ${r.date}, ${sqlJson(r.metadata)})
        `;
      }
    })();
    let insertTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        insertAll,
        new Promise<never>((_, reject) => {
          insertTimer = setTimeout(
            () => reject(new Error("DB insert timed out after 6s")),
            rowsToInsert.length > 8 ? 12000 : 6000,
          );
        }),
      ]);
    } catch (dbError) {
      insertAll.catch(() => undefined); // avoid unhandled rejection if it fails after the timeout
      console.error("[agent] INSERT INTO schedule failed", { child, events: saved, details: describeError(dbError) });
      const timedOut = dbError instanceof Error && /timed out/.test(dbError.message);
      return NextResponse.json(
        { success: false, error: timedOut ? "מסד הנתונים לא הגיב תוך 6 שניות, נסו שוב" : `DB insert failed: ${describeError(dbError)}` },
        { status: timedOut ? 504 : 500 },
      );
    } finally {
      if (insertTimer) clearTimeout(insertTimer);
    }

    // Learning + push run after the response is sent, so they never delay (or time out) the save.
    const learnEvents = draft.events;
    const learnSender = draft.sender_or_group;
    const kidsLabel = joinNames(kids.map((k) => childLabel(roster, k)));
    after(async () => {
      // Learning only makes sense for a single, unambiguous owner.
      if (kids.length === 1) {
        if (draft.import_kind === "fixtures") {
          await learnFixtureAssignment(draft.team ?? null, draft.league ?? null, child);
        } else {
          await learnPattern(
            learnEvents.flatMap((e) => [e.keyword, e.title]),
            learnSender,
            child,
            learnEvents.find((e) => e.type)?.type ?? null,
          );
        }
      }
      try {
        await sendPushToAll(
          {
            title: saved.length > 1 ? "משימות חדשות נוספו" : "משימה חדשה נוספה",
            body:
              saved.length > 1
                ? `נוספו ${saved.length} משימות עבור ${kidsLabel}`
                : `נוספה משימה ל${kidsLabel}: ${saved[0].title} - ${saved[0].time}`,
            url: "/",
          },
          { excludeEndpoint: senderEndpoint },
        );
      } catch (e) {
        console.error("[agent] push failed", e);
      }
    });

    // One line per distinct event (not per owner).
    const lines = saved
      .slice(0, draft.events.length)
      .map((s) => `• ${s.title} — ${s.date.split("-").reverse().join("-")} ב-${s.time}`)
      .join("\n");
    const successMessage = `נרשמו ${saved.length} אירועים עבור ${kidsLabel}${
      childFromMemory ? " (שובץ אוטומטית לפי למידה מאושרת)" : ""
    }:\n${lines}`;

    // Remember this request so any device with an empty local chat can show the recent history.
    // A request that needed follow-up answers is stored as one prompt (all user turns since the last save).
    const lastSavedAt = history.map((h) => h.role === "assistant" && h.content.startsWith("✅")).lastIndexOf(true);
    const promptParts = [
      ...history.slice(lastSavedAt + 1).filter((h) => h.role === "user").map((h) => h.content),
      text || (fileName ? `קובץ: ${fileName}` : "(צילום מסך)"),
    ];
    const recordedPrompt = promptParts.join(" · ");
    after(async () => {
      await recordAgentInteraction({ prompt: recordedPrompt, reply: `✅ ${successMessage}`, events: saved });
    });

    return NextResponse.json({
      success: true,
      message: successMessage,
      events: saved,
      draft: emptyDraft(),
    });
  } catch (error) {
    // Full detail goes to the server log (visible in Vercel); the client gets a readable, non-empty message.
    console.error("[API] POST /api/agent failed:", describeError(error), error);
    return NextResponse.json({ success: false, error: describeError(error) }, { status: 500 });
  }
}
