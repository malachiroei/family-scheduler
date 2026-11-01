import { NextRequest, NextResponse } from "next/server";
import { sendUpcomingTaskReminders } from "@/app/lib/push";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

const CHECK_DEADLINE_MS = 20_000;

const withDeadline = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Notifications check exceeded ${ms}ms`)), ms);
  });
  promise.catch((error) => {
    console.error("[NOTIFICATIONS_CHECK] background failure", error);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

const isAuthorizedCron = (request: NextRequest) => {
  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    console.warn("[NOTIFICATIONS_CHECK] CRON_SECRET is not configured; allowing request");
    return true;
  }

  const isClientFallback = request.nextUrl.searchParams.get("client") === "1";
  if (isClientFallback) {
    const host = request.headers.get("x-forwarded-host") || request.headers.get("host") || "";
    const origin = request.headers.get("origin") || "";
    const referer = request.headers.get("referer") || "";
    const sameOriginByOrigin = host && origin === `https://${host}`;
    let sameOriginByReferer = false;
    if (host && referer) {
      try {
        const refererHost = new URL(referer).host;
        sameOriginByReferer = refererHost === host;
      } catch {
        sameOriginByReferer = false;
      }
    }

    if (sameOriginByOrigin || sameOriginByReferer) {
      return true;
    }
  }

  const authHeader = request.headers.get("authorization") || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  return token === expected;
};

const runCheck = async (request: NextRequest) => {
  try {
    if (!isAuthorizedCron(request)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const now = new Date();
    const currentIsraelTime = now.toLocaleString("en-US", { timeZone: "Asia/Jerusalem" });
    console.log(`[NOTIFICATIONS_CHECK] checking at Israel=${currentIsraelTime} (Asia/Jerusalem) | UTC=${now.toISOString()}`);

    const result = await withDeadline(
      sendUpcomingTaskReminders({
        windowForwardMinutes: 15,
        // Child tasks go to the child's device AND parents (per their watch settings); parent-owned tasks go to that parent.
        strictChildUserOnly: false,
        timeZone: "Asia/Jerusalem",
        onAttempt: ({ userName, eventTitle }) => {
          console.log(`DEBUG: Attempting to send to ${userName} for event ${eventTitle}`);
        },
      }),
      CHECK_DEADLINE_MS,
    );
    const processed = typeof result.sent === "number" ? result.sent : 0;
    console.log("Current Israel Time:", currentIsraelTime);
    console.log("[NOTIFICATIONS_CHECK] cron result", result);
    return NextResponse.json({ success: true, processed, ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to check notifications";
    console.error("[NOTIFICATIONS_CHECK] failed", error);
    return NextResponse.json({ success: false, error: message, processed: 0 }, { status: 500 });
  }
};

export async function GET(request: NextRequest) {
  return runCheck(request);
}

export async function POST(request: NextRequest) {
  return runCheck(request);
}
