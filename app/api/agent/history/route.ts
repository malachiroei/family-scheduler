import { NextRequest, NextResponse } from "next/server";
import { appendChatMessages, clearChatMessages, loadAgentHistory } from "@/app/lib/agentHistoryStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

const NO_STORE = { "Cache-Control": "no-store, max-age=0" };

/** The shared conversation (same on every device). Falls back to rebuilt/example history on first use. */
export async function GET() {
  try {
    const history = await loadAgentHistory();
    return NextResponse.json({ ok: true, ...history }, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/agent/history] GET failed", error);
    return NextResponse.json({ ok: false, origin: "example", messages: [] }, { headers: NO_STORE });
  }
}

/** Appends messages from a device to the shared conversation: body `{ append: Msg[] }`. */
export async function POST(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as { append?: unknown };
    const incoming = Array.isArray(body.append) ? body.append.slice(0, 60) : [];
    const messages = await appendChatMessages(incoming);
    return NextResponse.json({ ok: true, origin: "chat", messages }, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/agent/history] POST failed", error);
    return NextResponse.json({ ok: false, error: "שמירת ההיסטוריה נכשלה" }, { status: 500, headers: NO_STORE });
  }
}

/** Clears the shared conversation on every device. */
export async function DELETE() {
  try {
    await clearChatMessages();
    return NextResponse.json({ ok: true, origin: "empty", messages: [] }, { headers: NO_STORE });
  } catch (error) {
    console.error("[api/agent/history] DELETE failed", error);
    return NextResponse.json({ ok: false, error: "ניקוי ההיסטוריה נכשל" }, { status: 500, headers: NO_STORE });
  }
}
