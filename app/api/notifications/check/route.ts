import { NextRequest, NextResponse } from "next/server";
import { sendUpcomingTaskReminders } from "@/app/lib/push";

const isAuthorizedCron = (request: NextRequest) => {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    console.warn("[NOTIFICATIONS_CHECK] CRON_SECRET is not configured; allowing request");
    return true;
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return token === expected;
};

const runCheck = async (request: NextRequest) => {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const currentTimeInIsrael = new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Jerusalem",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    }).format(new Date());

    const result = await sendUpcomingTaskReminders({
      timeZone: "Asia/Jerusalem",
      toleranceMinutes: 2,
    });
    console.log("[NOTIFICATIONS_CHECK] currentTimeInIsrael", currentTimeInIsrael);
    console.log("[NOTIFICATIONS_CHECK] cron result", result);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check notifications";
    return NextResponse.json({ error: message }, { status: 500 });
  }
};

export async function GET(request: NextRequest) {
  return runCheck(request);
}

export async function POST(request: NextRequest) {
  return runCheck(request);
}
