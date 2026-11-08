import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState, RunStep } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { Lightbox } from "../lightbox.tsx";
import { BackButton } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";
import { shotUrl } from "../shots.ts";
import { describeStep, shortUrl, visibleSteps } from "../step-format.ts";
import { formatClock } from "../time.ts";

/**
 * 前端秒级自增时钟 Hook。
 *
 * 【调用时机】
 * 在 `LiveView` 组件挂载时调用。
 *
 * 【作用】
 * 启动 1 秒间隔的本地循环定时器驱动当前时间戳自增，让界面的用时秒表平滑刷新，
 * 避免由后端每秒推送 IPC 消息造成不必要的进程间通信开销。
 *
 * @returns 响应式当前毫秒时间戳
 */
function useNow(): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * 实时监控中的单步时间线节点组件。
 *
 * 【调用时机】
 * 在 `LiveView` 左侧实时步骤流中遍历渲染当前已产生步骤时调用。
 *
 * 【作用】
 * 调用 `describeStep` 转译人话动作描述，展示状态圆点/对勾标记与操作参数目标。
 *
 * @param step 原始步骤对象
 */
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

/**
 * 任务实时监控与推流视图组件。
 *
 * 【调用时机】
 * 任务启动执行（点击"运行"、"保存并运行"）或用户在其他页面点击"运行中"状态标签跳转时（`view === "live"`）在主工作区渲染。
 *
 * 【作用】
 * 1. 监控当前处于执行中（`status === "run"`）的活跃任务；
 * 2. 头部展示任务名、实时耗时时钟（如 01:23）、已执行步数及"终止"中断按钮；
 * 3. 左侧展示步骤时间线流，新步骤追加时若用户停在底部则自动跟随到最底部，往上翻看时不打扰；
 * 4. 右侧以模拟浏览器容器展示当前页面 URL 与最新落盘的屏幕截图，支持点击调起灯箱大图预览；
 * 5. 任务结束侦测：一旦后端执行完毕或中断（`run` 对象消失且运行器空闲），自动跳转至对应的运行详情页（`go("run", seenRunId)`）；
 *    多 Profile 的一轮会依次换成下一个 Profile 的运行，整轮结束后跳到这一轮的页面（`go("batch", seenBatchId)`）。
 *
 * @param state 当前全局应用状态
 * @param go 路由导航函数
 */
export function LiveView({ state, go }: { state: AppState; go: Navigate }) {
  const run = state.activeRun?.status === "run" ? state.activeRun : undefined;
  const now = useNow();

  /** 看到过的那次运行；它结束时，自动带用户去看结果 */
  const seenRunId = useRef<string | null>(null);
  /** 看到过的那一轮；整轮结束时带用户去看这一轮的结果 */
  const seenBatchId = useRef<string | null>(null);
  if (run) {
    seenRunId.current = run.id;
    seenBatchId.current = run.batch?.id ?? null;
  }

  const [gaveUp, setGaveUp] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [shot, setShot] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);

  // 一轮里两个 Profile 之间运行器仍在忙，不算结束
  useEffect(() => {
    if (run || state.running || !seenRunId.current) return;
    if (seenBatchId.current) go("batch", seenBatchId.current, { replace: true });
    else go("run", seenRunId.current, { replace: true });
  }, [run?.id, state.running]);

  // 点了运行却一直没有开始（例如启动失败，原因会以提示条显示）：别让用户一直干等
  useEffect(() => {
    if (run) return;
    const timer = setTimeout(() => setGaveUp(true), 10_000);
    return () => clearTimeout(timer);
  }, [!!run]);

  /** 用户是否停在列表底部附近；往上翻看历史步骤时不再强行拉到底 */
  const stickToBottom = useRef(true);

  /**
   * 记录用户当前是否贴着底部。
   * 【调用时机】步骤列表滚动时（含用户手动滚动和下方的自动滚动）。
   */
  const onStepsScroll = () => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  };

  const steps = run ? visibleSteps(run.steps) : [];
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [steps.length]);

  if (!run) {
    return (
      <div class="page">
        <BackButton />
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

  /**
   * 中止当前正在运行的任务。
   * 【调用时机】用户点击右上角"终止"按钮时调用。
   */
  const cancel = () => {
    setCancelling(true);
    void window.agentApi.cancelTask();
  };

  return (
    <div class="live">
      <header class="live-head">
        <BackButton />
        <h1>{run.name}</h1>
        <span class="live-status">
          <i class="dot run" />
          运行中{run.batch && <> · {run.profileName} {run.batch.index}/{run.batch.total}</>} · {elapsed} · {steps.length} 步
        </span>
        <button type="button" class="btn btn-quiet-danger" disabled={cancelling} onClick={cancel}>
          {cancelling ? "正在终止…" : run.batch ? "终止这一轮" : "终止"}
        </button>
      </header>

      <div class="live-body">
        <ol class="live-steps" ref={listRef} onScroll={onStepsScroll}>
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
