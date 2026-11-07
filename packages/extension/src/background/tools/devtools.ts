import { READ_CONSOLE, READ_NETWORK } from "@agent-browser/protocol";
import { cdp } from "../cdp.ts";
import { ToolError } from "../errors.ts";
import type { ToolSpec } from "./types.ts";

const MAX_ENTRIES = 1_000;

interface ConsoleEntry {
  level: string;
  text: string;
  source?: string;
  time: number;
}

interface NetworkEntry {
  id: string;
  method: string;
  url: string;
  type: string;
  status?: number;
  mimeType?: string;
  failed?: string;
  time: number;
}

interface TabCapture {
  host: string;
  console: ConsoleEntry[];
  network: Map<string, NetworkEntry>;
}

const captures = new Map<number, TabCapture>();
chrome.tabs.onRemoved.addListener((tabId) => captures.delete(tabId));

function captureFor(tabId: number): TabCapture {
  let c = captures.get(tabId);
  if (!c) {
    c = { host: "", console: [], network: new Map() };
    captures.set(tabId, c);
  }
  return c;
}

const SECRET_PARAM = /(token|auth|key|secret|password|passwd|session|sig|signature|code|credential)/i;

/** Hide values of credential-looking query parameters. */
function redactUrl(raw: string): string {
  try {
    const url = new URL(raw);
    let changed = false;
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_PARAM.test(name)) {
        url.searchParams.set(name, "REDACTED");
        changed = true;
      }
    }
    if (url.username || url.password) {
      url.username = url.password ? "REDACTED" : url.username;
      url.password = "";
      changed = true;
    }
    return changed ? url.href : raw;
  } catch {
    return raw;
  }
}

function remoteObjectText(arg: any): string {
  if (!arg) return "";
  if (arg.type === "string") return arg.value;
  if ("value" in arg) return typeof arg.value === "object" ? JSON.stringify(arg.value) : String(arg.value);
  if (arg.unserializableValue) return arg.unserializableValue;
  if (arg.preview?.properties) {
    const props = arg.preview.properties.map((p: any) => `${p.name}: ${p.value}`).join(", ");
    return arg.subtype === "array" ? `[${props}]` : `{${props}}`;
  }
  return arg.description ?? `[${arg.type}]`;
}

function push<T>(list: T[], item: T) {
  list.push(item);
  if (list.length > MAX_ENTRIES) list.shift();
}

cdp.onEvent((tabId, method, params) => {
  if (!captures.has(tabId) && method !== "Page.frameNavigated") return;
  switch (method) {
    case "Runtime.consoleAPICalled": {
      const frame = params.stackTrace?.callFrames?.[0];
      const level = params.type === "warning" ? "warn" : params.type;
      const entry: ConsoleEntry = { level, text: (params.args ?? []).map(remoteObjectText).join(" "), time: Date.now() };
      if (frame?.url) entry.source = `${frame.url}:${frame.lineNumber + 1}`;
      push(captureFor(tabId).console, entry);
      break;
    }
    case "Runtime.exceptionThrown": {
      const d = params.exceptionDetails ?? {};
      const entry: ConsoleEntry = { level: "exception", text: d.exception?.description ?? d.text ?? "Uncaught exception", time: Date.now() };
      if (d.url) entry.source = `${d.url}:${(d.lineNumber ?? 0) + 1}`;
      push(captureFor(tabId).console, entry);
      break;
    }
    case "Network.requestWillBeSent": {
      const c = captureFor(tabId);
      if (params.redirectResponse) {
        // Keep the redirect hop as its own entry; the new request takes over the ID.
        const prev = c.network.get(params.requestId);
        if (prev) {
          prev.status = params.redirectResponse.status;
          c.network.delete(params.requestId);
          c.network.set(`${params.requestId}:${Date.now()}`, prev);
        }
      }
      c.network.set(params.requestId, {
        id: params.requestId,
        method: params.request.method,
        url: params.request.url,
        type: params.type ?? "Other",
        time: Date.now(),
      });
      while (c.network.size > MAX_ENTRIES) c.network.delete(c.network.keys().next().value!);
      break;
    }
    case "Network.responseReceived": {
      const e = captures.get(tabId)?.network.get(params.requestId);
      if (e) {
        e.status = params.response.status;
        e.mimeType = params.response.mimeType;
      }
      break;
    }
    case "Network.loadingFailed": {
      const e = captures.get(tabId)?.network.get(params.requestId);
      if (e) e.failed = params.canceled ? "canceled" : params.errorText;
      break;
    }
    case "Page.frameNavigated": {
      if (params.frame?.parentId) return;
      const c = captures.get(tabId);
      if (!c) return;
      let host = "";
      try {
        host = new URL(params.frame.url).host;
      } catch {}
      // Keep results scoped to the current site, as the tool descriptions promise.
      if (c.host && host !== c.host) {
        c.console = [];
        c.network.clear();
      }
      c.host = host;
      break;
    }
  }
});

async function startCapture(tabId: number, domain: "Runtime" | "Network"): Promise<boolean> {
  const tab = await chrome.tabs.get(tabId);
  const c = captureFor(tabId);
  if (!c.host) {
    try {
      c.host = new URL(tab.url ?? "").host;
    } catch {}
  }
  return cdp.enableCapture(tabId, domain);
}

const time = (t: number) => new Date(t).toISOString().slice(11, 19);

export const consoleTool: ToolSpec = {
  name: READ_CONSOLE.name,
  schema: READ_CONSOLE.input_schema,
  needsTab: true,
  async run(input: { pattern?: string; onlyErrors?: boolean; clear?: boolean; limit?: number }, ctx) {
    const started = await startCapture(ctx.tabId!, "Runtime");
    let re: RegExp | undefined;
    if (input.pattern) {
      try {
        re = new RegExp(input.pattern, "i");
      } catch (err) {
        throw new ToolError("input_invalid", `Invalid pattern: ${(err as Error).message}`);
      }
    }
    const c = captureFor(ctx.tabId!);
    let entries = c.console.filter((e) => (!input.onlyErrors || ["error", "exception", "assert"].includes(e.level)) && (!re || re.test(e.text)));
    entries = entries.slice(-(input.limit ?? 100));
    if (input.clear) {
      const drop = new Set(entries);
      c.console = c.console.filter((e) => !drop.has(e));
    }
    const lines = entries.map((e) => `[${e.level}] ${time(e.time)} ${e.text}${e.source ? `  (${e.source})` : ""}`);
    const head = started
      ? "Console collection started now; messages logged before this call are not available. Reproduce the behaviour and call again."
      : `${lines.length} message(s)${c.host ? ` for ${c.host}` : ""}:`;
    return { text: lines.length ? `${head}\n${lines.join("\n")}` : started ? head : "No matching console messages." };
  },
};

export const networkTool: ToolSpec = {
  name: READ_NETWORK.name,
  schema: READ_NETWORK.input_schema,
  needsTab: true,
  async run(input: { urlPattern?: string; clear?: boolean; limit?: number }, ctx) {
    const started = await startCapture(ctx.tabId!, "Network");
    const c = captureFor(ctx.tabId!);
    let entries = [...c.network.entries()].filter(([, e]) => !input.urlPattern || redactUrl(e.url).includes(input.urlPattern));
    entries = entries.slice(-(input.limit ?? 100));
    if (input.clear) for (const [key] of entries) c.network.delete(key);
    const lines = entries.map(([, e]) => {
      const status = e.failed ? `FAILED (${e.failed})` : e.status ?? "pending";
      return `${e.method} ${redactUrl(e.url)} → ${status} [${e.type}${e.mimeType ? `, ${e.mimeType}` : ""}]`;
    });
    const head = started
      ? "Network collection started now; requests made before this call are not available. Reload or repeat the action and call again."
      : `${lines.length} request(s)${c.host ? ` for ${c.host}` : ""}:`;
    return { text: lines.length ? `${head}\n${lines.join("\n")}` : started ? head : "No matching requests." };
  },
};
