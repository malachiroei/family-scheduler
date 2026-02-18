import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

const allowedModels = ["gemini-1.5-flash", "gemini-2.0-flash"] as const;
type SupportedModel = (typeof allowedModels)[number];
const defaultModel: SupportedModel = "gemini-1.5-flash";
const defaultFallbackModel: SupportedModel = "gemini-1.5-flash";
const modelAliasMap: Record<string, SupportedModel> = {
  "gemini-1.5-flash-latest": "gemini-1.5-flash",
  "gemini-2.0-flash-exp": "gemini-2.0-flash",
};
const allowedChildren = ["ravid", "amit", "alin"] as const;
const allowedTypes = ["dog", "gym", "sport", "lesson", "dance"] as const;

type ChildKey = (typeof allowedChildren)[number];
type EventType = (typeof allowedTypes)[number];

type AiEvent = {
  dayIndex: number;
  time: string;
  child: ChildKey;
  title: string;
  type: EventType;
  recurringWeekly?: boolean;
};

const extractJsonArray = (text: string) => {
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start === -1 || end === -1 || end <= start) {
    return "";
  }
  return text.slice(start, end + 1);
};

const ensureFamilyScheduleTable = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS family_schedule (
      event_id TEXT PRIMARY KEY,
      event_date TEXT NOT NULL,
      day_index INT NOT NULL,
      event_time TEXT NOT NULL,
      child TEXT NOT NULL,
      title TEXT NOT NULL,
      event_type TEXT NOT NULL,
      is_recurring BOOLEAN NOT NULL DEFAULT FALSE,
      recurring_template_id TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
};

const sanitizeDbEvent = (value: unknown) => {
  if (!value || typeof value !== "object") {
    return null;
  }

  const payload = value as Record<string, unknown>;
  const eventId = typeof payload.id === "string" ? payload.id.trim() : "";
  const date = typeof payload.date === "string" ? payload.date.trim() : "";
  const dayIndex = Number(payload.dayIndex);
  const time = typeof payload.time === "string" ? payload.time.trim() : "";
  const child = typeof payload.child === "string" ? payload.child : "";
  const title = typeof payload.title === "string" ? payload.title.trim() : "";
  const type = typeof payload.type === "string" ? payload.type : "";
  const isRecurring = Boolean(payload.isRecurring);
  const recurringTemplateId = typeof payload.recurringTemplateId === "string"
    ? payload.recurringTemplateId.trim()
    : null;

  if (
    !eventId ||
    !date ||
    !Number.isInteger(dayIndex) ||
    dayIndex < 0 ||
    dayIndex > 6 ||
    !time ||
    !title ||
    !allowedChildren.includes(child as ChildKey) ||
    !allowedTypes.includes(type as EventType)
  ) {
    return null;
  }

  return {
    eventId,
    date,
    dayIndex,
    time,
    child,
    title,
    type,
    isRecurring,
    recurringTemplateId,
  };
};

export async function GET() {
  try {
    console.log('[API] GET /api/schedule');
    await ensureFamilyScheduleTable();
    const result = await sql`
      SELECT
        event_id,
        event_date,
        day_index,
        event_time,
        child,
        title,
        event_type,
        is_recurring,
        recurring_template_id
      FROM family_schedule
      ORDER BY event_date ASC, event_time ASC
    `;

    const events = result.rows.map((row) => ({
      id: row.event_id,
      date: row.event_date,
      dayIndex: Number(row.day_index),
      time: row.event_time,
      child: row.child,
      title: row.title,
      type: row.event_type,
      isRecurring: Boolean(row.is_recurring),
      recurringTemplateId: row.recurring_template_id || undefined,
    }));

    return NextResponse.json({ events });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch events";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    console.log('[API] PUT /api/schedule');
    const body = await request.json();
    const incoming = sanitizeDbEvent(body?.event);
    if (!incoming) {
      return NextResponse.json({ error: "Invalid event payload" }, { status: 400 });
    }

    await ensureFamilyScheduleTable();
    await sql`
      INSERT INTO family_schedule (
        event_id,
        event_date,
        day_index,
        event_time,
        child,
        title,
        event_type,
        is_recurring,
        recurring_template_id,
        updated_at
      )
      VALUES (
        ${incoming.eventId},
        ${incoming.date},
        ${incoming.dayIndex},
        ${incoming.time},
        ${incoming.child},
        ${incoming.title},
        ${incoming.type},
        ${incoming.isRecurring},
        ${incoming.recurringTemplateId},
        NOW()
      )
      ON CONFLICT (event_id)
      DO UPDATE SET
        event_date = EXCLUDED.event_date,
        day_index = EXCLUDED.day_index,
        event_time = EXCLUDED.event_time,
        child = EXCLUDED.child,
        title = EXCLUDED.title,
        event_type = EXCLUDED.event_type,
        is_recurring = EXCLUDED.is_recurring,
        recurring_template_id = EXCLUDED.recurring_template_id,
        updated_at = NOW()
    `;

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    console.log('[API] DELETE /api/schedule');
    const body = await request.json();
    const clearAll = Boolean(body?.clearAll);
    const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
    const recurringTemplateId = typeof body?.recurringTemplateId === "string" ? body.recurringTemplateId.trim() : "";

    if (!clearAll && !eventId && !recurringTemplateId) {
      return NextResponse.json({ error: "eventId or recurringTemplateId is required" }, { status: 400 });
    }

    await ensureFamilyScheduleTable();

    if (clearAll) {
      await sql`DELETE FROM family_schedule`;
      return NextResponse.json({ ok: true });
    }

    if (recurringTemplateId) {
      await sql`
        DELETE FROM family_schedule
        WHERE recurring_template_id = ${recurringTemplateId}
           OR event_id = ${eventId}
      `;
    } else {
      await sql`
        DELETE FROM family_schedule
        WHERE event_id = ${eventId}
      `;
    }

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const sanitizeEvents = (events: unknown): AiEvent[] => {
  if (!Array.isArray(events)) {
    return [];
  }

  return events.reduce<AiEvent[]>((acc, item) => {
      if (!item || typeof item !== "object") {
        return acc;
      }

      const candidate = item as Record<string, unknown>;
      const dayIndex = Number(candidate.dayIndex);
      const time = typeof candidate.time === "string" ? candidate.time.trim() : "";
      const child = typeof candidate.child === "string" ? candidate.child : "";
      const title = typeof candidate.title === "string" ? candidate.title.trim() : "";
      const type = typeof candidate.type === "string" ? candidate.type : "";
      const recurringWeekly = typeof candidate.recurringWeekly === "boolean"
        ? candidate.recurringWeekly
        : (typeof candidate.isRecurring === "boolean" ? candidate.isRecurring : false);

      if (
        !Number.isInteger(dayIndex) ||
        dayIndex < 0 ||
        dayIndex > 6 ||
        !time ||
        !title ||
        !allowedChildren.includes(child as ChildKey) ||
        !allowedTypes.includes(type as EventType)
      ) {
        return acc;
      }

      acc.push({
        dayIndex,
        time,
        child: child as ChildKey,
        title,
        type: type as EventType,
        recurringWeekly,
      });

      return acc;
    }, []);
};

const isSupportedModel = (value: unknown): value is SupportedModel =>
  typeof value === "string" && allowedModels.includes(value as SupportedModel);

const normalizeModel = (value: unknown, fallback: SupportedModel): SupportedModel => {
  if (typeof value !== "string") {
    return fallback;
  }

  const normalized = value.trim();
  if (isSupportedModel(normalized)) {
    return normalized;
  }

  return modelAliasMap[normalized] ?? fallback;
};

export async function POST(request: NextRequest) {
  console.log('[API] POST /api/schedule');
  const apiKey = process.env.NEXT_PUBLIC_GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Missing NEXT_PUBLIC_GEMINI_API_KEY on server" },
      { status: 500 }
    );
  }

  try {
    const body = await request.json();
    const text = typeof body?.text === "string" ? body.text.trim() : "";
    const weekStart = typeof body?.weekStart === "string" ? body.weekStart.trim() : "";
    const systemPrompt = typeof body?.systemPrompt === "string" ? body.systemPrompt.trim() : "";
    const requestedModel = normalizeModel(body?.model, defaultModel);
    const fallbackModel = normalizeModel(body?.fallbackModel, defaultFallbackModel);
    const incomingInlineData = body?.imagePart?.inlineData;
    const imageBase64 = typeof incomingInlineData?.data === "string"
      ? incomingInlineData.data.trim()
      : (typeof body?.imageBase64 === "string" ? body.imageBase64.trim() : "");
    const imageMimeType = typeof incomingInlineData?.mimeType === "string"
      ? incomingInlineData.mimeType.trim()
      : (typeof body?.imageMimeType === "string" ? body.imageMimeType.trim() : "image/png");

    if (!text && !imageBase64) {
      return NextResponse.json({ error: "Text or image is required" }, { status: 400 });
    }

    const basePrompt = `אתה עוזר לו"ז משפחתי. נתח את הטקסט והחזר רק JSON תקין של מערך אירועים.
שבוע העבודה הוא:
0=יום ראשון, 1=יום שני, 2=יום שלישי, 3=יום רביעי, 4=יום חמישי, 5=יום שישי, 6=שבת
ילדים מותרים: ravid, amit, alin
סוגים מותרים: dog, gym, sport, lesson, dance
פורמט חובה לכל איבר:
{ "dayIndex": number, "time": string, "child": "ravid|amit|alin", "title": string, "type": "dog|gym|sport|lesson|dance" }

אם מתקבלת תמונה, בצע OCR וחלץ ממנה ימים/שעות/ילד.
החזר תמיד אך ורק מערך JSON, גם אם יש אירוע יחיד. ללא טקסט נוסף.
  תאריך תחילת השבוע שמוצג כרגע: ${weekStart || "לא ידוע"}
טקסט משתמש:
${text}`;

    const prompt = systemPrompt ? `${systemPrompt}\n\n${basePrompt}` : basePrompt;

    const userParts: Array<{ text?: string; inlineData?: { mimeType: string; data: string } }> = [{ text: prompt }];
    if (imageBase64) {
      userParts.push({
        inlineData: {
          mimeType: imageMimeType || "image/png",
          data: imageBase64,
        },
      });
    }

    const requestBody = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: userParts,
        },
      ],
      generationConfig: {
        temperature: 0.1,
        maxOutputTokens: 512,
      },
    });

    const callGemini = async (version: "v1beta" | "v1", model: string) =>
      fetch(
        `https://generativelanguage.googleapis.com/${version}/models/${model}:generateContent?key=${apiKey}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: requestBody,
        }
      );

    const modelChain: SupportedModel[] = requestedModel === fallbackModel
      ? [requestedModel]
      : [requestedModel, fallbackModel];

    let response: Response | null = null;

    for (const model of modelChain) {
      response = await callGemini("v1beta", model);
      if (response.status !== 404) {
        break;
      }

      response = await callGemini("v1", model);
      if (response.status !== 404) {
        break;
      }
    }

    if (!response) {
      return NextResponse.json(
        { error: "Gemini request failed: no response" },
        { status: 502 }
      );
    }

    if (!response.ok) {
      const errorText = await response.text();
      return NextResponse.json(
        { error: `Gemini request failed: ${errorText}` },
        { status: 502 }
      );
    }

    const data = await response.json();
    const textOutput: string =
      data?.candidates?.[0]?.content?.parts
        ?.map((part: { text?: string }) => part?.text || "")
        .join("") || "";

    const rawJson = extractJsonArray(textOutput);
    if (!rawJson) {
      return NextResponse.json({ events: [] });
    }

    const parsed = JSON.parse(rawJson);
    const events = sanitizeEvents(parsed);

    return NextResponse.json({ events });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
