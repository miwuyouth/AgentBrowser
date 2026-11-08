import { useEffect, useState } from "preact/hooks";
import type { AppState, RunRecord } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { BackButton, PageHead } from "../page.tsx";
import { Lightbox } from "../lightbox.tsx";
import { RunLog } from "../run-log.tsx";
import { ShotGallery } from "../shot-gallery.tsx";
import { getRunResult, ResultView } from "../result.tsx";
import type { Navigate } from "../sidebar.tsx";
import { describeStep, visibleSteps } from "../step-format.ts";
import { formatDateTime, formatDuration } from "../time.ts";
import { confirmDialog } from "../confirm.tsx";

const STATUS_LABEL = { ok: "成功", run: "运行中", fail: "失败" } as const;

/**
 * 单次运行记录明细与结果审阅视图组件。
 *
 * 【调用时机】
 * 用户在历史记录列表点击某条已结束的记录、或任务执行完毕由 LiveView 自动导航切换时（`view === "run"`）在主工作区渲染。
 *
 * 【作用】
 * 1. 按需加载：通过 `window.agentApi.getRun(runId)` 仅在进入页面时按需加载单次运行的完整明细（包含全部步骤与截图引用）；
 * 2. 状态保护：若记录仍在运行中，自动重定向至实时推流页面 `LiveView`；
 * 3. 头部信息：展示任务名称、成功/失败状态、所用 Profile、执行时刻、总耗时与触发方式，提供"重试"（只重跑这个 Profile）与"删除记录"操作；属于一轮的运行，返回按钮回到这一轮的页面；
 * 4. 结果/原因卡片：若执行成功，通过 `ResultView` 呈现表单数据或纯文本结果；若失败，呈现醒目报错与解决建议；
 * 5. 过程截图图集（`ShotGallery`）：以缩略图直观呈现运行过程，点击进入可翻页的灯箱；
 * 6. 排查信息折叠卡片（默认收起）：「Agent 说明」按需查看 Agent 的自然语言总结；「运行日志」展开查看每一步工具调用的人话记录，供发现 Agent 行为不符预期时排查。
 *
 * @param state 当前全局应用状态
 * @param runId 目标运行记录 ID
 * @param go 路由导航函数
 */
export function RunDetailView({ state, runId, go }: { state: AppState; runId: string | undefined; go: Navigate }) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [noteOpen, setNoteOpen] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

  /** 列表里的摘要，随状态实时更新；完整记录（含步骤）按需单独读取，undefined 表示还在读取 */
  const summary = state.runs.find((r) => r.id === runId);
  const [run, setRun] = useState<RunRecord | null | undefined>(undefined);

  useEffect(() => {
    if (!runId) return setRun(null);
    let alive = true;
    void window.agentApi.getRun(runId).then((r) => alive && setRun(r));
    return () => {
      alive = false;
    };
  }, [runId, summary?.status]);

  // 还在运行的记录没有"结果"可看，去实时视图
  useEffect(() => {
    if (summary?.status === "run") go("live", summary.id, { replace: true });
  }, [summary?.status]);

  // 属于一轮的运行，返回这一轮的页面
  const batchId = summary?.batch?.id ?? run?.batch?.id;

  if (run === undefined) return null; // 正在读取

  if (!run) {
    return (
      <div class="page">
        <BackButton />
        <div class="empty">
          <h2>找不到这条记录</h2>
          <p>它可能已经被删除了。</p>
        </div>
      </div>
    );
  }

  // 已成功结束的运行不应再有"进行中"的步骤（末步可能没来得及收尾），统一按完成展示
  const steps = visibleSteps(run.steps).map((s) => (run.status === "ok" && s.status === "run" ? { ...s, status: "done" as const } : s));
  const failed = run.status === "fail";
  const result = getRunResult(run);
  const isForm = result?.kind === "form";
  // 纯文本结果本身就是 Agent 的总结，不再重复；表单/失败时总结作为补充说明折叠起来
  const note = failed || isForm ? run.summary.trim() : "";
  const meta = [
    STATUS_LABEL[run.status],
    run.profileName,
    formatDateTime(run.startTime),
    run.endTime ? `用时 ${formatDuration(run.endTime - run.startTime)}` : null,
    run.trigger,
  ]
    .filter(Boolean)
    .join(" · ");

  /**
   * 从失败处重新尝试运行。
   * 【调用时机】用户在右上角点击"重试"按钮时调用。
   */
  const retry = () => {
    void window.agentApi.retryRun(run.id);
    go("live");
  };

  /**
   * 删除当前单条历史运行记录及其关联截图。
   * 【调用时机】用户点击右上角垃圾桶删除图标并确认时调用。
   */
  const remove = async () => {
    const ok = await confirmDialog({ title: "删除这条运行记录？", detail: "运行步骤和截图会一并删除，无法恢复。", confirmLabel: "删除", danger: true });
    if (!ok) return;
    await window.agentApi.deleteRuns([run.id]);
    if (batchId) go("batch", batchId, { replace: true });
    else go("runs");
  };

  return (
    <div class="page">
      <BackButton />
      <PageHead title={run.name} desc={meta}>
        <span class="head-actions">
          {failed && (
            <button type="button" class="btn btn-primary" disabled={state.running} onClick={retry}>
              重试
            </button>
          )}
          <button type="button" class="icon-btn" aria-label="删除这条记录" title="删除" onClick={remove}>
            <Icon name="trash" size={15} />
          </button>
        </span>
      </PageHead>

      <section class="section">
        <h2 class="section-title">{failed ? "失败原因" : isForm ? "表单数据" : "结果"}</h2>
        <div class="card result-card">
          {failed ? (
            <>
              <div class="result-text result-err">{run.error || "任务执行失败"}</div>
              {run.advice && <p class="result-advice">{run.advice}</p>}
            </>
          ) : result ? (
            <ResultView result={result} />
          ) : (
            <p class="muted">没有返回内容</p>
          )}
        </div>
      </section>

      <ShotGallery runId={run.id} steps={steps} />

      <section class="section">
        <h2 class="section-title">排查信息</h2>
        <div class="card">
          {note && (
            <>
              <button type="button" class="fold" aria-expanded={noteOpen} onClick={() => setNoteOpen(!noteOpen)}>
                <span class={`fold-icon ${noteOpen ? "open" : ""}`}>
                  <Icon name="chevron" size={14} />
                </span>
                Agent 说明
              </button>
              {noteOpen && <div class="fold-body result-text">{note}</div>}
            </>
          )}
          <button
            type="button"
            class={`fold ${note ? "fold-sep" : ""}`}
            aria-expanded={stepsOpen}
            onClick={() => setStepsOpen(!stepsOpen)}
          >
            <span class={`fold-icon ${stepsOpen ? "open" : ""}`}>
              <Icon name="chevron" size={14} />
            </span>
            运行日志
            <span class="fold-count">共 {steps.length} 步</span>
          </button>
          {stepsOpen && <RunLog run={run} steps={steps} onShot={setShot} />}
        </div>
      </section>

      {shot && <Lightbox src={shot} onClose={() => setShot(null)} />}
    </div>
  );
}
