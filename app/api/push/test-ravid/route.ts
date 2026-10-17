import { NextResponse } from "next/server";
import { NextRequest } from "next/server";
import { sql } from "@/app/lib/db";
import { ensurePushTables, sendPushToEndpoint } from "@/app/lib/push";
import { loadFamilyRoster } from "@/app/lib/familyRosterStore";

type EndpointRow = {
  endpoint: string;
};

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

    const roster = await loadFamilyRoster();
    const targetChildRaw = await resolveTargetChild(request);
    const member =
      roster.getMemberByAnyName(targetChildRaw) ??
      roster.children[0] ??
      null;
    if (!member || member.role !== "child") {
      return NextResponse.json(
        { error: "לא נמצא ילד ברוסטר לשליחת בדיקה" },
        { status: 400 },
      );
    }

    const lookupNames = [...new Set(
      [member.pushName, member.name, ...member.aliases].map((value) => value.trim()).filter(Boolean),
    )];

    const result = await sql<EndpointRow>`
      SELECT endpoint
      FROM push_subscriptions
      WHERE user_name = ANY(${lookupNames})
      ORDER BY updated_at DESC
      LIMIT 1
    `;

    const endpoint = result.rows[0]?.endpoint?.trim() || "";
    if (!endpoint) {
      return NextResponse.json(
        { error: `לא נמצא endpoint פעיל עבור ${member.name}. בדוק קודם את /api/debug/subscriptions` },
        { status: 404 }
      );
    }

    const sendResult = await sendPushToEndpoint(endpoint, {
      title: `בדיקת Push ל${member.name}`,
      body: `נשלחה התראת בדיקה ישירות ל-endpoint של ${member.name} ✅`,
      url: "/",
    });

    if (!sendResult.ok) {
      return NextResponse.json(
        { error: `שליחת התראת בדיקה עבור ${member.name} נכשלה`, reason: sendResult.reason || "send-failed" },
        { status: 500 }
      );
    }

    return NextResponse.json({ ok: true, sent: 1, target: member.name });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to send direct test push";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}