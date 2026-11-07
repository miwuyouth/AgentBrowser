import type { ThemeMode } from "../shared.ts";

const THEME_STORAGE_KEY = "agent_browser_theme";

export function getStoredTheme(): ThemeMode {
  const t = localStorage.getItem(THEME_STORAGE_KEY);
  if (t === "light" || t === "dark" || t === "system") return t;
  return "system";
}

export function applyTheme(theme: ThemeMode) {
  localStorage.setItem(THEME_STORAGE_KEY, theme);
  const isDark =
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  document.documentElement.style.colorScheme = isDark ? "dark" : "light";

  if (window.agentApi?.setTheme) {
    void window.agentApi.setTheme(theme).catch(() => {});
  }
}

export function initTheme() {
  const current = getStoredTheme();
  applyTheme(current);

  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (getStoredTheme() === "system") {
      applyTheme("system");
    }
  });
}
