import type { RunSummary } from "./shared.ts";

/**
 * 运行记录的「按天分组」与「过期清理」纯函数。
 * 不依赖 Electron，主进程（清理）和界面（分组、清理前算条数）共用，便于单元测试。
 */

/** 「设置 › 通用」里能选的保留天数；0 表示永久保留 */
export const RETENTION_OPTIONS = [7, 30, 90, 0] as const;

/** 默认保留最近 30 天 */
export const DEFAULT_KEEP_RUNS_DAYS = 30;

const DAY_MS = 86_400_000;
const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];

/** 是不是能选的保留天数（读设置文件、收到界面修改时校验） */
export function isRetentionOption(days: unknown): days is number {
  return typeof days === "number" && (RETENTION_OPTIONS as readonly number[]).includes(days);
}

/**
 * 算出已经过期、该删掉的运行记录 ID。
 *
 * 【调用时机】主进程启动时、每小时一次、改了保留天数时；界面在缩短保留天数前也用它算出要删几条。
 *
 * 【作用】
 * - 开始时间早于「现在 − 保留天数」的记录算过期；`keepDays` 为 0（永久）时什么都不删；
 * - 同一轮（多 Profile）按这一轮最晚的那条算，整轮一起留或一起删，不会只剩半轮；
 * - 还在运行的（或这一轮里有还在运行的）、以及 `protectedIds` 里的一律不删。
 *
 * @param runs 运行记录摘要
 * @param keepDays 保留天数，0 表示永久
 * @param now 当前时间戳
 * @param protectedIds 不能删的运行 ID（例如正在执行的那次）
 */
export function expiredRunIds(runs: RunSummary[], keepDays: number, now: number, protectedIds: string[] = []): string[] {
  if (!(keepDays > 0)) return [];
  const cutoff = now - keepDays * DAY_MS;

  // 每一组（一轮，或单独一次运行）的最晚开始时间，以及组里有没有不能删的
  const groupOf = (r: RunSummary) => (r.batch ? `batch:${r.batch.id}` : `run:${r.id}`);
  const latest = new Map<string, number>();
  const pinned = new Set<string>();
  for (const r of runs) {
    const g = groupOf(r);
    latest.set(g, Math.max(latest.get(g) ?? -Infinity, r.startTime));
    if (r.status === "run" || protectedIds.includes(r.id)) pinned.add(g);
  }

  return runs.filter((r) => !pinned.has(groupOf(r)) && latest.get(groupOf(r))! < cutoff).map((r) => r.id);
}

/** 当天零点的时间戳 */
const startOfDay = (ts: number) => {
  const d = new Date(ts);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
};

/**
 * 某一天在运行记录列表里的标题：今天、昨天，更早的写「11月7日 周五」，不是今年的再加年份。
 *
 * @param ts 这一天里的任意时刻
 * @param now 当前时间戳
 */
export function dayLabel(ts: number, now: number): string {
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / DAY_MS);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  const d = new Date(ts);
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : `${d.getFullYear()}年`;
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${WEEKDAYS[d.getDay()]}`;
}

/** 列表里的一天 */
export interface DayGroup<T> {
  /** 当天零点的时间戳，用作 key */
  key: number;
  /** 标题，见 `dayLabel` */
  label: string;
  items: T[];
}

/**
 * 把（已按时间倒序排好的）列表项按天分组，每组保持原来的顺序。
 *
 * 【调用时机】渲染「运行记录」列表时调用。
 *
 * @param items 列表项，带开始时间
 * @param now 当前时间戳
 */
export function groupByDay<T extends { startTime: number }>(items: T[], now: number): DayGroup<T>[] {
  const groups: DayGroup<T>[] = [];
  for (const item of items) {
    const key = startOfDay(item.startTime);
    const last = groups[groups.length - 1];
    if (last && last.key === key) last.items.push(item);
    else groups.push({ key, label: dayLabel(item.startTime, now), items: [item] });
  }
  return groups;
}
