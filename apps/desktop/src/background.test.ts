import assert from "node:assert/strict";
import { finishNotice, nextScheduled, quitWarning, trayStatus } from "./background.ts";
import type { TaskItem } from "./shared.ts";

/**
 * 后台常驻纯函数（退出确认、托盘状态行、完成通知文案）单元测试。
 */

// 2026-11-08 是周日，现在是 10:00
const now = new Date(2026, 10, 8, 10, 0).getTime();
const task = (id: string, name: string, repeatKind: TaskItem["repeatKind"], repeatTime = "08:30") =>
  ({ id, name, mode: repeatKind === "manual" ? "now" : "cron", repeatKind, repeatTime }) as TaskItem;

const manual = task("m", "手动任务", "manual");
const daily = task("d", "每日签到", "daily", "09:00"); // 下次：明天 09:00
const tonight = task("t", "晚间汇总", "daily", "21:00"); // 下次：今天 21:00

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`✓ ${name}`);
};

test("nextScheduled 取最早的定时任务，忽略手动任务", () => {
  assert.equal(nextScheduled([manual, daily, tonight], now)?.task.id, "t");
  assert.equal(nextScheduled([manual], now), null);
});

test("没有定时任务也没有任务在跑：直接退出", () => {
  assert.equal(quitWarning({ tasks: [manual], queued: [], now, warnScheduled: true }), null);
});

test("只有定时任务：提醒下一个任务，可以不再提醒", () => {
  const w = quitWarning({ tasks: [manual, daily], queued: [], now, warnScheduled: true });
  assert.equal(w?.message, "退出后，定时任务不会再运行");
  assert.equal(w?.detail, "下一个：「每日签到」明天 09:00。");
  assert.equal(w?.canMute, true);
});

test("只有定时任务且用户关掉了提醒：直接退出", () => {
  assert.equal(quitWarning({ tasks: [daily], queued: [], now, warnScheduled: false }), null);
});

test("有任务在跑：总是提醒，即使关掉了提醒，也不给「不再提醒」", () => {
  const w = quitWarning({ tasks: [manual], runningName: "手动任务", queued: [], now, warnScheduled: false });
  assert.equal(w?.message, "「手动任务」正在运行，退出会中断它");
  assert.equal(w?.detail, "中断的这次运行会记为失败。");
  assert.equal(w?.canMute, false);
});

test("有任务在跑 + 排队 + 定时任务：一并说清楚", () => {
  const w = quitWarning({ tasks: [daily], runningName: "每日签到", queued: ["x", "y"], now, warnScheduled: true });
  assert.equal(w?.detail, "中断的这次运行会记为失败。排队中的 2 个任务也不会运行。退出后定时任务也不会再运行。");
});

test("只有排队的任务", () => {
  const w = quitWarning({ tasks: [manual], queued: ["m"], now, warnScheduled: true });
  assert.equal(w?.message, "还有 1 个任务在排队，退出后不会运行");
  assert.equal(w?.canMute, false);
});

test("托盘状态行", () => {
  assert.equal(trayStatus({ tasks: [daily], runningName: "每日签到", queued: [], now }), "正在运行「每日签到」");
  assert.equal(trayStatus({ tasks: [daily], runningName: "每日签到", queued: ["x"], now }), "正在运行「每日签到」，1 个排队");
  assert.equal(trayStatus({ tasks: [daily, tonight], queued: [], now }), "下一个：「晚间汇总」今天 21:00");
  assert.equal(trayStatus({ tasks: [manual], queued: [], now }), "没有定时任务");
});

test("长任务名会被截断", () => {
  const long = "一二三四五六七八九十一二三四五六七八九十一二三";
  assert.equal(trayStatus({ tasks: [], runningName: long, queued: [], now }), `正在运行「${long.slice(0, 19)}…」`);
});

test("完成通知：成功取结果第一句，去掉 Markdown 标记", () => {
  const n = finishNotice({ name: "每日签到", status: "ok", summary: "\n## 签到成功\n获得 10 积分", error: undefined });
  assert.deepEqual(n, { title: "每日签到 · 已完成", body: "签到成功" });
  assert.equal(finishNotice({ name: "a", status: "ok", summary: "" }).body, "任务已完成");
});

test("完成通知：失败取失败原因", () => {
  const n = finishNotice({ name: "每日签到", status: "fail", summary: "任务执行失败：x", error: "页面上找不到「签到」按钮" });
  assert.deepEqual(n, { title: "每日签到 · 失败", body: "页面上找不到「签到」按钮" });
});

console.log(`\n${passed} passed`);
