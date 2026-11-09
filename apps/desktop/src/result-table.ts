import type { FormField, RunSummary } from "./shared.ts";

/**
 * 任务「表格」视图的纯逻辑：把一个任务的历次运行排成「一次运行一行、一个字段一列」。
 * 多 Profile 任务按轮分组，每轮里 Profile 的顺序固定（与「运行环境」一致），往下扫就能看出同一个账号的变化。
 * 不依赖 Electron 与界面，便于单元测试。
 */

/** 表格里的一轮：多 Profile 任务的一整轮，或一次单独的运行（如只重试了一个 Profile） */
export interface ResultGroup {
  /** 轮 ID，单独的运行用它自己的 ID */
  id: string;
  /** 这一轮最早开始的时刻 */
  startTime: number;
  /** 这一轮的运行，按 Profile 的固定顺序排 */
  runs: RunSummary[];
}

/** 下拉框里的一个 Profile */
export interface ProfileOption {
  key: string;
  name: string;
}

/** 识别 Profile 用的键：优先 ID（改名后仍是同一个），没有就用记录里的名字 */
export const profileKey = (run: RunSummary): string => run.profileId ?? run.profileName ?? "";

/**
 * 某次运行的 Profile 显示名：还存在的用现在的名字，已删除的用记录里当时的名字。
 *
 * @param run 运行摘要
 * @param names 现有 Profile 的 ID → 名称
 */
export function profileLabel(run: RunSummary, names: Map<string, string>): string {
  return (run.profileId && names.get(run.profileId)) || run.profileName || "未知 Profile";
}

/** 只留已结束的运行（成功或失败）；在跑的还没有结果，留在「记录」里看 */
export const finishedRuns = (runs: RunSummary[]) => runs.filter((r) => r.status !== "run");

/**
 * 历史上出现过的 Profile，用于下拉框；超过一个才算多 Profile 任务。
 *
 * 【作用】按「运行环境」里的顺序排；已删除的排在最后，按最近一次出现的先后。
 *
 * @param runs 这个任务的运行（任意顺序）
 * @param order 现有 Profile 的 ID，按「运行环境」里的顺序
 * @param names 现有 Profile 的 ID → 名称
 */
export function profileOptions(runs: RunSummary[], order: string[], names: Map<string, string>): ProfileOption[] {
  const seen = new Map<string, ProfileOption & { last: number }>();
  for (const run of runs) {
    const key = profileKey(run);
    if (!key) continue;
    const prev = seen.get(key);
    if (!prev || run.startTime > prev.last) seen.set(key, { key, name: profileLabel(run, names), last: run.startTime });
  }
  const rank = (key: string) => {
    const i = order.indexOf(key);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...seen.values()]
    .sort((a, b) => rank(a.key) - rank(b.key) || b.last - a.last)
    .map(({ key, name }) => ({ key, name }));
}

/**
 * 按轮分组，最新的一轮在最前；每轮里按 Profile 的固定顺序排。
 *
 * @param runs 这个任务已结束的运行（任意顺序）
 * @param order 现有 Profile 的 ID，按「运行环境」里的顺序；不在其中的（已删除）排在后面，按当时的运行顺序
 */
export function groupRounds(runs: RunSummary[], order: string[]): ResultGroup[] {
  const groups = new Map<string, RunSummary[]>();
  for (const run of runs) {
    const id = run.batch?.id ?? run.id;
    const list = groups.get(id);
    if (list) list.push(run);
    else groups.set(id, [run]);
  }
  const rank = (r: RunSummary) => {
    const i = r.profileId ? order.indexOf(r.profileId) : -1;
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...groups.entries()]
    .map(([id, list]) => ({
      id,
      startTime: Math.min(...list.map((r) => r.startTime)),
      runs: [...list].sort((a, b) => rank(a) - rank(b) || (a.batch?.index ?? 0) - (b.batch?.index ?? 0)),
    }))
    .sort((a, b) => b.startTime - a.startTime);
}

/** 单元格要显示的值；没有值返回 null（界面显示「—」） */
export function cellValue(run: RunSummary, field: FormField): string | number | null {
  const v = run.data?.[field.name];
  return v === undefined || v === "" ? null : v;
}

/** 两位补零 */
const pad = (n: number) => String(n).padStart(2, "0");

/** CSV 里的时间：`2026-11-10 08:00`，表格软件能直接识别成日期时间 */
export function csvTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * CSV 单元格转义：含逗号、引号、换行的加引号；以 = + - @ 开头的文字前面加 `'`，
 * 防止表格软件把抓到的网页内容当公式执行。数字原样输出。
 */
function csvCell(v: string | number | null): string {
  if (v === null) return "";
  if (typeof v === "number") return String(v);
  const text = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/**
 * 导出 CSV：长格式，一个 Profile 的一次运行一行——`时间, Profile, 状态, 字段…`。
 * 单 Profile 任务也带 Profile 列，多个任务的 CSV 合在一起时能分清是哪个账号。
 * 开头带 BOM，Excel 打开中文不乱码。
 *
 * @param runs 要导出的运行，按想要的行顺序
 * @param fields 任务的结果字段（列）
 * @param names 现有 Profile 的 ID → 名称
 */
export function toCsv(runs: RunSummary[], fields: FormField[], names: Map<string, string>): string {
  const head = ["时间", "Profile", "状态", ...fields.map((f) => f.name)];
  const lines = runs.map((r) =>
    [
      csvTime(r.startTime),
      profileLabel(r, names),
      r.status === "ok" ? "成功" : "失败",
      ...fields.map((f) => cellValue(r, f)),
    ].map(csvCell),
  );
  return `﻿${[head.map(csvCell), ...lines].map((cols) => cols.join(",")).join("\r\n")}\r\n`;
}
