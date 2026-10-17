import type { NextConfig } from "next";

const iconSources = [
  "/favicon.ico",
  "/favicon.png",
  "/favicon-16x16.png",
  "/favicon-32x32.png",
  "/apple-touch-icon.png",
  "/icon-192.png",
  "/icon-512.png",
];

const nextConfig: NextConfig = {
  async headers() {
    return iconSources.map((source) => ({
      source,
      headers: [{ key: "Cache-Control", value: "public, max-age=0, must-revalidate" }],
    }));
  },
};

export default nextConfig;
