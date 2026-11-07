import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRIDGE_CONFIG_FILE, type BridgeConfig, type ScreenshotOptions } from "@agent-browser/protocol";
import { findBrowser, type BrowserExecutable } from "./browser-path.ts";
import { extensionIdFromDir } from "./extension-id.ts";

/**
 * 启动浏览器时的配置选项
 */
export interface LaunchOptions {
  /** 已编译好的扩展目录绝对路径（packages/extension/dist） */
  extensionDir: string;
  /** 应用管理浏览器私有数据的根目录；独立 Profile 保存在 <dataDir>/profiles/<name> */
  dataDir: string;
  /** 显式指定要使用的 User Data 目录绝对路径 */
  userDataDir?: string;
  /** 指定的 Profile 标识名 */
  profile?: string;
  /** 本地 WebSocket 服务连接参数（端口与鉴权 Token） */
  bridge: { port: number; token: string };
  /** 截图压缩与分辨率配置 */
  screenshot?: ScreenshotOptions;
  /** 待启动的目标浏览器可执行文件信息 */
  browser?: BrowserExecutable;
  /** 浏览器初始窗口尺寸 */
  windowSize?: { width: number; height: number };
  /** 初始打开的网址（默认 about:blank） */
  initialUrl?: string;
  /** 额外的 Chromium 命令行启动参数 */
  extraArgs?: string[];
}

/**
 * 已启动的浏览器实例封装
 */
export interface LaunchedBrowser {
  /** 底层子进程句柄 */
  process: ChildProcess;
  /** 当前运行的浏览器可执行文件信息 */
  browser: BrowserExecutable;
  /** 当前所使用的用户数据目录（User Data Directory） */
  userDataDir: string;
  /** 当前打开的 Profile 标识（如有） */
  profile?: string;
  /** 加载的扩展唯一 ID（由公钥 hash 生成，固定不变） */
  extensionId: string;
  /** 优雅关闭浏览器进程（先发送 SIGTERM，超时强制 SIGKILL） */
  close(): Promise<void>;
}

/**
 * 检测目标用户数据目录是否正被其他浏览器进程占用（Chromium 单例锁检测）。
 *
 * Chromium 在每个数据目录下维护一个名为 SingletonLock 的软链接（内容格式为 "<hostname>-<pid>"）。
 * 如果目标 PID 依然处于存活状态，直接再次使用该目录会导致冲突或强制转交给已有实例，
 * 从而使 --load-extension 等命令行参数失效。
 */
function assertProfileFree(userDataDir: string) {
  const lock = path.join(userDataDir, "SingletonLock");
  let target: string;
  try {
    target = readlinkSync(lock); // 读取软链接指向的目标字符串 "<hostname>-<pid>"
  } catch {
    return; // 锁文件不存在或不可读（正常启动）
  }
  const pid = Number(target.split("-").pop());
  if (!Number.isInteger(pid)) return;
  try {
    process.kill(pid, 0); // 信号 0 仅检查 PID 是否存在，不向进程发送真实信号
  } catch {
    return; // 进程已消亡，残留的陈旧锁文件不影响启动
  }
  throw new Error(`该 Profile 数据目录 (${userDataDir}) 已被正在运行的浏览器进程 (PID: ${pid}) 占用，请先关闭该窗口。`);
}

/**
 * 启动 Chromium 内核浏览器并自动注入 Agent MV3 扩展。
 */
export async function launchBrowser(opts: LaunchOptions): Promise<LaunchedBrowser> {
  const browser = opts.browser ?? findBrowser();
  if (!browser) {
    throw new Error("未检测到可用的 Chromium 内核浏览器，请安装 Chrome / Edge / Chromium 或配置路径。");
  }

  const userDataDir = opts.userDataDir ?? path.join(opts.dataDir, "profiles", opts.profile ?? "default");

  mkdirSync(userDataDir, { recursive: true });
  // 启动前检查该目录是否已被其他进程占用
  assertProfileFree(userDataDir);

  // 每次启动时为扩展创建一个干净的独立副本，并将本次会话生成的随机端口和 Token 写入 bridge-config.json
  const extensionDir = path.join(opts.dataDir, "extension");
  rmSync(extensionDir, { recursive: true, force: true });
  cpSync(opts.extensionDir, extensionDir, { recursive: true });
  const config: BridgeConfig = { port: opts.bridge.port, token: opts.bridge.token, ...(opts.screenshot ? { screenshot: opts.screenshot } : {}) };
  writeFileSync(path.join(extensionDir, BRIDGE_CONFIG_FILE), JSON.stringify(config));
  const extensionId = extensionIdFromDir(extensionDir);

  const size = opts.windowSize ?? { width: 1440, height: 900 };
  const args = [
    // 指定该 Profile 专属的用户数据根目录
    `--user-data-dir=${userDataDir}`,
    // 注入 Agent 扩展
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    // 禁用部分版本 Chrome 限制 --load-extension 命令行开关的特性
    "--disable-features=DisableLoadExtensionCommandLineSwitch",
    // 隐藏使用 chrome.debugger 时页面顶部弹出的黄色警告横幅
    "--silent-debugger-extension-api",
    // 跳过浏览器首次启动引导与默认浏览器设置检查
    "--no-first-run",
    "--no-default-browser-check",
    // 设置初始窗口大小
    `--window-size=${size.width},${size.height}`,
    ...(opts.extraArgs ?? []),
    opts.initialUrl || "about:blank",
  ];
  if (!existsSync(browser.path)) throw new Error(`Browser not found at ${browser.path}`);

  // 以独立子进程拉起浏览器
  const child = spawn(browser.path, args, { stdio: "ignore", detached: false });

  // 监听浏览器进程退出事件
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  return {
    process: child,
    browser,
    userDataDir,
    profile: opts.profile,
    extensionId,
    async close() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      await exited;
      clearTimeout(timer);
    },
  };
}
