/**
 * 渲染进程里判断当前系统，用于快捷键文案和少量平台样式。
 * Electron 的 navigator.platform 在 macOS 上是 "MacIntel"，Windows 上是 "Win32"。
 */
export const isMac = /Mac/i.test(navigator.platform);

/**
 * 快捷键的显示文字：macOS 用 ⌘，其他系统用 Ctrl+。
 *
 * @param key 主键，例如 "N"、","、"["
 */
export const shortcut = (key: string) => (isMac ? `⌘${key}` : `Ctrl+${key}`);
