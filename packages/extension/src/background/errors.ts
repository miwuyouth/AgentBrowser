/** An expected failure with a machine-readable code, reported to the model. */
export class ToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

export const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Reject with `code` if `promise` does not settle within `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number, code: string, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ToolError(code, `${what} timed out after ${ms} ms`)), ms);
    }),
  ]);
}
