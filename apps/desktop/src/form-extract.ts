import type { FormField } from "./shared.ts";

/**
 * 规范化 Agent 提交或解析出的表单数据对象。
 *
 * 【调用时机】
 * 1. 当 Agent 在执行过程中调用了 `submit_result` 工具主动提交结构化数据时（由 `task-runner.ts` 的工具调用监听器触发）。
 * 2. 当 Agent 未调用工具，但在回复文本中输出了 JSON 字符串并被 `tryExtractJsonFallback` 捕获时调用。
 *
 * 【作用】
 * 根据任务配置中预期的表单字段规格（`fields`），对 Agent 提供的原始键值对数据进行清洗和对齐：
 * - 键名容错匹配：依次尝试 `field.name`、`field.id` 以及全小写名称 `field.name.toLowerCase()`。
 * - 空值处理：未提供或空字符串统一置为 `null`。
 * - 类型转换：
 *   - 数字字段（type === "number"）：自动剥除货币符号（如 ¥、$）及千分位逗号后转为浮点数/整数；无法解析为有效数字时返回 `null`。
 *   - 文本字段（type === "text"）：统一转为规范字符串。
 *
 * @param raw Agent 提交的未经清洗的原始对象数据
 * @param fields 任务定义中所期待提取的表单字段定义列表
 * @returns 规范化后的键值映射表，键为字段名称（field.name），值为文本、数值或 null
 */
export function normalizeFormData(raw: unknown, fields: FormField[]): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {};
  if (!raw || typeof raw !== "object") return result;
  const rawObj = raw as Record<string, unknown>;

  for (const field of fields) {
    const key = findFieldKey(rawObj, field);
    result[field.name] = key === undefined ? null : coerceFieldValue(rawObj[key], field);
  }

  return result;
}

/** 在提交对象里找到对应字段的键：依次尝试字段名、字段 id、小写字段名，以及去掉首尾空格后的键 */
function findFieldKey(rawObj: Record<string, unknown>, field: FormField): string | undefined {
  for (const key of [field.name, field.id, field.name.toLowerCase()]) {
    if (key in rawObj) return key;
  }
  return Object.keys(rawObj).find((k) => k.trim() === field.name);
}

/** 按字段类型规整单个值；空值或数字字段解析不出数字时返回 null */
function coerceFieldValue(val: unknown, field: FormField): string | number | null {
  if (val === undefined || val === null || val === "") return null;
  if (field.type === "number") {
    if (typeof val === "number") return isNaN(val) ? null : val;
    if (typeof val === "string") {
      const cleaned = val.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
      const num = cleaned ? Number(cleaned[0]) : NaN;
      return isNaN(num) ? null : num;
    }
    return null;
  }
  return typeof val === "string" ? val : String(val);
}

/** 字段的提交格式模板，如 `{"京豆": <数字>, "店名": "<文本>"}` */
export function submitTemplate(fields: FormField[]): string {
  const pairs = fields.map((f) => `${JSON.stringify(f.name)}: ${f.type === "number" ? "<数字>" : '"<文本>"'}`);
  return `{${pairs.join(", ")}}`;
}

/** `submit_result.data` 参数的说明文字：列出本任务必须使用的键和格式 */
export function describeSubmitData(fields: FormField[]): string {
  const list = fields.map((f) => `「${f.name}」${f.type === "number" ? "数字" : "文本"}`).join("；");
  return `本任务要提交的字段，键名必须与字段名完全一致：${list}。格式：${submitTemplate(fields)}。页面上确实找不到的字段填 null。`;
}

/** 一次 `submit_result` 的核对结果 */
export interface SubmitReview {
  /** 是否通过；不通过时 Agent 需要改正后重新提交 */
  ok: boolean;
  /** 给 Agent 的回执（通过）或改正说明（不通过） */
  message: string;
  /** 合并本次提交后的完整表单数据（键为字段名） */
  data: Record<string, string | number | null>;
  /** 至今已明确提交过的字段名（包括显式提交 null 的） */
  provided: string[];
}

/**
 * 核对 Agent 通过 `submit_result` 提交的数据，并与之前的提交合并。
 *
 * 【调用时机】Agent 每次调用 `submit_result` 时，由 `task-runner.ts` 交给执行器的校验回调调用。
 *
 * 【规则】
 * - 本次带上的字段覆盖之前的值，没带上的保留之前的值，便于 Agent 分几次补交；
 * - 不通过：一个字段都没认出来、数字字段给的不是数字、或有字段至今从未提交过（找不到的应显式提交 null）；
 * - 未定义的多余键：其余都正确时只提示已忽略，不算失败。
 * 即使不通过，本次合法的值也会先记下，避免 Agent 放弃重试时丢掉已拿到的数据。
 *
 * @param raw Agent 提交的 `data` 对象
 * @param fields 任务定义的表单字段
 * @param previous 之前提交合并后的结果；首次提交时不传
 */
export function reviewSubmission(
  raw: Record<string, unknown>,
  fields: FormField[],
  previous?: Pick<SubmitReview, "data" | "provided">,
): SubmitReview {
  const data: Record<string, string | number | null> = {};
  for (const f of fields) data[f.name] = previous?.data[f.name] ?? null;
  const provided = new Set(previous?.provided ?? []);

  const matchedKeys = new Set<string>();
  const accepted: string[] = [];
  const badNumbers: string[] = [];
  const badNames = new Set<string>();
  for (const field of fields) {
    const key = findFieldKey(raw, field);
    if (key === undefined) continue;
    matchedKeys.add(key);
    const value = coerceFieldValue(raw[key], field);
    const given = raw[key];
    if (value === null && given !== null && given !== undefined && given !== "") {
      badNumbers.push(`「${field.name}」应为纯数字，收到：${JSON.stringify(given)}`);
      badNames.add(field.name);
      continue;
    }
    data[field.name] = value;
    provided.add(field.name);
    accepted.push(field.name);
  }
  const unknownKeys = Object.keys(raw).filter((k) => !matchedKeys.has(k));
  const missing = fields.filter((f) => !provided.has(f.name) && !badNames.has(f.name)).map((f) => f.name);

  const recorded = accepted.map((name) => `「${name}」= ${JSON.stringify(data[name])}`).join("，");
  const unknownNote = unknownKeys.length ? `未定义的键：${unknownKeys.join("、")}` : "";
  const ok = accepted.length > 0 && badNumbers.length === 0 && missing.length === 0;

  if (ok) {
    const lines = [`已记录：${recorded}。`];
    if (unknownNote) lines.push(`${unknownNote}（已忽略）。`);
    return { ok, message: lines.join("\n"), data, provided: [...provided] };
  }

  const problems: string[] = [];
  if (unknownNote) problems.push(`${unknownNote}（data 的键必须是字段名本身）`);
  if (missing.length) problems.push(`缺少字段：${missing.map((n) => `「${n}」`).join("、")}（页面上确实找不到的请显式提交 null）`);
  problems.push(...badNumbers);
  const lines = ["提交未通过，请修正后重新调用 submit_result：", ...problems.map((p) => `- ${p}`)];
  if (recorded) lines.push(`本次已先记下：${recorded}。`);
  lines.push(`正确格式：{"data": ${submitTemplate(fields)}}`);
  return { ok, message: lines.join("\n"), data, provided: [...provided] };
}

/**
 * 当 Agent 未调用提交工具时，尝试从自然语言回复文本中兜底提取 JSON 表单数据。
 *
 * 【调用时机】
 * 在任务执行结束且属于配置了 `fields` 表单字段提取的任务中，若 Agent 产生最终文本回复且未曾成功通过 `submit_result` 提交数据时调用（由 `task-runner.ts` 在处理 `assistant_turn` 事件时触发）。
 *
 * 【作用】
 * 大语言模型有时会忽略工具调用指令，直接在聊天回复中以 Markdown 代码块或纯文本的形式输出 JSON。
 * 本函数通过正则表达式搜寻文本中的 ```json ... ``` 代码块或裸 `{...}` JSON 串：
 * 1. 尝试使用 `JSON.parse` 解析潜在候选字符串；
 * 2. 校验解析出的对象中是否至少包含一个目标表单字段的 `name` 或 `id`；
 * 3. 命中后调用 `normalizeFormData` 完成格式规整化并返回；若全部解析失败或未匹配目标字段则返回 `null`。
 *
 * @param text Agent 输出的最终回复文本
 * @param fields 任务定义中所期待提取的表单字段列表
 * @returns 提取并规范化后的表单键值对象；若提取失败则返回 null
 */
export function tryExtractJsonFallback(text: string, fields: FormField[]): Record<string, string | number | null> | null {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  const candidates: string[] = [];
  if (codeBlockMatch?.[1]) candidates.push(codeBlockMatch[1]);
  const braceMatch = text.match(/\{[\s\S]*\}/);
  if (braceMatch?.[0]) candidates.push(braceMatch[0]);

  for (const str of candidates) {
    try {
      const parsed = JSON.parse(str.trim());
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const hasKey = fields.some((f) => f.name in parsed || f.id in parsed);
        if (hasKey) {
          return normalizeFormData(parsed, fields);
        }
      }
    } catch {
      // 忽略候选串解析失败，继续尝试下一个匹配项
    }
  }
  return null;
}
