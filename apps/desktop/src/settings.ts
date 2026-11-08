import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_MODEL, type ProviderConfig } from "@agent-browser/agent";
import type { ProbeTarget } from "./model-probe.ts";
import type { ModelProbeRequest, ProviderKind, ProviderSettingsView, SettingsUpdate } from "./shared.ts";

/** 本地存储的模型服务配置结构 */
interface StoredProvider {
  /** 接口 Base URL（若留空则走服务商官方默认地址） */
  baseURL?: string;
  /** 主要推理模型名称 */
  model?: string;
  /** 使用系统钥匙串（Electron safeStorage）加密后的 base64 密文字符串 */
  apiKey?: string;
}

/** 存在 settings.json 里的通用设置（开机启动以系统登录项为准，不存这里） */
export interface StoredGeneral {
  keepInBackground: boolean;
  notifyOnFinish: boolean;
  quitWarn: boolean;
  /** 第一次关窗口躲进后台时，是否已经发过「仍在后台运行」的提示 */
  closeHintShown: boolean;
}

/** 通用设置的默认值：留在后台、完成通知、退出提醒都默认打开 */
const DEFAULT_GENERAL: StoredGeneral = { keepInBackground: true, notifyOnFinish: true, quitWarn: true, closeHintShown: false };

/** 本地 settings.json 的全量持久化存储数据结构 */
export interface StoredSettings {
  /** 通用设置 */
  general: StoredGeneral;
  /** 当前选中的全局默认模型服务商 */
  provider: ProviderKind;
  /** Anthropic (Claude) 相关配置 */
  anthropic: StoredProvider;
  /** OpenAI 或兼容协议相关配置 */
  openai: StoredProvider;
}

/** OpenAI 默认官方接口地址 */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/**
 * 获取 settings.json 的持久化绝对路径。
 *
 * 【调用时机】
 * 在 `loadSettings` 读取与 `saveSettings` 写入时内部调用。
 *
 * 【作用】
 * 定位应用专有的用户数据目录中的 settings.json 文件路径。
 */
const file = () => path.join(app.getPath("userData"), "settings.json");

/**
 * 根据服务商类型获取对应的配置节点引用。
 *
 * 【调用时机】
 * 在更新配置、生成脱敏视图或获取当前运行配置时内部调用。
 *
 * 【作用】
 * 映射返回 StoredSettings 中对应的 provider 存储子对象。
 */
const section = (s: StoredSettings, kind: ProviderKind) => (kind === "anthropic" ? s.anthropic : s.openai);

/**
 * 从本地磁盘加载模型配置。
 *
 * 【调用时机】
 * Electron 主进程启动时（`app.whenReady()`）初始化系统配置时调用。
 *
 * 【作用】
 * 读取 `<userData>/settings.json` 并反序列化。若文件不存在或损坏，优雅降级为初始默认结构。
 *
 * @returns 完整的本地模型持久化配置对象
 */
export function loadSettings(): StoredSettings {
  let raw: any = {};
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {}
  return {
    general: { ...DEFAULT_GENERAL, ...raw.general },
    provider: raw.provider ?? "anthropic",
    anthropic: raw.anthropic ?? {},
    openai: raw.openai ?? {},
  };
}

/**
 * 将配置持久化保存到 settings.json 文件。
 *
 * 【调用时机】
 * 渲染进程通过 IPC `settings:save` 提交配置修改并应用后调用。
 *
 * 【作用】
 * 将内存中的 StoredSettings 序列化为格式化 JSON 写入磁盘，确保设置在重启后仍保留。
 *
 * @param s 待保存的全量配置对象
 */
export function saveSettings(s: StoredSettings) {
  writeFileSync(file(), JSON.stringify(s, null, 2));
}

/**
 * 解密保存在本地的 API 密钥。
 *
 * 【调用时机】
 * 1. 组装前端展示视图（`view`）时，检查本地是否已安全存储有效密钥；
 * 2. 任务启动创建 Agent（`activeProviderConfig`）时，解密出真实明文密钥传入 SDK。
 *
 * 【作用】
 * 使用 Electron 的 `safeStorage.decryptString` 对 Base64 编码的密文字符串进行系统钥匙串解密。
 * 若加密不可用或解密失败，安全降级返回 undefined。
 *
 * @param enc 加密后的 Base64 字符串
 * @returns 解密后的明文 API 密钥，失败则为 undefined
 */
function decrypt(enc: string | undefined): string | undefined {
  if (!enc || !safeStorage.isEncryptionAvailable()) return undefined;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return undefined;
  }
}

/**
 * 将渲染进程传递过来的 SettingsUpdate 增量应用到内存配置中。
 *
 * 【调用时机】
 * 用户在设置面板或环境配置页点击"保存"时，主进程处理 `IPC.saveSettings` 请求时调用。
 *
 * 【作用】
 * 1. 更新当前选中的提供商类别；
 * 2. 增量更新 baseURL、model 字段；
 * 3. 密钥安全处理：若请求包含明文 API Key，校验 Electron 系统安全存储可用性，加密后存入；若请求清除密钥则移除密文字段。
 *
 * @param s 待更新的内存设置对象
 * @param u 前端提交的增量更新负载
 */
export function applyUpdate(s: StoredSettings, u: SettingsUpdate) {
  s.provider = u.kind;
  const p = section(s, u.kind);
  const set = <K extends keyof StoredProvider>(key: K, value: StoredProvider[K] | undefined) => {
    if (value === undefined) return;
    if (value === "") delete p[key];
    else p[key] = value;
  };
  set("baseURL", u.baseURL?.trim());
  set("model", u.model?.trim());
  if (u.clearApiKey) delete p.apiKey;
  else if (u.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("安全存储不可用；请使用环境变量配置 API 密钥。");
    p.apiKey = safeStorage.encryptString(u.apiKey).toString("base64");
  }
}

/**
 * 解析探测（获取列表 / 测试）要使用的明文密钥与地址。
 *
 * 【调用时机】设置弹窗点击"获取列表"或"测试"时，由主进程调用。
 * 【作用】优先用表单新输入的密钥；留空则依次回退到已保存的密钥、环境变量。
 * 勾选"清除密钥"时不再使用已保存的密钥。
 */
export function probeTarget(s: StoredSettings, req: ModelProbeRequest): ProbeTarget {
  const p = section(s, req.kind);
  const env = req.kind === "anthropic" ? process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN : process.env.OPENAI_API_KEY;
  const apiKey = req.apiKey?.trim() || (req.ignoreStored ? undefined : decrypt(p.apiKey)) || env;
  const baseURL = req.baseURL.trim() || (req.kind === "openai-compatible" ? OPENAI_DEFAULT_BASE_URL : "");
  return { kind: req.kind, baseURL, ...(apiKey ? { apiKey } : {}) };
}

/**
 * 生成传递给前端的模型配置脱敏视图。
 *
 * 【调用时机】
 * 主进程组装 `AppState` 并推送给渲染进程（`state()` 方法）时，为每种服务商分别调用。
 *
 * 【作用】
 * 生成安全的前端视图对象，不向渲染进程暴露真实明文密钥，仅标记密钥当前来源（stored 本地安全存储、environment 环境变量、none 未配置），并附带界面所需的默认模型与 BaseURL。
 *
 * @param s 当前持久化配置对象
 * @param kind 目标模型服务商种类
 * @returns 脱敏后的前端视图对象
 */
export function view(s: StoredSettings, kind: ProviderKind): ProviderSettingsView {
  const p = section(s, kind);
  const envKey = kind === "anthropic" ? process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN : process.env.OPENAI_API_KEY;
  return {
    kind,
    baseURL: p.baseURL ?? (kind === "openai-compatible" ? OPENAI_DEFAULT_BASE_URL : ""),
    model: p.model ?? (kind === "anthropic" ? DEFAULT_MODEL : ""),
    credentials: decrypt(p.apiKey) ? "stored" : envKey ? "environment" : "none",
  };
}

/**
 * 获取当前活跃模型服务提供商的完整运行时配置。
 *
 * 【调用时机】
 * 任务即将启动时，由 `main.ts` 中的 `createAgentForSession` 调用，为 AgentSession 提供模型底层配置。
 *
 * 【作用】
 * 校验当前激活提供商的配置合规性，解密系统钥匙串中存储的真实密钥并合并环境变量，组装为底层 `@agent-browser/agent` 的 `ProviderConfig`。
 * 若关键配置缺失（例如 OpenAI 兼容接口未填写模型名称），返回直观的错误提示字符串以便阻断运行。
 *
 * @param s 当前持久化配置对象
 * @returns 合法的 ProviderConfig 运行时配置；若校验未通过则返回错误说明字符串
 */
export function activeProviderConfig(s: StoredSettings): ProviderConfig | string {
  const p = section(s, s.provider);
  const apiKey = decrypt(p.apiKey);
  if (s.provider === "anthropic") {
    return {
      kind: "anthropic",
      ...(apiKey ? { apiKey } : {}),
      ...(p.baseURL ? { baseURL: p.baseURL } : {}),
      ...(p.model ? { model: p.model } : {}),
    };
  }
  if (!p.model) return "请在设置中为 OpenAI 兼容接口指定模型名称。";
  return {
    kind: "openai-compatible",
    baseURL: p.baseURL ?? OPENAI_DEFAULT_BASE_URL,
    model: p.model,
    ...(apiKey ? { apiKey } : {}),
  };
}
