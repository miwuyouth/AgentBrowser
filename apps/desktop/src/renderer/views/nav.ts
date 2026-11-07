import type { AppState } from "../../shared.ts";
import { applyTheme, getStoredTheme } from "../theme.ts";
import { escapeHtml, icon, status } from "../ui.ts";

export type ViewType = "tasks" | "editor" | "live" | "runs" | "kernels" | "profiles";

type NavItem = { view: ViewType; label: string; icon: "tasks" | "runs" | "kernel" | "profile" };

const NAV_GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "工作台",
    items: [
      { view: "tasks", label: "任务", icon: "tasks" },
      { view: "runs", label: "运行记录", icon: "runs" },
    ],
  },
  {
    label: "运行环境",
    items: [
      { view: "kernels", label: "浏览器内核", icon: "kernel" },
      { view: "profiles", label: "Profile", icon: "profile" },
    ],
  },
];

export function renderSidebar(
  state: AppState,
  currentView: ViewType,
  onNavigate: (view: ViewType, taskId?: string) => void,
  onOpenSettings: () => void,
): HTMLElement {
  const nav = document.createElement("nav");
  nav.className = "sidebar";
  nav.setAttribute("aria-label", "主导航");

  const theme = getStoredTheme();
  const themeIcon = icon(theme === "light" ? "sun" : theme === "dark" ? "moon" : "monitor", 16);
  const themeLabel = theme === "light" ? "浅色" : theme === "dark" ? "深色" : "跟随系统";

  // 定时任务状态：有定时任务才算「已排期」，没有就说没有，不假装一直在跑
  const cronTask = state.tasks.find((t) => t.mode === "cron");
  const scheduleLine = cronTask
    ? `${escapeHtml(state.scheduler?.nextTime || "已排期")}${cronTask.name ? ` · ${escapeHtml(cronTask.name)}` : ""}`
    : "暂无定时任务";

  // 编辑页属于「任务」，执行监控属于「运行记录」—— 让用户始终知道自己在哪里
  const activeView: ViewType = currentView === "editor" ? "tasks" : currentView === "live" ? "runs" : currentView;

  const navButton = (item: NavItem) => `
    <button type="button" class="nav-item ${activeView === item.view ? "active" : ""}"
      data-view="${item.view}" ${activeView === item.view ? 'aria-current="page"' : ""}>
      ${icon(item.icon, 16)}
      <span>${item.label}</span>
    </button>
  `;

  nav.innerHTML = `
    <div class="brand">
      <svg viewBox="0 0 32 32" fill="none" aria-hidden="true">
        <rect class="logo-plate" x="0" y="0" width="32" height="32" rx="8" />
        <rect class="logo-mark" x="7" y="9" width="18" height="14" rx="3" stroke-width="1.7" />
        <path class="logo-mark" d="M7 13.5h18" stroke-width="1.7" />
        <circle class="logo-dot" cx="10.4" cy="11.3" r="1" />
        <circle class="logo-dot" cx="13.4" cy="11.3" r="1" />
      </svg>
      <span class="brand-name">Agent 任务台</span>
    </div>

    <button type="button" class="btn btn-primary btn-block" id="nav-btn-new-task">
      ${icon("plus", 15)}新建任务
    </button>

    <div class="nav">
      ${NAV_GROUPS.map(
        (group) => `
        <div class="nav-label">${group.label}</div>
        ${group.items.map(navButton).join("")}
      `,
      ).join("")}
    </div>

    <div class="sidebar-foot">
      <div class="sched">
        <div class="sched-line">${status(cronTask ? "ok" : "idle", cronTask ? "定时任务" : "无定时任务")}</div>
        ${cronTask ? `<div class="sched-next" title="${scheduleLine}">${scheduleLine}</div>` : ""}
      </div>
      <div class="sidebar-actions">
        <button type="button" class="btn btn-ghost btn-sm" id="nav-btn-settings"
          title="设置 · 模型 ${escapeHtml(state.provider?.model || "未配置")}">
          ${icon("settings", 15)}设置
        </button>
        <button type="button" class="icon-btn" id="nav-btn-theme-toggle" title="外观：${themeLabel}（点击切换）">
          ${themeIcon}
        </button>
      </div>
    </div>
  `;

  nav.querySelector("#nav-btn-new-task")?.addEventListener("click", () => onNavigate("editor"));
  nav.querySelector("#nav-btn-settings")?.addEventListener("click", onOpenSettings);
  nav.querySelector("#nav-btn-theme-toggle")?.addEventListener("click", () => {
    const cur = getStoredTheme();
    const next = cur === "dark" ? "light" : cur === "light" ? "system" : "dark";
    applyTheme(next);
    onNavigate(currentView);
  });

  nav.querySelectorAll<HTMLButtonElement>(".nav-item").forEach((btn) => {
    btn.addEventListener("click", () => {
      const v = btn.getAttribute("data-view") as ViewType;
      if (v) onNavigate(v);
    });
  });

  return nav;
}
