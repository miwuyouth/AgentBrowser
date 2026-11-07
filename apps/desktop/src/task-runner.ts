import type { AgentSession } from "@agent-browser/agent";
import type { BrowserSession } from "@agent-browser/bridge";
import { loadRuns, loadTasks, resolveKernelAndProfile, saveRuns, saveTasks } from "./storage.ts";
import type { AppState, RunRecord, RunStep, TaskItem, UiEvent } from "./shared.ts";

export class TaskRunner {
  private activeRun: RunRecord | null = null;
  private currentAbortController: AbortController | null = null;
  private timer: NodeJS.Timeout | null = null;
  private startTime = 0;

  constructor(
    private emitEvent: (event: UiEvent) => void,
    private getAppState: () => AppState,
    private getOrStartBrowser: (kernelId: string, profileId: string, initialUrl?: string) => Promise<BrowserSession>,
    private closeBrowser: () => Promise<void>,
    private createAgent: (browser: BrowserSession) => AgentSession,
  ) {}

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

    const { kernel, profile } = resolveKernelAndProfile(
      task.kernelId || task.kernel,
      task.profileId || task.profile,
    );

    task.kernelId = kernel.id;
    task.kernel = kernel.name;
    task.profileId = profile.id;
    task.profile = profile.name;
    task.lastStatus = "run";
    task.lastRunTime = "刚刚开始";
    task.lastDuration = "进行中";
    saveTasks(tasks);

    const runId = Math.floor(1000 + Math.random() * 9000).toString();
    this.startTime = Date.now();
    this.currentAbortController = new AbortController();

    const initialStep: RunStep = {
      stepNumber: 1,
      status: "run",
      tag: "启动",
      text: `启动「${kernel.name}」，加载对应 Profile「${profile.name}」`,
      meta: "进行中",
      think: `开始执行任务：${task.name}。目标：${task.goal}。`,
    };

    this.activeRun = {
      id: runId,
      taskId: task.id,
      name: task.name,
      status: "run",
      when: "刚刚",
      startTime: this.startTime,
      trigger: triggerKind,
      facts: [
        { k: "步数", v: "1" },
        { k: "用时", v: "00:01" },
        { k: "内核", v: kernel.name },
        { k: "Profile", v: profile.name },
      ],
      summary: `正在执行任务：${task.goal}`,
      steps: [initialStep],
    };

    this.emitEvent({ type: "run_update", run: this.activeRun });
    this.emitEvent({ type: "state", state: this.getAppState() });

    this.timer = setInterval(() => {
      if (!this.activeRun) return;
      const elapsedSec = Math.floor((Date.now() - this.startTime) / 1000);
      const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
      const ss = String(elapsedSec % 60).padStart(2, "0");
      const timeStr = `${mm}:${ss}`;

      const fact = this.activeRun.facts.find((f) => f.k === "用时");
      if (fact) fact.v = timeStr;

      const lastStep = this.activeRun.steps[this.activeRun.steps.length - 1];
      if (lastStep && lastStep.status === "run") {
        lastStep.meta = `${timeStr} · 进行中`;
      }

      this.emitEvent({ type: "run_update", run: this.activeRun });
    }, 1000);

    try {
      // 1. 拉起或连接任务指定的浏览器内核及对应 Profile
      const browserSession = await this.getOrStartBrowser(kernel.id, profile.id, task.url);

      // 2. 检查模型配置并实例化 Agent
      const agentSession = this.createAgent(browserSession);

      // 3. 运行真实 Agent 循环
      await this.executeRealAgent(task, agentSession);

      this.finishTask(task, "ok");
    } catch (err) {
      const isCancelled = this.currentAbortController?.signal.aborted;
      const errMsg = isCancelled ? "用户主动终止任务" : err instanceof Error ? err.message : String(err);
      this.failTask(task, errMsg, isCancelled ? "已中止" : "请检查模型 API Key、浏览器内核连接或任务目标描述后重试。");
    } finally {
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
      this.activeRun = null;
      this.currentAbortController = null;
      if (task.autoClose) {
        await this.closeBrowser().catch(() => {});
      }
      this.emitEvent({ type: "state", state: this.getAppState() });
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

    let stepCount = 1;
    let accumulatedText = "";

    const prompt = [
      `任务目标：${task.goal}`,
      task.url ? `起始网址：${task.url}` : "",
      task.doneCondition ? `完成判定条件：${task.doneCondition}` : "",
      task.resultFormat ? `结果格式要求：${task.resultFormat}` : "",
    ]
      .filter(Boolean)
      .join("\n");

    await agent.send(
      prompt,
      (event) => {
        if (!this.activeRun) return;

        if (event.type === "thinking_delta") {
          const curStep = this.activeRun.steps[this.activeRun.steps.length - 1];
          if (curStep) {
            curStep.think = (curStep.think || "") + event.text;
            this.emitEvent({ type: "run_update", run: this.activeRun });
          }
        } else if (event.type === "text_delta") {
          accumulatedText += event.text;
          this.activeRun.summary = accumulatedText;
          this.emitEvent({ type: "run_update", run: this.activeRun });
        } else if (event.type === "tool_call") {
          stepCount++;
          const tag = this.resolveToolTag(event.name);
          const newStep: RunStep = {
            stepNumber: stepCount,
            status: "run",
            tag,
            text: `调用 ${event.name}：${this.summarizeArgs(event.input)}`,
            meta: "进行中",
          };
          this.activeRun.steps.push(newStep);
          this.updateFact("步数", String(stepCount));
          this.emitEvent({ type: "run_step", step: newStep, runId: this.activeRun.id });
          this.emitEvent({ type: "run_update", run: this.activeRun });
        } else if (event.type === "tool_result") {
          const lastStep = this.activeRun.steps[this.activeRun.steps.length - 1];
          if (lastStep) {
            lastStep.status = event.result.isError ? "todo" : "done";
            lastStep.meta = `用时 ${event.durationMs}ms`;
            for (const item of event.result.content) {
              if (item.type === "image") {
                const b64 = `data:${item.source.media_type};base64,${item.source.data}`;
                lastStep.screenshot = b64;
                this.emitEvent({ type: "run_screenshot", screenshot: b64, runId: this.activeRun.id });
              }
            }
            this.emitEvent({ type: "run_update", run: this.activeRun });
          }
        }
      },
      this.currentAbortController?.signal,
    );
  }

  private finishTask(task: TaskItem, status: "ok" | "fail") {
    if (!this.activeRun) return;

    this.activeRun.status = status;
    this.activeRun.endTime = Date.now();
    const elapsedSec = Math.floor((this.activeRun.endTime - this.startTime) / 1000);
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const ss = String(elapsedSec % 60).padStart(2, "0");
    const durationStr = `${mm}:${ss}`;

    this.updateFact("用时", durationStr);
    this.updateFact("步数", String(this.activeRun.steps.length));

    const runs = loadRuns();
    runs.unshift(this.activeRun);
    saveRuns(runs);

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

  private updateFact(key: string, value: string) {
    if (!this.activeRun) return;
    const f = this.activeRun.facts.find((fact) => fact.k === key);
    if (f) f.v = value;
  }

  private resolveToolTag(name: string): string {
    switch (name) {
      case "navigate":
        return "导航";
      case "computer":
        return "动作";
      case "read_page":
        return "观察";
      case "get_page_text":
      case "find":
        return "提取";
      case "browser_batch":
        return "批量";
      default:
        return "动作";
    }
  }

  private summarizeArgs(input: unknown): string {
    if (!input || typeof input !== "object") return "";
    const str = JSON.stringify(input);
    return str.length > 80 ? str.slice(0, 77) + "…" : str;
  }
}
