import { cpSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { BRIDGE_CONFIG_FILE, type BridgeConfig, type ScreenshotOptions } from "@agent-browser/protocol";

/**
 * 为本次会话准备一份独立的扩展副本：把随机端口和 Token 写入 bridge-config.json。
 * 所有通过扩展控制页面的 provider 共用这一步。返回扩展副本的目录。
 */
export function prepareExtension(opts: {
  extensionDir: string;
  dataDir: string;
  bridge: { port: number; token: string };
  screenshot?: ScreenshotOptions | undefined;
}): string {
  const extensionDir = path.join(opts.dataDir, "extension");
  rmSync(extensionDir, { recursive: true, force: true });
  cpSync(opts.extensionDir, extensionDir, { recursive: true });
  const config: BridgeConfig = {
    port: opts.bridge.port,
    token: opts.bridge.token,
    ...(opts.screenshot ? { screenshot: opts.screenshot } : {}),
  };
  writeFileSync(path.join(extensionDir, BRIDGE_CONFIG_FILE), JSON.stringify(config));
  return extensionDir;
}
