import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { GENERIC_APP_ICON } from "@/app/lib/appBranding";
import { isOriginalHouseholdEnabled } from "@/app/lib/deployment";

export const size = { width: 512, height: 512 };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

export default async function Icon() {
  const fileName = isOriginalHouseholdEnabled() ? "icon-512.png" : GENERIC_APP_ICON.replace(/^\//, "");
  return readFile(join(process.cwd(), "public", fileName));
}
