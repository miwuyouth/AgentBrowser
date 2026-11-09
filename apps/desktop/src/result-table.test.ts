import assert from "node:assert/strict";
import { cellValue, csvTime, finishedRuns, groupRounds, profileOptions, toCsv } from "./result-table.ts";
import type { FormField, RunSummary } from "./shared.ts";

/**
 * 任务「表格」视图纯逻辑（按轮分组、Profile 下拉、CSV）单元测试。
 */

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

const run = (id: string, over: Partial<RunSummary> = {}): RunSummary => ({
  id,
  taskId: "t1",
  name: "天气",
  status: "ok",
  startTime: 1000,
  trigger: "定时触发",
  ...over,
});

const fields: FormField[] = [
  { id: "f1", name: "温度", type: "number" },
  { id: "f2", name: "天气", type: "text" },
];
const names = new Map([
  ["p1", "主账号"],
  ["p2", "小号 A"],
]);

test("按轮分组：最新的一轮在前；轮内按「运行环境」顺序，不按运行顺序", () => {
  const b1 = { id: "b1", total: 2 };
  const groups = groupRounds(
    [
      run("a", { startTime: 100, profileId: "p2", batch: { ...b1, index: 1 } }),
      run("b", { startTime: 200, profileId: "p1", batch: { ...b1, index: 2 } }),
      run("c", { startTime: 500, profileId: "p2" }),
    ],
    ["p1", "p2"],
  );
  assert.deepEqual(groups.map((g) => g.id), ["c", "b1"]);
  assert.deepEqual(groups[1]!.runs.map((r) => r.id), ["b", "a"]);
  assert.equal(groups[1]!.startTime, 100);
});

test("Profile 下拉：按「运行环境」顺序，已删除的排最后并用当时的名字", () => {
  const opts = profileOptions(
    [
      run("a", { profileId: "gone", profileName: "旧号", startTime: 50 }),
      run("b", { profileId: "p2", profileName: "改名前" }),
      run("c", { profileId: "p1", profileName: "主账号" }),
      run("d", { profileId: "p1", profileName: "主账号", startTime: 2000 }),
    ],
    ["p1", "p2"],
    names,
  );
  assert.deepEqual(opts, [
    { key: "p1", name: "主账号" },
    { key: "p2", name: "小号 A" },
    { key: "gone", name: "旧号" },
  ]);
});

test("只留已结束的运行；空字符串算没有值", () => {
  assert.deepEqual(finishedRuns([run("a"), run("b", { status: "run" }), run("c", { status: "fail" })]).map((r) => r.id), ["a", "c"]);
  assert.equal(cellValue(run("a", { data: { 温度: 0, 天气: "" } }), fields[0]!), 0);
  assert.equal(cellValue(run("a", { data: { 温度: 0, 天气: "" } }), fields[1]!), null);
  assert.equal(cellValue(run("a"), fields[0]!), null);
});

test("CSV：BOM + 表头；转义逗号引号换行；公式开头的文字加 '；数字与负数原样", () => {
  const t = new Date(2026, 10, 10, 8, 5).getTime();
  assert.equal(csvTime(t), "2026-11-10 08:05");
  const csv = toCsv(
    [
      run("a", { startTime: t, profileId: "p1", data: { 温度: -3, 天气: '多云,"转"晴\n夜间' } }),
      run("b", { startTime: t, status: "fail", profileName: "旧号", data: { 温度: null, 天气: "=1+1" } }),
    ],
    fields,
    true,
    names,
  );
  assert.ok(csv.startsWith("﻿"));
  const lines = csv.slice(1).split("\r\n");
  assert.equal(lines[0], "时间,Profile,状态,温度,天气");
  assert.equal(lines[1], '2026-11-10 08:05,主账号,成功,-3,"多云,""转""晴\n夜间"');
  assert.equal(lines.at(-2), "2026-11-10 08:05,旧号,失败,,'=1+1");
});

test("CSV：单 Profile 不带 Profile 列", () => {
  const csv = toCsv([run("a", { data: { 温度: 18, 天气: "晴" } })], fields, false, names);
  assert.equal(csv.slice(1).split("\r\n")[0], "时间,状态,温度,天气");
});

console.log(`\n${passed} passed`);
