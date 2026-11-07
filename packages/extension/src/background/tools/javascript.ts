import { JAVASCRIPT } from "@agent-browser/protocol";
import { cdp } from "../cdp.ts";
import { ToolError } from "../errors.ts";
import type { ToolSpec } from "./types.ts";

const MAX_OUTPUT = 50_000;
const EVAL_TIMEOUT_MS = 30_000;

function render(result: any): string {
  if (!result) return "undefined";
  if (result.type === "undefined") return "undefined";
  if ("value" in result) {
    if (typeof result.value === "string") return result.value;
    try {
      return JSON.stringify(result.value, null, 2) ?? String(result.value);
    } catch {
      return String(result.value);
    }
  }
  if (result.unserializableValue) return String(result.unserializableValue);
  return result.description ?? `[${result.type}]`;
}

export const javascriptTool: ToolSpec = {
  name: JAVASCRIPT.name,
  schema: JAVASCRIPT.input_schema,
  needsTab: true,
  async run(input: { text: string }, ctx) {
    // replMode gives top-level await and returns the last expression's value.
    // The block keeps let/const from leaking into later calls.
    const response = await cdp.send<any>(
      ctx.tabId!,
      "Runtime.evaluate",
      {
        expression: `{${input.text}\n}`,
        replMode: true,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true,
        timeout: EVAL_TIMEOUT_MS,
      },
      EVAL_TIMEOUT_MS + 5_000,
    );
    if (response.exceptionDetails) {
      const d = response.exceptionDetails;
      const message = d.exception?.description ?? d.text ?? "Uncaught exception";
      throw new ToolError("js_exception", `JavaScript error: ${message}`);
    }
    let out = render(response.result);
    if (out.length > MAX_OUTPUT) out = out.slice(0, MAX_OUTPUT) + `\n[truncated: ${out.length} characters in total]`;
    return { text: out, recordable: { label: "javascript" } };
  },
};
