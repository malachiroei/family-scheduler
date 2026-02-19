import { NextResponse } from "next/server";
import { sendPushToAll } from "@/app/lib/push";

export async function POST() {
  try {
    const result = await sendPushToAll({
      title: "התראת ניסיון",
      body: "Push עובד תקין ✅",
      url: "/",
    });

    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send test push";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
