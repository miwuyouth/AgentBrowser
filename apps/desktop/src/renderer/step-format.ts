import type { RunStep } from "../shared.ts";

/** 工具名 → 人话。未知工具原样显示 */
export const TOOL_LABEL: Record<string, string> = {
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
  submit_result: "提交结果",
};

/** Agent 内部的标签页管理，对用户没有信息量，不在列表里显示 */
const INTERNAL_TOOL = /^tabs_(context|create)/;

export interface StepView {
  /** 动作名，如「打开页面」；非工具调用的步骤（如启动）为空 */
  label: string;
  /** 动作对象，如网址；已截短。无高价值信息时为空字符串 */
  target: string;
  internal: boolean;
}

const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);
export const shortUrl = (u: string) =>
  u
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/$/, "");

/** 从 JSON 文本或键值对字符串中提取指定 key 的值 */
function parseField(raw: string, key: string): string | null {
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const v = obj[key];
      return v != null ? String(v) : null;
    } catch {
      // 容错降级
    }
  }
  // 匹配 key="value" 或 key=value
  const m = new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/** 提炼工具步骤的人话表达，剔除代码、内部标识（ref_xx）等机器噪音 */
function formatToolCall(tool: string, raw: string): { label: string; target: string } {
  if (tool === "navigate") {
    let url = "";
    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw) as { url?: string };
        url = obj.url ?? "";
      } catch {
        const m = /"url"\s*:\s*"([^"]+)"/.exec(raw);
        url = m ? m[1]! : "";
      }
    } else {
      const m = /(?:url=)?(https?:\/\/[^\s]+|[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}[^\s]*)/.exec(raw);
      url = m ? m[1]! : raw;
    }
    return {
      label: "打开页面",
      target: url ? clip(shortUrl(url), 60) : "",
    };
  }

  if (tool === "javascript_tool") {
    // 脚本代码完全隐藏，提取业务意图，绝不在界面中输出生硬代码片段
    const hasFetch = /fetch|axios|api|\/t\//i.test(raw);
    const hasScroll = /scroll/i.test(raw);
    return {
      label: hasFetch ? "提取数据" : hasScroll ? "滚动页面" : "执行脚本",
      target: "",
    };
  }

  if (tool === "computer") {
    const action = parseField(raw, "action") || raw;
    const isClick = /click/i.test(action);
    const isType = /type/i.test(action);
    const isKey = /(?:^|\s)key(?:\s|=|$)/i.test(action);
    const isScroll = /scroll/i.test(action);
    const isWait = /wait/i.test(action);

    if (isClick) {
      return { label: "点击元素", target: "" };
    }
    if (isType) {
      const text = parseField(raw, "text");
      return {
        label: "输入文本",
        target: text ? `"${clip(text, 24)}"` : "",
      };
    }
    if (isKey) {
      const text = parseField(raw, "text");
      return {
        label: "按键操作",
        target: text ? clip(text, 20) : "",
      };
    }
    if (isScroll) {
      return { label: "滚动页面", target: "" };
    }
    if (isWait) {
      return { label: "等待页面", target: "" };
    }
    return { label: "页面操作", target: "" };
  }

  if (tool === "read_page") {
    return { label: "读取页面", target: "" };
  }

  if (tool === "get_page_text") {
    return { label: "提取文本", target: "" };
  }

  if (tool === "find") {
    const query = parseField(raw, "query");
    return {
      label: "查找元素",
      target: query ? `"${clip(query, 24)}"` : "",
    };
  }

  if (tool === "form_input") {
    const val = parseField(raw, "value");
    return {
      label: "填写表单",
      target: val ? clip(val, 24) : "",
    };
  }

  if (tool === "submit_result") {
    return { label: "提交结果", target: "" };
  }

  if (tool === "browser_batch") {
    if (raw.startsWith("{")) {
      try {
        const obj = JSON.parse(raw) as { actions?: Array<{ name?: string }> };
        if (Array.isArray(obj.actions)) {
          const names = obj.actions
            .map((a) => (a && typeof a === "object" ? a.name : null))
            .filter((n): n is string => typeof n === "string")
            .map((n) => TOOL_LABEL[n] ?? n);
          return { label: "批量操作", target: clip(names.join(" → "), 40) };
        }
      } catch {
        // ignore
      }
    }
    return { label: "批量操作", target: "" };
  }

  return {
    label: TOOL_LABEL[tool] ?? tool,
    target: "",
  };
}

/** 把步骤文字转成给人看的样子 */
export function describeStep(step: RunStep): StepView {
  const m = /^(?:调用\s+)?([A-Za-z0-9_.-]+)(?:[：:]\s*|\s{2})?([\s\S]*)$/.exec(step.text);
  const tool = m?.[1] ?? "";
  const rest = (m?.[2] ?? step.text).trim();

  // 如果识别为已知工具，使用专用人话转译
  if (tool && tool in TOOL_LABEL) {
    const formatted = formatToolCall(tool, rest);
    return {
      label: formatted.label,
      target: formatted.target,
      internal: INTERNAL_TOOL.test(tool),
    };
  }

  // 非工具调用或普通指令（如「用户补充指令：xxx」）
  if (step.text.startsWith("用户补充指令")) {
    const colon = step.text.indexOf("：") !== -1 ? step.text.indexOf("：") : step.text.indexOf(":");
    return {
      label: "用户指令",
      target: colon !== -1 ? clip(step.text.slice(colon + 1).trim(), 40) : "",
      internal: false,
    };
  }

  return {
    label: tool || step.text,
    target: clip(rest, 40),
    internal: false,
  };
}

/** 列表里只显示对用户有意义的步骤 */
export const visibleSteps = (steps: RunStep[]) => steps.filter((s) => !describeStep(s).internal);
