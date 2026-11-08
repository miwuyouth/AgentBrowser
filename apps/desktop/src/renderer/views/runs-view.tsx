import type { AppState, RunRecord } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";
import { formatRelative } from "../time.ts";

const STATUS_LABEL = { ok: "成功", run: "运行中", fail: "失败" } as const;

function RunRow({ run, go }: { run: RunRecord; go: Navigate }) {
  // 运行中的去实时视图看过程，已结束的去详情页看结果
  const open = () => go(run.status === "run" ? "live" : "run", run.id);

  return (
    <li
      class="row"
      role="link"
      tabIndex={0}
      aria-label={`${run.name}，${STATUS_LABEL[run.status]}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <i class={`dot ${run.status}`} />
      <span class="row-name">{run.name}</span>
      {run.status === "fail" && <span class="tag-err">失败</span>}
      <span class="row-meta">{run.status === "run" ? "运行中" : formatRelative(run.startTime)}</span>
      <Icon name="chevron" size={14} />
    </li>
  );
}

export function RunsView({ state, taskId, go }: { state: AppState; taskId: string | undefined; go: Navigate }) {
  const task = state.tasks.find((t) => t.id === taskId);
  const filtered = !!task;

  // 最新的在最前；显式按开始时间排，不依赖存储时的插入顺序
  const runs = state.runs
    .filter((r) => !filtered || r.taskId === task.id)
    .sort((a, b) => b.startTime - a.startTime);

  return (
    <div class="page">
      <PageHead title="运行记录" desc={`${runs.length} 条记录`}>
        {task && (
          <span class="filter-tag">
            {task.name}
            <button type="button" aria-label="查看全部运行记录" title="查看全部" onClick={() => go("runs")}>
              ×
            </button>
          </span>
        )}
      </PageHead>

      {runs.length === 0 ? (
        <div class="empty">
          <h2>{filtered ? "这个任务还没有运行过" : "还没有运行记录"}</h2>
          <p>任务运行后，记录会出现在这里。</p>
        </div>
      ) : (
        <ul class="list">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} go={go} />
          ))}
        </ul>
      )}
    </div>
  );
}
