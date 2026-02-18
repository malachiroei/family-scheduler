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

const sanitizeState = (value: unknown): PersistedState => {
  if (!isObject(value)) {
    return {};
  }

  const weekStart = typeof value.weekStart === "string" ? value.weekStart : undefined;
  const recurringTemplates = Array.isArray(value.recurringTemplates) ? value.recurringTemplates : [];
  const weeksData = isObject(value.weeksData) ? value.weeksData : {};

  return {
    weekStart,
    recurringTemplates,
    weeksData,
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
