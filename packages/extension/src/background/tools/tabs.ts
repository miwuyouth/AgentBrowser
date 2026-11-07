import { TABS_CLOSE, TABS_CONTEXT, TABS_CREATE } from "@agent-browser/protocol";
import { formatTabs, tabGroup } from "../tab-group.ts";
import type { ToolSpec } from "./types.ts";

export const tabsContextTool: ToolSpec = {
  name: TABS_CONTEXT.name,
  schema: TABS_CONTEXT.input_schema,
  needsTab: false,
  async run(input: { createIfEmpty?: boolean }) {
    if (input.createIfEmpty) await tabGroup.ensureGroup();
    return { text: formatTabs(await tabGroup.tabs()) };
  },
};

export const tabsCreateTool: ToolSpec = {
  name: TABS_CREATE.name,
  schema: TABS_CREATE.input_schema,
  needsTab: false,
  async run() {
    const tab = await tabGroup.createTab();
    return { text: `Created tab ${tab.id}.`, withTabs: true };
  },
};

export const tabsCloseTool: ToolSpec = {
  name: TABS_CLOSE.name,
  schema: TABS_CLOSE.input_schema,
  needsTab: true,
  async run(_input, ctx) {
    await chrome.tabs.remove(ctx.tabId!);
    const tabs = await tabGroup.tabs();
    return { text: `Closed tab ${ctx.tabId}.\n\n${formatTabs(tabs)}` };
  },
};
