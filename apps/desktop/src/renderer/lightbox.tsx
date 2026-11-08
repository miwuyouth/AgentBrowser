import { useEffect } from "preact/hooks";
import { Icon } from "./icons.tsx";

/**
 * 屏幕截图全屏放大预览灯箱组件。
 *
 * 【调用时机】
 * 在实时监控页面（LiveView）或运行详情页（RunDetailView）中，用户点击屏幕截图缩略图时渲染。
 *
 * 【作用】
 * 以高层级全屏遮罩居中呈现原始高清截图图片；支持按下键盘 Escape 键或用鼠标点击屏幕任意空白处快速退出关闭。
 * 传入 `onPrev` / `onNext` 时进入"图集"模式：显示左右切换按钮，并支持键盘 ← → 翻页；
 * 传入 `caption` 时在图片下方显示说明（如"第 12 步 · 点击元素"）。
 *
 * @param src 截图资源的协议地址（通常为 shot:// 形式）
 * @param onClose 退出预览的回调函数
 * @param caption 可选，图片说明文字
 * @param onPrev 可选，切换到上一张；无上一张时不传
 * @param onNext 可选，切换到下一张；无下一张时不传
 */
export function Lightbox({
  src,
  onClose,
  caption,
  onPrev,
  onNext,
}: {
  src: string;
  onClose: () => void;
  caption?: string;
  onPrev?: () => void;
  onNext?: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      else if (e.key === "ArrowLeft") onPrev?.();
      else if (e.key === "ArrowRight") onNext?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, onPrev, onNext]);

  const nav = (cls: string, label: string, icon: "back" | "chevron", go?: () => void) =>
    go && (
      <button
        type="button"
        class={`lightbox-nav ${cls}`}
        aria-label={label}
        onClick={(e) => {
          e.stopPropagation();
          go();
        }}
      >
        <Icon name={icon} size={20} />
      </button>
    );

  return (
    <div class="lightbox" role="dialog" aria-label="截图" onClick={onClose}>
      {nav("prev", "上一张", "back", onPrev)}
      <figure class="lightbox-fig">
        <img src={src} alt={caption ?? "步骤截图"} />
        {caption && <figcaption>{caption}</figcaption>}
      </figure>
      {nav("next", "下一张", "chevron", onNext)}
    </div>
  );
}
