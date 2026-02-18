import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Image from "next/image";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Malachi Family Time Planner",
  description: "לוח זמנים משפחתי חכם עם סנכרון בזמן אמת",
  icons: {
    icon: "/logo.png",
    shortcut: "/logo.png",
    apple: "/logo.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        <header className="app-global-logo print:hidden px-4 pt-4 md:pt-6">
          <div className="max-w-6xl mx-auto flex justify-center">
            <Image
              src="/logo.png"
              alt="MALACHI FAMILY TIME PLANNER"
              width={260}
              height={70}
              priority
              className="h-auto w-[220px] sm:w-[260px]"
            />
          </div>
        </header>
        {children}
      </body>
    </html>
  );
}
