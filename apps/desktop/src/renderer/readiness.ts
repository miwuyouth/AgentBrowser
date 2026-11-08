import type { AppState, KernelItem } from "../shared.ts";

export type KernelStatus = "done" | "installing" | "error" | "idle";

export interface Readiness {
  /** 已经配置好可用的模型服务（密钥来自本地或环境变量） */
  model: boolean;
  /** 已安装的内核；没有则为 undefined */
  kernel: KernelItem | undefined;
  kernelStatus: KernelStatus;
  /** 还没有内核时，应该自动下载哪一个（跳过需要授权 key 的） */
  downloadTarget: KernelItem | undefined;
  /** 已安装的内核下有可用的 Profile */
  profile: boolean;
  /** 三项全部就绪，可以开始运行任务 */
  all: boolean;
}

/** 判断「能不能开始跑任务」。引导页和任务页的提示卡共用这一份判断 */
export function getReadiness(state: AppState): Readiness {
  const p = state.provider;
  // Anthropic 必须有密钥；OpenAI 兼容接口（如本地 Ollama）可以没有密钥，但必须指定模型
  const model = p.kind === "anthropic" ? p.credentials !== "none" : !!p.model;

  const kernel = state.kernels.find((k) => k.installed);
  const downloadTarget = kernel ? undefined : state.kernels.find((k) => !k.needsLicense);
  const kernelStatus: KernelStatus = kernel
    ? "done"
    : downloadTarget?.installing
      ? "installing"
      : downloadTarget?.installError
        ? "error"
        : "idle";

  const profile = !!kernel && state.profiles.some((x) => x.kernelId === kernel.id);

  return { model, kernel, kernelStatus, downloadTarget, profile, all: model && !!kernel && profile };
}
