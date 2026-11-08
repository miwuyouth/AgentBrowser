import { useEffect, useState } from "preact/hooks";

/** Toast 轻提示数据项 */
interface Toast {
  id: number;
  message: string;
  isError: boolean;
}

type Listener = (message: string, isError: boolean) => void;
const listeners = new Set<Listener>();
let seq = 0;

/**
 * 触发一个全局轻提示消息。
 *
 * 【调用时机】
 * 渲染进程用户操作完成（如"已复制到剪贴板"、"校验失败"）时由前端组件直接调用。
 *
 * 【作用】
 * 通知所有已注册的轻提示宿主组件显示新气泡。
 *
 * @param message 提示文本
 * @param isError 是否为失败/错误类提示（样式呈红色警示）
 */
export function toast(message: string, isError = false) {
  listeners.forEach((l) => l(message, isError));
}

/**
 * 全局轻提示浮层宿主组件。
 *
 * 【调用时机】
 * 在应用的根组件（`app.tsx` 中的 `App`）最外层持续挂载渲染。
 *
 * 【作用】
 * 统一承载并渲染所有轻提示：
 * 1. 监听来自渲染层内部通过 `toast()` 触发的操作提示；
 * 2. 监听来自主进程通过 IPC 推送的 `notice` 事件（例如任务后台定时执行成功、内核安装完毕等）；
 * 3. 自动定时清理：普通提示 4 秒后自动淡出消失，报错类提示延长保留至 7 秒以保证用户来得及阅读。
 */
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
