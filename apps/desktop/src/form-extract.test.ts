import assert from "node:assert/strict";
import { describeSubmitData, normalizeFormData, reviewSubmission, tryExtractJsonFallback } from "./form-extract.ts";
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

const beans: FormField[] = [{ id: "f1", name: "京豆", type: "number", description: "领取完成后的京豆" }];

test("reviewSubmission: 正确提交时通过并写入数据", () => {
  const r = reviewSubmission({ 京豆: 3 }, beans);
  assert.equal(r.ok, true);
  assert.equal(r.data["京豆"], 3);
  assert.match(r.message, /已记录：「京豆」= 3/);
});

test("reviewSubmission: 自创键名（value/cmd）时不通过并给出正确格式", () => {
  const r = reviewSubmission({ value: 3, cmd: "京豆" }, beans);
  assert.equal(r.ok, false);
  assert.equal(r.data["京豆"], null);
  assert.match(r.message, /未定义的键：value、cmd/);
  assert.match(r.message, /缺少字段：「京豆」/);
  assert.match(r.message, /\{"data": \{"京豆": <数字>\}\}/);
});

test("reviewSubmission: 数字字段给了非数字时不通过，且不重复报缺少", () => {
  const r = reviewSubmission({ 京豆: "暂无" }, beans);
  assert.equal(r.ok, false);
  assert.match(r.message, /「京豆」应为纯数字/);
  assert.doesNotMatch(r.message, /缺少字段/);
});

test("reviewSubmission: 显式提交 null 视为已交代，可以通过", () => {
  const r = reviewSubmission({ 京豆: null }, beans);
  assert.equal(r.ok, true);
  assert.equal(r.data["京豆"], null);
});

test("reviewSubmission: 部分提交先记下，补交后合并通过", () => {
  const first = reviewSubmission({ 商品名称: "键盘" }, fields);
  assert.equal(first.ok, false);
  assert.equal(first.data["商品名称"], "键盘");
  assert.match(first.message, /本次已先记下：「商品名称」= "键盘"/);
  const rest = Object.fromEntries(fields.filter((f) => f.name !== "商品名称").map((f) => [f.name, f.type === "number" ? 1 : "x"]));
  const second = reviewSubmission(rest, fields, first);
  assert.equal(second.ok, true);
  assert.equal(second.data["商品名称"], "键盘");
});

test("reviewSubmission: 字段都对时多余键只提示忽略", () => {
  const r = reviewSubmission({ 京豆: "1,200", note: "已领取" }, beans);
  assert.equal(r.ok, true);
  assert.equal(r.data["京豆"], 1200);
  assert.match(r.message, /note（已忽略）/);
});

test("describeSubmitData: 列出字段名与格式模板", () => {
  assert.equal(
    describeSubmitData(beans),
    '本任务要提交的字段，键名必须与字段名完全一致：「京豆」数字。格式：{"京豆": <数字>}。页面上确实找不到的字段填 null。',
  );
});

console.log(`\n${passed} 个测试全部通过`);
