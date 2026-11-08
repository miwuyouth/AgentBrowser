import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "./run-store.ts";
import { capLog, lightRun, type RunRecord } from "./shared.ts";

/**
 * 运行记录本地存储管理器（RunStore）单元测试套件。
 */

let passed = 0;
/**
 * 自动创建与销毁临时测试目录的测试运行器。
 * 【调用时机】执行每个独立存储测试时调用。
 * 【作用】在系统临时目录生成沙箱根目录，注入新建的 RunStore 实例，执行后自动物理清理。
 */
const test = (name: string, fn: (store: RunStore, root: string) => void) => {
  const root = mkdtempSync(path.join(os.tmpdir(), "run-store-"));
  try {
    fn(new RunStore(root), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  passed++;
  console.log(`  ✓ ${name}`);
};

/**
 * 构造模拟运行记录实体。
 * 【调用时机】测试用例准备测试数据时调用。
 */
const run = (id: string, over: Partial<RunRecord> = {}): RunRecord => ({
  id,
  taskId: "t1",
  name: "任务",
  status: "run",
  startTime: 1000,
  trigger: "手动触发",
  summary: "",
  steps: [{ stepNumber: 1, status: "done", tag: "启动", text: "启动", meta: "已就绪" }],
  ...over,
});

console.log("run-store");
test("保存后：列表只有摘要，详情有完整步骤", (store) => {
  store.save(run("a"), { index: true });
  const [s] = store.list();
  assert.equal(s!.id, "a");
  assert.ok(!("steps" in s!), "摘要里不该带步骤");
  assert.equal(store.get("a")!.steps.length, 1);
});
test("运行中每一步只写自己的文件，不动索引", (store, root) => {
  store.save(run("a"), { index: true });
  const before = readFileSync(path.join(root, "index.json"), "utf8");
  store.save(run("a", { status: "ok", endTime: 2000 }));
  assert.equal(readFileSync(path.join(root, "index.json"), "utf8"), before);
  assert.equal(store.get("a")!.status, "ok");
  assert.equal(store.list()[0]!.status, "run");
});
test("结束时更新索引，不会重复出现", (store) => {
  store.save(run("a"), { index: true });
  store.save(run("a", { status: "fail", endTime: 2000 }), { index: true });
  assert.equal(store.list().length, 1);
  assert.equal(store.list()[0]!.status, "fail");
});
test("按开始时间倒序排", (store) => {
  store.save(run("early", { startTime: 1000 }), { index: true });
  store.save(run("late", { startTime: 2000 }), { index: true });
  assert.deepEqual(store.list().map((s) => s.id), ["late", "early"]);
});
test("存截图：存在自己的目录里，文件名就是编号", (store, root) => {
  const file = store.saveShot("a", 3, "image/png", Buffer.from("hello").toString("base64"));
  assert.equal(file, "3.png");
  assert.ok(existsSync(path.join(root, "a", "shots", "3.png")));
  assert.equal(readFileSync(path.join(root, "a", "shots", "3.png"), "utf8"), "hello");
});
test("shotPath：文件不存在或文件名不合法返回 null", (store) => {
  store.saveShot("a", 1, "image/png", Buffer.from("x").toString("base64"));
  assert.ok(store.shotPath("a", "1.png") !== null);
  assert.equal(store.shotPath("a", "2.png"), null);
  assert.equal(store.shotPath("a", "../index.json"), null);
  assert.equal(store.shotPath("../evil", "1.png"), null);
});
test("删除运行记录：删目录并从索引拿掉", (store, root) => {
  store.save(run("a"), { index: true });
  store.save(run("b"), { index: true });
  store.saveShot("a", 1, "image/png", "eA==");
  assert.equal(store.remove(["a"]), 1);
  assert.deepEqual(store.list().map((s) => s.id), ["b"]);
  assert.ok(!existsSync(path.join(root, "a")));
  assert.equal(store.get("a"), null);
});
test("非法的 run ID 抛错，不往奇怪路径写", (store) => {
  assert.throws(() => store.save(run("../evil")), /非法/);
});
test("完整日志字段随 run.json 原样落盘并读回", (store) => {
  const r = run("log");
  r.prompt = "任务目标：x";
  r.steps = [{ stepNumber: 1, status: "done", tag: "动作", text: "find", meta: "", thought: "先找按钮", tool: "find", input: '{"query":"a"}', output: "ref_1", isError: true }];
  store.save(r);
  const back = store.get("log")!;
  assert.equal(back.prompt, "任务目标：x");
  assert.deepEqual(back.steps[0], r.steps[0]);
});
test("lightRun 去掉完整入参/返回/说明，保留步骤骨架；capLog 截断并注明原长", () => {
  const r = run("light");
  r.prompt = "p";
  r.steps = [{ stepNumber: 1, status: "done", tag: "动作", text: "find", meta: "用时 1ms", screenshot: "1.png", thought: "t", tool: "find", input: "i", output: "o", isError: false }];
  const l = lightRun(r);
  assert.equal("prompt" in l, false);
  assert.deepEqual(l.steps[0], { stepNumber: 1, status: "done", tag: "动作", text: "find", meta: "用时 1ms", screenshot: "1.png", tool: "find", isError: false });
  assert.equal(r.steps[0]!.input, "i", "不修改原对象");
  assert.equal(capLog("abc", 10), "abc");
  assert.match(capLog("x".repeat(20), 5), /^xxxxx\n…（已截断，原文共 20 字）$/);
});

console.log(`\n${passed} 个测试全部通过`);
