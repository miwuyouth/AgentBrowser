import { summarizeBatch } from "../../batch.ts";
import type { AppState, RunSummary } from "../../shared.ts";
import { confirmDialog } from "../confirm.tsx";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";
import { formatDateTime, formatDuration } from "../time.ts";

const STATUS_LABEL = { ok: "成功", run: "运行中", fail: "失败" } as const;

/**
 * 这一轮里某个 Profile 的那次运行。
 *
 * 【调用时机】在 `BatchView` 的 Profile 列表里逐条渲染。
 * 【作用】只放「状态圆点 + Profile 名 + 状态」；点击进入那次运行的详情（还在跑的进实时视图）。
 */
function ProfileRunRow({ run, go }: { run: RunSummary; go: Navigate }) {
  const open = () => go(run.status === "run" ? "live" : "run", run.id);
  const name = run.profileName || "未知 Profile";
  return (
    <li
      class="row"
      role="link"
      tabIndex={0}
      aria-label={`${name}，${STATUS_LABEL[run.status]}`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <i class={`dot ${run.status}`} />
      <span class="row-name">{name}</span>
      {run.status === "fail" && <span class="tag-err">失败</span>}
      <span class="row-meta">{run.status === "run" ? "运行中" : run.endTime ? formatDuration(run.endTime - run.startTime) : ""}</span>
      <Icon name="chevron" size={14} />
    </li>
  );
}

/**
 * 一轮运行的页面：多 Profile 任务每次运行会在每个 Profile 上各跑一遍，这里列出每个 Profile 的结果。
 *
 * 【调用时机】
 * 用户在运行记录列表点击一整轮、实时视图里整轮结束后自动跳转、或点了这一轮的完成通知时（`view === "batch"`）渲染。
 *
 * 【作用】
 * 1. 头部：任务名，以及成功/失败数、开始时间、总用时、触发方式；
 * 2. 有失败时提供「重试失败的 N 个」：只在失败的那些 Profile 上重跑；
 * 3. 列出每个 Profile 的那次运行，点进去是现有的运行详情；
 * 4. 还没跑到的 Profile 用一行灰字说明（进行中写「等待运行」，被停止的写「没有运行」）；
 * 5. 删除这一轮的全部运行记录。
 *
 * @param state 当前全局应用状态
 * @param batchId 这一轮的 ID
 * @param go 路由导航函数
 */
export function BatchView({ state, batchId, go }: { state: AppState; batchId: string | undefined; go: Navigate }) {
  const runs = state.runs.filter((r) => r.batch?.id === batchId);

  const back = (
    <button type="button" class="back" onClick={() => go("runs")}>
      <Icon name="back" size={14} />
      运行记录
    </button>
  );

  if (runs.length === 0) {
    return (
      <div class="page">
        {back}
        <div class="empty">
          <h2>找不到这一轮的记录</h2>
          <p>它可能已经被删除了。</p>
        </div>
      </div>
    );
  }

  const batch = summarizeBatch(runs, state.activeBatchId);
  const remaining = batch.total - batch.runs.length;
  const status = batch.running ? "运行中" : batch.fail === 0 ? "全部成功" : `成功 ${batch.ok} 个，失败 ${batch.fail} 个`;
  const meta = [
    status,
    formatDateTime(batch.startTime),
    batch.endTime ? `用时 ${formatDuration(batch.endTime - batch.startTime)}` : null,
    batch.trigger,
  ]
    .filter(Boolean)
    .join(" · ");

  /**
   * 只在失败的那些 Profile 上重跑。
   * 【调用时机】用户点「重试失败的 N 个」时调用。
   */
  const retry = () => {
    void window.agentApi.retryBatch(batch.id);
    go("live");
  };

  /**
   * 删除这一轮的全部运行记录及截图。
   * 【调用时机】用户点右上角垃圾桶并确认时调用。
   */
  const remove = async () => {
    const ok = await confirmDialog({
      title: "删除这一轮的运行记录？",
      detail: `${batch.runs.length} 个 Profile 的运行步骤和截图会一并删除，无法恢复。`,
      confirmLabel: "删除",
      danger: true,
    });
    if (!ok) return;
    await window.agentApi.deleteRuns(batch.runs.map((r) => r.id));
    go("runs");
  };

  return (
    <div class="page">
      {back}
      <PageHead title={batch.name} desc={meta}>
        <span class="head-actions">
          {batch.fail > 0 && !batch.running && (
            <button type="button" class="btn btn-primary" disabled={state.running} title={state.running ? "已有任务正在运行" : undefined} onClick={retry}>
              重试失败的 {batch.fail} 个
            </button>
          )}
          <button type="button" class="icon-btn" aria-label="删除这一轮的记录" title="删除" disabled={batch.running} onClick={remove}>
            <Icon name="trash" size={15} />
          </button>
        </span>
      </PageHead>

      <section class="section">
        <h2 class="section-title">{batch.total} 个 Profile</h2>
        <ul class="list">
          {batch.runs.map((r) => (
            <ProfileRunRow key={r.id} run={r} go={go} />
          ))}
          {remaining > 0 && (
            <li class="row row-static">
              <span class="row-name muted">
                {batch.running ? `还有 ${remaining} 个 Profile 等待运行` : `${remaining} 个 Profile 没有运行（这一轮被停止了）`}
              </span>
            </li>
          )}
        </ul>
      </section>
    </div>
  );
}
