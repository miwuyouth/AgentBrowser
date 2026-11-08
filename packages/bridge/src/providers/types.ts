import type { ScreenshotOptions } from "@agent-browser/protocol";

/**
 * 浏览器提供者适配层。
 *
 * Chromium、CloakBrowser 等浏览器的下载、启动、停止方式各不相同，差异全部收敛在各自的
 * `BrowserProvider` 实现中；App 其余部分只依赖本文件定义的接口。
 *
 * Agent 通过扩展反向连接 Bridge 来控制页面，因此 provider 只需要负责「拉起」和「停止」，
 * 并保证扩展被加载。
 */

/** provider 的能力声明，界面和调度逻辑据此决定展示和限制。 */
export interface ProviderCapabilities {
  /** 新建 Profile 时是否会产生独立的浏览器指纹 */
  fingerprint: boolean;
  /** 同一时刻允许运行的最大实例数（受授权等限制），未设置表示不限制 */
  maxConcurrent?: number;
  /** 是否需要授权 key */
  needsLicense?: boolean;
}

/** 一个已安装、可用于启动的内核 */
export interface InstalledKernel {
  id: string;
  name: string;
  version?: string;
  /** 内核可执行文件的绝对路径（仅受管型 provider 使用） */
  path: string;
}

/** 启动时需要的 Profile 信息 */
export interface ProfileRef {
  id?: string;
  /** 浏览器用户数据目录 */
  dir: string;
  /** provider 自己解释的指纹配置（例如 CloakBrowser 的种子），对其他部分不透明 */
  fingerprint?: Record<string, unknown>;
}

export interface LaunchRequest {
  profile: ProfileRef;
  /** 受管型 provider 需要的内核；未提供时由 provider 自行决定回退行为 */
  kernel?: InstalledKernel;
  /** 编译后的扩展目录（dist） */
  extensionDir: string;
  /** 应用管理浏览器私有数据的根目录，扩展副本等放在这里 */
  dataDir: string;
  /** 本地 Bridge 的连接参数，会写入扩展副本 */
  bridge: { port: number; token: string };
  screenshot?: ScreenshotOptions;
  windowSize?: { width: number; height: number };
  initialUrl?: string;
  /** 以无头模式启动（不显示浏览器窗口） */
  headless?: boolean;
  extraArgs?: string[];
}

/** 一个正在运行的浏览器实例。不假设底层一定是 ChildProcess。 */
export interface RunningBrowser {
  providerId: string;
  /** 界面展示用名称 */
  label: string;
  /** 所使用的内核标识，用于判断是否可复用当前实例 */
  kernelId: string;
  userDataDir: string;
  /** Profile 标识（如有） */
  profile?: string;
  /** 是否以无头模式运行，用于判断是否可复用当前实例 */
  headless: boolean;
  /** 浏览器退出时回调；code 为 null 表示未知或被信号终止 */
  onExit(cb: (code: number | null) => void): void;
  /** 将连接建立前的异常退出转换为面向用户的错误说明 */
  describeEarlyExit?(code: number | null): string;
  /** 优雅关闭 */
  close(): Promise<void>;
}

export interface CreateProfileInput {
  name: string;
  /** 已创建好的 Profile 数据目录 */
  dir: string;
  /** 同一 provider 下已有 Profile 的配置，用于避免指纹重复 */
  existing?: ProfileSpec[];
  /** 指纹型 provider 可选的环境设置 */
  proxy?: string;
  locale?: string;
  timezone?: string;
}

/** createProfile 的产物，会随 Profile 记录一起持久化 */
export interface ProfileSpec {
  fingerprint?: Record<string, unknown>;
}

export interface BrowserProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: ProviderCapabilities;
  /** 新建 Profile：指纹型 provider 在这里生成指纹，普通 Chromium 返回空配置 */
  createProfile(input: CreateProfileInput): Promise<ProfileSpec>;
  /** 拉起浏览器并加载扩展 */
  launch(req: LaunchRequest): Promise<RunningBrowser>;
}

/** 安装过程中的进度信息 */
export interface InstallProgress {
  phase: "resolve" | "download" | "extract" | "verify";
  /** 0 到 1；缺省表示无法得知进度（不确定进度条） */
  fraction?: number;
  message?: string;
}

/** 需要授权 key 才能使用的 provider 提供的授权管理 */
export interface LicenseControl {
  /** 当前是否已有可用的授权 key */
  hasKey(): boolean;
  /** 校验并保存授权 key */
  saveKey(key: string): Promise<void>;
  /** 获取授权的页面 */
  claimUrl: string;
}

/**
 * 内核由 App 自己下载和管理的 provider。一个 provider 对应一个已安装内核，
 * 内核标识与 provider 标识相同。
 */
export interface ManagedProvider extends BrowserProvider {
  /** 已安装的内核；未安装返回 undefined。只看 App 自己的目录，不扫描系统 */
  installed(): InstalledKernel | undefined;
  /** 下载并安装（或升级到）当前推荐版本 */
  install(onProgress?: (p: InstallProgress) => void): Promise<InstalledKernel>;
  uninstall(): Promise<void>;
  readonly license?: LicenseControl;
}

export function isManagedProvider(p: BrowserProvider): p is ManagedProvider {
  return typeof (p as Partial<ManagedProvider>).installed === "function";
}

/** 安装需要先取得授权 key */
export class LicenseRequiredError extends Error {
  constructor(
    message: string,
    readonly claimUrl: string,
  ) {
    super(message);
    this.name = "LicenseRequiredError";
  }
}
