import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../shared.ts";

/** 读取主进程的全局状态，并随主进程推送的 state / run_update / kernel_progress 事件自动更新 */
export function useAppState(): AppState | null {
  const [state, setState] = useState<AppState | null>(null);

  useEffect(() => {
    void window.agentApi.getState().then(setState);
    return window.agentApi.onEvent((e) => {
      if (e.type === "state") setState(e.state);
      // 运行中每一步、每一秒都会推 run_update；只接收正在运行的那一次，避免结束后被旧数据覆盖
      else if (e.type === "kernel_progress") {
        // 下载过程中后端只推 kernel_progress，不推 state，进度要在这里合并进去
        setState(
          (prev) =>
            prev && {
              ...prev,
              kernels: prev.kernels.map((k) =>
                k.id === e.kernelId
                  ? {
                      ...k,
                      installing: true,
                      ...(e.fraction !== undefined ? { progress: e.fraction } : {}),
                      ...(e.message ? { progressText: e.message } : {}),
                    }
                  : k,
              ),
            },
        );
      } else if (e.type === "run_update") {
        setState((prev) => (prev && (e.run.status === "run" || prev.activeRun?.id === e.run.id) ? { ...prev, activeRun: e.run } : prev));
      }
    });
  }, []);

  return state;
}
