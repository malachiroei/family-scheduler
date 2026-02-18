import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

type PersistedState = {
  weekStart?: string;
  recurringTemplates?: unknown[];
  weeksData?: Record<string, unknown>;
};

const STATE_KEY = "global";

const ensureTable = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS scheduler_state (
      state_key TEXT PRIMARY KEY,
      payload JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const toDdMmYyyy = (date: Date) => {
  const dd = `${date.getDate()}`.padStart(2, "0");
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const yyyy = `${date.getFullYear()}`;
  return `${dd}-${mm}-${yyyy}`;
};

const parseDateCandidate = (value: unknown) => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  const ddMmYyyy = trimmed.match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (ddMmYyyy) {
    const parsed = new Date(`${ddMmYyyy[3]}-${ddMmYyyy[2]}-${ddMmYyyy[1]}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  const yyyyMmDd = trimmed.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (yyyyMmDd) {
    const parsed = new Date(`${yyyyMmDd[1]}-${yyyyMmDd[2]}-${yyyyMmDd[3]}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }

  return null;
};

const normalizeWeeksData = (weeksData: unknown) => {
  if (!isObject(weeksData)) {
    return {};
  }

  const normalized: Record<string, unknown> = {};
  Object.entries(weeksData).forEach(([weekKey, value]) => {
    if (!Array.isArray(value)) {
      return;
    }

    normalized[weekKey] = value.map((day) => {
      if (!isObject(day)) {
        return day;
      }

      const dayIsoDate = typeof day.isoDate === "string" ? day.isoDate : "";
      const fallbackDate = parseDateCandidate(dayIsoDate) ?? new Date();
      const events = Array.isArray(day.events) ? day.events : [];

      return {
        ...day,
        events: events
          .filter((event) => isObject(event))
          .map((event) => {
            const eventDate = parseDateCandidate(event.date) ?? fallbackDate;
            return {
              ...event,
              date: toDdMmYyyy(eventDate),
              isRecurring: Boolean((event as Record<string, unknown>).isRecurring ?? (event as Record<string, unknown>).recurringTemplateId),
            };
          }),
      };
    });
  });

  return normalized;
};

const sanitizeState = (value: unknown): PersistedState => {
  if (!isObject(value)) {
    return {};
  }

  const weekStart = typeof value.weekStart === "string" ? value.weekStart : undefined;
  const recurringTemplates = Array.isArray(value.recurringTemplates) ? value.recurringTemplates : [];
  const weeksData = normalizeWeeksData(value.weeksData);

  return {
    weekStart,
    recurringTemplates,
    weeksData,
  };
};

const removeEventFromState = (
  state: PersistedState,
  payload: { eventId?: string; recurringTemplateId?: string }
): PersistedState => {
  const eventId = typeof payload.eventId === "string" ? payload.eventId : "";
  const recurringTemplateId = typeof payload.recurringTemplateId === "string" ? payload.recurringTemplateId : "";

  if (!eventId && !recurringTemplateId) {
    return state;
  }

  const nextWeeksData: Record<string, unknown> = {};
  Object.entries(state.weeksData ?? {}).forEach(([weekKey, value]) => {
    if (!Array.isArray(value)) {
      nextWeeksData[weekKey] = value;
      return;
    }

    nextWeeksData[weekKey] = value.map((day) => {
      if (!isObject(day)) {
        return day;
      }

      const events = Array.isArray(day.events) ? day.events : [];
      return {
        ...day,
        events: events.filter((event) => {
          if (!isObject(event)) {
            return true;
          }
          const byId = eventId && event.id === eventId;
          const byTemplate = recurringTemplateId && event.recurringTemplateId === recurringTemplateId;
          return !(byId || byTemplate);
        }),
      };
    });
  });

  const nextTemplates = Array.isArray(state.recurringTemplates)
    ? state.recurringTemplates.filter((template) => {
        if (!recurringTemplateId || !isObject(template)) {
          return true;
        }
        return template.templateId !== recurringTemplateId;
      })
    : [];

  return {
    ...state,
    recurringTemplates: nextTemplates,
    weeksData: nextWeeksData,
  };
};

export async function GET() {
  try {
    await ensureTable();
    const result = await sql`
      SELECT payload
      FROM scheduler_state
      WHERE state_key = ${STATE_KEY}
      LIMIT 1
    `;

    const row = result.rows[0] as { payload?: unknown } | undefined;
    if (!row?.payload) {
      return NextResponse.json({ state: null });
    }

    return NextResponse.json({ state: sanitizeState(row.payload) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to load state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const incoming = await request.json();
    const state = sanitizeState(incoming);

    await ensureTable();
    await sql`
      INSERT INTO scheduler_state (state_key, payload, updated_at)
      VALUES (${STATE_KEY}, ${JSON.stringify(state)}::jsonb, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save state";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();

    await ensureTable();
    const result = await sql`
      SELECT payload
      FROM scheduler_state
      WHERE state_key = ${STATE_KEY}
      LIMIT 1
    `;

    const row = result.rows[0] as { payload?: unknown } | undefined;
    const currentState = sanitizeState(row?.payload ?? {});
    const nextState = removeEventFromState(currentState, {
      eventId: body?.eventId,
      recurringTemplateId: body?.recurringTemplateId,
    });

    await sql`
      INSERT INTO scheduler_state (state_key, payload, updated_at)
      VALUES (${STATE_KEY}, ${JSON.stringify(nextState)}::jsonb, NOW())
      ON CONFLICT (state_key)
      DO UPDATE SET
        payload = EXCLUDED.payload,
        updated_at = NOW()
    `;

    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to delete event";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
