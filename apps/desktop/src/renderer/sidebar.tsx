import { useState } from "preact/hooks";
import type { ThemeMode } from "../shared.ts";
import { Icon, type IconName } from "./icons.tsx";
import { applyTheme, getTheme, nextTheme } from "./theme.ts";

/** 应用支持的所有顶级或二级工作区视图标识 */
export type View = "tasks" | "editor" | "runs" | "run" | "batch" | "live" | "results" | "env";

/**
 * 界面路由跳转导航函数。
 *
 * 【调用时机】
 * 用户点击侧边栏菜单、任务卡片、运行记录、面包屑或返回按钮时调用。
 *
 * 【作用】
 * 切换当前渲染的视图界面，并按需传递实体 ID：
 * - editor: 传递任务 ID 表示编辑该任务，未传则表示新建任务；
 * - runs: 传递任务 ID 表示仅过滤查看该任务的专属历史记录；
 * - run: 传递运行 ID 表示进入单次运行详情页；
 * - batch: 传递一轮的 ID 表示进入这一轮的页面（多 Profile 任务每个 Profile 各一条记录）；
 * - live: 切换到实时监控正在运行的任务；
 * - results: 传递任务 ID 表示查看这个任务的结果表格，未传则显示上次看的任务。
 *
 * 每次跳转都会记入历史，供页面左上角的「< 返回」回到上一页；
 * 跳到顶级页面（任务、运行记录、结果、运行环境）时清空历史。
 *
 * @param view 目标视图名称
 * @param id 目标业务实体的唯一 ID（可选）
 * @param opts.replace 替换当前页而不记入历史：用于自动跳转（运行结束、记录被删除等），避免「返回」回到已失效的页面
 * @param opts.reset 清空历史再跳转：用于从系统通知等外部入口直接打开某页
 */
export type Navigate = (view: View, id?: string, opts?: { replace?: boolean; reset?: boolean }) => void;

/**
 * 视图所有者映射表。
 * 编辑页属于「任务」，运行详情和实时视图属于「运行记录」：确保二级页面中左侧侧边栏高亮始终指向正确的大模块。
 */
const NAV_OWNER: Record<View, View> = {
  tasks: "tasks",
  editor: "tasks",
  runs: "runs",
  run: "runs",
  batch: "runs",
  live: "runs",
  results: "results",
  env: "env",
};

const THEME_ICON: Record<ThemeMode, IconName> = { light: "sun", dark: "moon", system: "monitor" };
const THEME_LABEL: Record<ThemeMode, string> = { light: "浅色", dark: "深色", system: "跟随系统" };

interface Props {
  view: View;
  taskCount: number;
  onNavigate: Navigate;
  onOpenSettings: () => void;
}

/**
 * 桌面应用左侧常驻主导航栏组件。
 *
 * 【调用时机】
 * 在主界面壳层（`app.tsx` 中的 `Main`）左侧常驻挂载渲染。
 *
 * 【作用】
 * 1. 顶部提供 macOS 窗口拖拽区域与品牌标识；
 * 2. 提供"新建任务"高亮快捷操作入口（支持 ⌘N 快捷键）；
 * 3. 组织"工作台"核心导航菜单（任务、运行记录、结果、运行环境），实时反映高亮项与任务数量统计角标；
 * 4. 底部提供唤起系统设置对话框入口以及一键外观主题（浅色/深色/跟随系统）切换按钮。
 */
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
        {item("results", "table", "结果")}
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
