import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";

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
  const result = await sql<DebugSubscriptionRow>`
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
  `;

  return NextResponse.json({
    total: result.rowCount || 0,
    subscriptions: result.rows,
  });
}
