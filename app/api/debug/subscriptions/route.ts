import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

export const dynamic = "force-dynamic";

type DebugSubscriptionRow = {
  endpoint: string;
  user_name: string | null;
  p256dh: string | null;
  auth: string | null;
  receive_all: boolean | null;
  watch_children: string | null;
  reminder_lead_minutes: number | null;
  created_at: string | null;
  updated_at: string | null;
};

export async function GET() {
  const tableCheck = await sql<{ table_name: string }>`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('push_subscriptions', 'subscriptions')
  `;

  const existingTable = tableCheck.rows.find((row) => row.table_name === "push_subscriptions")
    ? "push_subscriptions"
    : tableCheck.rows.find((row) => row.table_name === "subscriptions")
      ? "subscriptions"
      : "";

  if (!existingTable) {
    return NextResponse.json({ total: 0, subscriptions: [], table: null });
  }

  const result = existingTable === "push_subscriptions"
    ? await sql<DebugSubscriptionRow>`
        SELECT
          endpoint,
          user_name,
          p256dh,
          auth,
          receive_all,
          watch_children,
          reminder_lead_minutes,
          created_at,
          updated_at
        FROM push_subscriptions
        ORDER BY updated_at DESC
      `
    : await sql<DebugSubscriptionRow>`
        SELECT
          endpoint,
          user_name,
          p256dh,
          auth,
          NULL::BOOLEAN AS receive_all,
          NULL::TEXT AS watch_children,
          NULL::INT AS reminder_lead_minutes,
          created_at,
          updated_at
        FROM subscriptions
        ORDER BY updated_at DESC
      `;

  return NextResponse.json({
    total: result.rowCount || 0,
    subscriptions: result.rows,
    table: existingTable,
  });
}
