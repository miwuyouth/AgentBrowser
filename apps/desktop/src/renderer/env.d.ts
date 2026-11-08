import type { AgentApi } from "../shared.ts";

/**
 * 渲染进程全局 Window 类型声明扩展。
 */
declare global {
  interface Window {
    /**
     * 由 preload.ts 在沙箱预加载阶段通过 contextBridge.exposeInMainWorld 注入的客户端 API 代理。
     * 前端各组件和 Hook 通过 window.agentApi 与 Electron 主进程进行受保护的 IPC 通信。
     */
    agentApi: AgentApi;
  }
}
