import { render } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { Onboarding } from "./onboarding.tsx";
import { getReadiness } from "./readiness.ts";
import { Sidebar, type Navigate, type View } from "./sidebar.tsx";
import { useAppState } from "./state.ts";
import { initTheme } from "./theme.ts";
import { ToastHost } from "./toast.tsx";
import { ConfirmHost, showAppPrompt } from "./confirm.tsx";
import { BackContext, type BackTarget } from "./page.tsx";
import type { AppState } from "../shared.ts";
import { SettingsModal, type SettingsTab } from "./views/settings-modal.tsx";
import { EnvView } from "./views/env-view.tsx";
import { EditorView } from "./views/editor-view.tsx";
import { LiveView } from "./views/live-view.tsx";
import { BatchView } from "./views/batch-view.tsx";
import { RunDetailView } from "./views/run-detail-view.tsx";
import { ResultsView } from "./views/results-view.tsx";
import { RunsView } from "./views/runs-view.tsx";
import { TasksView } from "./views/tasks-view.tsx";

/** 记录用户是否已完成过首次引导的 localStorage 键名 */
const ONBOARDED_KEY = "agent_browser_onboarded";

/** 一个页面：视图 + 可选的实体 ID */
type Route = { view: View; id?: string };

/** 导航历史最多记多少页，防止来回点击无限增长 */
const HISTORY_LIMIT = 50;

/**
 * 顶级页面（侧边栏直达）：跳到这里时清空历史，它们也不显示返回按钮。
 * 「结果」带不带任务 ID 都算顶级页：换任务用页面上的下拉框，不需要返回。
 */
function isTopLevel(r: Route): boolean {
  return r.view === "results" || ((r.view === "tasks" || r.view === "runs" || r.view === "env") && !r.id);
}

/**
 * 没有导航历史时（例如从系统通知直接打开）二级页面的上级页面。
 * 【调用时机】`Main` 计算返回目标、历史为空时调用。
 */
function parentOf(r: Route, state: AppState): Route | null {
  if (isTopLevel(r)) return null;
  switch (r.view) {
    case "editor":
    case "runs":
      return { view: "tasks" };
    case "run": {
      const batchId = state.runs.find((x) => x.id === r.id)?.batch?.id;
      return batchId ? { view: "batch", id: batchId } : { view: "runs" };
    }
    default:
      return { view: "runs" };
  }
}

/** 返回按钮上显示的上一页名称 */
function routeLabel(r: Route): string {
  switch (r.view) {
    case "tasks":
      return "任务";
    case "runs":
      return "运行记录";
    case "results":
      return "结果";
    case "env":
      return "运行环境";
    case "editor":
      return r.id ? "编辑任务" : "新建任务";
    case "run":
      return "运行详情";
    case "batch":
      return "这一轮";
    case "live":
      return "实时运行";
  }
}

/**
 * 桌面端应用主视图控制器组件。
 *
 * 【调用时机】
 * 由根组件 `App` 挂载渲染。
 *
 * 【作用】
 * 1. 订阅全局状态 Hook（`useAppState`）；
 * 2. 维护前端路由导航状态（当前页 `route` + 导航历史 `history`），分发路由跳转闭包 `go`，并通过 `BackContext` 给二级页面提供「< 返回上一页」；
 * 3. 首次加载时根据 `getReadiness` 与本地存储状态决定是否展示新手引导向导（`Onboarding`）；
 * 4. 监听全局快捷键（⌘N 新建任务、⌘, 打开设置），并响应系统通知点击跳到运行详情；
 * 5. 组装左侧 `Sidebar` 导航与右侧主视区视图切换（TasksView / EditorView / RunsView / RunDetailView / BatchView / LiveView / EnvView），并管理设置弹窗开闭。
 */
function Main() {
  const state = useAppState();
  const [nav, setNav] = useState<{ route: Route; history: Route[] }>({ route: { view: "tasks" }, history: [] });
  const { route, history } = nav;
  const go: Navigate = (view, id, opts) =>
    setNav(({ route: cur, history: hist }) => {
      const next: Route = { view, ...(id ? { id } : {}) };
      if (opts?.reset || isTopLevel(next)) return { route: next, history: [] };
      if (opts?.replace) return { route: next, history: hist };
      if (cur.view === next.view && cur.id === next.id) return { route: cur, history: hist };
      return { route: next, history: [...hist, cur].slice(-HISTORY_LIMIT) };
    });

  /** 「< 返回」的目标：有历史回到上一页，没有就回到上级页面；顶级页面为 null */
  let back: BackTarget | null = null;
  if (state && !isTopLevel(route)) {
    const prev = history.at(-1);
    if (prev) {
      back = { label: routeLabel(prev), onBack: () => setNav({ route: prev, history: history.slice(0, -1) }) };
    } else {
      const parent = parentOf(route, state);
      if (parent) back = { label: routeLabel(parent), onBack: () => go(parent.view, parent.id, { replace: true }) };
    }
  }
  /** 给只注册一次的快捷键监听读取最新的返回目标 */
  const backRef = useRef(back);
  backRef.current = back;
  /** 设置弹窗打开在哪个标签；null = 关闭 */
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  /** null = 还没拿到状态，暂时不决定要不要显示引导 */
  const [onboarding, setOnboarding] = useState<boolean | null>(null);

  // 第一次拿到状态时决定一次：已引导过、或者本来就全部就绪的老用户，不再打扰
  useEffect(() => {
    if (!state || onboarding !== null) return;
    const ready = getReadiness(state).all;
    if (ready) localStorage.setItem(ONBOARDED_KEY, "1");
    setOnboarding(localStorage.getItem(ONBOARDED_KEY) !== "1" && !ready);
  }, [state, onboarding]);

  // ⌘N：新建任务；⌘,：打开设置；⌘[：返回上一页
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "[") {
        if (!backRef.current || document.querySelector(".modal-overlay, .lightbox")) return;
        e.preventDefault();
        backRef.current.onBack();
      } else if (e.key === "n") {
        e.preventDefault();
        go("editor");
      } else if (e.key === ",") {
        e.preventDefault();
        setSettingsTab("general");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // 用户点了「任务完成」系统通知：跳到那次运行的详情；多 Profile 的一轮跳到这一轮的页面
  useEffect(
    () =>
      window.agentApi.onEvent((e) => {
        if (e.type !== "open_run") return;
        setSettingsTab(null);
        if (e.batchId) go("batch", e.batchId, { reset: true });
        else go("run", e.runId, { reset: true });
      }),
    [],
  );

  // 主进程要用户确认（退出前提醒、文件授权）：一律用应用内确认框，不用系统弹窗
  useEffect(() => {
    const off = window.agentApi.onEvent((e) => {
      if (e.type === "prompt") showAppPrompt(e.id, e.prompt);
    });
    void window.agentApi.pendingPrompts().then((list) => list.forEach((p) => showAppPrompt(p.id, p.prompt)));
    return off;
  }, []);

  if (!state || onboarding === null) return null;

  const { view, id } = route;

  if (onboarding) {
    return (
      <Onboarding
        state={state}
        onDone={() => {
          localStorage.setItem(ONBOARDED_KEY, "1");
          setOnboarding(false);
        }}
      />
    );
  }

  return (
    <div class="shell">
      <Sidebar
        view={view}
        taskCount={state.tasks.length}
        onNavigate={go}
        onOpenSettings={() => setSettingsTab("general")}
      />
      <main class="main">
        <BackContext.Provider value={back}>
        {view === "tasks" && <TasksView state={state} go={go} onOpenSettings={() => setSettingsTab("model")} />}
        {view === "editor" && <EditorView key={id ?? "new"} state={state} taskId={id} go={go} />}
        {view === "runs" && <RunsView state={state} taskId={id} go={go} />}
        {view === "results" && <ResultsView key={id ?? ""} state={state} taskId={id} go={go} />}
        {view === "run" && <RunDetailView key={id} state={state} runId={id} go={go} />}
        {view === "batch" && <BatchView key={id} state={state} batchId={id} go={go} />}
        {view === "live" && <LiveView state={state} go={go} />}
        {view === "env" && <EnvView state={state} />}
        </BackContext.Provider>
      </main>
      {settingsTab && <SettingsModal state={state} tab={settingsTab} onClose={() => setSettingsTab(null)} />}
    </div>
  );
}

/**
 * 桌面端渲染层根容器组件。
 *
 * 【调用时机】
 * 页面加载完成由底部 `render(<App />, ...)` 统一挂载至 DOM 节点 `#app`。
 *
 * 【作用】
 * 容纳主交互界面 `Main` 以及全局轻提示悬浮容器 `ToastHost`，确保通知在全屏引导或主界面均可正确浮动展现。
 */
function App() {
  return (
    <>
      <Main />
      <ToastHost />
      <ConfirmHost />
    </>
  );
}

// 页面首屏立即同步初始化主题外观
initTheme();
// 渲染挂载至 DOM
render(<App />, document.getElementById("app")!);
