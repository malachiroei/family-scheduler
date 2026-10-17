import { NextResponse, type NextRequest } from "next/server";
import { isOriginalHouseholdEnabled } from "@/app/lib/deployment";

const GENERIC_ICON = "/generic-family-icon.png";

const MALACHI_ICON_PATHS = new Set([
  "/favicon.ico",
  "/favicon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
]);

const noStore = (response: NextResponse) => {
  response.headers.set("Cache-Control", "public, max-age=0, must-revalidate");
  return response;
};

export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;
  const host = request.headers.get("host") ?? "";

  if (pathname === "/manifest.json") {
    const url = request.nextUrl.clone();
    url.pathname = "/api/site-manifest";
    url.search = "";
    return noStore(NextResponse.rewrite(url));
  }

  if (isOriginalHouseholdEnabled(host)) {
    return NextResponse.next();
  }

  if (MALACHI_ICON_PATHS.has(pathname)) {
    const url = request.nextUrl.clone();
    url.pathname = GENERIC_ICON;
    url.search = "";
    return noStore(NextResponse.rewrite(url));
  }

  return NextResponse.next();
}

export const config = {
  matcher: [
    "/favicon.ico",
    "/favicon.png",
    "/favicon-16x16.png",
    "/favicon-32x32.png",
    "/apple-touch-icon.png",
    "/icon-192.png",
    "/icon-512.png",
    "/manifest.json",
  ],
};
