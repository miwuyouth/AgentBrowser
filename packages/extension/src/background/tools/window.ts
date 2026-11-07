import { RESIZE_WINDOW } from "@agent-browser/protocol";
import { sleep } from "../errors.ts";
import { forgetFrame } from "../screenshot.ts";
import type { ToolSpec } from "./types.ts";

export const resizeWindowTool: ToolSpec = {
  name: RESIZE_WINDOW.name,
  schema: RESIZE_WINDOW.input_schema,
  needsTab: true,
  async run(input: { width: number; height: number }, ctx) {
    const win = await chrome.windows.update(ctx.tab!.windowId, { state: "normal", width: input.width, height: input.height });
    forgetFrame(ctx.tabId!);
    await sleep(300);
    return {
      text: `Resized the window to ${win.width}x${win.height}. Take a new screenshot before using coordinates.`,
      recordable: { label: "resize_window" },
    };
  },
};
