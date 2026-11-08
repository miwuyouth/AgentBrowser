/**
 * 一次运行为什么没能正常完成，以及该告诉用户什么。
 * 纯函数、不依赖 Electron，方便单独测试。
 */

export const DEFAULT_ADVICE = "请检查模型 API Key、浏览器内核连接或任务目标描述后重试。";

/** 带有"给用户的建议"的失败原因，由运行器据此写入运行记录 */
export class RunStopped extends Error {
  constructor(
    message: string,
    readonly advice: string,
  ) {
    super(message);
    this.name = "RunStopped";
  }
}

/**
 * Agent 不会抛异常，而是用 done 事件告诉我们它为什么停下。
 * 正常结束（end_turn）返回 null，其余情况翻译成失败原因。
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

export function describeTimeout(minutes: number): RunStopped {
  return new RunStopped(
    `任务运行超过 ${minutes} 分钟，已自动终止`,
    "可以在任务的高级设置里调大超时时间，或者把任务目标拆小一些。",
  );
}
