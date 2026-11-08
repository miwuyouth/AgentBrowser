import assert from "node:assert/strict";
import { describeStep, shortUrl, visibleSteps } from "./renderer/step-format.ts";
import type { RunStep } from "./shared.ts";

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

const makeStep = (text: string, status: RunStep["status"] = "done"): RunStep => ({
  stepNumber: 1,
  status,
  tag: "动作",
  text,
  meta: "",
});

console.log("step-format");

test("navigate 工具：提取并精简 URL 作为 target", () => {
  const s1 = describeStep(makeStep("navigate  https://v2ex.com/?tab=hot"));
  assert.equal(s1.label, "打开页面");
  assert.equal(s1.target, "v2ex.com/?tab=hot");

  const s2 = describeStep(makeStep('调用 navigate：{"url":"https://www.google.com/"}'));
  assert.equal(s2.label, "打开页面");
  assert.equal(s2.target, "google.com");
});

test("javascript_tool 工具：提取意图并隐藏生硬代码", () => {
  // 包含 fetch / 接口特征
  const s1 = describeStep(makeStep("javascript_tool  action=javascript_exec text=fetch('/t/1255299')"));
  assert.equal(s1.label, "提取数据");
  assert.equal(s1.target, "");

  const s2 = describeStep(makeStep("javascript_tool  text=const res = await fetch('/t/1255299'); console.log(res);"));
  assert.equal(s2.label, "提取数据");
  assert.equal(s2.target, "");

  // 普通通用脚本
  const s3 = describeStep(makeStep("javascript_tool  document.title"));
  assert.equal(s3.label, "执行脚本");
  assert.equal(s3.target, "");

  // 滚动脚本
  const s4 = describeStep(makeStep("javascript_tool  window.scrollTo(0, 1000)"));
  assert.equal(s4.label, "滚动页面");
  assert.equal(s4.target, "");
});

test("computer 工具：人话转译并隐藏 ref/坐标", () => {
  // 点击
  const s1 = describeStep(makeStep("computer  action=left_click ref=ref_25"));
  assert.equal(s1.label, "点击元素");
  assert.equal(s1.target, "");

  const s2 = describeStep(makeStep("computer  left_click"));
  assert.equal(s2.label, "点击元素");
  assert.equal(s2.target, "");

  // 输入
  const s3 = describeStep(makeStep('computer  type text="agent-browser"'));
  assert.equal(s3.label, "输入文本");
  assert.equal(s3.target, '"agent-browser"');

  // 按键
  const s4 = describeStep(makeStep('computer  key text="Enter"'));
  assert.equal(s4.label, "按键操作");
  assert.equal(s4.target, "Enter");

  // 滚动
  const s5 = describeStep(makeStep("computer  action=scroll scroll_direction=down"));
  assert.equal(s5.label, "滚动页面");
  assert.equal(s5.target, "");
});

test("read_page 与 get_page_text：过滤参数，仅保留干净标题", () => {
  const s1 = describeStep(makeStep("read_page  filter=interactive"));
  assert.equal(s1.label, "读取页面");
  assert.equal(s1.target, "");

  const s2 = describeStep(makeStep("get_page_text  max_chars=50000"));
  assert.equal(s2.label, "提取文本");
  assert.equal(s2.target, "");
});

test("find 与 form_input：保留对用户有价值的目标，隐藏内部字段", () => {
  const s1 = describeStep(makeStep('find  query="登录"'));
  assert.equal(s1.label, "查找元素");
  assert.equal(s1.target, '"登录"');

  const s2 = describeStep(makeStep('form_input  ref=ref_12 value="100"'));
  assert.equal(s2.label, "填写表单");
  assert.equal(s2.target, "100");
});

test("用户补充指令", () => {
  const s = describeStep(makeStep("用户补充指令：点击第一项"));
  assert.equal(s.label, "用户指令");
  assert.equal(s.target, "点击第一项");
});

test("visibleSteps 过滤内部标签页管理步骤", () => {
  const steps: RunStep[] = [
    makeStep("tabs_context_mcp  createIfEmpty=true"),
    makeStep("navigate  https://v2ex.com"),
    makeStep("tabs_create_mcp"),
  ];
  const filtered = visibleSteps(steps);
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0]!.text, "navigate  https://v2ex.com");
});

test("shortUrl 处理", () => {
  assert.equal(shortUrl("https://www.example.com/test/"), "example.com/test");
  assert.equal(shortUrl("http://example.com/"), "example.com");
});

console.log(`\n${passed} 个测试全部通过`);

