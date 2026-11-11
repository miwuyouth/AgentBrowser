import { execFile, execFileSync } from "node:child_process";
import { closeSync, existsSync, openSync, readlinkSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const isWin = process.platform === "win32";

/** Profile 数据目录正被另一个存活的浏览器进程占用 */
export class ProfileInUseError extends Error {
  readonly userDataDir: string;
  /** 占用它的浏览器主进程；Windows 上查不到时为 0 */
  readonly pid: number;

  constructor(userDataDir: string, pid: number) {
    super(
      pid > 0
        ? `该 Profile 数据目录 (${userDataDir}) 已被正在运行的浏览器进程 (PID: ${pid}) 占用，请先关闭该窗口。`
        : `该 Profile 数据目录 (${userDataDir}) 已被一个正在运行的浏览器占用，请先关闭该窗口。`,
    );
    this.name = "ProfileInUseError";
    this.userDataDir = userDataDir;
    this.pid = pid;
  }
}

/**
 * 检测目标用户数据目录是否正被其他浏览器进程占用（Chromium 单例锁检测）。
 *
 * 占用时直接再次使用该目录会导致冲突或强制转交给已有实例，从而使 --load-extension 等命令行参数失效。
 * - macOS / Linux：Chromium 在数据目录下维护名为 SingletonLock 的软链接（内容为 "<hostname>-<pid>"），PID 存活即占用；
 * - Windows：Chromium 独占打开数据目录下的 lockfile（只允许别人读），能以写方式打开说明没人占用。
 */
export function assertProfileFree(userDataDir: string) {
  if (isWin) {
    if (windowsLockHeld(userDataDir)) throw new ProfileInUseError(userDataDir, findWindowsBrowserPid(userDataDir) ?? 0);
    return;
  }
  const lock = path.join(userDataDir, "SingletonLock");
  let target: string;
  try {
    target = readlinkSync(lock); // 读取软链接指向的目标字符串 "<hostname>-<pid>"
  } catch {
    return; // 锁文件不存在或不可读（正常启动）
  }
  const pid = Number(target.split("-").pop());
  if (!Number.isInteger(pid)) return;
  if (!isAlive(pid)) return; // 进程已消亡，残留的陈旧锁文件不影响启动
  throw new ProfileInUseError(userDataDir, pid);
}

/** Windows：lockfile 存在且无法以写方式打开（共享冲突），说明有浏览器正在用这个目录 */
function windowsLockHeld(userDataDir: string): boolean {
  const lock = path.join(userDataDir, "lockfile");
  if (!existsSync(lock)) return false;
  try {
    closeSync(openSync(lock, "r+"));
    return false; // 能打开：残留的旧锁，没人占用
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "EBUSY" || code === "EPERM" || code === "EACCES";
  }
}

/**
 * Windows：按命令行找到使用该数据目录的浏览器主进程（不带 --type= 的那个，带的是渲染、GPU 等子进程）。
 * 查不到返回 undefined。
 */
function findWindowsBrowserPid(userDataDir: string): number | undefined {
  try {
    return listWindowsProcesses().find(
      (p) => usesUserDataDir(p.command, path.resolve(userDataDir)) && !/\s--type=/.test(p.command),
    )?.pid;
  } catch {
    return undefined;
  }
}

/** 命令行里的 --user-data-dir 是否就是 dir（Windows 路径不区分大小写；参数可能被引号包住） */
function usesUserDataDir(command: string, dir: string): boolean {
  const flag = `--user-data-dir=${dir}`.toLowerCase();
  const cmd = command.toLowerCase();
  const i = cmd.indexOf(flag);
  if (i < 0) return false;
  // 防止 C:\profiles\a 误匹配 C:\profiles\ab：后面必须是参数结束
  const next = cmd[i + flag.length];
  return next === undefined || next === '"' || next === " " || next === "\\";
}

interface ProcessInfo {
  pid: number;
  command: string;
}

/**
 * Windows：列出所有进程的 PID 和完整命令行。
 * 用 PowerShell 的 Get-CimInstance（wmic 在新版 Windows 上已移除）；强制 UTF-8 输出，否则中文路径会乱码。
 */
function listWindowsProcesses(): ProcessInfo[] {
  const script =
    "[Console]::OutputEncoding=[Text.Encoding]::UTF8;" +
    "Get-CimInstance Win32_Process -Property ProcessId,CommandLine | " +
    "Where-Object { $_.CommandLine } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress";
  const out = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  }).trim();
  if (!out) return [];
  const parsed = JSON.parse(out) as { ProcessId: number; CommandLine: string } | { ProcessId: number; CommandLine: string }[];
  return (Array.isArray(parsed) ? parsed : [parsed]).map((p) => ({ pid: p.ProcessId, command: p.CommandLine }));
}

/** 读取某个进程的完整命令行；进程不存在时返回 undefined */
function processCommand(pid: number): string | undefined {
  if (isWin) return listWindowsProcesses().find((p) => p.pid === pid)?.command;
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  } catch {
    return undefined; // ps 查不到说明进程刚好退出
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0); // 信号 0 仅检查 PID 是否存在，不向进程发送真实信号（Windows 上同样可用）
    return true;
  } catch {
    return false;
  }
}

/** 等进程退出，最多等 ms 毫秒；退出了返回 true */
async function waitExit(pid: number, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 100) {
    if (!isAlive(pid)) return true;
    await sleep(100);
  }
  return !isAlive(pid);
}

/**
 * 让浏览器进程正常退出，超时再强制结束。
 *
 * - macOS / Linux：先 SIGTERM（浏览器会保存 Cookie、会话后退出），5 秒内没退出再 SIGKILL；
 * - Windows：没有 SIGTERM（Node 的 kill 在 Windows 上等于直接强杀，会丢数据、下次弹「恢复页面」），
 *   所以先用不带 /F 的 taskkill 给窗口发关闭消息，5 秒内没退出（例如无头模式没有窗口）再 taskkill /F /T 连子进程一起结束。
 */
export async function stopBrowserProcess(pid: number): Promise<void> {
  if (!isAlive(pid)) return;
  if (isWin) {
    await execFileAsync("taskkill", ["/PID", String(pid)], { windowsHide: true }).catch(() => {});
    if (await waitExit(pid, 5_000)) return;
    await execFileAsync("taskkill", ["/F", "/T", "/PID", String(pid)], { windowsHide: true }).catch(() => {});
    await waitExit(pid, 2_000);
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return; // 刚好退出
  }
  if (await waitExit(pid, 5_000)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    return;
  }
  await waitExit(pid, 2_000);
}

/**
 * 关闭占用某个 Profile 数据目录的浏览器进程。
 *
 * 为避免被误用成"杀任意进程"，只会处理命令行里 `--user-data-dir` 位于 `allowedRoot` 之下的进程。
 */
export async function terminateProfileBrowser(pid: number, allowedRoot: string): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("无效的进程 ID");
  if (!isAlive(pid)) return; // 已经退出，无需处理

  const command = processCommand(pid);
  if (command === undefined) return; // 查不到说明进程刚好退出
  const root = path.resolve(allowedRoot) + path.sep;
  const flag = `--user-data-dir=${root}`;
  const owned = isWin ? command.toLowerCase().includes(flag.toLowerCase()) : command.includes(flag);
  if (!owned) {
    throw new Error(`进程 ${pid} 不是由本应用启动的浏览器，已拒绝关闭。请手动处理。`);
  }
  await stopBrowserProcess(pid);
}
