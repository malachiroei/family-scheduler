import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { sendPushToParents } from "@/app/lib/push";

const childLabelMap: Record<string, string> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  "רביד": "רביד",
  "עמית": "עמית",
  "אלין": "אלין",
};

const ensureFamilyScheduleTable = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS family_schedule (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      day TEXT NOT NULL,
      time TEXT NOT NULL,
      type TEXT NOT NULL,
      child TEXT NOT NULL,
      is_weekly BOOLEAN NOT NULL DEFAULT FALSE
    )
  `;
  await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS completed BOOLEAN NOT NULL DEFAULT FALSE`;
  await sql`ALTER TABLE family_schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`;
};

export async function POST(request: NextRequest) {
  try {
    await ensureFamilyScheduleTable();

    const body = await request.json().catch(() => ({}));
    const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
    const childNameRaw = typeof body?.childName === "string" ? body.childName.trim() : "";

    if (!eventId) {
      return NextResponse.json({ error: "eventId is required" }, { status: 400 });
    }

    const updated = await sql`
      UPDATE family_schedule
      SET completed = TRUE,
          updated_at = NOW()
      WHERE id = ${eventId}
      RETURNING id, COALESCE(title, text) AS title, child, completed
    `;

    const row = updated.rows[0];
    if (!row) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const childFromDb = String(row.child || "").trim();
    const childName = childNameRaw || childLabelMap[childFromDb.toLowerCase()] || childLabelMap[childFromDb] || "הילד";
    const taskTitle = String(row.title || "משימה").trim() || "משימה";

    await sendPushToParents({
      title: "אישור משימה",
      body: `${childName} אישר את המשימה: ${taskTitle}`,
      url: "/",
    }, ["רועי"]);

    return NextResponse.json({
      ok: true,
      eventId,
      childName,
      title: taskTitle,
      completed: true,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to confirm task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
