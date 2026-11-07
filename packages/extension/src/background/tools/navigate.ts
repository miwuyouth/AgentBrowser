/**
 * 页面导航工具（`navigate` 工具）。
 *
 * 核心机制：
 * 1. URL 规范化（`normalizeUrl`）：自动为裸域名（如 example.com）补全 `https://` 协议头；
 * 2. 前进与后退支持：支持传入 "back" 或 "forward" 浏览历史步进；
 * 3. 页面离开拦截检测（`beforeunload`）：若页面因未保存内容弹出“离开此网站？”弹窗，
 *    在 `force: false` 时安全放弃跳转并向 Agent 报错提示；在 `force: true` 时自动选择确认离开；
 * 4. 导航生命周期等待（`waitForNavigation`）：监听 `chrome.webNavigation` 各阶段事件
 *    （onCommitted、onDOMContentLoaded、SPA 单页同文档哈希/HistoryState 更新），确保页面 DOM 就绪后再返回结果。
 */

import { NAVIGATE } from "@agent-browser/protocol";
import { cdp } from "../cdp.ts";
import { ToolError, errorMessage, sleep } from "../errors.ts";
import type { ToolSpec } from "./types.ts";

/** 导航结果状态分类 */
type Outcome = { kind: "loaded" | "committed" | "same-document" | "timeout" | "blocked" } | { kind: "failed"; error: string };

/**
 * 等待主框架导航提交并完成 DOM 解析：
 * 兼容经典页面跳转、SPA 前端路由更新与 beforeunload 弹窗拦截。
 */
function waitForNavigation(tabId: number, start: () => Promise<void>, timeoutMs = 15_000): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    let committed = false;
    let done = false;
    const dialogsBefore = cdp.peekDialogs(tabId).length;
    const finish = (o: Outcome) => {
      if (done) return;
      done = true;
      cleanup();
      resolve(o);
    };
    const isMain = (d: { tabId: number; frameId: number }) => d.tabId === tabId && d.frameId === 0;
    const onCommitted = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (isMain(d)) committed = true;
    };
    const onDom = (d: chrome.webNavigation.WebNavigationFramedCallbackDetails) => {
      if (isMain(d)) finish({ kind: "loaded" });
    };
    const onSameDoc = (d: chrome.webNavigation.WebNavigationTransitionCallbackDetails) => {
      if (isMain(d)) finish({ kind: "same-document" });
    };
    const onError = (d: chrome.webNavigation.WebNavigationFramedErrorCallbackDetails) => {
      if (!isMain(d)) return;
      // ERR_ABORTED 通常表示被后续新跳转取代或转成了浏览器文件下载
      if (d.error.includes("ERR_ABORTED")) return;
      finish({ kind: "failed", error: d.error });
    };
    chrome.webNavigation.onCommitted.addListener(onCommitted);
    chrome.webNavigation.onDOMContentLoaded.addListener(onDom);
    chrome.webNavigation.onReferenceFragmentUpdated.addListener(onSameDoc);
    chrome.webNavigation.onHistoryStateUpdated.addListener(onSameDoc);
    chrome.webNavigation.onErrorOccurred.addListener(onError);
    const cleanup = () => {
      clearInterval(poll);
      chrome.webNavigation.onCommitted.removeListener(onCommitted);
      chrome.webNavigation.onDOMContentLoaded.removeListener(onDom);
      chrome.webNavigation.onReferenceFragmentUpdated.removeListener(onSameDoc);
      chrome.webNavigation.onHistoryStateUpdated.removeListener(onSameDoc);
      chrome.webNavigation.onErrorOccurred.removeListener(onError);
    };
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      const blocked = cdp
        .peekDialogs(tabId)
        .slice(dialogsBefore)
        .some((d) => d.type === "beforeunload" && d.action === "dismissed");
      if (blocked && !committed) finish({ kind: "blocked" });
      else if (Date.now() > deadline) finish({ kind: committed ? "committed" : "timeout" });
    }, 100);
    start().catch((err) => {
      if (done) return;
      done = true;
      cleanup();
      reject(err);
    });
  });
}

/** 规范化 URL 字符串 */
function normalizeUrl(raw: string): string {
  const url = raw.trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(url) && !/^[^/]+:\d+(\/|$)/.test(url) ? url : `https://${url}`;
  try {
    return new URL(withScheme).href;
  } catch {
    throw new ToolError("input_invalid", `Invalid URL: ${raw}`);
  }
}

export const navigateTool: ToolSpec = {
  name: NAVIGATE.name,
  schema: NAVIGATE.input_schema,
  needsTab: true,
  async run(input: { url: string; force?: boolean }, ctx) {
    const tabId = ctx.tabId!;
    // 预先附加 CDP 以便能够自动捕获并回答 "Leave site?" 离开提示弹窗
    try {
      await cdp.attach(tabId);
      cdp.setBeforeunloadPolicy(tabId, input.force ? "accept" : "dismiss");
    } catch {}

    const dir = input.url.trim().toLowerCase();
    let start: () => Promise<void>;
    if (dir === "back") start = () => chrome.tabs.goBack(tabId);
    else if (dir === "forward") start = () => chrome.tabs.goForward(tabId);
    else {
      const url = normalizeUrl(input.url);
      start = async () => {
        await chrome.tabs.update(tabId, { url });
      };
    }

    let outcome: Outcome;
    try {
      outcome = await waitForNavigation(tabId, start);
    } catch (err) {
      const msg = errorMessage(err);
      if (dir === "back" || dir === "forward") throw new ToolError("navigate_no_history", `Cannot go ${dir}: ${msg}`);
      throw new ToolError("navigate_failed", msg);
    } finally {
      cdp.setBeforeunloadPolicy(tabId, "dismiss");
    }

    if (outcome.kind === "blocked") {
      throw new ToolError(
        "navigate_beforeunload_blocked",
        'The page has unsaved changes and asked "Leave site?". Navigation was cancelled and the page is unchanged. Deal with the unsaved state first, or retry with force: true to discard it.',
      );
    }
    await sleep(150);
    const tab = await chrome.tabs.get(tabId);
    const url = tab.pendingUrl || tab.url || "";
    if (outcome.kind === "failed") {
      throw new ToolError("navigate_failed", `Navigation to ${url} failed: ${outcome.error}`);
    }
    const lines = [`Navigated ${dir === "back" || dir === "forward" ? dir + " " : ""}to ${url}`, `Title: ${tab.title || "(none)"}`];
    if (outcome.kind === "timeout") lines.push("The navigation has not committed yet; the page may still be loading.");
    if (outcome.kind === "committed") lines.push("The page is still loading; take a screenshot to check its state.");
    return { text: lines.join("\n"), withTabs: true, recordable: { label: `navigate ${url}` } };
  },
};
