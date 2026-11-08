/**
 * 内置矢量图标库（SVG Path 路径定义集合）。
 * 采用 24x24 视口的极简线性风格图标。
 */
const PATHS = {
  tasks: "M9 6h11M9 12h11M9 18h11M4 6l1 1 2-2M4 12l1 1 2-2M4 18l1 1 2-2",
  runs: "M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2",
  env: "M7 5h10a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
  plus: "M12 5v14M5 12h14",
  check: "m5 12 5 5 9-10",
  close: "M18 6 6 18M6 6l12 12",
  chevron: "m9 6 6 6-6 6",
  back: "m15 6-6 6 6 6",
  trash: "M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3",
  play: "M7 5v14l11-7z",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1 7 17M17 7l2.1-2.1",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z",
  monitor: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 21h8M12 17v4",
  window: "M5 4h14a3 3 0 0 1 3 3v10a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3zM2 9h20",
  copy: "M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2M16 4h-6a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V8l-4-4z",
} as const;

/** 支持的内置图标名称字面量类型 */
export type IconName = keyof typeof PATHS;

/**
 * 统一样式与大小的 SVG 矢量图标组件。
 *
 * 【调用时机】
 * 在侧边栏导航、操作按钮、表单控件及卡片状态展示中广泛渲染。
 *
 * 【作用】
 * 根据传入的名称（name）渲染对应的内嵌 SVG 路径，并应用统一的无障碍隐藏属性（`aria-hidden="true"`）与尺寸配置。
 *
 * @param name 图标名称
 * @param size 图标物理像素尺寸，默认为 16
 */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg class="icon" viewBox="0 0 24 24" width={size} height={size} aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}
