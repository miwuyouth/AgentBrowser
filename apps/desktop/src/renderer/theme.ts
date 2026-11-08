import type { ThemeMode } from "../shared.ts";

/**
 * 应用界面外观主题（深色/浅色/跟随系统）管理模块。
 */

/** 主题偏好持久化保存在 localStorage 中的 key */
const KEY = "agent_browser_theme";

/** 监听操作系统原生深浅色偏好的媒体查询匹配器 */
const media = window.matchMedia("(prefers-color-scheme: dark)");

/**
 * 获取当前用户设置的主题模式。
 *
 * 【调用时机】
 * 1. 应用启动（`initTheme`）时调用；
 * 2. 侧边栏等组件初始化主题状态时调用。
 *
 * 【作用】
 * 从 localStorage 读取持久化配置，若无效或未设置则默认返回 "system"（跟随系统）。
 *
 * @returns 当前配置的 ThemeMode ("light" | "dark" | "system")
 */
export function getTheme(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/**
 * 实际将计算后的深浅色应用至 DOM 树。
 *
 * 【调用时机】
 * 在 `applyTheme`、`initTheme` 或操作系统外观发生切换时内部调用。
 *
 * 【作用】
 * 计算最终应该显示为深色还是浅色（若为 system 则判断 `media.matches`），并写入 `<html data-theme="...">` 属性，驱动 CSS 变量生效。
 *
 * @param mode 当前主题模式
 */
function paint(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/**
 * 应用并持久化新的主题模式。
 *
 * 【调用时机】
 * 用户在侧边栏点击主题图标、或在设置模态框中切换主题单选框时调用。
 *
 * 【作用】
 * 1. 写入 localStorage 记忆设置；
 * 2. 调用 `paint` 刷新网页外观；
 * 3. 通过 IPC 调用 `window.agentApi.setTheme(mode)` 通知 Electron 主进程同步调整原生窗口背景与 nativeTheme。
 *
 * @param mode 目标主题模式
 */
export function applyTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  paint(mode);
  void window.agentApi.setTheme(mode);
}

/**
 * 初始化全局外观主题。
 *
 * 【调用时机】
 * 在渲染入口脚本（`app.tsx`）首屏渲染前立即同步调用。
 *
 * 【作用】
 * 1. 立即计算并涂覆初始主题，避免白屏闪烁；
 * 2. 注册系统深浅色切换事件监听器，当处于"跟随系统"模式时保持与操作系统自动同步。
 */
export function initTheme() {
  paint(getTheme());
  media.addEventListener("change", () => {
    if (getTheme() === "system") paint("system");
  });
}

/**
 * 计算三态循环切换的下一个主题模式。
 *
 * 【调用时机】
 * 用户点击侧边栏底部的主题单键快捷切换按钮时调用。
 *
 * 【作用】
 * 按照：浅色 ("light") → 深色 ("dark") → 跟随系统 ("system") → 浅色 ("light") 的顺序依次递进。
 *
 * @param mode 当前的主题模式
 * @returns 循环推导出的下一个主题模式
 */
export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}
