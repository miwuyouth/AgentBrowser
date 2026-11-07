/**
 * Agent 运行状态视觉反馈与防误触独占锁定层（Overlay & Input Lock）。
 *
 * 核心机制：
 * 1. 独占受控指示：在 Agent 操控网页期间，视口四周呈现醒目的琥珀色呼吸发光边框，顶部呈现浮动状态胶囊；
 * 2. 用户操作锁定（防误触）：
 *    - 阻断物理鼠标点击：在 Agent 忙碌时遮罩层启用 `pointer-events: all`，吸收所有物理点击并弹出锁定提示；
 *    - 阻断物理键盘与滚轮：在 window 捕获阶段拦截 keydown、wheel 等事件，防止用户抢占焦点或破坏页面状态；
 * 3. CDP 拟真动作精准穿透：
 *    - 当 Agent 通过 CDP 执行底层点击、打字时，临时放行（毫秒级窗口），保证自动化操作 100% 正常响应；
 * 4. 截屏纯净度保护：在扩展执行截图前通过 `clearOverlay` 临时隐藏遮罩，保证模型看到的截图真实干净。
 */

let host: HTMLElement | null = null;
let layer: ShadowRoot | null = null;
let borderEl: HTMLElement | null = null;
let bannerEl: HTMLElement | null = null;
let bannerTextEl: HTMLElement | null = null;
let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | undefined;

let isBusy = false;
let isCdpActive = false;
let listenersAttached = false;

function ensureLayer(): ShadowRoot {
  if (layer && host?.isConnected) return layer;
  host = document.createElement("agent-browser-overlay");
  host.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647;";
  layer = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host {
      all: initial;
    }
    .shield {
      position: fixed;
      inset: 0;
      pointer-events: none;
    }
    .shield.blocking {
      pointer-events: all;
      cursor: not-allowed;
    }
    .border-glow {
      position: fixed;
      inset: 0;
      box-shadow: inset 0 0 0 3px #f59e0b, inset 0 0 20px rgba(245, 158, 11, 0.45);
      pointer-events: none;
      z-index: 10000;
      opacity: 0;
      transition: opacity 0.25s ease;
    }
    .border-glow.active {
      opacity: 1;
      animation: borderPulse 2s infinite alternate ease-in-out;
    }
    @keyframes borderPulse {
      from { box-shadow: inset 0 0 0 3px #f59e0b, inset 0 0 16px rgba(245, 158, 11, 0.35); }
      to { box-shadow: inset 0 0 0 3px #fbbf24, inset 0 0 28px rgba(245, 158, 11, 0.65); }
    }
    .banner {
      position: fixed;
      top: 14px;
      left: 50%;
      transform: translateX(-50%) translateY(-24px);
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 8px 18px;
      background: rgba(17, 24, 39, 0.94);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      border: 1px solid rgba(245, 158, 11, 0.55);
      border-radius: 9999px;
      color: #f9fafb;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
      font-size: 13px;
      font-weight: 500;
      box-shadow: 0 10px 25px -5px rgba(0, 0, 0, 0.5), 0 0 15px rgba(245, 158, 11, 0.3);
      user-select: none;
      pointer-events: auto;
      z-index: 10001;
      opacity: 0;
      transition: opacity 0.25s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .banner.active {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .badge {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #f59e0b;
      box-shadow: 0 0 8px #f59e0b;
      animation: pulseDot 1.5s infinite;
      flex-shrink: 0;
    }
    @keyframes pulseDot {
      0%, 100% { transform: scale(1); opacity: 1; }
      50% { transform: scale(1.3); opacity: 0.6; }
    }
    .text-title {
      display: flex;
      align-items: center;
      gap: 6px;
      white-space: nowrap;
    }
    .text-lock {
      font-size: 11px;
      color: #fbbf24;
      background: rgba(245, 158, 11, 0.18);
      padding: 2px 7px;
      border-radius: 10px;
      border: 1px solid rgba(245, 158, 11, 0.35);
      margin-left: 2px;
      white-space: nowrap;
    }
    .toast {
      position: fixed;
      top: 62px;
      left: 50%;
      transform: translateX(-50%) translateY(-10px);
      background: rgba(220, 38, 38, 0.95);
      backdrop-filter: blur(8px);
      color: #ffffff;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      font-size: 12px;
      font-weight: 500;
      padding: 6px 14px;
      border-radius: 9999px;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.35);
      opacity: 0;
      pointer-events: none;
      transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
      z-index: 10002;
      white-space: nowrap;
    }
    .toast.show {
      opacity: 1;
      transform: translateX(-50%) translateY(0);
    }
    .dot {
      position: fixed;
      width: 22px;
      height: 22px;
      margin: -11px 0 0 -11px;
      border-radius: 50%;
      border: 2px solid #d97706;
      background: rgba(217, 119, 6, 0.25);
      animation: ripple 0.7s ease-out forwards;
      pointer-events: none;
      z-index: 10003;
    }
    @keyframes ripple {
      from { transform: scale(0.4); opacity: 1; }
      to { transform: scale(1.8); opacity: 0; }
    }
  `;
  layer.append(style);

  // 全屏发光边框节点
  borderEl = document.createElement("div");
  borderEl.className = "border-glow";
  layer.append(borderEl);

  // 顶部操作中胶囊提示节点
  bannerEl = document.createElement("div");
  bannerEl.className = "banner";
  bannerEl.innerHTML = `
    <div class="badge"></div>
    <div class="text-title">
      <span>🤖 AI Agent 正在操控浏览器...</span>
      <span class="text-lock">🔒 用户操作已锁定</span>
    </div>
  `;
  bannerTextEl = bannerEl.querySelector(".text-title span");
  layer.append(bannerEl);

  // 尝试点击时的警告浮层
  toastEl = document.createElement("div");
  toastEl.className = "toast";
  toastEl.textContent = "⚠️ Agent 正在执行自动化任务，用户操作已锁定";
  layer.append(toastEl);

  // 挂载到根节点
  (document.documentElement ?? document.body).append(host);

  // 当用户在遮罩上点击时弹出拦截提示
  host.addEventListener("mousedown", (e) => {
    if (isBusy && !isCdpActive) {
      e.preventDefault();
      e.stopPropagation();
      showToast();
    }
  });

  attachWindowListeners();
  return layer;
}

/** 弹出锁定警告提示 */
function showToast() {
  if (!toastEl) return;
  toastEl.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl?.classList.remove("show");
  }, 1600);
}

/** 拦截用户键盘输入与鼠标滚轮事件 */
function attachWindowListeners() {
  if (listenersAttached) return;
  listenersAttached = true;

  const preventUserEvent = (e: Event) => {
    if (isBusy && !isCdpActive) {
      e.preventDefault();
      e.stopPropagation();
      e.stopImmediatePropagation();
      showToast();
    }
  };

  // 在捕获阶段拦截键盘按键与滚轮滚动，防止用户破坏页面状态
  window.addEventListener("keydown", preventUserEvent, { capture: true, passive: false });
  window.addEventListener("keyup", preventUserEvent, { capture: true, passive: false });
  window.addEventListener("keypress", preventUserEvent, { capture: true, passive: false });
  window.addEventListener("wheel", preventUserEvent, { capture: true, passive: false });
  window.addEventListener("contextmenu", preventUserEvent, { capture: true, passive: false });
}

/** 更新遮罩层的拦截属性状态 */
function updatePointerEvents() {
  if (!host) return;
  if (isBusy && !isCdpActive) {
    host.style.pointerEvents = "all";
    host.style.cursor = "not-allowed";
  } else {
    host.style.pointerEvents = "none";
    host.style.cursor = "default";
  }
}

/** 设置 Agent 当前操作状态与提示文字 */
export function setAgentStatus(busy: boolean, toolName?: string) {
  isBusy = busy;
  ensureLayer();
  updatePointerEvents();

  if (borderEl) {
    if (busy) borderEl.classList.add("active");
    else borderEl.classList.remove("active");
  }

  if (bannerEl) {
    if (busy) {
      bannerEl.classList.add("active");
      if (bannerTextEl) {
        const label = toolLabel(toolName);
        bannerTextEl.textContent = label ? `🤖 Agent 正在操作中 (${label})...` : "🤖 AI Agent 正在操控浏览器...";
      }
    } else {
      bannerEl.classList.remove("active");
    }
  }
}

/** 标记当前是否正在由 CDP 执行拟真键鼠动作（毫秒级窗口放行） */
export function setCdpInputActive(active: boolean) {
  isCdpActive = active;
  updatePointerEvents();
}

/** 显示点击位置的涟漪水波纹动画圆点 */
export function showPointer(x: number, y: number) {
  const root = ensureLayer();
  const dot = document.createElement("div");
  dot.className = "dot";
  dot.style.left = `${x}px`;
  dot.style.top = `${y}px`;
  root.append(dot);
  setTimeout(() => dot.remove(), 800);
}

/** 截图前隐藏所有遮罩和指示元素，避免污染大模型视线 */
export function clearOverlay() {
  if (!layer) return;
  layer.querySelectorAll(".dot").forEach((d) => d.remove());
  if (host) host.style.display = "none";
}

/** 截图完成后恢复遮罩显示 */
export function restoreOverlay() {
  if (host) host.style.display = "block";
}

/** 将常见工具名转为对人类友好的操作短语 */
function toolLabel(tool?: string): string | undefined {
  if (!tool) return undefined;
  switch (tool) {
    case "computer":
      return "拟真键鼠交互";
    case "navigate":
      return "跳转加载网页";
    case "read_page":
      return "分析页面结构";
    case "get_page_text":
      return "读取页面正文";
    case "find_candidates":
      return "语义定位元素";
    case "form_input":
      return "填入表单数据";
    case "file_upload":
      return "注入上传文件";
    case "javascript_tool":
      return "执行页面脚本";
    default:
      return undefined;
  }
}
