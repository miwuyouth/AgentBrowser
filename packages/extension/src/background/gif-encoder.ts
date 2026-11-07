import { GIFEncoder, applyPalette, quantize } from "gifenc";
import type { RecordedFrame } from "./recorder.ts";
import { base64ToBlob } from "./screenshot.ts";

export interface GifOptions {
  showClickIndicators?: boolean;
  showActionLabels?: boolean;
  showProgressBar?: boolean;
}

const FRAME_DELAY_MS = 800;
const LAST_FRAME_DELAY_MS = 2_000;

/** Render recorded frames with overlays into an animated GIF (runs in the service worker). */
export async function encodeGif(frames: RecordedFrame[], options: GifOptions = {}): Promise<Uint8Array> {
  const showClicks = options.showClickIndicators ?? true;
  const showLabels = options.showActionLabels ?? true;
  const showProgress = options.showProgressBar ?? true;
  const width = frames[0]!.width;
  const height = frames[0]!.height;
  const canvas = new OffscreenCanvas(width, height);
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  const gif = GIFEncoder();

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i]!;
    const bitmap = await createImageBitmap(base64ToBlob(f.data, "image/jpeg"));
    ctx.clearRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();
    const sx = width / f.width;
    const sy = height / f.height;

    if (showClicks && f.point) {
      const [x, y] = [f.point[0] * sx, f.point[1] * sy];
      ctx.strokeStyle = "#d97706";
      ctx.fillStyle = "rgba(217,119,6,0.35)";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(x, y, 14, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }
    if (showLabels && f.label) {
      const label = f.label.length > 60 ? f.label.slice(0, 57) + "…" : f.label;
      ctx.font = "600 14px system-ui, sans-serif";
      const w = ctx.measureText(label).width + 16;
      ctx.fillStyle = "rgba(0,0,0,0.7)";
      ctx.fillRect(8, height - 34, w, 26);
      ctx.fillStyle = "#fff";
      ctx.fillText(label, 16, height - 16);
    }
    if (showProgress) {
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      ctx.fillRect(0, 0, width, 4);
      ctx.fillStyle = "#d97706";
      ctx.fillRect(0, 0, (width * (i + 1)) / frames.length, 4);
    }

    const { data } = ctx.getImageData(0, 0, width, height);
    const palette = quantize(data, 256);
    const index = applyPalette(data, palette);
    gif.writeFrame(index, width, height, { palette, delay: i === frames.length - 1 ? LAST_FRAME_DELAY_MS : FRAME_DELAY_MS });
  }
  gif.finish();
  return gif.bytes();
}
