import { NextResponse } from "next/server";
import { loadAgentHistory } from "@/app/lib/agentHistoryStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

/** Last 10 agent interactions, used to seed the chat on devices with an empty local history. */
export async function GET() {
  try {
    const history = await loadAgentHistory();
    return NextResponse.json({ ok: true, ...history });
  } catch (error) {
    console.error("[api/agent/history] GET failed", error);
    return NextResponse.json({ ok: false, origin: "example", messages: [] });
  }
}
