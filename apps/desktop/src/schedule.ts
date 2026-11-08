import type { TaskItem } from "./shared.ts";

/** 纯函数：根据任务的重复规则计算"应该在什么时刻运行"。主进程调度器和界面（显示下次运行）共用 */

export type RepeatKind = NonNullable<TaskItem["repeatKind"]>;
type Rule = Pick<TaskItem, "mode" | "repeatKind" | "repeatTime">;

/** "每 N 小时"的间隔；以运行时间为起点，向前向后都按这个间隔排 */
export const HOURS_INTERVAL = 6;
const HOUR = 3_600_000;

function parseTime(time: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  const h = m ? Number(m[1]) : 8;
  const min = m ? Number(m[2]) : 30;
  return [Math.min(h, 23), Math.min(min, 59)];
}

const dayAt = (base: Date, offsetDays: number, h: number, m: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, h, m, 0, 0);

/** 这一天（相对今天偏移 offset）有没有触发时刻；"每 N 小时"另算，不走这里 */
function dayHasSlot(kind: RepeatKind | undefined, day: Date): boolean {
  const weekday = day.getDay(); // 0 周日 … 6 周六
  if (kind === "daily") return true;
  if (kind === "weekday") return weekday >= 1 && weekday <= 5;
  if (kind === "weekly") return weekday === 1; // 每周一
  return false;
}

const isScheduled = (rule: Rule) => rule.mode === "cron" && !!rule.repeatKind && rule.repeatKind !== "manual" && rule.repeatKind !== "once";

/** 不晚于 ts 的最近一次计划时刻；手动任务返回 null */
export function latestSlot(rule: Rule, ts: number): number | null {
  if (!isScheduled(rule)) return null;
  const [h, m] = parseTime(rule.repeatTime);
  const now = new Date(ts);

  if (rule.repeatKind === "hours") {
    const anchor = dayAt(now, 0, h, m).getTime();
    return anchor + Math.floor((ts - anchor) / (HOURS_INTERVAL * HOUR)) * HOURS_INTERVAL * HOUR;
  }
  for (let back = 0; back <= 7; back++) {
    const slot = dayAt(now, -back, h, m);
    if (dayHasSlot(rule.repeatKind, slot) && slot.getTime() <= ts) return slot.getTime();
  }
  return null;
}

/** 晚于 ts 的下一次计划时刻；手动任务返回 null */
export function nextSlot(rule: Rule, ts: number): number | null {
  if (!isScheduled(rule)) return null;
  const [h, m] = parseTime(rule.repeatTime);
  const now = new Date(ts);

  if (rule.repeatKind === "hours") {
    const anchor = dayAt(now, 0, h, m).getTime();
    return anchor + (Math.floor((ts - anchor) / (HOURS_INTERVAL * HOUR)) + 1) * HOURS_INTERVAL * HOUR;
  }
  for (let ahead = 0; ahead <= 8; ahead++) {
    const slot = dayAt(now, ahead, h, m);
    if (dayHasSlot(rule.repeatKind, slot) && slot.getTime() > ts) return slot.getTime();
  }
  return null;
}

/** 写进任务的 schedule 字段，也是人读的规则描述 */
export function scheduleLabel(kind: RepeatKind, time: string): string {
  switch (kind) {
    case "daily":
      return `每天 ${time}`;
    case "weekday":
      return `工作日 ${time}`;
    case "weekly":
      return `每周一 ${time}`;
    case "hours":
      return `每 ${HOURS_INTERVAL} 小时（${time} 起）`;
    default:
      return "手动";
  }
}
