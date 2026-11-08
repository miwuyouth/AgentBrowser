import type { RunStep } from "../shared.ts";

/** 工具名 → 人话。未知工具原样显示 */
const TOOL_LABEL: Record<string, string> = {
  navigate: "打开页面",
  computer: "页面操作",
  read_page: "读取页面",
  get_page_text: "提取文本",
  find: "查找元素",
  browser_batch: "批量操作",
  form_input: "填写表单",
  javascript_tool: "执行脚本",
  tabs_context_mcp: "标签页",
  tabs_create_mcp: "新建标签页",
};

/** Agent 内部的标签页管理，对用户没有信息量，不在列表里显示 */
const INTERNAL_TOOL = /^tabs_(context|create)/;
const NOISE_KEYS = new Set(["tabId", "createIfEmpty"]);

export interface StepView {
  /** 动作名，如「打开页面」；非工具调用的步骤（如启动）为空 */
  label: string;
  /** 动作对象，如网址；已截短 */
  target: string;
  internal: boolean;
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
export const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "");

function describeArgs(obj: Record<string, unknown>): string {
  if (typeof obj.url === "string") return shortUrl(obj.url);
  if (Array.isArray(obj.actions)) {
    return obj.actions
      .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
      .filter((n): n is string => typeof n === "string")
      .map((n) => TOOL_LABEL[n] ?? n)
      .join(" → ");
  }
  return Object.entries(obj)
    .filter(([k, v]) => !NOISE_KEYS.has(k) && v != null)
    .map(([, v]) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ");
}

/** 把后端存的步骤文字（`navigate  https://…`，或旧格式 `调用 navigate：{json}`）转成给人看的样子 */
export function describeStep(step: RunStep): StepView {
  const m = /^(?:调用\s+)?([A-Za-z0-9_.-]+)(?:[：:]\s*|\s{2})?([\s\S]*)$/.exec(step.text);
  const tool = m?.[1] ?? "";
  const rest = (m?.[2] ?? step.text).trim();

  let target = rest;
  if (rest.startsWith("{")) {
    try {
      target = describeArgs(JSON.parse(rest));
    } catch {
      const u = /"url":"([^"]+)"/.exec(rest);
      target = u ? shortUrl(u[1]!) : "";
    }
  } else if (/^https?:\/\//.test(rest)) {
    target = shortUrl(rest);
  }

  return {
    label: tool ? (TOOL_LABEL[tool] ?? tool) : "",
    target: clip(target, 80),
    internal: INTERNAL_TOOL.test(tool),
  };
}

/** 列表里只显示对用户有意义的步骤 */
export const visibleSteps = (steps: RunStep[]) => steps.filter((s) => !describeStep(s).internal);
