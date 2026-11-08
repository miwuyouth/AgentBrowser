import type { RunRecord, RunResult } from "../shared.ts";

/** 取一次运行的结果。后端还没产出结构化结果之前，用最终回复文字兜底 */
export function getRunResult(run: RunRecord): RunResult | null {
  if (run.result) return run.result;
  return run.summary.trim() ? { kind: "text", text: run.summary } : null;
}

/** 唯一负责"把结果画出来"的组件：以后新增结果类型，只改这里 */
export function ResultView({ result }: { result: RunResult }) {
  switch (result.kind) {
    case "text":
    case "markdown": // Markdown 暂按纯文本显示；以后接入渲染器只改这一行
      return <div class="result-text">{result.text}</div>;
  }
}
