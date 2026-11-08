import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Onboarding } from "./onboarding.tsx";
import { getReadiness } from "./readiness.ts";
import { Sidebar, type Navigate, type View } from "./sidebar.tsx";
import { useAppState } from "./state.ts";
import { initTheme } from "./theme.ts";
import { ToastHost } from "./toast.tsx";
import { ConfirmHost, showAppPrompt } from "./confirm.tsx";
import { SettingsModal, type SettingsTab } from "./views/settings-modal.tsx";
import { EnvView } from "./views/env-view.tsx";
import { EditorView } from "./views/editor-view.tsx";
import { LiveView } from "./views/live-view.tsx";
import { RunDetailView } from "./views/run-detail-view.tsx";
import { RunsView } from "./views/runs-view.tsx";
import { TasksView } from "./views/tasks-view.tsx";

/** 记录用户是否已完成过首次引导的 localStorage 键名 */
const ONBOARDED_KEY = "agent_browser_onboarded";

/**
 * 桌面端应用主视图控制器组件。
 *
 * 【调用时机】
 * 由根组件 `App` 挂载渲染。
 *
 * 【作用】
 * 1. 订阅全局状态 Hook（`useAppState`）；
 * 2. 维护前端路由导航状态（`route: { view, id }`）并分发路由跳转闭包 `go`；
 * 3. 首次加载时根据 `getReadiness` 与本地存储状态决定是否展示新手引导向导（`Onboarding`）；
 * 4. 监听全局快捷键（⌘N 新建任务、⌘, 打开设置），并响应系统通知点击跳到运行详情；
 * 5. 组装左侧 `Sidebar` 导航与右侧主视区视图切换（TasksView / EditorView / RunsView / RunDetailView / LiveView / EnvView），并管理设置弹窗开闭。
 */
function Main() {
  const state = useAppState();
  const [route, setRoute] = useState<{ view: View; id?: string }>({ view: "tasks" });
  const go: Navigate = (view, id) => setRoute({ view, ...(id ? { id } : {}) });
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

  // ⌘N：新建任务；⌘,：打开设置
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      if (e.key === "n") {
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

  // 用户点了「任务完成」系统通知：跳到那次运行的详情
  useEffect(
    () =>
      window.agentApi.onEvent((e) => {
        if (e.type !== "open_run") return;
        setSettingsTab(null);
        go("run", e.runId);
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
        {view === "tasks" && <TasksView state={state} go={go} onOpenSettings={() => setSettingsTab("model")} />}
        {view === "editor" && <EditorView key={id ?? "new"} state={state} taskId={id} go={go} />}
        {view === "runs" && <RunsView state={state} taskId={id} go={go} />}
        {view === "run" && <RunDetailView key={id} state={state} runId={id} go={go} />}
        {view === "live" && <LiveView state={state} go={go} />}
        {view === "env" && <EnvView state={state} />}
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
