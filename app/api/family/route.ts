import { NextRequest, NextResponse } from "next/server";
import { defaultAppBranding } from "@/app/lib/appBranding";
import { fallbackRoster, type FamilyRole, type StoredFamilyMember } from "@/app/lib/familyMembers";
import { loadAppBranding, loadFamilyRoster, publicRosterPayload, saveFamilyRoster } from "@/app/lib/familyRosterStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const [roster, branding] = await Promise.all([loadFamilyRoster(), loadAppBranding()]);
    return NextResponse.json({ ok: true, ...publicRosterPayload(roster), branding });
  } catch (error) {
    console.error("[api/family] GET failed", error);
    return NextResponse.json({
      ok: true,
      ...publicRosterPayload(fallbackRoster),
      branding: defaultAppBranding(),
    });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const rawMembers = Array.isArray(body.members) ? body.members : [];
    const members: StoredFamilyMember[] = [];
    for (const item of rawMembers) {
      if (!item || typeof item !== "object") continue;
      const row = item as Record<string, unknown>;
      const name = typeof row.name === "string" ? row.name.trim() : "";
      const role: FamilyRole | null = row.role === "parent" || row.role === "child" ? row.role : null;
      if (!name || !role) continue;
      members.push({
        name,
        role,
        color: typeof row.color === "string" ? row.color : undefined,
        key: typeof row.key === "string" && row.key.trim() ? row.key.trim() : undefined,
      });
    }

    if (!members.length) {
      return NextResponse.json({ ok: false, error: "יש להזין לפחות בן משפחה אחד" }, { status: 400 });
    }

    const roster = await saveFamilyRoster(members);
    return NextResponse.json({ ok: true, ...publicRosterPayload(roster) });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save family roster";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
