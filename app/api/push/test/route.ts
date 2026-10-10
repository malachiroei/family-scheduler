import { NextRequest, NextResponse } from "next/server";
import { sendPushToAll, sendPushToEndpoint } from "@/app/lib/push";

/**
 * Test push. With `{ endpoint }` in the body it is delivered only to that (the current) device;
 * without it, it goes to every subscriber (legacy behavior).
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
      const result = await sendPushToEndpoint(endpoint, payload);
      if (!result.ok) {
        console.error("[push/test] send failed", result);
        return NextResponse.json(
          { error: `השליחה למכשיר נכשלה (${result.reason || "unknown"}). נסו להפעיל התראות מחדש.` },
          { status: 502 },
        );
      }
      return NextResponse.json({ ok: true, sent: 1 });
    }

    const result = await sendPushToAll(payload);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send test push";
    console.error("[push/test] failed", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
