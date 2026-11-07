import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
rmSync(dist, { recursive: true, force: true });
mkdirSync(path.join(dist, "renderer"), { recursive: true });

const node = {
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node22",
  sourcemap: "linked",
  logLevel: "info",
  // ws optionally loads native addons; Electron is provided at runtime.
  external: ["electron", "bufferutil", "utf-8-validate"],
};
await Promise.all([
  build({ ...node, entryPoints: [path.join(root, "src/main.ts")], outfile: path.join(dist, "main.cjs") }),
  build({ ...node, entryPoints: [path.join(root, "src/preload.ts")], outfile: path.join(dist, "preload.cjs") }),
  build({
    bundle: true,
    platform: "browser",
    format: "iife",
    target: "chrome130",
    sourcemap: "linked",
    logLevel: "info",
    entryPoints: [path.join(root, "src/renderer/app.ts")],
    outfile: path.join(dist, "renderer/app.js"),
  }),
]);
for (const f of ["index.html", "styles.css", "logo.svg"]) {
  const srcFile = path.join(root, "src/renderer", f);
  if (existsSync(srcFile)) cpSync(srcFile, path.join(dist, "renderer", f));
}

// 复制应用图标资产到 dist 目录
const assetsDir = path.join(root, "assets");
for (const iconFile of ["icon.png", "icon.icns", "icon.svg"]) {
  const srcIcon = path.join(assetsDir, iconFile);
  if (existsSync(srcIcon)) cpSync(srcIcon, path.join(dist, iconFile));
}

// 同步更新本地 Electron.app 的默认图标包，确保 macOS Dock 在开发模式下也展示产品图标
const electronResources = path.join(root, "node_modules/electron/dist/Electron.app/Contents/Resources");
const icnsSrc = path.join(assetsDir, "icon.icns");
if (existsSync(electronResources) && existsSync(icnsSrc)) {
  try {
    cpSync(icnsSrc, path.join(electronResources, "electron.icns"));
  } catch {}
}

console.log("desktop app built");
