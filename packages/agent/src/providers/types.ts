import type { ToolDefinition, ToolResult } from "@agent-browser/protocol";

/**
 * 大模型供应商抽象层（Model Providers）。
 *
 * 核心架构思想：
 * Agent 会话主循环、工具执行器以及浏览器扩展侧完全保持模型中立（Provider-neutral）。
 * 具体的大模型适配器（如 Anthropic、OpenAI 兼容接口等）负责封装特定协议细节：
 * - 请求体和请求头的封装与网络传输；
 * - SSE 流式事件的解析与思考过程（Thinking/Reasoning）解包；
 * - 工具调用（Tool Call）与工具执行结果（含截图 Base64）向历史消息列表的编码转换；
 * - 历史上下文窗口的管理与防爆处理。
 */

/** 单个工具调用请求抽象 */
export interface ToolCall {
  /** 模型生成的唯一调用 ID */
  id: string;
  /** 被调用的工具名称 */
  name: string;
  /** 解析后的工具输入参数对象；若非合法 JSON 则保留原始字符串 */
  input: unknown;
  /** 参数解析失败时的错误提示（若解析失败则填充） */
  inputError?: string;
}

/** 单次大模型推断的回合结束原因 */
export type TurnStop =
  /** 模型给出了最终自然语言回答，当前用户任务回合完成 */
  | "end_turn"
  /** 模型发起了工具调用请求，等待工具执行结果返回 */
  | "tool_use"
  /** 达到生成 Token 上限，工具调用可能不完整，禁止执行 */
  | "max_tokens"
  /** 模型或内容安全策略拒绝回答 */
  | "refusal";

/** 单次回合生成的聚合结果 */
export interface TurnResult {
  /** 模型回复的自然语言文本 */
  text: string;
  /** 本次回合模型发起的所有工具调用请求 */
  toolCalls: ToolCall[];
  /** 结束状态标记 */
  stop: TurnStop;
  /** 拒绝或异常中断时的人类可读详细信息 */
  detail?: string;
}

/** 流式输出回调接口（向 UI 或调度器实时推送文本增量和思考过程） */
export interface TurnCallbacks {
  /** 文本增量回调 */
  onText(delta: string): void;
  /** 思考/推理链文本增量回调（例如 Claude 3.7 Thinking 或 DeepSeek-R1 推理） */
  onThinking(delta: string): void;
}

/** 单个工具调用的执行产物 */
export interface ToolOutcome {
  /** 触发调用的原请求 */
  call: ToolCall;
  /** 工具的实际执行结果（包含文本、图片块、错误标志） */
  result: ToolResult;
}

/**
 * 单个会话的历史上下文容器。
 * 针对各厂商特定的消息数据格式维护历史消息数组。
 */
export interface Conversation {
  /** 供应商原生的消息历史（用于检查、调试或测试） */
  readonly history: readonly unknown[];
  /** 添加用户文本消息到历史列表中 */
  addUserText(text: string): void;
  /** 发起一次大模型交互推断，并将助手回复写入历史 */
  runTurn(callbacks: TurnCallbacks, signal?: AbortSignal): Promise<TurnResult>;
  /** 将上一回合所有工具调用的执行结果顺序追加到历史列表中 */
  addToolResults(outcomes: ToolOutcome[]): void;
}

/** 结构化 JSON 生成请求（供小模型辅助工具如 find 快速提取结构化数据） */
export interface JsonRequest {
  system: string;
  prompt: string;
  /** 期望返回对象的 JSON Schema */
  schema: Record<string, unknown>;
  signal?: AbortSignal;
}

/** 大模型供应商通用接口契约 */
export interface ModelProvider {
  /** 供应商类型标识，如 "anthropic", "openai-compatible" */
  readonly kind: string;
  /** 使用的主力模型名称，如 "claude-3-7-sonnet-20250219" */
  readonly model: string;
  /** 创建一个绑定了系统提示词与工具集的新会话上下文 */
  createConversation(system: string, tools: readonly ToolDefinition[]): Conversation;
  /** 发起轻量低成本的结构化 JSON 补全请求（供 App 端的 find 工具做视觉/DOM 候选过滤） */
  completeJson(request: JsonRequest): Promise<string>;
  /** 将 SDK 或网络层捕获的底层异常转换为对用户友好的错误说明 */
  describeError(err: unknown): string;
}
