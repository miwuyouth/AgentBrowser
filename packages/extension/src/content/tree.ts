/**
 * 网页无障碍结构树（Accessibility Tree）提取与元素 Candidate 收集器。
 *
 * 核心机制：
 * 1. 结构树提取（`buildTree`）：模拟无障碍树（Accessibility Tree），将复杂的 HTML DOM 扁平化精简为层次分明的语义节点树；
 * 2. 元素 Ref 绑定：为每个有意义的交互或结构节点分配唯一引用（如 [ref_1]，见 `refs.ts`），Agent 模型后续直接使用 ref 操作元素；
 * 3. 隐私与安全脱敏（`isSensitive`）：识别密码框、信用卡号、CVV、双重认证码等，在结构树中强行脱敏为 `[redacted]`，防止密码泄露给大模型；
 * 4. 阴影 DOM（Shadow DOM）穿透：递归支持 `shadowRoot` 内部组件的解析；
 * 5. 防假死时间预算（TIME_BUDGET_MS = 1500）：在特大页面（万级 DOM）上严格受控，防止阻塞网页主线程。
 */

import type { FindCandidate, TreeOptions, TreeResult } from "./api.ts";
import { pruneRefs, refFor, resolveRef } from "./refs.ts";

/** 无需遍历的纯元数据与无界面表现标签 */
const SKIP_TAGS = new Set(["script", "style", "meta", "link", "title", "noscript", "template", "head", "base", "svg"]);
/** 天然具备交互能力的 HTML 标签集合 */
const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea", "details", "summary"]);
/** ARIA 交互角色集合 */
const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "tab",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "combobox",
  "textbox",
  "searchbox",
  "slider",
  "spinbutton",
  "treeitem",
]);
/** 结构性重要语义标签 */
const STRUCTURE_TAGS = new Set([
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "nav",
  "main",
  "header",
  "footer",
  "section",
  "article",
  "aside",
  "form",
  "dialog",
  "table",
]);
const CONTAINER_SELECTOR = "li, tr, article, dialog, fieldset, form, [role=row], [role=listitem], [role=article], [role=dialog]";

/** 单次树遍历的最大节点数与执行超时时间（毫秒） */
const MAX_ELEMENTS = 10_000;
const TIME_BUDGET_MS = 1_500;

/** 计算元素的语义角色（Role），结合显式 ARIA 属性与原生 HTML 语义 */
export function roleOf(el: Element): string {
  const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
  if (explicit) return explicit;
  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case "a":
      return el.hasAttribute("href") ? "link" : "generic";
    case "button":
    case "summary":
      return "button";
    case "input": {
      const type = (el.getAttribute("type") || "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) return "button";
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      if (type === "file") return "file-input";
      if (type === "search") return "searchbox";
      if (type === "hidden") return "hidden";
      return "textbox";
    }
    case "select":
      return (el as HTMLSelectElement).multiple ? "listbox" : "combobox";
    case "textarea":
      return "textbox";
    case "img":
      return "image";
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      return "heading";
    case "nav":
      return "navigation";
    case "main":
      return "main";
    case "header":
      return "banner";
    case "footer":
      return "contentinfo";
    case "aside":
      return "complementary";
    case "section":
      return "region";
    case "article":
      return "article";
    case "form":
      return "form";
    case "dialog":
      return "dialog";
    case "table":
      return "table";
    case "tr":
      return "row";
    case "th":
      return "columnheader";
    case "td":
      return "cell";
    case "ul":
    case "ol":
      return "list";
    case "li":
      return "listitem";
    case "label":
      return "label";
    default:
      return (el as HTMLElement).isContentEditable && el.getAttribute("contenteditable") !== null ? "textbox" : "generic";
  }
}

/** 判断元素是否具备用户可交互性（点击、输入、选择等） */
function isInteractive(el: Element): boolean {
  const tag = el.tagName.toLowerCase();
  if (INTERACTIVE_TAGS.has(tag)) return tag !== "input" || (el as HTMLInputElement).type !== "hidden";
  const role = el.getAttribute("role");
  if (role && INTERACTIVE_ROLES.has(role)) return true;
  return el.hasAttribute("onclick") || (el.hasAttribute("tabindex") && el.getAttribute("tabindex") !== "-1") || el.getAttribute("contenteditable") === "true";
}

/**
 * 敏感输入元素判定：
 * 包含密码框、支付卡号、安全码、一次性动态码等，其值严禁向大模型展示。
 */
function isSensitive(el: Element): boolean {
  const type = (el.getAttribute("type") || "").toLowerCase();
  if (type === "password" || type === "hidden") return true;
  const autocomplete = (el.getAttribute("autocomplete") || "").toLowerCase();
  return /(current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp)/.test(autocomplete);
}

const clip = (s: string | null | undefined, n: number) => {
  const v = (s ?? "").replace(/\s+/g, " ").trim();
  return v.length > n ? v.slice(0, n) + "…" : v;
};

/** 获取元素直属文本节点的纯文本（不包含深层子元素文本） */
function ownText(el: Element): string {
  let t = "";
  for (const node of el.childNodes) if (node.nodeType === Node.TEXT_NODE) t += node.textContent;
  return t.replace(/\s+/g, " ").trim();
}

/** 解析 aria-labelledby 引用的元素内容 */
function textOfIds(ids: string): string {
  return ids
    .split(/\s+/)
    .slice(0, 3)
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
}

/**
 * 计算元素的可访问名称（Accessible Name）。
 * 遵循 W3C 优先级规则：
 * aria-label > aria-labelledby > associated <label> > 选中的选项 > placeholder/title/alt > 按钮文字 > 直属文本。
 */
export function accessibleName(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const aria = el.getAttribute("aria-label");
  if (aria?.trim()) return clip(aria, 100);
  const labelledBy = el.getAttribute("aria-labelledby");
  if (labelledBy) {
    const t = clip(textOfIds(labelledBy), 100);
    if (t) return t;
  }
  const labels = (el as HTMLInputElement).labels;
  if (labels && labels.length > 0) {
    const t = clip([...labels].map((l) => l.textContent).join(" "), 100);
    if (t) return t;
  }
  if (tag === "select") {
    const select = el as HTMLSelectElement;
    if (isSensitive(el)) return "[value redacted]";
    const selected = select.options[select.selectedIndex];
    if (selected?.textContent?.trim()) return clip(selected.textContent, 100);
  }
  for (const attr of ["placeholder", "title", "alt"]) {
    const v = el.getAttribute(attr);
    if (v?.trim()) return clip(v, 100);
  }
  if (tag === "input") {
    const input = el as HTMLInputElement;
    if (["submit", "button", "reset"].includes(input.type) && input.value) return clip(input.value, 100);
    return "";
  }
  if (tag === "textarea" || tag === "img") return "";
  if (isInteractive(el) || /^h[1-6]$/.test(tag) || tag === "label" || tag === "option") {
    return clip(el.textContent, 100);
  }
  const own = ownText(el);
  return own.length >= 3 ? clip(own, 100) : "";
}

/** 元素视觉可见性检测（非 display:none / visibility:hidden / opacity:0 且尺寸大于 0） */
function isVisible(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof el.checkVisibility === "function") {
    return el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  }
  const style = getComputedStyle(el);
  return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
}

/** 检测元素当前是否处于浏览器可视视口（Viewport）内 */
export function inViewport(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** 获取子节点（支持穿透 Shadow DOM） */
function childrenOf(el: Element): Element[] {
  const kids = [...el.children];
  if (el.shadowRoot) kids.unshift(...el.shadowRoot.children);
  return kids;
}

/** 树节点过滤策略 */
function shouldInclude(el: Element, filter: TreeOptions["filter"], focused: boolean): boolean {
  const tag = el.tagName.toLowerCase();
  if (SKIP_TAGS.has(tag)) return false;
  if (filter === "interactive") {
    if (el.getAttribute("aria-hidden") === "true") return false;
    if (!isVisible(el)) return false;
    if (!focused && !inViewport(el)) return false;
    return isInteractive(el);
  }
  if (isInteractive(el) || STRUCTURE_TAGS.has(tag)) return true;
  if (el.hasAttribute("role") && el.getAttribute("role") !== "presentation" && el.getAttribute("role") !== "none") return true;
  if (accessibleName(el)) return true;
  const role = roleOf(el);
  return role !== "generic" && role !== "image";
}

function quote(s: string) {
  return `"${s.replace(/"/g, '\\"')}"`;
}

/** 格式化生成单行元素描述及 ref 绑定 */
function describeLine(el: Element, depth: number, ref: string): string[] {
  const tag = el.tagName.toLowerCase();
  const role = roleOf(el);
  const name = accessibleName(el);
  let line = "  ".repeat(depth) + role;
  if (name) line += " " + quote(name);
  line += ` [${ref}]`;
  const href = el.getAttribute("href");
  if (href && role === "link") line += ` href=${quote(clip(href, 200))}`;
  const type = el.getAttribute("type");
  if (type && tag === "input") line += ` type=${quote(type)}`;
  const placeholder = el.getAttribute("placeholder");
  if (placeholder && placeholder.trim() !== name) line += ` placeholder=${quote(clip(placeholder, 80))}`;
  if ((tag === "input" || tag === "textarea") && !["checkbox", "radio", "submit", "button", "reset", "file"].includes(type ?? "")) {
    const value = (el as HTMLInputElement).value;
    if (value) line += ` value=${quote(isSensitive(el) ? "[redacted]" : clip(value, 80))}`;
  }
  if ((el as HTMLInputElement).checked || el.getAttribute("aria-checked") === "true") line += " (checked)";
  if (el.getAttribute("aria-selected") === "true") line += " (selected)";
  const expanded = el.getAttribute("aria-expanded");
  if (expanded) line += expanded === "true" ? " (expanded)" : " (collapsed)";
  if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") line += " (disabled)";

  const lines = [line];
  if (tag === "select" && !isSensitive(el)) {
    const options = (el as HTMLSelectElement).options;
    for (let i = 0; i < options.length && i < 300; i++) {
      const o = options[i]!;
      const label = clip(o.textContent, 100);
      let ol = "  ".repeat(depth + 1) + "option " + quote(label);
      if (o.selected) ol += " (selected)";
      if (o.value && o.value !== label) ol += ` value=${quote(clip(o.value, 80))}`;
      lines.push(ol);
    }
  }
  return lines;
}

/**
 * 构建整页或指定子树的可访问结构大纲。
 * 控制最大深度、元素上限以及字符长度，防止超出模型上下文上限。
 */
export function buildTree(opts: TreeOptions): TreeResult {
  const deadline = performance.now() + TIME_BUDGET_MS;
  const lines: string[] = [];
  let count = 0;
  let stopped = false;
  const focused = Boolean(opts.refId);

  const visit = (el: Element, depth: number, isRoot: boolean) => {
    if (stopped) return;
    if (count >= MAX_ELEMENTS || performance.now() > deadline) {
      stopped = true;
      return;
    }
    const include = isRoot || shouldInclude(el, opts.filter, focused);
    if (include) {
      count++;
      lines.push(...describeLine(el, depth, refFor(el)));
    }
    const tag = el.tagName.toLowerCase();
    if (tag === "select" || SKIP_TAGS.has(tag)) return;
    const nextDepth = include ? depth + 1 : depth;
    if (nextDepth > opts.depth) return;
    for (const child of childrenOf(el)) visit(child, nextDepth, false);
  };

  const root = opts.refId ? resolveRef(opts.refId) : document.body;
  if (root) visit(root, 0, Boolean(opts.refId));
  pruneRefs();

  let text = lines.join("\n");
  let truncated = stopped;
  if (stopped) {
    text += `\n[stopped after ${count} elements: the page is very large. Use filter "interactive", a smaller depth, or ref_id to focus.]`;
  }
  if (text.length > opts.maxChars) {
    const cut = Math.max(text.lastIndexOf("\n", opts.maxChars), 0) || opts.maxChars;
    text =
      text.slice(0, cut) +
      `\n[output truncated at ${cut} of ${text.length} characters. Pass a larger max_chars, a smaller depth, or ref_id to focus.]`;
    truncated = true;
  }
  if (!text) text = opts.filter === "interactive" ? "(no interactive elements in the viewport)" : "(empty page)";
  return { text, elementCount: count, truncated };
}

function attrsSummary(el: Element): string | undefined {
  const parts: string[] = [];
  for (const a of ["id", "name", "data-testid", "data-test", "data-qa", "aria-describedby"]) {
    const v = el.getAttribute(a);
    if (!v) continue;
    parts.push(a === "aria-describedby" ? `described: ${clip(textOfIds(v), 80)}` : `${a}=${clip(v, 60)}`);
  }
  return parts.length ? parts.join(" ") : undefined;
}

/** 为 App 侧的 `find` 工具收集轻量候选元素列表 */
export function collectCandidates(limit = 1500): FindCandidate[] {
  const out: FindCandidate[] = [];
  const deadline = performance.now() + TIME_BUDGET_MS;
  const visit = (el: Element) => {
    if (out.length >= limit || performance.now() > deadline) return;
    const tag = el.tagName.toLowerCase();
    if (SKIP_TAGS.has(tag)) return;
    const role = roleOf(el);
    const interesting =
      isInteractive(el) || role === "heading" || (role === "image" && accessibleName(el)) || role === "file-input" || role === "dialog";
    if (interesting && role !== "hidden") {
      const name = accessibleName(el);
      const text = isInteractive(el) && !["input", "select", "textarea"].includes(tag) ? clip(el.textContent, 150) : undefined;
      const container = el.parentElement?.closest(CONTAINER_SELECTOR);
      const candidate: FindCandidate = {
        ref: refFor(el),
        role,
        name,
        visible: isVisible(el),
        inViewport: inViewport(el),
      };
      if (text && text !== name) candidate.text = text;
      if (container) candidate.context = clip(container.textContent, 150);
      const attrs = attrsSummary(el);
      if (attrs) candidate.attrs = attrs;
      const href = el.getAttribute("href");
      if (href) candidate.href = clip(href, 150);
      if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") candidate.disabled = true;
      out.push(candidate);
    }
    if (tag === "select") return;
    for (const child of childrenOf(el)) visit(child);
  };
  if (document.body) visit(document.body);
  return out;
}
