import { NextRequest, NextResponse } from "next/server";
import { defaultAppBranding } from "@/app/lib/appBranding";
import { loadAppBranding, saveAppBranding } from "@/app/lib/familyRosterStore";

export const dynamic = "force-dynamic";
export const revalidate = 0;

export async function GET() {
  try {
    const branding = await loadAppBranding();
    return NextResponse.json({ ok: true, branding });
  } catch (error) {
    console.error("[api/branding] GET failed", error);
    return NextResponse.json({ ok: true, branding: defaultAppBranding() });
  }
}

export async function PUT(request: NextRequest) {
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    const branding = await saveAppBranding({
      app_title: body.app_title ?? body.title,
      app_icon: body.app_icon ?? body.icon,
    });
    return NextResponse.json({ ok: true, branding });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to save branding";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
