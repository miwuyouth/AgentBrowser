import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import {
  PROTOCOL_VERSION,
  errorResult,
  type AppMessage,
  type ExtensionMessage,
  type HelloMessage,
  type ToolResult,
} from "@agent-browser/protocol";

/**
 * Bridge 本地 WebSocket 服务的配置参数
 */
export interface BridgeOptions {
  /** 每次会话随机生成的鉴权密钥，扩展必须在 `hello` 握手中上报相同的 Token */
  token: string;
  /** 允许连接的唯一扩展 ID；只有 Origin 为 `chrome-extension://<extensionId>` 的连接才被接纳 */
  extensionId: string;
  /** 监听端口，传 0 则由操作系统随机挑选空闲端口 */
  port?: number;
  /** 心跳 Ping 发送间隔（毫秒，默认 20,000ms） */
  pingIntervalMs?: number;
  /** 工具调用的全局默认超时时间（毫秒，默认 60,000ms） */
  defaultTimeoutMs?: number;
}

/**
 * 扩展握手成功后提取的连接元数据
 */
export interface ConnectionInfo {
  extensionVersion: string;
  userAgent: string;
}

/**
 * 工具调用的可选参数
 */
export interface CallOptions {
  /** 单次调用的超时时间 */
  timeoutMs?: number;
  /** 用于主动取消工具调用的 AbortSignal */
  signal?: AbortSignal;
}

/** 记录正在等待扩展回传结果的挂起调用 */
interface Pending {
  resolve(result: ToolResult): void;
  timer: NodeJS.Timeout;
  cleanup(): void;
}

/** 握手超时时间（5 秒内未完成 hello 则主动断开） */
const HELLO_TIMEOUT_MS = 5_000;

/**
 * 桌面端 App 的本地 WebSocket 服务端（BrowserBridge）：
 *
 * 负责接收浏览器扩展的主动反向连接（因 MV3 扩展无法监听端口，只能由扩展连接 App）。
 * 同一时刻只维护一个有效的浏览器连接；新连接到达并握手成功后会自动取代旧连接。
 *
 * `call()` 方法在遇到超时、断开或主动取消时均不会抛出底层异常，
 * 而是包装成标准化的 ToolResult（isError: true）回传给 Agent 循环交由大模型继续决策。
 *
 * 派发的事件：
 * - `connected` (ConnectionInfo): 扩展握手成功
 * - `disconnected`: 扩展断开
 * - `log` (level, message): 收到扩展回传的运行日志
 */
export class BrowserBridge extends EventEmitter {
  private socket: WebSocket | null = null;
  private info: ConnectionInfo | null = null;
  private pending = new Map<string, Pending>();
  private pingTimer: NodeJS.Timeout | undefined;
  private lastPong = 0;

  private constructor(
    private readonly wss: WebSocketServer,
    private readonly opts: Required<BridgeOptions>,
  ) {
    super();
    // 监听新进入的 WebSocket 连接请求并校验 Origin
    wss.on("connection", (ws, req) => this.accept(ws, req.headers.origin));
  }

  /**
   * 启动本地 WebSocket 服务并监听在 127.0.0.1
   */
  static start(options: BridgeOptions): Promise<BrowserBridge> {
    const opts: Required<BridgeOptions> = { port: 0, pingIntervalMs: 20_000, defaultTimeoutMs: 60_000, ...options };
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({ host: "127.0.0.1", port: opts.port, maxPayload: 64 * 1024 * 1024 });
      wss.once("error", reject);
      wss.once("listening", () => {
        wss.off("error", reject);
        resolve(new BrowserBridge(wss, opts));
      });
    });
  }

  /** 获取实际监听的本地端口号 */
  get port(): number {
    return (this.wss.address() as AddressInfo).port;
  }

  /** 当前是否与扩展处于已连接就绪状态 */
  get connected(): boolean {
    return this.info !== null && this.socket?.readyState === WebSocket.OPEN;
  }

  /** 获取当前活跃连接的信息 */
  get connection(): ConnectionInfo | null {
    return this.info;
  }

  /**
   * 异步等待扩展连接成功；若超过 timeoutMs 仍未建立连接则 Promise reject
   */
  waitForConnection(timeoutMs = 20_000): Promise<ConnectionInfo> {
    if (this.connected) return Promise.resolve(this.info!);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.off("connected", onConnected);
        reject(new Error(`浏览器扩展未在 ${timeoutMs} ms 内完成连接。`));
      }, timeoutMs);
      const onConnected = (info: ConnectionInfo) => {
        clearTimeout(timer);
        resolve(info);
      };
      this.once("connected", onConnected);
    });
  }

  /**
   * 向扩展下发工具调用指令并等待执行结果
   */
  call(tool: string, input: Record<string, unknown>, options: CallOptions = {}): Promise<ToolResult> {
    const ws = this.socket;
    if (!ws || !this.connected) {
      return Promise.resolve(errorResult("浏览器未连接，Agent 浏览器是否已退出？", "browser_not_connected"));
    }
    if (options.signal?.aborted) return Promise.resolve(errorResult("已取消。", "cancelled"));

    const id = randomUUID();
    const timeoutMs = options.timeoutMs ?? this.opts.defaultTimeoutMs;
    return new Promise<ToolResult>((resolve) => {
      // 外部触发中断时的处理逻辑
      const onAbort = () => {
        this.send({ type: "cancel", id });
        this.settle(id, errorResult("已取消。", "cancelled"));
      };
      // 超时定时器
      const timer = setTimeout(() => {
        this.send({ type: "cancel", id });
        this.settle(id, errorResult(`${tool} 未在 ${timeoutMs} ms 内完成执行。`, "tool_timeout"));
      }, timeoutMs);

      options.signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, timer, cleanup: () => options.signal?.removeEventListener("abort", onAbort) });

      // 发送工具调用消息，设置扩展端超时略小于本地超时，给扩展留出清理资源并回传结果的时间
      this.send({ type: "tool_call", id, tool, input, timeoutMs: Math.max(1_000, timeoutMs - 2_000) });
    });
  }

  /**
   * 关闭 Bridge 服务，中断活跃连接并关闭端口监听
   */
  async close(): Promise<void> {
    clearInterval(this.pingTimer);
    this.failAll("Bridge 服务已关闭。", "browser_disconnected");
    this.socket?.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  /**
   * 检验进入连接的 Origin 来源
   */
  private accept(ws: WebSocket, origin: string | undefined) {
    // 严格限制 Origin 必须符合 chrome-extension://<固定ExtensionID>
    if (origin !== `chrome-extension://${this.opts.extensionId}`) {
      this.emit("log", "warn", `拒绝了来源为 ${origin ?? "(none)"} 的未知连接`);
      ws.close(1008, "origin not allowed");
      return;
    }

    // 握手超时定时器（防止连接后不发 hello 占用）
    const helloTimer = setTimeout(() => ws.close(1008, "no hello"), HELLO_TIMEOUT_MS);
    ws.on("message", (data) => {
      let msg: ExtensionMessage;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      // 首条消息必须为握手 hello
      if (msg.type === "hello") {
        clearTimeout(helloTimer);
        this.onHello(ws, msg);
        return;
      }
      if (ws !== this.socket) return; // 非已认证连接丢弃
      this.onMessage(msg);
    });

    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (ws !== this.socket) return;
      this.socket = null;
      this.info = null;
      clearInterval(this.pingTimer);
      this.failAll("浏览器在工具运行过程中意外断开连接。", "browser_disconnected");
      this.emit("disconnected");
    });
    ws.on("error", (err) => this.emit("log", "warn", `socket 出错: ${err.message}`));
  }

  /**
   * 处理扩展的 hello 握手包，校验 Token 和协议版本
   */
  private onHello(ws: WebSocket, hello: HelloMessage) {
    const reject = (reason: string) => {
      ws.send(JSON.stringify({ type: "reject", reason } satisfies AppMessage));
      ws.close(1008, reason);
      this.emit("log", "warn", `拒绝扩展连接: ${reason}`);
    };
    if (hello.token !== this.opts.token) return reject("bad token");
    if (hello.protocolVersion !== PROTOCOL_VERSION) {
      return reject(`协议版本 ${hello.protocolVersion} 不受支持 (期望版本 ${PROTOCOL_VERSION})`);
    }
    // 若已有旧连接，则关闭旧连接并使用新连接替换
    if (this.socket && this.socket !== ws) {
      this.failAll("浏览器重新连接，原有执行已丢失。", "browser_disconnected");
      this.socket.close(1000, "replaced");
    }
    this.socket = ws;
    this.info = { extensionVersion: hello.extensionVersion, userAgent: hello.userAgent };
    // 回复欢迎确认消息
    ws.send(JSON.stringify({ type: "welcome", protocolVersion: PROTOCOL_VERSION } satisfies AppMessage));
    // 启动周期性心跳探测以防止 MV3 Service Worker 挂起休眠
    this.startPing(ws);
    this.emit("connected", this.info);
  }

  /**
   * 处理扩展回传的常规业务消息
   */
  private onMessage(msg: ExtensionMessage) {
    switch (msg.type) {
      case "tool_result":
        // 收到工具调用执行结果
        this.settle(msg.id, msg.result);
        break;
      case "pong":
        // 收到心跳响应
        this.lastPong = Date.now();
        break;
      case "log":
        // 收到扩展运行日志
        this.emit("log", msg.level, msg.message);
        break;
    }
  }

  /**
   * 定期向扩展发送 Ping 心跳包：
   * 1. 阻止 Chrome 自动挂起 MV3 Service Worker；
   * 2. 探测已假死的连接并在超时后主动关闭。
   */
  private startPing(ws: WebSocket) {
    clearInterval(this.pingTimer);
    this.lastPong = Date.now();
    this.pingTimer = setInterval(() => {
      if (Date.now() - this.lastPong > this.opts.pingIntervalMs * 3) {
        this.emit("log", "warn", "扩展未响应心跳，主动断开连接");
        ws.terminate();
        return;
      }
      this.send({ type: "ping" });
    }, this.opts.pingIntervalMs);
  }

  /** 发送数据给扩展 */
  private send(msg: AppMessage) {
    if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(msg));
  }

  /** 结算已挂起的工具调用结果 */
  private settle(id: string, result: ToolResult) {
    const p = this.pending.get(id);
    if (!p) return;
    this.pending.delete(id);
    clearTimeout(p.timer);
    p.cleanup();
    p.resolve(result);
  }

  /** 将所有处于挂起状态的工具调用标记为失败 */
  private failAll(message: string, code: string) {
    for (const id of [...this.pending.keys()]) this.settle(id, errorResult(message, code));
  }
}
