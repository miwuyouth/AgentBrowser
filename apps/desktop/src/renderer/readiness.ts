import type { AppState, KernelItem } from "../shared.ts";

/** 内核状态枚举：已就绪、下载中、安装错误、未安装且空闲 */
export type KernelStatus = "done" | "installing" | "error" | "idle";

/** 环境就绪度评估结果结构 */
export interface Readiness {
  /** 已经配置好可用的模型服务（密钥来自本地安全存储或系统环境变量） */
  model: boolean;
  /** 已安装的内核对象；若尚未安装任何内核则为 undefined */
  kernel: KernelItem | undefined;
  /** 内核当前的准备状态 */
  kernelStatus: KernelStatus;
  /** 还没有任何内核时，系统建议优先自动下载的目标内核（自动跳过需要商业授权 Key 的） */
  downloadTarget: KernelItem | undefined;
  /** 已安装的内核下是否存在可用的 Profile */
  profile: boolean;
  /** 模型、内核、Profile 三项全部就绪，可以随时发起执行任务 */
  all: boolean;
}

/**
 * 评估当前系统运行环境的就绪程度（判断"能不能开始跑任务"）。
 *
 * 【调用时机】
 * 1. 根组件（`app.tsx`）首屏初始化时调用，用于决定是否对新用户弹出新手引导向导（Onboarding）；
 * 2. 任务列表页面（`TasksView`）渲染时调用，若未全部就绪，在顶部展示分步引导卡片；
 * 3. 任务编辑与新建页面判断是否允许直接触发运行。
 *
 * 【作用】
 * 根据传入的全局 AppState 做多维度健康检查：
 * - 检查模型配置：Anthropic 必须存在有效凭据（本地或环境变量）；OpenAI 兼容接口可以不填密钥但必须指定模型；
 * - 检查内核状态：查找是否已有已安装内核，若无则挑选首个无需商业 License 的内核作为推荐下载目标；
 * - 检查 Profile：确认已安装内核下是否拥有可用 Profile；
 * - 组装综合结论 `all = model && !!kernel && profile`。
 *
 * @param state 当前的全局应用状态对象
 * @returns 细项与全量评估结果
 */
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
