/**
 * 注入网页的 Content Script 入口与 DOM API 暴露层。
 *
 * 核心机制：
 * 运行在 Chrome 隔离世界（Isolated World）中，避免污染网页全局命名空间，
 * 同时挂载 `__agentBrowser` API 供 Background 脚本通过 `chrome.scripting.executeScript` 快速直接调用：
 * - `tree`: 计算页面可访问性树（Accessibility Tree）并生成元素 refs；
 * - `candidates`: 为 App 侧的 find 工具收集交互元素候选；
 * - `pageText`: 提取网页正文核心文本；
 * - `elementPoint`: 根据 ref 计算元素中心坐标点，若在视口外则平滑滚动到视口；
 * - `setValue` / `setFiles`: 表单填充与文件直接注入；
 * - `overlay`: 鼠标点击或交互时在网页上渲染红色指示光标或高亮。
 */

import type { ElementPoint, PageApi } from "./api.ts";
import { dropFiles, setFiles, setValue } from "./forms.ts";
import { clearOverlay, restoreOverlay, setAgentStatus, setCdpInputActive, showPointer } from "./overlay.ts";
import { resolveRef } from "./refs.ts";
import { extractPageText } from "./text.ts";
import { accessibleName, buildTree, collectCandidates, inViewport, roleOf } from "./tree.ts";

/** 计算元素中心点坐标与遮挡检测 */
function pointOf(el: Element, ref: string): ElementPoint {
  const r = el.getBoundingClientRect();
  const x = r.left + r.width / 2;
  const y = r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  // 检测元素中心点是否被上层浮层/弹窗遮挡
  const covered = hit && hit !== el && !el.contains(hit) && !hit.contains(el) ? hit.tagName.toLowerCase() : undefined;
  const name = accessibleName(el);
  const point: ElementPoint = {
    x,
    y,
    width: r.width,
    height: r.height,
    inViewport: inViewport(el),
    label: `${ref} (${roleOf(el)}${name ? ` "${name}"` : ""})`,
  };
  if (covered) point.coveredBy = covered;
  return point;
}

/** 若元素不在当前视口内，瞬时滚动居中 */
function scrollIntoViewIfNeeded(el: Element) {
  const r = el.getBoundingClientRect();
  const fully = r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight && r.right <= innerWidth;
  if (!fully) el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
}

/** 挂载到 Content Script 环境的内部 API 实例 */
const api: PageApi = {
  tree: (opts) => buildTree(opts),
  candidates: (opts) => collectCandidates(opts.limit),
  pageText: (maxChars) => extractPageText(maxChars),
  elementPoint(ref) {
    const el = resolveRef(ref);
    scrollIntoViewIfNeeded(el);
    return pointOf(el, ref);
  },
  scrollTo(ref) {
    const el = resolveRef(ref);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    return pointOf(el, ref);
  },
  setValue,
  setFiles,
  dropFiles,
  viewport: () => ({
    width: innerWidth,
    height: innerHeight,
    devicePixelRatio: devicePixelRatio,
    scrollX,
    scrollY,
  }),
};

// 后台通过 chrome.scripting 在相同的 isolated world 中访问 __agentBrowser。
// 防止重复注入（manifest 自动声明 + 运行时按需注入）
if (!(globalThis as any).__agentBrowser) {
  (globalThis as any).__agentBrowser = api;
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "agent-browser:pointer") showPointer(message.x, message.y);
    else if (message?.type === "agent-browser:clear-overlay") clearOverlay();
    else if (message?.type === "agent-browser:restore-overlay") restoreOverlay();
    else if (message?.type === "agent-browser:status") setAgentStatus(Boolean(message.busy), message.tool);
    else if (message?.type === "agent-browser:cdp-input") setCdpInputActive(Boolean(message.active));
    else return false;
    sendResponse({ ok: true });
    return false;
  });
}
