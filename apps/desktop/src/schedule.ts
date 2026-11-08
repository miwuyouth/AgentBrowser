import type { TaskItem } from "./shared.ts";

/**
 * 调度规则计算纯函数模块。
 * 根据任务配置的重复规则计算"应该在什么时刻运行"。
 * 由 Electron 主进程调度器（检查到期任务）和渲染层界面（显示下次运行时间）共享。
 */

/** 任务重复执行类型 */
export type RepeatKind = NonNullable<TaskItem["repeatKind"]>;

/** 调度规则推导所需的最小任务属性集合 */
type Rule = Pick<TaskItem, "mode" | "repeatKind" | "repeatTime">;

/** "每 N 小时"周期的固定间隔小时数；以基准时间为起点，向前向后均按此固定间隔排布 */
export const HOURS_INTERVAL = 6;

/** 1 小时的毫秒数 */
const HOUR = 3_600_000;

/**
 * 解析 "HH:mm" 格式的每日时间字符串。
 *
 * 【调用时机】
 * 在 `latestSlot` 或 `nextSlot` 中推导具体时间点的时、分时内部调用。
 *
 * 【作用】
 * 解析用户输入的定时字符串（如 "08:30"），提取小时与分钟数值并做边界范围保护（0-23, 0-59）。
 * 若格式不匹配或未指定，默认降级为 08:30。
 *
 * @param time 类似 "09:00" 的时间字符串
 * @returns 包含合法 [小时, 分钟] 的元组
 */
function parseTime(time: string | undefined): [number, number] {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time ?? "");
  const h = m ? Number(m[1]) : 8;
  const min = m ? Number(m[2]) : 30;
  return [Math.min(h, 23), Math.min(min, 59)];
}

/**
 * 构造指定偏移天数与特定时分的新 Date 实例。
 *
 * 【调用时机】
 * 在遍历前溯或后瞻日期、匹配每日/工作日/每周触发时刻时内部调用。
 *
 * 【作用】
 * 以基准日期为基准，加上 `offsetDays` 天，并将时、分、秒、毫秒设置为目标时间点。
 *
 * @param base 基准日期对象
 * @param offsetDays 相对基准日期的偏移天数（负数为向前推，正数为向后推）
 * @param h 目标小时 (0-23)
 * @param m 目标分钟 (0-59)
 * @returns 构造好的本地时间 Date 对象
 */
const dayAt = (base: Date, offsetDays: number, h: number, m: number) =>
  new Date(base.getFullYear(), base.getMonth(), base.getDate() + offsetDays, h, m, 0, 0);

/**
 * 判断指定日期是否符合当前重复类型的排程要求。
 *
 * 【调用时机】
 * 在 `latestSlot` 与 `nextSlot` 按天循环查找触发槽位时内部调用。
 *
 * 【作用】
 * 校验特定自然日是否命中规则（"每 N 小时"按时间轴独立计算，不走本函数）：
 * - daily: 每天均有效；
 * - weekday: 仅周一至周五有效；
 * - weekly: 仅周一有效。
 *
 * @param kind 重复调度类型
 * @param day 待检测的目标日期
 * @returns 若该日期包含触发槽位则返回 true，否则返回 false
 */
function dayHasSlot(kind: RepeatKind | undefined, day: Date): boolean {
  const weekday = day.getDay(); // 0 周日 … 6 周六
  if (kind === "daily") return true;
  if (kind === "weekday") return weekday >= 1 && weekday <= 5;
  if (kind === "weekly") return weekday === 1; // 每周一
  return false;
}

/**
 * 判断当前任务规则是否启用了有效的周期性调度。
 *
 * 【调用时机】
 * 在 `latestSlot` 与 `nextSlot` 执行最前置检查时调用。
 *
 * 【作用】
 * 过滤非定时任务（如 manual、once 或 mode !== "cron"），避免无效计算。
 */
export const isScheduled = (rule: Rule) => rule.mode === "cron" && !!rule.repeatKind && rule.repeatKind !== "manual" && rule.repeatKind !== "once";

/**
 * 计算不晚于指定时间戳的最近一次计划触发时刻。
 *
 * 【调用时机】
 * 1. 调度器主循环（`scheduler.ts` 中的 `Scheduler.tick()`）每 30 秒执行一次，用于核验任务在当前时刻之前是否应该已经被触发。
 * 2. 调度测试用例中验证历史时刻推导准确性时调用。
 *
 * 【作用】
 * 从当前时间戳 `ts` 向前推导，计算最近的一个理论执行时间戳（毫秒）。
 * - 若非定时任务则返回 `null`；
 * - 若为 "hours" 模式，以今天设定的时间为锚点，以 6 小时为固定步长向前对齐；
 * - 若为按天模式，向前回溯最多 7 天，找到符合星期规则且时间戳 <= ts 的最新槽位。
 *
 * @param rule 任务的调度模式与时间规则
 * @param ts 基准时间戳（毫秒）
 * @returns 最近的计划触发时间戳；若不适用周期定时则返回 null
 */
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

/**
 * 计算严格晚于指定时间戳的下一次计划触发时刻。
 *
 * 【调用时机】
 * 1. 任务列表或任务详情界面渲染时调用，向用户展示「下次运行：明天 08:30」等提示。
 * 2. 调度测试中检验未来执行点。
 *
 * 【作用】
 * 从当前时间戳 `ts` 向未来推导最近的一个预期触发时间戳（毫秒）。
 * - 手动任务返回 `null`；
 * - 若为 "hours" 模式，以锚点向后寻找第一个大于 `ts` 的整倍数时隙；
 * - 若为按天模式，向后遍历未来最多 8 天，找到符合日历规则且时间戳 > ts 的最近槽位。
 *
 * @param rule 任务的调度模式与时间规则
 * @param ts 基准时间戳（毫秒）
 * @returns 下一次计划执行的毫秒时间戳；若非定时任务则返回 null
 */
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

/**
 * 将重复规则与执行时间生成为人话描述的标签文案。
 *
 * 【调用时机】
 * 1. 用户在任务编辑器中调整重复周期下拉框或时间输入框时调用，实时呈现人话描述。
 * 2. 保存任务时将可读字符串持久化写入 `task.schedule` 字段。
 *
 * 【作用】
 * 将规则转换为直观的中文文本，如「每天 08:30」、「工作日 09:00」、「每 6 小时（08:30 起）」等。
 *
 * @param kind 重复周期类型（如 "daily"、"weekday" 等）
 * @param time 触发时间点（如 "08:30"）
 * @returns 人话可读的规则描述字符串
 */
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
