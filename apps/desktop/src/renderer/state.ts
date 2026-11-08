import { useEffect, useState } from "preact/hooks";
import type { AppState } from "../shared.ts";

/**
 * 响应式全局应用状态 Hook。
 *
 * 【调用时机】
 * 在应用的根级入口组件（`app.tsx` 中的 `Main` 组件）中调用，作为贯穿整个前端视图树的单一响应式数据源。
 *
 * 【作用】
 * 1. 初始化挂载时，通过 IPC 调用 `window.agentApi.getState()` 拉取主进程维护的初始 AppState 全量状态；
 * 2. 通过 `window.agentApi.onEvent` 注册长连接事件监听，响应来自主进程的推送更新：
 *    - `e.type === "state"`: 主进程广播全量状态变更（如新建任务、设置保存等），直接替换当前状态；
 *    - `e.type === "kernel_progress"`: 内核下载阶段主进程不推全量 state，此处局部增量合并进度（progress、progressText）；
 *    - `e.type === "run_update"`: 任务执行中每产生一个步骤或截图，局部实时更新 `activeRun` 对象，保证高频打点顺畅且不造成全局大重绘；
 * 3. 在组件卸载时自动执行注销清理回调。
 *
 * @returns 当前最新的全局应用状态 AppState，未完成初次加载前为 null
 */
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
