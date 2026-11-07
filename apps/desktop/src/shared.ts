import type { AgentEvent, Effort } from "@agent-browser/agent";
import type { DetectedBrowser } from "@agent-browser/bridge";

export type { DetectedBrowser };

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
  /** 任务完成后是否自动关闭浏览器 */
  autoClose: boolean;
  mode: TaskMode;
  schedule: string;
  cronExpr?: string;
  repeatKind?: "daily" | "weekday" | "weekly" | "hours" | "once" | "manual";
  repeatTime?: string;
  maxSteps: number;
  timeoutMinutes: number;
  resultFormat: "text" | "json" | "markdown";
  lastStatus: TaskStatus;
  lastRunTime?: string;
  lastDuration?: string;
  createdAt: number;
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
  hasError?: boolean;
  error?: string;
  advice?: string;
  steps: RunStep[];
}

/** 浏览器内核展示卡片结构 */
export interface KernelItem {
  id: string;
  name: string;
  ver: string;
  source: string;
  path: string;
  health: string;
  ok: boolean;
  usage: string;
  isDefault?: boolean;
}

/** Profile 展示卡片结构（每个 Profile 绑定到对应的浏览器内核） */
export interface ProfileItem {
  id: string;
  name: string;
  initial: string;
  hue: string;
  /** 所属浏览器内核 ID */
  kernelId: string;
  /** 所属浏览器内核名称 */
  kernel: string;
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

/** 调度器状态 */
export interface SchedulerState {
  running: boolean;
  nextTime: string;
  nextTask: string;
}

/** 全局桌面应用状态 */
export interface AppState {
  browser: BrowserStatus;
  browserError?: string;
  browserInfo?: string;
  provider: ProviderSettingsView;
  providers: Record<ProviderKind, ProviderSettingsView>;
  running: boolean;
  tasks: TaskItem[];
  runs: RunRecord[];
  kernels: KernelItem[];
  profiles: ProfileItem[];
  activeRun?: RunRecord;
  scheduler: SchedulerState;
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
  | Exclude<AgentEvent, { type: "assistant_turn" }>
  | { type: "state"; state: AppState }
  | { type: "run_step"; step: RunStep; runId: string }
  | { type: "run_screenshot"; screenshot: string; url?: string; runId: string }
  | { type: "run_update"; run: RunRecord }
  | { type: "notice"; message: string; isError?: boolean };

export type ThemeMode = "dark" | "light" | "system";

/** Preload 脚本暴露给 window.agentApi 的接口定义 */
export interface AgentApi {
  getState(): Promise<AppState>;
  saveSettings(update: SettingsUpdate): Promise<AppState>;
  saveTask(task: Partial<TaskItem>): Promise<TaskItem>;
  deleteTask(id: string): Promise<void>;
  runTask(id: string): Promise<void>;
  cancelTask(): Promise<void>;
  createProfile(kernelId: string, name: string): Promise<ProfileItem>;
  saveProfile(profile: Partial<ProfileItem>): Promise<void>;
  deleteProfile(id: string): Promise<void>;
  openBrowser(kernelId: string, profileId?: string, url?: string): Promise<{ ok: boolean; message: string }>;
  testBrowser(kernelId: string, profileId?: string): Promise<{ ok: boolean; message: string }>;
  showInFolder(targetPath: string): Promise<void>;
  setDefaultKernel(kernelId: string): Promise<void>;
  rescanKernels(): Promise<KernelItem[]>;
  copyText(text: string): Promise<void>;
  setTheme(theme: ThemeMode): Promise<void>;
  onEvent(listener: (e: UiEvent) => void): () => void;
}

/** IPC 通道名称常量 */
export const IPC = {
  getState: "app:get-state",
  saveSettings: "settings:save",
  saveTask: "tasks:save",
  deleteTask: "tasks:delete",
  runTask: "tasks:run",
  cancelTask: "agent:cancel-task",
  createProfile: "profiles:create",
  saveProfile: "profiles:save",
  deleteProfile: "profiles:delete",
  openBrowser: "browser:open",
  testBrowser: "browser:test",
  showInFolder: "browser:show-in-folder",
  setDefaultKernel: "kernel:set-default",
  rescanKernels: "kernel:rescan",
  copyText: "app:copy-text",
  setTheme: "app:set-theme",
  event: "agent:event",
} as const;
