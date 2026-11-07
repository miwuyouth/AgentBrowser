import { BrowserWindow, app, clipboard, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import { existsSync } from "node:fs";
import path from "node:path";
import { AgentSession, createProvider } from "@agent-browser/agent";
import { findBrowser, startBrowserSession, type BrowserSession } from "@agent-browser/bridge";
import {
  activeProviderConfig,
  applyUpdate,
  loadSettings,
  saveSettings,
  view,
  type StoredSettings,
} from "./settings.ts";
import {
  IPC,
  type AppState,
  type BrowserStatus,
  type ProfileItem,
  type SettingsUpdate,
  type TaskItem,
  type UiEvent,
} from "./shared.ts";
import {
  createProfileForKernel,
  getKernelsList,
  loadProfiles,
  loadRuns,
  loadTasks,
  removeProfileById,
  resolveKernelAndProfile,
  saveDefaultKernel,
  saveTasks,
  updateProfileMeta,
} from "./storage.ts";
import { TaskRunner } from "./task-runner.ts";

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

/** 主进程向渲染窗口推送 UI 事件 */
function emit(e: UiEvent) {
  window?.webContents.send(IPC.event, e);
}

/** 组装发送给渲染进程的当前应用状态 */
function state(): AppState {
  const browserLabel = browser
    ? `${browser.browser.browser.name || browser.browser.browser.kind} (${browser.browser.profile || "Default"})`
    : undefined;

  const tasks = loadTasks();
  const runs = loadRuns();
  const kernels = getKernelsList();
  const profiles = loadProfiles();
  const activeRun = taskRunner?.getActiveRun() || undefined;

  const nextScheduledTask = tasks.find((t) => t.mode === "cron");

  return {
    browser: browserStatus,
    ...(browserError ? { browserError } : {}),
    ...(browserLabel ? { browserInfo: browserLabel } : {}),
    provider: view(settings, settings.provider),
    providers: { anthropic: view(settings, "anthropic"), "openai-compatible": view(settings, "openai-compatible") },
    running: taskRunner?.isRunning() ?? false,
    tasks,
    runs,
    kernels,
    profiles,
    activeRun,
    scheduler: {
      running: true,
      nextTime: nextScheduledTask ? nextScheduledTask.schedule || "已就绪" : "未配置定时任务",
      nextTask: nextScheduledTask ? nextScheduledTask.name : "暂无等待任务",
    },
  };
}

/** 推送全量状态更新到渲染进程 */
const pushState = () => emit({ type: "state", state: state() });

/** 根据当前配置与指定浏览器会话创建 Agent 实例 */
function createAgentForSession(session: BrowserSession): AgentSession {
  const config = activeProviderConfig(settings);
  if (typeof config === "string") throw new Error(config);
  return new AgentSession({ bridge: session.bridge, provider: createProvider(config) });
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
  const executable = findBrowser(kernel.path) || findBrowser(kernel.id);
  if (!executable) {
    throw new Error(`未找到选定的 Chromium 浏览器（${kernel.name}）。`);
  }

  if (browser && browserStatus === "connected") {
    const curExecutablePath = browser.browser.browser.path;
    const curUserDataDir = browser.browser.userDataDir;
    // 如果当前正在运行的内核路径与 Profile 数据目录完全一致，直接复用
    if (curExecutablePath === executable.path && curUserDataDir === profile.dir) {
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
      browser: executable,
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

    session.browser.process.once("exit", () => {
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
    browserError = err instanceof Error ? err.message : String(err);
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
    const { kernel, profile } = resolveKernelAndProfile(
      taskData.kernelId || taskData.kernel,
      taskData.profileId || taskData.profile,
    );

    if (taskData.id) {
      const idx = tasks.findIndex((t) => t.id === taskData.id);
      if (idx !== -1) {
        tasks[idx] = {
          ...tasks[idx],
          ...taskData,
          kernelId: kernel.id,
          kernel: kernel.name,
          profileId: profile.id,
          profile: profile.name,
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
        profileId: profile.id,
        profile: profile.name,
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
        createdAt: Date.now(),
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

  // 执行与停止任务
  ipcMain.handle(IPC.runTask, (_e, id: string) => {
    void taskRunner.runTask(id);
    return state();
  });

  ipcMain.handle(IPC.cancelTask, () => {
    taskRunner.cancel();
    pushState();
  });

  // Profile 管理 IPC
  ipcMain.handle(IPC.createProfile, (_e, kernelId: string, name: string) => {
    const created = createProfileForKernel(kernelId, name);
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
  ipcMain.handle(IPC.openBrowser, async (_e, kernelId: string, profileId?: string, url?: string) => {
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
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });

  // 测试指定浏览器内核与对应的 Profile
  ipcMain.handle(IPC.testBrowser, async (_e, kernelId: string, profileId?: string) => {
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
        message: `测试失败：${err instanceof Error ? err.message : String(err)}`,
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
  ipcMain.handle(IPC.setDefaultKernel, (_e, kernelId: string) => {
    saveDefaultKernel(kernelId);
    pushState();
  });

  ipcMain.handle(IPC.rescanKernels, () => {
    const kernels = getKernelsList();
    pushState();
    return kernels;
  });

  // 剪贴板工具
  ipcMain.handle(IPC.copyText, (_e, text: string) => {
    clipboard.writeText(text);
    emit({ type: "notice", message: "已复制到剪贴板" });
  });

  // 主题模式控制
  ipcMain.handle(IPC.setTheme, (_e, theme: "dark" | "light" | "system") => {
    nativeTheme.themeSource = theme;
    if (window) {
      window.setBackgroundColor(nativeTheme.shouldUseDarkColors ? "#0F1113" : "#F6F8FA");
    }
  });
}

/** 创建主应用窗口 */
function createWindow() {
  const iconPath = appIconPath();
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    title: "Agent 任务台",
    ...(existsSync(iconPath) ? { icon: iconPath } : {}),
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#191919" : "#FAFAFA",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
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
  const iconPath = appIconPath();
  if (process.platform === "darwin" && app.dock && existsSync(iconPath)) {
    try {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    } catch {}
  }

  settings = loadSettings();

  taskRunner = new TaskRunner(
    emit,
    state,
    (kernelId, profileId, initialUrl) => startBrowser(kernelId, profileId, initialUrl),
    () => closeCurrentBrowser(),
    (bSession) => createAgentForSession(bSession),
  );

  registerIpc();
  createWindow();

});

app.on("window-all-closed", () => app.quit());

let quitting = false;
app.on("before-quit", (event) => {
  if (quitting || !browser) return;
  event.preventDefault();
  quitting = true;
  taskRunner?.cancel();
  void browser.close().finally(() => app.quit());
});
