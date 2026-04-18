import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/db";
import { ensureScheduleMetadataColumn, parseScheduleMetadata } from "@/app/lib/scheduleTable";
import { sendPushToParents } from "@/app/lib/push";

const childLabelMap: Record<string, string> = {
  ravid: "רביד",
  amit: "עמית",
  alin: "אלין",
  "רביד": "רביד",
  "עמית": "עמית",
  "אלין": "אלין",
};

export async function POST(request: NextRequest) {
  try {
    await ensureScheduleMetadataColumn();

    const body = await request.json().catch(() => ({}));
    const eventId = typeof body?.eventId === "string" ? body.eventId.trim() : "";
    const childNameRaw = typeof body?.childName === "string" ? body.childName.trim() : "";

    if (!eventId) {
      return NextResponse.json({ error: "eventId is required" }, { status: 400 });
    }

    const updated = await sql`
      UPDATE schedule
      SET metadata = jsonb_set(
        COALESCE(metadata, '{}'::jsonb),
        '{completed}',
        'true'::jsonb,
        true
      )
      WHERE id = ${eventId}
      RETURNING id, title, metadata
    `;

    const row = updated.rows[0] as { id?: string; title?: string; metadata?: unknown } | undefined;
    if (!row) {
      return NextResponse.json({ error: "Task not found" }, { status: 404 });
    }

    const meta = parseScheduleMetadata(row.metadata);
    const childFromDb = meta.child.trim();
    const childName = childNameRaw || childLabelMap[childFromDb.toLowerCase()] || childLabelMap[childFromDb] || "הילד";
    const taskTitle = String(row.title || "משימה").trim() || "משימה";

    await sendPushToParents({
      title: "אישור משימה",
      body: `${childName} אישר את המשימה: ${taskTitle}`,
      url: "/",
    });

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
