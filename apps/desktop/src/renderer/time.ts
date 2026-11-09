/**
 * 界面时间与时长格式化工具模块。
 */

const pad = (n: number) => String(n).padStart(2, "0");
const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

/**
 * 将时间戳格式化为绝对日期与时钟时间。
 *
 * 【调用时机】
 * 在运行记录详情页头部、或需要精确展示记录发生时刻的界面中调用。
 *
 * 【作用】
 * 输出如 "11月8日 12:10"；若非当年则展示为 "2025年11月8日 12:10"。
 *
 * @param ts 目标毫秒时间戳
 * @param now 基准时间戳，默认当前时间
 * @returns 绝对日期时间字符串
 */
export function formatDateTime(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 只取时间戳的时刻，如 "09:12"。
 *
 * 【调用时机】运行记录列表里每一行的时间（日期已由所在分组的标题给出）。
 */
export function formatTimeOfDay(ts: number): string {
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * 将耗时毫秒数转化为中文易读时长。
 *
 * 【调用时机】
 * 历史列表与运行详情页展示任务总执行耗时时调用。
 *
 * 【作用】
 * 将毫秒时间转化为人话时长（例如："42 秒"、"3 分 12 秒"、"1 小时 5 分"）。
 *
 * @param ms 耗时毫秒数
 * @returns 格式化后的时长字符串
 */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/**
 * 格式化未来的计划触发时刻。
 *
 * 【调用时机】
 * 任务列表卡片展示「下次运行：明天 08:30」或任务编辑页预览调度效果时调用。
 *
 * 【作用】
 * 将未来的时间戳转译为如 "今天 14:30"、"明天 08:30"、"周一 08:30" 或 "11月20日 08:30"。
 *
 * @param ts 未来的计划执行时间戳
 * @param now 当前时间戳基准
 * @returns 人性化未来时间文本
 */
export function formatUpcoming(ts: number, now = Date.now()): string {
  const d = new Date(ts);
  const clock = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const days = Math.round((startOfDay(d) - startOfDay(new Date(now))) / 86_400_000);
  if (days === 0) return `今天 ${clock}`;
  if (days === 1) return `明天 ${clock}`;
  if (days < 7) return `${WEEKDAYS[d.getDay()]} ${clock}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clock}`;
}

/**
 * 运行中时钟计时格式化。
 *
 * 【调用时机】
 * 实时视图（LiveView）中任务正在执行中时，每秒触发的计时器刷屏渲染时调用。
 *
 * 【作用】
 * 将执行已逝去的毫秒数格式化为标准数字时钟格式：未满一小时显示 "03:12"，超过一小时显示 "1:03:12"。
 *
 * @param ms 已运行毫秒数
 * @returns 类似 "03:12" 的时钟字符串
 */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const sec = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${pad(m)}:${pad(sec)}`;
}
