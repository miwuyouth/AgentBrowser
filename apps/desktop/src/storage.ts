import { app } from "electron";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getProvider, listManagedProviders } from "@agent-browser/bridge";
import { pickDefaultKernel, pickDefaultProfile, type DefaultsInput, type ProfileRef } from "./defaults.ts";
import type { KernelItem, ProfileItem, RunRecord, TaskItem } from "./shared.ts";

const dataDir = () => path.join(app.getPath("userData"), "agent-desk-data");
const tasksFile = () => path.join(dataDir(), "tasks.json");
const runsFile = () => path.join(dataDir(), "runs.json");
const profilesFile = () => path.join(dataDir(), "profiles.json");
const defaultKernelFile = () => path.join(dataDir(), "default-kernel.txt");
const defaultProfileFile = () => path.join(dataDir(), "default-profile.txt");

/** 每个内核自动带的那个 Profile 的名称（中性，不叫"默认"：默认是可以换的） */
const BUILTIN_PROFILE_NAME = "主 Profile";

function getAppBrowserDir() {
  return path.join(app.getPath("userData"), "browser");
}

export function getAppBrowserProfilesDir() {
  return path.join(getAppBrowserDir(), "profiles");
}

function ensureDir() {
  const dir = dataDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const bDir = getAppBrowserProfilesDir();
  if (!existsSync(bDir)) mkdirSync(bDir, { recursive: true });
}

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

function writeJson(filePath: string, data: unknown) {
  ensureDir();
  try {
    writeFileSync(filePath, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error(`Failed to write ${filePath}:`, err);
  }
}

/** 计算文件夹真实占用磁盘大小 */
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

// Tasks 存取
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

export function saveTasks(tasks: TaskItem[]) {
  writeJson(tasksFile(), tasks);
}

// Runs 存取
export function loadRuns(): RunRecord[] {
  return readJson<RunRecord[]>(runsFile(), []);
}

export function saveRuns(runs: RunRecord[]) {
  writeJson(runsFile(), runs);
}

// 默认 Profile 存取。全局只有一个默认 Profile，默认内核由它推出
function readTextFile(file: string): string {
  try {
    if (existsSync(file)) return readFileSync(file, "utf8").trim();
  } catch {}
  return "";
}

/** 旧版本保存的是「默认内核」；只在还没有默认 Profile 时用来迁移 */
const loadLegacyDefaultKernel = () => readTextFile(defaultKernelFile());
const loadDefaultProfileId = () => readTextFile(defaultProfileFile());

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

/** 所有 Profile 的 id 与所属内核，按内核顺序排；不读磁盘大小，所以可以随便调用 */
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

function defaultsInput(kernels: KernelRaw[], refs: ProfileRef[]): DefaultsInput {
  return { kernels, refs, savedProfile: loadDefaultProfileId(), legacyKernel: loadLegacyDefaultKernel() };
}
const resolveDefaultProfileId = (kernels: KernelRaw[], refs: ProfileRef[]) => pickDefaultProfile(defaultsInput(kernels, refs));
const resolveDefaultKernelId = (kernels: KernelRaw[], refs: ProfileRef[]) => pickDefaultKernel(defaultsInput(kernels, refs));

/**
 * 组装真实的 Chromium 内核列表
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
 * 加载所有 Profile。每个普通内核自带一个内置 Profile（不能删除），用户可在任意内核下新建更多。
 * 全局只有一个默认 Profile（isDefault），默认内核就是它所在的内核。
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

/** 自动新建 Profile 时用的名称：当前时间 */
export function formatProfileStamp(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * 为指定浏览器内核新建一个对应的 Profile。
 * 具体的初始化交给内核对应的 provider：指纹型浏览器会在这里生成并保存指纹。
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
 * 更新已有 Profile 的名称等元数据
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
 * 删除自定义 Profile 及其对应的数据目录
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

function findProfile(kernel: KernelItem, profileIdOrName?: string): ProfileItem | undefined {
  const kernelProfiles = loadProfiles().filter((p) => p.kernelId === kernel.id);
  return (
    (profileIdOrName && kernelProfiles.find((p) => p.id === profileIdOrName || p.name === profileIdOrName)) ||
    kernelProfiles.find((p) => p.isDefault) ||
    kernelProfiles[0]
  );
}

/**
 * 保存任务时使用：解析内核，Profile 可能还不存在（指纹型内核没有默认 Profile），
 * 此时返回 undefined，等任务真正执行时再自动创建。
 */
export function resolveKernelAndOptionalProfile(
  kernelIdOrName?: string,
  profileIdOrName?: string,
): { kernel: KernelItem; profile: ProfileItem | undefined } {
  const kernel = resolveKernel(kernelIdOrName);
  return { kernel, profile: findProfile(kernel, profileIdOrName) };
}

/**
 * 根据传入的内核标识与 Profile 标识，解析出准确的内核与对应的 Profile。
 * 内核下没有任何 Profile 时抛错（手动打开 / 测试连接用）。
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
 * 任务执行时使用：内核下没有可用 Profile、或指定 forceNew 时，自动新建一个 Profile。
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
