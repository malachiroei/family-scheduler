import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { sql } from "@vercel/postgres";
import { ensurePushTables, sendPushToEndpoint } from "@/app/lib/push";

type EndpointRow = {
  endpoint: string;
};

const allowedChildNames = ["רביד", "עמית", "אלין"] as const;

const resolveTargetChild = async (request: NextRequest) => {
  const fromQuery = request.nextUrl.searchParams.get("childName") || request.nextUrl.searchParams.get("userName");
  if (typeof fromQuery === "string" && fromQuery.trim()) {
    return fromQuery.trim();
  }

  const body = await request.json().catch(() => ({}));
  const fromBody = typeof body?.childName === "string"
    ? body.childName.trim()
    : (typeof body?.userName === "string" ? body.userName.trim() : "");
  return fromBody;
};

export async function POST(request: NextRequest) {
  try {
    await ensurePushTables();

    const targetChildRaw = await resolveTargetChild(request);
    const targetChild = allowedChildNames.includes(targetChildRaw as (typeof allowedChildNames)[number])
      ? targetChildRaw
      : "רביד";

    const result = await sql<EndpointRow>`
      SELECT endpoint
      FROM push_subscriptions
      WHERE user_name = ${targetChild}
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    const endpoint = result.rows[0]?.endpoint?.trim() || "";
    if (!endpoint) {
      return NextResponse.json(
        { error: `לא נמצא endpoint פעיל עבור ${targetChild}. בדוק קודם את /api/debug/subscriptions` },
        { status: 404 }
      );
    }

    const sendResult = await sendPushToEndpoint(endpoint, {
      title: `בדיקת Push ל${targetChild}`,
      body: `נשלחה התראת בדיקה ישירות ל-endpoint של ${targetChild} ✅`,
      url: "/",
    });

    if (!sendResult.ok) {
      return NextResponse.json(
        { error: `שליחת התראת בדיקה עבור ${targetChild} נכשלה`, reason: sendResult.reason || "send-failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, sent: 1, target: targetChild });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send direct test push";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}