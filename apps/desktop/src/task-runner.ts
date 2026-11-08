import type { AgentSession, SubmitCheck } from "@agent-browser/agent";
import type { BrowserSession } from "@agent-browser/bridge";
import { randomBytes } from "node:crypto";
import { getRunStore, loadProfiles, loadTasks, prepareRunProfiles, saveTasks } from "./storage.ts";
import { DEFAULT_ADVICE, describeStop, describeTimeout, RunStopped } from "./run-stop.ts";
import { describeSubmitData, reviewSubmission, submitTemplate, tryExtractJsonFallback, type SubmitReview } from "./form-extract.ts";
import {
  capLog,
  errorMessage,
  lightRun,
  type AppState,
  type KernelItem,
  type ProfileItem,
  type RunBatch,
  type RunRecord,
  type RunStep,
  type TaskItem,
  type UiEvent,
} from "./shared.ts";


/** 创建 AgentSession 时随任务传入的运行选项 */
export interface AgentRunOptions {
  /** 任务设置的最大步数 */
  maxSteps?: number;
  /** 核对 `submit_result` 提交内容的回调 */
  onSubmitResult?: (data: Record<string, unknown>) => SubmitCheck;
  /** 本任务 `submit_result.data` 的参数说明 */
  submitDataDescription?: string;
}

/**
 * 毫秒耗时格式化为 mm:ss 字符串。
 *
 * 【调用时机】
 * 任务完成或失败收尾时内部调用。
 *
 * 【作用】
 * 计算运行耗时并格式化为如 "02:15" 的简明文本。
 *
 * @param ms 毫秒数值
 * @returns 格式化后的分秒字符串
 */
function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

/**
 * 一轮结束时界面轻提示的文字。
 *
 * @param name 任务名称
 * @param runs 这一轮实际跑完的运行记录
 * @param total 这一轮计划运行的 Profile 数
 */
function finishedMessage(name: string, runs: RunRecord[], total: number): string {
  if (total <= 1) return `任务「${name}」执行完成（${runs[0]?.status === "ok" ? "成功" : "失败"}）`;
  const ok = runs.filter((r) => r.status === "ok").length;
  const fail = runs.length - ok;
  const skipped = total - runs.length;
  const parts = [`成功 ${ok} 个`, fail > 0 ? `失败 ${fail} 个` : "", skipped > 0 ? `${skipped} 个未运行` : ""].filter(Boolean);
  return `任务「${name}」这一轮已结束：${parts.join("，")}`;
}

/**
 * 任务执行调度与运行时生命周期管理器。
 * 负责调度 Agent 与浏览器环境交互、管理步骤执行、记录日志与截图落盘、处理超时与中止信号。
 */
export class TaskRunner {
  /** 当前正在执行的任务运行记录实体 */
  private activeRun: RunRecord | null = null;
  /** 当前运行的 Agent 会话实例 */
  private currentAgent: AgentSession | null = null;
  /** 用于取消当前运行的 AbortController 实例 */
  private currentAbortController: AbortController | null = null;
  /** 任务超时计时器句柄 */
  private deadline: ReturnType<typeof setTimeout> | null = null;
  /** 是否因超时而触发中止（用于区分用户主动取消与超时中断） */
  private timedOut = false;
  /** 当前运行启动的毫秒时间戳 */
  private startTime = 0;
  /** 是否有一轮正在进行：从第一个 Profile 开始到最后一个结束，两次运行之间也算 */
  private batchActive = false;
  /** 当前这一轮的 ID；只跑一个 Profile 时没有 */
  private batchId: string | undefined;
  /** 用户点了「停止」（或退出应用）：停掉整轮，后面的 Profile 不再运行；这种情况不发完成通知 */
  private stopRequested = false;

  /**
   * 构造任务运行器。
   *
   * @param emitEvent 主进程向渲染层推送 UI 事件的回调
   * @param getAppState 获取当前应用全局状态的回调
   * @param getOrStartBrowser 获取或启动指定内核与 Profile 浏览器会话的回调
   * @param closeBrowser 安全关闭当前打开的浏览器会话的回调
   * @param createAgent 根据浏览器会话和设置创建 AgentSession 的工厂函数
   */
  constructor(
    private emitEvent: (event: UiEvent) => void,
    private getAppState: () => AppState,
    private getOrStartBrowser: (
      kernelId: string,
      profileId: string,
      initialUrl?: string,
      headless?: boolean,
    ) => Promise<BrowserSession>,
    private closeBrowser: () => Promise<void>,
    private createAgent: (browser: BrowserSession, opts: AgentRunOptions) => AgentSession,
  ) {}

  /**
   * 恢复与清理上次异常退出未收尾的运行记录。
   *
   * 【调用时机】
   * 应用启动阶段（`main.ts` 中的 `app.whenReady()`）在完成初始化后立即调用。
   *
   * 【作用】
   * 当应用上次发生系统断电、崩溃或强制退出时，处于执行中的任务记录会停留在 "run" 状态。
   * 本方法扫描所有历史记录和任务列表，将残留的 "run" 状态安全修正为 "fail"（标记为「已中断」），
   * 保留已经记录落盘的所有步骤与截图，保证数据状态的一致性。
   */
  recoverInterruptedRuns() {
    const store = getRunStore();
    for (const summary of store.list()) {
      if (summary.status !== "run") continue;
      const r = store.get(summary.id);
      if (!r) continue;
      r.status = "fail";
      r.hasError = true;
      r.error = "应用在任务执行过程中退出，这次运行被中断";
      r.advice = "已记录的步骤仍然保留。可以重新运行该任务。";
      r.endTime = r.endTime ?? Date.now();
      store.save(r, { index: true });
    }

    const tasks = loadTasks();
    let tasksChanged = false;
    for (const t of tasks) {
      if (t.lastStatus !== "run") continue;
      t.lastStatus = "fail";
      t.lastDuration = "已中断";
      tasksChanged = true;
    }
    if (tasksChanged) saveTasks(tasks);
  }

  /**
   * 持久化当前运行记录到本地磁盘。
   *
   * 【调用时机】
   * 1. 任务开始时调用（index: true，写入 run.json 并同步更新全局 index.json 索引）；
   * 2. 执行过程中产生新步骤、截图或助理回复时调用（index: false，轻量仅写自己的小文件）；
   * 3. 任务顺利完成或失败收尾时调用（index: true，更新最终结果与状态到全局索引）。
   *
   * 【作用】
   * 调用 RunStore 实例将当前的 `activeRun` 原子写入专属文件。
   *
   * @param index 是否同时将摘要更新回全局 index.json 列表索引
   */
  private persistRun(index: boolean) {
    if (this.activeRun) getRunStore().save(this.activeRun, { index });
  }

  /**
   * 运行器恢复空闲时的回调通知钩子。
   * 一次运行彻底结束后（浏览器已按设置关闭或保留）被调用，调度器据此继续推进排队等待的任务。
   */
  onIdle?: () => void;

  /**
   * 一轮运行全部收尾（结果已落盘）时的回调；只跑一个 Profile 时 runs 只有一条。
   * 主进程据此发「任务完成」系统通知；byUser 为 true 表示用户自己停止的，不需要通知。
   */
  onFinished?: (runs: RunRecord[], byUser: boolean) => void;

  /**
   * 获取当前正在执行的任务明细对象。
   *
   * 【调用时机】
   * 主进程在组装 AppState（`main.ts` 中的 `state()`）时调用。
   *
   * 【作用】
   * 返回当前的 `activeRun` 实体引用，若当前无任务在执行则返回 null。
   *
   * @returns 当前活跃的 RunRecord 或 null
   */
  getActiveRun(): RunRecord | null {
    return this.activeRun;
  }

  /**
   * 查询当前是否有任务正在执行中。
   *
   * 【调用时机】
   * 1. 调度器检查系统繁忙状态（`isBusy`）时调用；
   * 2. 主进程组装应用全局状态时标记 `running` 状态。
   *
   * @returns 若正在执行任务返回 true，否则返回 false
   */
  isRunning(): boolean {
    return this.batchActive;
  }

  /** 当前正在进行的那一轮的 ID；没有在跑、或只跑一个 Profile 时为 undefined */
  getActiveBatchId(): string | undefined {
    return this.batchId;
  }

  /**
   * 发起执行指定 ID 的任务：在任务勾选的每个 Profile 上依次各跑一次（一轮）。
   *
   * 【调用时机】
   * 1. 用户在前端任务列表点击"运行"按钮或任务编辑页点击"保存并运行"时调用（由 IPC `IPC.runTask` 触发）；
   * 2. 用户重试失败的运行时调用，只在那些 Profile 上重跑（由 IPC `IPC.retryRun` / `IPC.retryBatch` 触发）；
   * 3. 调度器轮询发现有任务到期且当前空闲，或队列出队时自动触发（triggerKind: "定时触发"）。
   *
   * 【作用】
   * 1. 并发互斥拦截（已有一轮在跑时抛错）；
   * 2. 解析这一轮要用的 Profile（必要时自动新建），登记任务状态为 "run"；
   * 3. 按顺序对每个 Profile 调用 `runOne`：某个失败了继续跑下一个；用户停止则整轮停下；
   * 4. 整轮结束后汇总任务状态，按配置关闭浏览器，发完成通知，并调用 `onIdle` 唤醒调度器消耗后续排队任务。
   *
   * 整轮期间 `isRunning()` 一直为 true，排队的任务要等整轮结束才会开始。
   *
   * @param taskId 目标任务的 ID
   * @param triggerKind 触发来源说明（如 "手动触发"、"定时触发"、"失败重试"）
   * @param onlyProfileIds 只在这些 Profile 上运行（重试用）；不传则用任务勾选的全部 Profile
   */
  async runTask(taskId: string, triggerKind = "手动触发", onlyProfileIds?: string[]): Promise<void> {
    if (this.batchActive) {
      throw new Error("已有任务正在执行中，请先等待或停止当前任务。");
    }
    const task = loadTasks().find((t) => t.id === taskId);
    if (!task) throw new Error(`未找到任务 ID: ${taskId}`);

    // 在第一个 await 之前占住运行器，防止解析 Profile 期间又启动另一个任务
    this.batchActive = true;
    this.stopRequested = false;
    let plan: Awaited<ReturnType<typeof prepareRunProfiles>>;
    try {
      plan = await prepareRunProfiles(task, onlyProfileIds);
    } catch (err) {
      this.batchActive = false;
      throw err;
    }
    const { kernel, profiles, created } = plan;
    if (created) this.emitEvent({ type: "state", state: this.getAppState() });

    const batchId = profiles.length > 1 ? `batch-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}` : undefined;
    this.batchId = batchId;
    const before = this.markTaskStarted(task.id, kernel, created && !task.autoProfile ? profiles[0]!.id : undefined);

    const batchStart = Date.now();
    const finished: RunRecord[] = [];
    try {
      for (const [i, profile] of profiles.entries()) {
        if (this.stopRequested) break;
        const batch = batchId ? { id: batchId, index: i + 1, total: profiles.length } : undefined;
        finished.push(await this.runOne(task, kernel, profile, triggerKind, batch));
      }
    } finally {
      this.markTaskFinished(task.id, finished, Date.now() - batchStart, before);
      // 后台运行没有窗口可以手动关，结束后一律关闭，避免留下看不见的浏览器进程
      if (task.autoClose || task.headless) {
        await this.closeBrowser().catch(() => {});
      }
      // 浏览器关完才放开运行器，免得关闭时误关了紧接着启动的下一个任务的浏览器
      this.batchActive = false;
      this.batchId = undefined;
      if (finished.length > 0) {
        this.emitEvent({ type: "notice", message: finishedMessage(task.name, finished, profiles.length) });
        this.onFinished?.(finished, this.stopRequested);
      }
      this.emitEvent({ type: "state", state: this.getAppState() });
      // 通知调度器：可以让排队的下一个任务上了
      this.onIdle?.();
    }
  }

  /**
   * 一轮开始时把任务登记为「运行中」。
   *
   * @param taskId 任务 ID
   * @param kernel 这一轮用的内核
   * @param pinProfileId 这个内核原本没有 Profile、刚为任务新建了一个时传入：记到任务上，下次还用它
   * @returns 登记前的状态；整轮一个都没跑（刚开始就被停止）时用来还原
   */
  private markTaskStarted(taskId: string, kernel: KernelItem, pinProfileId?: string) {
    const tasks = loadTasks();
    const t = tasks.find((item) => item.id === taskId);
    if (!t) return undefined;
    const before = { lastStatus: t.lastStatus, lastRunTime: t.lastRunTime, lastDuration: t.lastDuration };
    t.kernelId = kernel.id;
    t.kernel = kernel.name;
    if (pinProfileId) t.profileIds = [pinProfileId];
    t.lastStatus = "run";
    t.lastRunTime = "刚刚开始";
    t.lastDuration = "进行中";
    saveTasks(tasks);
    return before;
  }

  /**
   * 一轮结束时汇总任务的最近状态：跑过的 Profile 全部成功才算成功。
   * 用户停止时正在跑的那个会记为失败，所以被停止的一轮也算失败。
   *
   * @param taskId 任务 ID
   * @param runs 这一轮实际跑完的运行记录
   * @param elapsedMs 整轮用时
   * @param before 开始前的状态；一个都没跑时还原它
   */
  private markTaskFinished(
    taskId: string,
    runs: RunRecord[],
    elapsedMs: number,
    before: Pick<TaskItem, "lastStatus" | "lastRunTime" | "lastDuration"> | undefined,
  ) {
    const tasks = loadTasks();
    const t = tasks.find((item) => item.id === taskId);
    if (!t) return;
    if (runs.length === 0 && before) {
      Object.assign(t, before);
    } else {
      // 与运行记录里这一轮的整体状态一致（见 batch.ts 的 summarizeBatch）：有失败才算失败
      t.lastStatus = runs.every((r) => r.status === "ok") ? "ok" : "fail";
      t.lastRunTime = "刚刚";
      t.lastDuration = `用时 ${formatElapsed(elapsedMs)}`;
    }
    saveTasks(tasks);
  }

  /**
   * 在一个 Profile 上运行一次任务。
   *
   * 【调用时机】`runTask` 按顺序对这一轮的每个 Profile 调用。
   *
   * 【作用】
   * 1. 初始化运行记录与第一步"启动环境"日志，注册超时定时器（每个 Profile 单独计时）；
   * 2. 确认 Profile 仍然存在（一轮进行中可能被删），启动或复用对应的浏览器会话；
   * 3. 实例化 AgentSession，运行主推理交互循环（`executeRealAgent`）；
   * 4. 成功收尾（`finishTask`）或失败拦截（`failTask`），清理计时器与运行状态。
   * 浏览器不在这里关：换下一个 Profile 时 `getOrStartBrowser` 会先关掉旧的，整轮结束再按设置关闭。
   *
   * @returns 收尾后的完整运行记录
   */
  private async runOne(
    task: TaskItem,
    kernel: KernelItem,
    profile: ProfileItem,
    triggerKind: string,
    batch: RunBatch | undefined,
  ): Promise<RunRecord> {
    const runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    this.startTime = Date.now();
    this.currentAbortController = new AbortController();
    this.timedOut = false;
    const limitMs = (task.timeoutMinutes ?? 0) * 60_000;
    if (limitMs > 0) {
      this.deadline = setTimeout(() => {
        this.timedOut = true;
        this.currentAbortController?.abort();
      }, limitMs);
    }

    const initialStep: RunStep = {
      stepNumber: 1,
      status: "run",
      tag: "启动",
      text: `${task.headless ? "后台启动" : "启动"}「${kernel.name}」，加载对应 Profile「${profile.name}」`,
      meta: "进行中",
    };

    const run: RunRecord = {
      id: runId,
      taskId: task.id,
      name: task.name,
      status: "run",
      startTime: this.startTime,
      trigger: triggerKind,
      profileId: profile.id,
      profileName: profile.name,
      ...(batch ? { batch } : {}),
      summary: "",
      steps: [initialStep],
    };
    this.activeRun = run;

    this.persistRun(true);
    this.emitEvent({ type: "run_update", run: lightRun(run) });
    this.emitEvent({ type: "state", state: this.getAppState() });

    try {
      // 1. 一轮进行中 Profile 可能被删了：不能悄悄换成默认 Profile 去跑（那是另一个账号）
      if (!loadProfiles().some((p) => p.id === profile.id)) {
        throw new RunStopped(`Profile「${profile.name}」已被删除`, "到任务的高级设置里重新勾选要运行的 Profile。");
      }

      // 2. 拉起或连接任务指定的浏览器内核及对应 Profile
      const browserSession = await this.getOrStartBrowser(kernel.id, profile.id, task.url, !!task.headless);

      // 3. 检查模型配置并实例化 Agent
      const agentSession = this.createAgent(browserSession, {
        ...(task.maxSteps ? { maxSteps: task.maxSteps } : {}),
        ...this.submitOptions(task),
      });
      this.currentAgent = agentSession;

      // 4. 运行真实 Agent 循环
      await this.executeRealAgent(task, agentSession);

      this.finishTask("ok");
    } catch (err) {
      // 优先级：超时 > 用户终止 > Agent 给出的停止原因 > 其他异常
      const stop = this.timedOut
        ? describeTimeout(task.timeoutMinutes)
        : this.currentAbortController?.signal.aborted
          ? describeStop("cancelled", undefined)!
          : err instanceof RunStopped
            ? err
            : new RunStopped(errorMessage(err), DEFAULT_ADVICE);
      this.failTask(stop.message, stop.advice);
    } finally {
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = null;
      this.activeRun = null;
      this.currentAgent = null;
      this.currentAbortController = null;
    }
    return run;
  }

  /**
   * 中止当前正在运行的任务。
   *
   * 【调用时机】
   * 1. 用户在前端实时页面点击"终止任务"（由 IPC `IPC.cancelTask` 触发）时调用；
   * 2. 应用关闭前退出清理时调用。
   *
   * 【作用】
   * 停掉整轮：当前 Profile 的运行立即中断（记为失败），后面的 Profile 不再运行。
   * 触发当前执行过程持有的 AbortController 中止信号，使进行中的网络请求与 Agent 交互立即中断退出。
   */
  cancel() {
    if (this.batchActive) this.stopRequested = true;
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

  /**
   * 生成本次运行的 `submit_result` 相关选项（任务没有表单字段时返回空对象）。
   *
   * 【调用时机】`runTask` 创建 AgentSession 时调用，每次运行一套，提交状态不跨运行。
   *
   * 【作用】
   * - 把本任务的字段名和格式写进 `submit_result.data` 的参数说明，让模型知道该用哪些键；
   * - 每次提交都按字段核对（见 `reviewSubmission`），合并后的数据写入运行结果，
   *   核对结论作为工具结果回给 Agent：格式不对时 Agent 能看到错误并重新提交。
   */
  private submitOptions(task: TaskItem): Pick<AgentRunOptions, "onSubmitResult" | "submitDataDescription"> {
    const fields = task.fields;
    if (!fields?.length) return {};
    let last: SubmitReview | undefined;
    return {
      submitDataDescription: describeSubmitData(fields),
      onSubmitResult: (data) => {
        last = reviewSubmission(data, fields, last);
        if (this.activeRun) this.activeRun.result = { kind: "form", data: last.data, fields };
        return last.ok ? { ok: true, message: last.message } : { ok: false, error: last.message };
      },
    };
  }

  /**
   * 执行与 Agent 的多轮真实交互循环。
   *
   * 【调用时机】
   * 在 `runTask` 成功初始化浏览器会话与 AgentSession 后内部调用。
   *
   * 【作用】
   * 1. 组装输入提示词（包含目标、起始网址、完成判定条件、表单提取要求）；
   * 2. 调用 `agent.send` 发送目标并实时监听流式事件：
   *    - `done`: 捕获完成状态与停止原因；
   *    - `assistant_turn`: 捕获最终文本回复，并进行表单提取兜底尝试；
   *    - `tool_call`: 记录工具调用步骤，保存导航 URL（用于重试），处理 `submit_result` 表单提交；
   *    - `tool_result`: 记录耗时与状态，将截图图片安全落盘保存为独立图片文件；
   * 3. 循环结束后检查是否存在异常终止原因（通过 `describeStop`），若非正常完成则主动抛出 `RunStopped`。
   *
   * @param task 当前执行的任务对象
   * @param agent 已绑定的 AgentSession 实例
   */
  private async executeRealAgent(task: TaskItem, agent: AgentSession) {
    if (!this.activeRun) return;

    if (this.activeRun.steps[0]) {
      this.activeRun.steps[0].status = "done";
      this.activeRun.steps[0].meta = "已就绪";
    }

    const hasFields = Boolean(task.fields && task.fields.length > 0);
    const formPrompt = hasFields
      ? [
          "【表单提取要求】",
          "本任务需要提取以下结构化表单字段：",
          ...task.fields!.map(
            (f) =>
              `- 「${f.name}」（类型：${f.type === "number" ? "数字" : "文本"}${f.description ? `，要求：${f.description}` : ""}）`,
          ),
          `在从页面收集到信息后，必须调用 submit_result 工具提交，参数格式：{"data": ${submitTemplate(task.fields!)}}。键名必须与上面的字段名完全一致，数字类型填纯数字，页面上确实找不到的字段填 null。`,
          "submit_result 会返回核对结果；若返回错误，请按提示修正后重新提交，直到提交成功，再在最终回复中简要总结。",
        ].join("\n")
      : "";

    const prompt = [
      `任务目标：${task.goal}`,
      task.url ? `起始网址：${task.url}` : "",
      task.doneCondition ? `完成判定条件：${task.doneCondition}` : "",
      formPrompt,
    ]
      .filter(Boolean)
      .join("\n");

    this.activeRun.prompt = prompt;
    // 本轮 Agent 在发起工具调用前说的话，挂到这一轮的第一个工具调用上
    let pendingThought = "";

    // 记录 Agent 停下的原因；放在对象上，避免闭包里赋值被 TS 误判为 never
    const outcome: { reason?: string; message?: string } = {};

    await agent.send(
      prompt,
      (event) => {
        if (event.type === "done") {
          outcome.reason = event.reason;
          if (event.message) outcome.message = event.message;
        }
        if (!this.activeRun) return;

        if (event.type === "assistant_turn") {
          // 有工具调用的那一轮，文字是 Agent 对这一步的说明，留给运行日志；没有工具调用的那一轮才是最终回复
          pendingThought = event.toolCalls.length > 0 ? event.text.trim() : "";
          if (event.toolCalls.length === 0 && event.text.trim()) {
            this.activeRun.summary = event.text;
            const current = this.activeRun.result;
            const nothingYet = !current || (current.kind === "form" && Object.values(current.data).every((v) => v === null));
            if (hasFields && nothingYet) {
              const fallback = tryExtractJsonFallback(event.text, task.fields!);
              if (fallback) {
                this.activeRun.result = {
                  kind: "form",
                  data: fallback,
                  fields: task.fields!,
                };
              }
            }
            this.persistRun(false);
            this.emitEvent({ type: "run_update", run: lightRun(this.activeRun) });
          }
        } else if (event.type === "tool_call") {
          const newStep: RunStep = {
            // 编号统一按当前步数 + 1，避免和「插话」步骤撞号（截图文件名也用它）
            stepNumber: this.activeRun.steps.length + 1,
            status: "run",
            tag: this.resolveToolTag(event.name),
            text: [event.name, this.summarizeArgs(event.input)].filter(Boolean).join("  "),
            meta: "进行中",
            tool: event.name,
            input: capLog(this.stringifyInput(event.input)),
            ...(pendingThought ? { thought: capLog(pendingThought) } : {}),
          };
          pendingThought = "";
          // 记录 Agent 最后导航到的页面：失败后「从上次失败处重试」要用
          const navUrl = this.extractNavigateUrl(event.name, event.input);
          if (navUrl) this.activeRun.lastUrl = navUrl;
          this.activeRun.steps.push(newStep);
          this.persistRun(false);
          this.emitEvent({ type: "run_update", run: lightRun(this.activeRun) });
        } else if (event.type === "tool_result") {
          const lastStep = this.activeRun.steps[this.activeRun.steps.length - 1];
          if (lastStep) {
            lastStep.status = event.result.isError ? "todo" : "done";
            lastStep.meta = `用时 ${event.durationMs}ms`;
            if (event.result.isError) lastStep.isError = true;
            const outText = event.result.content
              .flatMap((item) => (item.type === "text" ? [item.text] : []))
              .join("\n")
              .trim();
            if (outText) lastStep.output = capLog(outText);
            for (const item of event.result.content) {
              // 截图直接存成文件，记录和消息里只带文件名，不再带着 base64 满处传
              if (item.type === "image") {
                lastStep.screenshot = getRunStore().saveShot(
                  this.activeRun.id,
                  lastStep.stepNumber,
                  item.source.media_type,
                  item.source.data,
                );
              }
            }
            this.persistRun(false);
            this.emitEvent({ type: "run_update", run: lightRun(this.activeRun) });
          }
        }
      },
      this.currentAbortController?.signal,
    );

    const stop = describeStop(outcome.reason, outcome.message, task.maxSteps);
    if (stop) throw stop;
  }

  /**
   * 一次运行（一个 Profile）收尾：记录结束时间与最终状态并落盘。
   *
   * 【调用时机】
   * 1. 这个 Profile 顺利执行完成时在 `runOne` 中调用；
   * 2. 在 `failTask` 中完成错误记录赋值后调用以统一落盘。
   * 任务的最近状态、完成提示与通知在整轮结束时由 `runTask` 统一处理。
   *
   * @param status 最终状态（"ok" 或 "fail"）
   */
  private finishTask(status: "ok" | "fail") {
    if (!this.activeRun) return;
    this.activeRun.status = status;
    this.activeRun.endTime = Date.now();
    this.persistRun(true);
  }

  /**
   * 一次运行异常失败时的错误记录组装与收尾。
   *
   * 【调用时机】
   * 在 `runOne` 的 catch 错误处理块中调用。
   *
   * 【作用】
   * 在当前的 `activeRun` 上附加详细报错原因 `error` 与解决方案建议 `advice`，修改状态为 "fail"，并委托 `finishTask` 完成最终持久化。
   *
   * @param errorMsg 错误说明信息
   * @param advice 针对用户的排查建议
   */
  private failTask(errorMsg: string, advice: string) {
    if (!this.activeRun) return;

    this.activeRun.status = "fail";
    this.activeRun.hasError = true;
    this.activeRun.error = errorMsg;
    this.activeRun.advice = advice;
    this.activeRun.summary = `任务执行失败：${errorMsg}`;

    this.finishTask("fail");
  }

  /**
   * 将工具名称映射为中文分类标签。
   *
   * 【调用时机】
   * 在 `tool_call` 收到工具调用创建新的 RunStep 步骤时内部调用。
   *
   * 【作用】
   * 将 navigate 映射为"导航"、read_page 映射为"观察"、find/get_page_text 映射为"提取"、browser_batch 映射为"批量"、submit_result 映射为"表单"，其余默认"动作"。
   *
   * @param name 底层工具调用名称
   * @returns 中文分类短标签
   */
  private resolveToolTag(name: string): string {
    switch (name) {
      case "navigate":
        return "导航";
      case "read_page":
        return "观察";
      case "get_page_text":
      case "find":
        return "提取";
      case "browser_batch":
        return "批量";
      case "submit_result":
        return "表单";
      default:
        return "动作";
    }
  }

  /**
   * 从工具调用参数中提取导航目标 URL。
   *
   * 【调用时机】
   * 在 `tool_call` 事件处理时调用。
   *
   * 【作用】
   * 检查是否为页面导航操作（包含 `navigate` 工具或 `browser_batch` 动作列表中的 navigate 子动作），提取出目标网址。
   * 将其记录到 `activeRun.lastUrl` 中，当任务失败后用户点击"从失败处重试"时便可直接从该网址继续执行。
   *
   * @param name 工具名称
   * @param input 工具入参对象
   * @returns 提取到的 URL 字符串；若非导航操作则返回 null
   */
  private extractNavigateUrl(name: string, input: unknown): string | null {
    if (!input || typeof input !== "object") return null;
    const obj = input as Record<string, unknown>;
    if (name === "navigate" && typeof obj.url === "string") return obj.url;
    if (Array.isArray(obj.actions)) {
      for (let i = obj.actions.length - 1; i >= 0; i--) {
        const a = obj.actions[i];
        if (a && typeof a === "object") {
          const ao = a as { name?: unknown; input?: unknown };
          if (ao.name === "navigate" && ao.input && typeof ao.input === "object") {
            const u = (ao.input as Record<string, unknown>).url;
            if (typeof u === "string") return u;
          }
        }
      }
    }
    return null;
  }

  /** 工具入参转为格式化 JSON 文本，供运行日志完整展示 */
  private stringifyInput(input: unknown): string {
    if (input === undefined) return "";
    try {
      return JSON.stringify(input, null, 2) ?? "";
    } catch {
      return String(input);
    }
  }

  /**
   * 生成简短清晰的参数摘要。
   *
   * 【调用时机】
   * 在 `tool_call` 事件生成步骤文本描述时调用。
   *
   * 【作用】
   * 过滤掉 tabId、createIfEmpty 等机器底层无意义噪音字段，将关键参数（URL、子动作链、文本输入等）裁剪展示，最长限制在 60 字符内。
   *
   * @param input 工具原始输入参数
   * @returns 裁剪后的参数摘要字符串
   */
  private summarizeArgs(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const obj = input as Record<string, unknown>;
    const clip = (v: string, n = 60) => (v.length > n ? v.slice(0, n - 1) + "…" : v);

    if (typeof obj.url === "string") return clip(obj.url);
    if (Array.isArray(obj.actions)) {
      const names = obj.actions
        .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === "string");
      return names.length ? clip(names.join(" → ")) : `${obj.actions.length} 个动作`;
    }

    const noise = new Set(["tabId", "createIfEmpty"]);
    const parts = Object.entries(obj)
      .filter(([k, v]) => !noise.has(k) && v !== undefined && v !== null)
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`);
    return clip(parts.join(" "));
  }
}
