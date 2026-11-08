import type { AppState, RunSummary } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";
import { formatRelative } from "../time.ts";

const STATUS_LABEL = { ok: "成功", run: "运行中", fail: "失败" } as const;

/**
 * 单条历史运行记录条目行组件。
 *
 * 【调用时机】
 * 在 `RunsView` 列表中遍历历史运行摘要数据时渲染。
 *
 * 【作用】
 * 1. 展现运行状态色标小圆点（绿色成功、黄色运行中、红色失败）；
 * 2. 展现任务名称、失败醒目标签与执行相对时间（如"刚刚"、"12分钟前"）；
 * 3. 智能路由分发：点击整行，若该任务仍在运行中（`status === "run"`）则跳转至实时视图（`live`），若已完成/失败则跳转至详情回溯页（`run`）。
 *
 * @param run 运行摘要对象
 * @param go 路由导航函数
 */
function RunRow({ run, go }: { run: RunSummary; go: Navigate }) {
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

/**
 * 历史运行记录工作区视图组件。
 *
 * 【调用时机】
 * 用户点击侧边栏"运行记录"菜单项（`view === "runs"`）时在主视区渲染。
 *
 * 【作用】
 * 1. 展示全局历史运行记录，支持通过可选的 `taskId` 进行单一任务历史筛选；
 * 2. 显式按执行开始时间倒序排列（最新的在最前）；
 * 3. 头部提供任务过滤标签及一键清除过滤按钮；
 * 4. 包含空状态提示。
 *
 * @param state 当前全局应用状态
 * @param taskId 可选的过滤任务 ID
 * @param go 路由导航函数
 */
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
