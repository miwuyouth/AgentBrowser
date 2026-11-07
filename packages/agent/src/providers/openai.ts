/**
 * OpenAI 及 OpenAI 兼容接口（OpenAI-Compatible）适配器。
 *
 * 适用场景：
 * - OpenAI 官方接口（GPT-4o、o1、o3-mini 等）；
 * - 各类第三方云端服务与自建本地大模型服务（如 vLLM、Ollama、LocalAI、DeepSeek、Qwen 等）。
 *
 * 核心技术细节：
 * 1. 思考过程捕获：流式解析兼容 `reasoning_content` 与 `reasoning` 字段；
 * 2. 工具调用碎片聚合：处理流式分块传输中 function 名称与 arguments 参数碎片的拼装；
 * 3. 截图传输技巧：OpenAI 的 `role: "tool"` 消息仅支持文本内容。对于截图等视觉图片，
 *    适配器将其封装为带有 Base64 data URL 的图片块，紧跟在工具消息之后以 `role: "user"` 发送；
 * 4. 视觉能力降级：对于非视觉（text-only）模型，可配置 `vision: false` 自动跳过图片下发；
 * 5. 客户端历史图片修剪：防止连续操作截屏撑爆上下文窗口。
 */

import OpenAI from "openai";
import type {
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageFunctionToolCall,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type { ToolDefinition } from "@agent-browser/protocol";
import type { Conversation, JsonRequest, ModelProvider, ToolCall, ToolOutcome, TurnCallbacks, TurnResult } from "./types.ts";

/** OpenAI 兼容接口的配置选项 */
export interface OpenAIProviderOptions {
  client?: OpenAI;
  /** API 基础 URL，例如 https://api.openai.com/v1 或 http://127.0.0.1:11434/v1 */
  baseURL?: string;
  /** API 密钥（本地无鉴权服务可不填） */
  apiKey?: string;
  /** 主模型名称 */
  model: string;
  /** 专用于 find 页面元素匹配的小模型，未设置时默认复用主模型 */
  findModel?: string;
  /** 每回合最大输出 Token 数 */
  maxTokens?: number;
  /** 指定携带 maxTokens 的字段名（新版模型可能要求使用 max_completion_tokens） */
  maxTokensParam?: "max_tokens" | "max_completion_tokens";
  /** 是否向模型传递截图。如果是纯文本模型，请设为 false */
  vision?: boolean;
  /** 历史上下文中保留的最大截图数量，多余的会被替换为文本说明 */
  keepImages?: number;
  /** 辅助工具请求 JSON 时的格式控制模式 */
  jsonMode?: "json_schema" | "json_object" | "none";
  temperature?: number;
  /** 合并到每次 Chat 请求体中的额外自定义字段（用于特定供应商扩展参数） */
  extraBody?: Record<string, unknown>;
}

export class OpenAIProvider implements ModelProvider {
  readonly kind = "openai-compatible";
  readonly model: string;
  readonly client: OpenAI;
  readonly opts: Required<Pick<OpenAIProviderOptions, "vision" | "keepImages" | "jsonMode">> & OpenAIProviderOptions;

  constructor(opts: OpenAIProviderOptions) {
    this.opts = { vision: true, keepImages: 3, jsonMode: "json_object", ...opts };
    this.model = opts.model;
    this.client =
      opts.client ??
      new OpenAI({
        // SDK 强制校验 key，本地服务端无 key 时给一个占位字符串
        apiKey: opts.apiKey || process.env.OPENAI_API_KEY || "not-needed",
        ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
      });
  }

  createConversation(system: string, tools: readonly ToolDefinition[]): Conversation {
    return new OpenAIConversation(this, system, tools);
  }

  /** 获取请求公共参数 */
  common(): Record<string, unknown> {
    const o = this.opts;
    return {
      ...(o.maxTokens ? { [o.maxTokensParam ?? "max_tokens"]: o.maxTokens } : {}),
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...o.extraBody,
    };
  }

  /** 发起低成本结构化 JSON 补全请求（供 find 元素筛选使用） */
  async completeJson(req: JsonRequest): Promise<string> {
    const mode = this.opts.jsonMode;
    const system =
      mode === "json_schema"
        ? req.system
        : `${req.system}\n\nRespond with only a JSON object matching this JSON Schema, no other text:\n${JSON.stringify(req.schema)}`;
    const responseFormat =
      mode === "json_schema"
        ? { response_format: { type: "json_schema", json_schema: { name: "result", schema: req.schema, strict: true } } }
        : mode === "json_object"
          ? { response_format: { type: "json_object" } }
          : {};
    const response = await this.client.chat.completions.create(
      {
        model: this.opts.findModel ?? this.model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: req.prompt },
        ],
        ...this.common(),
        ...responseFormat,
      } as never,
      req.signal ? { signal: req.signal } : {},
    );
    const choice = (response as OpenAI.Chat.Completions.ChatCompletion).choices[0];
    if (choice?.finish_reason === "content_filter") throw new Error("The element search was declined by a content filter.");
    return extractJson(choice?.message.content ?? "");
  }

  /** 将常见的网络与 API 错误转换为人类可读的提示说明 */
  describeError(err: unknown): string {
    if (err instanceof OpenAI.AuthenticationError) return "Authentication failed: check the API key for the OpenAI-compatible endpoint.";
    if (err instanceof OpenAI.NotFoundError) return `Not found (404): check the base URL and the model name "${this.model}".`;
    if (err instanceof OpenAI.RateLimitError) return "Rate limited by the endpoint; try again shortly.";
    if (err instanceof OpenAI.APIConnectionError) return `Cannot reach the endpoint${this.opts.baseURL ? ` at ${this.opts.baseURL}` : ""}: ${err.message}`;
    if (err instanceof OpenAI.APIError) return `API error ${err.status ?? ""}: ${err.message}`;
    return err instanceof Error ? err.message : String(err);
  }
}

/** 从模型可能夹杂代码块标记（Markdown ```json 等）的文本中提取合法 JSON 字符串 */
function extractJson(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = (fenced ? fenced[1]! : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  return start >= 0 && end > start ? body.slice(start, end + 1) : body;
}

/** 流式分块解析中的暂存工具调用 */
interface PendingCall {
  id: string;
  name: string;
  args: string;
}

/** 维护符合 OpenAI Chat Completions 规范的会话历史 */
class OpenAIConversation implements Conversation {
  private readonly messages: ChatCompletionMessageParam[];
  private readonly tools: ChatCompletionTool[];

  constructor(
    private readonly provider: OpenAIProvider,
    system: string,
    defs: readonly ToolDefinition[],
  ) {
    this.messages = [{ role: "system", content: system }];
    this.tools = defs.map((d) => ({
      type: "function",
      function: { name: d.name, description: d.description, parameters: d.input_schema as unknown as Record<string, unknown> },
    }));
  }

  get history(): readonly ChatCompletionMessageParam[] {
    return this.messages;
  }

  addUserText(text: string) {
    this.messages.push({ role: "user", content: text });
  }

  /** 运行一个回合的大模型交互（流式接收文本、推理链、工具调用） */
  async runTurn(cb: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult> {
    const body = {
      model: this.provider.model,
      messages: this.messages,
      tools: this.tools,
      tool_choice: "auto",
      stream: true,
      ...this.provider.common(),
    } as ChatCompletionCreateParamsStreaming;
    const stream = await this.provider.client.chat.completions.create(body, signal ? { signal } : {});

    let text = "";
    let refusal = "";
    let finish: string | null = null;
    const pending = new Map<number, PendingCall>();
    for await (const chunk of stream) {
      const choice = chunk.choices?.[0];
      if (!choice) continue;
      const delta = (choice.delta ?? {}) as Record<string, any>;
      if (typeof delta.content === "string" && delta.content) {
        text += delta.content;
        cb.onText(delta.content);
      }
      // 提取思考/推理链文本（兼容不同服务端使用的 reasoning_content 或 reasoning 字段）
      const reasoning = delta.reasoning_content ?? delta.reasoning;
      if (typeof reasoning === "string" && reasoning) cb.onThinking(reasoning);
      if (typeof delta.refusal === "string") refusal += delta.refusal;
      // 拼接流式分片传来的 tool_calls 参数
      for (const tc of (delta.tool_calls ?? []) as any[]) {
        const index = typeof tc.index === "number" ? tc.index : pending.size;
        const cur = pending.get(index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        const name: string | undefined = tc.function?.name;
        // 多数服务仅发一次函数名，少数兼容服务每 chunk 重复发送，做去重保护
        if (name) cur.name = !cur.name || name === cur.name ? name : cur.name + name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        pending.set(index, cur);
      }
      if (choice.finish_reason) finish = choice.finish_reason;
    }

    const calls = [...pending.entries()]
      .sort(([a], [b]) => a - b)
      .map(([index, c]) => ({ ...c, id: c.id || `call_${index}_${Date.now().toString(36)}` }))
      .filter((c) => c.name);

    if (refusal || finish === "content_filter") {
      this.messages.push({ role: "assistant", content: text || refusal || "" });
      return { text, toolCalls: [], stop: "refusal", detail: refusal || "Blocked by the endpoint's content filter." };
    }
    if (finish === "length") {
      // 超出最大 Token 上限，工具调用参数可能残缺截断，不能执行
      this.messages.push({ role: "assistant", content: text });
      return { text, toolCalls: [], stop: "max_tokens", ...(calls.length ? { detail: "The response hit the output limit in the middle of a tool call." } : {}) };
    }

    const toolCalls: ToolCall[] = calls.map((c) => {
      try {
        return { id: c.id, name: c.name, input: c.args.trim() ? JSON.parse(c.args) : {} };
      } catch {
        return { id: c.id, name: c.name, input: c.args, inputError: "The tool arguments were not valid JSON." };
      }
    });
    const assistant: ChatCompletionMessageParam = { role: "assistant", content: text };
    if (calls.length) {
      assistant.tool_calls = calls.map(
        (c): ChatCompletionMessageFunctionToolCall => ({ id: c.id, type: "function", function: { name: c.name, arguments: c.args || "{}" } }),
      );
    }
    this.messages.push(assistant);
    return { text, toolCalls, stop: toolCalls.length ? "tool_use" : "end_turn" };
  }

  /**
   * 将工具结果回填到消息历史：
   * 1. 纯文本结果放入 role: "tool" 消息中；
   * 2. 因为 Chat Completions 协议原生工具消息只接受字符串，
   *    所有的截图等图片作为单独的 role: "user" 消息紧随其后附带，并标明所属工具。
   */
  addToolResults(outcomes: ToolOutcome[]) {
    const images: ChatCompletionContentPart[] = [];
    const labels: string[] = [];
    for (const { call, result } of outcomes) {
      let content = result.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      const shots = result.content.filter((b) => b.type === "image");
      if (shots.length) {
        if (this.provider.opts.vision) {
          for (const s of shots) {
            if (s.type !== "image") continue;
            labels.push(`${labels.length + 1}: ${call.name} (${call.id})`);
            images.push({ type: "image_url", image_url: { url: `data:${s.source.media_type};base64,${s.source.data}` } });
          }
          content += `\n[${shots.length} screenshot(s) attached in the next message]`;
        } else {
          content += `\n[${shots.length} screenshot(s) omitted: this model cannot see images. Use read_page, find or get_page_text instead.]`;
        }
      }
      this.messages.push({ role: "tool", tool_call_id: call.id, content: (result.isError ? "Error: " : "") + (content || "ok") });
    }
    if (images.length) {
      this.messages.push({ role: "user", content: [{ type: "text", text: `Screenshots from the tool calls above, in order (${labels.join("; ")}).` }, ...images] });
      this.pruneImages();
    }
  }

  /**
   * 客户端本地批量修剪历史截图，仅保留最新的图片，避免上下文超长，并保护服务端 Prefix Cache。
   */
  private pruneImages() {
    const keep = this.provider.opts.keepImages;
    const slots: { parts: ChatCompletionContentPart[]; index: number }[] = [];
    for (const m of this.messages) {
      if (m.role !== "user" || !Array.isArray(m.content)) continue;
      const parts = m.content as ChatCompletionContentPart[];
      parts.forEach((p, index) => p.type === "image_url" && slots.push({ parts, index }));
    }
    if (slots.length < keep * 2) return;
    for (const s of slots.slice(0, slots.length - keep)) {
      s.parts[s.index] = { type: "text", text: "[earlier screenshot removed to save context]" };
    }
  }
}
