import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import os from "node:os";

/** Chrome for Testing 官方版本清单（每个渠道最新的可下载版本） */
const LAST_KNOWN_GOOD =
  "https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json";

export interface CftPlatform {
  /** 清单里的平台名 */
  platform: string;
  /** zip 解压后的顶层目录 */
  dir: string;
  /** 可执行文件相对 dir 的路径 */
  exe: string;
}

export function cftPlatform(): CftPlatform {
  const { platform } = process;
  const arch = os.arch();
  if (platform === "darwin" && (arch === "arm64" || arch === "x64")) {
    const p = arch === "arm64" ? "mac-arm64" : "mac-x64";
    return {
      platform: p,
      dir: `chrome-${p}`,
      exe: "Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
    };
  }
  if (platform === "win32" && arch === "x64") return { platform: "win64", dir: "chrome-win64", exe: "chrome.exe" };
  if (platform === "linux" && arch === "x64") return { platform: "linux64", dir: "chrome-linux64", exe: "chrome" };
  throw new Error(`当前系统暂不支持自动下载 Chromium（${platform}/${arch}）。`);
}

export interface CftRelease {
  version: string;
  url: string;
}

/** 解析当前平台 Stable 渠道的最新版本与下载地址 */
export async function resolveStableRelease(): Promise<CftRelease> {
  const target = cftPlatform();
  const res = await fetch(LAST_KNOWN_GOOD, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`获取 Chromium 版本信息失败：HTTP ${res.status}`);
  const data = (await res.json()) as {
    channels?: { Stable?: { version: string; downloads?: { chrome?: { platform: string; url: string }[] } } };
  };
  const stable = data.channels?.Stable;
  const url = stable?.downloads?.chrome?.find((d) => d.platform === target.platform)?.url;
  if (!stable || !url) throw new Error(`官方清单里没有适用于 ${target.platform} 的 Chromium 下载。`);
  return { version: stable.version, url };
}

/** 流式下载到文件，并按已接收字节上报进度（0 到 1，未知总大小时为 undefined） */
export async function downloadFile(
  url: string,
  dest: string,
  onProgress?: (fraction: number | undefined) => void,
): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败：HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length")) || undefined;
  let received = 0;
  let lastReport = 0;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.length;
      const now = Date.now();
      if (onProgress && now - lastReport > 250) {
        lastReport = now;
        onProgress(total ? received / total : undefined);
      }
      cb(null, chunk);
    },
  });
  await pipeline(Readable.fromWeb(res.body as never), counter, createWriteStream(dest));
  if (total && received !== total) throw new Error(`下载不完整：收到 ${received} 字节，应为 ${total} 字节。`);
  onProgress?.(1);
}
