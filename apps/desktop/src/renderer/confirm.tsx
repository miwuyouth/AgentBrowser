import { useEffect, useRef, useState } from "preact/hooks";

/** 确认框的内容 */
export interface ConfirmOptions {
  /** 一句话问题，粗体显示，例如「删除这条运行记录？」 */
  title: string;
  /** 补充说明，每项一行，常规字号显示 */
  detail?: string | string[];
  /** 确认按钮文字，用动词，例如「删除」「卸载」 */
  confirmLabel: string;
  /** 不可恢复的操作：确认按钮用红色 */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let show: ((p: Pending) => void) | null = null;

/**
 * 弹出应用内确认框，替代 `window.confirm`（后者在 Electron 里是系统原生弹窗，按钮固定为英文、无法统一风格）。
 *
 * 【调用时机】
 * 删除、卸载等需要用户再确认一次的操作前调用。
 *
 * @returns 用户点了确认按钮为 `true`；取消、按 Esc、点遮罩为 `false`
 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return new Promise((resolve) => {
    if (!show) return resolve(false);
    show({ ...options, resolve });
  });
}

/**
 * 确认框宿主组件，在根组件里常驻挂载一次。
 *
 * 【作用】
 * 1. 同一时间只显示一个确认框；
 * 2. 打开时焦点落在「取消」上，回车不会误删；Tab 只在两个按钮之间切换；
 * 3. Esc / 点遮罩 = 取消；关闭后焦点回到打开前的元素。
 */
export function ConfirmHost() {
  const [pending, setPending] = useState<Pending | null>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const okRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    show = (p) => {
      setPending((prev) => {
        prev?.resolve(false);
        return p;
      });
    };
    return () => {
      show = null;
    };
  }, []);

  const close = (ok: boolean) => {
    if (!pending) return;
    pending.resolve(ok);
    setPending(null);
    restoreRef.current?.focus();
    restoreRef.current = null;
  };

  useEffect(() => {
    if (!pending) return;
    if (!restoreRef.current) restoreRef.current = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopImmediatePropagation();
        close(false);
      } else if (e.key === "Tab") {
        e.preventDefault();
        const next = document.activeElement === cancelRef.current ? okRef.current : cancelRef.current;
        next?.focus();
      }
    };
    // 捕获阶段拦截，避免底下的设置弹窗等同时响应 Esc
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [pending]);

  if (!pending) return null;

  const lines = pending.detail === undefined ? [] : Array.isArray(pending.detail) ? pending.detail : [pending.detail];

  return (
    <div class="modal-overlay confirm-overlay" onMouseDown={() => close(false)}>
      <div
        class="modal confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={lines.length ? "confirm-detail" : undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 id="confirm-title" class="confirm-title">{pending.title}</h2>
        {lines.length > 0 && (
          <div id="confirm-detail" class="confirm-detail">
            {lines.map((l) => (
              <p key={l}>{l}</p>
            ))}
          </div>
        )}
        <div class="confirm-foot">
          <button ref={cancelRef} type="button" class="btn" onClick={() => close(false)}>
            取消
          </button>
          <button
            ref={okRef}
            type="button"
            class={`btn ${pending.danger ? "btn-danger" : "btn-primary"}`}
            onClick={() => close(true)}
          >
            {pending.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
