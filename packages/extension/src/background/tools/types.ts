import type { ImageMediaType, JsonSchema } from "@agent-browser/protocol";

export interface ToolContext {
  /** The validated target tab, when the tool takes a tabId. */
  tab?: chrome.tabs.Tab;
  tabId?: number;
  signal: AbortSignal;
  /** Extra lines appended to the result (dialogs handled, new tabs, ...). */
  notes: string[];
}

export interface ToolOutput {
  text: string;
  image?: { data: string; mediaType: ImageMediaType };
  /** Append the agent group's tab list. */
  withTabs?: boolean;
  /** Describes the action for GIF recording; `point` is in viewport CSS pixels. */
  recordable?: { label: string; point?: [number, number] };
}

export interface ToolSpec {
  name: string;
  schema: JsonSchema;
  /** Validate input.tabId against the agent group before running. */
  needsTab: boolean;
  run(input: any, ctx: ToolContext): Promise<ToolOutput>;
}
