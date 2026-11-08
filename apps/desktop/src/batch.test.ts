import assert from "node:assert/strict";
import { groupRuns, planRunProfiles, summarizeBatch } from "./batch.ts";
import type { RunSummary } from "./shared.ts";

/**
 * 「一轮」纯函数（选 Profile、运行记录按轮分组）单元测试。
 */

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

// 该内核的 Profile，按「运行环境」里的顺序
const main = { id: "c::default", isDefault: true };
const work = { id: "c::work" };
const shop = { id: "c::shop" };
const all = [main, work, shop];

test("按「运行环境」里的顺序运行，不按勾选顺序", () => {
  const plan = planRunProfiles({ profileIds: ["c::shop", "c::work"] }, all);
  assert.deepEqual(plan, { kind: "existing", profiles: [work, shop] });
});

test("勾选的 Profile 被删掉了就跳过；全被删掉时退回默认 Profile", () => {
  assert.deepEqual(planRunProfiles({ profileIds: ["c::gone", "c::work"] }, all), { kind: "existing", profiles: [work] });
  assert.deepEqual(planRunProfiles({ profileIds: ["c::gone"] }, all), { kind: "existing", profiles: [main] });
  assert.deepEqual(planRunProfiles({ profileIds: [] }, [work, shop]), { kind: "existing", profiles: [work] });
});

test("每次新建，或该内核一个 Profile 都没有：新建", () => {
  assert.deepEqual(planRunProfiles({ profileIds: [], autoProfile: true }, all), { kind: "create" });
  assert.deepEqual(planRunProfiles({ profileIds: ["c::work"] }, []), { kind: "create" });
});

test("重试只跑指定的 Profile；都被删了就报错，不换成别的账号", () => {
  assert.deepEqual(planRunProfiles({ profileIds: ["c::work", "c::shop"] }, all, ["c::shop"]), { kind: "existing", profiles: [shop] });
  // 「每次新建」的任务重试时，用那次自动建的 Profile
  assert.deepEqual(planRunProfiles({ profileIds: [], autoProfile: true }, all, ["c::work"]), { kind: "existing", profiles: [work] });
  assert.throws(() => planRunProfiles({ profileIds: ["c::work"] }, all, ["c::gone"]), /已被删除/);
});

const run = (id: string, startTime: number, status: RunSummary["status"], batch?: { id: string; index: number; total: number }): RunSummary => ({
  id,
  taskId: "t",
  name: "签到",
  status,
  startTime,
  ...(status === "run" ? {} : { endTime: startTime + 10 }),
  trigger: "定时触发",
  ...(batch ? { batch } : {}),
});

test("同一轮合成一行，单独的运行各一行，最新的在最前", () => {
  const items = groupRuns([
    run("a", 100, "ok"),
    run("b2", 210, "fail", { id: "B", index: 2, total: 3 }),
    run("b1", 200, "ok", { id: "B", index: 1, total: 3 }),
    run("c", 300, "ok"),
  ]);
  assert.deepEqual(
    items.map((i) => (i.kind === "run" ? i.run.id : i.batch.id)),
    ["c", "B", "a"],
  );
  const b = items[1]!;
  assert.equal(b.kind, "batch");
  if (b.kind === "batch") {
    assert.deepEqual(b.batch.runs.map((r) => r.id), ["b1", "b2"]);
    assert.equal(b.batch.startTime, 200);
    assert.equal(b.batch.total, 3);
  }
});

test("一轮的整体状态：有失败为失败，否则为成功", () => {
  const s = summarizeBatch([run("1", 1, "ok", { id: "B", index: 1, total: 2 }), run("2", 2, "fail", { id: "B", index: 2, total: 2 })]);
  assert.equal(s.status, "fail");
  assert.equal(s.ok, 1);
  assert.equal(s.fail, 1);
  assert.equal(s.endTime, 12);
  assert.equal(summarizeBatch([run("1", 1, "ok", { id: "B", index: 1, total: 3 })]).status, "ok");
});

test("两个 Profile 之间（没有在跑的记录）也算这一轮在进行", () => {
  const runs = [run("1", 1, "ok", { id: "B", index: 1, total: 2 })];
  const s = summarizeBatch(runs, "B");
  assert.equal(s.running, true);
  assert.equal(s.status, "run");
  assert.equal(s.endTime, undefined);
  assert.equal(summarizeBatch(runs, "other").running, false);
});

console.log(`\n${passed} passed`);
