import type { AppState, TaskItem } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { getReadiness } from "../readiness.ts";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";

function TaskRow({
  task,
  busy,
  running,
  go,
}: {
  task: TaskItem;
  busy: boolean;
  running: boolean;
  go: Navigate;
}) {
  const open = () => go("editor", task.id);

  return (
    <li
      class="row"
      role="link"
      tabIndex={0}
      aria-label={`编辑「${task.name}」`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <span class="row-name">{task.name}</span>

      <button
        type="button"
        class="btn btn-sm"
        disabled={busy && !running}
        title={busy && !running ? "已有任务正在运行" : running ? "查看实时运行" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (running) {
            go("live");
          } else {
            void window.agentApi.runTask(task.id);
            go("live");
          }
        }}
      >
        <Icon name="play" size={12} />
        {running ? "运行中" : "运行"}
      </button>

      <Icon name="chevron" size={14} />
    </li>
  );
}

/** 模型或浏览器还没准备好时，在任务页顶部提醒，并给出直达的入口 */
function SetupHint({ state, go, onOpenSettings }: { state: AppState; go: Navigate; onOpenSettings: () => void }) {
  const r = getReadiness(state);
  if (r.model && r.kernel) return null;

  const needModel = !r.model;
  const title = needModel ? "先配置模型，才能开始运行任务" : r.kernelStatus === "installing" ? "正在下载浏览器" : "还没有可用的浏览器";
  const desc = needModel ? "需要一个 API Key，约一分钟完成。" : "到运行环境里下载一个浏览器内核。";

  return (
    <div class="hint">
      <Icon name="settings" size={18} />
      <div>
        <b>{title}</b>
        <span>{desc}</span>
      </div>
      <button type="button" class="btn btn-primary btn-sm" onClick={needModel ? onOpenSettings : () => go("env")}>
        {needModel ? "去配置" : "查看"}
      </button>
    </div>
  );
}

export function TasksView({ state, go, onOpenSettings }: { state: AppState; go: Navigate; onOpenSettings: () => void }) {
  // 最近改动的排在最前
  const tasks = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  if (tasks.length === 0) {
    return (
      <div class="page">
        <PageHead title="任务" desc="创建第一个自动化任务" />
        <SetupHint state={state} go={go} onOpenSettings={onOpenSettings} />
        <div class="empty">
          <h2>还没有任务</h2>
          <p>用一句话告诉 Agent 要做什么，它会替你操作浏览器。</p>
          <button type="button" class="btn btn-primary btn-lg" onClick={() => go("editor")}>
            新建任务
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="page">
      <PageHead title="任务" desc={`${tasks.length} 个任务`} />
      <SetupHint state={state} go={go} onOpenSettings={onOpenSettings} />
      <ul class="list">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            busy={state.running}
            running={state.activeRun?.taskId === t.id}
            go={go}
          />
        ))}
      </ul>
    </div>
  );
}
