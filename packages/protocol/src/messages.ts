import type { ToolResult } from "./blocks.ts";

/** 协议版本号；当通信消息格式发生破坏性变动时递增 */
export const PROTOCOL_VERSION = 1;

/**
 * 桌面 App 在每次拉起浏览器前，写入扩展目录的连接配置文件（bridge-config.json）
 */
export interface BridgeConfig {
  /** 本地 WebSocket 服务监听的端口 */
  port: number;
  /** 每次启动由主进程生成的随机安全 Token，扩展在 hello 握手时必须携带此 Token 进行校验 */
  token: string;
  /** 截图压缩与分辨率配置 */
  screenshot?: ScreenshotOptions;
}

/**
 * 页面截图配置项（控制发送给视觉大模型的图像尺寸与压缩率）
 */
export interface ScreenshotOptions {
  /** 全尺寸截图的最长边像素限制（默认 1920） */
  maxLongEdge?: number;
  /** 全尺寸截图的最大总像素上限（width * height，默认 1920×1080） */
  maxPixels?: number;
  /** JPEG 压缩质量（0 到 1 之间） */
  jpegQuality?: number;
}

/** 扩展目录内配置文件的文件名 */
export const BRIDGE_CONFIG_FILE = "bridge-config.json";

// ---------- 扩展 -> 桌面 App (extension -> app) ----------

/** 扩展建立 WebSocket 连接后发送的首条问候握手消息 */
export interface HelloMessage {
  type: "hello";
  /** 扩展所使用的协议版本号 */
  protocolVersion: number;
  /** 从 bridge-config.json 读取的校验 Token */
  token: string;
  /** 扩展本身的版本号 */
  extensionVersion: string;
  /** 浏览器的 User-Agent 字符串 */
  userAgent: string;
}

/** 工具执行完毕后由扩展回传给 App 的执行结果（文本、报错或截图） */
export interface ToolResultMessage {
  type: "tool_result";
  /** 工具调用的唯一标识 ID，与 ToolCallMessage.id 对应 */
  id: string;
  /** 包含文本块、图像块或错误标记的执行结果 */
  result: ToolResult;
}

/** 响应 App 心跳检测的回包 */
export interface PongMessage {
  type: "pong";
}

/** 扩展向桌面端回传的运行日志消息 */
export interface LogMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
}

/** 扩展发送给桌面端的所有消息类型联合 */
export type ExtensionMessage = HelloMessage | ToolResultMessage | PongMessage | LogMessage;

// ---------- 桌面 App -> 扩展 (app -> extension) ----------

/** App 校验 Token 成功后回复的欢迎握手确认消息 */
export interface WelcomeMessage {
  type: "welcome";
  protocolVersion: number;
}

/** App 鉴权失败或协议不兼容时的拒绝消息 */
export interface RejectMessage {
  type: "reject";
  reason: string;
}

/** App 下发给扩展执行的具体工具调用指令 */
export interface ToolCallMessage {
  type: "tool_call";
  /** 工具调用的唯一标识 ID */
  id: string;
  /** 工具名称（例如 click, navigate, form_input, computer） */
  tool: string;
  /** 工具入参对象 */
  input: Record<string, unknown>;
  /** 执行超时时间（毫秒），超时后扩展会主动 abort 中止正在执行的任务 */
  timeoutMs?: number;
}

/** App 主动取消某项正在执行的工具调用 */
export interface CancelMessage {
  type: "cancel";
  id: string;
}

/** App 发送给扩展的心跳保活探测 */
export interface PingMessage {
  type: "ping";
}

/** 桌面端发送给扩展的所有消息类型联合 */
export type AppMessage = WelcomeMessage | RejectMessage | ToolCallMessage | CancelMessage | PingMessage;
