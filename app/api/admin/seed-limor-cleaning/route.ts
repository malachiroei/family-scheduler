import { NextRequest, NextResponse } from "next/server";
import { sql, sqlJson } from "@/app/lib/db";
import {
  buildMetadataFromIncoming,
  ensureScheduleExtraColumns,
  parseScheduleMetadata,
} from "@/app/lib/scheduleTable";
import { loadFamilyRoster } from "@/app/lib/familyRosterStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;
export const maxDuration = 30;

/**
 * One-off seed: creates (or updates in place) the bi-weekly recurring task "ניקיון עם לימור".
 * Same table and row format the app itself writes (public.schedule, metadata.isRecurring = true), so it appears in
 * the weekly board and in the "משימות קבועות" tab. It never deletes anything and is safe to call repeatedly.
 *
 *   curl -X POST https://<your-domain>/api/admin/seed-limor-cleaning -H "x-delete-password: <DELETE_PASSWORD>"
 *   add  -H "content-type: application/json" -d '{"dryRun":true}'  to preview without writing.
 */
const RULE_ID = "recurring-limor-cleaning";
const TITLE = "ניקיון עם לימור";
const TIME = "08:00";
const INTERVAL_WEEKS = 2;
const FIRST_OCCURRENCE = "2026-11-01"; // Sunday; 2026-10-25 is intentionally off

const upcomingOccurrences = (count: number) => {
  const out: string[] = [];
  const base = new Date(`${FIRST_OCCURRENCE}T00:00:00Z`);
  for (let i = 0; i < count; i += 1) {
    const d = new Date(base.getTime() + i * INTERVAL_WEEKS * 7 * 24 * 60 * 60 * 1000);
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
};

export async function POST(request: NextRequest) {
  const expected = process.env.DELETE_PASSWORD?.trim() || "2101";
  const provided = request.headers.get("x-delete-password")?.trim() || "";
  if (provided !== expected) {
    return NextResponse.json({ ok: false, error: "Unauthorized: missing or wrong x-delete-password header" }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as { dryRun?: unknown };
    const dryRun = body?.dryRun === true;

    const roster = await loadFamilyRoster();
    const findMember = (names: string[]) => roster.members.find((m) => names.includes(m.name.trim()));
    const roei = findMember(["רועי"]);
    const sivan = findMember(["סיון", "סיוון"]);
    if (!roei || !sivan) {
      return NextResponse.json(
        {
          ok: false,
          error: "The family roster must contain both רועי and סיון",
          rosterMembers: roster.members.map((m) => m.name),
        },
        { status: 409 },
      );
    }
    const child = `${roei.key}_${sivan.key}`;
    if (!roster.isAllowedScheduleChild(child)) {
      return NextResponse.json({ ok: false, error: `Assignee "${child}" is not accepted by the roster` }, { status: 409 });
    }

    const metadata = buildMetadataFromIncoming({
      dayIndex: 0,
      time: TIME,
      child,
      type: "other",
      isRecurring: true,
      recurringTemplateId: RULE_ID,
      recurrenceIntervalWeeks: INTERVAL_WEEKS,
      recurrenceAnchorDate: FIRST_OCCURRENCE,
      completed: false,
      sendNotification: true,
      requireConfirmation: false,
      needsAck: false,
      reminderLeadMinutes: null,
      userId: "system",
      notified: false,
      eventDate: FIRST_OCCURRENCE,
      source: "recurring-setup",
    });

    const leftovers = await sql`
      SELECT id, title, "date"::text AS date
      FROM schedule
      WHERE title ILIKE ${"%לימור%"} AND id <> ${RULE_ID}
      ORDER BY "date"
      LIMIT 50
    `;

    const summary = {
      id: RULE_ID,
      title: TITLE,
      dayIndex: 0,
      time: TIME,
      child,
      everyWeeks: INTERVAL_WEEKS,
      firstOccurrence: FIRST_OCCURRENCE,
      nextOccurrences: upcomingOccurrences(6),
      offThisSunday: "2026-10-25",
    };

    if (dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, wouldWrite: summary, otherRowsMatchingLimor: leftovers.rows });
    }

    const hasExtraColumns = await ensureScheduleExtraColumns();
    if (hasExtraColumns) {
      await sql`
        INSERT INTO schedule (id, title, "date", metadata, start_time, child_id, notified)
        VALUES (${RULE_ID}, ${TITLE}, ${FIRST_OCCURRENCE}, ${sqlJson(metadata)}, ${TIME}, ${child}, false)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          "date" = EXCLUDED."date",
          metadata = EXCLUDED.metadata,
          start_time = EXCLUDED.start_time,
          child_id = EXCLUDED.child_id,
          notified = false
      `;
    } else {
      await sql`
        INSERT INTO schedule (id, title, "date", metadata)
        VALUES (${RULE_ID}, ${TITLE}, ${FIRST_OCCURRENCE}, ${sqlJson(metadata)})
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          "date" = EXCLUDED."date",
          metadata = EXCLUDED.metadata
      `;
    }

    // Read back exactly what the app will see.
    const saved = await sql`SELECT id, title, "date"::text AS date, metadata FROM schedule WHERE id = ${RULE_ID}`;
    const row = saved.rows[0] as { id: string; title: string; date: string; metadata: unknown } | undefined;
    const readBack = row ? parseScheduleMetadata(row.metadata) : null;

    return NextResponse.json({
      ok: Boolean(row),
      written: summary,
      readBack: row
        ? {
            id: row.id,
            title: row.title,
            date: row.date,
            isRecurring: readBack?.isRecurring,
            child: readBack?.child,
            time: readBack?.time,
            recurrenceIntervalWeeks: readBack?.recurrenceIntervalWeeks,
            recurrenceAnchorDate: readBack?.recurrenceAnchorDate,
          }
        : null,
      otherRowsMatchingLimor: leftovers.rows,
    });
  } catch (error) {
    console.error("[api/admin/seed-limor-cleaning] failed", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}
