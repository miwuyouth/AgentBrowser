import type { ScreenshotOptions } from "@agent-browser/protocol";
import type { Viewport } from "../content/api.ts";
import { cdp } from "./cdp.ts";
import { ToolError } from "./errors.ts";
import { callPage, sendToPage } from "./page.ts";

/**
 * Coordinate model
 * ----------------
 * A full-scale screenshot is the viewport scaled into a "frame" that fits the
 * size limits below. The model reads and writes coordinates in that frame.
 * For each tab we remember the frame of the last full-scale capture, so a
 * click maps back to viewport CSS pixels even if a later screenshot was taken
 * at a smaller `scale`.
 */
export interface FrameContext {
  viewportWidth: number;
  viewportHeight: number;
  frameWidth: number;
  frameHeight: number;
}

const settings: Required<ScreenshotOptions> = {
  maxLongEdge: 1920,
  maxPixels: 1920 * 1080,
  jpegQuality: 0.8,
};

export function configureScreenshots(options: ScreenshotOptions | undefined) {
  if (!options) return;
  if (options.maxLongEdge) settings.maxLongEdge = options.maxLongEdge;
  if (options.maxPixels) settings.maxPixels = options.maxPixels;
  if (options.jpegQuality) settings.jpegQuality = options.jpegQuality;
}

const contexts = new Map<number, FrameContext>();
chrome.tabs.onRemoved.addListener((tabId) => contexts.delete(tabId));

function fitFrame(width: number, height: number, maxLongEdge = settings.maxLongEdge, maxPixels = settings.maxPixels) {
  const scale = Math.min(1, maxLongEdge / Math.max(width, height), Math.sqrt(maxPixels / (width * height)));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

async function viewportOf(tabId: number): Promise<Viewport> {
  try {
    return await callPage(tabId, "viewport");
  } catch {
    // Pages without script access (error pages, chrome:// pages): fall back to CDP.
    const m = await cdp.send<any>(tabId, "Page.getLayoutMetrics");
    const vv = m.cssVisualViewport ?? m.cssLayoutViewport;
    return { width: vv.clientWidth, height: vv.clientHeight, devicePixelRatio: 1, scrollX: vv.pageX ?? 0, scrollY: vv.pageY ?? 0 };
  }
}

function contextFor(vp: Viewport): FrameContext {
  const frame = fitFrame(vp.width, vp.height);
  return { viewportWidth: vp.width, viewportHeight: vp.height, frameWidth: frame.width, frameHeight: frame.height };
}

/** Frame context used to interpret coordinates for this tab. */
async function frameContext(tabId: number): Promise<FrameContext> {
  const known = contexts.get(tabId);
  if (known) return known;
  const ctx = contextFor(await viewportOf(tabId));
  contexts.set(tabId, ctx);
  return ctx;
}

/** Map a frame coordinate to viewport CSS pixels, rejecting points outside the frame. */
export async function toViewport(tabId: number, point: readonly number[], what = "coordinate"): Promise<[number, number]> {
  const [x, y] = point as [number, number];
  const ctx = await frameContext(tabId);
  if (!(x >= 0 && y >= 0 && x <= ctx.frameWidth + 1 && y <= ctx.frameHeight + 1)) {
    throw new ToolError(
      "coordinate_out_of_bounds",
      `${what} (${Math.round(x)}, ${Math.round(y)}) is outside the screenshot frame ${ctx.frameWidth}x${ctx.frameHeight}. Use coordinates from a full-scale screenshot.`,
    );
  }
  return [(x * ctx.viewportWidth) / ctx.frameWidth, (y * ctx.viewportHeight) / ctx.frameHeight];
}

/** Forget the remembered frame, e.g. after the window was resized. */
export function forgetFrame(tabId: number) {
  contexts.delete(tabId);
}

/** Map viewport CSS pixels to the frame (used for GIF overlays and messages). */
export function toFrame(tabId: number, x: number, y: number): [number, number] | undefined {
  const ctx = contexts.get(tabId);
  if (!ctx) return undefined;
  return [Math.round((x * ctx.frameWidth) / ctx.viewportWidth), Math.round((y * ctx.frameHeight) / ctx.viewportHeight)];
}

export interface Capture {
  data: string;
  width: number;
  height: number;
  frame: FrameContext;
}

async function captureBitmap(tabId: number): Promise<{ bitmap: ImageBitmap; vp: Viewport }> {
  await sendToPage(tabId, { type: "agent-browser:clear-overlay" });
  try {
    const vp = await viewportOf(tabId);
    const shot = await cdp.send<{ data: string }>(
      tabId,
      "Page.captureScreenshot",
      { format: "png", fromSurface: true, captureBeyondViewport: false },
      20_000,
    );
    if (!shot?.data) throw new ToolError("screenshot_failed", "Chrome returned an empty screenshot.");
    const bitmap = await createImageBitmap(base64ToBlob(shot.data, "image/png"));
    return { bitmap, vp };
  } finally {
    void sendToPage(tabId, { type: "agent-browser:restore-overlay" });
  }
}

async function encode(
  source: ImageBitmap,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  width: number,
  height: number,
): Promise<string> {
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new ToolError("screenshot_failed", "No 2D canvas available.");
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, width, height);
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: settings.jpegQuality });
  return blobToBase64(blob);
}

/** Capture the viewport. `scale` < 1 shrinks the returned image only. */
export async function screenshot(tabId: number, scale = 1): Promise<Capture> {
  const { bitmap, vp } = await captureBitmap(tabId);
  try {
    const frame = contextFor(vp);
    contexts.set(tabId, frame);
    const width = Math.max(1, Math.round(frame.frameWidth * scale));
    const height = Math.max(1, Math.round(frame.frameHeight * scale));
    const data = await encode(bitmap, 0, 0, bitmap.width, bitmap.height, width, height);
    return { data, width, height, frame };
  } finally {
    bitmap.close();
  }
}

/** Capture a region given in frame coordinates, at up to device-pixel detail. */
export async function zoom(tabId: number, region: readonly number[], scale = 1): Promise<Capture & { region: number[] }> {
  const [x0, y0, x1, y1] = region as [number, number, number, number];
  if (!(x1 > x0 && y1 > y0)) throw new ToolError("input_invalid", "region must be [x0, y0, x1, y1] with x1 > x0 and y1 > y0");
  const [vx0, vy0] = await toViewport(tabId, [x0, y0], "region start");
  const [vx1, vy1] = await toViewport(tabId, [x1, y1], "region end");
  const { bitmap, vp } = await captureBitmap(tabId);
  try {
    const ratioX = bitmap.width / vp.width;
    const ratioY = bitmap.height / vp.height;
    const sx = Math.max(0, vx0 * ratioX);
    const sy = Math.max(0, vy0 * ratioY);
    const sw = Math.min(bitmap.width - sx, (vx1 - vx0) * ratioX);
    const sh = Math.min(bitmap.height - sy, (vy1 - vy0) * ratioY);
    const fit = fitFrame(sw, sh);
    const width = Math.max(1, Math.round(fit.width * scale));
    const height = Math.max(1, Math.round(fit.height * scale));
    const data = await encode(bitmap, sx, sy, sw, sh, width, height);
    return { data, width, height, frame: contexts.get(tabId) ?? contextFor(vp), region: [x0, y0, x1, y1] };
  } finally {
    bitmap.close();
  }
}

/** Small, cheap capture for GIF recording. */
export async function thumbnail(
  tabId: number,
  maxLongEdge = 800,
): Promise<{ data: string; width: number; height: number; viewportWidth: number; viewportHeight: number }> {
  const { bitmap, vp } = await captureBitmap(tabId);
  try {
    const fit = fitFrame(vp.width, vp.height, maxLongEdge, maxLongEdge * maxLongEdge);
    const data = await encode(bitmap, 0, 0, bitmap.width, bitmap.height, fit.width, fit.height);
    return { data, ...fit, viewportWidth: vp.width, viewportHeight: vp.height };
  } finally {
    bitmap.close();
  }
}

export function base64ToBlob(b64: string, type: string): Blob {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
