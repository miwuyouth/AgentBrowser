import type { PageApi } from "../content/api.ts";
import { ToolError, errorMessage } from "./errors.ts";

/**
 * Call a function of the content script's page API (`globalThis.__agentBrowser`)
 * in the extension's isolated world. Injects the content script first when the
 * page was loaded before the extension (or is about:blank).
 */
export async function callPage<K extends keyof PageApi>(
  tabId: number,
  method: K,
  ...args: Parameters<PageApi[K]>
): Promise<Awaited<ReturnType<PageApi[K]>>> {
  const run = async () => {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: (m: string, a: unknown[]) => {
        const api = (globalThis as any).__agentBrowser;
        if (!api) return { missing: true };
        // Run inside the promise chain so synchronous throws are reported too.
        return Promise.resolve()
          .then(() => api[m](...a))
          .then(
          (value: unknown) => ({ value }),
          (e: unknown) => ({ error: e instanceof Error ? e.message : String(e), code: (e as any)?.code }),
        );
      },
      args: [method, args],
    });
    return res?.result as { missing?: boolean; value?: unknown; error?: string; code?: string } | undefined;
  };

  let res;
  try {
    res = await run();
    if (res?.missing) {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      res = await run();
    }
  } catch (err) {
    throw new ToolError("page_unavailable", `Cannot access this page: ${errorMessage(err)}`);
  }
  if (!res || res.missing) throw new ToolError("page_unavailable", "The page script is not available in this tab.");
  if (res.error) throw new ToolError(res.code ?? "page_error", res.error);
  return res.value as Awaited<ReturnType<PageApi[K]>>;
}

/** Fire-and-forget visual feedback; never fails the tool. */
export async function sendToPage(tabId: number, message: object): Promise<void> {
  await chrome.tabs.sendMessage(tabId, message).catch(() => {});
}
