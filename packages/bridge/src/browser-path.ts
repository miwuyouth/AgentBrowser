import { existsSync, readdirSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Chromium 内核浏览器的分类标识：
 * - chrome-for-testing: Google 专门为自动化和扩展测试打造的无限制版本（最推荐）
 * - chromium: 开源无品牌的纯净 Chromium 内核
 * - chrome: 官方 Google Chrome 系列（含 Stable/Beta/Dev/Canary）
 * - edge: 微软 Microsoft Edge
 * - brave: Brave 浏览器
 * - arc: Arc 浏览器
 * - other: 其他 Chromium 系分支（如 Vivaldi, Opera）
 */
export type BrowserKind = "chrome-for-testing" | "chromium" | "chrome" | "edge" | "brave" | "arc" | "other";

/**
 * 启动时可执行文件的完整信息结构
 */
export interface BrowserExecutable {
  /** 浏览器二进制可执行文件的绝对路径 */
  path: string;
  /** 浏览器内核分类 */
  kind: BrowserKind;
  /** 内部唯一标识（如 google-chrome、microsoft-edge） */
  id?: string;
  /** 友好的展示名称（如 Google Chrome Dev） */
  name?: string;
  /** 系统默认的用户数据根目录（User Data Directory） */
  defaultUserDataDir?: string;
}

/**
 * 系统中检测到的已安装 Chromium 浏览器结构
 */
export interface DetectedBrowser {
  /** 浏览器唯一 ID */
  id: string;
  /** 界面展示名称 */
  name: string;
  /** 内核类别 */
  kind: BrowserKind;
  /** 可执行文件路径 */
  path: string;
  /** macOS 对应的 .app 包路径（如果存在） */
  appPath?: string;
  /** 系统中默认对应的 User Data 目录 */
  defaultUserDataDir?: string;
  /** 从 Info.plist 或元数据中读取到的版本号 */
  version?: string;
}

/**
 * 已知应用的预定义路径特征
 */
interface KnownAppSpec {
  id: string;
  name: string;
  kind: BrowserKind;
  appName: string;
  bin: string;
  dataDirSub: string;
}

/**
 * macOS 系统中常见的 Chromium 系列浏览器配置清单
 */
const MACOS_KNOWN_APPS: KnownAppSpec[] = [
  { id: "chrome-for-testing", name: "Google Chrome for Testing", kind: "chrome-for-testing", appName: "Google Chrome for Testing.app", bin: "Contents/MacOS/Google Chrome for Testing", dataDirSub: "Google/Chrome for Testing" },
  { id: "google-chrome", name: "Google Chrome", kind: "chrome", appName: "Google Chrome.app", bin: "Contents/MacOS/Google Chrome", dataDirSub: "Google/Chrome" },
  { id: "google-chrome-canary", name: "Google Chrome Canary", kind: "chrome", appName: "Google Chrome Canary.app", bin: "Contents/MacOS/Google Chrome Canary", dataDirSub: "Google/Chrome Canary" },
  { id: "google-chrome-dev", name: "Google Chrome Dev", kind: "chrome", appName: "Google Chrome Dev.app", bin: "Contents/MacOS/Google Chrome Dev", dataDirSub: "Google/Chrome Dev" },
  { id: "google-chrome-beta", name: "Google Chrome Beta", kind: "chrome", appName: "Google Chrome Beta.app", bin: "Contents/MacOS/Google Chrome Beta", dataDirSub: "Google/Chrome Beta" },
  { id: "chromium", name: "Chromium", kind: "chromium", appName: "Chromium.app", bin: "Contents/MacOS/Chromium", dataDirSub: "Chromium" },
  { id: "microsoft-edge", name: "Microsoft Edge", kind: "edge", appName: "Microsoft Edge.app", bin: "Contents/MacOS/Microsoft Edge", dataDirSub: "Microsoft Edge" },
  { id: "microsoft-edge-beta", name: "Microsoft Edge Beta", kind: "edge", appName: "Microsoft Edge Beta.app", bin: "Contents/MacOS/Microsoft Edge Beta", dataDirSub: "Microsoft Edge Beta" },
  { id: "microsoft-edge-dev", name: "Microsoft Edge Dev", kind: "edge", appName: "Microsoft Edge Dev.app", bin: "Contents/MacOS/Microsoft Edge Dev", dataDirSub: "Microsoft Edge Dev" },
  { id: "microsoft-edge-canary", name: "Microsoft Edge Canary", kind: "edge", appName: "Microsoft Edge Canary.app", bin: "Contents/MacOS/Microsoft Edge Canary", dataDirSub: "Microsoft Edge Canary" },
  { id: "brave", name: "Brave Browser", kind: "brave", appName: "Brave Browser.app", bin: "Contents/MacOS/Brave Browser", dataDirSub: "BraveSoftware/Brave-Browser" },
  { id: "brave-beta", name: "Brave Browser Beta", kind: "brave", appName: "Brave Browser Beta.app", bin: "Contents/MacOS/Brave Browser Beta", dataDirSub: "BraveSoftware/Brave-Browser-Beta" },
  { id: "brave-nightly", name: "Brave Browser Nightly", kind: "brave", appName: "Brave Browser Nightly.app", bin: "Contents/MacOS/Brave Browser Nightly", dataDirSub: "BraveSoftware/Brave-Browser-Nightly" },
  { id: "arc", name: "Arc", kind: "arc", appName: "Arc.app", bin: "Contents/MacOS/Arc", dataDirSub: "Arc/User Data" },
  { id: "vivaldi", name: "Vivaldi", kind: "other", appName: "Vivaldi.app", bin: "Contents/MacOS/Vivaldi", dataDirSub: "Vivaldi" },
  { id: "opera", name: "Opera", kind: "other", appName: "Opera.app", bin: "Contents/MacOS/Opera", dataDirSub: "com.operasoftware.Opera" },
];

/**
 * 从 macOS .app 包内的 Info.plist 读取版本字符串，快速且无需拉起进程
 */
function readMacAppVersion(appPath: string): string | undefined {
  try {
    const plist = readFileSync(path.join(appPath, "Contents/Info.plist"), "utf8");
    const m = plist.match(/<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/);
    return m ? m[1] : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 扫描当前操作系统中安装的所有 Chromium 系列浏览器。
 * 覆盖 macOS、Windows、Linux 等标准安装路径与 Puppeteer 本地缓存。
 */
export function detectInstalledBrowsers(): DetectedBrowser[] {
  const list: DetectedBrowser[] = [];
  const seenPaths = new Set<string>();

  // 辅助函数：根据路径去重
  const add = (b: DetectedBrowser) => {
    if (!seenPaths.has(b.path)) {
      seenPaths.add(b.path);
      list.push(b);
    }
  };

  const platform = os.platform();

  if (platform === "darwin") {
    // 1. 优先检查标准应用目录：/Applications 以及用户根目录下的 ~/Applications
    const appRoots = ["/Applications", path.join(os.homedir(), "Applications")];
    for (const spec of MACOS_KNOWN_APPS) {
      for (const root of appRoots) {
        const appPath = path.join(root, spec.appName);
        const binPath = path.join(appPath, spec.bin);
        if (existsSync(binPath)) {
          add({
            id: spec.id,
            name: spec.name,
            kind: spec.kind,
            path: binPath,
            appPath,
            version: readMacAppVersion(appPath),
            defaultUserDataDir: path.join(os.homedir(), "Library/Application Support", spec.dataDirSub),
          });
          break;
        }
      }
    }

    // 2. 扫描 Puppeteer 缓存目录（~/.cache/puppeteer/chrome），查找 Google Chrome for Testing
    const cache = path.join(os.homedir(), ".cache", "puppeteer", "chrome");
    if (existsSync(cache)) {
      try {
        const versions = readdirSync(cache).filter((d) => d.startsWith("mac")).sort(compareVersionDirs).reverse();
        for (const v of versions) {
          for (const arch of ["chrome-mac-arm64", "chrome-mac-x64"]) {
            const appPath = path.join(cache, v, arch, "Google Chrome for Testing.app");
            const binPath = path.join(appPath, "Contents", "MacOS", "Google Chrome for Testing");
            if (existsSync(binPath)) {
              add({
                id: `chrome-for-testing-${v}`,
                name: "Google Chrome for Testing",
                kind: "chrome-for-testing",
                path: binPath,
                appPath,
                version: readMacAppVersion(appPath) ?? v.replace(/^mac_arm-|^mac-/, ""),
                defaultUserDataDir: path.join(os.homedir(), "Library/Application Support/Google/Chrome for Testing"),
              });
            }
          }
        }
      } catch {}
    }
  } else if (platform === "win32") {
    // Windows 系统路径检测
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData/Local");
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

    const winSpecs = [
      { id: "google-chrome", name: "Google Chrome", kind: "chrome" as BrowserKind, sub: "Google\\Chrome\\Application\\chrome.exe", dataDir: path.join(localAppData, "Google\\Chrome\\User Data") },
      { id: "microsoft-edge", name: "Microsoft Edge", kind: "edge" as BrowserKind, sub: "Microsoft\\Edge\\Application\\msedge.exe", dataDir: path.join(localAppData, "Microsoft\\Edge\\User Data") },
      { id: "brave", name: "Brave Browser", kind: "brave" as BrowserKind, sub: "BraveSoftware\\Brave-Browser\\Application\\brave.exe", dataDir: path.join(localAppData, "BraveSoftware\\Brave-Browser\\User Data") },
      { id: "chromium", name: "Chromium", kind: "chromium" as BrowserKind, sub: "Chromium\\Application\\chrome.exe", dataDir: path.join(localAppData, "Chromium\\User Data") },
    ];

    for (const spec of winSpecs) {
      for (const root of [programFiles, programFilesX86, localAppData]) {
        const binPath = path.join(root, spec.sub);
        if (existsSync(binPath)) {
          add({
            id: spec.id,
            name: spec.name,
            kind: spec.kind,
            path: binPath,
            defaultUserDataDir: spec.dataDir,
          });
          break;
        }
      }
    }
  } else {
    // Linux 系统常见二进制位置
    const linuxSpecs = [
      { id: "google-chrome", name: "Google Chrome", kind: "chrome" as BrowserKind, bin: "/usr/bin/google-chrome", dataDir: path.join(os.homedir(), ".config/google-chrome") },
      { id: "google-chrome-beta", name: "Google Chrome Beta", kind: "chrome" as BrowserKind, bin: "/usr/bin/google-chrome-beta", dataDir: path.join(os.homedir(), ".config/google-chrome-beta") },
      { id: "google-chrome-dev", name: "Google Chrome Dev", kind: "chrome" as BrowserKind, bin: "/usr/bin/google-chrome-unstable", dataDir: path.join(os.homedir(), ".config/google-chrome-unstable") },
      { id: "chromium", name: "Chromium", kind: "chromium" as BrowserKind, bin: "/usr/bin/chromium", dataDir: path.join(os.homedir(), ".config/chromium") },
      { id: "chromium-browser", name: "Chromium", kind: "chromium" as BrowserKind, bin: "/usr/bin/chromium-browser", dataDir: path.join(os.homedir(), ".config/chromium") },
      { id: "microsoft-edge", name: "Microsoft Edge", kind: "edge" as BrowserKind, bin: "/usr/bin/microsoft-edge", dataDir: path.join(os.homedir(), ".config/microsoft-edge") },
      { id: "brave", name: "Brave Browser", kind: "brave" as BrowserKind, bin: "/usr/bin/brave-browser", dataDir: path.join(os.homedir(), ".config/BraveSoftware/Brave-Browser") },
    ];
    for (const spec of linuxSpecs) {
      if (existsSync(spec.bin)) {
        add({
          id: spec.id,
          name: spec.name,
          kind: spec.kind,
          path: spec.bin,
          defaultUserDataDir: spec.dataDir,
        });
      }
    }
  }

  return list;
}

/**
 * 寻找可用的 Chromium 内核浏览器可执行文件：
 * 1. 若指定了 preferredIdOrPath（ID 或文件路径），优先匹配；
 * 2. 检查环境变量 AGENT_BROWSER_CHROME；
 * 3. 自动检测系统中已安装的浏览器，按优先级排序返回最优项（Chrome for Testing -> Chromium -> Chrome -> Edge -> Brave...）。
 */
export function findBrowser(preferredIdOrPath?: string): BrowserExecutable | undefined {
  if (preferredIdOrPath) {
    if (existsSync(preferredIdOrPath)) {
      return { path: preferredIdOrPath, kind: guessKind(preferredIdOrPath) };
    }
    const needle = preferredIdOrPath.toLowerCase().trim();
    const needleClean = needle.replace(/[-_\s]/g, "");
    const detected = detectInstalledBrowsers().find(
      (b) =>
        b.id === preferredIdOrPath ||
        b.path === preferredIdOrPath ||
        b.name === preferredIdOrPath ||
        b.kind === preferredIdOrPath ||
        b.id.toLowerCase() === needle ||
        b.name.toLowerCase() === needle ||
        b.kind.toLowerCase() === needle ||
        b.id.toLowerCase().startsWith(needle) ||
        b.id.toLowerCase().replace(/[-_\s]/g, "") === needleClean ||
        b.name.toLowerCase().replace(/[-_\s]/g, "") === needleClean ||
        b.path.toLowerCase().includes(needleClean),
    );
    if (detected) {
      return {
        path: detected.path,
        kind: detected.kind,
        id: detected.id,
        name: detected.name,
        defaultUserDataDir: detected.defaultUserDataDir,
      };
    }
  }

  const override = process.env.AGENT_BROWSER_CHROME;
  if (override && existsSync(override)) {
    return { path: override, kind: guessKind(override) };
  }

  const detected = detectInstalledBrowsers();
  // 默认探测优先顺序：标准已安装 Chrome -> Chromium -> Chrome for Testing -> Edge -> Brave -> 其他
  const order: BrowserKind[] = ["chrome", "chromium", "chrome-for-testing", "edge", "brave", "arc", "other"];
  const sorted = [...detected].sort((a, b) => {
    const ia = order.indexOf(a.kind);
    const ib = order.indexOf(b.kind);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  const first = sorted[0];
  if (first) {
    return {
      path: first.path,
      kind: first.kind,
      id: first.id,
      name: first.name,
      defaultUserDataDir: first.defaultUserDataDir,
    };
  }

  return undefined;
}

/**
 * 根据文件路径或名称推断浏览器种类
 */
function guessKind(p: string): BrowserKind {
  if (/for Testing/i.test(p)) return "chrome-for-testing";
  if (/edge/i.test(p)) return "edge";
  if (/brave/i.test(p)) return "brave";
  if (/arc/i.test(p)) return "arc";
  if (/chromium/i.test(p)) return "chromium";
  if (/chrome/i.test(p)) return "chrome";
  return "other";
}

/**
 * 版本目录比较排序辅助函数
 */
function compareVersionDirs(a: string, b: string): number {
  const va = a.split("-").pop()!.split(".").map(Number);
  const vb = b.split("-").pop()!.split(".").map(Number);
  for (let i = 0; i < Math.max(va.length, vb.length); i++) {
    const d = (va[i] ?? 0) - (vb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}
