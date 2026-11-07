/**
 * App 宿主侧实现的自然语言元素查找（`find` 工具）。
 *
 * 工作流原理：
 * 1. 扩展端提取 DOM 候选节点：通过内部工具 `find_candidates` 收集页面所有交互候选元素（按钮、链接、输入框等）；
 * 2. 候选元素压缩与优先级排序：优先视口内可见元素，控制在 Token 预算（MAX_CANDIDATES = 1200）内；
 * 3. 辅助轻量模型语义匹配：调用低成本快速小模型（如 Haiku），将自然语言描述与元素特征比对，输出符合条件的 ref 列表及原因；
 * 4. 汇总匹配项返回给 Agent 主模型，Agent 即可直接使用匹配到的 `ref` 执行点击或输入。
 */

import { FIND_CANDIDATES_TOOL, errorResult, text, type ToolResult } from "@agent-browser/protocol";
import type { BrowserBridge } from "@agent-browser/bridge";
import type { JsonRequest } from "./providers/types.ts";

/** DOM 候选元素数据结构 */
interface Candidate {
  ref: string;
  role: string;
  name: string;
  text?: string;
  context?: string;
  attrs?: string;
  href?: string;
  visible: boolean;
  inViewport: boolean;
  disabled?: boolean;
}

/** 参与比对的最大候选元素数量 */
const MAX_CANDIDATES = 1200;
/** 返回给 Agent 的最大匹配结果数量 */
const MAX_MATCHES = 20;

/** 字符串截断辅助函数 */
const clip = (s: string | undefined, n: number) => (s && s.length > n ? s.slice(0, n) + "…" : s ?? "");

/** 将单个候选元素紧凑序列化为单行文本，减少 Prompt Token 消耗 */
function line(c: Candidate): string {
  const parts = [c.ref, c.role, JSON.stringify(clip(c.name, 80))];
  if (c.text) parts.push(`text=${JSON.stringify(clip(c.text, 80))}`);
  if (c.context) parts.push(`in=${JSON.stringify(clip(c.context, 80))}`);
  if (c.attrs) parts.push(clip(c.attrs, 80));
  if (c.href) parts.push(`href=${clip(c.href, 60)}`);
  parts.push(c.inViewport ? "in-viewport" : c.visible ? "off-screen" : "hidden");
  if (c.disabled) parts.push("disabled");
  return parts.join(" | ");
}

/** 辅助小模型输出的 JSON Schema 定义 */
const MATCH_SCHEMA = {
  type: "object",
  properties: {
    matches: {
      type: "array",
      items: {
        type: "object",
        properties: { ref: { type: "string" }, reason: { type: "string" } },
        required: ["ref", "reason"],
        additionalProperties: false,
      },
    },
    more: { type: "boolean" },
  },
  required: ["matches", "more"],
  additionalProperties: false,
} as const;

/**
 * 执行元素自然语言查找：
 * 扩展端收集候选，小模型做语义筛选与排序。
 */
export async function findElements(
  bridge: BrowserBridge,
  completeJson: (request: JsonRequest) => Promise<string>,
  input: { query: string; tabId: number },
  signal?: AbortSignal,
): Promise<ToolResult> {
  // 1. 调用扩展侧内部工具获取 DOM 候选列表
  const raw = await bridge.call(FIND_CANDIDATES_TOOL, { tabId: input.tabId, limit: MAX_CANDIDATES * 2 }, signal ? { signal } : {});
  if (raw.isError) return raw;
  const first = raw.content[0];
  let candidates: Candidate[] = JSON.parse(first?.type === "text" ? first.text : "[]");
  if (candidates.length === 0) return { content: [text("The page has no interactive elements to search.")] };

  // 2. 优先可见元素，控制在预算条数以内
  candidates = [...candidates.filter((c) => c.visible), ...candidates.filter((c) => !c.visible)].slice(0, MAX_CANDIDATES);
  const byRef = new Map(candidates.map((c) => [c.ref, c]));

  // 3. 调用轻量模型进行自然语言匹配
  let answer: string;
  try {
    answer = await completeJson({
      system:
        "You match a description of a web page element against a list of candidate elements. Each line is: ref | role | name | details | visibility. " +
        `Return the refs that match, best first, at most ${MAX_MATCHES}, each with a short reason. Set more to true if further elements also match. Return an empty list if nothing matches.`,
      prompt: `Description: ${input.query}\n\nCandidates:\n${candidates.map(line).join("\n")}`,
      schema: MATCH_SCHEMA as unknown as Record<string, unknown>,
      ...(signal ? { signal } : {}),
    });
  } catch (err) {
    return errorResult(`The element search failed (${err instanceof Error ? err.message : String(err)}); use read_page instead.`, "find_failed");
  }

  // 4. 解析结果并做校验
  let parsed: { matches: { ref: string; reason: string }[]; more?: boolean };
  try {
    parsed = JSON.parse(answer);
    if (!Array.isArray(parsed.matches)) throw new Error("no matches array");
  } catch {
    return errorResult("The element search returned an unreadable answer; use read_page instead.", "find_failed");
  }
  const matches = parsed.matches.filter((m) => byRef.has(m.ref)).slice(0, MAX_MATCHES);
  if (matches.length === 0) {
    return { content: [text(`No element matches ${JSON.stringify(input.query)}. Try another description, scroll, or use read_page.`)] };
  }

  // 5. 格式化输出匹配详情与 ref 标识
  const lines = matches.map((m) => {
    const c = byRef.get(m.ref)!;
    return `- ${c.ref} ${c.role} ${JSON.stringify(c.name || c.text || "")} (${c.inViewport ? "in viewport" : c.visible ? "off-screen" : "hidden"}) — ${m.reason}`;
  });
  const more = parsed.more ? "\nMore elements match; use a more specific description to narrow it down." : "";
  return { content: [text(`Found ${matches.length} match(es) for ${JSON.stringify(input.query)}:\n${lines.join("\n")}${more}`)] };
}
