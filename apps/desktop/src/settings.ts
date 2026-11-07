import { app, safeStorage } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_FIND_MODEL, DEFAULT_MODEL, type Effort, type ProviderConfig } from "@agent-browser/agent";
import type { ProviderKind, ProviderSettingsView, SettingsUpdate } from "./shared.ts";

/** 本地存储的模型服务配置结构 */
interface StoredProvider {
  baseURL?: string;
  model?: string;
  findModel?: string;
  effort?: Effort;
  vision?: boolean;
  /** 使用系统钥匙串（Electron safeStorage）加密后的 base64 密文 */
  apiKey?: string;
}

/** 本地 settings.json 的全量持久化结构 */
export interface StoredSettings {
  provider: ProviderKind;
  anthropic: StoredProvider;
  openai: StoredProvider;
}

/** OpenAI 默认官方接口地址 */
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";

/** settings.json 文件所在路径（位于应用专有配置目录中） */
const file = () => path.join(app.getPath("userData"), "settings.json");
const section = (s: StoredSettings, kind: ProviderKind) => (kind === "anthropic" ? s.anthropic : s.openai);

/**
 * 从本地磁盘加载模型配置
 */
export function loadSettings(): StoredSettings {
  let raw: any = {};
  try {
    raw = JSON.parse(readFileSync(file(), "utf8"));
  } catch {}
  if (!raw.anthropic && !raw.openai) {
    const { model, effort, apiKey } = raw;
    raw = { provider: "anthropic", anthropic: { model, effort, apiKey }, openai: {} };
  }
  return {
    provider: raw.provider ?? "anthropic",
    anthropic: raw.anthropic ?? {},
    openai: raw.openai ?? {},
  };
}

/**
 * 将配置持久化保存到 settings.json
 */
export function saveSettings(s: StoredSettings) {
  writeFileSync(file(), JSON.stringify(s, null, 2));
}

/**
 * 解密保存在本地的 API 密钥
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
 * 将渲染进程传递过来的 SettingsUpdate 增量应用到内存配置中
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
  set("findModel", u.findModel?.trim());
  set("effort", u.effort);
  set("vision", u.vision);
  if (u.clearApiKey) delete p.apiKey;
  else if (u.apiKey) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error("安全存储不可用；请使用环境变量配置 API 密钥。");
    p.apiKey = safeStorage.encryptString(u.apiKey).toString("base64");
  }
}

/**
 * 生成传递给前端的模型配置视图（脱敏显示密钥来源）
 */
export function view(s: StoredSettings, kind: ProviderKind): ProviderSettingsView {
  const p = section(s, kind);
  const envKey = kind === "anthropic" ? process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN : process.env.OPENAI_API_KEY;
  return {
    kind,
    baseURL: p.baseURL ?? (kind === "openai-compatible" ? OPENAI_DEFAULT_BASE_URL : ""),
    model: p.model ?? (kind === "anthropic" ? DEFAULT_MODEL : ""),
    findModel: p.findModel ?? (kind === "anthropic" && !p.baseURL ? DEFAULT_FIND_MODEL : ""),
    effort: p.effort ?? "high",
    vision: p.vision ?? true,
    credentials: decrypt(p.apiKey) ? "stored" : envKey ? "environment" : "none",
  };
}

/**
 * 获取当前活跃模型服务提供商的完整配置，未填全时返回说明提示
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
      ...(p.findModel ? { findModel: p.findModel } : {}),
      effort: p.effort ?? "high",
    };
  }
  if (!p.model) return "请在设置中为 OpenAI 兼容接口指定模型名称。";
  return {
    kind: "openai-compatible",
    baseURL: p.baseURL ?? OPENAI_DEFAULT_BASE_URL,
    model: p.model,
    ...(apiKey ? { apiKey } : {}),
    ...(p.findModel ? { findModel: p.findModel } : {}),
    vision: p.vision ?? true,
  };
}
