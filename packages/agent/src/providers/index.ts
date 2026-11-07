/**
 * 模型供应商工厂与统一导出。
 */

import { AnthropicProvider, type AnthropicProviderOptions } from "./anthropic.ts";
import { OpenAIProvider, type OpenAIProviderOptions } from "./openai.ts";
import type { ModelProvider } from "./types.ts";

export * from "./anthropic.ts";
export * from "./openai.ts";
export * from "./types.ts";

/** 可序列化的模型供应商配置对象（例如存储在 settings.json 中） */
export type ProviderConfig =
  | ({ kind: "anthropic" } & Omit<AnthropicProviderOptions, "client">)
  | ({ kind: "openai-compatible" } & Omit<OpenAIProviderOptions, "client">);

/** 根据配置项工厂化实例化对应的模型供应商（Anthropic 或 OpenAI-Compatible） */
export function createProvider(config: ProviderConfig): ModelProvider {
  switch (config.kind) {
    case "anthropic": {
      const { kind: _, ...opts } = config;
      return new AnthropicProvider(opts);
    }
    case "openai-compatible": {
      const { kind: _, ...opts } = config;
      return new OpenAIProvider(opts);
    }
  }
}
