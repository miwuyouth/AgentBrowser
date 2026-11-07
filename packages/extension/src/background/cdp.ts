/**
 * Chrome DevTools 协议（CDP）会话管理器。
 *
 * 核心机制：
 * 1. 懒加载附加（Lazy Attach）：只有当需要向特定标签页发送 CDP 指令时才调用 `chrome.debugger.attach`；
 * 2. 持续稳定连接：因为本浏览器专属于 Agent 自动化，无需为日常使用场景而在 5 分钟后强行断开；
 *    保持常驻连接避免了重新 attach 的性能损耗与时序竞争问题；
 * 3. 焦点仿真模拟（Focus Emulation）：开启 `Emulation.setFocusEmulationEnabled`，确保即使浏览器处于后台或失去焦点，
 *    页面上的输入框、按键事件依然能正常接收焦点；
 * 4. 弹窗自动处理：alert/confirm 等 JavaScript 弹窗会阻塞后续所有 CDP 命令，本管理器会主动捕获并自动处理，记录弹窗信息供 Agent 获悉；
 * 5. 生命周期自动管理：当标签页被关闭或浏览器退出时，自动清理会话状态。
 */

import { ToolError, errorMessage, withTimeout } from "./errors.ts";

type EventHandler = (tabId: number, method: string, params: any) => void;

/** 离开页面弹窗策略：accept 同意离开，dismiss 拒绝离开 */
export type DialogPolicy = "accept" | "dismiss";

/** JavaScript 弹窗处理记录 */
export interface DialogRecord {
  type: string;
  message: string;
  action: "accepted" | "dismissed";
}

/** 单个标签页的 CDP 会话状态 */
interface TabState {
  /** 额外开启捕获的域（如用于监听网络请求的 Network 或控制台的 Runtime） */
  capture: Set<string>;
  beforeunload: DialogPolicy;
  dialogs: DialogRecord[];
}

/**
 * 封装 chrome.debugger API 的单例管理器
 */
class DebuggerManager {
  private tabs = new Map<number, TabState>();
  private attaching = new Map<number, Promise<void>>();
  private handlers: EventHandler[] = [];

  constructor() {
    chrome.debugger.onEvent.addListener((source, method, params) => {
      if (source.tabId === undefined) return;
      if (method === "Page.javascriptDialogOpening") this.onDialog(source.tabId, params as any);
      for (const h of this.handlers) h(source.tabId, method, params);
    });
    chrome.debugger.onDetach.addListener((source) => {
      if (source.tabId !== undefined) this.forget(source.tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => this.forget(tabId));
  }

  /** 注册 CDP 事件监听器（如用于监听控制台输出或网络请求包） */
  onEvent(handler: EventHandler) {
    this.handlers.push(handler);
  }

  isAttached(tabId: number) {
    return this.tabs.has(tabId);
  }

  /** 附加调试器到指定标签页 */
  async attach(tabId: number): Promise<void> {
    if (this.tabs.has(tabId)) return;
    const pending = this.attaching.get(tabId);
    if (pending) return pending;
    const p = (async () => {
      try {
        await chrome.debugger.attach({ tabId }, "1.3");
      } catch (err) {
        const msg = errorMessage(err);
        if (!/already attached/i.test(msg)) {
          throw new ToolError("debugger_attach_failed", `Could not attach to tab ${tabId}: ${msg}`);
        }
      }
      this.tabs.set(tabId, { capture: new Set(), beforeunload: "dismiss", dialogs: [] });
      await this.raw(tabId, "Page.enable");
      // 开启焦点仿真，确保后台无焦点窗口中仍能正常输入文字
      await this.raw(tabId, "Emulation.setFocusEmulationEnabled", { enabled: true }).catch(() => {});
    })();
    this.attaching.set(tabId, p);
    try {
      await p;
    } finally {
      this.attaching.delete(tabId);
    }
  }

  /** 解除指定标签页的调试器绑定 */
  async detach(tabId: number) {
    if (!this.tabs.has(tabId)) return;
    this.forget(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }

  /** 发送 CDP 命令，按需自动提前附加 */
  async send<T = any>(tabId: number, method: string, params?: object, timeoutMs = 30_000): Promise<T> {
    await this.attach(tabId);
    return withTimeout(this.raw<T>(tabId, method, params), timeoutMs, "cdp_timeout", method);
  }

  /** 开启额外的 CDP 事件监听域（Runtime 或 Network） */
  async enableCapture(tabId: number, domain: "Runtime" | "Network") {
    await this.attach(tabId);
    const state = this.tabs.get(tabId)!;
    if (state.capture.has(domain)) return false;
    await this.raw(tabId, `${domain}.enable`);
    state.capture.add(domain);
    return true;
  }

  isCapturing(tabId: number, domain: string) {
    return this.tabs.get(tabId)?.capture.has(domain) ?? false;
  }

  setBeforeunloadPolicy(tabId: number, policy: DialogPolicy) {
    const state = this.tabs.get(tabId);
    if (state) state.beforeunload = policy;
  }

  /** 查看已触发并处理的弹窗记录（不清除） */
  peekDialogs(tabId: number): readonly DialogRecord[] {
    return this.tabs.get(tabId)?.dialogs ?? [];
  }

  /** 提取并清除已处理的弹窗记录，用于上报给模型 */
  takeDialogs(tabId: number): DialogRecord[] {
    const state = this.tabs.get(tabId);
    if (!state || state.dialogs.length === 0) return [];
    return state.dialogs.splice(0);
  }

  private raw<T>(tabId: number, method: string, params?: object): Promise<T> {
    return chrome.debugger.sendCommand({ tabId }, method, params).then(
      (r) => r as T,
      (err) => {
        throw new ToolError("cdp_error", `${method} failed: ${errorMessage(err)}`);
      },
    );
  }

  /**
   * 自动应答 JavaScript 弹窗：
   * 原生 alert/confirm 会导致整个标签页的主线程冻结，进而阻断后续一切 CDP 操作。
   * 因此必须第一时间应答：alert/confirm 自动接受，prompt 自动关闭。
   */
  private onDialog(tabId: number, params: { type: string; message: string }) {
    const state = this.tabs.get(tabId);
    const accept =
      params.type === "beforeunload" ? state?.beforeunload === "accept" : params.type === "alert" || params.type === "confirm";
    void this.raw(tabId, "Page.handleJavaScriptDialog", { accept }).catch(() => {});
    state?.dialogs.push({ type: params.type, message: params.message, action: accept ? "accepted" : "dismissed" });
  }

  private forget(tabId: number) {
    this.tabs.delete(tabId);
  }
}

export const cdp = new DebuggerManager();
