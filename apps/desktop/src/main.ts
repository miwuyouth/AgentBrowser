import {
  BrowserWindow,
  Menu,
  Notification,
  Tray,
  app,
  clipboard,
  dialog,
  ipcMain,
  nativeImage,
  nativeTheme,
  net,
  powerMonitor,
  protocol,
  shell,
} from "electron";
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
import { finishNotice, quitWarning, trayStatus, type QuitWarning } from "./background.ts";
import { listModels, testModel } from "./model-probe.ts";
import {
  activeProviderConfig,
  applyUpdate,
  loadSettings,
  probeTarget,
  saveSettings,
  view,
  type StoredSettings,
} from "./settings.ts";
import {
  AUTO_PROFILE_LABEL,
  IPC,
  errorMessage,
  lightRun,
  type AppState,
  type BrowserActionResult,
  type GeneralSettings,
  type GeneralSettingsView,
  type BrowserStatus,
  type ProfileItem,
  type ModelProbeRequest,
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

// 截图以 shot://run/<运行ID>/<文件名> 的自定义协议提供给界面，彻底避免把体积巨大的 base64 塞进 IPC 消息中。
// 必须在 app.whenReady() 之前注册特权方案。
protocol.registerSchemesAsPrivileged([{ scheme: "shot", privileges: { standard: true, secure: true, supportFetchAPI: true } }]);

/**
 * 获取配套 Chrome 浏览器扩展的构建产物目录。
 *
 * 【调用时机】
 * 在 `startBrowser` 启动浏览器并装载扩展插件前调用。
 *
 * 【作用】
 * 优先读取环境变量指定的路径；
 * 若应用已打包，则定位到安装包内的 resources/extension 目录；
 * 若处于开发环境，则直接解析 monorepo 中 packages/extension/dist 的构建产物路径。
 *
 * @returns 扩展产物目录的绝对路径
 */
function extensionDir(): string {
  if (process.env.AGENT_BROWSER_EXTENSION_DIR) return process.env.AGENT_BROWSER_EXTENSION_DIR;
  return app.isPackaged ? path.join(process.resourcesPath, "extension") : path.resolve(__dirname, "../../../packages/extension/dist");
}

/**
 * 获取桌面端产品应用图标文件路径。
 *
 * 【调用时机】
 * 在 `createWindow` 创建 Electron 主窗口时调用。
 *
 * 【作用】
 * 优先在当前构建目录寻找 icon.png，若不存在则回退至源码 assets/icon.png 路径。
 *
 * @returns 图标文件的绝对路径
 */
function appIconPath(): string {
  return assetPath("icon.png");
}

/**
 * 定位随应用分发的图片素材：优先构建目录（dist/），开发时回退到源码 assets/。
 *
 * 【调用时机】取窗口图标、菜单栏（托盘）图标时调用。
 */
function assetPath(name: string): string {
  const distFile = path.join(__dirname, name);
  if (existsSync(distFile)) return distFile;
  return path.resolve(__dirname, "../assets", name);
}

/** Electron 主窗口引用 */
let window: BrowserWindow | null = null;
/** 本地持久化的全量模型设置 */
let settings: StoredSettings;
/** 当前打开的浏览器会话引用 */
let browser: BrowserSession | null = null;
/** 浏览器连接状态 */
let browserStatus: BrowserStatus = "stopped";
/** 浏览器启动或连接过程中的错误信息 */
let browserError: string | undefined;
/** 全局任务运行器实例 */
let taskRunner: TaskRunner;
/** 全局定时调度器实例 */
let scheduler: Scheduler;

const isMac = process.platform === "darwin";
/** 菜单栏（macOS）/ 系统托盘（Windows、Linux）图标 */
let tray: Tray | null = null;
/** 已经确认要退出（或者无需确认）；之后窗口的 close 不再拦截成「躲进后台」 */
let allowQuit = false;
/** 退出确认框是否正在显示，避免连按 ⌘Q 叠出多个 */
let confirmingQuit = false;
/** 正在关闭浏览器、等它关完再退出 */
let closingBrowser = false;
/** 系统正在关机 / 重启：不弹任何确认框挡住关机 */
let systemShutdown = false;
/** 系统通知必须保持引用，否则被回收后点击事件会丢 */
const liveNotifications = new Set<Notification>();
/** Windows 登录项带上这个参数，用来识别「开机自动启动」 */
const HIDDEN_ARG = "--hidden";

/** 内核下载安装的实时运行时状态（仅保留在内存中，不持久化） */
interface KernelRuntime {
  installing?: boolean;
  fraction?: number;
  message?: string;
  error?: string;
  claimUrl?: string;
}
const kernelRuntime = new Map<string, KernelRuntime>();

/**
 * 主进程向渲染窗口单向推送 UI 事件。
 *
 * 【调用时机】
 * 状态更新、任务执行步骤推进、内核下载进度更新或发送操作轻提示通知时调用。
 *
 * 【作用】
 * 通过主窗口的 `webContents.send` 将特定事件广播至预加载脚本及前端监听器。
 *
 * @param e 待广播的 UI 事件对象
 */
function emit(e: UiEvent) {
  window?.webContents.send(IPC.event, e);
  // Linux 的托盘菜单不能在点击时现做，只能跟着状态刷新
  if (e.type === "state" && tray && process.platform === "linux") tray.setContextMenu(trayMenu());
}

/**
 * 组装发送给渲染进程的当前应用全量状态对象。
 *
 * 【调用时机】
 * 1. 渲染进程通过 IPC `IPC.getState` 主动拉取初始数据时调用；
 * 2. `pushState` 广播最新全量状态时内部调用。
 *
 * 【作用】
 * 聚合任务列表、历史运行记录摘要、已安装内核（合并实时下载进度）、Profile 列表、当前激活的模型配置脱敏视图及运行中任务等，构成一体化状态快照。
 *
 * @returns 完整的 AppState 对象
 */
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
  const running = taskRunner?.getActiveRun();
  const activeRun = running ? lightRun(running) : undefined;

  return {
    platform: process.platform,
    general: generalView(),
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

/**
 * 推送全量状态更新到渲染进程。
 *
 * 【调用时机】
 * 任何触发数据变更的操作后（如任务创建/修改/删除、设置变更、排队队列变动、内核状态变动等）调用。
 *
 * 【作用】
 * 调用 `state()` 生成全量快照，并发送 `type: "state"` 事件同步给前端界面。
 */
const pushState = () => emit({ type: "state", state: state() });

// ───────────────────────────── 后台常驻：通用设置、窗口、托盘、退出确认、系统通知 ─────────────────────────────

/** 开机启动不可用的原因；可用时返回 undefined */
function loginItemNote(): string | undefined {
  if (process.platform === "linux") return "当前系统暂不支持";
  if (!app.isPackaged) return "开发模式下不可用，打包安装后才能设置";
  return undefined;
}

/** Windows 读写登录项时要带上同样的参数，才能对应到同一条登录项 */
const loginItemQuery = () => (process.platform === "win32" ? { args: [HIDDEN_ARG] } : {});

/**
 * 组装发给界面的通用设置。
 * 开机启动以系统登录项为准（用户可能在系统设置里手动关掉）。
 */
function generalView(): GeneralSettingsView {
  const note = loginItemNote();
  return {
    keepInBackground: settings.general.keepInBackground,
    notifyOnFinish: settings.general.notifyOnFinish,
    quitWarn: settings.general.quitWarn,
    openAtLogin: note ? false : app.getLoginItemSettings(loginItemQuery()).openAtLogin,
    ...(note ? { loginItemNote: note } : {}),
  };
}

/**
 * 修改通用设置（「设置 › 通用」里的开关）。
 *
 * 【调用时机】渲染进程 IPC `settings:save-general`。
 * 【作用】只改传进来的项：开机启动写进系统登录项，其余写进 settings.json。
 */
function saveGeneral(patch: Partial<GeneralSettings>) {
  const g = settings.general;
  if (typeof patch.keepInBackground === "boolean") g.keepInBackground = patch.keepInBackground;
  if (typeof patch.notifyOnFinish === "boolean") g.notifyOnFinish = patch.notifyOnFinish;
  if (typeof patch.quitWarn === "boolean") g.quitWarn = patch.quitWarn;
  if (typeof patch.openAtLogin === "boolean") {
    const note = loginItemNote();
    if (note) throw new Error(`无法设置开机启动：${note}`);
    app.setLoginItemSettings({ openAtLogin: patch.openAtLogin, ...loginItemQuery() });
  }
  saveSettings(settings);
  pushState();
}

/** 托盘菜单与退出确认需要的「现在有什么在跑、接下来跑什么」 */
const runContext = () => ({
  tasks: loadTasks(),
  ...(taskRunner?.getActiveRun() ? { runningName: taskRunner.getActiveRun()!.name } : {}),
  queued: scheduler?.queued() ?? [],
  now: Date.now(),
});

/**
 * 把窗口拿到前台。
 *
 * 【调用时机】点托盘「打开」、点 Dock 图标、点系统通知、再次启动应用（第二个实例）时调用。
 * 【作用】macOS 上先把 Dock 图标请回来；窗口不存在就新建，藏起来了就显示并聚焦。
 */
function showWindow() {
  if (isMac) void app.dock?.show();
  if (!window) {
    createWindow();
    return;
  }
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/**
 * 关掉窗口时躲进后台：窗口只是藏起来，应用继续运行，定时任务照常执行。
 *
 * 【调用时机】开启「关闭窗口后留在后台」时，用户点红叉 / ⌘W，或在退出确认框里选「保持在后台」。
 * 【作用】藏起窗口，macOS 上同时藏起 Dock 图标，只留菜单栏图标；第一次会发一条系统通知告诉用户应用还在。
 */
function hideToBackground() {
  window?.hide();
  if (isMac) app.dock?.hide();
  if (!settings.general.closeHintShown) {
    settings.general.closeHintShown = true;
    saveSettings(settings);
    notify({
      title: `${app.getName()} 仍在后台运行`,
      body: `定时任务会照常执行。点${isMac ? "菜单栏" : "任务栏托盘"}里的图标可以打开或退出。`,
    });
  }
}

/**
 * 发一条系统通知。
 *
 * 【调用时机】任务跑完、第一次躲进后台时调用。
 * 【作用】系统不支持通知时什么也不做；点击通知执行 onClick。通知对象在关闭/点击前一直保留引用。
 */
function notify(opts: { title: string; body: string }, onClick?: () => void) {
  if (!Notification.isSupported()) return;
  const n = new Notification({ ...opts, ...(isMac ? {} : { icon: appIconPath() }) });
  liveNotifications.add(n);
  const drop = () => liveNotifications.delete(n);
  n.on("click", () => {
    drop();
    onClick?.();
  });
  n.on("close", drop);
  n.show();
}

/**
 * 打开窗口并跳到某次运行的详情。
 *
 * 【调用时机】用户点了「任务完成」系统通知。
 */
function openRun(runId: string) {
  showWindow();
  const send = () => emit({ type: "open_run", runId });
  if (window?.webContents.isLoading()) window.webContents.once("did-finish-load", send);
  else send();
}

/**
 * 任务跑完时按设置发系统通知。
 *
 * 【调用时机】TaskRunner.onFinished。
 * 【作用】用户自己停止的、关掉了通知开关的、正在看着这个窗口的（界面里已有轻提示）都不发。
 */
function notifyRunFinished(run: Parameters<typeof finishNotice>[0] & { id: string }, byUser: boolean) {
  if (byUser || !settings.general.notifyOnFinish) return;
  if (window?.isVisible() && window.isFocused()) return;
  notify(finishNotice(run), () => openRun(run.id));
}

/** 托盘菜单：一行只读状态 + 打开 + 退出 */
function trayMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: trayStatus(runContext()), enabled: false },
    { type: "separator" },
    { label: `打开 ${app.getName()}`, click: showWindow },
    { label: "退出", click: () => app.quit() },
  ]);
}

/**
 * 创建菜单栏（macOS）/ 系统托盘（Windows、Linux）图标。
 *
 * 【调用时机】应用启动时调用一次。
 * 【作用】macOS 用单色模板图（跟随菜单栏明暗），点击弹出菜单；Windows 左键打开窗口、右键弹出菜单；
 * Linux 只能预先挂菜单，所以每次状态变化时刷新（见 emit）。
 */
function createTray() {
  const image = isMac
    ? nativeImage.createFromPath(assetPath("trayTemplate.png"))
    : nativeImage.createFromPath(appIconPath()).resize({ width: 16, height: 16 });
  if (isMac) image.setTemplateImage(true);
  tray = new Tray(image);
  tray.setToolTip(app.getName());
  if (process.platform === "linux") {
    tray.setContextMenu(trayMenu());
    return;
  }
  tray.on("click", () => (isMac ? tray?.popUpContextMenu(trayMenu()) : showWindow()));
  tray.on("right-click", () => tray?.popUpContextMenu(trayMenu()));
}

/**
 * 退出前确认。
 *
 * 【调用时机】before-quit 里 quitWarning 认为需要确认时调用。
 * 【作用】窗口可见时以表单（sheet）形式挂在窗口上；默认按钮是「保持在后台 / 取消」，防止误按回车退出。
 * 选「退出」才真正退出；勾了「不再提醒」就关掉设置里的「退出前提醒」。
 */
async function confirmQuit(warning: QuitWarning) {
  confirmingQuit = true;
  const keep = settings.general.keepInBackground;
  const parent = window?.isVisible() ? window : undefined;
  if (!parent && isMac) app.focus({ steal: true });
  const options: Electron.MessageBoxOptions = {
    type: "warning",
    message: warning.message,
    detail: warning.detail,
    buttons: [keep ? "保持在后台" : "取消", "退出"],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
    ...(warning.canMute ? { checkboxLabel: "不再提醒" } : {}),
  };
  const result = await (parent ? dialog.showMessageBox(parent, options) : dialog.showMessageBox(options));
  confirmingQuit = false;
  if (result.response !== 1) {
    if (keep) hideToBackground();
    return;
  }
  if (warning.canMute && result.checkboxChecked) {
    settings.general.quitWarn = false;
    saveSettings(settings);
  }
  allowQuit = true;
  app.quit();
}

/**
 * 根据当前配置与指定浏览器会话创建 Agent 实例。
 *
 * 【调用时机】
 * 在 `TaskRunner.runTask` 启动准备阶段由工场函数回调触发。
 *
 * 【作用】
 * 1. 检查并获取当前激活提供商的模型配置；
 * 2. 挂载文件授权门控（`makeFilePermissionGate`）；
 * 3. 构造并返回 `@agent-browser/agent` 的 `AgentSession` 实例。
 *
 * @param session 已建立连接的浏览器会话
 * @param opts 运行选项，如步数上限
 * @returns 实例化完成的 AgentSession
 */
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

/**
 * 创建单次任务执行范围内的文件读取授权校验回调函数。
 *
 * 【调用时机】
 * 在 `createAgentForSession` 内部调用，为当前 AgentSession 单独生成授权闭包。
 *
 * 【作用】
 * 类似 macOS TCC 权限控制，当 Agent 尝试通过工具读取本地文件上传至网页时触发弹窗拦截：
 * - 用户可选择「允许一次」、「总是允许」（仅在此次运行内记住）或「拒绝」；
 * - 拦截结果实时发送通知消息并向 Agent 返回授权布尔值，防止本地隐私敏感文件被无感知读取。
 *
 * @returns 接受文件绝对路径并异步返回是否允许读取的门控函数
 */
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

/**
 * 安全关闭当前运行中的浏览器会话。
 *
 * 【调用时机】
 * 1. 任务设置了 `autoClose: true` 并在任务结束后由 TaskRunner 调用；
 * 2. 准备启动新内核/Profile，需先关闭之前旧内核实例时调用；
 * 3. 卸载正在运行中的内核前调用；
 * 4. 应用退出前（`before-quit`）调用。
 *
 * 【作用】
 * 异步调用底层的 `browser.close()` 释放进程资源，将全局 `browserStatus` 重置为 "stopped" 并同步推送最新状态。
 */
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

/**
 * 启动指定内核与对应 Profile 的浏览器进程，并等待自研扩展通过 WebSocket 连接。
 *
 * 【调用时机】
 * 1. 任务运行器启动任务执行前调用；
 * 2. 用户在前端环境管理界面点击"打开浏览器"进行人工操作/登录时调用；
 * 3. 用户在前端点击"测试连接"时调用。
 *
 * 【作用】
 * 1. 解析目标内核与 Profile，确认已下载安装；
 * 2. 检查当前已启动的浏览器，若内核与数据目录完全相同则直接复用；若不同则先安全关闭旧实例；
 * 3. 状态标记为 "starting"，调用 `startBrowserSession` 拉起浏览器进程并自动挂载配套扩展；
 * 4. 监听 Bridge 的 connected、disconnected 及进程 onExit 事件，实时维护连接状态。
 *
 * @param targetKernel 目标内核标识或名称（可选）
 * @param targetProfile 目标 Profile 标识或名称（可选）
 * @param initialUrl 启动后默认导航的初始网址（可选）
 * @returns 建立连接后的 BrowserSession 实例
 */
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

/**
 * 注册主进程与渲染进程之间的所有 IPC 交互通道。
 *
 * 【调用时机】
 * 应用初始化就绪阶段（`app.whenReady()`）在创建主窗口前调用。
 *
 * 【作用】
 * 为任务增删改查、运行控制、Profile 管理、内核下载/卸载/授权、主题控制等数十个业务通道绑定处理句柄。
 */
function registerIpc() {
  ipcMain.handle(IPC.getState, () => state());

  // 保存模型设置
  ipcMain.handle(IPC.saveSettings, (_e, update: SettingsUpdate) => {
    applyUpdate(settings, update);
    saveSettings(settings);
    pushState();
    return state();
  });

  // 通用设置：开关拨动即生效
  ipcMain.handle(IPC.saveGeneral, (_e, patch: Partial<GeneralSettings>) => {
    saveGeneral(patch ?? {});
    return state();
  });

  // 模型列表与连通性测试（使用表单当前值，不要求先保存）
  ipcMain.handle(IPC.listModels, (_e, req: ModelProbeRequest) => listModels(probeTarget(settings, req)));
  ipcMain.handle(IPC.testModel, (_e, req: ModelProbeRequest) => testModel(probeTarget(settings, req), (req.model ?? "").trim()));

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
        fields: taskData.fields,
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

  // 从失败的运行记录重试：独立重新执行该任务
  ipcMain.handle(IPC.retryRun, (_e, runId: string) => {
    const run = getRunStore().get(runId);
    if (!run || run.status === "run") throw new Error(`未找到可重试的运行记录 #${runId}`);
    if (!run.taskId) throw new Error("这条运行记录没有关联的任务，无法重试。");
    taskRunner
      .runTask(run.taskId, "失败重试")
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

  // 释放被占用的 Profile 目录
  ipcMain.handle(IPC.releaseProfile, async (_e, pid: number) => {
    try {
      await terminateProfileBrowser(pid, getAppBrowserProfilesDir());
      return { ok: true, message: "已关闭占用该 Profile 的浏览器" };
    } catch (err) {
      return { ok: false, message: errorMessage(err) };
    }
  });

  // 手动打开指定浏览器内核与对应的 Profile
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

/**
 * 创建应用主窗口。
 *
 * 【调用时机】
 * 1. 在 `app.whenReady()` 启动完毕后调用；
 * 2. 在 macOS 环境下用户关闭窗口后重新点击 Dock 应用图标（`activate` 事件）时调用。
 *
 * 【作用】
 * 创建并配置 Electron 主窗口：设置尺寸、最小限制、macOS 毛玻璃侧边栏（vibrancy）、红绿灯位置、隔离沙箱与预加载脚本，并加载渲染页面。
 */
function createWindow({ show = true }: { show?: boolean } = {}) {
  const iconPath = appIconPath();
  window = new BrowserWindow({
    show,
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
  // 关窗口（红叉 / ⌘W）：开启了后台常驻就只是藏起来；否则当作退出（会先走退出确认）
  window.on("close", (event) => {
    if (allowQuit) return;
    event.preventDefault();
    if (settings.general.keepInBackground) hideToBackground();
    else app.quit();
  });
  window.on("closed", () => (window = null));
}

// 只允许一个实例：应用常驻后台时再次打开它，应该把已有的窗口拿出来，而不是再起一个（否则会有两个调度器重复跑任务）
const isPrimaryInstance = app.requestSingleInstanceLock();
if (!isPrimaryInstance) app.exit(0);
app.on("second-instance", () => {
  if (settings) showWindow();
});

// Electron 启动主入口
app.whenReady().then(() => {
  if (!isPrimaryInstance) return;
  app.setName("Agent 任务台");

  // 自定义截图协议处理句柄：shot://run/<runId>/<file>
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

  taskRunner.onFinished = (run, byUser) => notifyRunFinished(run, byUser);

  registerIpc();
  createTray();

  // 开机自动启动时不弹窗口，只在菜单栏 / 托盘里待命（窗口照常创建好，点通知或「打开」时立刻能用）
  const atLogin = process.argv.includes(HIDDEN_ARG) || (isMac && app.getLoginItemSettings().wasOpenedAtLogin);
  createWindow({ show: !atLogin });
  if (atLogin && isMac) app.dock?.hide();
});

// 系统关机 / 重启：不弹退出确认，免得挡住关机（Windows 关机不会触发 before-quit，无需处理）
app.whenReady().then(() => powerMonitor.on("shutdown", () => (systemShutdown = true)));

// 关窗口不会走到这里（close 事件里已拦截成「躲进后台」或「退出」）；窗口全关只会发生在退出过程中

// 点 Dock 图标：把窗口拿出来
app.on("activate", () => {
  if (settings) showWindow();
});

// 真正退出（⌘Q、托盘「退出」、Dock 退出、未开启后台常驻时关窗口）
app.on("before-quit", (event) => {
  if (!allowQuit) {
    const warning = systemShutdown
      ? null
      : quitWarning({ ...runContext(), warnScheduled: settings?.general.quitWarn ?? false });
    if (warning) {
      event.preventDefault();
      if (!confirmingQuit) void confirmQuit(warning);
      return;
    }
    allowQuit = true;
  }
  // 先中断正在跑的任务、关掉浏览器，再退出
  taskRunner?.cancel();
  if (closingBrowser || !browser) return;
  event.preventDefault();
  closingBrowser = true;
  void browser.close().finally(() => app.quit());
});
