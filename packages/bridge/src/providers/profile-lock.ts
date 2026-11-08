import { execFileSync } from "node:child_process";
import { readlinkSync } from "node:fs";
import path from "node:path";

/** Profile 数据目录正被另一个存活的浏览器进程占用 */
export class ProfileInUseError extends Error {
  readonly userDataDir: string;
  readonly pid: number;

  constructor(userDataDir: string, pid: number) {
    super(`该 Profile 数据目录 (${userDataDir}) 已被正在运行的浏览器进程 (PID: ${pid}) 占用，请先关闭该窗口。`);
    this.name = "ProfileInUseError";
    this.userDataDir = userDataDir;
    this.pid = pid;
  }
}

/**
 * 检测目标用户数据目录是否正被其他浏览器进程占用（Chromium 单例锁检测）。
 *
 * Chromium 在每个数据目录下维护一个名为 SingletonLock 的软链接（内容格式为 "<hostname>-<pid>"）。
 * 如果目标 PID 依然处于存活状态，直接再次使用该目录会导致冲突或强制转交给已有实例，
 * 从而使 --load-extension 等命令行参数失效。
 */
export function assertProfileFree(userDataDir: string) {
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
  throw new ProfileInUseError(userDataDir, pid);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * 关闭占用某个 Profile 数据目录的浏览器进程。
 *
 * 为避免被误用成"杀任意进程"，只会处理命令行里 `--user-data-dir` 位于 `allowedRoot` 之下的进程；
 * 先发 SIGTERM 让浏览器正常收尾，5 秒内没退出再 SIGKILL。
 */
export async function terminateProfileBrowser(pid: number, allowedRoot: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("无效的进程 ID");
  if (!isAlive(pid)) return; // 已经退出，无需处理

  let command = "";
  try {
    command = execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return; // ps 查不到说明进程刚好退出
  }
  const root = path.resolve(allowedRoot) + path.sep;
  if (!command.includes(`--user-data-dir=${root}`)) {
    throw new Error(`进程 ${pid} 不是由本应用启动的浏览器，已拒绝关闭。请手动处理。`);
  }

  process.kill(pid, "SIGTERM");
  for (let i = 0; i < 50; i++) {
    if (!isAlive(pid)) return;
    await sleep(100);
  }
  process.kill(pid, "SIGKILL");
  for (let i = 0; i < 20 && isAlive(pid); i++) await sleep(100);
}
