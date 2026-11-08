import { latestSlot } from "./schedule.ts";
import { errorMessage, type TaskItem } from "./shared.ts";

const TICK_MS = 30_000;
/** 计划时刻之后多久内仍然触发；超过就当作错过，跳过不补跑（比如电脑休眠了很久） */
export const GRACE_MS = 5 * 60_000;

export interface SchedulerDeps {
  loadTasks(): TaskItem[];
  saveTasks(tasks: TaskItem[]): void;
  /** 当前是否已有任务在运行 */
  isBusy(): boolean;
  run(taskId: string): Promise<void>;
  notify(message: string, isError?: boolean): void;
  /** 排队列表变了，需要刷新界面 */
  onQueueChange(): void;
}

/**
 * 定时调度：每 30 秒检查一次哪些任务到点了。
 * - 到点时已有任务在运行：排队，等它结束再依次运行；同一个任务不会重复排队。
 * - 应用没开着、或电脑休眠期间错过的时刻：跳过，不补跑。
 */
export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private queue: string[] = [];

  constructor(
    private deps: SchedulerDeps,
    private now: () => number = Date.now,
  ) {}

  queued(): string[] {
    return [...this.queue];
  }

  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.now();
    const tasks = this.deps.loadTasks();
    const due: TaskItem[] = [];
    let dirty = false;

    for (const task of tasks) {
      const slot = latestSlot(task, now);
      if (slot === null) continue;

      // 第一次见到这个任务：从现在开始计，不去追溯它创建之前的时刻
      if (task.lastScheduledAt === undefined) {
        task.lastScheduledAt = now;
        dirty = true;
        continue;
      }
      if (slot <= task.lastScheduledAt) continue;

      // 这个时刻不管触发还是跳过，都记下来，保证只处理一次
      task.lastScheduledAt = slot;
      dirty = true;
      if (now - slot <= GRACE_MS) due.push(task);
    }

    if (dirty) this.deps.saveTasks(tasks);
    for (const task of due) this.submit(task);
  }

  /** 运行器空闲了：让排队的下一个任务上 */
  pump(): void {
    if (this.deps.isBusy()) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.deps.onQueueChange();

    const task = this.deps.loadTasks().find((t) => t.id === id);
    if (!task) return this.pump(); // 排队期间被删除了
    this.launch(task);
  }

  private submit(task: TaskItem) {
    if (this.queue.includes(task.id)) return;
    if (this.deps.isBusy()) {
      this.queue.push(task.id);
      this.deps.notify(`定时任务「${task.name}」已加入队列，等当前任务结束后运行`);
      this.deps.onQueueChange();
      return;
    }
    this.launch(task);
  }

  private launch(task: TaskItem) {
    this.deps.notify(`定时任务「${task.name}」开始运行`);
    this.deps.run(task.id).catch((err) => {
      this.deps.notify(`定时任务「${task.name}」没能启动：${errorMessage(err)}`, true);
      this.pump(); // 没启动成功就不会触发"空闲"回调，这里接着处理下一个
    });
  }
}
