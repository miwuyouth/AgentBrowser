/**
 * @agent-browser/agent 统一导出入口
 *
 * 核心功能：
 * - `session.ts`: Agent 多回合会话主循环（驱动大模型、分发工具结果、状态机管理）；
 * - `executor.ts`: 工具执行器（派发 App 本地工具与 Chrome 扩展远端工具）；
 * - `find.ts`: App 侧实现的自然语言 DOM 元素语义检索；
 * - `prompt.ts`: 稳定字节级的 Agent 系统提示词定义；
 * - `providers/`: 大模型适配器（Anthropic 原生与兼容网关、OpenAI 兼容端点）。
 */

export * from "./executor.ts";
export * from "./find.ts";
export * from "./prompt.ts";
export * from "./providers/index.ts";
export * from "./session.ts";
