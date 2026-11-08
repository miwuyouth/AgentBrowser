/**
 * Terminal front end for the browser agent (no Electron needed).
 *
 *   pnpm build:extension
 *   pnpm cli "find the weather in Tokyo on weather.com"
 *
 * Anthropic (default): credentials from ANTHROPIC_API_KEY or an `ant auth login` profile.
 *   --model <id>  --effort <low|medium|high|xhigh|max>  --base-url <gateway>
 * OpenAI-compatible:
 *   pnpm cli --provider openai --base-url http://127.0.0.1:11434/v1 --model qwen3-vl "task"
 *   key from --api-key or OPENAI_API_KEY; --find-model <id>; --no-vision for text-only models
 * Other: --profile <browser profile name>
 * Browser: uses the Chromium installed under .agent-browser-data/kernels (install it from the desktop app),
 *   or an explicit executable via AGENT_BROWSER_CHROME=/path/to/chrome-for-testing. System browsers are not scanned.
 * During a run, Ctrl+C cancels it; at the prompt, Ctrl+C or "exit" quits.
 */
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { getProvider, initProviders, isManagedProvider, startBrowserSession } from "@agent-browser/bridge";
import { AgentSession, createProvider, type AgentEvent, type Effort, type ProviderConfig } from "../src/index.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "../../..");

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    profile: { type: "string", default: "default" },
    provider: { type: "string", default: "anthropic" },
    "base-url": { type: "string" },
    "api-key": { type: "string" },
    model: { type: "string" },
    "find-model": { type: "string" },
    effort: { type: "string" },
    "no-vision": { type: "boolean", default: false },
  },
});

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

function summarize(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const { tabId: _tab, ...rest } = input as Record<string, unknown>;
  const s = JSON.stringify(rest);
  return s.length > 160 ? s.slice(0, 157) + "..." : s;
}

function print(e: AgentEvent) {
  switch (e.type) {
    case "text_delta":
      process.stdout.write(e.text);
      break;
    case "thinking_delta":
      process.stdout.write(dim(e.text));
      break;
    case "tool_call":
      console.log(cyan(`\n→ ${e.name} ${summarize(e.input)}`));
      break;
    case "tool_result": {
      const first = e.result.content.find((b) => b.type === "text");
      const line = first?.type === "text" ? first.text.split("\n")[0]!.slice(0, 200) : "";
      const images = e.result.content.filter((b) => b.type === "image").length;
      const label = `${e.result.isError ? "✘" : "✔"} ${line}${images ? ` [${images} image]` : ""} (${e.durationMs} ms)`;
      console.log(e.result.isError ? red(label) : dim(label));
      break;
    }
    case "done":
      if (e.reason !== "end_turn") console.log(red(`\n[stopped: ${e.reason}${e.message ? ` — ${e.message}` : ""}]`));
      else console.log();
      break;
  }
}

function providerConfig(): ProviderConfig {
  const common = {
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
    ...(values["find-model"] ? { findModel: values["find-model"] } : {}),
  };
  if (values.provider === "openai" || values.provider === "openai-compatible") {
    if (!values.model) throw new Error("--model is required with --provider openai");
    return { kind: "openai-compatible", model: values.model, vision: !values["no-vision"], ...common };
  }
  if (values.provider !== "anthropic") throw new Error(`Unknown provider "${values.provider}" (use anthropic or openai)`);
  return {
    kind: "anthropic",
    ...common,
    ...(values.model ? { model: values.model } : {}),
    ...(values.effort ? { effort: values.effort as Effort } : {}),
  };
}

async function main() {
  const config = providerConfig(); // fail on bad flags before launching the browser
  initProviders({ kernelsDir: path.join(root, ".agent-browser-data/kernels") });
  const chromium = getProvider("chromium");
  const explicit = process.env.AGENT_BROWSER_CHROME;
  const kernel = explicit
    ? { id: "chromium", name: "Chromium", path: explicit }
    : isManagedProvider(chromium)
      ? chromium.installed()
      : undefined;
  if (!kernel) {
    throw new Error("未找到 Chromium 内核：请先在桌面应用的「浏览器内核」页下载，或设置 AGENT_BROWSER_CHROME 指向可执行文件。");
  }
  const session = await startBrowserSession({
    extensionDir: path.join(root, "packages/extension/dist"),
    dataDir: path.join(root, ".agent-browser-data"),
    profile: values.profile!,
    kernel,
  });
  console.log(dim(`browser connected (${session.browser.label}); profile "${values.profile}"`));
  session.bridge.on("log", (level: string, msg: string) => level !== "info" && console.log(dim(`[extension ${level}] ${msg}`)));

  const agent = new AgentSession({ bridge: session.bridge, provider: createProvider(config) });
  console.log(dim(`model: ${agent.provider.kind} · ${agent.provider.model}`));
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let current: AbortController | null = null;
  rl.on("SIGINT", () => {
    if (current) {
      current.abort();
      return;
    }
    void shutdown();
  });
  const shutdown = async () => {
    rl.close();
    await session.close();
    process.exit(0);
  };

  let task = positionals.join(" ").trim();
  for (;;) {
    if (!task) {
      task = (await rl.question("\nyou> ")).trim();
      if (!task) continue;
      if (task === "exit" || task === "quit") return shutdown();
    }
    current = new AbortController();
    try {
      await agent.send(task, print, current.signal);
    } catch (err) {
      console.error(red(String(err)));
    }
    current = null;
    task = "";
  }
}

main().catch((err) => {
  console.error(red(err instanceof Error ? err.message : String(err)));
  process.exit(1);
});
