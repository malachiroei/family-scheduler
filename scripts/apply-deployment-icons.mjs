import { copyFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const identity = [
  process.env.VERCEL_PROJECT_NAME,
  process.env.VERCEL_URL,
  process.env.VERCEL_PROJECT_PRODUCTION_URL,
  process.env.NEXT_PUBLIC_VERCEL_PROJECT_PRODUCTION_URL,
  process.env.NEXT_PUBLIC_VERCEL_URL,
]
  .filter(Boolean)
  .join(" ")
  .toLowerCase();

const isFriend = /family-scheduler-friend/.test(identity);
if (!isFriend) {
  console.log("[icons] keeping original Malachi public icons");
  process.exit(0);
}

const generic = join(root, "public", "generic-family-icon.png");
if (!existsSync(generic)) {
  console.warn("[icons] missing public/generic-family-icon.png — skipped");
  process.exit(0);
}

const targets = [
  "favicon.ico",
  "favicon.png",
  "favicon-16x16.png",
  "favicon-32x32.png",
  "apple-touch-icon.png",
  "icon-192.png",
  "icon-512.png",
  "logo.png",
];

for (const file of targets) {
  const dest = join(root, "public", file);
  copyFileSync(generic, dest);
  console.log(`[icons] friend deploy replaced public/${file}`);
}
