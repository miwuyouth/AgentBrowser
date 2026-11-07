import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { ensureKey } from "./gen-key.mjs";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const watch = process.argv.includes("--watch");

ensureKey();
rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

const iconsSrc = path.join(root, "icons");
if (existsSync(iconsSrc)) {
  cpSync(iconsSrc, path.join(dist, "icons"), { recursive: true });
}

const manifest = JSON.parse(readFileSync(path.join(root, "manifest.json"), "utf8"));
const { key, id } = JSON.parse(readFileSync(path.join(root, "extension-key.json"), "utf8"));
manifest.key = key;
writeFileSync(path.join(dist, "manifest.json"), JSON.stringify(manifest, null, 2));

const common = { bundle: true, target: "chrome116", logLevel: "info", sourcemap: "linked", legalComments: "none" };
await Promise.all([
  build({ ...common, entryPoints: [path.join(root, "src/background/index.ts")], outfile: path.join(dist, "background.js"), format: "esm" }),
  build({ ...common, entryPoints: [path.join(root, "src/content/index.ts")], outfile: path.join(dist, "content.js"), format: "iife" }),
]);
console.log(`extension built: ${dist}\nextension id: ${id}`);
if (watch) console.log("--watch is not implemented; rerun the build after changes");
