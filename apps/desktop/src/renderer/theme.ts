import type { ThemeMode } from "../shared.ts";

const KEY = "agent_browser_theme";
const media = window.matchMedia("(prefers-color-scheme: dark)");

export function getTheme(): ThemeMode {
  const saved = localStorage.getItem(KEY);
  return saved === "light" || saved === "dark" ? saved : "system";
}

/** 把主题写到 <html data-theme>；"system" 时跟随系统 */
function paint(mode: ThemeMode) {
  const dark = mode === "dark" || (mode === "system" && media.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

export function applyTheme(mode: ThemeMode) {
  localStorage.setItem(KEY, mode);
  paint(mode);
  void window.agentApi.setTheme(mode);
}

/** 启动时调用：系统外观变化时，"跟随系统"模式要同步更新 */
export function initTheme() {
  paint(getTheme());
  media.addEventListener("change", () => {
    if (getTheme() === "system") paint("system");
  });
}

/** 浅色 → 深色 → 跟随系统 → 浅色 */
export function nextTheme(mode: ThemeMode): ThemeMode {
  return mode === "light" ? "dark" : mode === "dark" ? "system" : "light";
}
