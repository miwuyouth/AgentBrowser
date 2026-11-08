import { useEffect, useState } from "preact/hooks";

interface Toast {
  id: number;
  message: string;
  isError: boolean;
}

type Listener = (message: string, isError: boolean) => void;
const listeners = new Set<Listener>();
let seq = 0;

/** 界面自己的操作结果（已复制、删除失败……）也用同一套轻提示 */
export function toast(message: string, isError = false) {
  listeners.forEach((l) => l(message, isError));
}

/** 主进程推来的 notice 事件（任务完成、启动失败等）和 toast() 都在这里显示，短暂停留后消失 */
export function ToastHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);

  useEffect(() => {
    const show: Listener = (message, isError) => {
      const id = ++seq;
      setToasts((t) => [...t, { id, message, isError }]);
      // 出错的提示多留一会儿，让人来得及读完
      setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), isError ? 7000 : 4000);
    };
    listeners.add(show);
    const off = window.agentApi.onEvent((e) => {
      if (e.type === "notice") show(e.message, !!e.isError);
    });
    return () => {
      listeners.delete(show);
      off();
    };
  }, []);

  return (
    <div class="toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} class={`toast ${t.isError ? "error" : ""}`}>
          {t.isError && <i class="dot fail" />}
          {t.message}
        </div>
      ))}
    </div>
  );
}
