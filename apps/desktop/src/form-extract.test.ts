import assert from "node:assert/strict";
import { normalizeFormData, tryExtractJsonFallback } from "./form-extract.ts";
import type { FormField } from "./shared.ts";

/**
 * 结构化表单提取与规范化清洗单元测试套件。
 */

let passed = 0;
/**
 * 简易单元测试断言运行包装器。
 * 【调用时机】执行每个独立用例时调用。
 * 【作用】执行测试逻辑，递增通过计数并在控制台输出成功勾选日志。
 */
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("form-extract");

const fields: FormField[] = [
  { id: "f1", name: "商品名称", type: "text" },
  { id: "f2", name: "商品价格", type: "number" },
  { id: "f3", name: "库存状态", type: "text" },
];

test("normalizeFormData: 正确提取文本与数字字段", () => {
  const raw = {
    "商品名称": "Apple iPhone 16 Pro",
    "商品价格": 7999,
    "库存状态": "现货",
  };
  const normalized = normalizeFormData(raw, fields);
  assert.equal(normalized["商品名称"], "Apple iPhone 16 Pro");
  assert.equal(normalized["商品价格"], 7999);
  assert.equal(normalized["库存状态"], "现货");
});

test("normalizeFormData: 数字字段包含货币符号与千分符时自动清洗", () => {
  const raw = {
    "商品名称": "MacBook Pro",
    "商品价格": "¥14,999.00",
  };
  const normalized = normalizeFormData(raw, fields);
  assert.equal(normalized["商品名称"], "MacBook Pro");
  assert.equal(normalized["商品价格"], 14999);
  assert.equal(normalized["库存状态"], null);
});

test("normalizeFormData: 缺失字段返回 null", () => {
  const raw = {
    "商品名称": "iPad Mini",
  };
  const normalized = normalizeFormData(raw, fields);
  assert.equal(normalized["商品名称"], "iPad Mini");
  assert.equal(normalized["商品价格"], null);
  assert.equal(normalized["库存状态"], null);
});

test("tryExtractJsonFallback: 从 Markdown 代码块中兜底提取 JSON", () => {
  const text = `
我已经完成查询，提取到如下数据：
\`\`\`json
{
  "商品名称": "RTX 4090",
  "商品价格": 12999,
  "库存状态": "有货"
}
\`\`\`
请确认。
`;
  const extracted = tryExtractJsonFallback(text, fields);
  assert.ok(extracted);
  assert.equal(extracted["商品名称"], "RTX 4090");
  assert.equal(extracted["商品价格"], 12999);
  assert.equal(extracted["库存状态"], "有货");
});

test("tryExtractJsonFallback: 从裸文本 JSON 中兜底提取", () => {
  const text = `最终结果是 {"商品名称": "键盘", "商品价格": "299"}，任务完成。`;
  const extracted = tryExtractJsonFallback(text, fields);
  assert.ok(extracted);
  assert.equal(extracted["商品名称"], "键盘");
  assert.equal(extracted["商品价格"], 299);
});

console.log(`\n${passed} 个测试全部通过`);
