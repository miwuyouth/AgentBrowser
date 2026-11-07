// Generates the public key that pins the extension ID.
// Chrome derives the ID of an unpacked extension from `key` in manifest.json,
// so the App can verify the WebSocket Origin. The private key is not needed
// for unpacked loading and is discarded.
import { generateKeyPairSync, createHash } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, "..", "extension-key.json");

export function extensionIdFromKey(base64Key) {
  const hex = createHash("sha256").update(Buffer.from(base64Key, "base64")).digest("hex").slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
}

export function ensureKey({ force = false } = {}) {
  if (existsSync(out) && !force) return;
  const { publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const key = publicKey.toString("base64");
  writeFileSync(out, JSON.stringify({ key, id: extensionIdFromKey(key) }, null, 2) + "\n");
  console.log(`wrote ${path.relative(process.cwd(), out)}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  ensureKey({ force: process.argv.includes("--force") });
}
