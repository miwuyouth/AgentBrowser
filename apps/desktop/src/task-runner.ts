import type { AgentSession } from "@agent-browser/agent";
import type { BrowserSession } from "@agent-browser/bridge";
import { randomBytes } from "node:crypto";
import { formatProfileStamp, getRunStore, loadTasks, resolveOrCreateProfile, saveTasks } from "./storage.ts";
import { DEFAULT_ADVICE, describeStop, describeTimeout, RunStopped } from "./run-stop.ts";
import { normalizeFormData, tryExtractJsonFallback } from "./form-extract.ts";
import { errorMessage, type AppState, type FormField, type RunRecord, type RunStep, type TaskItem, type UiEvent } from "./shared.ts";

/** 毫秒 → mm:ss */
function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  return `${String(Math.floor(sec / 60)).padStart(2, "0")}:${String(sec % 60).padStart(2, "0")}`;
}

export class TaskRunner {
  private activeRun: RunRecord | null = null;
  private currentAgent: AgentSession | null = null;
  private currentAbortController: AbortController | null = null;
  /** 任务超时计时器；超时后 timedOut 为 true，用来和用户主动终止区分开 */
  private deadline: ReturnType<typeof setTimeout> | null = null;
  private timedOut = false;
  private startTime = 0;

  constructor(
    private emitEvent: (event: UiEvent) => void,
    private getAppState: () => AppState,
    private getOrStartBrowser: (kernelId: string, profileId: string, initialUrl?: string) => Promise<BrowserSession>,
    private closeBrowser: () => Promise<void>,
    private createAgent: (browser: BrowserSession, opts: { maxSteps?: number }) => AgentSession,
  ) {}

  /**
   * 应用上次异常退出（崩溃、强退）时，进行中的记录会停在「运行中」。
   * 启动时把它们收尾成「失败」，保留已经记下的步骤。
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
   * 把当前运行记录写到它自己的文件。index 为真时同时更新列表索引（开始、结束时）；
   * 运行中每一步只写这一个小文件，截图在产生时就已经存成独立文件。
   */
  private persistRun(index: boolean) {
    if (this.activeRun) getRunStore().save(this.activeRun, { index });
  }

  /** 一次运行彻底结束后调用（浏览器已按设置关闭）。调度器用它来启动排队的任务 */
  onIdle?: () => void;

  getActiveRun(): RunRecord | null {
    return this.activeRun;
  }

  isRunning(): boolean {
    return this.activeRun !== null;
  }

  async runTask(taskId: string, triggerKind = "手动触发"): Promise<void> {
    if (this.activeRun) {
      throw new Error("已有任务正在执行中，请先等待或停止当前任务。");
    }

    const tasks = loadTasks();
    const taskIndex = tasks.findIndex((t) => t.id === taskId);
    if (taskIndex === -1) throw new Error(`未找到任务 ID: ${taskId}`);

    const task = tasks[taskIndex];
    if (!task) throw new Error(`未找到任务 ID: ${taskId}`);

    // 自动模式：每次执行都新建 Profile；否则用所选 Profile，该内核下一个都没有时也会自动创建
    const autoProfile = !!task.autoProfile;
    const { kernel, profile, created } = await resolveOrCreateProfile(
      task.kernelId || task.kernel,
      autoProfile ? undefined : task.profileId || task.profile,
      formatProfileStamp(),
      autoProfile,
    );
    if (created) this.emitEvent({ type: "state", state: this.getAppState() });

    task.kernelId = kernel.id;
    task.kernel = kernel.name;
    // 自动模式下任务本身不绑定具体 Profile，下次执行仍会新建
    if (!autoProfile) {
      task.profileId = profile.id;
      task.profile = profile.name;
    }
    task.lastStatus = "run";
    task.lastRunTime = "刚刚开始";
    task.lastDuration = "进行中";
    saveTasks(tasks);

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
      text: `启动「${kernel.name}」，加载对应 Profile「${profile.name}」`,
      meta: "进行中",
    };

    this.activeRun = {
      id: runId,
      taskId: task.id,
      name: task.name,
      status: "run",
      startTime: this.startTime,
      trigger: triggerKind,
      summary: "",
      steps: [initialStep],
    };

    this.persistRun(true);
    this.emitEvent({ type: "run_update", run: this.activeRun });
    this.emitEvent({ type: "state", state: this.getAppState() });

    try {
      // 1. 拉起或连接任务指定的浏览器内核及对应 Profile
      const initialUrl = task.url;
      const browserSession = await this.getOrStartBrowser(kernel.id, profile.id, initialUrl);

      // 2. 检查模型配置并实例化 Agent
      const agentSession = this.createAgent(browserSession, task.maxSteps ? { maxSteps: task.maxSteps } : {});
      this.currentAgent = agentSession;

      // 3. 运行真实 Agent 循环
      await this.executeRealAgent(task, agentSession);

      this.finishTask(task, "ok");
    } catch (err) {
      // 优先级：超时 > 用户终止 > Agent 给出的停止原因 > 其他异常
      const stop = this.timedOut
        ? describeTimeout(task.timeoutMinutes)
        : this.currentAbortController?.signal.aborted
          ? describeStop("cancelled", undefined)!
          : err instanceof RunStopped
            ? err
            : new RunStopped(errorMessage(err), DEFAULT_ADVICE);
      this.failTask(task, stop.message, stop.advice);
    } finally {
      if (this.deadline) clearTimeout(this.deadline);
      this.deadline = null;
      this.activeRun = null;
      this.currentAgent = null;
      this.currentAbortController = null;
      if (task.autoClose) {
        await this.closeBrowser().catch(() => {});
      }
      this.emitEvent({ type: "state", state: this.getAppState() });
      // 通知调度器：可以让排队的下一个任务上了
      this.onIdle?.();
    }
  }

  cancel() {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
    }
  }

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
          '在从页面收集到信息后，必须调用 submit_result 工具提交提取的数据，参数格式：{"data": { "字段名": 字段值 }}。数字类型请填纯数字。完成提交后在最终回复中简要总结。',
        ].join("\n")
      : "";

    const prompt = [
      `任务目标：${task.goal}`,
      task.url ? `起始网址：${task.url}` : "",
      task.doneCondition ? `完成判定条件：${task.doneCondition}` : "",
      formPrompt,
      task.resultFormat ? `结果格式要求：${task.resultFormat}` : "",
    ]
      .filter(Boolean)
      .join("\n");

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
          // 没有工具调用的那一轮就是最终回复。界面不显示思考过程和逐字输出，所以不再推送它们
          if (event.toolCalls.length === 0 && event.text.trim()) {
            this.activeRun.summary = event.text;
            if (hasFields && !this.activeRun.result) {
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
            this.emitEvent({ type: "run_update", run: this.activeRun });
          }
        } else if (event.type === "tool_call") {
          if (event.name === "submit_result" && hasFields && event.input && typeof event.input === "object") {
            const rawData = (event.input as { data?: unknown }).data ?? event.input;
            const normalized = normalizeFormData(rawData, task.fields!);
            this.activeRun.result = {
              kind: "form",
              data: normalized,
              fields: task.fields!,
            };
          }
          const newStep: RunStep = {
            // 编号统一按当前步数 + 1（截图文件名也用它）
            stepNumber: this.activeRun.steps.length + 1,
            status: "run",
            tag: this.resolveToolTag(event.name),
            text: [event.name, this.summarizeArgs(event.name, event.input)].filter(Boolean).join("  "),
            meta: "进行中",
          };
          // 记录 Agent 最后导航到的页面：失败后「从上次失败处重试」要用
          const navUrl = this.extractNavigateUrl(event.name, event.input);
          if (navUrl) this.activeRun.lastUrl = navUrl;
          this.activeRun.steps.push(newStep);
          this.persistRun(false);
          this.emitEvent({ type: "run_update", run: this.activeRun });
        } else if (event.type === "tool_result") {
          const lastStep = this.activeRun.steps[this.activeRun.steps.length - 1];
          if (lastStep) {
            lastStep.status = event.result.isError ? "todo" : "done";
            lastStep.meta = `用时 ${event.durationMs}ms`;
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
            this.emitEvent({ type: "run_update", run: this.activeRun });
          }
        }
      },
      this.currentAbortController?.signal,
    );

    const stop = describeStop(outcome.reason, outcome.message, task.maxSteps);
    if (stop) throw stop;
  }

  private finishTask(task: TaskItem, status: "ok" | "fail") {
    if (!this.activeRun) return;

    this.activeRun.status = status;
    this.activeRun.endTime = Date.now();
    const durationStr = formatElapsed(this.activeRun.endTime - this.startTime);

    this.persistRun(true);

    const tasks = loadTasks();
    const t = tasks.find((item) => item.id === task.id);
    if (t) {
      t.lastStatus = status;
      t.lastRunTime = "刚刚";
      t.lastDuration = `用时 ${durationStr}`;
      saveTasks(tasks);
    }

    this.emitEvent({ type: "notice", message: `任务「${task.name}」执行完成（${status === "ok" ? "成功" : "失败"}）` });
  }

  private failTask(task: TaskItem, errorMsg: string, advice: string) {
    if (!this.activeRun) return;

    this.activeRun.status = "fail";
    this.activeRun.hasError = true;
    this.activeRun.error = errorMsg;
    this.activeRun.advice = advice;
    this.activeRun.summary = `任务执行失败：${errorMsg}`;

    this.finishTask(task, "fail");
  }

  private resolveToolTag(name: string): string {
    switch (name) {
      case "navigate":
        return "导航";
      case "read_page":
        return "观察";
      case "get_page_text":
      case "find":
        return "提取";
      case "javascript_tool":
        return "数据";
      case "browser_batch":
        return "批量";
      case "submit_result":
        return "表单";
      default:
        return "动作";
    }
  }

  /** 从工具调用参数里提取导航目标 URL（含 browser_batch 里的 navigate 子动作） */
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

  /** 生成简短的参数摘要：过滤机器内部噪音，只保留高价值目标（URL、输入文本、查询词等） */
  private summarizeArgs(name: string, input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const obj = input as Record<string, unknown>;
    const clip = (v: string, n = 60) => (v.length > n ? v.slice(0, n - 1) + "…" : v);

    if (name === "navigate" || typeof obj.url === "string") {
      return typeof obj.url === "string" ? clip(obj.url) : "";
    }

    if (Array.isArray(obj.actions)) {
      const names = obj.actions
        .map((a) => (a && typeof a === "object" ? (a as { name?: unknown }).name : null))
        .filter((n): n is string => typeof n === "string");
      return names.length ? clip(names.join(" → ")) : `${obj.actions.length} 个动作`;
    }

    if (name === "javascript_tool") {
      const code = typeof obj.text === "string" ? obj.text : "";
      if (/fetch|axios|api|\/t\//i.test(code)) return "fetch";
      return "";
    }

    if (name === "read_page" || name === "get_page_text" || name === "submit_result") {
      return "";
    }

    if (name === "computer") {
      const action = typeof obj.action === "string" ? obj.action : "";
      if (action === "type" && typeof obj.text === "string") return `type text="${clip(obj.text, 24)}"`;
      if (action === "key" && typeof obj.text === "string") return `key text="${obj.text}"`;
      if (action) return action;
      return "";
    }

    if (name === "find" && typeof obj.query === "string") {
      return `query="${clip(obj.query, 24)}"`;
    }

    if (name === "form_input" && obj.value !== undefined) {
      return `value="${clip(String(obj.value), 24)}"`;
    }

    return "";
  }
}
