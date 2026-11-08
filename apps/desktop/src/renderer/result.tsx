import { useState } from "preact/hooks";
import type { FormField, RunRecord, RunResult } from "../shared.ts";
import { Icon } from "./icons.tsx";

/**
 * 提取运行记录的最终结果对象。
 *
 * 【调用时机】
 * 实时监控页面（LiveView）在任务执行完成进入收尾展示、或运行详情页（RunDetailView）渲染结果卡片时调用。
 *
 * 【作用】
 * 优先取结构化的 `run.result`；若执行过程未产生结构化结果，则安全使用 Agent 的最终总结文字（`run.summary`）构造成 `{ kind: "text", text: summary }` 进行兜底呈现。
 *
 * @param run 完整的单次运行明细记录
 * @returns 最终结果对象或 null
 */
export function getRunResult(run: RunRecord): RunResult | null {
  if (run.result) return run.result;
  return run.summary.trim() ? { kind: "text", text: run.summary } : null;
}

/**
 * 结构化表单字段提取结果呈现组件。
 *
 * 【调用时机】
 * 当任务结果类型为 `form`（`result.kind === "form"`）时在 `ResultView` 中内部渲染。
 *
 * 【作用】
 * 1. 列表呈现任务定义的所有表单字段及其提取值，标记数字/文本徽章；
 * 2. 字段值支持单项点击快速复制；
 * 3. 头部提供"复制全部 (JSON)"一键将提取出的数据结构复制到剪贴板；
 * Agent 的自然语言说明不在此处展示，由详情页提供折叠入口按需查看。
 */
function FormResultView({ data, fields }: { data: Record<string, string | number | null>; fields: FormField[] }) {
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
        <span class="form-result-title">共 {fields.length} 项</span>
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
    </div>
  );
}

/**
 * 运行产出结果统一渲染组件。
 *
 * 【调用时机】
 * 在 LiveView 实时页与 RunDetailView 详情页中呈现任务最终产出时调用。
 *
 * 【作用】
 * 作为结果呈现的单一出口，根据结果种类（kind）做多态渲染：
 * - "form": 渲染为结构化表单卡片（`FormResultView`）；
 * - "text" / "markdown": 渲染为纯文本段落（后续若集成 Markdown 解析器仅需在此拓展）。
 *
 * @param result 规范的运行结果实体
 */
export function ResultView({ result }: { result: RunResult }) {
  switch (result.kind) {
    case "form":
      return <FormResultView data={result.data} fields={result.fields} />;
    case "text":
    case "markdown": // Markdown 暂按纯文本显示；以后接入渲染器只改这一行
      return <div class="result-text">{result.text}</div>;
  }
}
