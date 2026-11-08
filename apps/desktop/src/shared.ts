import type { Effort } from "@agent-browser/agent";

/** 浏览器运行状态 */
export type BrowserStatus = "stopped" | "starting" | "connected" | "error";

/** 模型提供商类型 */
export type ProviderKind = "anthropic" | "openai-compatible";

/** 任务状态 */
export type TaskStatus = "ok" | "run" | "fail" | "none";

/** 任务执行模式 */
export type TaskMode = "now" | "cron";

/** 任务结构定义 */
export interface TaskItem {
  id: string;
  name: string;
  goal: string;
  url?: string;
  doneCondition?: string;
  /** 所选浏览器内核 ID */
  kernelId: string;
  /** 所选浏览器内核显示名称 */
  kernel: string;
  /** 所选 Profile ID（与 kernelId 对应） */
  profileId: string;
  /** 所选 Profile 显示名称 */
  profile: string;
  /** 为 true 时每次执行任务都自动新建一个 Profile，profileId 留空 */
  autoProfile?: boolean;
  /** 任务完成后是否自动关闭浏览器 */
  autoClose: boolean;
  mode: TaskMode;
  schedule: string;
  cronExpr?: string;
  repeatKind?: "daily" | "weekday" | "weekly" | "hours" | "once" | "manual";
  repeatTime?: string;
  /** 调度器最近一次处理过的计划时刻（毫秒时间戳）；用来避免重复触发、识别错过的时刻 */
  lastScheduledAt?: number;
  maxSteps: number;
  timeoutMinutes: number;
  resultFormat: "text" | "json" | "markdown";
  lastStatus: TaskStatus;
  lastRunTime?: string;
  lastDuration?: string;
  updatedAt: number;
}

/** 运行步骤结构 */
export interface RunStep {
  stepNumber: number;
  status: "done" | "run" | "todo";
  tag: string;
  text: string;
  meta: string;
  think?: string;
  screenshot?: string;
  url?: string;
}

/** 一次运行的最终结果。目前只有文字；以后支持结构化数据时，在这里新增一个 kind 即可 */
export type RunResult = { kind: "text"; text: string } | { kind: "markdown"; text: string };

/** 单次运行记录结构 */
export interface RunRecord {
  id: string;
  taskId?: string;
  name: string;
  status: "ok" | "run" | "fail";
  when: string;
  startTime: number;
  endTime?: number;
  trigger: string;
  facts: { k: string; v: string }[];
  summary: string;
  /** 结构化的最终结果；缺省时界面用 summary 兜底 */
  result?: RunResult;
  hasError?: boolean;
  error?: string;
  advice?: string;
  /** Agent 最后导航到的页面地址；失败重试时从这里继续 */
  lastUrl?: string;
  steps: RunStep[];
}

/** 浏览器内核展示卡片结构 */
export interface KernelItem {
  id: string;
  /** 由哪个 BrowserProvider 负责启动 */
  providerId: string;
  /** 是否已下载安装到 App 的内核目录 */
  installed: boolean;
  /** 正在下载安装 */
  installing?: boolean;
  /** 安装进度 0 到 1；缺省表示无法得知 */
  progress?: number;
  progressText?: string;
  /** 上一次安装失败的原因 */
  installError?: string;
  /** 该内核需要授权 key 才能使用 */
  needsLicense?: boolean;
  /** 需要授权 key 但尚未设置 */
  licenseMissing?: boolean;
  /** 领取授权 key 的页面 */
  claimUrl?: string;
  name: string;
  ver: string;
  source: string;
  path: string;
  usage: string;
  isDefault?: boolean;
}

/** Profile 展示卡片结构（每个 Profile 绑定到对应的浏览器内核） */
export interface ProfileItem {
  id: string;
  name: string;
  initial: string;
  /** 所属浏览器内核 ID */
  kernelId: string;
  /** 所属浏览器内核名称 */
  kernel: string;
  /** 负责启动该 Profile 的 BrowserProvider */
  providerId: string;
  /** 指纹配置（仅指纹型浏览器有，内容由对应 provider 解释，例如 CloakBrowser 的 seed） */
  fingerprint?: Record<string, unknown>;
  /** 是否为该内核的默认 Profile */
  isDefault?: boolean;
  usage: string;
  size: string;
  dir: string;
}

/** 模型服务提供商配置视图 */
export interface ProviderSettingsView {
  kind: ProviderKind;
  baseURL: string;
  model: string;
  findModel: string;
  effort: Effort;
  vision: boolean;
  credentials: "stored" | "environment" | "none";
}

/** 全局桌面应用状态 */
export interface AppState {
  browser: BrowserStatus;
  browserError?: string;
  provider: ProviderSettingsView;
  providers: Record<ProviderKind, ProviderSettingsView>;
  running: boolean;
  /** 因为已有任务在运行而排队等待的任务 ID，按先后顺序 */
  queued: string[];
  tasks: TaskItem[];
  runs: RunRecord[];
  kernels: KernelItem[];
  profiles: ProfileItem[];
  activeRun?: RunRecord;
}

/** 保存设置时的更新载荷（仅模型配置） */
export interface SettingsUpdate {
  kind: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
  findModel?: string;
  effort?: Effort;
  vision?: boolean;
}

/** 转发给渲染窗口的 UI 事件类型 */
export type UiEvent =
  | { type: "state"; state: AppState }
  | { type: "run_update"; run: RunRecord }
  | { type: "kernel_progress"; kernelId: string; fraction?: number; message?: string }
  | { type: "notice"; message: string; isError?: boolean };

export type ThemeMode = "dark" | "light" | "system";

/** 手动打开 / 测试连接的结果；Profile 被残留浏览器占用时带上占用者的 PID */
export interface BrowserActionResult {
  ok: boolean;
  message: string;
  lockedPid?: number;
}

/** Preload 脚本暴露给 window.agentApi 的接口定义 */
export interface AgentApi {
  getState(): Promise<AppState>;
  saveSettings(update: SettingsUpdate): Promise<AppState>;
  saveTask(task: Partial<TaskItem>): Promise<TaskItem>;
  deleteTask(id: string): Promise<void>;
  runTask(id: string): Promise<void>;
  /** 任务运行中给 Agent 补充一条指令（不打断当前步骤） */
  interject(text: string): Promise<{ ok: boolean; message: string }>;
  /** 从一次失败的运行记录重试：带上失败原因与最后页面继续执行 */
  retryRun(runId: string): Promise<void>;
  /** 删除运行记录，返回实际删除的条数 */
  deleteRuns(ids: string[]): Promise<number>;
  cancelTask(): Promise<void>;
  createProfile(kernelId: string, name: string): Promise<ProfileItem>;
  saveProfile(profile: Partial<ProfileItem>): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  openBrowser(kernelId: string, profileId?: string, url?: string): Promise<BrowserActionResult>;
  testBrowser(kernelId: string, profileId?: string): Promise<BrowserActionResult>;
  /** 关闭占用某个 Profile 数据目录的残留浏览器进程 */
  releaseProfile(pid: number): Promise<{ ok: boolean; message: string }>;
  showInFolder(targetPath: string): Promise<void>;
  setDefaultKernel(kernelId: string): Promise<void>;
  installKernel(kernelId: string): Promise<{ ok: boolean; message: string }>;
  uninstallKernel(kernelId: string): Promise<{ ok: boolean; message: string }>;
  saveKernelLicense(kernelId: string, key: string): Promise<{ ok: boolean; message: string }>;
  openExternal(url: string): Promise<void>;
  copyText(text: string): Promise<void>;
  setTheme(theme: ThemeMode): Promise<void>;
  onEvent(listener: (e: UiEvent) => void): () => void;
}

/** 任务选择"每次执行自动新建 Profile"时显示的名称 */
export const AUTO_PROFILE_LABEL = "自动创建新 Profile";

/** 下拉框中"自动创建"选项的 value */
export const AUTO_PROFILE_VALUE = "__auto__";

/** 把任意抛出值转成可展示的错误文案 */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** IPC 通道名称常量 */
export const IPC = {
  getState: "app:get-state",
  saveSettings: "settings:save",
  saveTask: "tasks:save",
  deleteTask: "tasks:delete",
  runTask: "tasks:run",
  interject: "agent:interject",
  retryRun: "runs:retry",
  deleteRuns: "runs:delete",
  cancelTask: "agent:cancel-task",
  createProfile: "profiles:create",
  saveProfile: "profiles:save",
  deleteProfile: "profiles:delete",
  releaseProfile: "browser:release-profile",
  openBrowser: "browser:open",
  testBrowser: "browser:test",
  showInFolder: "browser:show-in-folder",
  setDefaultKernel: "kernel:set-default",
  installKernel: "kernel:install",
  uninstallKernel: "kernel:uninstall",
  saveKernelLicense: "kernel:save-license",
  openExternal: "app:open-external",
  copyText: "app:copy-text",
  setTheme: "app:set-theme",
  event: "agent:event",
} as const;
