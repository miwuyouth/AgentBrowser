
/**
 * 跨主进程与渲染进程共享的数据模型契约与轻量工具函数。
 */

/** 浏览器进程的实时运行状态枚举 */
export type BrowserStatus = "stopped" | "starting" | "connected" | "error";

/** 支持的模型服务提供商类型 */
export type ProviderKind = "anthropic" | "openai-compatible";

/** 任务最近一次的执行状态结果 */
export type TaskStatus = "ok" | "run" | "fail" | "none";

/** 任务执行触发模式：立即执行或定时触发 */
export type TaskMode = "now" | "cron";

/** 表单字段定义（用于任务结构化结果提取） */
export interface FormField {
  /** 字段唯一标识 */
  id: string;
  /** 字段名称（展示与对齐使用的键名） */
  name: string;
  /** 期望提取的字段类型：文本或纯数字 */
  type: "text" | "number";
  /** 针对该字段的提取要求或补充描述（可选） */
  description?: string;
}

/** 任务结构定义（持久化存储与界面展现的核心实体） */
export interface TaskItem {
  /** 任务唯一 ID */
  id: string;
  /** 任务自定义名称 */
  name: string;
  /** 任务核心目标（自然语言 Prompt） */
  goal: string;
  /** 任务起始网址（可选） */
  url?: string;
  /** 任务执行完成的判定条件说明（可选） */
  doneCondition?: string;
  /** 期望提取的表单字段列表（可选） */
  fields?: FormField[];
  /** 所选浏览器内核 ID（如 "chromium"） */
  kernelId: string;
  /** 所选浏览器内核显示名称 */
  kernel: string;
  /** 所选 Profile ID（与 kernelId 对应） */
  profileId: string;
  /** 所选 Profile 显示名称 */
  profile: string;
  /** 为 true 时表示每次执行任务都自动新建一个全新 Profile，此时 profileId 留空 */
  autoProfile?: boolean;
  /** 任务执行完毕后是否自动关闭浏览器实例（headless 时始终关闭） */
  autoClose: boolean;
  /** 后台运行：以无头模式启动浏览器，不显示窗口 */
  headless?: boolean;
  /** 任务模式：立即执行还是定时循环 */
  mode: TaskMode;
  /** 计划规则的人话描述标签（如 "每天 08:30"） */
  schedule: string;
  /** Cron 表达式（备用） */
  cronExpr?: string;
  /** 重复周期类型 */
  repeatKind?: "daily" | "weekday" | "weekly" | "hours" | "once" | "manual";
  /** 每日定时运行的时间点（如 "08:30"） */
  repeatTime?: string;
  /** 调度器最近一次处理过的计划时刻（毫秒时间戳）；用于避免重复触发并识别错过的时刻 */
  lastScheduledAt?: number;
  /** 单次运行允许的最大步骤上限 */
  maxSteps: number;
  /** 单次运行的超时截止时间（分钟） */
  timeoutMinutes: number;
  /** 最近一次运行的状态 */
  lastStatus: TaskStatus;
  /** 最近一次运行发生的时间描述（如 "刚刚"、"10分钟前"） */
  lastRunTime?: string;
  /** 最近一次运行的耗时描述（如 "用时 01:23"） */
  lastDuration?: string;
  /** 任务配置最后更新的毫秒时间戳 */
  updatedAt: number;
}

/** 单步操作的运行记录结构 */
export interface RunStep {
  /** 步骤序号（从 1 开始递增） */
  stepNumber: number;
  /** 步骤当前执行状态 */
  status: "done" | "run" | "todo";
  /** 动作分类标签（如 "导航"、"观察"、"动作"、"提取"） */
  tag: string;
  /** 步骤内容详情（包含调用的工具名及参数摘要） */
  text: string;
  /** 辅助元信息（如耗时 "用时 320ms"、"已就绪" 等） */
  meta: string;
  /** 这一步捕获的截图文件名（如 "3.png"）；文件位于该次运行目录中，界面通过 shot:// 协议访问 */
  screenshot?: string;
  /** 以下为"运行日志"的完整排查信息，仅落盘与详情页使用；实时推送时会被剔除（见 `lightRun`） */
  /** 发起本次工具调用的那一轮里，Agent 说的话（它为什么这么做）；一轮多个调用时只挂在第一个上 */
  thought?: string;
  /** 工具原名（如 "computer"、"navigate"） */
  tool?: string;
  /** 工具入参的完整 JSON（格式化后，过长会截断） */
  input?: string;
  /** 工具返回的文本内容（过长会截断）；截图不在此处，见 `screenshot` */
  output?: string;
  /** 工具返回了错误 */
  isError?: boolean;
}

/** 日志中单段文本（入参 / 返回）的最大保留字数，防止个别页面文本把记录撑得过大 */
export const LOG_TEXT_LIMIT = 6000;

/** 截断过长的日志文本并注明原长度 */
export const capLog = (text: string, limit = LOG_TEXT_LIMIT) =>
  text.length > limit ? `${text.slice(0, limit)}\n…（已截断，原文共 ${text.length} 字）` : text;

/**
 * 生成用于实时推送的轻量运行记录：去掉每步的完整入参/返回/Agent 说明。
 * 运行中每一步都会广播整份记录，若带着这些大块文本会越推越慢；完整内容在详情页按需从磁盘读取。
 */
export function lightRun(run: RunRecord): RunRecord {
  const { prompt: _prompt, ...rest } = run;
  return {
    ...rest,
    steps: run.steps.map(({ thought: _t, input: _i, output: _o, ...step }) => step),
  };
}

/** 一次运行的最终结果联合类型 */
export type RunResult =
  | { kind: "text"; text: string }
  | { kind: "markdown"; text: string }
  | { kind: "form"; data: Record<string, string | number | null>; fields: FormField[] };

/** 运行记录的轻量摘要：用于历史列表展现，不含耗内存的步骤与截图路径 */
export interface RunSummary {
  /** 运行记录唯一 ID */
  id: string;
  /** 关联的任务 ID（若为独立执行则可能为空） */
  taskId?: string;
  /** 任务名称或运行名称 */
  name: string;
  /** 最终执行状态 */
  status: "ok" | "run" | "fail";
  /** 运行开始的毫秒时间戳 */
  startTime: number;
  /** 运行结束的毫秒时间戳（若仍在运行则未定义） */
  endTime?: number;
  /** 触发源描述（如 "手动触发"、"定时触发"、"失败重试"） */
  trigger: string;
}

/** 单次运行的完整明细记录：在详情页和重试操作时按需加载 */
export interface RunRecord extends RunSummary {
  /** Agent 给出的最终回复文本；运行中为空 */
  summary: string;
  /** 结构化的最终结果；若缺失则界面使用 summary 兜底呈现 */
  result?: RunResult;
  /** 是否存在异常报错 */
  hasError?: boolean;
  /** 详细错误信息 */
  error?: string;
  /** 针对本次失败给用户的操作建议 */
  advice?: string;
  /** Agent 最后导航到的页面 URL；用于从失败处继续重试 */
  lastUrl?: string;
  /** 发给 Agent 的完整任务指令（含目标、起始网址、表单提取要求等）；运行日志的第一条 */
  prompt?: string;
  /** 完整的步骤操作历史列表 */
  steps: RunStep[];
}

/** 浏览器内核展示卡片结构 */
export interface KernelItem {
  /** 内核唯一 ID（如 "chromium"） */
  id: string;
  /** 负责启动该内核的 BrowserProvider 标识 */
  providerId: string;
  /** 是否已下载安装至 App 专有的内核目录中 */
  installed: boolean;
  /** 当前是否正处于下载安装中 */
  installing?: boolean;
  /** 安装进度百分比（0 到 1 之间） */
  progress?: number;
  /** 安装进度的文字提示信息 */
  progressText?: string;
  /** 上次下载安装失败的原因说明 */
  installError?: string;
  /** 该内核是否需要授权 Key 才能使用 */
  needsLicense?: boolean;
  /** 是否需要授权 Key 且当前尚未填写设置 */
  licenseMissing?: boolean;
  /** 申领授权 Key 的官方外部链接 */
  claimUrl?: string;
  /** 内核展示名称 */
  name: string;
  /** 内核版本字符串 */
  ver: string;
  /** 来源说明 */
  source: string;
  /** 内核二进制在本地的安装路径 */
  path: string;
  /** 关联使用该内核的任务数量 */
  taskCount: number;
  /** 是否为全局默认内核（由全局默认 Profile 所在内核推导而来） */
  isDefault?: boolean;
}

/** Profile 展示卡片结构（每个 Profile 绑定到对应的浏览器内核） */
export interface ProfileItem {
  /** Profile 唯一 ID */
  id: string;
  /** Profile 显示名称 */
  name: string;
  /** 首字母缩写，用于图标头像展示 */
  initial: string;
  /** 所属浏览器内核 ID */
  kernelId: string;
  /** 所属浏览器内核名称 */
  kernel: string;
  /** 负责管理启动该 Profile 的 Provider 标识 */
  providerId: string;
  /** 指纹配置（指纹浏览器专有） */
  fingerprint?: Record<string, unknown>;
  /** 是否为全局默认 Profile（全局唯一） */
  isDefault?: boolean;
  /** 是否为内核自带的内置不可删除 Profile */
  builtin?: boolean;
  /** 关联使用该 Profile 的任务数量 */
  taskCount: number;
  /** 数据目录占用磁盘大小（如 "12.5 MB"） */
  size: string;
  /** 数据目录的本地绝对路径 */
  dir: string;
}

/** 模型服务提供商的前端展示视图（已脱敏） */
export interface ProviderSettingsView {
  /** 服务商类别 */
  kind: ProviderKind;
  /** 接口 Base URL */
  baseURL: string;
  /** 推理模型名称 */
  model: string;
  /** API 凭据配置状态：stored(保存在本地系统钥匙串)、environment(来自系统环境变量)、none(未配置) */
  credentials: "stored" | "environment" | "none";
}

/** 「设置 › 通用」里的应用行为开关（改动立即生效，没有保存按钮） */
export interface GeneralSettings {
  /** 关闭窗口后留在后台（菜单栏 / 托盘）继续运行，定时任务照常执行 */
  keepInBackground: boolean;
  /** 开机（登录系统）时在后台启动；真实值以系统登录项为准，不存进 settings.json */
  openAtLogin: boolean;
  /** 任务跑完（成功或失败）时发系统通知；用户自己点「停止」的不发 */
  notifyOnFinish: boolean;
  /** 只有定时任务（没有任务在跑）时，退出前也确认一次；有任务在跑或排队时总会确认 */
  quitWarn: boolean;
}

/** 发给界面的通用设置视图 */
export interface GeneralSettingsView extends GeneralSettings {
  /** 开机启动不可用时的原因（开发模式、系统不支持）；可用时不存在 */
  loginItemNote?: string;
}

/** 全局桌面应用状态对象（主进程全量同步至渲染进程） */
export interface AppState {
  /** 运行平台（process.platform），界面据此说「菜单栏」还是「托盘」 */
  platform: string;
  /** 通用设置 */
  general: GeneralSettingsView;
  /** 浏览器连接状态 */
  browser: BrowserStatus;
  /** 浏览器连接或启动异常信息 */
  browserError?: string;
  /** 当前选中的模型服务商脱敏配置 */
  provider: ProviderSettingsView;
  /** 所有支持的模型服务商配置字典 */
  providers: Record<ProviderKind, ProviderSettingsView>;
  /** 当前是否有任务正在运行 */
  running: boolean;
  /** 排队等待执行的任务 ID 列表 */
  queued: string[];
  /** 全量任务列表 */
  tasks: TaskItem[];
  /** 历史运行记录摘要列表（仅摘要，按时间倒序） */
  runs: RunSummary[];
  /** 检测到的浏览器内核列表 */
  kernels: KernelItem[];
  /** 本地所有 Profile 列表 */
  profiles: ProfileItem[];
  /** 当前正在执行的完整运行明细（含实时步骤） */
  activeRun?: RunRecord;
}

/** 保存设置时的更新载荷（仅模型配置） */
export interface SettingsUpdate {
  /** 目标服务商类别 */
  kind: ProviderKind;
  baseURL?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  model?: string;
}

/** 获取模型列表 / 测试模型时的请求载荷（表单当前值，未保存也可探测） */
export interface ModelProbeRequest {
  kind: ProviderKind;
  baseURL: string;
  /** 表单中新输入的明文密钥；留空则使用已保存的密钥或环境变量 */
  apiKey?: string;
  /** 表单中已勾选"清除密钥"时为 true，此时不使用已保存的密钥 */
  ignoreStored?: boolean;
  /** 待测试的模型名（仅测试时使用） */
  model?: string;
}

/** 获取模型列表的结果 */
export interface ModelListResult {
  ok: boolean;
  models: string[];
  message: string;
}

/** 测试模型可用性的结果 */
export interface ModelTestResult {
  ok: boolean;
  message: string;
}

/** 主进程转发给渲染进程的单向推送 UI 事件 */
export type UiEvent =
  | { type: "state"; state: AppState }
  | { type: "run_update"; run: RunRecord }
  | { type: "kernel_progress"; kernelId: string; fraction?: number; message?: string }
  | { type: "notice"; message: string; isError?: boolean }
  /** 用户点了系统通知：界面跳到对应的运行详情 */
  | { type: "open_run"; runId: string }
  /** 主进程要用户确认（退出前提醒、文件授权等）：界面弹出应用内确认框，选完后通过 answerPrompt 回复 */
  | { type: "prompt"; id: number; prompt: AppPrompt };

/** 确认框的内容；主进程和渲染进程共用 */
export interface AppPrompt {
  /** 一句话问题，粗体显示，例如「删除这条运行记录？」 */
  title: string;
  /** 补充说明，每项一行，常规字号显示 */
  detail?: string | string[];
  /** 确认按钮文字，用动词，例如「删除」「卸载」 */
  confirmLabel: string;
  /** 不可恢复的操作：确认按钮用红色 */
  danger?: boolean;
  /** 取消按钮文字，默认「取消」 */
  cancelLabel?: string;
  /** 附带一个复选框（例如「不再提醒」），不传就没有 */
  checkboxLabel?: string;
}

/** 用户对确认框的选择 */
export interface PromptAnswer {
  /** 点了确认按钮；取消、按 Esc、点遮罩为 false */
  ok: boolean;
  /** 确认时复选框是否勾选；没有复选框或取消时恒为 false */
  checked: boolean;
}

/** 外观主题模式 */
export type ThemeMode = "dark" | "light" | "system";

/** 手动打开浏览器或测试连接的执行结果 */
export interface BrowserActionResult {
  ok: boolean;
  message: string;
  /** Profile 数据目录被外部残留浏览器进程占用时的进程 PID */
  lockedPid?: number;
}

/** Preload 脚本暴露给全局 window.agentApi 的接口签名定义 */
export interface AgentApi {
  /** 获取当前应用全局状态 */
  getState(): Promise<AppState>;
  /** 保存模型服务商设置 */
  saveSettings(update: SettingsUpdate): Promise<AppState>;
  /** 修改通用设置（只传要改的项），立即生效 */
  saveGeneral(patch: Partial<GeneralSettings>): Promise<AppState>;
  /** 用表单当前值向接口拉取可用模型列表 */
  listModels(req: ModelProbeRequest): Promise<ModelListResult>;
  /** 用表单当前值发一次最小请求，验证接口、密钥与模型是否可用 */
  testModel(req: ModelProbeRequest): Promise<ModelTestResult>;
  /** 新建或更新保存任务 */
  saveTask(task: Partial<TaskItem>): Promise<TaskItem>;
  /** 克隆指定 ID 的任务并持久化生成新副本 */
  cloneTask(id: string): Promise<TaskItem>;
  /** 删除指定 ID 的任务 */
  deleteTask(id: string): Promise<void>;
  /** 立即触发运行指定任务 */
  runTask(id: string): Promise<void>;
  /** 从失败的运行记录重试该任务 */
  retryRun(runId: string): Promise<void>;
  /** 批量删除运行历史记录 */
  deleteRuns(ids: string[]): Promise<number>;
  /** 按需读取单次运行的完整明细记录（含步骤与截图） */
  getRun(id: string): Promise<RunRecord | null>;
  /** 中止当前正在运行的任务 */
  cancelTask(): Promise<void>;
  /** 为指定内核新建 Profile */
  createProfile(kernelId: string, name: string): Promise<ProfileItem>;
  /** 更新 Profile 元信息 */
  saveProfile(profile: Partial<ProfileItem>): Promise<void>;
  /** 删除指定的自定义 Profile */
  deleteProfile(id: string): Promise<void>;
  /** 在独立窗口中打开指定的浏览器内核与 Profile（供用户手工操作或登录网站） */
  openBrowser(kernelId: string, profileId?: string, url?: string): Promise<BrowserActionResult>;
  /** 测试内核与扩展的连接连通性 */
  testBrowser(kernelId: string, profileId?: string): Promise<BrowserActionResult>;
  /** 强制释放并关闭占用 Profile 目录的残留进程 */
  releaseProfile(pid: number): Promise<{ ok: boolean; message: string }>;
  /** 在系统文件管理器中定位目标文件或目录 */
  showInFolder(targetPath: string): Promise<void>;
  /** 下载安装指定浏览器内核 */
  installKernel(kernelId: string): Promise<{ ok: boolean; message: string }>;
  /** 卸载指定浏览器内核 */
  uninstallKernel(kernelId: string): Promise<{ ok: boolean; message: string }>;
  /** 保存内核授权密钥 */
  saveKernelLicense(kernelId: string, key: string): Promise<{ ok: boolean; message: string }>;
  /** 在系统默认外部浏览器中打开链接 */
  openExternal(url: string): Promise<void>;
  /** 复制文本到系统剪贴板 */
  copyText(text: string): Promise<void>;
  /** 设置应用外观主题 */
  setTheme(theme: ThemeMode): Promise<void>;
  /** 回复主进程发来的确认框 */
  answerPrompt(id: number, answer: PromptAnswer): Promise<void>;
  /** 取还没回复的确认框（界面刚加载好时补弹，防止错过加载前发来的） */
  pendingPrompts(): Promise<{ id: number; prompt: AppPrompt }[]>;
  /** 注册主进程 UI 事件监听器，返回解除监听的清理函数 */
  onEvent(listener: (e: UiEvent) => void): () => void;
}

/** 任务选择"每次执行自动新建 Profile"时展示的名称常量 */
export const AUTO_PROFILE_LABEL = "自动创建新 Profile";

/** 下拉框中"自动创建新 Profile"选项的特殊 value 标识 */
export const AUTO_PROFILE_VALUE = "__auto__";

/**
 * 将任意抛出的错误对象或未知值统一转化为人类可读的字符串信息。
 *
 * 【调用时机】
 * 无论主进程还是渲染进程，在 catch 块中捕获到未知异常时广泛调用。
 *
 * 【作用】
 * 若为 Error 实例则取其 message，否则使用 String() 转换，保证不会因对象打印导致 [object Object]。
 *
 * @param err 捕获到的异常或值
 * @returns 格式化后的错误提示文本
 */
export const errorMessage = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 根据已有任务名称列表，为被克隆的任务生成规范且不重复的副本名称。
 *
 * 【命名规则】
 * - 首次克隆：「任务名」->「任务名 (副本)」
 * - 再次克隆：「任务名 (副本)」->「任务名 (副本 2)」
 * - 继续克隆：「任务名 (副本 2)」->「任务名 (副本 3)」
 * - 兼容中英文括号及空格变体，如「任务名 副本」、「任务名（副本）」等。
 *
 * @param baseName 原始任务名称
 * @param existingNames 当前所有已有任务的名称数组
 * @returns 保证在 existingNames 中不存在的全新名称
 */
export function makeCloneName(baseName: string, existingNames: string[]): string {
  const trimmed = baseName?.trim() || "新任务";
  const nameSet = new Set(existingNames);

  // 提取原始名称主体（去除末尾可能已有的 副本 标记）
  const copyRegex = /^(.*?)(?:[（(]\s*副本(?:\s*(\d+))?\s*[）)]|\s+副本(?:\s*(\d+))?)$/;
  const match = trimmed.match(copyRegex);
  const root = (match && match[1]?.trim()) ? match[1].trim() : trimmed;

  // 检查某种编号的副本变体（如带括号、不带括号、全角括号）是否已存在
  const isTaken = (num?: number) => {
    if (!num) {
      return (
        nameSet.has(`${root} (副本)`) ||
        nameSet.has(`${root} 副本`) ||
        nameSet.has(`${root}（副本）`)
      );
    }
    return (
      nameSet.has(`${root} (副本 ${num})`) ||
      nameSet.has(`${root} 副本 ${num}`) ||
      nameSet.has(`${root}（副本 ${num}）`)
    );
  };

  if (!isTaken()) {
    return `${root} (副本)`;
  }

  let index = 2;
  while (isTaken(index)) {
    index++;
  }
  return `${root} (副本 ${index})`;
}

/**
 * 完整克隆一个任务对象，分配新的唯一 ID 并重置执行状态。
 *
 * 【调用时机】
 * 主进程处理 `IPC.cloneTask` 或需要深拷贝任务时调用。
 *
 * 【作用】
 * 1. 生成唯一的不重复名称（如「xxx (副本)」）；
 * 2. 赋予全新的任务 ID 与表单字段 ID；
 * 3. 复制完整的核心执行配置（内核、Profile、调度规则、表单字段、超时限制等）；
 * 4. 重置最近运行状态为未执行状态（none）。
 *
 * @param source 源任务对象
 * @param existingNames 当前系统中所有已有任务名称
 * @returns 克隆后的全新任务对象
 */
export function cloneTaskItem(source: TaskItem, existingNames: string[]): TaskItem {
  const name = makeCloneName(source.name, existingNames);
  const now = Date.now();
  const rand = Math.random().toString(36).slice(2, 6);
  const fields = source.fields?.map((f) => ({
    ...f,
    id: `f-${now}-${Math.random().toString(36).slice(2, 6)}`,
  }));

  return {
    ...source,
    id: `task-${now}-${rand}`,
    name,
    fields,
    lastStatus: "none",
    lastRunTime: "—",
    lastDuration: "—",
    lastScheduledAt: now,
    updatedAt: now,
  };
}

/** Electron IPC 通道名称常量集合 */
export const IPC = {
  getState: "app:get-state",
  saveSettings: "settings:save",
  saveGeneral: "settings:save-general",
  listModels: "settings:list-models",
  testModel: "settings:test-model",
  saveTask: "tasks:save",
  cloneTask: "tasks:clone",
  deleteTask: "tasks:delete",
  runTask: "tasks:run",
  retryRun: "runs:retry",
  deleteRuns: "runs:delete",
  getRun: "runs:get",
  cancelTask: "agent:cancel-task",
  createProfile: "profiles:create",
  saveProfile: "profiles:save",
  deleteProfile: "profiles:delete",
  releaseProfile: "browser:release-profile",
  openBrowser: "browser:open",
  testBrowser: "browser:test",
  showInFolder: "browser:show-in-folder",
  installKernel: "kernel:install",
  uninstallKernel: "kernel:uninstall",
  saveKernelLicense: "kernel:save-license",
  openExternal: "app:open-external",
  copyText: "app:copy-text",
  setTheme: "app:set-theme",
  answerPrompt: "app:answer-prompt",
  pendingPrompts: "app:pending-prompts",
  event: "agent:event",
} as const;
