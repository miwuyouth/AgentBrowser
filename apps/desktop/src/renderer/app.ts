import type { AgentApi, AppState, UiEvent } from "../shared.ts";
import { initTheme } from "./theme.ts";
import { escapeHtml, icon } from "./ui.ts";
import { renderEditorView } from "./views/editor-view.ts";
import { renderKernelsView } from "./views/kernels-view.ts";
import { renderLiveView } from "./views/live-view.ts";
import { renderSidebar, type ViewType } from "./views/nav.ts";
import { renderProfilesView } from "./views/profiles-view.ts";
import { renderRunsView } from "./views/runs-view.ts";
import { SettingsModalController } from "./views/settings-modal.ts";
import { renderTasksView } from "./views/tasks-view.ts";

declare global {
  interface Window {
    agentApi: AgentApi;
  }
}

const api = window.agentApi;
const appEl = document.getElementById("app") as HTMLElement;
const toastContainer = document.getElementById("toast-container") as HTMLElement;

let state: AppState | null = null;
let currentView: ViewType = "tasks";
let editingTaskId: string | undefined = undefined;
/** 上一次实际渲染的视图（用于判断是否同视图重渲染，从而恢复滚动/焦点） */
let lastRenderedView: ViewType | null = null;

let settingsModal: SettingsModalController;

/** 弹出 Toast 提示框 */
function showToast(message: string, isError = false) {
  const toast = document.createElement("div");
  toast.className = `toast ${isError ? "toast-error" : ""}`;
  toast.setAttribute("role", isError ? "alert" : "status");
  toast.innerHTML = `${isError ? icon("alert", 14) : ""}<span>${escapeHtml(message)}</span>`;
  toastContainer.append(toast);
  setTimeout(() => {
    toast.style.opacity = "0";
    toast.style.transition = "opacity 0.2s";
    setTimeout(() => toast.remove(), 200);
  }, 3200);
}

/** 测试指定浏览器内核及对应 Profile */
async function handleTestBrowser(kernelId: string, profileId?: string) {
  showToast("正在测试启动浏览器内核与对应 Profile…");
  const res = await api.testBrowser(kernelId, profileId);
  showToast(res.message, !res.ok);
}

/** 手动打开指定浏览器内核及对应 Profile */
async function handleOpenBrowser(kernelId: string, profileId?: string, url?: string) {
  showToast("正在启动浏览器窗口…");
  const res = await api.openBrowser(kernelId, profileId, url);
  showToast(res.message, !res.ok);
}

/** 页面路由导航 */
function navigate(view: ViewType, taskId?: string) {
  currentView = view;
  editingTaskId = taskId;
  renderApp();
}

/** 渲染全局应用界面；任何异常都转成可见的错误面板，避免整页变成“点了没反应”的空白 */
function renderApp() {
  try {
    renderAppInner();
  } catch (err) {
    console.error("渲染界面失败", err);
    const fallback = renderViewError(err instanceof Error ? err.message : String(err));
    const stale = appEl.querySelector<HTMLElement>(":scope > .page");
    if (stale) stale.replaceWith(fallback);
    else appEl.append(fallback);
  }
}

/** 渲染失败时的兜底页面：说明原因并给出回到任务列表的入口 */
function renderViewError(message: string): HTMLElement {
  const main = document.createElement("main");
  main.className = "page";
  main.innerHTML = `
    <div class="page-inner">
      <div class="panel">
        <div class="empty">
          <div class="empty-icon">${icon("alert", 22)}</div>
          <h3 class="empty-title">这个页面没能渲染出来</h3>
          <p class="empty-desc">${escapeHtml(message || "未知错误")}</p>
          <div class="empty-actions">
            <button type="button" class="btn btn-primary" id="btn-render-error-back">返回任务列表</button>
          </div>
        </div>
      </div>
    </div>
  `;
  main.querySelector("#btn-render-error-back")?.addEventListener("click", () => navigate("tasks"));
  return main;
}

/** 实际渲染逻辑 */
function renderAppInner() {
  if (!state) return;

  // ---- 重建前：记录滚动位置与焦点，避免“页面像被刷新” ----
  const prevMain = appEl.querySelector<HTMLElement>(":scope > .page");
  const prevScrollTop = prevMain?.scrollTop ?? 0;
  const prevScrollLeft = prevMain?.scrollLeft ?? 0;
  // live 视图：若用户原本停留在底部附近，新步骤到来后继续跟随到底部
  const wasNearBottom = prevMain
    ? prevMain.scrollHeight - prevMain.scrollTop - prevMain.clientHeight < 64
    : false;

  const prevActive = document.activeElement;
  const activeId =
    prevActive instanceof HTMLElement && appEl.contains(prevActive) ? prevActive.id : "";
  const selStart =
    prevActive instanceof HTMLInputElement || prevActive instanceof HTMLTextAreaElement
      ? prevActive.selectionStart
      : null;
  const selEnd =
    prevActive instanceof HTMLInputElement || prevActive instanceof HTMLTextAreaElement
      ? prevActive.selectionEnd
      : null;

  // 1. 渲染左侧导航栏：内容没变化就保留原节点。
  //    任务运行时每秒都会推送状态并重渲染，如果在「按下」与「抬起」之间把按钮换掉，
  //    浏览器就不会派发 click —— 用户看到的就是「点了没反应」。
  const nextSidebar = renderSidebar(
    state,
    currentView,
    (v, tId) => navigate(v, tId),
    () => {
      if (state) settingsModal.open(state);
    },
  );
  const prevSidebar = appEl.querySelector<HTMLElement>(":scope > .sidebar");
  if (!prevSidebar) {
    appEl.prepend(nextSidebar);
  } else if (prevSidebar.outerHTML !== nextSidebar.outerHTML) {
    prevSidebar.replaceWith(nextSidebar);
  }

  // 2. 根据当前视图渲染主视图
  let mainView: HTMLElement;

  switch (currentView) {
    case "tasks":
      mainView = renderTasksView(
        state,
        (v, tId) => navigate(v, tId),
        async (taskId) => {
          try {
            await api.runTask(taskId);
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
            throw err;
          }
        },
        async (taskId) => {
          try {
            await api.deleteTask(taskId);
            showToast("任务已删除");
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
          }
        },
      );
      break;

    case "editor":
      mainView = renderEditorView(
        state,
        editingTaskId,
        (v, tId) => navigate(v, tId),
        async (taskData, runImmediately) => {
          try {
            const saved = await api.saveTask(taskData);
            showToast(editingTaskId ? "任务已更新" : "任务已创建");
            if (runImmediately && saved.id) {
              await api.runTask(saved.id);
            }
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
            // 保存失败就留在编辑页，不要带着未保存的修改跳走
            throw err;
          }
        },
        () => {
          if (state) settingsModal.open(state);
        },
        (kernelId, profileId) => handleTestBrowser(kernelId, profileId),
        (kernelId, profileId, url) => handleOpenBrowser(kernelId, profileId, url),
        async (kernelId, name) => {
          try {
            const created = await api.createProfile(kernelId, name);
            showToast(`已创建 Profile「${created.name}」`);
            return created;
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
            throw err;
          }
        },
      );
      break;

    case "live":
      mainView = renderLiveView(
        state,
        (v, tId) => navigate(v, tId),
        () => void api.cancelTask(),
      );
      break;

    case "runs":
      mainView = renderRunsView(
        state,
        (v, tId) => navigate(v, tId),
        async (taskId) => {
          try {
            await api.runTask(taskId);
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
            throw err;
          }
        },
        (text) => void api.copyText(text),
      );
      break;

    case "kernels":
      mainView = renderKernelsView(
        state,
        async (kernelId) => {
          await api.setDefaultKernel(kernelId);
          showToast("已更新默认浏览器内核");
        },
        async () => {
          const rescanned = await api.rescanKernels();
          if (state) state.kernels = rescanned;
          renderApp();
          showToast("已重新扫描系统浏览器内核");
        },
        (kernelId, profileId) => void handleTestBrowser(kernelId, profileId),
        (kernelId, profileId) => void handleOpenBrowser(kernelId, profileId),
      );
      break;

    case "profiles":
      mainView = renderProfilesView(
        state,
        async (kernelId, name) => {
          try {
            const created = await api.createProfile(kernelId, name);
            showToast(`已为「${created.kernel}」创建 Profile「${created.name}」`);
            return created;
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
            throw err;
          }
        },
        async (pData) => {
          await api.saveProfile(pData);
          showToast("Profile 已保存");
        },
        async (id) => {
          try {
            await api.deleteProfile(id);
            showToast("Profile 已删除");
          } catch (err) {
            showToast(String(err instanceof Error ? err.message : err), true);
          }
        },
        (kernelId, profileId) => handleOpenBrowser(kernelId, profileId),
        (kernelId, profileId) => handleTestBrowser(kernelId, profileId),
        async (dirPath) => {
          await api.showInFolder(dirPath);
        },
      );
      break;
  }

  // ---- 内容没变就保留原节点：既不打断焦点/滚动，也不会把点击目标换掉 ----
  const unchanged = !!prevMain && prevMain.outerHTML === mainView.outerHTML;

  if (unchanged) {
    lastRenderedView = currentView;
    return;
  }

  if (prevMain) prevMain.replaceWith(mainView);
  else appEl.append(mainView);

  // ---- 重建后：同一视图才恢复滚动位置与焦点 ----
  const sameView = lastRenderedView === currentView;
  if (sameView) {
    if (currentView === "live" && wasNearBottom) {
      mainView.scrollTop = mainView.scrollHeight;
    } else {
      mainView.scrollTop = prevScrollTop;
      mainView.scrollLeft = prevScrollLeft;
    }
    if (activeId) {
      const next = mainView.querySelector<HTMLElement>(`#${CSS.escape(activeId)}`);
      if (
        next instanceof HTMLInputElement ||
        next instanceof HTMLTextAreaElement ||
        next instanceof HTMLSelectElement
      ) {
        next.focus();
        if (next instanceof HTMLInputElement && selStart !== null) {
          next.setSelectionRange(selStart, selEnd ?? selStart);
        }
      }
    }
  }
  lastRenderedView = currentView;
}

/** 监听主进程派发的 UI 事件流 */
function onEvent(e: UiEvent) {
  switch (e.type) {
    case "state":
      state = e.state;
      // 编辑页是未保存的表单，状态推送（如后台任务完成）若触发整页重建会丢失输入内容
      if (currentView !== "editor") {
        renderApp();
      }
      break;

    case "notice":
      showToast(e.message, e.isError);
      break;

    case "run_update":
      if (state) {
        state.activeRun = e.run;
        if (currentView === "live" || currentView === "tasks") {
          renderApp();
        }
      }
      break;

    case "run_step":
      if (state && state.activeRun && state.activeRun.id === e.runId) {
        state.activeRun.steps.push(e.step);
        if (currentView === "live") renderApp();
      }
      break;

    case "run_screenshot":
      if (state && state.activeRun && state.activeRun.id === e.runId) {
        const lastStep = state.activeRun.steps[state.activeRun.steps.length - 1];
        if (lastStep) lastStep.screenshot = e.screenshot;
        if (currentView === "live") renderApp();
      }
      break;
  }
}

// 初始化
initTheme();
api.onEvent(onEvent);

/** 「更多」菜单：点击别处或按 Esc 关闭，避免浮层留在屏幕上 */
function closeOpenMenus(except?: Node | null) {
  document.querySelectorAll<HTMLDetailsElement>("details.menu[open]").forEach((el) => {
    if (except && el.contains(except)) return;
    el.open = false;
  });
}

document.addEventListener("click", (e) => {
  const target = e.target as HTMLElement | null;
  // 选中菜单项后立即收起浮层
  if (target?.closest?.(".menu-item")) {
    closeOpenMenus();
    return;
  }
  closeOpenMenus(target);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeOpenMenus();
});

settingsModal = new SettingsModalController(api, (newState) => {
  state = newState;
  // 同上：设置保存发生在编辑页上时，不重建表单，仅更新侧边栏数据
  if (currentView !== "editor") {
    renderApp();
  }
  showToast("设置已保存");
});

void api.getState().then((s) => {
  state = s;
  renderApp();
});
