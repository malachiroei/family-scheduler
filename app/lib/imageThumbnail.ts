/** Lightweight chat-history thumbnails. Kept small enough for `scheduler_state` JSON. */
export const THUMBNAIL_MAX_WIDTH = 240;
export const THUMBNAIL_MAX_CHARS = 36_000;

const DATA_URL_RE = /^data:image\/(webp|jpeg|jpg|png);base64,[A-Za-z0-9+/=]+$/i;

/** Accepts a persisted `thumbnailUrl` / `imageBase64` data URL, or rejects oversized payloads. */
export const isThumbnailDataUrl = (value: unknown): value is string =>
  typeof value === "string" && value.length > 32 && value.length <= THUMBNAIL_MAX_CHARS && DATA_URL_RE.test(value);

const pickStoredThumbnail = (value: unknown): string | undefined =>
  isThumbnailDataUrl(value) ? value : undefined;

/** Reads either field name the client may send. */
export const readStoredThumbnail = (raw: Record<string, unknown>): string | undefined =>
  pickStoredThumbnail(raw.thumbnailUrl) ?? pickStoredThumbnail(raw.imageBase64);

const loadImage = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("thumbnail load failed"));
    img.src = src;
  });

const encodeCanvas = (canvas: HTMLCanvasElement, mime: "image/webp" | "image/jpeg", quality: number) => {
  try {
    return canvas.toDataURL(mime, quality);
  } catch {
    return "";
  }
};

/**
 * Compress a pasted/uploaded image to a ~10–25KB WebP/JPEG data URL (max 240px wide).
 * Returns undefined when canvas encoding is unavailable or the result is still too large.
 */
export const AGENT_IMAGE_MAX_EDGE = 1000;
export const AGENT_IMAGE_QUALITY = 0.75;

/**
 * Downscale a screenshot before POST /api/agent (max 1000×1000 JPEG @ 0.75) so OCR stays under the
 * serverless time limit. Falls back to the original data URL if canvas encoding fails.
 */
export const prepareAgentImage = async (source: string): Promise<{ dataUrl: string; mime: string }> => {
  const fallbackMime = source.match(/^data:([^;]+);/)?.[1] || "image/jpeg";
  if (typeof document === "undefined" || !source.startsWith("data:image/")) {
    return { dataUrl: source, mime: fallbackMime };
  }
  try {
    const img = await loadImage(source);
    const scale = Math.min(1, AGENT_IMAGE_MAX_EDGE / Math.max(img.width, img.height, 1));
    const width = Math.max(1, Math.round(img.width * scale));
    const height = Math.max(1, Math.round(img.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return { dataUrl: source, mime: fallbackMime };
    ctx.drawImage(img, 0, 0, width, height);
    const dataUrl = encodeCanvas(canvas, "image/jpeg", AGENT_IMAGE_QUALITY);
    if (dataUrl.startsWith("data:image/jpeg")) {
      return { dataUrl, mime: "image/jpeg" };
    }
  } catch {
    // keep the original
  }
  return { dataUrl: source, mime: fallbackMime };
};

export const createImageThumbnail = async (source: string): Promise<string | undefined> => {
  if (typeof document === "undefined" || !source.startsWith("data:image/")) return undefined;
  try {
    const img = await loadImage(source);
    const widths = [THUMBNAIL_MAX_WIDTH, 180, 140];
    const qualities = [0.62, 0.5, 0.4];
    for (const maxWidth of widths) {
      const scale = Math.min(1, maxWidth / Math.max(img.width, 1));
      const width = Math.max(1, Math.round(img.width * scale));
      const height = Math.max(1, Math.round(img.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      if (!ctx) return undefined;
      ctx.drawImage(img, 0, 0, width, height);
      for (const mime of ["image/webp", "image/jpeg"] as const) {
        for (const quality of qualities) {
          const url = encodeCanvas(canvas, mime, quality);
          if (isThumbnailDataUrl(url)) return url;
        }
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
};
