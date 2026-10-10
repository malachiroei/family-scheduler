import { NextRequest, NextResponse } from "next/server";
import { sendPushToAll, sendPushToEndpoint } from "@/app/lib/push";

/**
 * Test push. With `{ endpoint }` in the body it is delivered only to that (the current) device;
 * without it, it goes to every subscriber (legacy behavior).
 * Failures return the exact reason / HTTP status reported by web-push so the UI can show it.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint.trim() : "";
    const payload = {
      title: "התראת בדיקה",
      body: "ההתראות עובדות במכשיר הזה ✅",
      url: "/",
    };

    if (endpoint) {
      console.log("[push:test] sending to:", endpoint);
      const result = await sendPushToEndpoint(endpoint, payload);
      if (!result.ok) {
        const detail = result as { reason?: string; statusCode?: number; message?: string };
        console.error("[push:test] send failed", detail);

        let error = `השליחה נכשלה (${detail.reason || "unknown"}${detail.statusCode ? `, HTTP ${detail.statusCode}` : ""})`;
        let status = 502;
        if (detail.reason === "endpoint-not-found") {
          error = "המכשיר לא רשום בשרת. לחצו על \"הפעל התראות\" ונסו שוב.";
          status = 404;
        } else if (detail.reason === "expired-subscription") {
          error = "המנוי להתראות במכשיר פג תוקף ונמחק. הפעילו התראות מחדש ונסו שוב.";
          status = 410;
        } else if (detail.reason === "missing-vapid") {
          error = "מפתחות VAPID לא מוגדרים בשרת (NEXT_PUBLIC_VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY).";
          status = 500;
        } else if (detail.message) {
          error += `: ${detail.message}`;
        }

        return NextResponse.json(
          { ok: false, error, reason: detail.reason || "send-failed", statusCode: detail.statusCode ?? 0 },
          { status },
        );
      }
      console.log("[push:test] sent OK");
      return NextResponse.json({ ok: true, sent: 1 });
    }

    const result = await sendPushToAll(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send test push";
    console.error("[push:test] failed", error);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
