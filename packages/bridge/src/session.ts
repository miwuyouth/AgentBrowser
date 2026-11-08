import { randomBytes } from "node:crypto";
import path from "node:path";
import type { ScreenshotOptions } from "@agent-browser/protocol";
import { extensionIdFromDir } from "./extension-id.ts";
import { getProvider } from "./providers/registry.ts";
import type { BrowserProvider, InstalledKernel, RunningBrowser } from "./providers/types.ts";
import { BrowserBridge, type ConnectionInfo } from "./server.ts";

/**
 * 启动浏览器会话的参数选项
 */
export interface BrowserSessionOptions {
  /** 编译后的扩展目录（dist） */
  extensionDir: string;
  /** 应用数据根目录 */
  dataDir: string;
  /** 显式指定的 User Data 目录绝对路径 */
  userDataDir?: string;
  /** 要激活打开的 Profile 标识名称 */
  profile?: string;
  /** 浏览器提供者（默认普通 Chromium） */
  provider?: BrowserProvider;
  /** 受管型 provider 使用的内核 */
  kernel?: InstalledKernel;
  /** Profile 的指纹配置，由 provider 自行解释 */
  fingerprint?: Record<string, unknown>;
  /** 截图相关设置 */
  screenshot?: ScreenshotOptions;
  /** 窗口初始宽高 */
  windowSize?: { width: number; height: number };
  /** 初始打开的网址（默认 about:blank） */
  initialUrl?: string;
  /** 以无头模式启动（不显示浏览器窗口） */
  headless?: boolean;
  /** 等待扩展反向连接的超时毫秒数（默认 30,000ms） */
  connectTimeoutMs?: number;
  /** 传递给 Chromium 的额外启动参数 */
  extraArgs?: string[];
}

/**
 * 运行中的浏览器会话实例：
 * 包含 Bridge WebSocket 通信服务、浏览器子进程与扩展握手成功后的连接信息。
 */
export interface BrowserSession {
  /** 负责与扩展双向通信的 Bridge 实例 */
  bridge: BrowserBridge;
  /** 运行中的浏览器子进程管理句柄 */
  browser: RunningBrowser;
  /** 握手成功的连接元数据（User-Agent、扩展版本号等） */
  connection: ConnectionInfo;
  /** 完整关闭会话：断开通信并安全终止浏览器进程 */
  close(): Promise<void>;
}

/**
 * 开启完整的浏览器会话：
 * 1. 启动本地 Bridge WebSocket 监听服务（随机端口与鉴权 Token）；
 * 2. 通过 provider 以注入扩展的方式拉起浏览器；
 * 3. 等待扩展 Service Worker 启动并反向连接握手成功；
 * 4. 返回就绪的 BrowserSession。
 */
export async function startBrowserSession(opts: BrowserSessionOptions): Promise<BrowserSession> {
  // 生成一次性随机 Token，防止本地非授权连接
  const token = randomBytes(24).toString("hex");
  const extensionId = extensionIdFromDir(path.resolve(opts.extensionDir));
  // 启动本地 WebSocket Bridge 监听服务
  const bridge = await BrowserBridge.start({ token, extensionId });
  let browser: RunningBrowser | undefined;
  // 未指定 provider 时使用普通 Chromium
  const provider = opts.provider ?? getProvider("chromium");

  try {
    // 通过 provider 启动浏览器
    browser = await provider.launch({
      profile: {
        dir: opts.userDataDir ?? path.join(opts.dataDir, "profiles", opts.profile ?? "default"),
        ...(opts.profile ? { id: opts.profile } : {}),
        ...(opts.fingerprint ? { fingerprint: opts.fingerprint } : {}),
      },
      ...(opts.kernel ? { kernel: opts.kernel } : {}),
      extensionDir: path.resolve(opts.extensionDir),
      dataDir: path.resolve(opts.dataDir),
      bridge: { port: bridge.port, token },
      ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
      ...(opts.windowSize ? { windowSize: opts.windowSize } : {}),
      ...(opts.initialUrl ? { initialUrl: opts.initialUrl } : {}),
      ...(opts.headless ? { headless: true } : {}),
      ...(opts.extraArgs ? { extraArgs: opts.extraArgs } : {}),
    });
    const launched = browser;

    // 监控浏览器过早退出事件（例如单例冲突、崩溃或 TCC 权限被拒）
    const exited = new Promise<never>((_, reject) =>
      launched.onExit((code) =>
        reject(new Error(launched.describeEarlyExit?.(code) ?? `The browser exited before connecting (code ${code}).`)),
      ),
    );
    exited.catch(() => {}); // 仅在建立连接前参与 Promise.race

    // 等待扩展连接上 Bridge 或等待进程异常退出
    const connection = await Promise.race([bridge.waitForConnection(opts.connectTimeoutMs ?? 30_000), exited]);
    return {
      bridge,
      browser: launched,
      connection,
      async close() {
        await bridge.close();
        await launched.close();
      },
    };
  } catch (err) {
    // 出现异常时确保清理已创建的资源
    await bridge.close();
    await browser?.close();
    throw err;
  }
}
