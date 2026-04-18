import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/db";
import { ensureScheduleMetadataColumn, parseScheduleMetadata } from "@/app/lib/scheduleTable";
import { sendPushToAll, sendPushToParents } from "@/app/lib/push";

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
        AND COALESCE((metadata->'completed')::boolean, false) = false
      RETURNING id, title, metadata
    `;

    const row = updated.rows[0] as { id?: string; title?: string; metadata?: unknown } | undefined;
    if (!row) {
      const existing = await sql`
        SELECT id, metadata
        FROM schedule
        WHERE id = ${eventId}
        LIMIT 1
      `;

      const existingRow = existing.rows[0] as { metadata?: unknown } | undefined;
      if (!existingRow) {
        return NextResponse.json({ error: "Task not found" }, { status: 404 });
      }

      const meta = parseScheduleMetadata(existingRow.metadata);
      const childFromDb = meta.child.trim();
      const childName = childNameRaw || childLabelMap[childFromDb.toLowerCase()] || childLabelMap[childFromDb] || "הילד";
      return NextResponse.json({ ok: true, eventId, childName, completed: true, alreadyConfirmed: true });
    }

    const meta = parseScheduleMetadata(row.metadata);
    const childFromDb = meta.child.trim();
    const childName = childNameRaw || childLabelMap[childFromDb.toLowerCase()] || childLabelMap[childFromDb] || "הילד";

    const parentPayload = {
      title: "אישור משימה",
      body: `${childName} אישר את המשימה`,
      url: "/",
    };

    const parentSendResult = await sendPushToParents(parentPayload, ["רועי", "סיוון"]);

    if ((parentSendResult.sent || 0) === 0) {
      await sendPushToAll(parentPayload);
    }

    return NextResponse.json({ ok: true, eventId, childName, completed: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to acknowledge task";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
