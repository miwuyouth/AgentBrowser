/**
 * 浏览器 Agent 多回合主会话（AgentSession）。
 *
 * 核心架构设计：
 * 本类完全保持模型中立（Provider-neutral）：
 * - 模型协议细节由 `ModelProvider` / `Conversation` 负责；
 * - 工具派发与执行由 `BrowserToolExecutor` 负责；
 * - 本类全权掌控“感知 - 思考 - 决策行动 - 校验”的 Agent 核心循环（Agent Loop）。
 */

import type { BrowserBridge } from "@agent-browser/bridge";
import { MODEL_TOOLS, errorResult, type ToolResult } from "@agent-browser/protocol";
import { BrowserToolExecutor, type ExecutorOptions } from "./executor.ts";
import { SYSTEM_PROMPT } from "./prompt.ts";
import { AnthropicProvider, type AnthropicProviderOptions } from "./providers/anthropic.ts";
import type { Conversation, ModelProvider, ToolCall, ToolOutcome } from "./providers/types.ts";

/** Agent 会话创建选项 */
export interface AgentOptions {
  bridge: BrowserBridge;
  /** 大模型供应商实例；未指定时默认使用下方 Anthropic 快捷参数创建 */
  provider?: ModelProvider;
  client?: AnthropicProviderOptions["client"];
  model?: string;
  findModel?: string;
  effort?: AnthropicProviderOptions["effort"];
  maxTokens?: number;
  /** 单次回合最大循环步数安全上限（防止死循环，默认 150 步） */
  maxSteps?: number;
  /** 追加到内置系统提示词末尾的自定义指令 */
  instructions?: string;
  allowFile?: ExecutorOptions["allowFile"];
}

/** 会话运行过程中对外派发的事件流 */
export type AgentEvent =
  /** 模型生成的正文文本增量（打字机流式输出） */
  | { type: "text_delta"; text: string }
  /** 模型推理/思维链增量（Thinking 流式输出） */
  | { type: "thinking_delta"; text: string }
  /** 本次回合模型回复完成（包含正文和发起的工具调用清单） */
  | { type: "assistant_turn"; text: string; toolCalls: ToolCall[] }
  /** 即将执行某工具调用 */
  | { type: "tool_call"; id: string; name: string; input: unknown }
  /** 工具调用执行完毕返回结果 */
  | { type: "tool_result"; id: string; name: string; result: ToolResult; durationMs: number }
  /** 本次任务结束（正常结束、步数超限、用户取消、模型拒绝、Token 超限、异常错误） */
  | { type: "done"; reason: "end_turn" | "max_steps" | "cancelled" | "refusal" | "max_tokens" | "error"; message?: string };

/**
 * 浏览器 Agent 核心会话类
 */
export class AgentSession {
  readonly provider: ModelProvider;
  private readonly conversation: Conversation;
  private readonly executor: BrowserToolExecutor;
  private readonly maxSteps: number;
  private running = false;

  constructor(opts: AgentOptions) {
    this.provider =
      opts.provider ??
      new AnthropicProvider({
        ...(opts.client ? { client: opts.client } : {}),
        ...(opts.model ? { model: opts.model } : {}),
        ...(opts.findModel ? { findModel: opts.findModel } : {}),
        ...(opts.effort ? { effort: opts.effort } : {}),
        ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
      });
    this.maxSteps = opts.maxSteps ?? 150;
    const system = opts.instructions ? `${SYSTEM_PROMPT}\n\nAdditional instructions\n${opts.instructions}` : SYSTEM_PROMPT;
    this.conversation = this.provider.createConversation(system, MODEL_TOOLS);
    this.executor = new BrowserToolExecutor({
      bridge: opts.bridge,
      completeJson: (req) => this.provider.completeJson(req),
      ...(opts.allowFile ? { allowFile: opts.allowFile } : {}),
    });
  }

  /** 获取供应商原生的消息历史记录 */
  get messages(): readonly unknown[] {
    return this.conversation.history;
  }

  /** 当前会话是否正在运行中 */
  get busy() {
    return this.running;
  }

  /** 发送一条用户消息并驱动 Agent 自主循环执行，直到最终回答或中断 */
  async send(userText: string, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<void> {
    if (this.running) throw new Error("The agent is already running.");
    this.running = true;
    try {
      this.conversation.addUserText(userText);
      await this.loop(onEvent, signal);
    } finally {
      this.running = false;
    }
  }

  /**
   * Agent 核心循环：
   * 大模型推断 -> 解析工具调用 -> 执行工具 -> 工具结果写入历史 -> 继续推断
   */
  private async loop(onEvent: (e: AgentEvent) => void, signal?: AbortSignal) {
    const callbacks = {
      onText: (text: string) => onEvent({ type: "text_delta", text }),
      onThinking: (text: string) => onEvent({ type: "thinking_delta", text }),
    };
    for (let step = 0; step < this.maxSteps; step++) {
      if (signal?.aborted) return onEvent({ type: "done", reason: "cancelled" });

      let turn;
      try {
        turn = await this.conversation.runTurn(callbacks, signal);
      } catch (err) {
        if (signal?.aborted) return onEvent({ type: "done", reason: "cancelled" });
        return onEvent({ type: "done", reason: "error", message: this.provider.describeError(err) });
      }
      onEvent({ type: "assistant_turn", text: turn.text, toolCalls: turn.toolCalls });

      if (turn.stop === "refusal" || turn.stop === "max_tokens") {
        return onEvent({ type: "done", reason: turn.stop, ...(turn.detail ? { message: turn.detail } : {}) });
      }
      // 如果模型没有发起任何工具调用，说明给出了最终回答，任务正常结束
      if (turn.toolCalls.length === 0) return onEvent({ type: "done", reason: "end_turn" });

      // 浏览器动作具有强状态依赖性（如先点击展开菜单，再点击子选项），必须严格按顺序串行执行
      const outcomes: ToolOutcome[] = [];
      for (const call of turn.toolCalls) {
        if (signal?.aborted) {
          outcomes.push({ call, result: errorResult("Cancelled by the user.", "cancelled") });
          continue;
        }
        onEvent({ type: "tool_call", id: call.id, name: call.name, input: call.input });
        const started = Date.now();
        const result = call.inputError
          ? errorResult(`${call.inputError} Retry the call with valid JSON arguments.`, "input_invalid")
          : await this.executor.execute(call.name, call.input, signal);
        onEvent({ type: "tool_result", id: call.id, name: call.name, result, durationMs: Date.now() - started });
        outcomes.push({ call, result });
      }
      // 每个发起的工具调用都必须有对应结果填充，即使被用户取消也要填充 cancelled 错误，确保上下文消息完整有效
      this.conversation.addToolResults(outcomes);
      if (signal?.aborted) return onEvent({ type: "done", reason: "cancelled" });
    }
    onEvent({ type: "done", reason: "max_steps", message: `Stopped after ${this.maxSteps} steps.` });
  }
}
