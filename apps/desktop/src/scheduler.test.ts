import assert from "node:assert/strict";
import { latestSlot, nextSlot, scheduleLabel } from "./schedule.ts";
import { GRACE_MS, Scheduler } from "./scheduler.ts";
import type { TaskItem } from "./shared.ts";

// 2026-11-08 是周日。所有时间都按本地时区构造，和运行时一致。
const at = (day: number, h: number, m = 0) => new Date(2026, 10, day, h, m).getTime();
const rule = (repeatKind: TaskItem["repeatKind"], repeatTime = "08:30") => ({ mode: "cron" as const, repeatKind, repeatTime });

let passed = 0;
const test = (name: string, fn: () => void) => {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
};

console.log("schedule");
test("每天：到点后取今天，没到点取昨天", () => {
  assert.equal(latestSlot(rule("daily"), at(8, 9)), at(8, 8, 30));
  assert.equal(latestSlot(rule("daily"), at(8, 7)), at(7, 8, 30));
  assert.equal(nextSlot(rule("daily"), at(8, 9)), at(9, 8, 30));
  assert.equal(nextSlot(rule("daily"), at(8, 7)), at(8, 8, 30));
});
test("工作日：周日往前找到周五，往后找到周一", () => {
  assert.equal(latestSlot(rule("weekday"), at(8, 10)), at(6, 8, 30));
  assert.equal(nextSlot(rule("weekday"), at(8, 10)), at(9, 8, 30));
});
test("每周一", () => {
  assert.equal(latestSlot(rule("weekly"), at(8, 10)), at(2, 8, 30));
  assert.equal(nextSlot(rule("weekly"), at(8, 10)), at(9, 8, 30));
});
test("每 6 小时：以运行时间为起点向前向后排", () => {
  assert.equal(latestSlot(rule("hours"), at(8, 15)), at(8, 14, 30));
  assert.equal(latestSlot(rule("hours"), at(8, 7)), at(8, 2, 30));
  assert.equal(nextSlot(rule("hours"), at(8, 15)), at(8, 20, 30));
});
test("手动任务没有计划时刻", () => {
  assert.equal(latestSlot({ mode: "now", repeatKind: "manual", repeatTime: "08:30" }, at(8, 9)), null);
  assert.equal(nextSlot({ mode: "now", repeatKind: "manual", repeatTime: "08:30" }, at(8, 9)), null);
});
test("规则描述", () => {
  assert.equal(scheduleLabel("daily", "08:30"), "每天 08:30");
  assert.equal(scheduleLabel("hours", "08:30"), "每 6 小时（08:30 起）");
});

/** 搭一个带假时钟、假任务存储、假运行器的调度器 */
function setup(tasks: Partial<TaskItem>[], start: number) {
  let clock = start;
  let busy = false;
  const store = tasks.map((t) => ({ id: "t", name: "任务", ...t }) as TaskItem);
  const ran: string[] = [];
  const notices: string[] = [];
  const scheduler = new Scheduler(
    {
      loadTasks: () => store,
      saveTasks: () => {},
      isBusy: () => busy,
      run: async (id) => {
        ran.push(id);
        busy = true; // 真实运行器里，运行期间 isRunning() 为真
      },
      notify: (m) => notices.push(m),
      onQueueChange: () => {},
    },
    () => clock,
  );
  return {
    scheduler,
    store,
    ran,
    notices,
    setClock: (t: number) => (clock = t),
    finishRun: () => {
      busy = false;
      scheduler.pump();
    },
  };
}

console.log("scheduler");
test("到点触发一次，之后的检查不会重复触发", () => {
  const s = setup([{ id: "a", ...rule("daily"), mode: "cron", lastScheduledAt: at(7, 8, 30) }], at(8, 8, 30) + 10_000);
  s.scheduler.tick();
  s.setClock(at(8, 8, 31));
  s.scheduler.tick();
  s.scheduler.tick();
  assert.deepEqual(s.ran, ["a"]);
});
test("错过超过宽限时间：跳过，且之后不会补跑", () => {
  const s = setup([{ id: "a", ...rule("daily"), lastScheduledAt: at(7, 8, 30) }], at(8, 9));
  s.scheduler.tick();
  s.setClock(at(8, 9, 1));
  s.scheduler.tick();
  assert.deepEqual(s.ran, []);
  assert.equal(s.store[0]!.lastScheduledAt, at(8, 8, 30));
});
test("刚好在宽限时间内仍然触发", () => {
  const s = setup([{ id: "a", ...rule("daily"), lastScheduledAt: at(7, 8, 30) }], at(8, 8, 30) + GRACE_MS);
  s.scheduler.tick();
  assert.deepEqual(s.ran, ["a"]);
});
test("第一次见到的任务只记起点，不追溯", () => {
  const s = setup([{ id: "a", ...rule("daily") }], at(8, 9));
  s.scheduler.tick();
  assert.deepEqual(s.ran, []);
  assert.equal(s.store[0]!.lastScheduledAt, at(8, 9));
});
test("手动任务永远不触发", () => {
  const s = setup([{ id: "a", mode: "now", repeatKind: "manual" }], at(8, 9));
  s.scheduler.tick();
  s.setClock(at(9, 9));
  s.scheduler.tick();
  assert.deepEqual(s.ran, []);
});
test("已有任务在运行时排队，结束后依次运行，不重复排队", () => {
  const s = setup(
    [
      { id: "a", name: "A", ...rule("daily"), lastScheduledAt: at(7, 8, 30) },
      { id: "b", name: "B", ...rule("daily"), lastScheduledAt: at(7, 8, 30) },
    ],
    at(8, 8, 30) + 5_000,
  );
  s.scheduler.tick(); // a 先上，b 因为 a 在运行而排队
  assert.deepEqual(s.ran, ["a"]);
  assert.deepEqual(s.scheduler.queued(), ["b"]);
  s.scheduler.tick(); // 同一时刻不会再次入队
  assert.deepEqual(s.scheduler.queued(), ["b"]);
  s.finishRun();
  assert.deepEqual(s.ran, ["a", "b"]);
  assert.deepEqual(s.scheduler.queued(), []);
});
test("排队期间任务被删除：跳过它继续下一个", () => {
  const s = setup(
    [
      { id: "a", ...rule("daily"), lastScheduledAt: at(7, 8, 30) },
      { id: "b", ...rule("daily"), lastScheduledAt: at(7, 8, 30) },
      { id: "c", ...rule("daily"), lastScheduledAt: at(7, 8, 30) },
    ],
    at(8, 8, 30) + 5_000,
  );
  s.scheduler.tick();
  s.store.splice(1, 1); // 删除 b
  s.finishRun();
  assert.deepEqual(s.ran, ["a", "c"]);
});

console.log(`\n${passed} 个测试全部通过`);
