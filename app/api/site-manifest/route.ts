import { NextResponse } from "next/server";
import { GENERIC_APP_ICON, GENERIC_APP_TITLE, ORIGINAL_APP_TITLE } from "@/app/lib/appBranding";
import { isOriginalHouseholdEnabled } from "@/app/lib/deployment";

export const dynamic = "force-dynamic";

export function GET() {
  const original = isOriginalHouseholdEnabled();
  const name = original ? ORIGINAL_APP_TITLE : GENERIC_APP_TITLE;
  const icon = original ? "/icon-512.png" : GENERIC_APP_ICON;
  const icon192 = original ? "/icon-192.png" : GENERIC_APP_ICON;

  return NextResponse.json(
    {
      name,
      short_name: original ? "Scheduler" : "הלו״ז",
      description: "לוח זמנים משפחתי חכם עם סנכרון בזמן אמת",
      lang: "he",
      dir: "rtl",
      start_url: "/",
      scope: "/",
      display: "standalone",
      orientation: "portrait",
      background_color: "#f8fafc",
      theme_color: "#1e293b",
      icons: [
        { src: icon192, sizes: "192x192", type: "image/png", purpose: "any" },
        { src: icon, sizes: "512x512", type: "image/png", purpose: "any" },
        { src: icon, sizes: "512x512", type: "image/png", purpose: "maskable" },
      ],
    },
    {
      headers: {
        "Content-Type": "application/manifest+json; charset=utf-8",
        "Cache-Control": "public, max-age=0, must-revalidate",
      },
    },
  );
}
