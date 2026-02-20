import { NextRequest, NextResponse } from "next/server";
import { getPublicVapidKey, hasPushConfig, removePushSubscription, savePushSubscription } from "@/app/lib/push";

export async function GET() {
  return NextResponse.json({
    enabled: hasPushConfig(),
    publicKey: getPublicVapidKey(),
  });
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const subscription = body?.subscription;
    const userName = typeof body?.userName === "string" ? body.userName : "";
    const receiveAll = Boolean(body?.receiveAll);
    const reminderLeadMinutes = Number(body?.reminderLeadMinutes);
    const watchChildren = Array.isArray(body?.watchChildren)
      ? body.watchChildren.filter((value: unknown): value is string => typeof value === "string")
      : [];

    const saved = await savePushSubscription({
      ...(subscription && typeof subscription === "object" ? subscription : {}),
      userName,
      receiveAll,
      watchChildren,
      reminderLeadMinutes,
    });
    return NextResponse.json({ ok: true, endpoint: saved.endpoint });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to subscribe";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
    if (!endpoint.trim()) {
      return NextResponse.json({ error: "endpoint is required" }, { status: 400 });
    }

    await removePushSubscription(endpoint);
    return NextResponse.json({ ok: true });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to unsubscribe";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
