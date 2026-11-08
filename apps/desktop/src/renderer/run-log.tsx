import { useState } from "preact/hooks";
import type { RunRecord, RunStep } from "../shared.ts";
import { Icon } from "./icons.tsx";
import { shotUrl } from "./shots.ts";
import { describeStep } from "./step-format.ts";

/**
 * 日志中的一块带标题的预格式化文本（入参 / 返回）。
 * 支持选中复制；排查时常需要把原文贴出去。
 */
function LogBlock({ title, text, error }: { title: string; text: string; error?: boolean }) {
  return (
    <div class="log-block">
      <div class="log-k">{title}</div>
      <pre class={`log-pre selectable ${error ? "err" : ""}`}>{text}</pre>
    </div>
  );
}

/**
 * 单步日志：Agent 的说明 + 一次工具调用。
 *
 * 默认只显示一行摘要（动作 / 工具名 / 耗时），Agent 说的话始终可见，
 * 点击摘要行展开完整入参、返回内容和当时的截图。
 */
function LogItem({ runId, step, onShot }: { runId: string; step: RunStep; onShot: (src: string) => void }) {
  const [open, setOpen] = useState(false);
  const { label, target } = describeStep(step);
  const hasDetail = Boolean(step.input || step.output || step.screenshot);
  const mark = step.isError ? "err" : step.status;

  return (
    <li class="log-item">
      {step.thought && (
        <div class="log-agent">
          <span class="log-who">Agent</span>
          <p class="selectable">{step.thought}</p>
        </div>
      )}

      <button type="button" class="log-call" aria-expanded={open} disabled={!hasDetail} onClick={() => setOpen(!open)}>
        <span class={`fold-icon ${open ? "open" : ""} ${hasDetail ? "" : "dim"}`}>
          <Icon name="chevron" size={13} />
        </span>
        <span class="log-no">{step.stepNumber}</span>
        <span class={`s-mark ${mark}`}>
          {step.status === "done" && !step.isError && <Icon name="check" size={11} />}
          {step.isError && <Icon name="close" size={11} />}
        </span>
        <span class="step-text" title={target}>
          {label && <b>{label}</b>}
          {step.tool && <code class="log-tool">{step.tool}</code>}
          {target}
        </span>
        <span class="step-meta">{step.meta}</span>
        {step.screenshot && <span class="log-has-shot">截图</span>}
      </button>

      {open && (
        <div class="log-detail">
          {step.input && <LogBlock title="入参" text={step.input} />}
          {step.output && (
            <LogBlock title={step.isError ? "返回（出错）" : "返回"} text={step.output} error={step.isError} />
          )}
          {step.screenshot && (
            <button type="button" class="log-shot" onClick={() => onShot(shotUrl(runId, step.screenshot!))}>
              <img src={shotUrl(runId, step.screenshot)} alt={`第 ${step.stepNumber} 步截图`} loading="lazy" />
            </button>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * 运行日志：Agent 与工具之间的完整交互记录，用于 Agent 行为不符预期时排查。
 *
 * 【调用时机】
 * 运行详情页「排查信息 → 运行日志」展开后渲染。
 *
 * 【内容】
 * 1. 发给 Agent 的完整任务指令（`run.prompt`）；
 * 2. 逐步记录：Agent 每轮说的话、调用的工具与完整入参、工具返回内容与截图；
 * Agent 的最终回复不在此重复，见「排查信息 → Agent 说明」。
 *
 * @param run 完整运行记录
 * @param steps 要展示的步骤（已去掉内部管理步骤、已规整状态）
 * @param onShot 点击截图查看大图
 */
export function RunLog({ run, steps, onShot }: { run: RunRecord; steps: RunStep[]; onShot: (src: string) => void }) {
  return (
    <div class="run-log">
      {run.prompt && (
        <div class="log-edge">
          <div class="log-k">发给 Agent 的指令</div>
          <pre class="log-pre selectable">{run.prompt}</pre>
        </div>
      )}
      <ol class="log-list">
        {steps.map((s) => (
          <LogItem key={s.stepNumber} runId={run.id} step={s} onShot={onShot} />
        ))}
      </ol>
    </div>
  );
}
