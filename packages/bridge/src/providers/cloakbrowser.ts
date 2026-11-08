import { randomInt } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { prepareExtension } from "./extension.ts";
import { assertProfileFree } from "./profile-lock.ts";
import {
  LicenseRequiredError,
  type CreateProfileInput,
  type InstallProgress,
  type InstalledKernel,
  type LaunchRequest,
  type LicenseControl,
  type ManagedProvider,
  type ProfileSpec,
  type RunningBrowser,
} from "./types.ts";

const INSTALL_FILE = ".agent-browser-install.json";
const KEY_RE = /^cb_[A-Za-z0-9_-]+$/;
const SITE_URL = "https://cloakbrowser.dev";

async function loadCloak(): Promise<typeof import("cloakbrowser")> {
  try {
    return await import("cloakbrowser");
  } catch (err) {
    throw new Error(`无法加载 CloakBrowser 组件：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** CloakBrowser 的指纹种子范围（与官方包装一致） */
const SEED_MIN = 10_000;
const SEED_MAX = 99_999;

/** 存放在 Profile 记录里的指纹配置，仅本 provider 解释 */
interface CloakFingerprint {
  seed: number;
  proxy?: string;
  locale?: string;
  timezone?: string;
}

function readFingerprint(fp: Record<string, unknown> | undefined): CloakFingerprint {
  const seed = fp?.seed;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < SEED_MIN || seed > SEED_MAX) {
    throw new Error("该 Profile 缺少有效的指纹种子，请重新创建 Profile。");
  }
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const proxy = str(fp?.proxy);
  const locale = str(fp?.locale);
  const timezone = str(fp?.timezone);
  return { seed, ...(proxy ? { proxy } : {}), ...(locale ? { locale } : {}), ...(timezone ? { timezone } : {}) };
}

/**
 * CloakBrowser 指纹浏览器（打过补丁的 Chromium）。
 *
 * - 新建 Profile 时生成指纹种子并保存在 Profile 记录里，启动时通过 `--fingerprint=<seed>` 显式传入，
 *   因此同一 Profile 每次启动指纹一致，不同 Profile 指纹不同。
 * - 通过官方 npm 包的 launchPersistentContext 启动，扩展用 extensionPaths 加载。
 * - 官方包按需动态加载，没有用到 CloakBrowser 时不会引入它。
 */
export class CloakBrowserProvider implements ManagedProvider {
  readonly id = "cloakbrowser";
  readonly label = "CloakBrowser";
  // 并发上限由授权决定（Free 同时只有 1 个会话），由官方包在启动时校验，这里不重复限制
  readonly capabilities = { fingerprint: true, needsLicense: true } as const;
  private readonly cacheDir: string;

  /**
   * 官方包的二进制和授权 key 都放在它的缓存目录里。这里把缓存目录指向 App 自己的内核目录，
   * 通过进程环境变量生效（官方包每次调用时读取）。
   */
  constructor(opts: { kernelsDir: string }) {
    this.cacheDir = path.join(opts.kernelsDir, "cloakbrowser");
    mkdirSync(this.cacheDir, { recursive: true });
    process.env.CLOAKBROWSER_CACHE_DIR = this.cacheDir;
  }

  readonly license: LicenseControl = {
    claimUrl: SITE_URL,
    hasKey: () => {
      if ((process.env.CLOAKBROWSER_LICENSE_KEY ?? "").trim()) return true;
      try {
        return KEY_RE.test(readFileSync(path.join(this.cacheDir, "license.key"), "utf8").trim());
      } catch {
        return false;
      }
    },
    saveKey: async (key) => {
      const k = key.trim();
      if (!KEY_RE.test(k)) throw new Error("这不是有效的 CloakBrowser key（应以 cb_ 开头）。");
      const cloak = await loadCloak();
      const info = await cloak.validateLicense(k).catch(() => null);
      if (info && !info.valid) throw new Error("该 key 无效或已过期。");
      const file = path.join(this.cacheDir, "license.key");
      const tmp = `${file}.${process.pid}.tmp`;
      writeFileSync(tmp, `${k}\n`, { mode: 0o600 });
      chmodSync(tmp, 0o600);
      renameSync(tmp, file);
      rmSync(path.join(this.cacheDir, ".free_claim"), { force: true });
    },
  };

  installed(): InstalledKernel | undefined {
    try {
      const meta = JSON.parse(readFileSync(path.join(this.cacheDir, INSTALL_FILE), "utf8")) as {
        version: string;
        path: string;
      };
      if (!existsSync(meta.path)) return undefined;
      return { id: this.id, name: this.label, version: meta.version, path: meta.path };
    } catch {
      return undefined;
    }
  }

  async install(onProgress?: (p: InstallProgress) => void): Promise<InstalledKernel> {
    const cloak = await loadCloak();
    onProgress?.({ phase: "download", message: "正在下载 CloakBrowser（体积较大，请耐心等待）…" });
    // 官方包没有进度回调，只会向 console.error 打印 "Download progress: N% (a/b MB)"。
    // 安装期间旁听这类输出来得到进度；输出本身原样放行，格式变化时退化为不确定进度。
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      const m = /Download progress: (\d+)%/.exec(String(args[0] ?? ""));
      if (m) onProgress?.({ phase: "download", fraction: Number(m[1]) / 100, message: "下载 CloakBrowser" });
      originalError.apply(console, args);
    };
    let binaryPath: string;
    try {
      binaryPath = await cloak.ensureBinary();
    } catch (err) {
      if (err instanceof cloak.CloakBrowserLicenseError) {
        const claimUrl = /https:\/\/cloakbrowser\.dev\/#claim=[^\s)]+/.exec(err.message)?.[0] ?? SITE_URL;
        throw new LicenseRequiredError("需要 CloakBrowser 授权 key。可免费领取，领取后填入下方再下载。", claimUrl);
      }
      throw err;
    } finally {
      console.error = originalError;
    }
    onProgress?.({ phase: "verify", message: "正在校验…" });
    const info = cloak.binaryInfo();
    writeFileSync(
      path.join(this.cacheDir, INSTALL_FILE),
      JSON.stringify({ version: info.version ?? "unknown", path: binaryPath }),
    );
    return this.installed()!;
  }

  async uninstall(): Promise<void> {
    // 只删除二进制目录和安装记录，授权 key 等其他文件保留，重新下载时不必再填。
    // 不用官方的 clearCache()：它会清空整个缓存目录，连 license.key 一起删掉。
    for (const name of readdirSync(this.cacheDir)) {
      if (name.startsWith("chromium-")) rmSync(path.join(this.cacheDir, name), { recursive: true, force: true });
    }
    rmSync(path.join(this.cacheDir, INSTALL_FILE), { force: true });
  }

  async createProfile(input: CreateProfileInput): Promise<ProfileSpec> {
    mkdirSync(input.dir, { recursive: true });
    const used = new Set(
      (input.existing ?? []).map((p) => p.fingerprint?.seed).filter((s): s is number => typeof s === "number"),
    );
    // 种子空间约 9 万个，App 能看到全部 Profile，所以可以直接保证不重复
    if (used.size >= SEED_MAX - SEED_MIN + 1) throw new Error("指纹种子已用尽。");
    let seed: number;
    do {
      seed = randomInt(SEED_MIN, SEED_MAX + 1);
    } while (used.has(seed));

    const fingerprint: CloakFingerprint = {
      seed,
      ...(input.proxy ? { proxy: input.proxy } : {}),
      ...(input.locale ? { locale: input.locale } : {}),
      ...(input.timezone ? { timezone: input.timezone } : {}),
    };
    return { fingerprint: { ...fingerprint } };
  }

  async launch(req: LaunchRequest): Promise<RunningBrowser> {
    const fp = readFingerprint(req.profile.fingerprint);
    if (!this.installed()) throw new Error("CloakBrowser 内核尚未安装，请先在「浏览器内核」页下载。");
    const userDataDir = req.profile.dir;
    mkdirSync(userDataDir, { recursive: true });
    assertProfileFree(userDataDir);

    const cloak = await loadCloak();

    const extensionDir = prepareExtension(req);
    const size = req.windowSize ?? { width: 1440, height: 900 };

    const context = await cloak.launchPersistentContext({
      userDataDir,
      headless: !!req.headless,
      extensionPaths: [extensionDir],
      args: [
        `--fingerprint=${fp.seed}`,
        // 隐藏使用 chrome.debugger 时页面顶部弹出的黄色警告横幅
        "--silent-debugger-extension-api",
        "--no-first-run",
        `--window-size=${size.width},${size.height}`,
        ...(req.extraArgs ?? []),
      ],
      ...(fp.proxy ? { proxy: fp.proxy } : {}),
      ...(fp.locale ? { locale: fp.locale } : {}),
      ...(fp.timezone ? { timezone: fp.timezone } : {}),
    });

    if (req.initialUrl && req.initialUrl !== "about:blank") {
      const page = context.pages()[0] ?? (await context.newPage());
      void page.goto(req.initialUrl).catch(() => {});
    }

    let closed = false;
    context.once("close", () => {
      closed = true;
    });

    return {
      providerId: this.id,
      label: req.kernel?.name ?? this.label,
      kernelId: req.kernel?.id ?? this.id,
      userDataDir,
      ...(req.profile.id ? { profile: req.profile.id } : {}),
      headless: !!req.headless,
      // Playwright 不提供退出码
      onExit: (cb) => {
        context.once("close", () => cb(null));
      },
      async close() {
        if (closed) return;
        await context.close().catch(() => {});
      },
    };
  }
}
