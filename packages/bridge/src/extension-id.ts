import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * 根据 Chromium 官方算法计算已解压扩展的唯一 Extension ID：
 * 1. 取 manifest.json 中公钥 key 的 base64 解码数据；
 * 2. 进行 SHA-256 哈希计算；
 * 3. 截取前 32 位十六进制字符；
 * 4. 将每位十六进制映射为字母 a-p（0 -> 'a', 15 -> 'p'），生成形如 `gbkhmpegikjdanijdnpknikfopnplpcc` 的固定 ID。
 */
function extensionIdFromKey(base64Key: string): string {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

/**
 * 从指定的扩展目录中读取 manifest.json 中的 key 并计算对应的 Extension ID
 */
export function extensionIdFromDir(extensionDir: string): string {
  const manifest = JSON.parse(readFileSync(path.join(extensionDir, "manifest.json"), "utf8"));
  if (typeof manifest.key !== "string") {
    throw new Error(`${extensionDir}/manifest.json 缺少 "key" 字段；请通过构建脚本编译扩展。`);
  }
  return extensionIdFromKey(manifest.key);
}
