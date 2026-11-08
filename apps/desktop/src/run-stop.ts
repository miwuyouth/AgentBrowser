/**
 * 运行终止原因解析模块。
 * 负责解释一次运行为什么没能正常完成，以及该向用户呈现何种建议。
 * 纯函数、不依赖 Electron，方便单独进行单元测试。
 */

/** 默认失败排查建议文案 */
export const DEFAULT_ADVICE = "请检查模型 API Key、浏览器内核连接或任务目标描述后重试。";

/**
 * 带有"给用户的操作建议"的失败异常类。
 * 运行器（TaskRunner）捕获此错误后，会将其中的 message 与 advice 一同写入运行历史记录，便于界面展示。
 */
export class RunStopped extends Error {
  /**
   * 构造函数。
   *
   * @param message 失败简述，例如"用户主动终止任务"或"模型拒绝执行"
   * @param advice 针对该失败原因提供给用户的具体排查与操作指引
   */
  constructor(
    message: string,
    readonly advice: string,
  ) {
    super(message);
    this.name = "RunStopped";
  }
}

/**
 * 解析 Agent 的终止原因，并转译为业务异常或确定是否正常完成。
 *
 * 【调用时机】
 * 1. 在 `task-runner.ts` 中，Agent 的 `agent.send` 循环收到 `done` 事件后调用，用于检查 Agent 是否因异常原因提前终止。
 * 2. 任务执行被外层 try-catch 拦截后，判断是否属于用户主动点击取消（`cancelled`）时调用。
 *
 * 【作用】
 * Agent 运行时通常不会直接抛出未捕获异常，而是通过 `done` 事件携带停止状态代码告知上层：
 * - 正常结束（`undefined` 或 `"end_turn"`）：返回 `null`，表示任务已正常收尾；
 * - 用户取消（`"cancelled"`）：构造用户主动中止的 RunStopped 实例；
 * - 达到步数上限（`"max_steps"`）：生成超出最大步数的提示，建议调大设置或细化任务目标；
 * - 上下文截断（`"max_tokens"`）：提示模型回复超出长度限制；
 * - 模型拒绝（`"refusal"`）：透传模型的拒绝信息；
 * - 其他异常：统一使用默认失败建议。
 *
 * @param reason Agent 返回的停止枚举原因字符串
 * @param message 模型或 Agent 附加的详细说明信息（可选）
 * @param maxSteps 该任务所配置的最大步数上限（可选，用于在文案中呈现具体数值）
 * @returns 若为正常完成返回 null；若异常终止则返回组装好的 RunStopped 实例
 */
export function describeStop(reason: string | undefined, message: string | undefined, maxSteps?: number): RunStopped | null {
  switch (reason) {
    case undefined:
    case "end_turn":
      return null;
    case "cancelled":
      return new RunStopped("用户主动终止任务", "已中止");
    case "max_steps":
      return new RunStopped(
        `已达到最大步数${maxSteps ? `（${maxSteps} 步）` : ""}，任务仍未完成`,
        "可以在任务的高级设置里调大最大步数，或者把任务目标写得更具体一些。",
      );
    case "max_tokens":
      return new RunStopped("模型回复超出长度上限，被截断", "可以把任务目标拆小一些后重试。");
    case "refusal":
      return new RunStopped(message ? `模型拒绝执行：${message}` : "模型拒绝执行这个任务", "请调整任务目标后重试。");
    default:
      return new RunStopped(message || "模型调用失败", DEFAULT_ADVICE);
  }
}

/**
 * 构造任务执行超时的失败描述对象。
 *
 * 【调用时机】
 * 在 `task-runner.ts` 的执行流程中，当任务设定的 `deadline` 定时器被触发、导致任务被 AbortController 强行中止后，在 catch 错误处理分支中调用。
 *
 * 【作用】
 * 生成带友好建议的超时失败异常，告知用户运行耗时已超限，并给出调整超时配置或分解任务的建议。
 *
 * @param minutes 任务配置中允许执行的最大超时时间（单位：分钟）
 * @returns 包装了超时说明与调整建议的 RunStopped 实例
 */
export function describeTimeout(minutes: number): RunStopped {
  return new RunStopped(
    `任务运行超过 ${minutes} 分钟，已自动终止`,
    "可以在任务的高级设置里调大超时时间，或者把任务目标拆小一些。",
  );
}
