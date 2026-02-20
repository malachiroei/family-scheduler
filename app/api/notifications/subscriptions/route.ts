import { NextRequest, NextResponse } from "next/server";
import { sql } from "@vercel/postgres";
import { ensurePushTables } from "@/app/lib/push";

type SubscriptionRow = {
  endpoint: string;
  user_name: string | null;
  receive_all: boolean | null;
  watch_children: string | null;
  reminder_lead_minutes: number | null;
  updated_at: string | null;
};

const isAuthorized = (request: NextRequest) => {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return true;
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return token === expected;
};

const endpointPreview = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return `${trimmed.slice(0, 40)}...`;
};

export async function GET(request: NextRequest) {
  if (!isAuthorized(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  await ensurePushTables();

  const result = await sql<SubscriptionRow>`
    SELECT endpoint, user_name, receive_all, watch_children, reminder_lead_minutes, updated_at
    FROM push_subscriptions
    ORDER BY updated_at DESC
  `;

  const items = result.rows.map((row) => ({
    userName: (row.user_name || "").trim() || "(unassigned)",
    endpointPreview: endpointPreview(String(row.endpoint || "")),
    receiveAll: Boolean(row.receive_all),
    watchChildren: String(row.watch_children || "").trim(),
    reminderLeadMinutes: Number(row.reminder_lead_minutes || 10),
    updatedAt: row.updated_at,
  }));

  const byUserName = items.reduce<Record<string, number>>((acc, item) => {
    acc[item.userName] = (acc[item.userName] || 0) + 1;
    return acc;
  }, {});

  return NextResponse.json({
    total: items.length,
    byUserName,
    items,
  });
}
