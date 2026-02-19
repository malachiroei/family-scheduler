import { NextRequest, NextResponse } from "next/server";
import { sendUpcomingTaskReminders } from "@/app/lib/push";

const isAuthorizedCron = (request: NextRequest) => {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    return true;
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return token === expected;
};

const runReminders = async (request: NextRequest) => {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await sendUpcomingTaskReminders();
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send reminders";
    return NextResponse.json({ error: message }, { status: 500 });
  }
};

export async function GET(request: NextRequest) {
  return runReminders(request);
}

export async function POST(request: NextRequest) {
  return runReminders(request);
}
