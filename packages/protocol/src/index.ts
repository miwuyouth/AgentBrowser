/**
 * @agent-browser/protocol 统一导出入口
 *
 * 协议层定义了系统内所有角色（App、Extension、Bridge、LLM）通信的标准数据格式：
 * - `blocks.ts`: 内容块（文本、图片等）与工具执行结果定义；
 * - `messages.ts`: WebSocket 双向通信协议消息（请求、响应、心跳、握手等）；
 * - `tools.ts`: 浏览器自动化工具清单与 JSON Schema；
 * - `validate.ts`: 工具入参 JSON Schema 校验器。
 */

export * from "./blocks.ts";
export * from "./messages.ts";
export * from "./tools.ts";
export * from "./validate.ts";
