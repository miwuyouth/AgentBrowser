import type { AppState, TaskItem } from "../../shared.ts";
import { emptyState, escapeHtml, icon, moreMenu, status } from "../ui.ts";

/** 跨整页重渲染保留筛选与搜索状态（运行事件推送会触发整页重建，不能让用户刚输入的内容消失） */
let lastFilter: "all" | "cron" | "manual" | "fail" = "all";
let lastSearchQuery = "";

type Filter = "all" | "cron" | "manual" | "fail";

/** 任务状态 → 语义标记 */
function taskStatus(t: TaskItem): string {
  switch (t.lastStatus) {
    case "ok":
      return status("ok", "上次成功");
    case "run":
      return status("run", "运行中");
    case "fail":
      return status("fail", "上次失败");
    default:
      return status("idle", "未运行");
  }
}

export function renderTasksView(
  state: AppState,
  onNavigate: (view: "tasks" | "editor" | "live" | "runs" | "kernels" | "profiles", taskId?: string) => void,
  onRunTask: (taskId: string) => void | Promise<void>,
  onDeleteTask: (taskId: string) => void,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  let filter: Filter = lastFilter;
  let searchQuery = lastSearchQuery;

  const renderContent = () => {
    // 重建前记录搜索框焦点：innerHTML 重建会丢焦点，否则用户每敲一个字就被打断
    const searchWasFocused = document.activeElement === container.querySelector("#tasks-search");

    const tasks = state.tasks || [];
    const cronCount = tasks.filter((t) => t.mode === "cron").length;
    const manualCount = tasks.filter((t) => t.mode === "now" || t.schedule === "手动").length;
    const runningCount = tasks.filter((t) => t.lastStatus === "run").length;
    const failCount = tasks.filter((t) => t.lastStatus === "fail").length;

    let filteredTasks = tasks.filter((t) => {
      if (filter === "cron" && t.mode !== "cron") return false;
      if (filter === "manual" && t.mode !== "now" && t.schedule !== "手动") return false;
      if (filter === "fail" && t.lastStatus !== "fail") return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return t.name.toLowerCase().includes(q) || t.goal.toLowerCase().includes(q);
      }
      return true;
    });

    const activeRun = state.activeRun;
    const runningTask = tasks.find((t) => t.lastStatus === "run");
    const bannerName = activeRun?.name || runningTask?.name;
    const bannerStep = activeRun?.steps[activeRun.steps.length - 1];
    const elapsed = activeRun?.facts.find((f) => f.k === "用时")?.v;

    const summary = [
      `${tasks.length} 个任务`,
      cronCount > 0 ? `${cronCount} 个定时` : null,
      runningCount > 0 ? `${runningCount} 个运行中` : null,
    ]
      .filter(Boolean)
      .join(" · ");

    // 空列表时不要再说「选一个任务运行」—— 此时没有任务可选
    const subline =
      tasks.length === 0
        ? "用自然语言描述一件要在网页里完成的事，Agent 会在浏览器里一步步做完。"
        : `${summary}。选一个任务运行，或编辑它的目标与执行方式。`;

    const tab = (key: Filter, label: string, count: number) => `
      <button type="button" class="tab ${filter === key ? "active" : ""}" data-filter="${key}" role="tab"
        aria-selected="${filter === key}">${label}<span class="tab-count">${count}</span></button>
    `;

    const taskRow = (t: TaskItem) => {
      const running = t.lastStatus === "run";
      const meta = [
        `<span>${escapeHtml(t.kernel)} · ${escapeHtml(t.profile)}</span>`,
        `<span class="mono">${escapeHtml(t.schedule || "手动")}</span>`,
        t.lastRunTime ? `<span>上次 ${escapeHtml(t.lastRunTime)}</span>` : "",
        t.lastDuration ? `<span class="mono">${escapeHtml(t.lastDuration)}</span>` : "",
      ]
        .filter(Boolean)
        .join('<span class="meta-sep">·</span>');

      return `
        <div class="task-row">
          <div class="task-main">
            <div class="task-title">
              <span class="clamp-2" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
              ${taskStatus(t)}
            </div>
            <div class="task-goal ellipsis" title="${escapeHtml(t.goal)}">${escapeHtml(t.goal || "未填写目标")}</div>
            <div class="task-meta">${meta}</div>
          </div>

          <div class="task-actions">
            ${
              running
                ? `<button type="button" class="btn btn-secondary btn-sm btn-watch" data-id="${t.id}">查看进度</button>`
                : `<button type="button" class="btn btn-primary btn-sm btn-run-now" data-id="${t.id}">${icon("play", 12)}运行</button>`
            }
            <button type="button" class="btn btn-ghost btn-sm btn-edit" data-id="${t.id}">编辑</button>
            ${moreMenu(
              `<button type="button" class="menu-item menu-item-danger btn-delete" data-id="${t.id}">${icon("trash", 14)}删除任务</button>`,
              "任务操作",
            )}
          </div>
        </div>
      `;
    };

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            <h1>任务</h1>
            <p class="page-sub">${subline}</p>
          </div>
          <div class="page-actions">
            <div class="search">
              ${icon("search", 15)}
              <input type="search" id="tasks-search" placeholder="搜索任务名或目标" value="${escapeHtml(searchQuery)}" aria-label="搜索任务" />
            </div>
          </div>
        </header>

        ${
          bannerName
            ? `
          <button type="button" class="running-banner" id="banner-running-task">
            <span class="spinner"></span>
            <span class="running-main">
              <span class="running-name">${escapeHtml(bannerName)}</span>
              <span class="running-step ellipsis">${
                bannerStep ? escapeHtml(bannerStep.text) : "正在启动浏览器，准备执行…"
              }</span>
            </span>
            <span class="meta mono">${elapsed ? `已用 ${escapeHtml(elapsed)}` : ""}</span>
            <span class="running-cta">查看实时过程${icon("chevronRight", 14)}</span>
          </button>
        `
            : ""
        }

        <div class="tabs" role="tablist" aria-label="任务筛选">
          ${tab("all", "全部", tasks.length)}
          ${tab("cron", "定时", cronCount)}
          ${tab("manual", "手动", manualCount)}
          ${tab("fail", "最近失败", failCount)}
        </div>

        <div class="panel">
          ${
            filteredTasks.length > 0
              ? `<div class="list">${filteredTasks.map(taskRow).join("")}</div>`
              : tasks.length === 0
                ? emptyState({
                    icon: "tasks",
                    title: "还没有任务",
                    desc: "新建后，这里会显示每个任务的运行状态、上次结果与下次执行时间。可以从每日签到、价格监控这类小任务开始。",
                    actions: `<button type="button" class="btn btn-primary" id="btn-create-first-task">${icon("plus", 15)}新建任务</button>`,
                  })
                : emptyState({
                    icon: "search",
                    title: "没有符合条件的任务",
                    desc: "换个关键词，或清除当前的筛选条件。",
                    actions: `<button type="button" class="btn btn-secondary" id="btn-clear-filter">清除筛选</button>`,
                  })
          }
        </div>
      </div>
    `;

    // ---- 事件 ----
    container.querySelector("#btn-create-first-task")?.addEventListener("click", () => onNavigate("editor"));
    container.querySelector("#btn-clear-filter")?.addEventListener("click", () => {
      filter = "all";
      lastFilter = "all";
      searchQuery = "";
      lastSearchQuery = "";
      renderContent();
    });
    container.querySelector("#banner-running-task")?.addEventListener("click", () => onNavigate("live"));

    const searchInput = container.querySelector<HTMLInputElement>("#tasks-search");
    searchInput?.addEventListener("input", (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      lastSearchQuery = searchQuery;
      renderContent();
    });
    if (searchWasFocused && searchInput) {
      searchInput.focus();
      searchInput.setSelectionRange(searchInput.value.length, searchInput.value.length);
    }

    container.querySelectorAll<HTMLButtonElement>(".tab").forEach((el) => {
      el.addEventListener("click", () => {
        filter = el.getAttribute("data-filter") as Filter;
        lastFilter = filter;
        renderContent();
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-run-now").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.getAttribute("data-id");
        if (!id) return;
        // 启动失败时留在列表页（Toast 已说明原因），不要跳到一个空白的监控页
        try {
          await onRunTask(id);
          onNavigate("live", id);
        } catch {
          /* 错误已在上层提示 */
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-watch").forEach((btn) => {
      btn.addEventListener("click", () => onNavigate("live"));
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-edit").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) onNavigate("editor", id);
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-delete").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        const task = tasks.find((t) => t.id === id);
        if (id && confirm(`删除任务「${task?.name || id}」？运行记录会保留。`)) {
          onDeleteTask(id);
        }
      });
    });
  };

  renderContent();
  return container;
}
