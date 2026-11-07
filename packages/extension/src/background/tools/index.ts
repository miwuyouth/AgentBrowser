/**
 * 扩展端工具注册中心与统一分发器（Tool Dispatcher）。
 *
 * 核心机制：
 * 1. 工具注册表：将各个细分模块（computer、form、read、navigate、devtools 等）的 ToolSpec 统一维护在 `registry` Map 中；
 * 2. 入参二次校验：调用 `validateAgainstSchema` 校验入参格式；
 * 3. 标签页鉴权隔离：若标记了 `needsTab: true`，统一先经由 `tabGroup.requireTab` 校验标签页是否属于 Agent 专用分组；
 * 4. 自动化上下文装饰：
 *    - 弹窗自动处理附注（`formatDialogs`）：将页面刚弹出的 alert/confirm 处理结果作为提示追加到输出中；
 *    - GIF 动图录制帧捕获（`recorder.capture`）：若处于录制状态，在动作执行后自动抓帧；
 *    - 标签页上下文同步（`withTabs`）：必要时把当前组内所有活跃标签页状态附加在返回内容中。
 */

import {
  errorResult,
  image,
  text,
  validateAgainstSchema,
  type ToolResult,
} from "@agent-browser/protocol";
import { cdp } from "../cdp.ts";
import { ToolError, errorMessage } from "../errors.ts";
import { sendToPage } from "../page.ts";
import { recorder } from "../recorder.ts";
import { formatTabs, tabGroup } from "../tab-group.ts";
import { computerTool } from "./computer.ts";
import { consoleTool, networkTool } from "./devtools.ts";
import { fileUploadTool, formInputTool, uploadImageTool } from "./form.ts";
import { gifTool } from "./gif.ts";
import { javascriptTool } from "./javascript.ts";
import { navigateTool } from "./navigate.ts";
import { findCandidatesTool, getPageTextTool, readPageTool } from "./read.ts";
import { tabsCloseTool, tabsContextTool, tabsCreateTool } from "./tabs.ts";
import type { ToolContext, ToolSpec } from "./types.ts";
import { resizeWindowTool } from "./window.ts";

/** 扩展端支持的全部工具规格清单 */
const specs: ToolSpec[] = [
  tabsContextTool,
  tabsCreateTool,
  tabsCloseTool,
  navigateTool,
  computerTool,
  readPageTool,
  getPageTextTool,
  findCandidatesTool,
  formInputTool,
  javascriptTool,
  consoleTool,
  networkTool,
  fileUploadTool,
  uploadImageTool,
  resizeWindowTool,
  gifTool,
];
const registry = new Map(specs.map((s) => [s.name, s]));

/** 格式化已自动处理的弹窗事件说明 */
function formatDialogs(tabId: number): string[] {
  return cdp
    .takeDialogs(tabId)
    .map((d) => `Note: a JavaScript ${d.type} dialog appeared${d.message ? ` (${JSON.stringify(d.message.slice(0, 200))})` : ""} and was ${d.action}.`);
}

/** 记录标签页忙碌状态计时器，避免连续调用间快速闪烁 */
const busyTimers = new Map<number, ReturnType<typeof setTimeout>>();

/** 向目标网页同步 Agent 的忙碌锁定状态与操作提示 */
function setTabBusy(tabId: number, busy: boolean, tool?: string) {
  const existing = busyTimers.get(tabId);
  if (existing) {
    clearTimeout(existing);
    busyTimers.delete(tabId);
  }
  if (busy) {
    void sendToPage(tabId, { type: "agent-browser:status", busy: true, tool });
  } else {
    // 延迟 1.2 秒解除锁定与隐藏提示，保持动画连贯，避免两个连续的工具调用之间产生视觉闪烁
    const timer = setTimeout(() => {
      busyTimers.delete(tabId);
      void sendToPage(tabId, { type: "agent-browser:status", busy: false });
    }, 1200);
    busyTimers.set(tabId, timer);
  }
}

/** 扩展端工具调用统一分发入口 */
export async function dispatch(tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<ToolResult> {
  const spec = registry.get(tool);
  if (!spec) return errorResult(`Unknown tool "${tool}".`, "unknown_tool");
  const problem = validateAgainstSchema(spec.schema, input);
  if (problem) return errorResult(`Invalid input for ${tool}: ${problem}`, "input_invalid");

  const ctx: ToolContext = { signal, notes: [] };
  try {
    // 检查标签页是否存在且属于 Agent 专用分组
    if (spec.needsTab) {
      ctx.tab = await tabGroup.requireTab(input.tabId as number);
      ctx.tabId = ctx.tab.id!;
      // 开启受控提示与输入锁定
      setTabBusy(ctx.tabId, true, tool);
    }
    const out = await spec.run(input, ctx);
    if (ctx.tabId !== undefined) ctx.notes.push(...formatDialogs(ctx.tabId));
    // 若正在录制操作过程动图，捕获动作后视口状态
    if (out.recordable && ctx.tabId !== undefined && recorder.isRecording) {
      await recorder.capture(ctx.tabId, out.recordable).catch(() => {});
    }
    const parts = [out.text, ...ctx.notes];
    if (out.withTabs) parts.push(formatTabs(await tabGroup.tabs(), ctx.tabId));
    const content: ToolResult["content"] = [text(parts.filter(Boolean).join("\n\n"))];
    if (out.image) content.push(image(out.image.data, out.image.mediaType));
    return { content };
  } catch (err) {
    if (ctx.tabId !== undefined) ctx.notes.push(...formatDialogs(ctx.tabId));
    const code = err instanceof ToolError ? err.code : signal.aborted ? "cancelled" : "execution_error";
    const message = signal.aborted && !(err instanceof ToolError) ? "Cancelled." : errorMessage(err);
    return errorResult([message, ...ctx.notes].join("\n\n"), code);
  } finally {
    if (ctx.tabId !== undefined) {
      // 动作完成，触发防抖解除锁定
      setTabBusy(ctx.tabId, false);
    }
  }
}
