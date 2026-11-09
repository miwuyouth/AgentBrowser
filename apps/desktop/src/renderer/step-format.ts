import type { RunStep } from "../shared.ts";

/**
 * 运行步骤日志人话转译模块。
 * 负责将 Agent 底层生硬的工具名称（如 computer, navigate, javascript_tool）及参数剔除技术噪音，
 * 转化为普通用户直观易懂的界面动作描述。
 */

/** 工具名称到人话动作的映射字典 */
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

/** Agent 内部的标签页管理工具，对最终用户无直接信息量，在步骤列表中默认隐藏 */
const INTERNAL_TOOL = /^tabs_(context|create)/;

/** 步骤的人话展示视图数据结构 */
export interface StepView {
  /** 动作分类名称，如「打开页面」、「点击元素」；非工具步骤（如启动）为空 */
  label: string;
  /** 动作操作目标对象，如简化网址、输入文本；已安全截断 */
  target: string;
  /** 是否属于内部机器管理步骤（应在界面过滤隐藏） */
  internal: boolean;
}

/** 字符截断辅助函数 */
const clip = (v: string, n: number) => (v.length > n ? `${v.slice(0, n - 1)}…` : v);

/**
 * 网址简化工具。
 * 剥除开头的 http://、https://、www. 以及结尾的斜杠，便于小空间展示。
 */
export const shortUrl = (u: string) =>
  u
    .replace(/^https?:\/\/(www\.)?/, "")
    .replace(/\/$/, "");

/**
 * 从 JSON 文本或键值对字符串中提取指定 key 的值。
 *
 * 【调用时机】
 * 在 `formatToolCall` 提取工具入参参数值时内部调用。
 *
 * 【作用】
 * 支持解析标准 JSON 字符串，或通过正则表达式容错匹配 `key="value"`、`key='value'` 或 `key=value`。
 *
 * @param raw 参数原始字符串
 * @param key 目标键名
 * @returns 提取到的值字符串；未匹配则返回 null
 */
function parseField(raw: string, key: string): string | null {
  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw) as Record<string, unknown>;
      const v = obj[key];
      return v != null ? String(v) : null;
    } catch {
      // 容错降级，继续走正则提取
    }
  }
  // 匹配 key="value" 或 key=value
  const m = new RegExp(`(?:^|\\s)${key}=(?:"([^"]*)"|'([^']*)'|(\\S+))`).exec(raw);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

/**
 * 提炼工具步骤的人话表达，剔除代码、内部标识（ref_xx）等机器噪音。
 *
 * 【调用时机】
 * 在 `describeStep` 匹配到已知工具调用时内部调用。
 *
 * 【作用】
 * 针对各类工具定制人话转译逻辑：
 * - navigate: 提取 url 并简化显示；
 * - javascript_tool: 隐藏具体代码，按 fetch/scroll 等关键字提炼为"提取数据"或"滚动页面"；
 * - computer: 识别 action 参数细分为"点击元素"、"输入文本"、"按键操作"、"滚动页面"等；
 * - find: 提取 query 搜索词；
 * - form_input: 提取 value 输入值；
 * - browser_batch: 将子动作串联为 "打开页面 → 点击元素" 等直观流程。
 *
 * @param tool 底层工具名
 * @param raw 工具参数原始文本
 * @returns 人性化标签与操作目标对象
 */
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

/**
 * 将原始的单步运行日志（RunStep）转译为面向人类的可视化模型。
 *
 * 【调用时机】
 * 1. 实时视图（LiveView）在任务执行中渲染每一步的操作条目时调用；
 * 2. 运行详情页（RunDetailView）渲染完整的执行历史步骤列表时调用；
 * 3. `visibleSteps` 判定是否为内部工具时调用。
 *
 * 【作用】
 * 正则提取工具名称与入参，若为已知工具调用 `formatToolCall` 进行业务转译；
 * 若为用户补充指令等非工具操作，提取出指令摘要；
 * 返回包含人话标签、目标参数以及是否为内部不可见步骤的 StepView 对象。
 *
 * @param step 原始的 RunStep 步骤对象
 * @returns 转换后的 StepView 视图对象
 */
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

  // 启动步骤：主句只说启动了哪个内核，Profile 名（常是长邮箱）放到下面的灰字里
  const boot = /^(后台)?启动「(.+?)」，加载对应 Profile「(.+)」$/.exec(step.text.trim());
  if (boot) {
    return { label: `${boot[1] ?? ""}启动 ${boot[2]}`, target: `Profile：${boot[3]}`, internal: false };
  }

  // 无法识别工具名的纯描述文字（如「启动浏览器…」）整句作为目标，避免标签与目标重复
  if (!tool) {
    return { label: "", target: clip(step.text.trim(), 60), internal: false };
  }

  return {
    label: tool,
    target: clip(rest, 40),
    internal: false,
  };
}

/**
 * 过滤出仅对最终用户有明确信息量的可视步骤。
 *
 * 【调用时机】
 * 在 LiveView 实时时间轴和 RunDetailView 步骤列表渲染前调用。
 *
 * 【作用】
 * 剔除内部 `internal: true` 的标签页管理步骤，保持界面清爽聚焦。
 *
 * @param steps 完整的 RunStep 步骤数组
 * @returns 过滤后的有效步骤数组
 */
export const visibleSteps = (steps: RunStep[]) => steps.filter((s) => !describeStep(s).internal);
