import { app } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProvider, listManagedProviders } from "@agent-browser/bridge";
import { RunStore } from "./run-store.ts";
import { pickDefaultKernel, pickDefaultProfile, type DefaultsInput, type ProfileRef } from "./defaults.ts";
import type { KernelItem, ProfileItem, TaskItem } from "./shared.ts";

/** 应用全局专有数据存储目录（位于系统的 userData 目录下的 agent-desk-data） */
const dataDir = () => path.join(app.getPath("userData"), "agent-desk-data");

/** tasks.json 持久化文件路径 */
const tasksFile = () => path.join(dataDir(), "tasks.json");

/** profiles.json 持久化文件路径 */
const profilesFile = () => path.join(dataDir(), "profiles.json");

/** 旧版默认内核记录文件路径（仅用于兼容性迁移） */
const defaultKernelFile = () => path.join(dataDir(), "default-kernel.txt");

/** 全局默认 Profile 记录文件路径 */
const defaultProfileFile = () => path.join(dataDir(), "default-profile.txt");

/** 普通内核自带的内置 Profile 展示名称（中性命名，因为全局默认 Profile 是可随意切换的） */
const BUILTIN_PROFILE_NAME = "主 Profile";

/** 获取浏览器数据根目录 */
function getAppBrowserDir() {
  return path.join(app.getPath("userData"), "browser");
}

/**
 * 获取所有内核的 Profile 存储根目录。
 * 各内核在其中拥有独立的子文件夹（例如 `<userData>/browser/profiles/chromium`）。
 */
export function getAppBrowserProfilesDir() {
  return path.join(getAppBrowserDir(), "profiles");
}

/**
 * 确保核心存储目录已在磁盘中创建。
 *
 * 【调用时机】
 * 读写 JSON 文件或初始化存储结构前内部调用。
 *
 * 【作用】
 * 若目标目录尚不存在，递归创建数据目录和 Profile 目录。
 */
function ensureDir() {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const bDir = getAppBrowserProfilesDir();
  if (!existsSync(bDir)) mkdirSync(bDir, { recursive: true });
}

/**
 * 通用安全读取 JSON 文件工具。
 *
 * 【调用时机】
 * 加载 tasks.json、profiles.json 等文件时内部调用。
 *
 * 【作用】
 * 读取指定文件并解析为 JSON，若文件不存在或语法异常，打印错误日志并安全返回传入的 fallback 兜底默认值。
 *
 * @param filePath 目标文件的绝对路径
 * @param fallback 读取或解析失败时的回退兜底对象
 */
function readJson<T>(filePath: string, fallback: T): T {
  try {
    if (existsSync(filePath)) {
      return JSON.parse(readFileSync(filePath, "utf8"));
    }
  } catch (err) {
    console.error(`Failed to read ${filePath}:`, err);
  }
  return fallback;
}

/**
 * 通用安全写入 JSON 文件工具。
 *
 * 【调用时机】
 * 保存任务列表、更新 Profile 元数据时内部调用。
 *
 * 【作用】
 * 格式化并将数据序列化写入目标文件，写入前自动确保父级目录已存在。
 *
 * @param filePath 目标文件绝对路径
 * @param data 待保存的 JavaScript 对象
 */
function writeJson(filePath: string, data: unknown) {
  ensureDir();
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to write ${filePath}:`, err);
  }
}

/**
 * 递归计算指定文件夹在磁盘上的实际占用体积。
 *
 * 【调用时机】
 * 组装 Profile 卡片展示信息（`loadProfiles`）时为每个 Profile 目录调用。
 *
 * 【作用】
 * 遍历目录（深度限制在 2 层，避免深层扫描开销过大），累加所有文件字节数，转化为友好字符串（如 "128 KB" 或 "45.2 MB"）。
 *
 * @param dirPath 目标文件夹绝对路径
 * @returns 人话可读的体积字符串
 */
function getFolderSize(dirPath: string): string {
  try {
    if (!existsSync(dirPath)) return "0 KB";
    let totalBytes = 0;
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      try {
        if (entry.isFile()) {
          totalBytes += statSync(fullPath).size;
        } else if (entry.isDirectory() && !entry.isSymbolicLink()) {
          const subEntries = readdirSync(fullPath, { withFileTypes: true });
          for (const sub of subEntries) {
            if (sub.isFile()) totalBytes += statSync(path.join(fullPath, sub.name)).size;
          }
        }
      } catch {}
    }
    if (totalBytes === 0) return "0 KB";
    const mb = totalBytes / (1024 * 1024);
    if (mb < 0.1) {
      const kb = Math.max(1, Math.round(totalBytes / 1024));
      return `${kb} KB`;
    }
    return `${mb.toFixed(1)} MB`;
  } catch {
    return "0 KB";
  }
}

/**
 * 加载所有已持久化的任务列表。
 *
 * 【调用时机】
 * 1. 组装全局 AppState（`state()`）时调用，向渲染进程提供任务列表；
 * 2. 调度器轮询检查到期任务（`scheduler.tick()`）时调用；
 * 3. 启动任务（`TaskRunner.runTask`）根据 ID 获取最新任务配置时调用；
 * 4. 应用恢复异常中断的运行记录时调用。
 *
 * 【作用】
 * 从 `tasks.json` 读取数据，并与当前已检测到的内核及默认 Profile 重新校验关联：
 * 自动修正无效或缺失的 kernelId、kernelName、profileId、profileName，并确保 autoClose 默认值。
 *
 * @returns 规范化的任务列表数组
 */
export function loadTasks(): TaskItem[] {
  const raw = readJson<TaskItem[]>(tasksFile(), []);
  const kernels = getKernelsListRaw();
  const defaultKernelId = resolveDefaultKernelId(kernels, profileRefs(kernels));
  const defaultKernel = kernels.find((k) => k.id === defaultKernelId) || kernels[0];

  return raw.map((t) => {
    const matchedKernel =
      kernels.find((k) => k.id === t.kernelId || k.id === t.kernel || k.name === t.kernel) || defaultKernel;
    const kernelId = matchedKernel?.id || t.kernelId || "chromium";
    const kernelName = matchedKernel?.name || t.kernel || "Chromium";
    const defaultProfileId = `${kernelId}::default`;
    const profileId = t.profileId && t.profileId.startsWith(`${kernelId}::`) ? t.profileId : defaultProfileId;
    const profileName = t.profile || BUILTIN_PROFILE_NAME;

    return {
      ...t,
      kernelId,
      kernel: kernelName,
      profileId,
      profile: profileName,
      autoClose: t.autoClose ?? true,
    };
  });
}

/**
 * 将任务列表全量持久化保存到 tasks.json。
 *
 * 【调用时机】
 * 1. 用户通过界面新建、编辑或删除任务后由 IPC 处理函数调用；
 * 2. 任务开始执行、顺利收尾或异常失败时更新任务最近状态时调用；
 * 3. 调度器处理到期标记更新 `lastScheduledAt` 时调用。
 *
 * 【作用】
 * 将全量任务实体数组格式化写入磁盘中的 `tasks.json`。
 *
 * @param tasks 待持久化的最新任务列表
 */
export function saveTasks(tasks: TaskItem[]) {
  writeJson(tasksFile(), tasks);
}

/** 全局单例 RunStore 缓存 */
let runStore: RunStore | null = null;

/**
 * 获取运行记录存储管理器的全局单例。
 *
 * 【调用时机】
 * 任何涉及读写运行记录、截图存取、历史删除或应用中断恢复时调用。
 *
 * 【作用】
 * 惰性初始化并返回唯一的 `RunStore` 实例，根目录定位在 `<userData>/agent-desk-data/runs`。
 *
 * @returns RunStore 单例实例
 */
export function getRunStore(): RunStore {
  runStore ??= new RunStore(path.join(dataDir(), "runs"));
  return runStore;
}

/**
 * 辅助读取单行纯文本文件内容的工具。
 *
 * 【调用时机】
 * 读取 `default-profile.txt` 或旧版 `default-kernel.txt` 时内部调用。
 *
 * 【作用】
 * 读取文本文件内容并去除前后首尾空白字符，若文件不存在则安全返回空字符串。
 */
function readTextFile(file: string): string {
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch {}
  return "";
}

/** 旧版本保存的是「默认内核」；只在还没有默认 Profile 时用来迁移 */
const loadLegacyDefaultKernel = () => readTextFile(defaultKernelFile());
const loadDefaultProfileId = () => readTextFile(defaultProfileFile());

/**
 * 保存全局默认 Profile ID 到本地磁盘。
 *
 * 【调用时机】
 * 保存任务时（由 IPC `IPC.saveTask` 处理函数触发）调用，记住用户最近一次选的 Profile。
 *
 * 【作用】
 * 将所选 Profile 的唯一 ID 写入 `default-profile.txt`，新建任务时据此预选内核与 Profile。
 *
 * @param profileId 目标 Profile 的 ID
 */
export function saveDefaultProfile(profileId: string) {
  ensureDir();
  writeFileSync(defaultProfileFile(), profileId.trim(), "utf8");
}

/** 内部使用的内核条目：每个由 App 管理的 provider 对应一个内核，是否已下载安装由 provider 自己判断 */
interface KernelRaw {
  id: string;
  providerId: string;
  name: string;
  path: string;
  version?: string;
  installed: boolean;
  needsLicense: boolean;
  licenseMissing: boolean;
  claimUrl?: string;
}

/**
 * 获取底层内核原始状态列表。
 *
 * 【调用时机】
 * 在装配内核卡片列表、装配 Profile 列表、解析默认配置或启动内核前内部调用。
 *
 * 【作用】
 * 遍历 Bridge 注册的托管 Provider，结合底层是否已下载安装、是否需要授权 Key 及授权状态组装 KernelRaw 列表。
 */
function getKernelsListRaw(): KernelRaw[] {
  return listManagedProviders().map((p): KernelRaw => {
    const k = p.installed();
    return {
      id: p.id,
      providerId: p.id,
      name: p.label,
      path: k?.path ?? "",
      ...(k?.version ? { version: k.version } : {}),
      installed: !!k,
      needsLicense: !!p.license,
      licenseMissing: !!p.license && !p.license.hasKey(),
      ...(p.license ? { claimUrl: p.license.claimUrl } : {}),
    };
  });
}

/**
 * 获取系统中所有 Profile 的精简引用（仅包含 id 与所属内核）。
 *
 * 【调用时机】
 * 在推导全局默认内核与默认 Profile 时内部调用。
 *
 * 【作用】
 * 按内核顺序收集普通内核的内置 Profile 以及用户自定义 Profile。因为不读取磁盘体积，计算轻量快速。
 */
function profileRefs(kernels: KernelRaw[]): ProfileRef[] {
  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);
  const refs: ProfileRef[] = [];
  for (const k of kernels) {
    const builtinId = `${k.id}::default`;
    // 指纹型内核不自动带 Profile：每个 Profile 都有自己的指纹，必须由用户显式新建
    if (!getProvider(k.providerId).capabilities.fingerprint) refs.push({ id: builtinId, kernelId: k.id });
    for (const rec of stored) {
      if (rec.kernelId === k.id && !rec.isDefault && rec.id !== builtinId) refs.push({ id: rec.id, kernelId: k.id });
    }
  }
  return refs;
}

/** 构造 DefaultsInput 推导参数辅助函数 */
function defaultsInput(kernels: KernelRaw[], refs: ProfileRef[]): DefaultsInput {
  return { kernels, refs, savedProfile: loadDefaultProfileId(), legacyKernel: loadLegacyDefaultKernel() };
}
const resolveDefaultProfileId = (kernels: KernelRaw[], refs: ProfileRef[]) => pickDefaultProfile(defaultsInput(kernels, refs));
const resolveDefaultKernelId = (kernels: KernelRaw[], refs: ProfileRef[]) => pickDefaultKernel(defaultsInput(kernels, refs));

/**
 * 组装供前端渲染界面呈现的完整内核卡片信息列表。
 *
 * 【调用时机】
 * 主进程组装应用全局状态（`main.ts` 中的 `state()`）时调用。
 *
 * 【作用】
 * 整合底层已安装内核信息，标记是否已下载安装、安装路径、是否需要授权，推算当前是否为默认内核，并实时统计有多少个任务正在绑定使用该内核。
 *
 * @returns KernelItem 数组
 */
export function getKernelsList(): KernelItem[] {
  const detected = getKernelsListRaw();
  const defaultId = resolveDefaultKernelId(detected, profileRefs(detected));
  const tasks = readJson<TaskItem[]>(tasksFile(), []);

  return detected.map((b) => ({
    id: b.id,
    providerId: b.providerId,
    name: b.name,
    installed: b.installed,
    ver: b.installed ? (b.version ? `v${b.version}` : "已安装") : "未安装",
    source: "App 管理",
    path: b.path,
    needsLicense: b.needsLicense,
    licenseMissing: b.licenseMissing,
    ...(b.claimUrl ? { claimUrl: b.claimUrl } : {}),
    taskCount: tasks.filter((t) => t.kernelId === b.id || t.kernel === b.name || t.kernel === b.id).length,
    isDefault: b.id === defaultId,
  }));
}

/** 本地 profiles.json 持久化记录项 */
interface StoredProfileRecord {
  id: string;
  name: string;
  kernelId: string;
  /** 负责该 Profile 的 provider；旧记录没有此字段，按所属内核推断 */
  providerId?: string;
  /** 指纹配置，由 provider 在创建 Profile 时生成 */
  fingerprint?: Record<string, unknown>;
  dirName: string;
  isDefault?: boolean;
}

/**
 * 加载所有浏览器内核下的全量 Profile 列表。
 *
 * 【调用时机】
 * 1. 组装全局 AppState（`state()`）时调用，向前端环境管理页与任务编辑下拉框提供 Profile 列表；
 * 2. 解析任务或启动浏览器时查找 Profile 时调用。
 *
 * 【作用】
 * 扫描内核目录与 `profiles.json`：
 * 1. 确保普通内核的内置 Profile 目录（`default`）存在并加载对应元数据；
 * 2. 加载用户创建的所有自定义 Profile；
 * 3. 统计每个 Profile 实际占用磁盘大小；
 * 4. 统计每个 Profile 被多少个任务绑定使用；
 * 5. 标记全局默认 Profile。
 *
 * @returns 完整的 ProfileItem 列表
 */
export function loadProfiles(): ProfileItem[] {
  ensureDir();
  const pBaseDir = getAppBrowserProfilesDir();
  const kernels = getKernelsListRaw();
  const tasks = loadTasks();
  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);
  const defaultId = resolveDefaultProfileId(kernels, profileRefs(kernels));

  const result: ProfileItem[] = [];

  for (const k of kernels) {
    const kernelProfileRoot = path.join(pBaseDir, k.id);
    if (!existsSync(kernelProfileRoot)) {
      mkdirSync(kernelProfileRoot, { recursive: true });
    }

    // 指纹型内核不自动创建内置 Profile：每个 Profile 都有自己的指纹，必须由用户显式新建
    const fingerprintKernel = getProvider(k.providerId).capabilities.fingerprint;

    // 1. 每个普通内核必有对应的内置 Profile
    const builtinId = `${k.id}::default`;
    if (!fingerprintKernel) {
      const builtinRecord = stored.find((s) => s.id === builtinId);
      const builtinDir = path.join(kernelProfileRoot, "default");
      if (!existsSync(builtinDir)) {
        mkdirSync(builtinDir, { recursive: true });
      }

      const builtinName = builtinRecord?.name || BUILTIN_PROFILE_NAME;
      result.push({
        id: builtinId,
        name: builtinName,
        initial: builtinName.slice(0, 1).toUpperCase(),
        kernelId: k.id,
        kernel: k.name,
        providerId: k.providerId,
        builtin: true,
        isDefault: builtinId === defaultId,
        taskCount: tasks.filter((t) => t.kernelId === k.id && t.profileId === builtinId).length,
        size: getFolderSize(builtinDir),
        dir: builtinDir,
      });
    }

    // 2. 该内核下用户创建的自定义 Profile
    const customRecords = stored.filter((s) => s.kernelId === k.id && !s.isDefault && s.id !== builtinId);
    for (const rec of customRecords) {
      const dirName = rec.dirName || rec.id.split("::")[1] || rec.id;
      const customDir = path.join(kernelProfileRoot, dirName);
      if (!existsSync(customDir)) {
        mkdirSync(customDir, { recursive: true });
      }
      result.push({
        id: rec.id,
        name: rec.name,
        initial: rec.name.slice(0, 1).toUpperCase(),
        kernelId: k.id,
        kernel: k.name,
        providerId: rec.providerId ?? k.providerId,
        ...(rec.fingerprint ? { fingerprint: rec.fingerprint } : {}),
        isDefault: rec.id === defaultId,
        taskCount: tasks.filter((t) => t.profileId === rec.id).length,
        size: getFolderSize(customDir),
        dir: customDir,
      });
    }
  }

  return result;
}

/**
 * 生成规范的时间戳字符串（用于自动命名 Profile）。
 *
 * 【调用时机】
 * 任务开启自动创建新 Profile、或新建 Profile 时未输入自定义名称时调用。
 *
 * 【作用】
 * 输出形如 "2026-11-08 17:00:00" 的时间戳字符串。
 *
 * @param d 基准日期对象，默认为当前时间
 * @returns 格式化日期字符串
 */
export function formatProfileStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 为指定的浏览器内核新建一个 Profile。
 *
 * 【调用时机】
 * 1. 用户在环境配置页点击"新建 Profile"并确认时（由 IPC `IPC.createProfile` 触发）调用；
 * 2. 任务启动执行时若配置了自动新建 Profile，由 `resolveOrCreateProfile` 调用。
 *
 * 【作用】
 * 1. 生成唯一目录名称并创建物理文件夹；
 * 2. 委托对应 Provider 初始化该 Profile（针对指纹型内核，Provider 会在此步生成唯一硬件指纹并持久化）；
 * 3. 将元信息写入 `profiles.json`；
 * 4. 返回组装好的 ProfileItem 实体。
 *
 * @param kernelId 目标浏览器内核 ID
 * @param name 自定义 Profile 显示名称
 * @returns 新建成功的 ProfileItem 实体
 */
export async function createProfileForKernel(kernelId: string, name: string): Promise<ProfileItem> {
  ensureDir();
  const kernels = getKernelsListRaw();
  const targetKernel = kernels.find((k) => k.id === kernelId || k.name === kernelId) || kernels[0];
  if (!targetKernel) {
    throw new Error("未找到指定的浏览器内核");
  }

  const cleanName = name.trim() || formatProfileStamp();
  // 加随机后缀，避免同一毫秒内创建多个 Profile 时 id 和目录冲突
  const dirName = `profile-${Date.now()}-${randomBytes(3).toString("hex")}`;
  const id = `${targetKernel.id}::${dirName}`;
  const dir = path.join(getAppBrowserProfilesDir(), targetKernel.id, dirName);
  mkdirSync(dir, { recursive: true });

  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);
  const provider = getProvider(targetKernel.providerId);
  let spec;
  try {
    spec = await provider.createProfile({
      name: cleanName,
      dir,
      // 同一 provider 下已有的指纹，用来避免重复
      existing: stored
        .filter((s) => (s.providerId ?? "chromium") === provider.id)
        .map((s) => ({ ...(s.fingerprint ? { fingerprint: s.fingerprint } : {}) })),
    });
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }

  stored.push({
    id,
    name: cleanName,
    kernelId: targetKernel.id,
    providerId: provider.id,
    ...(spec.fingerprint ? { fingerprint: spec.fingerprint } : {}),
    dirName,
    isDefault: false,
  });
  writeJson(profilesFile(), stored);

  return {
    id,
    name: cleanName,
    initial: cleanName.slice(0, 1).toUpperCase(),
    kernelId: targetKernel.id,
    kernel: targetKernel.name,
    providerId: provider.id,
    ...(spec.fingerprint ? { fingerprint: spec.fingerprint } : {}),
    isDefault: false,
    taskCount: 0,
    size: getFolderSize(dir),
    dir,
  };
}

/**
 * 更新已有 Profile 的元数据（如重命名）。
 *
 * 【调用时机】
 * 用户在前端界面修改 Profile 名称失焦或回车确认时（由 IPC `IPC.saveProfile` 触发）调用。
 *
 * 【作用】
 * 更新 `profiles.json` 中匹配 ID 的名称等属性并落盘。
 *
 * @param profileData 待更新的 Profile 部分属性（必须包含 id）
 */
export function updateProfileMeta(profileData: Partial<ProfileItem>) {
  if (!profileData.id) return;
  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);
  const idx = stored.findIndex((s) => s.id === profileData.id);
  const [kernelIdFromId, dirNameFromId] = profileData.id.split("::");

  if (idx !== -1) {
    const cur = stored[idx]!;
    stored[idx] = {
      ...cur,
      ...(profileData.name ? { name: profileData.name.trim() } : {}),
    };
  } else if (kernelIdFromId && dirNameFromId) {
    stored.push({
      id: profileData.id,
      name: profileData.name?.trim() || BUILTIN_PROFILE_NAME,
      kernelId: kernelIdFromId,
      dirName: dirNameFromId,
      isDefault: dirNameFromId === "default",
    });
  }
  writeJson(profilesFile(), stored);
}

/**
 * 删除指定的自定义 Profile 及其本地物理数据目录。
 *
 * 【调用时机】
 * 用户在环境页点击删除某个自定义 Profile 并确认时（由 IPC `IPC.deleteProfile` 触发）调用。
 *
 * 【作用】
 * 1. 严格禁止删除内核内置的不可删除 Profile（以 `::default` 结尾）；
 * 2. 从 `profiles.json` 中移除该记录；
 * 3. 递归强行删除其在磁盘上的物理 Profile 目录。
 *
 * @param id 待删除的 Profile ID
 */
export function removeProfileById(id: string) {
  if (id.endsWith("::default")) {
    throw new Error("内置 Profile 不能删除");
  }
  const all = loadProfiles();
  const target = all.find((p) => p.id === id);
  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []).filter((s) => s.id !== id);
  writeJson(profilesFile(), stored);

  if (target?.dir && existsSync(target.dir)) {
    try {
      rmSync(target.dir, { recursive: true, force: true });
    } catch {}
  }
}

/**
 * 根据标识或名称定位目标内核。
 *
 * 【调用时机】
 * 在内核解析流程内部调用。
 *
 * 【作用】
 * 优先匹配 ID 或名称相同的内核，若未找到或未指定则退回全局默认内核。若未安装任何内核则抛出明确错误。
 *
 * @param kernelIdOrName 内核 ID 或展示名称
 * @returns 匹配到的 KernelItem
 */
function resolveKernel(kernelIdOrName?: string): KernelItem {
  const kernels = getKernelsList();
  if (kernels.length === 0) {
    throw new Error("未检测到任何已安装的 Chromium 内核浏览器");
  }

  const defaultKernel = kernels.find((k) => k.isDefault) || kernels[0]!;
  return (
    (kernelIdOrName &&
      kernels.find(
        (k) =>
          k.id === kernelIdOrName ||
          k.name === kernelIdOrName ||
          k.name.toLowerCase() === kernelIdOrName.toLowerCase(),
      )) ||
    defaultKernel
  );
}

/**
 * 在目标内核的所有 Profile 中定位匹配项。
 *
 * 【调用时机】
 * 在 `resolveKernelAndOptionalProfile` 内部查找目标 Profile 时调用。
 *
 * 【作用】
 * 依次按传入的 ID 或名称、内核的默认 Profile、或首个 Profile 进行匹配查找。
 *
 * @param kernel 目标内核实体
 * @param profileIdOrName 期望匹配的 Profile ID 或名称
 * @returns 匹配到的 ProfileItem；若内核下没有任何 Profile 则返回 undefined
 */
function findProfile(kernel: KernelItem, profileIdOrName?: string): ProfileItem | undefined {
  const kernelProfiles = loadProfiles().filter((p) => p.kernelId === kernel.id);
  return (
    (profileIdOrName && kernelProfiles.find((p) => p.id === profileIdOrName || p.name === profileIdOrName)) ||
    kernelProfiles.find((p) => p.isDefault) ||
    kernelProfiles[0]
  );
}

/**
 * 保存任务时解析内核与可选的 Profile。
 *
 * 【调用时机】
 * 用户保存或更新任务（由 IPC `IPC.saveTask` 处理函数触发）时调用。
 *
 * 【作用】
 * 解析内核对象，但对 Profile 允许返回 undefined（因为指纹型内核没有默认 Profile，或任务选择了自动新建 Profile），允许留空以便在任务执行时自动创建。
 *
 * @param kernelIdOrName 内核 ID 或名称
 * @param profileIdOrName Profile ID 或名称
 * @returns 包含必定存在的内核与可能未定义的 Profile
 */
export function resolveKernelAndOptionalProfile(
  kernelIdOrName?: string,
  profileIdOrName?: string,
): { kernel: KernelItem; profile: ProfileItem | undefined } {
  const kernel = resolveKernel(kernelIdOrName);
  return { kernel, profile: findProfile(kernel, profileIdOrName) };
}

/**
 * 根据传入的标识解析出确定的内核与确定的 Profile。
 *
 * 【调用时机】
 * 用户手动打开浏览器进行调试（`IPC.openBrowser`）或测试连接（`IPC.testBrowser`）时调用。
 *
 * 【作用】
 * 严格解析内核与 Profile，若目标内核下暂无任何 Profile，抛出明确错误引导用户去新建或执行任务。
 *
 * @param kernelIdOrName 内核 ID 或名称
 * @param profileIdOrName Profile ID 或名称
 * @returns 确定的内核与 Profile 对象
 */
export function resolveKernelAndProfile(
  kernelIdOrName?: string,
  profileIdOrName?: string,
): { kernel: KernelItem; profile: ProfileItem } {
  const { kernel, profile } = resolveKernelAndOptionalProfile(kernelIdOrName, profileIdOrName);
  if (!profile) {
    throw new Error(`内核「${kernel.name}」下还没有 Profile。任务执行时会自动创建，也可以先到 Profile 页新建一个。`);
  }
  return { kernel, profile };
}

/**
 * 任务执行时解析或自动按需创建可用 Profile。
 *
 * 【调用时机】
 * 任务即将启动前（由 `TaskRunner.runTask` 触发）调用。
 *
 * 【作用】
 * 确保任务启动时一定有合法的 Profile 可用：
 * - 若已有可用 Profile 且 `forceNew === false`，直接复用；
 * - 若任务指定了自动新建 Profile（`forceNew === true`）或该内核下尚无可用 Profile，则自动新建一个以当前时间命名的全新 Profile 并返回。
 *
 * @param kernelIdOrName 内核 ID 或名称
 * @param profileIdOrName Profile ID 或名称
 * @param newProfileName 自动新建 Profile 时使用的建议名称
 * @param forceNew 是否强制每次都新建全新 Profile
 * @returns 包含内核、Profile 以及是否刚刚新建的标记
 */
export async function resolveOrCreateProfile(
  kernelIdOrName: string | undefined,
  profileIdOrName: string | undefined,
  newProfileName: string,
  forceNew = false,
): Promise<{ kernel: KernelItem; profile: ProfileItem; created: boolean }> {
  const { kernel, profile } = resolveKernelAndOptionalProfile(kernelIdOrName, profileIdOrName);
  if (profile && !forceNew) return { kernel, profile, created: false };
  const createdProfile = await createProfileForKernel(kernel.id, newProfileName);
  return { kernel, profile: createdProfile, created: true };
}
