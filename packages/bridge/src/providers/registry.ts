import { ChromiumProvider } from "./chromium.ts";
import { CloakBrowserProvider } from "./cloakbrowser.ts";
import { isManagedProvider, type BrowserProvider, type ManagedProvider } from "./types.ts";

const providers = new Map<string, BrowserProvider>();

export function registerProvider(provider: BrowserProvider): void {
  providers.set(provider.id, provider);
}

/**
 * 注册内置的 provider。必须在使用任何 provider 之前调用一次；
 * kernelsDir 是 App 自己管理内核的根目录，不会去扫描系统里已安装的浏览器。
 */
export function initProviders(opts: { kernelsDir: string }): void {
  providers.clear();
  registerProvider(new ChromiumProvider(opts));
  registerProvider(new CloakBrowserProvider(opts));
}

export function getProvider(id: string): BrowserProvider {
  const p = providers.get(id);
  if (!p) throw new Error(`未知的浏览器类型：${id}`);
  return p;
}

export function listProviders(): BrowserProvider[] {
  return [...providers.values()];
}

export function listManagedProviders(): ManagedProvider[] {
  return listProviders().filter(isManagedProvider);
}
