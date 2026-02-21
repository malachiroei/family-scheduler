import { NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { ensurePushTables } from "@/app/lib/push";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type SubscriptionRow = {
  endpoint: string;
  user_name: string | null;
  p256dh: string | null;
  auth: string | null;
  created_at: string | null;
  updated_at: string | null;
};

export async function GET() {
  try {
    await ensurePushTables();

    const result = await sql<SubscriptionRow>`
      SELECT
        endpoint,
        user_name,
        p256dh,
        auth,
        created_at,
        updated_at
      FROM push_subscriptions
      ORDER BY updated_at DESC
    `;

    return NextResponse.json({
      total: result.rowCount || 0,
      subscriptions: result.rows,
      table: "push_subscriptions",
      source: "app-router",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch subscriptions";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}