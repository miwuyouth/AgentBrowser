import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState, RunStep } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { Lightbox } from "../lightbox.tsx";
import type { Navigate } from "../sidebar.tsx";
import { shotUrl } from "../shots.ts";
import { describeStep, shortUrl, visibleSteps } from "../step-format.ts";
import { formatClock } from "../time.ts";

/** 每秒刷新一次的当前时间。用时在界面里自己算，后端不用每秒推一次 */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

function LiveStep({ step }: { step: RunStep }) {
  const { label, target } = describeStep(step);
  return (
    <li class={`live-step ${step.status}`}>
      <span class="live-mark">{step.status === "done" && <Icon name="check" size={10} />}</span>
      <div class="live-step-body">
        <div class="live-step-label">{label || target}</div>
        {label && target && <div class="live-step-target">{target}</div>}
      </div>
    </li>
  );
}

export function LiveView({ state, go }: { state: AppState; go: Navigate }) {
  const run = state.activeRun?.status === "run" ? state.activeRun : undefined;
  const now = useNow();

  /** 看到过的那次运行；它结束时，自动带用户去看结果 */
  const seenRunId = useRef<string | null>(null);
  if (run) seenRunId.current = run.id;

  const [gaveUp, setGaveUp] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  useEffect(() => {
    if (!run && seenRunId.current) go("run", seenRunId.current);
  }, [run?.id]);

  // 点了运行却一直没有开始（例如启动失败，原因会以提示条显示）：别让用户一直干等
  useEffect(() => {
    if (run) return;
    const timer = setTimeout(() => setGaveUp(true), 10_000);
    return () => clearTimeout(timer);
  }, [!!run]);

  const steps = run ? visibleSteps(run.steps) : [];
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (!run) {
    return (
      <div class="page">
        <div class="empty">
          {seenRunId.current || !gaveUp ? (
            <>
              <h2>正在启动浏览器…</h2>
              <p>马上就好。</p>
              <div class="ob-progress indeterminate" style="width: 160px">
                <i />
              </div>
            </>
          ) : (
            <>
              <h2>没有正在运行的任务</h2>
              <p>如果刚才点了运行，可能是没能启动，详情见提示。</p>
              <button type="button" class="btn" onClick={() => go("runs")}>
                查看运行记录
              </button>
            </>
          )}
        </div>
      </div>
    );
  }

  const elapsed = formatClock(now - run.startTime);
  const latestFile = [...run.steps].reverse().find((s) => s.screenshot)?.screenshot;
  const latestShot = latestFile ? shotUrl(run.id, latestFile) : undefined;

  const cancel = () => {
    setCancelling(true);
    void window.agentApi.cancelTask();
  };

  return (
    <div class="live">
      <header class="live-head">
        <h1>{run.name}</h1>
        <span class="live-status">
          <i class="dot run" />
          运行中 · {elapsed} · {steps.length} 步
        </span>
        <button type="button" class="btn btn-quiet-danger" disabled={cancelling} onClick={cancel}>
          {cancelling ? "正在终止…" : "终止"}
        </button>
      </header>

      <div class="live-body">
        <ol class="live-steps" ref={listRef}>
          {steps.map((s) => (
            <LiveStep key={s.stepNumber} step={s} />
          ))}
        </ol>

        <div class="live-stage">
          <div class="browser">
            <div class="browser-bar">
              <span class="browser-url">{run.lastUrl ? shortUrl(run.lastUrl) : "等待打开页面"}</span>
            </div>
            {latestShot ? (
              <img class="browser-shot" src={latestShot} alt="浏览器当前画面" onClick={() => setShot(latestShot)} />
            ) : (
              <div class="browser-empty">等待浏览器画面…</div>
            )}
          </div>
        </div>
      </div>

      {shot && <Lightbox src={shot} onClose={() => setShot(null)} />}
    </div>
  );
}
