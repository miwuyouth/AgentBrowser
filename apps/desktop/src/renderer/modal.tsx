import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { Icon } from "./icons.tsx";

/**
 * 通用模态对话框容器组件。
 *
 * 【调用时机】
 * 在系统设置弹窗（`SettingsModal`）、新建 Profile 弹窗等需要浮层阻断交互的场景中渲染。
 *
 * 【作用】
 * 1. 渲染全屏暗色半透明遮罩与居中浮窗结构；
 * 2. 键盘交互：监听全局键盘事件，当用户按下 Escape 键时自动触发 `onClose`；
 * 3. 鼠标交互：点击遮罩背景自动关闭，同时对内部容器阻止事件冒泡防止误触；
 * 4. 规范无障碍访问属性（`role="dialog"`、`aria-modal="true"`）。
 *
 * @param title 弹窗标题
 * @param onClose 关闭回调函数
 * @param width 可选的自定义最大宽度
 * @param children 弹窗内部插槽内容
 */
export function Modal({
  title,
  onClose,
  width,
  children,
}: {
  title: string;
  onClose: () => void;
  width?: number | string;
  children: ComponentChildren;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const style = width ? { maxWidth: typeof width === "number" ? `${width}px` : width } : undefined;

  return (
    <div class="modal-overlay" onMouseDown={onClose}>
      <div class="modal" role="dialog" aria-modal="true" aria-label={title} style={style} onMouseDown={(e) => e.stopPropagation()}>
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
