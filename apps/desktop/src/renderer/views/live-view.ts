import type { AppState, RunRecord } from "../../shared.ts";
import { emptyState, escapeHtml, icon, status } from "../ui.ts";

/** 整页重渲染（每个新步骤都会触发）后保持「显示思考过程」的展开状态 */
let lastShowThinking = false;

export function renderLiveView(
  state: AppState,
  onNavigate: (view: "tasks" | "editor" | "live" | "runs" | "kernels" | "profiles", taskId?: string) => void,
  onCancel: () => void,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  let showThinking = lastShowThinking;

  const renderContent = () => {
    const run: RunRecord | null = state.activeRun || null;
    const fallbackRun = !run && state.runs?.length ? state.runs[0]! : null;
    const current = run || fallbackRun;

    // 1) 正在启动，但还没有步骤：告诉用户「正在进行」，不要显示成「什么都没发生」
    if (!current && state.running) {
      container.innerHTML = `
        <div class="page-inner">
          <header class="page-head">
            <div class="page-head-main">
              <h1>执行监控</h1>
              <p class="page-sub">Agent 正在启动浏览器并准备执行任务。</p>
            </div>
          </header>
          <div class="panel">
            <div class="empty">
              <span class="spinner" style="width: 22px; height: 22px; border-width: 2.5px;"></span>
              <h3 class="empty-title" style="margin-top: 6px;">正在启动…</h3>
              <p class="empty-desc">浏览器窗口即将打开，第一步开始后这里会显示实时画面与步骤。</p>
              <div class="empty-actions">
                <button type="button" class="btn btn-secondary" id="btn-cancel-starting">取消执行</button>
              </div>
            </div>
          </div>
        </div>
      `;
      container.querySelector("#btn-cancel-starting")?.addEventListener("click", () => {
        if (confirm("确定要取消这次执行吗？")) onCancel();
      });
      return;
    }

    // 2) 什么都没有：说明这里会出现什么，并给出入口
    if (!current) {
      container.innerHTML = `
        <div class="page-inner">
          <header class="page-head">
            <div class="page-head-main">
              <h1>执行监控</h1>
              <p class="page-sub">实时观察 Agent 在浏览器里的每一步：截图、动作与思考。</p>
            </div>
          </header>
          <div class="panel">
            ${emptyState({
              icon: "play",
              title: "当前没有任务在运行",
              desc: "在任务列表里选一个任务点「运行」，这里会显示浏览器的实时画面与每一步动作。",
              actions: `
                <button type="button" class="btn btn-primary" id="btn-empty-tasks">前往任务列表</button>
                <button type="button" class="btn btn-ghost" id="btn-empty-new">新建任务</button>
              `,
            })}
          </div>
        </div>
      `;
      container.querySelector("#btn-empty-tasks")?.addEventListener("click", () => onNavigate("tasks"));
      container.querySelector("#btn-empty-new")?.addEventListener("click", () => onNavigate("editor"));
      return;
    }

    const isRunning = current.status === "run" && !!run;
    const isLive = !!run;
    const doneSteps = current.steps.filter((s) => s.status === "done" || s.status === "run").length;
    const kernelFact = current.facts.find((f) => f.k === "内核")?.v || "Chromium";
    const profileFact = current.facts.find((f) => f.k === "Profile")?.v || "默认 Profile";
    const durationFact = current.facts.find((f) => f.k === "用时")?.v || "00:00";

    const task = current.taskId ? state.tasks.find((t) => t.id === current.taskId) : null;
    const currentUrl = task?.url || "about:blank";
    const latestScreenshot = current.steps.slice().reverse().find((s) => s.screenshot)?.screenshot;
    const stepLimit = task?.maxSteps || 30;

    const statusEl = isRunning
      ? status("run", "运行中")
      : current.status === "ok"
        ? status("ok", "已完成")
        : status("fail", "失败");

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            ${
              !isLive
                ? `<button type="button" class="back-link" id="breadcrumb-runs">${icon("arrowLeft", 14)}运行记录 · #${escapeHtml(current.id)}</button>`
                : ""
            }
            <h1>${escapeHtml(current.name)} ${statusEl}</h1>
            <div class="meta">
              <span>${escapeHtml(kernelFact)} · Profile「${escapeHtml(profileFact)}」</span>
              <span class="meta-sep">·</span>
              <span>${escapeHtml(current.trigger || "手动触发")}</span>
              <span class="meta-sep">·</span>
              <span class="mono">已用 ${escapeHtml(durationFact)}</span>
            </div>
          </div>

          <div class="page-actions">
            ${
              isRunning
                ? `<button type="button" class="btn btn-danger" id="btn-stop">${icon("stop", 13)}停止任务</button>`
                : `
              <button type="button" class="btn btn-secondary" id="btn-to-runs">查看完整记录</button>
              ${current.taskId ? `<button type="button" class="btn btn-ghost" id="btn-edit-task">编辑任务</button>` : ""}
            `
            }
          </div>
        </header>

        ${
          !isLive
            ? `
          <div class="notice">
            <span>当前没有任务在运行，下面是最近一次运行（#${escapeHtml(current.id)}）的过程。</span>
            <button type="button" class="btn btn-ghost btn-sm" id="btn-back-to-tasks">返回任务列表</button>
          </div>
        `
            : ""
        }

        <div class="live-grid">
          <!-- 左：浏览器实时画面 -->
          <section class="browser-panel" aria-label="浏览器实时画面">
            <div class="browser-bar">
              ${icon("lock", 14)}
              <span class="browser-url" title="${escapeHtml(currentUrl)}">${escapeHtml(currentUrl)}</span>
              <span class="tag">${escapeHtml(kernelFact)}</span>
            </div>
            <div class="browser-stage">
              ${
                latestScreenshot
                  ? `<img src="${latestScreenshot}" alt="网页实时截图" />`
                  : `<div class="stage-empty">
                      ${icon("browser", 24)}
                      <span>${isRunning ? "浏览器已连接，Agent 正在操作，第一张截图马上出现" : "这次运行没有留下页面截图"}</span>
                    </div>`
              }
            </div>
          </section>

          <!-- 右：执行步骤 -->
          <section class="steps-panel" aria-label="执行步骤">
            <div class="steps-head">
              <span class="steps-title">
                ${isRunning ? '<span class="spinner"></span>' : ""}
                执行步骤
                <span class="mono" style="color: var(--text-muted); font-size: 12px; font-weight: 400;">
                  第 ${doneSteps} 步${isRunning ? ` · 上限 ${stepLimit} 步` : ` · 共 ${current.steps.length} 步`}
                </span>
              </span>
              <button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-think">
                ${showThinking ? "隐藏思考" : "显示思考"}
              </button>
            </div>

            ${
              current.steps.length === 0
                ? `<p class="field-hint">${isRunning ? "正在等待第一步…" : "这次运行没有记录步骤。"}</p>`
                : `<ol class="timeline">
                    ${current.steps
                      .map((s, idx) => {
                        const isLast = idx === current.steps.length - 1;
                        return `
                        <li class="step">
                          <span class="step-rail">
                            <span class="step-dot ${s.status}"></span>
                            ${isLast ? "" : '<span class="step-line"></span>'}
                          </span>
                          <div class="step-body">
                            <div class="step-line-top">
                              <span class="step-tag">${escapeHtml(s.tag)}</span>
                              <span class="step-text ${s.status === "todo" ? "dim" : s.status === "run" ? "run" : ""}">${escapeHtml(s.text)}</span>
                            </div>
                            ${showThinking && s.think ? `<div class="think-box">${escapeHtml(s.think)}</div>` : ""}
                            <span class="step-meta">${escapeHtml(s.meta)}</span>
                          </div>
                        </li>
                      `;
                      })
                      .join("")}
                  </ol>`
            }
          </section>
        </div>
      </div>
    `;

    // ---- 事件 ----
    container.querySelector("#breadcrumb-runs")?.addEventListener("click", () => onNavigate("runs"));
    container.querySelector("#btn-to-runs")?.addEventListener("click", () => onNavigate("runs"));
    container.querySelector("#btn-back-to-tasks")?.addEventListener("click", () => onNavigate("tasks"));

    container.querySelector("#btn-edit-task")?.addEventListener("click", () => {
      if (current.taskId) onNavigate("editor", current.taskId);
    });

    container.querySelector("#btn-stop")?.addEventListener("click", () => {
      if (confirm("停止后当前这一步会中断，已完成的步骤仍会保存。确定停止吗？")) onCancel();
    });

    container.querySelector("#btn-toggle-think")?.addEventListener("click", () => {
      showThinking = !showThinking;
      lastShowThinking = showThinking;
      renderContent();
    });
  };

  renderContent();
  return container;
}
