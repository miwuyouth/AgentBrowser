import { useEffect, useState } from "preact/hooks";
import type { AppState, RunRecord, RunStep } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import { Lightbox } from "../lightbox.tsx";
import { getRunResult, ResultView } from "../result.tsx";
import type { Navigate } from "../sidebar.tsx";
import { describeStep, visibleSteps } from "../step-format.ts";
import { formatDateTime, formatDuration } from "../time.ts";

const STATUS_LABEL = { ok: "成功", run: "运行中", fail: "失败" } as const;

function StepRow({ step, onShot }: { step: RunStep; onShot: (src: string) => void }) {
  const { label, target } = describeStep(step);
  return (
    <li class="step-row">
      <span class={`s-mark ${step.status}`}>{step.status === "done" && <Icon name="check" size={11} />}</span>
      <span class="step-text" title={target}>
        {label && <b>{label}</b>}
        {target}
      </span>
      <span class="step-meta">{step.meta}</span>
      {step.screenshot && (
        <button type="button" class="link-btn" onClick={() => onShot(step.screenshot!)}>
          截图
        </button>
      )}
    </li>
  );
}

export function RunDetailView({ state, runId, go }: { state: AppState; runId: string | undefined; go: Navigate }) {
  const [stepsOpen, setStepsOpen] = useState(false);
  const [shot, setShot] = useState<string | null>(null);

  const run: RunRecord | undefined = state.runs.find((r) => r.id === runId);

  // 还在运行的记录没有"结果"可看，去实时视图
  useEffect(() => {
    if (run?.status === "run") go("live", run.id);
  }, [run?.status]);

  const back = (
    <button type="button" class="back" onClick={() => go("runs")}>
      <Icon name="back" size={14} />
      运行记录
    </button>
  );

  if (!run) {
    return (
      <div class="page">
        {back}
        <div class="empty">
          <h2>找不到这条记录</h2>
          <p>它可能已经被删除了。</p>
        </div>
      </div>
    );
  }

  const steps = visibleSteps(run.steps);
  const failed = run.status === "fail";
  const result = getRunResult(run);
  const meta = [
    STATUS_LABEL[run.status],
    formatDateTime(run.startTime),
    run.endTime ? `用时 ${formatDuration(run.endTime - run.startTime)}` : null,
    run.trigger,
  ]
    .filter(Boolean)
    .join(" · ");

  const retry = () => {
    void window.agentApi.retryRun(run.id);
    go("live");
  };

  const remove = async () => {
    if (!window.confirm("删除这条运行记录？删除后无法恢复。")) return;
    await window.agentApi.deleteRuns([run.id]);
    go("runs");
  };

  return (
    <div class="page">
      {back}
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
        <h2 class="section-title">{failed ? "失败原因" : "结果"}</h2>
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

      <section class="section">
        <div class="card">
          <button type="button" class="fold" aria-expanded={stepsOpen} onClick={() => setStepsOpen(!stepsOpen)}>
            <span class={`fold-icon ${stepsOpen ? "open" : ""}`}>
              <Icon name="chevron" size={14} />
            </span>
            步骤
            <span class="fold-count">共 {steps.length} 步</span>
          </button>
          {stepsOpen && (
            <ul class="step-list">
              {steps.map((s) => (
                <StepRow key={s.stepNumber} step={s} onShot={setShot} />
              ))}
            </ul>
          )}
        </div>
      </section>

      {shot && <Lightbox src={shot} onClose={() => setShot(null)} />}
    </div>
  );
}
