import { app } from "electron";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { detectInstalledBrowsers } from "@agent-browser/bridge";
import type { KernelItem, ProfileItem, RunRecord, TaskItem } from "./shared.ts";

const dataDir = () => path.join(app.getPath("userData"), "agent-desk-data");
const tasksFile = () => path.join(dataDir(), "tasks.json");
const runsFile = () => path.join(dataDir(), "runs.json");
const profilesFile = () => path.join(dataDir(), "profiles.json");
const defaultKernelFile = () => path.join(dataDir(), "default-kernel.txt");

function getAppBrowserDir() {
  return path.join(app.getPath("userData"), "browser");
}

function getAppBrowserProfilesDir() {
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
  const defaultKernel = kernels.find((k) => k.isDefault) || kernels[0];

  return raw.map((t) => {
    const matchedKernel =
      kernels.find((k) => k.id === t.kernelId || k.id === t.kernel || k.name === t.kernel) || defaultKernel;
    const kernelId = matchedKernel?.id || t.kernelId || "google-chrome";
    const kernelName = matchedKernel?.name || t.kernel || "Chromium";
    const defaultProfileId = `${kernelId}::default`;
    const profileId = t.profileId && t.profileId.startsWith(`${kernelId}::`) ? t.profileId : defaultProfileId;
    const profileName = t.profile || "默认 Profile";

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

// Default Kernel 存取
function loadDefaultKernel(): string {
  try {
    if (existsSync(defaultKernelFile())) {
      return readFileSync(defaultKernelFile(), "utf8").trim();
    }
  } catch {}
  return "";
}

export function saveDefaultKernel(kernelId: string) {
  ensureDir();
  try {
    writeFileSync(defaultKernelFile(), kernelId.trim(), "utf8");
  } catch (err) {
    console.error("Failed to write default kernel:", err);
  }
}

function getKernelsListRaw() {
  const detected = detectInstalledBrowsers();
  const defaultKernel = loadDefaultKernel();
  const hasMatchedDefault = detected.some((b) => b.id === defaultKernel);
  return detected.map((b, idx) => ({
    ...b,
    isDefault: hasMatchedDefault ? b.id === defaultKernel : idx === 0,
  }));
}

/**
 * 组装真实的 Chromium 内核列表
 */
export function getKernelsList(): KernelItem[] {
  const detected = getKernelsListRaw();
  const tasks = readJson<TaskItem[]>(tasksFile(), []);

  return detected.map((b) => {
    const usageCount = tasks.filter(
      (t) => t.kernelId === b.id || t.kernel === b.name || t.kernel === b.id,
    ).length;
    const usage = usageCount > 0 ? `${usageCount} 个任务在用` : "就绪";

    return {
      id: b.id,
      name: b.name,
      ver: b.version ? `v${b.version}` : "已安装",
      source: "系统检测",
      path: b.path,
      health: "可用",
      ok: true,
      usage,
      isDefault: b.isDefault,
    };
  });
}

interface StoredProfileRecord {
  id: string;
  name: string;
  hue?: string;
  kernelId: string;
  dirName: string;
  isDefault?: boolean;
}

const PROFILE_COLORS = ["#6AA2FF", "#5FD0C0", "#B79CFF", "#E9A93E", "#F2766B", "#A0A7B0"];

/**
 * 加载所有浏览器内核对应的 Profile 列表。
 * 每个检测到的浏览器内核默认拥有一个「默认 Profile」，用户也可在任意内核下创建多个专属 Profile。
 */
export function loadProfiles(): ProfileItem[] {
  ensureDir();
  const pBaseDir = getAppBrowserProfilesDir();
  const kernels = getKernelsListRaw();
  const tasks = loadTasks();
  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);

  const result: ProfileItem[] = [];
  let colorIdx = 0;

  for (const k of kernels) {
    const kernelProfileRoot = path.join(pBaseDir, k.id);
    if (!existsSync(kernelProfileRoot)) {
      mkdirSync(kernelProfileRoot, { recursive: true });
    }

    // 1. 每个内核必有对应的默认 Profile
    const defaultId = `${k.id}::default`;
    const defaultRecord = stored.find((s) => s.id === defaultId);
    const defaultDir = path.join(kernelProfileRoot, "default");
    if (!existsSync(defaultDir)) {
      mkdirSync(defaultDir, { recursive: true });
    }

    const defaultName = defaultRecord?.name || "默认 Profile";
    const defaultUsageCount = tasks.filter((t) => t.kernelId === k.id && t.profileId === defaultId).length;
    result.push({
      id: defaultId,
      name: defaultName,
      initial: defaultName.slice(0, 1).toUpperCase(),
      hue: defaultRecord?.hue || PROFILE_COLORS[colorIdx++ % PROFILE_COLORS.length]!,
      kernelId: k.id,
      kernel: k.name,
      isDefault: true,
      usage: defaultUsageCount > 0 ? `${defaultUsageCount} 个任务在用` : "未使用",
      size: getFolderSize(defaultDir),
      dir: defaultDir,
    });

    // 2. 该内核下用户创建的自定义 Profile
    const customRecords = stored.filter((s) => s.kernelId === k.id && !s.isDefault && s.id !== defaultId);
    for (const rec of customRecords) {
      const dirName = rec.dirName || rec.id.split("::")[1] || rec.id;
      const customDir = path.join(kernelProfileRoot, dirName);
      if (!existsSync(customDir)) {
        mkdirSync(customDir, { recursive: true });
      }
      const usageCount = tasks.filter((t) => t.profileId === rec.id).length;
      result.push({
        id: rec.id,
        name: rec.name,
        initial: rec.name.slice(0, 1).toUpperCase(),
        hue: rec.hue || PROFILE_COLORS[colorIdx++ % PROFILE_COLORS.length]!,
        kernelId: k.id,
        kernel: k.name,
        isDefault: false,
        usage: usageCount > 0 ? `${usageCount} 个任务在用` : "未使用",
        size: getFolderSize(customDir),
        dir: customDir,
      });
    }
  }

  return result;
}

/**
 * 为指定浏览器内核新建一个对应的 Profile
 */
export function createProfileForKernel(kernelId: string, name: string): ProfileItem {
  ensureDir();
  const kernels = getKernelsListRaw();
  const targetKernel = kernels.find((k) => k.id === kernelId || k.name === kernelId) || kernels[0];
  if (!targetKernel) {
    throw new Error("未找到指定的浏览器内核");
  }

  const cleanName = name.trim() || "新 Profile";
  const dirName = `profile-${Date.now()}`;
  const id = `${targetKernel.id}::${dirName}`;
  const dir = path.join(getAppBrowserProfilesDir(), targetKernel.id, dirName);
  mkdirSync(dir, { recursive: true });

  const stored = readJson<StoredProfileRecord[]>(profilesFile(), []);
  const hue = PROFILE_COLORS[stored.length % PROFILE_COLORS.length]!;
  stored.push({
    id,
    name: cleanName,
    hue,
    kernelId: targetKernel.id,
    dirName,
    isDefault: false,
  });
  writeJson(profilesFile(), stored);

  return {
    id,
    name: cleanName,
    initial: cleanName.slice(0, 1).toUpperCase(),
    hue,
    kernelId: targetKernel.id,
    kernel: targetKernel.name,
    isDefault: false,
    usage: "未使用",
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
      name: profileData.name?.trim() || "默认 Profile",
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
    throw new Error("内核的默认 Profile 不可删除");
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
 * 根据传入的内核标识与 Profile 标识，解析出准确的内核与对应的 Profile
 */
export function resolveKernelAndProfile(
  kernelIdOrName?: string,
  profileIdOrName?: string,
): { kernel: KernelItem; profile: ProfileItem } {
  const kernels = getKernelsList();
  if (kernels.length === 0) {
    throw new Error("未检测到任何已安装的 Chromium 内核浏览器");
  }

  const defaultKernel = kernels.find((k) => k.isDefault) || kernels[0]!;
  const kernel =
    (kernelIdOrName &&
      kernels.find(
        (k) =>
          k.id === kernelIdOrName ||
          k.name === kernelIdOrName ||
          k.path === kernelIdOrName ||
          k.name.toLowerCase() === kernelIdOrName.toLowerCase(),
      )) ||
    defaultKernel;

  const profiles = loadProfiles();
  const kernelProfiles = profiles.filter((p) => p.kernelId === kernel.id);
  const defaultProfile = kernelProfiles.find((p) => p.isDefault) || kernelProfiles[0];

  if (!defaultProfile) {
    throw new Error(`未找到内核「${kernel.name}」对应的 Profile`);
  }

  const profile =
    (profileIdOrName &&
      kernelProfiles.find((p) => p.id === profileIdOrName || p.name === profileIdOrName)) ||
    defaultProfile;

  return { kernel, profile };
}
