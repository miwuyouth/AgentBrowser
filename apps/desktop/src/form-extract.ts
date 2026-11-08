import type { FormField } from "./shared.ts";

/** 规范化 Agent 提交或解析出的表单数据 */
export function normalizeFormData(raw: unknown, fields: FormField[]): Record<string, string | number | null> {
  const result: Record<string, string | number | null> = {};
  if (!raw || typeof raw !== "object") return result;
  const rawObj = raw as Record<string, unknown>;

  for (const field of fields) {
    const val = rawObj[field.name] ?? rawObj[field.id] ?? rawObj[field.name.toLowerCase()];
    if (val === undefined || val === null || val === "") {
      result[field.name] = null;
      continue;
    }

    if (field.type === "number") {
      if (typeof val === "number" && !isNaN(val)) {
        result[field.name] = val;
      } else if (typeof val === "string") {
        const cleaned = val.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
        const num = cleaned ? Number(cleaned[0]) : NaN;
        result[field.name] = isNaN(num) ? null : num;
      } else {
        result[field.name] = null;
      }
    } else {
      result[field.name] = typeof val === "string" ? val : String(val);
    }
  }

  return result;
}

/** 若 Agent 未调工具但在文本中返回了 JSON，尝试兜底提取表单数据 */
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
      // 忽略解析失败
    }
  }
  return null;
}

