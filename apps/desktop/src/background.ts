import { formatUpcoming } from "./renderer/time.ts";
import { nextSlot } from "./schedule.ts";
import type { RunRecord, TaskItem } from "./shared.ts";

/**
 * 后台常驻相关的纯函数：退出前要不要确认、托盘菜单的状态行、任务完成通知的文案。
 * 不依赖 Electron，便于单元测试；main.ts 负责把结果交给对话框 / 托盘 / 系统通知。
 */

/** 托盘状态行与通知里任务名的最大长度，超出用省略号 */
const NAME_MAX = 20;
/** 通知正文的最大长度 */
const BODY_MAX = 80;

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/**
 * 找出最近一次要运行的定时任务。
 *
 * 【调用时机】组装退出确认框、托盘状态行时调用。
 * 【作用】遍历所有定时任务，取下一次触发时刻最早的那个；没有定时任务返回 null。
 */
export function nextScheduled(tasks: TaskItem[], now: number): { task: TaskItem; at: number } | null {
  let best: { task: TaskItem; at: number } | null = null;
  for (const task of tasks) {
    const at = nextSlot(task, now);
    if (at !== null && (!best || at < best.at)) best = { task, at };
  }
  return best;
}

/** 退出前的确认内容 */
export interface QuitWarning {
  message: string;
  detail: string;
  /** 是否提供「不再提醒」：只有「仅有定时任务」时才给；有任务在跑或排队时每次都要确认 */
  canMute: boolean;
}

/** 判断退出确认所需的应用现状 */
export interface QuitContext {
  tasks: TaskItem[];
  /** 正在运行的任务名；没有任务在跑则不传 */
  runningName?: string;
  /** 排队中的任务 ID */
  queued: string[];
  now: number;
  /** 用户是否还想在「仅有定时任务」时被提醒（设置里的「退出前提醒」） */
  warnScheduled: boolean;
}

/**
 * 决定真正退出前要不要弹确认框，以及说什么。
 *
 * 【调用时机】主进程 before-quit（⌘Q、托盘「退出」、Dock 退出、关闭窗口且未开启后台常驻）时调用；系统关机时不调用。
 * 【作用】
 * - 有任务在跑或排队：一定确认，说清楚会中断什么，不提供「不再提醒」；
 * - 只有定时任务：按设置决定是否确认，并写出最近一个任务的时间；
 * - 两者都没有：返回 null，直接退出。
 */
export function quitWarning(ctx: QuitContext): QuitWarning | null {
  const next = nextScheduled(ctx.tasks, ctx.now);
  const queued = ctx.queued.length;

  if (ctx.runningName || queued > 0) {
    const lines: string[] = [];
    if (ctx.runningName) lines.push("中断的这次运行会记为失败。");
    if (ctx.runningName && queued > 0) lines.push(`排队中的 ${queued} 个任务也不会运行。`);
    if (next) lines.push("退出后定时任务也不会再运行。");
    return {
      message: ctx.runningName
        ? `「${clip(ctx.runningName, NAME_MAX)}」正在运行，退出会中断它`
        : `还有 ${queued} 个任务在排队，退出后不会运行`,
      detail: lines.join(""),
      canMute: false,
    };
  }

  if (!next || !ctx.warnScheduled) return null;
  return {
    message: "退出后，定时任务不会再运行",
    detail: `下一个：「${clip(next.task.name, NAME_MAX)}」${formatUpcoming(next.at, ctx.now)}。`,
    canMute: true,
  };
}

/**
 * 托盘菜单顶部那一行只读状态。
 *
 * 【调用时机】每次弹出托盘菜单（Linux 为每次状态变化）时调用。
 * 【作用】有任务在跑显示它；否则显示下一个定时任务；都没有就说没有定时任务。
 */
export function trayStatus(ctx: Omit<QuitContext, "warnScheduled">): string {
  if (ctx.runningName) {
    const more = ctx.queued.length > 0 ? `，${ctx.queued.length} 个排队` : "";
    return `正在运行「${clip(ctx.runningName, NAME_MAX)}」${more}`;
  }
  const next = nextScheduled(ctx.tasks, ctx.now);
  return next ? `下一个：「${clip(next.task.name, NAME_MAX)}」${formatUpcoming(next.at, ctx.now)}` : "没有定时任务";
}

/** 取一段文字里第一行有内容的话，去掉开头的 Markdown 标记 */
function firstLine(text: string | undefined): string {
  for (const raw of (text ?? "").split("\n")) {
    const line = raw.replace(/^[\s#>*\-]+/, "").replace(/\*\*/g, "").trim();
    if (line) return line;
  }
  return "";
}

/** 发完成通知需要的运行记录信息 */
export type NoticeRun = Pick<RunRecord, "name" | "status" | "summary" | "error" | "profileName">;

/**
 * 任务跑完时系统通知的标题与正文。
 *
 * 【调用时机】TaskRunner 一轮收尾（非用户主动停止）且用户开启了「任务完成时通知」时调用。
 * 【作用】
 * - 只跑一个 Profile：标题是「任务名 · 已完成 / 失败」；成功时正文取结果第一句，失败时取失败原因；
 * - 一轮跑了多个 Profile：只发这一条，标题按整体结果，正文写成功/失败各几个，并列出失败的 Profile。
 *
 * @param runs 这一轮跑完的运行记录（按顺序）
 */
export function finishNotice(runs: NoticeRun[]): { title: string; body: string } {
  const first = runs[0];
  const name = clip(first?.name ?? "", NAME_MAX);
  if (runs.length <= 1) {
    const ok = first?.status === "ok";
    const body = ok ? firstLine(first?.summary) || "任务已完成" : firstLine(first?.error) || "点击查看失败原因";
    return { title: `${name} · ${ok ? "已完成" : "失败"}`, body: clip(body, BODY_MAX) };
  }
  const failed = runs.filter((r) => r.status !== "ok");
  if (failed.length === 0) return { title: `${name} · 已完成`, body: `${runs.length} 个 Profile 全部成功` };
  const title = `${name} · ${failed.length === runs.length ? "失败" : "部分失败"}`;
  const names = failed.map((r) => r.profileName).filter(Boolean).join("、");
  const body = `成功 ${runs.length - failed.length} 个，失败 ${failed.length} 个${names ? `：${names}` : ""}`;
  return { title, body: clip(body, BODY_MAX) };
}
