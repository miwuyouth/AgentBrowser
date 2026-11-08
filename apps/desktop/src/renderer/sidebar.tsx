import { useState } from "preact/hooks";
import type { ThemeMode } from "../shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { applyTheme, getTheme, nextTheme } from "./theme.ts";

export type View = "tasks" | "editor" | "runs" | "run" | "live" | "env";

/**
 * 跳转到某个页面。id 的含义取决于目标页面：
 * editor / runs → 任务 ID（编辑某个任务 / 只看某个任务的运行记录）
 * run / live → 运行记录 ID
 */
export type Navigate = (view: View, id?: string) => void;

/** 编辑页属于「任务」，运行详情和实时视图属于「运行记录」：导航高亮始终告诉用户自己在哪 */
const NAV_OWNER: Record<View, View> = { tasks: "tasks", editor: "tasks", runs: "runs", run: "runs", live: "runs", env: "env" };

const THEME_ICON: Record<ThemeMode, IconName> = { light: "sun", dark: "moon", system: "monitor" };
const THEME_LABEL: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

interface Props {
  view: View;
  taskCount: number;
  onNavigate: Navigate;
  onOpenSettings: () => void;
}

export function Sidebar({ view, taskCount, onNavigate, onOpenSettings }: Props) {
  const [theme, setTheme] = useState<ThemeMode>(getTheme);
  const active = NAV_OWNER[view];

  const item = (target: View, icon: IconName, label: string, count?: number) => (
    <button
      type="button"
      class={`nav-item ${active === target ? "active" : ""}`}
      aria-current={active === target ? "page" : undefined}
      onClick={() => onNavigate(target)}
    >
      <Icon name={icon} />
      <span>{label}</span>
      {count !== undefined && count > 0 && <span class="nav-count">{count}</span>}
    </button>
  );

  const toggleTheme = () => {
    const next = nextTheme(theme);
    applyTheme(next);
    setTheme(next);
  };

  return (
    <nav class="sidebar" aria-label="主导航">
      <div class="sidebar-drag" />

      <div class="brand">
        <span class="brand-mark">
          <Icon name="window" size={14} />
        </span>
        Agent Browser
      </div>

      <button type="button" class="btn btn-primary btn-block" style="margin-bottom: 22px" onClick={() => onNavigate("editor")}>
        <Icon name="plus" />
        新建任务
        <kbd>⌘N</kbd>
      </button>

      <div class="nav-group">
        <div class="nav-label">工作台</div>
        {item("tasks", "tasks", "任务", taskCount)}
        {item("runs", "runs", "运行记录")}
        <div class="nav-divider" />
        {item("env", "env", "运行环境")}
      </div>

      <div class="sidebar-foot">
        <button type="button" class="nav-item" onClick={onOpenSettings}>
          <Icon name="settings" />
          <span>设置</span>
        </button>
        <button
          type="button"
          class="icon-btn"
          aria-label={`外观：${THEME_LABEL[theme]}`}
          title={`外观：${THEME_LABEL[theme]}`}
          onClick={toggleTheme}
        >
          <Icon name={THEME_ICON[theme]} />
        </button>
      </div>
    </nav>
  );
}
