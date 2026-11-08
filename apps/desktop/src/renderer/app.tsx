import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { Onboarding } from "./onboarding.tsx";
import { getReadiness } from "./readiness.ts";
import { Sidebar, type Navigate, type View } from "./sidebar.tsx";
import { useAppState } from "./state.ts";
import { initTheme } from "./theme.ts";
import { ToastHost } from "./toast.tsx";
import { SettingsModal } from "./views/settings-modal.tsx";
import { EnvView } from "./views/env-view.tsx";
import { EditorView } from "./views/editor-view.tsx";
import { LiveView } from "./views/live-view.tsx";
import { RunDetailView } from "./views/run-detail-view.tsx";
import { RunsView } from "./views/runs-view.tsx";
import { TasksView } from "./views/tasks-view.tsx";

const ONBOARDED_KEY = "agent_browser_onboarded";

function Main() {
  const state = useAppState();
  const [route, setRoute] = useState<{ view: View; id?: string }>({ view: "tasks" });
  const go: Navigate = (view, id) => setRoute({ view, ...(id ? { id } : {}) });
  /** null = 还没拿到状态，暂时不决定要不要显示引导 */
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [onboarding, setOnboarding] = useState<boolean | null>(null);

  // 第一次拿到状态时决定一次：已引导过、或者本来就全部就绪的老用户，不再打扰
  useEffect(() => {
    if (!state || onboarding !== null) return;
    const ready = getReadiness(state).all;
    if (ready) localStorage.setItem(ONBOARDED_KEY, "1");
    setOnboarding(localStorage.getItem(ONBOARDED_KEY) !== "1" && !ready);
  }, [state, onboarding]);

  // ⌘N：新建任务
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "n") {
        e.preventDefault();
        go("editor");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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
        onOpenSettings={() => setSettingsOpen(true)}
      />
      <main class="main">
        {view === "tasks" && <TasksView state={state} go={go} onOpenSettings={() => setSettingsOpen(true)} />}
        {view === "editor" && <EditorView key={id ?? "new"} state={state} taskId={id} go={go} />}
        {view === "runs" && <RunsView state={state} taskId={id} go={go} />}
        {view === "run" && <RunDetailView key={id} state={state} runId={id} go={go} />}
        {view === "live" && <LiveView state={state} go={go} />}
        {view === "env" && <EnvView state={state} />}
      </main>
      {settingsOpen && <SettingsModal state={state} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

/** 轻提示在引导页和主界面里都要能显示，所以放在最外层 */
function App() {
  return (
    <>
      <Main />
      <ToastHost />
    </>
  );
}

initTheme();
render(<App />, document.getElementById("app")!);
