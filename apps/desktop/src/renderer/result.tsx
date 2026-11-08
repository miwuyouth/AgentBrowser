import { useState } from "preact/hooks";
import type { FormField, RunRecord, RunResult } from "../shared.ts";
import { Icon } from "./icons.tsx";

/** 取一次运行的结果。后端还没产出结构化结果之前，用最终回复文字兜底 */
export function getRunResult(run: RunRecord): RunResult | null {
  if (run.result) return run.result;
  return run.summary.trim() ? { kind: "text", text: run.summary } : null;
}

function FormResultView({
  data,
  fields,
  summary,
}: {
  data: Record<string, string | number | null>;
  fields: FormField[];
  summary?: string;
}) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [copiedAll, setCopiedAll] = useState(false);

  const copyText = (key: string, text: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedKey(key);
    setTimeout(() => setCopiedKey(null), 1500);
  };

  const copyAllJson = () => {
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    setCopiedAll(true);
    setTimeout(() => setCopiedAll(false), 1500);
  };

  return (
    <div class="form-result">
      <div class="form-result-head">
        <span class="form-result-title">表单提取结果（共 {fields.length} 项）</span>
        <button type="button" class="btn btn-sm" onClick={copyAllJson}>
          <Icon name={copiedAll ? "check" : "copy"} size={13} />
          {copiedAll ? "已复制 JSON" : "复制全部 (JSON)"}
        </button>
      </div>

      <div class="form-result-table">
        {fields.map((f) => {
          const val = data[f.name];
          const hasVal = val !== null && val !== undefined && val !== "";
          const displayVal = hasVal ? String(val) : "";

          return (
            <div key={f.id || f.name} class="form-result-row">
              <div class="form-result-label">
                <span class="form-result-name">{f.name}</span>
                <span class="form-result-badge">{f.type === "number" ? "数字" : "文本"}</span>
                {f.description && <span class="form-result-desc" title={f.description}>{f.description}</span>}
              </div>

              <div class="form-result-val-wrap">
                {hasVal ? (
                  <>
                    <span class={`form-result-val ${f.type === "number" ? "number" : ""}`}>
                      {displayVal}
                    </span>
                    <button
                      type="button"
                      class="icon-btn form-result-copy"
                      title="复制此项"
                      onClick={() => copyText(f.name, displayVal)}
                    >
                      <Icon name={copiedKey === f.name ? "check" : "copy"} size={13} />
                    </button>
                  </>
                ) : (
                  <span class="form-result-empty">— 未提取到</span>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {summary && summary.trim() && (
        <div class="form-result-summary">
          <span class="form-result-summary-title">Agent 说明：</span>
          <p>{summary}</p>
        </div>
      )}
    </div>
  );
}

/** 唯一负责"把结果画出来"的组件：以后新增结果类型，只改这里 */
export function ResultView({ result, summary }: { result: RunResult; summary?: string }) {
  switch (result.kind) {
    case "form":
      return <FormResultView data={result.data} fields={result.fields} summary={summary} />;
    case "text":
    case "markdown": // Markdown 暂按纯文本显示；以后接入渲染器只改这一行
      return <div class="result-text">{result.text}</div>;
  }
}
