import type { JsonSchema, JsonType } from "./tools.ts";

/**
 * 针对工具输入参数（Tool Input）的轻量级 JSON Schema 校验器。
 * 仅覆盖 tools.ts 中使用到的 Schema 子集。
 * 
 * 校验规则：
 * 如果符合 Schema 规则，返回 null；
 * 如果不符合规则，返回人类可读的具体错误说明字符串。
 * 
 * 双端校验机制：
 * 1. App 端在把大模型生成（或流式拼接）的参数下发给扩展之前先校验；
 * 2. 浏览器扩展端在接收到调用消息时二次校验，确保安全与参数准确。
 */
export function validateAgainstSchema(schema: JsonSchema, value: unknown, path = "input"): string | null {
  // 校验数据类型（type 支持单一类型或数组联合类型）
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      return `${path} must be ${types.join(" or ")}, got ${describe(value)}`;
    }
  }
  // 校验枚举值范围
  if (schema.enum && !schema.enum.includes(value as never)) {
    return `${path} must be one of ${schema.enum.map((e) => JSON.stringify(e)).join(", ")}`;
  }
  // 校验数字大小范围
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) return `${path} must be >= ${schema.minimum}`;
    if (schema.maximum !== undefined && value > schema.maximum) return `${path} must be <= ${schema.maximum}`;
  }
  // 校验数组长度及子元素
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) return `${path} needs at least ${schema.minItems} items`;
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return `${path} allows at most ${schema.maxItems} items`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const problem = validateAgainstSchema(schema.items, value[i], `${path}[${i}]`);
        if (problem) return problem;
      }
    }
  }
  // 校验对象属性（必填字段、字段属性、是否允许额外未知字段）
  if (isPlainObject(value)) {
    for (const key of schema.required ?? []) {
      if (value[key] === undefined) return `${path}.${key} is required`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (value[key] === undefined) continue;
      const problem = validateAgainstSchema(sub, value[key], `${path}.${key}`);
      if (problem) return problem;
    }
    if (schema.additionalProperties === false && schema.properties) {
      const extra = Object.keys(value).find((k) => !(k in schema.properties!));
      if (extra) return `${path}.${extra} is not allowed`;
    }
  }
  return null;
}

/** 检查给定值是否符合指定的 JSON Schema 基础类型 */
function matchesType(type: JsonType, value: unknown): boolean {
  switch (type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return isPlainObject(value);
    case "null":
      return value === null;
  }
}

/** 判断是否为纯对象（非 null，非数组） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 获取人类可读的值类型描述，便于生成错误信息 */
function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  return typeof value;
}
