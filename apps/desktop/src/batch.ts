import type { RunSummary, TaskItem } from "./shared.ts";

/**
 * 「一轮」相关的纯函数：一次运行要在哪些 Profile 上跑、运行记录怎么按轮分组。
 * 任务选了多个 Profile 时，每次运行会按顺序在每个 Profile 上各跑一遍，这一组叫「一轮」。
 * 不依赖 Electron，主进程和界面共用，便于单元测试。
 */

/** 挑选 Profile 时需要的最少信息 */
export interface ProfileLike {
  id: string;
  isDefault?: boolean;
}

/** 这一轮要怎么准备 Profile */
export type RunProfilePlan<P> =
  /** 在这些已有的 Profile 上依次运行（顺序与「运行环境」里一致） */
  | { kind: "existing"; profiles: P[] }
  /** 新建一个 Profile 再运行：任务设了「每次新建」，或这个内核下还没有任何 Profile */
  | { kind: "create" };

/**
 * 算出这次运行要用哪些 Profile。
 *
 * 【调用时机】TaskRunner 开始一轮运行前调用。
 *
 * 【作用】
 * - 指定了 `only`（重试）：只用这些 Profile；全被删掉了就报错，不悄悄换成别的 Profile；
 * - 任务设了「每次新建 Profile」：新建一个；
 * - 否则用任务勾选的、仍然存在的 Profile；一个都不剩时退回该内核的默认 Profile（再没有就取第一个，还没有就新建）。
 *
 * @param task 任务（只看 profileIds 与 autoProfile）
 * @param kernelProfiles 该内核当前所有的 Profile，按「运行环境」里的顺序
 * @param only 只在这些 Profile 上运行（重试用）
 */
export function planRunProfiles<P extends ProfileLike>(
  task: Pick<TaskItem, "profileIds" | "autoProfile">,
  kernelProfiles: P[],
  only?: string[],
): RunProfilePlan<P> {
  if (only) {
    const picked = kernelProfiles.filter((p) => only.includes(p.id));
    if (picked.length === 0) throw new Error("要重跑的 Profile 已被删除。");
    return { kind: "existing", profiles: picked };
  }
  if (task.autoProfile) return { kind: "create" };
  const picked = kernelProfiles.filter((p) => task.profileIds.includes(p.id));
  if (picked.length > 0) return { kind: "existing", profiles: picked };
  const fallback = kernelProfiles.find((p) => p.isDefault) ?? kernelProfiles[0];
  return fallback ? { kind: "existing", profiles: [fallback] } : { kind: "create" };
}

/** 运行记录列表里的一行：一条单独的运行，或一整轮 */
export type RunListItem =
  | { kind: "run"; run: RunSummary; startTime: number }
  | { kind: "batch"; batch: BatchInfo; startTime: number };

/** 一轮运行的汇总 */
export interface BatchInfo {
  id: string;
  taskId?: string;
  /** 任务名称 */
  name: string;
  /** 这一轮的运行记录，按第几个 Profile 排序 */
  runs: RunSummary[];
  /** 计划运行的 Profile 总数（停止后可能多于已有的记录数） */
  total: number;
  /** 这一轮最早开始的时刻 */
  startTime: number;
  /** 最后一条结束的时刻；还有在跑的则没有 */
  endTime?: number;
  trigger: string;
  ok: number;
  fail: number;
  /** 有一条正在运行，或者还没跑完全部 Profile 且这一轮仍在进行 */
  running: boolean;
  /** 整体状态：在跑 → run；有失败 → fail；否则 ok */
  status: "ok" | "run" | "fail";
}

/**
 * 把同一轮的运行记录汇总成一份。
 *
 * @param runs 同一个 batch.id 的运行记录（顺序不限）
 * @param activeBatchId 当前正在进行的那一轮（运行器在两次运行之间也算在进行）
 */
export function summarizeBatch(runs: RunSummary[], activeBatchId?: string): BatchInfo {
  const sorted = [...runs].sort((a, b) => (a.batch?.index ?? 0) - (b.batch?.index ?? 0));
  const first = sorted[0]!;
  const ok = sorted.filter((r) => r.status === "ok").length;
  const fail = sorted.filter((r) => r.status === "fail").length;
  const id = first.batch!.id;
  const running = sorted.some((r) => r.status === "run") || id === activeBatchId;
  const ends = sorted.map((r) => r.endTime);
  return {
    id,
    ...(first.taskId ? { taskId: first.taskId } : {}),
    name: first.name,
    runs: sorted,
    total: Math.max(first.batch!.total, sorted.length),
    startTime: Math.min(...sorted.map((r) => r.startTime)),
    ...(!running && ends.every((t) => t !== undefined) ? { endTime: Math.max(...(ends as number[])) } : {}),
    trigger: first.trigger,
    ok,
    fail,
    running,
    status: running ? "run" : fail > 0 ? "fail" : "ok",
  };
}

/**
 * 运行记录按轮分组：同一轮的合成一行，单独的运行各占一行，最新的在最前。
 *
 * 【调用时机】渲染「运行记录」列表时调用。
 *
 * @param runs 运行记录摘要
 * @param activeBatchId 当前正在进行的那一轮
 */
export function groupRuns(runs: RunSummary[], activeBatchId?: string): RunListItem[] {
  const batches = new Map<string, RunSummary[]>();
  const items: RunListItem[] = [];
  for (const run of runs) {
    if (!run.batch) {
      items.push({ kind: "run", run, startTime: run.startTime });
      continue;
    }
    const list = batches.get(run.batch.id);
    if (list) list.push(run);
    else batches.set(run.batch.id, [run]);
  }
  for (const list of batches.values()) {
    const batch = summarizeBatch(list, activeBatchId);
    items.push({ kind: "batch", batch, startTime: batch.startTime });
  }
  return items.sort((a, b) => b.startTime - a.startTime);
}
