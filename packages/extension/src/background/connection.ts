/**
 * Chrome MV3 扩展与 App 宿主桥接端的 WebSocket 连接与生命周期管理。
 *
 * 核心功能：
 * 1. 动态加载配置：读取扩展目录下的 bridge.json（由 Bridge 在启动扩展时动态写入端口与鉴权 Token）；
 * 2. 握手认证：连接成功后发送 `hello` 消息，附带 Token、协议版本号与扩展信息；
 * 3. 自动指数退避重连：连接断开或配置未就绪时自动延迟重连（500ms ~ 5000ms）；
 * 4. 工具调用派发与取消：管理在途任务（inflight），支持 timeout 超时与 cancel 消息主动中断；
 * 5. 心跳与日志上报：响应 ping 消息回复 pong，将扩展日志通过 WebSocket 同步回宿主端。
 */

import {
  BRIDGE_CONFIG_FILE,
  PROTOCOL_VERSION,
  errorResult,
  type AppMessage,
  type BridgeConfig,
  type ExtensionMessage,
  type ToolCallMessage,
} from "@agent-browser/protocol";
import { configureScreenshots } from "./screenshot.ts";
import { dispatch } from "./tools/index.ts";

/** 重连延迟下限与上限（毫秒） */
const MIN_RETRY_MS = 500;
const MAX_RETRY_MS = 5_000;

let socket: WebSocket | null = null;
let connecting = false;
let retryDelay = MIN_RETRY_MS;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
/** 正在执行中的工具调用控制器映射（callId -> AbortController） */
const inflight = new Map<string, AbortController>();

/** 读取由 Bridge 服务动态写入扩展目录的 bridge.json 配置文件 */
async function loadConfig(): Promise<BridgeConfig | null> {
  try {
    const res = await fetch(chrome.runtime.getURL(BRIDGE_CONFIG_FILE), { cache: "no-store" });
    if (!res.ok) return null;
    const config = (await res.json()) as BridgeConfig;
    return typeof config.port === "number" && typeof config.token === "string" ? config : null;
  } catch {
    return null;
  }
}

/** 通过 WebSocket 向 App 端发送协议消息 */
function send(message: ExtensionMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

/** 记录日志并同时推送到 App 端 */
export function log(level: "debug" | "info" | "warn" | "error", message: string) {
  console[level === "debug" ? "log" : level](`[agent-browser] ${message}`);
  send({ type: "log", level, message });
}

/** 安排下一次重试连接（指数退避算法） */
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => void connect(), retryDelay);
  retryDelay = Math.min(retryDelay * 2, MAX_RETRY_MS);
}

/** 执行来自 App 端的单个工具调用 */
async function runToolCall(msg: ToolCallMessage) {
  const controller = new AbortController();
  inflight.set(msg.id, controller);
  const timer = msg.timeoutMs ? setTimeout(() => controller.abort(), msg.timeoutMs) : undefined;
  try {
    const result = await dispatch(msg.tool, msg.input ?? {}, controller.signal);
    send({ type: "tool_result", id: msg.id, result });
  } catch (err) {
    send({ type: "tool_result", id: msg.id, result: errorResult(String(err), "execution_error") });
  } finally {
    clearTimeout(timer);
    inflight.delete(msg.id);
  }
}

/** 处理从 App 端接收到的 WebSocket 消息 */
function onMessage(raw: string) {
  let msg: AppMessage;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  switch (msg.type) {
    case "welcome":
      retryDelay = MIN_RETRY_MS;
      log("info", `connected to the app (protocol ${msg.protocolVersion})`);
      break;
    case "reject":
      console.warn(`[agent-browser] the app rejected this extension: ${msg.reason}`);
      break;
    case "ping":
      send({ type: "pong" });
      break;
    case "tool_call":
      void runToolCall(msg);
      break;
    case "cancel":
      inflight.get(msg.id)?.abort();
      break;
  }
}

/** 连接到 App 端的 Bridge WebSocket 桥接服务。支持防重入多次调用。 */
export async function connect() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const config = await loadConfig();
    if (!config) {
      scheduleRetry();
      return;
    }
    configureScreenshots(config.screenshot);
    const ws = new WebSocket(`ws://127.0.0.1:${config.port}`);
    socket = ws;
    ws.onopen = () => {
      // 连接建立后立刻发起握手包
      ws.send(
        JSON.stringify({
          type: "hello",
          protocolVersion: PROTOCOL_VERSION,
          token: config.token,
          extensionVersion: chrome.runtime.getManifest().version,
          userAgent: navigator.userAgent,
        } satisfies ExtensionMessage),
      );
    };
    ws.onmessage = (ev) => onMessage(typeof ev.data === "string" ? ev.data : "");
    ws.onclose = () => {
      if (socket === ws) socket = null;
      // 连接断开时中断所有在途的工具执行
      for (const c of inflight.values()) c.abort();
      inflight.clear();
      scheduleRetry();
    };
    ws.onerror = () => {}; // 错误会随后触发 onclose
  } finally {
    connecting = false;
  }
}
