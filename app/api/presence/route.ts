import { NextRequest, NextResponse } from "next/server";
import { sql } from "@/app/lib/db";
import { ensurePushTables } from "@/app/lib/push";

const allowedUsers = ["רביד", "עמית", "אלין", "סיוון", "רועי"] as const;
type AllowedUser = (typeof allowedUsers)[number];

type PresenceRow = {
  user_name: string;
  last_seen: string;
};

type SubscriptionUserRow = {
  user_name: string;
  last_subscription_at: string | null;
};

const ensurePresenceTable = async () => {
  await sql`
    CREATE TABLE IF NOT EXISTS app_presence (
      user_name TEXT PRIMARY KEY,
      last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `;
};

const normalizeAllowedUser = (value: unknown): AllowedUser | null => {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  return allowedUsers.includes(trimmed as AllowedUser)
    ? (trimmed as AllowedUser)
    : (() => {
      try {
        const decoded = Buffer.from(trimmed, "latin1").toString("utf8").trim();
        return allowedUsers.includes(decoded as AllowedUser)
          ? (decoded as AllowedUser)
          : null;
      } catch {
        return null;
      }
    })();
};

export async function GET() {
  try {
    await ensurePushTables();
    await ensurePresenceTable();

    const subscriptions = await sql<SubscriptionUserRow>`
      SELECT user_name, MAX(COALESCE(updated_at, created_at)) AS last_subscription_at
      FROM push_subscriptions
      WHERE user_name IS NOT NULL
        AND BTRIM(user_name) <> ''
      GROUP BY user_name
    `;

    const presence = await sql<PresenceRow>`
      SELECT user_name, last_seen
      FROM app_presence
    `;

    const registeredSet = new Set<AllowedUser>();
    const subscribedSet = new Set<AllowedUser>();
    const subscriptionLastSeenMap = new Map<AllowedUser, string>();
    subscriptions.rows.forEach((row) => {
      const userName = normalizeAllowedUser(row.user_name);
      if (!userName) {
        return;
      }

      registeredSet.add(userName);
      subscribedSet.add(userName);
      if (typeof row.last_subscription_at === "string" && row.last_subscription_at) {
        subscriptionLastSeenMap.set(userName, row.last_subscription_at);
      }
    });

    const presenceMap = new Map<string, string>();
    presence.rows.forEach((row) => {
      const userName = normalizeAllowedUser(row.user_name);
      if (!userName) {
        return;
      }
      registeredSet.add(userName);
      presenceMap.set(userName, row.last_seen);
    });

    const nowMs = Date.now();
    const users = allowedUsers.map((userName) => {
      const heartbeatLastSeen = presenceMap.get(userName) || null;
      const lastSeen = heartbeatLastSeen || subscriptionLastSeenMap.get(userName) || null;
      const heartbeatLastSeenMs = heartbeatLastSeen ? new Date(heartbeatLastSeen).getTime() : Number.NaN;
      const isOnline = Number.isFinite(heartbeatLastSeenMs) && (nowMs - heartbeatLastSeenMs) <= (2 * 60 * 1000);
      return {
        userName,
        registered: registeredSet.has(userName),
        hasSubscription: subscribedSet.has(userName),
        isOnline,
        lastSeen,
      };
    });

    return NextResponse.json({ users, serverNowIso: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch presence";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    await ensurePushTables();
    await ensurePresenceTable();

    const body = await request.json().catch(() => ({}));
    const userName = normalizeAllowedUser(body?.userName);
    if (!userName) {
      return NextResponse.json({ error: "userName is required" }, { status: 400 });
    }

    await sql`
      INSERT INTO app_presence (user_name, last_seen)
      VALUES (${userName}, NOW())
      ON CONFLICT (user_name)
      DO UPDATE SET last_seen = NOW()
    `;

    return NextResponse.json({ ok: true, userName, lastSeen: new Date().toISOString() });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to update presence";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
