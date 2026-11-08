import { useEffect } from "preact/hooks";

/** 点击截图后放大查看，点任意处或按 Esc 关闭 */
export function Lightbox({ src, onClose }: { src: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div class="lightbox" role="dialog" aria-label="截图" onClick={onClose}>
      <img src={src} alt="步骤截图" />
    </div>
  );
}
