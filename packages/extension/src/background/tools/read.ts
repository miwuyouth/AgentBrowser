import { FIND_CANDIDATES_TOOL, GET_PAGE_TEXT, READ_PAGE } from "@agent-browser/protocol";
import { callPage } from "../page.ts";
import type { ToolSpec } from "./types.ts";

export const readPageTool: ToolSpec = {
  name: READ_PAGE.name,
  schema: READ_PAGE.input_schema,
  needsTab: true,
  async run(input: { filter?: "interactive" | "all"; depth?: number; ref_id?: string; max_chars?: number }, ctx) {
    const result = await callPage(ctx.tabId!, "tree", {
      filter: input.filter ?? "all",
      depth: input.depth ?? 15,
      ...(input.ref_id ? { refId: input.ref_id } : {}),
      maxChars: input.max_chars ?? 50_000,
    });
    const tab = await chrome.tabs.get(ctx.tabId!);
    return { text: `Page: ${tab.title || "(untitled)"} — ${tab.url}\n${result.text}` };
  },
};

export const getPageTextTool: ToolSpec = {
  name: GET_PAGE_TEXT.name,
  schema: GET_PAGE_TEXT.input_schema,
  needsTab: true,
  async run(input: { max_chars?: number }, ctx) {
    const r = await callPage(ctx.tabId!, "pageText", input.max_chars ?? 50_000);
    const source = r.source === "body" ? "" : ` (from <${r.source}>)`;
    return { text: `Title: ${r.title}\nURL: ${r.url}\nText${source}:\n\n${r.text || "(no text)"}` };
  },
};

/** Internal: element candidates for the App's `find` tool. Returns JSON. */
export const findCandidatesTool: ToolSpec = {
  name: FIND_CANDIDATES_TOOL,
  schema: {
    type: "object",
    properties: { tabId: { type: "integer" }, limit: { type: "integer", minimum: 1, maximum: 5000 } },
    required: ["tabId"],
  },
  needsTab: true,
  async run(input: { limit?: number }, ctx) {
    const candidates = await callPage(ctx.tabId!, "candidates", { limit: input.limit ?? 1500 });
    return { text: JSON.stringify(candidates) };
  },
};
