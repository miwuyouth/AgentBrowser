import type { AppState, RunRecord } from "../../shared.ts";
import { emptyState, escapeHtml, icon, status } from "../ui.ts";

/** 跨整页重渲染记住选中的运行记录、筛选状态与搜索词 */
let lastSelectedId = "";
let lastFilter: "all" | "ok" | "fail" | "run" = "all";
let lastSearchQuery = "";

type RunFilter = "all" | "ok" | "fail" | "run";

function runStatus(r: RunRecord): string {
  if (r.status === "run") return status("run", "运行中");
  if (r.status === "ok") return status("ok", "成功");
  return status("fail", "失败");
}

export function renderRunsView(
  state: AppState,
  onNavigate: (view: "tasks" | "editor" | "live" | "runs" | "kernels" | "profiles", taskId?: string) => void,
  onRunTask: (taskId: string) => void | Promise<void>,
  onCopyText: (text: string) => void,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  let filter: RunFilter = lastFilter;
  let searchQuery = lastSearchQuery;
  let selectedId = lastSelectedId || state.runs?.[0]?.id || "";

  const renderContent = () => {
    const searchWasFocused = document.activeElement === container.querySelector("#runs-search");

    const runs = state.runs || [];

    if (runs.length === 0) {
      container.innerHTML = `
        <div class="page-inner">
          <header class="page-head">
            <div class="page-head-main">
              <h1>运行记录</h1>
              <p class="page-sub">每次执行的结果、Agent 返回的内容与完整步骤都保存在这里。</p>
            </div>
          </header>
          <div class="panel">
            ${emptyState({
              icon: "runs",
              title: "暂无运行记录",
              desc: "在任务列表里点「运行」后，这次执行的步骤、截图与结果会自动记录在这里。",
              actions: `<button type="button" class="btn btn-primary" id="btn-empty-goto-tasks">查看任务列表</button>`,
            })}
          </div>
        </div>
      `;
      container.querySelector("#btn-empty-goto-tasks")?.addEventListener("click", () => onNavigate("tasks"));
      return;
    }

    const okCount = runs.filter((r) => r.status === "ok").length;
    const failCount = runs.filter((r) => r.status === "fail").length;
    const runCount = runs.filter((r) => r.status === "run").length;

    const filteredRuns = runs.filter((r) => {
      if (filter === "ok" && r.status !== "ok") return false;
      if (filter === "fail" && r.status !== "fail") return false;
      if (filter === "run" && r.status !== "run") return false;
      if (searchQuery) {
        const q = searchQuery.toLowerCase();
        return (
          r.name.toLowerCase().includes(q) ||
          r.summary.toLowerCase().includes(q) ||
          (r.error ? r.error.toLowerCase().includes(q) : false)
        );
      }
      return true;
    });

    if (selectedId && !runs.some((r) => r.id === selectedId)) {
      selectedId = runs[0]!.id;
    }
    const cur = runs.find((r) => r.id === selectedId);

    const tab = (key: RunFilter, label: string, count: number) => `
      <button type="button" class="tab ${filter === key ? "active" : ""}" data-filter="${key}" role="tab"
        aria-selected="${filter === key}">${label}<span class="tab-count">${count}</span></button>
    `;

    const runRow = (r: RunRecord) => {
      const isSelected = r.id === selectedId;
      const factsSummary = r.facts
        .map(
          (f) =>
            `<span class="meta-sep">·</span><span>${escapeHtml(f.k)} <span class="mono">${escapeHtml(f.v)}</span></span>`,
        )
        .join("");

      return `
        <div class="run-row list-item ${isSelected ? "active expanded" : ""}" data-id="${escapeHtml(r.id)}" ${isSelected ? 'aria-current="true"' : ""}>
          <div class="run-row-header" data-id="${escapeHtml(r.id)}">
            <div class="run-main">
              <div class="run-title">
                <span class="run-name clamp-2" title="${escapeHtml(r.name)}">${escapeHtml(r.name)}</span>
                ${runStatus(r)}
                <span class="mono run-id">#${escapeHtml(r.id)}</span>
              </div>
              <div class="run-meta">
                <span>${escapeHtml(r.when)}</span>
                <span class="meta-sep">·</span>
                <span>${escapeHtml(r.trigger)}</span>
                ${factsSummary}
              </div>
              ${
                !isSelected
                  ? `
                <div class="run-preview ellipsis" title="${escapeHtml(r.summary || r.error || "")}">
                  ${
                    r.hasError
                      ? `<span class="run-preview-error">${icon("alert", 13)}失败原因：${escapeHtml(r.error || "未知异常")}</span>`
                      : `<span class="run-preview-text">${escapeHtml(r.summary || "这次运行没有返回内容。")}</span>`
                  }
                </div>
              `
                  : ""
              }
            </div>

            <div class="run-actions">
              <button type="button" class="btn btn-ghost btn-sm btn-copy-result" ${isSelected ? 'id="btn-copy-result"' : ""} data-id="${escapeHtml(r.id)}" title="复制 Agent 返回的结果">
                ${icon("copy", 14)}复制结果
              </button>
              ${
                r.taskId
                  ? `
                <button type="button" class="btn btn-primary btn-sm btn-rerun-task" ${isSelected ? 'id="btn-rerun-task"' : ""} data-id="${escapeHtml(r.id)}" title="再次执行该任务">
                  ${icon("play", 12)}再次执行
                </button>
              `
                  : ""
              }
              <button type="button" class="btn btn-ghost btn-sm btn-toggle-detail" data-id="${escapeHtml(r.id)}" aria-label="${isSelected ? "收起详情" : "展开详情"}">
                <span>${isSelected ? "收起" : "详情"}</span>
                ${icon(isSelected ? "chevronUp" : "chevronDown", 14)}
              </button>
            </div>
          </div>

          ${
            isSelected
              ? `
            <div class="run-detail detail">
              <div class="facts">
                ${r.facts
                  .map(
                    (f) => `
                  <div class="fact">
                    <span class="fact-k">${escapeHtml(f.k)}</span>
                    <span class="fact-v" title="${escapeHtml(f.v)}">${escapeHtml(f.v)}</span>
                  </div>
                `,
                  )
                  .join("")}
              </div>

              <div class="divider"></div>

              <section class="section">
                <div class="section-head">
                  <h3 class="section-title">Agent 返回的结果</h3>
                </div>
                <p class="result-text">${escapeHtml(r.summary || "这次运行没有返回内容。")}</p>

                ${
                  r.hasError
                    ? `
                  <div class="error-box">
                    <div class="error-title">${icon("alert", 14)}失败原因：${escapeHtml(r.error || "未知异常")}</div>
                    <div class="error-body">${escapeHtml(r.advice || "建议检查浏览器内核与 Profile 是否可用，或调整任务目标后重试。")}</div>
                    ${
                      r.taskId
                        ? `
                      <div class="page-actions" style="margin-top: 4px;">
                        <button type="button" class="btn btn-secondary btn-sm" id="btn-adjust-task" data-id="${escapeHtml(r.id)}">调整任务设置</button>
                        <button type="button" class="btn btn-ghost btn-sm" id="btn-retry-task" data-id="${escapeHtml(r.id)}">${icon("refresh", 14)}重试</button>
                      </div>
                    `
                        : ""
                    }
                  </div>
                `
                    : ""
                }
              </section>
            </div>
          `
              : ""
          }
        </div>
      `;
    };

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            <h1>运行记录</h1>
            <p class="page-sub">共 ${runs.length} 次运行。点击展开查看执行详情、Agent 返回结果与失败原因。</p>
          </div>
          <div class="page-actions">
            <div class="search">
              ${icon("search", 15)}
              <input type="search" id="runs-search" placeholder="搜索任务名、结果或失败原因" value="${escapeHtml(searchQuery)}" aria-label="搜索运行记录" />
            </div>
          </div>
        </header>

        <div class="tabs" role="tablist" aria-label="运行记录筛选">
          ${tab("all", "全部", runs.length)}
          ${tab("ok", "成功", okCount)}
          ${tab("fail", "失败", failCount)}
          ${tab("run", "运行中", runCount)}
        </div>

        <div class="panel">
          ${
            filteredRuns.length > 0
              ? `<div class="list" aria-label="运行列表">${filteredRuns.map(runRow).join("")}</div>`
              : emptyState({
                  icon: "search",
                  title: "没有符合条件的运行记录",
                  desc: "换个关键词，或清除当前的筛选条件。",
                  actions: `<button type="button" class="btn btn-secondary" id="btn-clear-filter">清除筛选</button>`,
                })
          }
        </div>
      </div>
    `;

    // ---- 事件绑定 ----
    const searchInput = container.querySelector<HTMLInputElement>("#runs-search");
    if (searchWasFocused && searchInput) {
      searchInput.focus();
      const len = searchInput.value.length;
      searchInput.setSelectionRange(len, len);
    }

    container.querySelector<HTMLInputElement>("#runs-search")?.addEventListener("input", (e) => {
      searchQuery = (e.target as HTMLInputElement).value;
      lastSearchQuery = searchQuery;
      renderContent();
    });

    container.querySelectorAll<HTMLButtonElement>(".tab").forEach((tabBtn) => {
      tabBtn.addEventListener("click", () => {
        const nextFilter = tabBtn.getAttribute("data-filter") as RunFilter;
        filter = nextFilter;
        lastFilter = nextFilter;
        renderContent();
      });
    });

    container.querySelector("#btn-clear-filter")?.addEventListener("click", () => {
      filter = "all";
      lastFilter = "all";
      searchQuery = "";
      lastSearchQuery = "";
      renderContent();
    });

    container.querySelectorAll<HTMLElement>(".list-item").forEach((item) => {
      item.addEventListener("click", (e) => {
        if ((e.target as HTMLElement | null)?.closest(".run-actions, .error-box button")) {
          return;
        }
        const id = item.getAttribute("data-id");
        if (id) {
          selectedId = selectedId === id ? "" : id;
          lastSelectedId = selectedId;
          renderContent();
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-toggle-detail").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id")!;
        selectedId = selectedId === id ? "" : id;
        lastSelectedId = selectedId;
        renderContent();
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-copy-result").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = btn.getAttribute("data-id");
        const r = runs.find((item) => item.id === id);
        onCopyText(r ? r.summary : "");
      });
    });

    const rerun = async (runId?: string) => {
      const targetRun = runs.find((item) => item.id === runId);
      if (!targetRun?.taskId) return;
      try {
        await onRunTask(targetRun.taskId);
        onNavigate("live", targetRun.taskId);
      } catch {
        /* 错误已在上层提示，留在当前页 */
      }
    };

    container.querySelectorAll<HTMLButtonElement>(".btn-rerun-task").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        void rerun(btn.getAttribute("data-id")!);
      });
    });

    container.querySelector("#btn-retry-task")?.addEventListener("click", () => {
      void rerun(cur?.id);
    });

    container.querySelector("#btn-adjust-task")?.addEventListener("click", () => {
      if (cur?.taskId) onNavigate("editor", cur.taskId);
    });
  };

  renderContent();
  return container;
}
