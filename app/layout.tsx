import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import Script from "next/script";
import {
  defaultAppBranding,
  defaultFaviconHref,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
  resolveShareImagePath,
  toAbsoluteAssetUrl,
} from "@/app/lib/appBranding";
import { isOriginalHouseholdEnabled, siteUrlFromHost } from "@/app/lib/deployment";
import { loadAppBranding } from "@/app/lib/familyRosterStore";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const APP_DESCRIPTION = "לוח זמנים משפחתי חכם עם סנכרון בזמן אמת";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const headerList = await headers();
  const siteUrl = siteUrlFromHost(headerList.get("x-forwarded-host") || headerList.get("host"));
  const originalHousehold = isOriginalHouseholdEnabled(headerList.get("host") || "");
  const defaultIconHref = defaultFaviconHref();
  const branding = await loadAppBranding().catch(() => defaultAppBranding());
  const appIconUrl = resolveShareImagePath(branding.app_icon);
  const brandingImageUrl = appIconUrl
    ? (appIconUrl.startsWith("http") ? appIconUrl : `${siteUrl}${appIconUrl}`)
    : `${siteUrl}/generic-family-icon.png`;
  const ogImageUrl = `${siteUrl}/opengraph-image?v=9`;
  const shareImageUrl = toAbsoluteAssetUrl(siteUrl, appIconUrl) || brandingImageUrl;

  return {
    metadataBase: new URL(siteUrl),
    title: branding.app_title,
    description: APP_DESCRIPTION,
    manifest: "/manifest.json?v=8",
    applicationName: branding.app_title,
    appleWebApp: {
      capable: true,
      statusBarStyle: "default",
      title: branding.app_title,
    },
    icons: originalHousehold
      ? {
          icon: [
            { url: "/favicon.ico", sizes: "48x48" },
            { url: "/favicon-32x32.png", sizes: "32x32", type: "image/png" },
            { url: "/icon-192.png", sizes: "192x192", type: "image/png" },
            { url: "/icon-512.png", sizes: "512x512", type: "image/png" },
          ],
          shortcut: "/favicon.ico",
          apple: "/apple-touch-icon.png",
        }
      : {
          icon: [
            { url: "/favicon.ico?v=8", sizes: "any" },
            { url: `${defaultIconHref}?v=8`, type: "image/png" },
          ],
          shortcut: `${defaultIconHref}?v=8`,
          apple: `${defaultIconHref}?v=8`,
        },
    openGraph: {
      type: "website",
      url: siteUrl,
      siteName: branding.app_title,
      locale: "he_IL",
      title: branding.app_title,
      description: APP_DESCRIPTION,
      images: [
        {
          url: ogImageUrl,
          secureUrl: ogImageUrl,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          type: "image/png",
          alt: branding.app_title,
        },
        {
          url: shareImageUrl,
          secureUrl: shareImageUrl,
          width: OG_IMAGE_WIDTH,
          height: OG_IMAGE_HEIGHT,
          type: "image/png",
          alt: branding.app_title,
        },
      ],
    },
    twitter: {
      card: "summary_large_image",
      title: branding.app_title,
      description: APP_DESCRIPTION,
      images: [ogImageUrl, shareImageUrl],
    },
  };
}

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const headerList = await headers();
  const originalHousehold = isOriginalHouseholdEnabled(headerList.get("host") || "");
  const defaultIconHref = defaultFaviconHref();

  return (
    <html lang="he" dir="rtl">
      <head>
        <meta name="apple-mobile-web-app-capable" content="yes" />
        {originalHousehold ? (
          <>
            <link rel="icon" href="/favicon.ico" sizes="any" />
            <link rel="icon" type="image/png" sizes="32x32" href="/favicon-32x32.png" />
            <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
          </>
        ) : (
          <>
            <link rel="icon" href="/favicon.ico?v=8" sizes="any" />
            <link rel="icon" type="image/png" href={`${defaultIconHref}?v=8`} />
            <link rel="apple-touch-icon" href={`${defaultIconHref}?v=8`} />
          </>
        )}
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased min-h-screen`}
      >
        <Script id="pwa-install-capture" strategy="beforeInteractive">
          {`window.addEventListener("beforeinstallprompt",function(e){e.preventDefault();window.__pwaInstallPrompt=e;});`}
        </Script>
        {children}
      </body>
    </html>
  );
}
