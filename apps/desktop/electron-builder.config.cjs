/**
 * electron-builder 打包配置（原先写在 package.json 的 build 字段里）。
 *
 * 用 JS 写是为了让 electronDist 能按目标平台区分：
 * - 在 Mac 上打 Mac 包：直接用 node_modules 里已装好的 Electron，不用再联网下载；
 * - 打 Windows 包：本机装的是 Mac 版 Electron 用不了，返回 null 让 electron-builder 下载对应平台的版本
 *   （网络不通时可设置环境变量 ELECTRON_MIRROR 换镜像）。
 */
const LOCAL_ELECTRON = "node_modules/electron/dist";

/** @type {import("electron-builder").Configuration} */
module.exports = {
  appId: "com.agentbrowser.desktop",
  productName: "Agent Browser",
  directories: {
    output: "release",
  },
  electronDist: ({ platformName, arch }) =>
    platformName === process.platform && arch === process.arch ? LOCAL_ELECTRON : null,
  files: ["dist/**/*"],
  extraResources: [
    {
      from: "../../packages/extension/dist",
      to: "extension",
    },
  ],
  mac: {
    icon: "assets/icon.icns",
    target: ["dir", "dmg"],
    category: "public.app-category.productivity",
  },
  win: {
    // 至少 256×256 的 PNG，electron-builder 会自动转成 .ico
    icon: "assets/icon.png",
    target: [{ target: "nsis", arch: ["x64"] }],
  },
  nsis: {
    // 安装向导：可选安装位置，默认装在当前用户下（不需要管理员权限）
    oneClick: false,
    perMachine: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: "Agent Browser",
  },
};
