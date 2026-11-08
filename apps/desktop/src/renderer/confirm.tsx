import { useEffect, useRef, useState } from "preact/hooks";
import type { AppPrompt, PromptAnswer } from "../shared.ts";

/** 确认框的内容，见 `AppPrompt` */
export type ConfirmOptions = AppPrompt;
/** 带复选框的确认结果 */
export type ConfirmResult = PromptAnswer;

interface Pending extends ConfirmOptions {
  resolve: (result: ConfirmResult) => void;
}

/** 宿主挂载前就要弹的确认框，挂载后依次弹出 */
const waiting: Pending[] = [];
let enqueue: ((p: Pending) => void) | null = null;

/**
 * 弹出应用内确认框，替代 `window.confirm`（后者在 Electron 里是系统原生弹窗，按钮固定为英文、无法统一风格）。
 *
 * 【调用时机】
 * 删除、卸载等需要用户再确认一次的操作前调用。
 *
 * @returns 用户点了确认按钮为 `true`；取消、按 Esc、点遮罩为 `false`
 */
export async function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return (await confirmWithCheckbox(options)).ok;
}

/**
 * 同 `confirmDialog`，但同时返回复选框（`checkboxLabel`）的勾选状态。
 *
 * 【调用时机】需要「不再提醒」这类附加选项的确认。
 * 【作用】已有确认框在显示时排在它后面；宿主还没挂载时先存着，挂载后再弹。
 */
export function confirmWithCheckbox(options: ConfirmOptions): Promise<ConfirmResult> {
  return new Promise((resolve) => {
    const p = { ...options, resolve };
    if (enqueue) enqueue(p);
    else waiting.push(p);
  });
}

/** 已经弹过的主进程确认框 ID：事件和补拉可能各来一次，只弹一次 */
const shownPrompts = new Set<number>();

/**
 * 弹出主进程发来的确认框，并把选择回复给主进程。
 *
 * 【调用时机】收到主进程的 prompt 事件，或界面加载好后补拉到未回复的确认框时调用。
 */
export function showAppPrompt(id: number, prompt: AppPrompt) {
  if (shownPrompts.has(id)) return;
  shownPrompts.add(id);
  void confirmWithCheckbox(prompt).then((answer) => window.agentApi.answerPrompt(id, answer));
}

/**
 * 确认框宿主组件，在根组件里常驻挂载一次。
 *
 * 【作用】
 * 1. 同一时间只显示一个确认框，后来的排队，前一个关掉后再弹；
 * 2. 打开时焦点落在「取消」上，回车不会误删；Tab 只在框内的复选框和按钮之间切换；
 * 3. Esc / 点遮罩 = 取消；关闭后焦点回到打开前的元素。
 */
export function ConfirmHost() {
  const [queue, setQueue] = useState<Pending[]>([]);
  const pending = queue[0] ?? null;
  const [checked, setChecked] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    enqueue = (p) => setQueue((q) => [...q, p]);
    const early = waiting.splice(0);
    if (early.length) setQueue((q) => [...early, ...q]);
    return () => {
      enqueue = null;
    };
  }, []);

  const close = (ok: boolean) => {
    if (!pending) return;
    pending.resolve({ ok, checked: ok && checked });
    setQueue((q) => q.slice(1));
    setChecked(false);
    if (queue.length > 1) return;
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
        const items = Array.from(boxRef.current?.querySelectorAll<HTMLElement>("input, button") ?? []);
        if (!items.length) return;
        const at = items.indexOf(document.activeElement as HTMLElement);
        const step = e.shiftKey ? -1 : 1;
        items[(at + step + items.length) % items.length]?.focus();
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
        ref={boxRef}
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
        {pending.checkboxLabel && (
          <label class="confirm-check">
            <input type="checkbox" checked={checked} onChange={(e) => setChecked(e.currentTarget.checked)} />
            {pending.checkboxLabel}
          </label>
        )}
        <div class="confirm-foot">
          <button ref={cancelRef} type="button" class="btn" onClick={() => close(false)}>
            {pending.cancelLabel ?? "取消"}
          </button>
          <button
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
