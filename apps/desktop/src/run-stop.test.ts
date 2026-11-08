import assert from "node:assert/strict";
import { DEFAULT_ADVICE, RunStopped, describeStop, describeTimeout } from "./run-stop.ts";

/**
 * 运行终止状态与排查建议转译单元测试套件。
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

console.log("run-stop");
test("正常结束不算失败", () => {
  assert.equal(describeStop("end_turn", undefined), null);
  assert.equal(describeStop(undefined, undefined), null);
});
test("步数用完：说明上限并建议调大", () => {
  const s = describeStop("max_steps", "Stopped after 30 steps.", 30)!;
  assert.ok(s instanceof RunStopped);
  assert.equal(s.message, "已达到最大步数（30 步），任务仍未完成");
  assert.match(s.advice, /调大最大步数/);
});
test("没有步数信息时也能给出原因", () => {
  assert.equal(describeStop("max_steps", undefined)!.message, "已达到最大步数，任务仍未完成");
});
test("用户终止", () => {
  const s = describeStop("cancelled", undefined)!;
  assert.equal(s.message, "用户主动终止任务");
  assert.equal(s.advice, "已中止");
});
test("模型拒绝、截断", () => {
  assert.equal(describeStop("refusal", "违反政策")!.message, "模型拒绝执行：违反政策");
  assert.match(describeStop("max_tokens", undefined)!.message, /截断/);
});
test("API 报错：用 Agent 给出的信息，没有则兜底，并给出通用建议", () => {
  const withMsg = describeStop("error", "401 invalid api key")!;
  assert.equal(withMsg.message, "401 invalid api key");
  assert.equal(withMsg.advice, DEFAULT_ADVICE);
  assert.equal(describeStop("error", undefined)!.message, "模型调用失败");
});
test("超时：说明时长并建议调大超时", () => {
  const s = describeTimeout(10);
  assert.equal(s.message, "任务运行超过 10 分钟，已自动终止");
  assert.match(s.advice, /调大超时时间/);
});

console.log(`\n${passed} 个测试全部通过`);
