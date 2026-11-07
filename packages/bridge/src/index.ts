/**
 * @agent-browser/bridge 统一导出入口
 *
 * 桥接层负责宿主应用（Desktop/Node）与 Chrome 浏览器之间的生命周期管理和通信：
 * - `browser-path.ts`: 探测系统已安装的 Chromium 浏览器与用户 Profiles；
 * - `extension-id.ts`: 计算 Chrome 扩展的公钥与确定性 Extension ID；
 * - `launcher.ts`: 负责以受控参数拉起 Chromium 子进程；
 * - `server.ts`: 本地 WebSocket 桥接服务器，负责扩展连接管理与消息路由；
 * - `session.ts`: 浏览器完整会话封装（拉起浏览器、等待扩展连接、健康检查）。
 */

export * from "./browser-path.ts";
export * from "./extension-id.ts";
export * from "./launcher.ts";
export * from "./server.ts";
export * from "./session.ts";
