/**
 * 渲染层共用的视觉原子：图标、状态标记、空状态、更多菜单、转义。
 * 所有页面都从这里取组件，保证同一套线条粗细、尺寸与语义。
 */

export function escapeHtml(str: string): string {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** 统一图标集：24 网格、1.75 线条、圆头圆角，视觉尺寸一致 */
const ICONS = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  tasks: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01"/>',
  runs: '<path d="M3 12h4l2.5 7 4-14 2.5 7H21"/>',
  kernel: '<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="3.2"/><path d="M12 8.8h8.5M9.2 13.6 4.9 6.2M14.8 13.6l-4.3 7.2"/>',
  profile: '<circle cx="12" cy="8.5" r="3.6"/><path d="M4.5 20a7.5 7.5 0 0 1 15 0"/>',
  settings:
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6 1.65 1.65 0 0 0 10 3.09V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9v.09a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
  moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  search: '<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-3.7-3.7"/>',
  play: '<path d="M8 5.2v13.6L19 12z" fill="currentColor" stroke="none"/>',
  stop: '<rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" stroke="none"/>',
  edit: '<path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4 16.5z"/><path d="M14.5 6.5 17.5 9.5"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  trash: '<path d="M4 7h16M10 7V5.5A1.5 1.5 0 0 1 11.5 4h1A1.5 1.5 0 0 1 14 5.5V7M6.5 7l.8 11.6A1.5 1.5 0 0 0 8.8 20h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7"/>',
  chevronRight: '<path d="M9 6l6 6-6 6"/>',
  chevronDown: '<path d="M6 9l6 6 6-6"/>',
  chevronUp: '<path d="M18 15l-6-6-6 6"/>',
  arrowLeft: '<path d="M19 12H5M11 19l-7-7 7-7"/>',
  refresh: '<path d="M20 12a8 8 0 1 1-2.6-5.9M20 4v4.5h-4.5"/>',
  external: '<path d="M14 4h6v6M20 4l-8.5 8.5M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  folder: '<path d="M3 7.5A1.5 1.5 0 0 1 4.5 6h4L10 8h9.5A1.5 1.5 0 0 1 21 9.5v8A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z"/>',
  check: '<path d="M4.5 12.5 9 17l10.5-10.5"/>',
  alert: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5.5"/><path d="M12 16.3h.01"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7v5.2l3.2 1.9"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="9.5" rx="2"/><path d="M8 10.5V7.6a4 4 0 0 1 8 0v2.9"/>',
  browser: '<rect x="3" y="4.5" width="18" height="15" rx="2"/><path d="M3 9h18"/><path d="M6.5 6.8h.01M9 6.8h.01"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M15 9V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h3"/>',
  history: '<path d="M3.5 12a8.5 8.5 0 1 0 2.6-6.1M3.5 4v5h5"/><path d="M12 8v4.4l3 1.8"/>',
  spark: '<path d="M12 3.5 13.8 9l5.5 1.8-5.5 1.8L12 18l-1.8-5.4L4.7 10.8 10.2 9z"/>',
} as const;

export type IconName = keyof typeof ICONS;

export function icon(name: IconName, size = 16): string {
  return `<svg class="ico" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
}

export type StatusKind = "ok" | "run" | "fail" | "idle" | "warn";

/** 状态标记：圆点承载颜色，文字保证可读 —— 不靠颜色单独传达信息 */
export function status(kind: StatusKind, label: string): string {
  return `<span class="status status-${kind}"><span class="status-dot" aria-hidden="true"></span><span class="status-label">${escapeHtml(label)}</span></span>`;
}

/** 空状态：说明这里会出现什么，并给出开始操作的入口 */
export function emptyState(opts: {
  icon: IconName;
  title: string;
  desc: string;
  actions?: string;
}): string {
  return `
    <div class="empty">
      <div class="empty-icon">${icon(opts.icon, 22)}</div>
      <h3 class="empty-title">${escapeHtml(opts.title)}</h3>
      <p class="empty-desc">${escapeHtml(opts.desc)}</p>
      ${opts.actions ? `<div class="empty-actions">${opts.actions}</div>` : ""}
    </div>
  `;
}

/** 低频操作的「更多」菜单：<details> 实现，点击外部或 Esc 由 app.ts 统一关闭 */
export function moreMenu(items: string, label = "更多操作"): string {
  return `
    <details class="menu">
      <summary class="icon-btn" aria-label="${escapeHtml(label)}" title="${escapeHtml(label)}">${icon("more", 16)}</summary>
      <div class="menu-list" role="menu">${items}</div>
    </details>
  `;
}
