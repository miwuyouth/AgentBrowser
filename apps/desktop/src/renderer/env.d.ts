import type { AgentApi } from "../shared.ts";

declare global {
  interface Window {
    /** 由 preload.ts 通过 contextBridge 注入 */
    agentApi: AgentApi;
  }
}
