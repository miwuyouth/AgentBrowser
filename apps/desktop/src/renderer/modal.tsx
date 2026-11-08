import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { Icon } from "./icons.tsx";

/** 通用弹窗：点遮罩或按 Esc 关闭。新建 Profile、设置都用它 */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="modal-overlay" onMouseDown={onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} onMouseDown={(e) => e.stopPropagation()}>
        <div class="modal-head">
          <h2>{title}</h2>
          <button type="button" class="icon-btn" aria-label="关闭" onClick={onClose}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
