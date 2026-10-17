import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { defaultAppBranding, defaultFaviconHref } from "@/app/lib/appBranding";
import { appMetadataBase, isOriginalHouseholdEnabled } from "@/app/lib/deployment";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

const defaultBranding = defaultAppBranding();
const originalHousehold = isOriginalHouseholdEnabled();
const defaultIconHref = defaultFaviconHref();

export const metadata: Metadata = {
  metadataBase: appMetadataBase(),
  title: defaultBranding.app_title,
  description: "לוח זמנים משפחתי חכם עם סנכרון בזמן אמת",
  manifest: "/manifest.json?v=8",
  applicationName: defaultBranding.app_title,
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: defaultBranding.app_title,
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
    title: defaultBranding.app_title,
    description: "לוח זמנים משפחתי חכם עם סנכרון בזמן אמת",
    images: [{ url: originalHousehold ? "/icon-512.png" : defaultIconHref, width: 512, height: 512 }],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
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
        {children}
      </body>
    </html>
  );
}
