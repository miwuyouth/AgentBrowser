import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { RunStore } from "./run-store.ts";
import type { RunRecord } from "./shared.ts";

let passed = 0;
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
  assert.equal(store.list()[0]!.endTime, 2000);
});
test("列表按开始时间倒序", (store) => {
  store.save(run("old", { startTime: 1 }), { index: true });
  store.save(run("new", { startTime: 3 }), { index: true });
  store.save(run("mid", { startTime: 2 }), { index: true });
  assert.deepEqual(store.list().map((s) => s.id), ["new", "mid", "old"]);
});
test("截图存成独立文件，记录里只有文件名", (store) => {
  const file = store.saveShot("a", 3, "image/jpeg", Buffer.from("fake-image").toString("base64"));
  assert.equal(file, "3.jpg");
  assert.equal(readFileSync(store.shotPath("a", file)!, "utf8"), "fake-image");
  assert.equal(store.saveShot("a", 4, "image/png", "AA=="), "4.png");
  assert.equal(store.saveShot("a", 5, "image/unknown", "AA=="), "5.png");
});
test("截图路径：拒绝越界、非法文件名、不存在的文件", (store) => {
  store.saveShot("a", 1, "image/png", "AA==");
  assert.ok(store.shotPath("a", "1.png"));
  assert.equal(store.shotPath("../a", "1.png"), null);
  assert.equal(store.shotPath("a", "../1.png"), null);
  assert.equal(store.shotPath("a", "run.json"), null);
  assert.equal(store.shotPath("a", "9.png"), null);
  assert.equal(store.shotPath("nope", "1.png"), null);
});
test("删除：连同截图一起删掉，返回实际删除条数，忽略非法 id", (store, root) => {
  store.save(run("a"), { index: true });
  store.saveShot("a", 1, "image/png", "AA==");
  store.save(run("b"), { index: true });
  assert.equal(store.remove(["a", "../../etc", "missing"]), 1);
  assert.ok(!existsSync(path.join(root, "a")));
  assert.deepEqual(store.list().map((s) => s.id), ["b"]);
});
test("非法的运行 ID 不能写入", (store) => {
  assert.throws(() => store.save(run("../evil")), /非法/);
  assert.equal(store.get("../evil"), null);
});
test("索引损坏或不存在时不报错", (store, root) => {
  assert.deepEqual(store.list(), []);
  writeFileSync(path.join(root, "index.json"), "{ not json");
  assert.deepEqual(store.list(), []);
  assert.equal(store.get("missing"), null);
});

console.log(`\n${passed} 个测试全部通过`);
