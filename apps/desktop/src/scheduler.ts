import { latestSlot } from "./schedule.ts";
import { errorMessage, type TaskItem } from "./shared.ts";

/** 定时检查轮询间隔（30 秒） */
const TICK_MS = 30_000;

/**
 * 容错宽限时间窗口（5 分钟）。
 * 计划时刻之后多久内仍然允许触发；如果超过此窗口则视为严重错过（如电脑深度休眠或长时间关机），直接跳过不作补跑。
 */
export const GRACE_MS = 5 * 60_000;

/** 调度器对外部系统依赖的接口约定 */
export interface SchedulerDeps {
  /** 从持久化存储读取所有任务 */
  loadTasks(): TaskItem[];
  /** 将更新后的任务状态（如 lastScheduledAt）保存回持久化存储 */
  saveTasks(tasks: TaskItem[]): void;
  /** 检查当前是否已有任务正在运行 */
  isBusy(): boolean;
  /** 发起执行指定 ID 任务的异步操作 */
  run(taskId: string): Promise<void>;
  /** 向主进程或渲染层发送操作通知消息 */
  notify(message: string, isError?: boolean): void;
  /** 当任务排队列表变更时触发，通知渲染进程刷新界面展示 */
  onQueueChange(): void;
}

/**
 * 任务定时调度管理器。
 * 每 30 秒轮询检查一次哪些任务到点了。
 * - 并发控制：到点时若已有任务在运行，自动排队，等前序任务结束后再按序运行；同一个任务不会重复排队。
 * - 错峰与休眠处理：应用未启动或电脑休眠期间错过的时刻超过宽限期（5分钟）时直接跳过，不补跑。
 */
export class Scheduler {
  /** 轮询定时器引用 */
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 当前等待运行的任务 ID 队列 */
  private queue: string[] = [];

  /**
   * 构造调度器实例。
   *
   * @param deps 调度器所需的各项依赖接口
   * @param now 获取当前毫秒时间戳的函数，默认使用 Date.now，支持单测注入自定义假时钟
   */
  constructor(
    private deps: SchedulerDeps,
    private now: () => number = Date.now,
  ) {}

  /**
   * 获取当前所有排队中的任务 ID 列表。
   *
   * 【调用时机】
   * 主进程在每次组装发送给渲染进程的 AppState 时调用（`main.ts` 中的 `state()`）。
   *
   * 【作用】
   * 返回排队队列中任务 ID 的副本数组，供前端界面展示等待状态与排队指示。
   *
   * @returns 任务 ID 数组
   */
  queued(): string[] {
    return [...this.queue];
  }

  /**
   * 启动调度器后台轮询。
   *
   * 【调用时机】
   * 在 Electron 主进程就绪（`app.whenReady()`）后，完成核心模块组装时调用。
   *
   * 【作用】
   * 立即执行一次时钟心跳检查（`tick`），并启动 30 秒一次的循环定时器，持续监听任务到期。
   */
  start() {
    this.tick();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  /**
   * 停止调度器后台轮询。
   *
   * 【调用时机】
   * 应用退出前（`before-quit`）或销毁调度器时调用。
   *
   * 【作用】
   * 清除循环定时器，释放资源并避免在应用退出阶段继续派发任务。
   */
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * 调度器单次时钟检查心跳。
   *
   * 【调用时机】
   * 1. 调度器启动时立即触发；
   * 2. 后台循环定时器每 30 秒周期性触发；
   * 3. 调度器单元测试中手动模拟时钟步进。
   *
   * 【作用】
   * 遍历所有任务，推算其计划执行时刻与上次触发时刻：
   * 1. 首次见到的任务记录当前时间为起点，避免向前追溯历史；
   * 2. 对已到期但未记录过的时刻，无论是否在宽限期内，均更新 `lastScheduledAt` 防止重复触发；
   * 3. 距离当前时间在宽限期（5分钟）以内的到期任务，加入本次待触发列表并调用 `submit` 提交执行。
   */
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

  /**
   * 推进处理排队队列中的下一个任务。
   *
   * 【调用时机】
   * 1. 当正在运行的任务彻底收尾（`taskRunner.onIdle` 回调触发）时调用；
   * 2. 当队列中的某个任务尝试启动发生异常时在 catch 中调用，以继续消耗后续队列。
   *
   * 【作用】
   * 检查运行器是否处于空闲：
   * - 若运行器当前仍在执行，则直接返回；
   * - 若空闲，则从队列头部取出第一个等待的任务 ID；
   * - 若任务在排队期间已被用户删除，则跳过并递归推进下一个；
   * - 找到有效任务后调用 `launch` 启动它。
   */
  pump(): void {
    if (this.deps.isBusy()) return;
    const id = this.queue.shift();
    if (id === undefined) return;
    this.deps.onQueueChange();

    const task = this.deps.loadTasks().find((t) => t.id === id);
    if (!task) return this.pump(); // 排队期间被删除了，继续找下一个
    this.launch(task);
  }

  /**
   * 提交任务准备运行，处理运行中排队逻辑。
   *
   * 【调用时机】
   * 在 `tick()` 扫描到期任务后，对每一个到达计划时刻的任务内部调用。
   *
   * 【作用】
   * - 防重判断：如果该任务已在排队队列中，则忽略；
   * - 繁忙排队：若运行器当前有任务在跑，将本任务追加至队尾，发送入队通知并触发界面刷新；
   * - 立即运行：若当前系统空闲，则直接调用 `launch` 启动执行。
   *
   * @param task 待提交执行的目标任务
   */
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

  /**
   * 真正发起启动任务执行。
   *
   * 【调用时机】
   * 1. `submit` 时运行器空闲，直接调用；
   * 2. `pump` 从排队队列中成功弹出任务后调用。
   *
   * 【作用】
   * 发出开始运行的通知，并调用 `deps.run(task.id)` 启动任务。
   * 若任务未能成功启动（如抛出异常），发出错误通知并主动调用 `pump()`，确保排在其后的其他任务不会被卡死。
   *
   * @param task 准备启动的目标任务
   */
  private launch(task: TaskItem) {
    this.deps.notify(`定时任务「${task.name}」开始运行`);
    this.deps.run(task.id).catch((err) => {
      this.deps.notify(`定时任务「${task.name}」没能启动：${errorMessage(err)}`, true);
      this.pump(); // 没启动成功就不会触发"空闲"回调，这里接着处理下一个
    });
  }
}
