import { GIF_CREATOR } from "@agent-browser/protocol";
import { ToolError } from "../errors.ts";
import { encodeGif, type GifOptions } from "../gif-encoder.ts";
import { callPage } from "../page.ts";
import { recorder } from "../recorder.ts";
import { toViewport } from "../screenshot.ts";
import type { ToolSpec } from "./types.ts";

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

interface GifInput {
  action: "start_recording" | "stop_recording" | "export" | "clear";
  download?: boolean;
  coordinate?: [number, number];
  filename?: string;
  options?: GifOptions;
}

export const gifTool: ToolSpec = {
  name: GIF_CREATOR.name,
  schema: GIF_CREATOR.input_schema,
  needsTab: true,
  async run(input: GifInput, ctx) {
    const tabId = ctx.tabId!;
    switch (input.action) {
      case "start_recording":
        recorder.start();
        await recorder.capture(tabId, { label: "start" }).catch(() => {});
        return { text: "Recording started. A frame is captured after each action; call stop_recording, then export." };
      case "stop_recording":
        recorder.stop();
        return { text: `Recording stopped with ${recorder.frameCount} frame(s) kept.` };
      case "clear":
        recorder.clear();
        return { text: "Recording cleared." };
      case "export": {
        const frames = recorder.snapshot();
        if (frames.length === 0) throw new ToolError("gif_no_frames", "There are no recorded frames. Use start_recording first.");
        if (!input.download && !input.coordinate) throw new ToolError("input_invalid", "export needs download: true or a coordinate to drop the GIF onto.");
        const bytes = await encodeGif(frames, input.options);
        const data = toBase64(bytes);
        const filename = (input.filename || `recording-${new Date().toISOString().replace(/[:.]/g, "-")}.gif`).replace(/[\\/]/g, "_");
        const size = `${Math.round(bytes.length / 1024)} KB`;
        if (input.download) {
          await chrome.downloads.download({ url: `data:image/gif;base64,${data}`, filename, saveAs: false, conflictAction: "uniquify" });
          return { text: `Exported ${frames.length} frames (${size}) and saved ${filename} to the Downloads folder.` };
        }
        const [x, y] = await toViewport(tabId, input.coordinate!);
        const message = await callPage(tabId, "dropFiles", x, y, [{ name: filename, data, mimeType: "image/gif" }]);
        return { text: `Exported ${frames.length} frames (${size}). ${message}` };
      }
    }
  },
};
