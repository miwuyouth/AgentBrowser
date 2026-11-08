import { execFile, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import extract from "extract-zip";
import { cftPlatform, downloadFile, resolveStableRelease } from "./cft.ts";
import { prepareExtension } from "./extension.ts";
import { assertProfileFree } from "./profile-lock.ts";
import type {
  CreateProfileInput,
  InstallProgress,
  InstalledKernel,
  LaunchRequest,
  ManagedProvider,
  ProfileSpec,
  RunningBrowser,
} from "./types.ts";

const execFileAsync = promisify(execFile);
const INSTALL_FILE = "install.json";

function describeEarlyExit(code: number | null): string {
  if (code === 21) {
    return `浏览器启动失败并闪退（错误码 21：Profile In Use / 目录权限受阻）。macOS 系统隐私策略拦截了向系统 Chrome 目录写入单例锁（SingletonLock），或已有浏览器实例占用；请在设置中将数据模式切换为「独立隔离目录」，或改用 Chrome for Testing / Chromium。`;
  }
  if (code === 0) {
    return `浏览器退出（code 0）。该浏览器可能已在后台运行并拦截了新窗口，请先完全退出该浏览器再试。`;
  }
  return `The browser exited before connecting (code ${code}).`;
}

/**
 * 普通 Chromium 内核（Chrome for Testing）：由 App 自己下载到 `<kernelsDir>/chromium/<version>`，
 * 启动时直接拉起二进制并通过 --load-extension 注入扩展。
 * 不产生独立指纹，新建 Profile 只是一个空的数据目录。
 */
export class ChromiumProvider implements ManagedProvider {
  readonly id = "chromium";
  readonly label = "Chromium";
  readonly capabilities = { fingerprint: false } as const;
  private readonly root: string;

  constructor(opts: { kernelsDir: string }) {
    this.root = path.join(opts.kernelsDir, "chromium");
  }

  async createProfile(input: CreateProfileInput): Promise<ProfileSpec> {
    mkdirSync(input.dir, { recursive: true });
    return {};
  }

  installed(): InstalledKernel | undefined {
    try {
      const meta = JSON.parse(readFileSync(path.join(this.root, INSTALL_FILE), "utf8")) as {
        version: string;
        exe: string;
      };
      const exe = path.join(this.root, meta.exe);
      if (!existsSync(exe)) return undefined;
      return { id: this.id, name: this.label, version: meta.version, path: exe };
    } catch {
      return undefined;
    }
  }

  async install(onProgress?: (p: InstallProgress) => void): Promise<InstalledKernel> {
    const target = cftPlatform();
    onProgress?.({ phase: "resolve", message: "正在获取最新稳定版信息…" });
    const release = await resolveStableRelease();

    const current = this.installed();
    if (current?.version === release.version) return current;

    mkdirSync(this.root, { recursive: true });
    const work = path.join(this.root, `.tmp-${Date.now()}`);
    mkdirSync(work, { recursive: true });
    try {
      const zip = path.join(work, "chrome.zip");
      await downloadFile(release.url, zip, (fraction) =>
        onProgress?.({ phase: "download", ...(fraction !== undefined ? { fraction } : {}), message: `下载 Chromium ${release.version}` }),
      );

      onProgress?.({ phase: "extract", message: "正在解压…" });
      const unpacked = path.join(work, "unpacked");
      await extract(zip, { dir: unpacked });
      const relExe = path.join(target.dir, target.exe);
      const exe = path.join(unpacked, relExe);
      if (!existsSync(exe)) throw new Error("解压后没有找到浏览器可执行文件。");

      onProgress?.({ phase: "verify", message: "正在校验…" });
      await execFileAsync(exe, ["--version"], { timeout: 15_000 });

      // 解压成功才替换：先移到正式目录，再写入安装信息
      const finalDir = path.join(this.root, release.version);
      rmSync(finalDir, { recursive: true, force: true });
      renameSync(unpacked, finalDir);
      writeFileSync(
        path.join(this.root, INSTALL_FILE),
        JSON.stringify({ version: release.version, exe: path.join(release.version, relExe) }),
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }

    // 清理旧版本目录（best-effort）
    for (const name of readdirSync(this.root)) {
      if (name !== release.version && /^\d+\./.test(name)) {
        rmSync(path.join(this.root, name), { recursive: true, force: true });
      }
    }
    return this.installed()!;
  }

  async uninstall(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
  }

  async launch(req: LaunchRequest): Promise<RunningBrowser> {
    const kernel = req.kernel ?? this.installed();
    if (!kernel) throw new Error("Chromium 内核尚未安装，请先在「浏览器内核」页下载。");
    const executable = { path: kernel.path };
    if (!existsSync(executable.path)) throw new Error(`Browser not found at ${executable.path}`);

    const userDataDir = req.profile.dir;
    mkdirSync(userDataDir, { recursive: true });
    // 启动前检查该目录是否已被其他进程占用
    assertProfileFree(userDataDir);

    // 每次启动时为扩展创建一个干净的独立副本，并写入本次会话的端口和 Token
    const extensionDir = prepareExtension(req);

    const size = req.windowSize ?? { width: 1440, height: 900 };
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
      // 无头模式：新版 headless 支持加载扩展，Agent 照常通过扩展控制页面
      ...(req.headless ? ["--headless=new"] : []),
      ...(req.extraArgs ?? []),
      req.initialUrl || "about:blank",
    ];

    // 以独立子进程拉起浏览器
    const child = spawn(executable.path, args, { stdio: "ignore", detached: false });
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));

    return {
      providerId: this.id,
      label: kernel.name,
      kernelId: kernel.id,
      userDataDir,
      ...(req.profile.id ? { profile: req.profile.id } : {}),
      headless: !!req.headless,
      onExit: (cb) => {
        child.once("exit", (code) => cb(code));
      },
      describeEarlyExit,
      async close() {
        if (child.exitCode !== null) return;
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
        await exited;
        clearTimeout(timer);
      },
    };
  }
}
