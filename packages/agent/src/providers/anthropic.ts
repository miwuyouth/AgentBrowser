/**
 * Anthropic 官方及兼容网关适配器。
 *
 * 核心特性支持：
 * - Messages API 与 Beta Messages API 适配；
 * - 深度思考（Thinking / Adaptive Thinking）流式解析；
 * - 服务端上下文管理（Context Editing / clear_tool_uses）；
 * - 客户端历史截图自动修剪（降级防爆上下文窗口）；
 * - 提示词缓存（Prompt Caching / cache_control: ephemeral）；
 * - 工具入参提前流式解析（Eager Input Streaming）与 JSON 重试；
 * - 结构化输出支持（Structured Output 用于页面元素定位 find 工具）。
 */

import Anthropic from "@anthropic-ai/sdk";
import type { BetaMessageStream } from "@anthropic-ai/sdk/lib/BetaMessageStream";
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageParam,
  BetaTool,
  BetaToolResultBlockParam,
  BetaToolUseBlock,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ToolDefinition } from "@agent-browser/protocol";
import type { Conversation, JsonRequest, ModelProvider, ToolOutcome, TurnCallbacks, TurnResult } from "./types.ts";

/** 模型思考/推理力度等级 */
export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

/** 默认主力操作模型与轻量查找模型 */
export const DEFAULT_MODEL = "claude-opus-5-5";
export const DEFAULT_FIND_MODEL = "claude-haiku-5-5";

/** Anthropic 实验性/高级 API 特性开关配置（非官方 Gateway 可能会缺失部分能力） */
export interface AnthropicFeatures {
  /** 服务端自动清理旧工具执行历史（如旧截图）。若关闭，则由客户端本地修剪 */
  contextEditing: boolean;
  /** 服务端在模型拒绝回答时自动回退降级到备选模型 */
  fallbacks: boolean;
  /** 自适应思考模式（adaptive thinking） */
  adaptiveThinking: boolean;
  /** 推理力度控制（output_config.effort） */
  effort: boolean;
  /** 工具参数边生成边流式反序列化（eager_input_streaming） */
  eagerInputStreaming: boolean;
  /** 自动提示词缓存控制（cache_control） */
  promptCaching: boolean;
  /** find 工具使用的 JSON Schema 结构化输出 */
  structuredOutput: boolean;
}

/** 官方接口默认全部开启的高级功能 */
const ALL_ON: AnthropicFeatures = {
  contextEditing: true,
  fallbacks: true,
  adaptiveThinking: true,
  effort: true,
  eagerInputStreaming: true,
  promptCaching: true,
  structuredOutput: true,
};

/** 第三方网关/兼容服务默认全关闭，避免因未实现扩展协议报错 */
const ALL_OFF: AnthropicFeatures = Object.fromEntries(Object.keys(ALL_ON).map((k) => [k, false])) as unknown as AnthropicFeatures;

export interface AnthropicProviderOptions {
  client?: Anthropic;
  apiKey?: string;
  /** 自定义 API 接入点（网关或兼容服务），若提供则默认关闭所有实验性 Beta 特性 */
  baseURL?: string;
  model?: string;
  findModel?: string;
  effort?: Effort;
  maxTokens?: number;
  features?: Partial<AnthropicFeatures>;
  /** 客户端本地修剪时保留的历史截图数量（contextEditing 关闭时生效） */
  keepImages?: number;
}

const isToolUse = (b: BetaContentBlock): b is BetaToolUseBlock => b.type === "tool_use";

export class AnthropicProvider implements ModelProvider {
  readonly kind: string;
  readonly model: string;
  readonly client: Anthropic;
  readonly features: AnthropicFeatures;
  private readonly findModel: string;
  private readonly effort: Effort;
  private readonly maxTokens: number;
  private readonly keepImages: number;

  constructor(opts: AnthropicProviderOptions = {}) {
    this.client =
      opts.client ??
      new Anthropic({ ...(opts.apiKey ? { apiKey: opts.apiKey } : {}), ...(opts.baseURL ? { baseURL: opts.baseURL } : {}) });
    this.kind = opts.baseURL ? "anthropic-compatible" : "anthropic";
    this.features = { ...(opts.baseURL ? ALL_OFF : ALL_ON), ...opts.features };
    this.model = opts.model ?? DEFAULT_MODEL;
    this.findModel = opts.findModel ?? (opts.baseURL ? this.model : DEFAULT_FIND_MODEL);
    this.effort = opts.effort ?? "high";
    this.maxTokens = opts.maxTokens ?? (this.features.adaptiveThinking ? 64_000 : 16_000);
    this.keepImages = opts.keepImages ?? 4;
  }

  createConversation(system: string, tools: readonly ToolDefinition[]): Conversation {
    return new AnthropicConversation(this, system, tools);
  }

  /** 构建单回合推断的 API 请求参数对象 */
  turnParams(system: string, tools: BetaTool[], messages: BetaMessageParam[]) {
    const f = this.features;
    const betas: string[] = [];
    const params: Record<string, unknown> = { model: this.model, max_tokens: this.maxTokens, system, tools, messages };
    if (f.adaptiveThinking) params.thinking = { type: "adaptive", display: "summarized" };
    if (f.effort) params.output_config = { effort: this.effort };
    if (f.promptCaching) params.cache_control = { type: "ephemeral" };
    if (f.contextEditing) {
      // 服务端自动清理过期的旧工具执行结果（尤其是占用庞大的截图 Base64），
      // 既保持了思维链思考块有效，又保持了 Prompt 缓存命中热度
      betas.push("context-management-2025-06-27");
      params.context_management = {
        edits: [
          {
            type: "clear_tool_uses_20250919",
            trigger: { type: "input_tokens", value: 150_000 },
            keep: { type: "tool_uses", value: 8 },
            clear_at_least: { type: "input_tokens", value: 40_000 },
          },
        ],
      };
    }
    if (f.fallbacks) {
      betas.push("server-side-fallback-2026-07-01");
      params.fallbacks = "default";
    }
    if (betas.length) params.betas = betas;
    return { params, beta: betas.length > 0 };
  }

  get keep() {
    return this.keepImages;
  }

  /** 执行结构化 JSON 请求（供 find 元素快速筛选使用） */
  async completeJson(req: JsonRequest): Promise<string> {
    const f = this.features;
    const system = f.structuredOutput
      ? req.system
      : `${req.system}\n\nRespond with only a JSON object matching this JSON Schema, no other text:\n${JSON.stringify(req.schema)}`;
    const outputConfig: Record<string, unknown> = {};
    if (f.effort) outputConfig.effort = "low";
    if (f.structuredOutput) outputConfig.format = { type: "json_schema", schema: req.schema };
    const response = await this.client.messages.create(
      {
        model: this.findModel,
        max_tokens: 4000,
        system,
        messages: [{ role: "user", content: req.prompt }],
        ...(Object.keys(outputConfig).length ? { output_config: outputConfig as never } : {}),
      },
      req.signal ? { signal: req.signal } : {},
    );
    if (response.stop_reason === "refusal") throw new Error("The element search was declined.");
    const block = response.content.find((b) => b.type === "text");
    return block?.type === "text" ? block.text : "";
  }

  /** 将 Anthropic SDK 的各种网络和身份验证错误转化为易读文本 */
  describeError(err: unknown): string {
    if (err instanceof Anthropic.AuthenticationError) return "Authentication failed: check the Anthropic API key.";
    if (err instanceof Anthropic.RateLimitError) return "Rate limited by the API; try again shortly.";
    if (err instanceof Anthropic.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }
}

/** Anthropic 专用会话实现，维护符合 Anthropic Messages 格式的消息数组 */
class AnthropicConversation implements Conversation {
  private readonly messages: BetaMessageParam[] = [];
  private readonly tools: BetaTool[];

  constructor(
    private readonly provider: AnthropicProvider,
    private readonly system: string,
    defs: readonly ToolDefinition[],
  ) {
    this.tools = defs.map((d) => ({
      name: d.name,
      description: d.description,
      input_schema: d.input_schema as BetaTool["input_schema"],
      ...(provider.features.eagerInputStreaming ? { eager_input_streaming: true } : {}),
    }));
  }

  get history(): readonly BetaMessageParam[] {
    return this.messages;
  }

  /**
   * 追加用户文本消息：
   * 若上一回合用户中断，末尾可能留有未回复的用户消息，此时合并到末尾文本块中，
   * 确保用户消息与助手消息严格交替，保证 API 历史规范有效。
   */
  addUserText(text: string) {
    const last = this.messages.at(-1);
    if (last?.role !== "user") {
      this.messages.push({ role: "user", content: text });
      return;
    }
    const blocks = typeof last.content === "string" ? [{ type: "text" as const, text: last.content }] : last.content;
    last.content = [...blocks, { type: "text", text }];
  }

  /** 发起一次大模型交互推断回合 */
  async runTurn(cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    const client = this.provider.client;
    let jsonRetries = 0;
    for (;;) {
      const { params, beta } = this.provider.turnParams(this.system, this.tools, this.messages);
      let message: BetaMessage;
      try {
        const opts = signal ? { signal } : {};
        // 若无 beta 特性使用标准 messages 端点，避免某些代理服务不支持 beta 路由
        const stream = (beta ? client.beta.messages.stream(params as never, opts) : client.messages.stream(params as never, opts)) as unknown as BetaMessageStream;
        stream.on("text", (delta) => cb.onText(delta));
        stream.on("thinking", (delta) => cb.onThinking(delta));
        message = await stream.finalMessage();
      } catch (err) {
        // 在开启了 eager input streaming 模式下，畸变未完成的参数可能触发非 API 异常，最多重试 2 次
        if (!signal?.aborted && !(err instanceof Anthropic.APIError) && this.provider.features.eagerInputStreaming && jsonRetries++ < 2) continue;
        throw err;
      }

      const text = message.content.map((b) => (b.type === "text" ? b.text : "")).join("");
      const toolUses = message.content.filter(isToolUse);
      if (message.stop_reason === "pause_turn") {
        this.messages.push({ role: "assistant", content: message.content });
        continue;
      }
      if (message.stop_reason === "refusal") {
        this.messages.push({ role: "assistant", content: message.content });
        return { text, toolCalls: [], stop: "refusal", ...(message.stop_details?.explanation ? { detail: message.stop_details.explanation } : {}) };
      }
      if (message.stop_reason === "max_tokens" && toolUses.length > 0) {
        // 在超长截断（max_tokens）时切断的工具调用可能变成残缺的部分 JSON，绝对不能执行残缺动作
        return { text, toolCalls: [], stop: "max_tokens", detail: "The response hit max_tokens in the middle of a tool call." };
      }
      this.messages.push({ role: "assistant", content: message.content });
      return {
        text,
        toolCalls: toolUses.map((u) => ({ id: u.id, name: u.name, input: u.input })),
        stop: toolUses.length ? "tool_use" : message.stop_reason === "max_tokens" ? "max_tokens" : "end_turn",
      };
    }
  }

  /** 将工具执行结果以单个 user 消息回传给大模型 */
  addToolResults(outcomes: ToolOutcome[]) {
    const content: BetaToolResultBlockParam[] = outcomes.map(({ call, result }) => ({
      type: "tool_result",
      tool_use_id: call.id,
      content: result.content.length ? result.content : [{ type: "text", text: "ok" }],
      ...(result.isError ? { is_error: true } : {}),
    }));
    // 所有工具结果聚合放入一条 user 消息中
    this.messages.push({ role: "user", content });
    if (!this.provider.features.contextEditing) this.pruneImages();
  }

  /**
   * 客户端本地修剪历史截图：
   * 在未开启服务端 contextEditing 时，防止大量历史截屏图片撑爆大模型的上下文窗口。
   * 采用批处理修剪方式（图片总数达到限制的 2 倍时才修剪），降低对 Prompt Cache 前缀的影响。
   */
  private pruneImages() {
    const keep = this.provider.keep;
    const slots: { blocks: unknown[]; index: number }[] = [];
    for (const m of this.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type !== "tool_result" || !Array.isArray(block.content)) continue;
        block.content.forEach((b, index) => b.type === "image" && slots.push({ blocks: block.content as unknown[], index }));
      }
    }
    if (slots.length < keep * 2) return;
    for (const s of slots.slice(0, slots.length - keep)) s.blocks[s.index] = { type: "text", text: "[earlier screenshot removed to save context]" };
  }
}
