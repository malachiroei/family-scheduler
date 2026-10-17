import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";
import {
  appIconSrc,
  defaultAppBranding,
  fallbackShareIconPath,
  GENERIC_APP_ICON,
  isImageAppIcon,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_WIDTH,
} from "@/app/lib/appBranding";
import { loadAppBranding } from "@/app/lib/familyRosterStore";

export const runtime = "nodejs";
export const alt = "Family Scheduler";
export const size = { width: OG_IMAGE_WIDTH, height: OG_IMAGE_HEIGHT };
export const contentType = "image/png";
export const dynamic = "force-dynamic";

const toDataUri = async (src: string): Promise<string | null> => {
  if (src.startsWith("data:image/")) {
    return src;
  }
  if (/^https?:\/\//i.test(src)) {
    const response = await fetch(src);
    if (!response.ok) {
      return null;
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") || "image/png";
    return `data:${type};base64,${bytes.toString("base64")}`;
  }
  const fileName = src.replace(/^\//, "") || GENERIC_APP_ICON.replace(/^\//, "");
  const bytes = await readFile(join(process.cwd(), "public", fileName));
  return `data:image/png;base64,${bytes.toString("base64")}`;
};

export default async function OpenGraphImage() {
  const branding = await loadAppBranding().catch(() => defaultAppBranding());
  const icon = appIconSrc(branding.app_icon || defaultAppBranding().app_icon);
  const fallbackPath = fallbackShareIconPath();

  if (isImageAppIcon(icon) || icon.startsWith("data:image/")) {
    const dataUri = (await toDataUri(icon).catch(() => null))
      || (await toDataUri(fallbackPath).catch(() => null));
    if (dataUri) {
      return new ImageResponse(
        (
          <div
            style={{
              width: "100%",
              height: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "linear-gradient(180deg, #dbeafe 0%, #f8fafc 100%)",
            }}
          >
            <img
              src={dataUri}
              width={360}
              height={360}
              style={{ borderRadius: 72, objectFit: "contain" }}
            />
          </div>
        ),
        { ...size },
      );
    }
  }

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "linear-gradient(180deg, #dbeafe 0%, #f8fafc 100%)",
          fontSize: 180,
        }}
      >
        {icon || "📅"}
      </div>
    ),
    { ...size },
  );
}
