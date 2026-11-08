import type { AppState, TaskItem, TaskStatus } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { getReadiness } from "../readiness.ts";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";

type RowStatus = TaskStatus | "queued";
const STATUS_LABEL: Record<RowStatus, string> = { ok: "成功", run: "运行中", fail: "失败", none: "未运行", queued: "排队中" };

function TaskRow({ task, status, busy, go }: { task: TaskItem; status: RowStatus; busy: boolean; go: Navigate }) {
  const open = () => go("runs", task.id);
  const stop = (e: Event) => e.stopPropagation();

  return (
    <li
      class="row"
      role="link"
      tabIndex={0}
      aria-label={`查看「${task.name}」的运行记录`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <i class={`dot ${status}`} />
      <span class="row-name">{task.name}</span>

      <span class="row-actions" onClick={stop}>
        {status !== "run" && (
          <button
            type="button"
            class="btn btn-sm"
            disabled={busy}
            title={busy ? "已有任务正在运行" : undefined}
            onClick={() => {
              void window.agentApi.runTask(task.id);
              go("live");
            }}
          >
            <Icon name="play" size={12} />
            运行
          </button>
        )}
        <button type="button" class="icon-btn" aria-label="编辑任务" title="编辑" onClick={() => go("editor", task.id)}>
          <Icon name="edit" size={15} />
        </button>
      </span>

      <span class="row-meta">{STATUS_LABEL[status]}</span>
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
        {tasks.map((t) => {
          // 正在运行的那一个以主进程的实时状态为准
          const status: RowStatus = state.activeRun?.taskId === t.id ? "run" : state.queued.includes(t.id) ? "queued" : t.lastStatus;
          return <TaskRow key={t.id} task={t} status={status} busy={state.running} go={go} />;
        })}
      </ul>
    </div>
  );
}
