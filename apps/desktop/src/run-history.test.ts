import assert from "node:assert/strict";
import { dayLabel, expiredRunIds, groupByDay, isRetentionOption } from "./run-history.ts";
import type { RunSummary } from "./shared.ts";

/**
 * 运行记录「按天分组」与「过期清理」单元测试。
 */

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

const DAY = 86_400_000;
// 2026年11月10日 周二 15:00（本地时间）
const now = new Date(2026, 10, 10, 15, 0).getTime();

const run = (id: string, startTime: number, extra: Partial<RunSummary> = {}): RunSummary => ({
  id,
  name: id,
  status: "ok",
  startTime,
  trigger: "手动",
  ...extra,
});

test("保留天数只接受 7 / 30 / 90 / 永久", () => {
  assert.ok([7, 30, 90, 0].every(isRetentionOption));
  assert.ok(![1, 31, -1, "30", undefined, null].some(isRetentionOption));
});

test("超过保留天数的删掉，没超过的留着", () => {
  const runs = [run("new", now - 29 * DAY), run("old", now - 31 * DAY), run("older", now - 400 * DAY)];
  assert.deepEqual(expiredRunIds(runs, 30, now), ["old", "older"]);
  assert.deepEqual(expiredRunIds(runs, 90, now), ["older"]);
});

test("永久保留时什么都不删", () => {
  assert.deepEqual(expiredRunIds([run("old", now - 1000 * DAY)], 0, now), []);
});

test("还在运行的、被保护的不删", () => {
  const runs = [run("stuck", now - 40 * DAY, { status: "run" }), run("active", now - 40 * DAY), run("old", now - 40 * DAY)];
  assert.deepEqual(expiredRunIds(runs, 30, now, ["active"]), ["old"]);
});

test("同一轮按最晚的那条算，整轮一起留或一起删", () => {
  const b = (id: string, index: number, startTime: number, batchId = "b1") =>
    run(id, startTime, { batch: { id: batchId, index, total: 2 } });
  // 一轮跨过了期限：第一条已过期、第二条没有 → 整轮留着
  const straddle = [b("a1", 0, now - 30 * DAY - 60_000), b("a2", 1, now - 30 * DAY + 60_000)];
  assert.deepEqual(expiredRunIds(straddle, 30, now), []);
  // 整轮都过期 → 一起删
  const old = [b("c1", 0, now - 40 * DAY, "b2"), b("c2", 1, now - 40 * DAY + 60_000, "b2")];
  assert.deepEqual(expiredRunIds(old, 30, now), ["c1", "c2"]);
  // 这一轮里有一条还在跑 → 整轮都不删
  const running = [b("d1", 0, now - 40 * DAY, "b3"), b("d2", 1, now - 40 * DAY, "b3")];
  running[1]!.status = "run";
  assert.deepEqual(expiredRunIds(running, 30, now), []);
});

test("日期标题：今天、昨天、同年写月日加星期、往年加年份", () => {
  assert.equal(dayLabel(new Date(2026, 10, 10, 0, 1).getTime(), now), "今天");
  assert.equal(dayLabel(new Date(2026, 10, 9, 23, 59).getTime(), now), "昨天");
  assert.equal(dayLabel(new Date(2026, 10, 6, 9, 0).getTime(), now), "11月6日 周五");
  assert.equal(dayLabel(new Date(2025, 11, 31, 9, 0).getTime(), now), "2025年12月31日 周三");
});

test("按天分组：同一天的放一组，组内保持原顺序", () => {
  const items = [
    { id: "t2", startTime: new Date(2026, 10, 10, 9, 0).getTime() },
    { id: "t1", startTime: new Date(2026, 10, 10, 8, 0).getTime() },
    { id: "y1", startTime: new Date(2026, 10, 9, 22, 0).getTime() },
    { id: "o1", startTime: new Date(2026, 10, 6, 7, 0).getTime() },
  ];
  const groups = groupByDay(items, now);
  assert.deepEqual(
    groups.map((g) => [g.label, g.items.map((i) => i.id)]),
    [
      ["今天", ["t2", "t1"]],
      ["昨天", ["y1"]],
      ["11月6日 周五", ["o1"]],
    ],
  );
  assert.deepEqual(groupByDay([], now), []);
});

console.log(`\n${passed} passed`);
