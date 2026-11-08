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
  // cloakbrowser (ESM) and playwright-core (dynamic requires) are loaded from node_modules at runtime.
  external: ["electron", "bufferutil", "utf-8-validate", "cloakbrowser", "playwright-core"],
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
    jsx: "automatic",
    jsxImportSource: "preact",
    entryPoints: [path.join(root, "src/renderer/app.tsx")],
    outfile: path.join(dist, "renderer/app.js"),
  }),
]);
for (const f of ["index.html", "styles.css", "logo.svg"]) {
  const srcFile = path.join(root, "src/renderer", f);
  if (existsSync(srcFile)) cpSync(srcFile, path.join(dist, "renderer", f));
}

// 主进程窗口图标、菜单栏（托盘）图标
const assetsDir = path.join(root, "assets");
for (const f of ["icon.png", "trayTemplate.png", "trayTemplate@2x.png"]) {
  const srcFile = path.join(assetsDir, f);
  if (existsSync(srcFile)) cpSync(srcFile, path.join(dist, f));
}

console.log("desktop app built");
process.exit(0);
