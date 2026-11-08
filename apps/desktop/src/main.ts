import { BrowserWindow, app, clipboard, dialog, ipcMain, nativeTheme, net, protocol, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { AgentSession, createProvider } from "@agent-browser/agent";
import {
  LicenseRequiredError,
  ProfileInUseError,
  getProvider,
  terminateProfileBrowser,
  initProviders,
  isManagedProvider,
  startBrowserSession,
  type BrowserSession,
} from "@agent-browser/bridge";
import {
  activeProviderConfig,
  applyUpdate,
  loadSettings,
  saveSettings,
  view,
  type StoredSettings,
} from "./settings.ts";
import {
  AUTO_PROFILE_LABEL,
  IPC,
  errorMessage,
  type AppState,
  type BrowserActionResult,
  type BrowserStatus,
  type ProfileItem,
  type SettingsUpdate,
  type TaskItem,
  type ThemeMode,
  type UiEvent,
} from "./shared.ts";
import {
  createProfileForKernel,
  getAppBrowserProfilesDir,
  getKernelsList,
  loadProfiles,
  getRunStore,
  loadTasks,
  removeProfileById,
  resolveKernelAndOptionalProfile,
  resolveKernelAndProfile,
  saveDefaultProfile,
  saveTasks,
  updateProfileMeta,
} from "./storage.ts";
import { Scheduler } from "./scheduler.ts";
import { TaskRunner } from "./task-runner.ts";

// 截图以 shot://run/<运行ID>/<文件名> 的地址提供给界面，不再把 base64 塞进消息里。必须在 app ready 之前注册。
protocol.registerSchemesAsPrivileged([{ scheme: "shot", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/** 获取浏览器扩展的构建产物目录 */
function extensionDir(): string {
  if (process.env.AGENT_BROWSER_EXTENSION_DIR) return process.env.AGENT_BROWSER_EXTENSION_DIR;
  return app.isPackaged ? path.join(process.resourcesPath, "extension") : path.resolve(__dirname, "../../../packages/extension/dist");
}

/** 获取桌面端产品图标路径 */
function appIconPath(): string {
  const distIcon = path.join(__dirname, "icon.png");
  if (existsSync(distIcon)) return distIcon;
  return path.resolve(__dirname, "../assets/icon.png");
}

let window: BrowserWindow | null = null;
let settings: StoredSettings;
let browser: BrowserSession | null = null;
let browserStatus: BrowserStatus = "stopped";
let browserError: string | undefined;
let taskRunner: TaskRunner;
let scheduler: Scheduler;

/** 内核下载安装的运行时状态（不持久化） */
interface KernelRuntime {
  installing?: boolean;
  fraction?: number;
  message?: string;
  error?: string;
  claimUrl?: string;
}
const kernelRuntime = new Map<string, KernelRuntime>();

/** 主进程向渲染窗口推送 UI 事件 */
function emit(e: UiEvent) {
  window?.webContents.send(IPC.event, e);
}

/** 组装发送给渲染进程的当前应用状态 */
function state(): AppState {
  const tasks = loadTasks();
  const runs = getRunStore().list();
  const kernels = getKernelsList().map((k) => {
    const rt = kernelRuntime.get(k.id);
    if (!rt) return k;
    return {
      ...k,
      ...(rt.installing ? { installing: true } : {}),
      ...(rt.fraction !== undefined ? { progress: rt.fraction } : {}),
      ...(rt.message ? { progressText: rt.message } : {}),
      ...(rt.error ? { installError: rt.error } : {}),
      ...(rt.claimUrl ? { claimUrl: rt.claimUrl } : {}),
    };
  });
  const profiles = loadProfiles();
  const activeRun = taskRunner?.getActiveRun() || undefined;

  return {
    browser: browserStatus,
    ...(browserError ? { browserError } : {}),
    provider: view(settings, settings.provider),
    providers: { anthropic: view(settings, "anthropic"), "openai-compatible": view(settings, "openai-compatible") },
    running: taskRunner?.isRunning() ?? false,
    queued: scheduler?.queued() ?? [],
    tasks,
    runs,
    kernels,
    profiles,
    activeRun,
  };
}

/** 推送全量状态更新到渲染进程 */
const pushState = () => emit({ type: "state", state: state() });

/** 根据当前配置与指定浏览器会话创建 Agent 实例 */
function createAgentForSession(session: BrowserSession, opts: { maxSteps?: number }): AgentSession {
  const config = activeProviderConfig(settings);
  if (typeof config === "string") throw new Error(config);
  return new AgentSession({
    bridge: session.bridge,
    provider: createProvider(config),
    // macOS TCC 式文件授权：Agent 通过 file_upload 读取本地文件前先询问用户。
    // 「总是允许」只对本任务本次运行生效（每个 Agent 实例一套授权记忆）。
    allowFile: makeFilePermissionGate(),
    // 任务里设置的最大步数；没设置就用 Agent 自己的安全上限
    ...(opts.maxSteps ? { maxSteps: opts.maxSteps } : {}),
  });
}

/** 创建一次运行范围内的文件读取授权回调 */
function makeFilePermissionGate(): (absolutePath: string) => Promise<boolean> {
  const alwaysAllowed = new Set<string>();
  return async (absolutePath: string) => {
    if (alwaysAllowed.has(absolutePath)) return true;
    const choice = await dialog.showMessageBox({
      type: "question",
      title: "Agent 请求读取本地文件",
      message: "Agent 想读取这个文件并上传到网页：",
      detail: absolutePath,
      buttons: ["允许一次", "总是允许", "拒绝"],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    });
    if (choice.response === 1) alwaysAllowed.add(absolutePath);
    const allowed = choice.response !== 2;
    emit({
      type: "notice",
      message: allowed
        ? `已允许读取 ${path.basename(absolutePath)}`
        : `已拒绝读取 ${path.basename(absolutePath)}，Agent 收到「不允许」的回复`,
      ...(!allowed ? { isError: true } : {}),
    });
    return allowed;
  };
}

/** 安全关闭当前运行的浏览器会话 */
async function closeCurrentBrowser(): Promise<void> {
  if (!browser) return;
  const current = browser;
  browser = null;
  browserStatus = "stopped";
  pushState();
  try {
    await current.close();
  } catch {}
}

/** 启动指定内核与对应 Profile 的浏览器进程并等待扩展通过 WebSocket 连接 */
async function startBrowser(
  targetKernel?: string,
  targetProfile?: string,
  initialUrl?: string,
): Promise<BrowserSession> {
  const { kernel, profile } = resolveKernelAndProfile(targetKernel, targetProfile);
  const provider = getProvider(profile.providerId || kernel.providerId);
  // 内核必须由 App 下载安装；不会去使用系统里已有的浏览器
  const installedKernel = isManagedProvider(provider) ? provider.installed() : undefined;
  if (!installedKernel) {
    throw new Error(`「${kernel.name}」内核尚未安装，请先在「浏览器内核」页下载。`);
  }

  if (browser && browserStatus === "connected") {
    // 如果当前正在运行的内核与 Profile 数据目录完全一致，直接复用
    if (browser.browser.kernelId === kernel.id && browser.browser.userDataDir === profile.dir) {
      return browser;
    }
    // 否则先安全关闭当前实例再启动目标内核与 Profile
    await closeCurrentBrowser();
  }

  if (browserStatus === "starting") {
    throw new Error("浏览器正在启动中，请稍候再试。");
  }

  browserStatus = "starting";
  browserError = undefined;
  pushState();

  try {
    const dir = extensionDir();
    if (!existsSync(path.join(dir, "manifest.json"))) {
      throw new Error(`扩展尚未构建: ${dir} (请先执行 pnpm build:extension)`);
    }

    const session = await startBrowserSession({
      extensionDir: dir,
      dataDir: path.join(app.getPath("userData"), "browser"),
      provider,
      kernel: installedKernel,
      ...(profile.fingerprint ? { fingerprint: profile.fingerprint } : {}),
      userDataDir: profile.dir,
      profile: profile.id,
      ...(initialUrl ? { initialUrl } : {}),
    });
    browser = session;
    browserStatus = "connected";

    session.bridge.on("disconnected", () => {
      if (browser === session && browserStatus === "connected") {
        browserStatus = "stopped";
        pushState();
      }
    });

    session.bridge.on("connected", () => {
      if (browser === session) {
        browserStatus = "connected";
        browserError = undefined;
        pushState();
      }
    });

    session.browser.onExit(() => {
      if (browser === session) {
        browserStatus = "stopped";
        browser = null;
        pushState();
      }
    });

    pushState();
    return session;
  } catch (err) {
    browser = null;
    browserStatus = "error";
    browserError = errorMessage(err);
    pushState();
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** 注册 IPC 交互通道 */
function registerIpc() {
  ipcMain.handle(IPC.getState, () => state());

  // 保存模型设置
  ipcMain.handle(IPC.saveSettings, (_e, update: SettingsUpdate) => {
    applyUpdate(settings, update);
    saveSettings(settings);
    pushState();
    return state();
  });

  // 任务管理 IPC
  ipcMain.handle(IPC.saveTask, (_e, taskData: Partial<TaskItem>) => {
    const tasks = loadTasks();
    // 自动模式或 Profile 还不存在时，留到任务执行时再自动创建
    const autoProfile = !!taskData.autoProfile;
    const { kernel, profile } = resolveKernelAndOptionalProfile(
      taskData.kernelId || taskData.kernel,
      autoProfile ? undefined : taskData.profileId || taskData.profile,
    );

    if (taskData.id) {
      const idx = tasks.findIndex((t) => t.id === taskData.id);
      if (idx !== -1) {
        tasks[idx] = {
          ...tasks[idx],
          ...taskData,
          kernelId: kernel.id,
          kernel: kernel.name,
          autoProfile,
          profileId: autoProfile ? "" : (profile?.id ?? ""),
          profile: autoProfile ? AUTO_PROFILE_LABEL : (profile?.name ?? ""),
          lastScheduledAt: Date.now(),
          updatedAt: Date.now(),
        } as TaskItem;
        taskData = tasks[idx]!;
      }
    } else {
      const newTask: TaskItem = {
        id: `task-${Date.now()}`,
        name: taskData.name || "新任务",
        goal: taskData.goal || "",
        url: taskData.url || "",
        doneCondition: taskData.doneCondition || "",
        kernelId: kernel.id,
        kernel: kernel.name,
        autoProfile,
        profileId: autoProfile ? "" : (profile?.id ?? ""),
        profile: autoProfile ? AUTO_PROFILE_LABEL : (profile?.name ?? ""),
        autoClose: taskData.autoClose ?? true,
        mode: taskData.mode || "now",
        schedule: taskData.schedule || "手动",
        cronExpr: taskData.cronExpr,
        repeatKind: taskData.repeatKind || "manual",
        repeatTime: taskData.repeatTime || "08:30",
        maxSteps: taskData.maxSteps || 30,
        timeoutMinutes: taskData.timeoutMinutes || 10,
        resultFormat: taskData.resultFormat || "text",
        lastStatus: "none",
        lastRunTime: "—",
        lastDuration: "—",
        lastScheduledAt: Date.now(),
        updatedAt: Date.now(),
      };
      tasks.unshift(newTask);
      taskData = newTask;
    }
    saveTasks(tasks);
    pushState();
    return taskData;
  });

  ipcMain.handle(IPC.deleteTask, (_e, id: string) => {
    const tasks = loadTasks().filter((t) => t.id !== id);
    saveTasks(tasks);
    pushState();
  });

  // 删除运行记录（正在执行的那次每步都会落盘，这里跳过它，否则下一步又会被写回来）
  ipcMain.handle(IPC.deleteRuns, (_e, ids: string[]) => {
    const activeId = taskRunner?.getActiveRun()?.id;
    const targets = new Set(Array.isArray(ids) ? ids.filter((x) => typeof x === "string" && x !== activeId) : []);
    if (targets.size === 0) return 0;
    const removed = getRunStore().remove([...targets]);
    if (removed > 0) pushState();
    return removed;
  });

  // 读取一次运行的完整记录（列表只带摘要，详情页按需来取）
  ipcMain.handle(IPC.getRun, (_e, id: string) => getRunStore().get(typeof id === "string" ? id : ""));

  // 执行与停止任务
  ipcMain.handle(IPC.runTask, (_e, id: string) => {
    taskRunner.runTask(id).catch((err) => emit({ type: "notice", message: errorMessage(err), isError: true }));
    return state();
  });

  // 运行中给 Agent 补充指令（不打断当前步骤）
  ipcMain.handle(IPC.interject, (_e, text: string) => taskRunner.interject(typeof text === "string" ? text : ""));

  // 从失败的运行记录重试：带上失败原因与最后页面继续
  ipcMain.handle(IPC.retryRun, (_e, runId: string) => {
    const run = getRunStore().get(runId);
    if (!run || run.status === "run") throw new Error(`未找到可重试的运行记录 #${runId}`);
    if (!run.taskId) throw new Error("这条运行记录没有关联的任务，无法重试。");
    taskRunner
      .runTask(run.taskId, "失败重试", run)
      .catch((err) => emit({ type: "notice", message: errorMessage(err), isError: true }));
    return state();
  });

  ipcMain.handle(IPC.cancelTask, () => {
    taskRunner.cancel();
    pushState();
  });

  // Profile 管理 IPC
  ipcMain.handle(IPC.createProfile, async (_e, kernelId: string, name: string) => {
    const created = await createProfileForKernel(kernelId, name);
    pushState();
    return created;
  });

  ipcMain.handle(IPC.saveProfile, (_e, profileData: Partial<ProfileItem>) => {
    updateProfileMeta(profileData);
    pushState();
  });

  ipcMain.handle(IPC.deleteProfile, (_e, id: string) => {
    removeProfileById(id);
    pushState();
  });

  // 手动打开指定浏览器内核与对应的 Profile
  ipcMain.handle(IPC.releaseProfile, async (_e, pid: number) => {
    try {
      await terminateProfileBrowser(pid, getAppBrowserProfilesDir());
      return { ok: true, message: "已关闭占用该 Profile 的浏览器" };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  });

  ipcMain.handle(IPC.openBrowser, async (_e, kernelId: string, profileId?: string, url?: string): Promise<BrowserActionResult> => {
    try {
      const { kernel, profile } = resolveKernelAndProfile(kernelId, profileId);
      await startBrowser(kernel.id, profile.id, url);
      return {
        ok: true,
        message: `已打开「${kernel.name}」· Profile「${profile.name}」，可在窗口中操作或登录网站`,
      };
    } catch (err) {
      return {
        ok: false,
        message: errorMessage(err),
        ...(err instanceof ProfileInUseError ? { lockedPid: err.pid } : {}),
      };
    }
  });

  // 测试指定浏览器内核与对应的 Profile
  ipcMain.handle(IPC.testBrowser, async (_e, kernelId: string, profileId?: string): Promise<BrowserActionResult> => {
    try {
      const { kernel, profile } = resolveKernelAndProfile(kernelId, profileId);
      const session = await startBrowser(kernel.id, profile.id);
      const res = await session.bridge.call("tabs_context_mcp", {}, { timeoutMs: 10_000 });
      if (res.isError) {
        return {
          ok: false,
          message: `扩展已连接但工具自检返回异常`,
        };
      }
      return {
        ok: true,
        message: `测试通过：「${kernel.name}」与 Profile「${profile.name}」扩展通信正常`,
      };
    } catch (err) {
      return {
        ok: false,
        message: `测试失败：${errorMessage(err)}`,
        ...(err instanceof ProfileInUseError ? { lockedPid: err.pid } : {}),
      };
    }
  });

  ipcMain.handle(IPC.showInFolder, (_e, targetPath: string) => {
    const cleanPath = targetPath.replace(/^~/, app.getPath("home"));
    if (existsSync(cleanPath)) {
      shell.showItemInFolder(cleanPath);
    } else {
      shell.openPath(path.dirname(cleanPath));
    }
  });

  // 浏览器内核 IPC
  ipcMain.handle(IPC.setDefaultProfile, (_e, profileId: string) => {
    if (!loadProfiles().some((p) => p.id === profileId)) throw new Error("找不到这个 Profile");
    saveDefaultProfile(profileId);
    pushState();
  });

  // 下载安装内核
  ipcMain.handle(IPC.installKernel, async (_e, kernelId: string) => {
    const provider = getProvider(kernelId);
    if (!isManagedProvider(provider)) return { ok: false, message: "该内核不支持由 App 安装。" };
    if (kernelRuntime.get(kernelId)?.installing) return { ok: false, message: "正在安装中，请稍候。" };

    kernelRuntime.set(kernelId, { installing: true });
    pushState();
    try {
      const k = await provider.install((p) => {
        kernelRuntime.set(kernelId, {
          installing: true,
          ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
          ...(p.message ? { message: p.message } : {}),
        });
        emit({
          type: "kernel_progress",
          kernelId,
          ...(p.fraction !== undefined ? { fraction: p.fraction } : {}),
          ...(p.message ? { message: p.message } : {}),
        });
      });
      kernelRuntime.delete(kernelId);
      pushState();
      return { ok: true, message: `「${provider.label}」${k.version ? ` ${k.version}` : ""} 已安装` };
    } catch (err) {
      const message = errorMessage(err);
      kernelRuntime.set(kernelId, {
        error: message,
        ...(err instanceof LicenseRequiredError ? { claimUrl: err.claimUrl } : {}),
      });
      pushState();
      return { ok: false, message };
    }
  });

  // 卸载内核（若正被当前浏览器使用则先关闭）
  ipcMain.handle(IPC.uninstallKernel, async (_e, kernelId: string) => {
    const provider = getProvider(kernelId);
    if (!isManagedProvider(provider)) return { ok: false, message: "该内核不支持由 App 卸载。" };
    if (kernelRuntime.get(kernelId)?.installing) return { ok: false, message: "正在安装中，无法卸载。" };
    try {
      if (browser?.browser.kernelId === kernelId) await closeCurrentBrowser();
      await provider.uninstall();
      kernelRuntime.delete(kernelId);
      pushState();
      return { ok: true, message: `「${provider.label}」已卸载（Profile 数据已保留）` };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  });

  // 保存内核授权 key
  ipcMain.handle(IPC.saveKernelLicense, async (_e, kernelId: string, key: string) => {
    const provider = getProvider(kernelId);
    if (!isManagedProvider(provider) || !provider.license) return { ok: false, message: "该内核不需要授权 key。" };
    try {
      await provider.license.saveKey(key);
      kernelRuntime.delete(kernelId);
      pushState();
      return { ok: true, message: "授权 key 已保存，可以下载内核了" };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  });

  // 用系统浏览器打开外部链接（仅限 https）
  ipcMain.handle(IPC.openExternal, async (_e, url: string) => {
    if (typeof url === "string" && /^https:\/\//.test(url)) await shell.openExternal(url);
  });

  // 剪贴板工具
  ipcMain.handle(IPC.copyText, (_e, text: string) => {
    clipboard.writeText(text);
    emit({ type: "notice", message: "已复制到剪贴板" });
  });

  // 主题模式控制
  ipcMain.handle(IPC.setTheme, (_e, theme: ThemeMode) => {
    nativeTheme.themeSource = theme;
    if (window && process.platform !== "darwin") {
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0f0f11" : "#fbfbfa");
    }
  });
}

/** 创建主应用窗口 */
function createWindow() {
  const iconPath = appIconPath();
  const isMac = process.platform === "darwin";
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    title: "Agent 任务台",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#0f0f11" : "#fbfbfa",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    ...(isMac
      ? {
          vibrancy: "sidebar",
          visualEffectState: "active",
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.loadFile(path.join(__dirname, "renderer", "index.html"));
  window.on("closed", () => (window = null));
}

// Electron 启动入口
app.whenReady().then(() => {
  app.setName("Agent 任务台");

  protocol.handle("shot", (request) => {
    const [, runId = "", file = ""] = new URL(request.url).pathname.split("/");
    const full = getRunStore().shotPath(runId, file);
    return full ? net.fetch(pathToFileURL(full).toString()) : new Response("not found", { status: 404 });
  });

  settings = loadSettings();
  initProviders({ kernelsDir: path.join(app.getPath("userData"), "kernels") });

  taskRunner = new TaskRunner(
    emit,
    state,
    (kernelId, profileId, initialUrl) => startBrowser(kernelId, profileId, initialUrl),
    () => closeCurrentBrowser(),
    (bSession, opts) => createAgentForSession(bSession, opts),
  );

  taskRunner.recoverInterruptedRuns();

  scheduler = new Scheduler({
    loadTasks,
    saveTasks,
    isBusy: () => taskRunner.isRunning(),
    run: (taskId) => taskRunner.runTask(taskId, "定时触发"),
    notify: (message, isError) => emit({ type: "notice", message, ...(isError ? { isError: true } : {}) }),
    onQueueChange: pushState,
  });
  taskRunner.onIdle = () => scheduler.pump();
  scheduler.start();

  registerIpc();
  createWindow();
});

// macOS 习惯：关掉窗口不退出，应用留在后台，定时任务才能继续运行；⌘Q 才真正退出。
// 其他系统上关窗口就是退出。
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 窗口被关掉后，点 Dock 图标把它重新打开
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !browser) return;
  event.preventDefault();
  quitting = true;
  taskRunner?.cancel();
  void browser.close().finally(() => app.quit());
});
