/**
 * 浏览器工具执行器（BrowserToolExecutor）。
 *
 * 核心调度职责：
 * 负责接收大模型输出的工具调用请求，校验参数 Schema，并分流至对应环境执行：
 * 1. App 本地工具：
 *    - `find`: 在 App 侧利用小模型分析扩展端返回的 DOM 候选集，进行语义筛选；
 *    - `file_upload`: 本地读取磁盘文件，校验文件大小与权限白名单，转 Base64 后转发给扩展；
 *    - `browser_batch`: 宿主端按序串行执行一批子动作（可混合 App 工具与扩展工具），遇错即停；
 * 2. 扩展透传工具（其余所有工具，如 computer、navigate、read_page 等）：
 *    - 经由 WebSocket Bridge 直接下发给 Chrome MV3 扩展执行。
 */

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { BrowserBridge } from "@agent-browser/bridge";
import {
  errorResult,
  getToolDefinition,
  isPlainObject,
  text,
  validateAgainstSchema,
  type ContentBlock,
  type ToolResult,
} from "@agent-browser/protocol";
import { findElements } from "./find.ts";
import type { JsonRequest } from "./providers/types.ts";

/** 执行器配置选项 */
export interface ExecutorOptions {
  bridge: BrowserBridge;
  /** 用于 `find` 工具的轻量结构化模型调用接口 */
  completeJson: (request: JsonRequest) => Promise<string>;
  /**
   * 文件上传安全鉴权回调：
   * 决定 Agent 是否允许上传指定的本地文件。默认允许读取任意可读文件；可按需限制指定目录。
   */
  allowFile?: (absolutePath: string) => boolean | Promise<boolean>;
  /**
   * `submit_result` 校验回调：
   * 由宿主按任务的字段要求核对 Agent 提交的数据，返回值原样作为工具结果回给 Agent。
   * 不通过时 Agent 会收到错误，可据此改正后重新提交；未提供时一律视为提交成功。
   */
  onSubmitResult?: (data: Record<string, unknown>) => SubmitCheck;
  timeoutMs?: number;
}

/** `submit_result` 的校验结论：`message` 为给 Agent 的成功回执，`error` 为要求 Agent 改正的说明 */
export type SubmitCheck = { ok: true; message?: string } | { ok: false; error: string };

/** 常用文件扩展名到 MIME 类型的映射字典 */
const MIME: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
};

/** 单次上传最大文件字节数上限（20 MB） */
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

/** 执行模型调用的工具路由与派发器 */
export class BrowserToolExecutor {
  constructor(private readonly opts: ExecutorOptions) {}

  /**
   * 执行单个工具调用：
   * 包含 Schema 校验、App 本地工具拦截与 Bridge 转发。
   */
  async execute(name: string, input: unknown, signal?: AbortSignal): Promise<ToolResult> {
    const def = getToolDefinition(name);
    if (!def) return errorResult(`Unknown tool "${name}".`, "unknown_tool");
    if (!isPlainObject(input)) return errorResult(`Input for ${name} must be an object.`, "input_invalid");
    // 本地先进行 JSON Schema 规范校验
    const problem = validateAgainstSchema(def.input_schema, input);
    if (problem) return errorResult(`Invalid input for ${name}: ${problem}`, "input_invalid");

    switch (name) {
      case "browser_batch":
        return this.batch(input.actions as { name: string; input: Record<string, unknown> }[], signal);
      case "find":
        return findElements(this.opts.bridge, this.opts.completeJson, input as { query: string; tabId: number }, signal);
      case "file_upload":
        return this.fileUpload(input as { paths: string[]; ref: string; tabId: number }, signal);
      case "submit_result": {
        if (!isPlainObject(input.data)) return errorResult('"data" must be an object of field name → value.', "input_invalid");
        const check = this.opts.onSubmitResult?.(input.data);
        if (check && !check.ok) return errorResult(check.error, "input_invalid");
        return { content: [text(check?.message ?? "Structured data has been recorded.")] };
      }
      default:
        // 其余工具直接转发给 Chrome 扩展
        return this.opts.bridge.call(name, input, this.callOptions(signal));
    }
  }

  private callOptions(signal?: AbortSignal) {
    return { ...(signal ? { signal } : {}), ...(this.opts.timeoutMs ? { timeoutMs: this.opts.timeoutMs } : {}) };
  }

  /**
   * App 端预处理文件上传：
   * 从本地磁盘读取文件 Base64 编码，绕过 Chrome 原生文件对话框直接注入 DOM
   */
  private async fileUpload(input: { paths: string[]; ref: string; tabId: number }, signal?: AbortSignal): Promise<ToolResult> {
    const files: { name: string; data: string; mimeType?: string }[] = [];
    let total = 0;
    for (const p of input.paths) {
      if (!path.isAbsolute(p)) return errorResult(`${p} is not an absolute path.`, "input_invalid");
      const resolved = path.resolve(p);
      if (this.opts.allowFile && !(await this.opts.allowFile(resolved))) {
        return errorResult(`Uploading ${resolved} is not allowed.`, "file_not_allowed");
      }
      try {
        const info = await stat(resolved);
        if (!info.isFile()) return errorResult(`${resolved} is not a file.`, "input_invalid");
        total += info.size;
        if (total > MAX_UPLOAD_BYTES) return errorResult("Files total more than 20 MB.", "input_invalid");
        const data = (await readFile(resolved)).toString("base64");
        const mimeType = MIME[path.extname(resolved).toLowerCase()];
        files.push({ name: path.basename(resolved), data, ...(mimeType ? { mimeType } : {}) });
      } catch (err) {
        return errorResult(`Cannot read ${resolved}: ${(err as Error).message}`, "file_unreadable");
      }
    }
    // 读取完成后，将 Base64 数据封装好发给扩展侧注入到对应的 <input type="file">
    return this.opts.bridge.call("file_upload", { files, ref: input.ref, tabId: input.tabId }, this.callOptions(signal));
  }

  /**
   * 批处理多步动作：
   * 在 App 侧统一协调批处理，使得批处理中既可以调用扩展工具，也可以调用 App 工具（如 find、file_upload）。
   * 遇到任一步骤失败立即中断后续步骤，并返回已执行结果。
   */
  private async batch(actions: { name: string; input: Record<string, unknown> }[], signal?: AbortSignal): Promise<ToolResult> {
    const content: ContentBlock[] = [];
    const label = (a: { name: string; input: Record<string, unknown> }, i: number) =>
      `[${i + 1}] ${a.name}${typeof a.input?.action === "string" ? `:${a.input.action}` : ""}`;
    for (let i = 0; i < actions.length; i++) {
      const action = actions[i]!;
      if (action.name === "browser_batch") {
        return this.batchFailure(content, `${label(action, i)} failed: browser_batch cannot be nested.`, actions.length - i - 1, "batch_invalid_input");
      }
      if (signal?.aborted) return this.batchFailure(content, "Batch cancelled.", actions.length - i, "cancelled");
      const result = await this.execute(action.name, action.input, signal);
      const output = result.content
        .filter((b) => b.type === "text")
        .map((b) => (b as { text: string }).text)
        .join("\n");
      if (result.isError) {
        return this.batchFailure(content, `${label(action, i)} failed: ${output}`, actions.length - i - 1, result.errorCode ?? "execution_error");
      }
      content.push(text(`${label(action, i)} ${output || "ok"}`));
      content.push(...result.content.filter((b) => b.type === "image"));
    }
    return { content };
  }

  /** 批处理异常中止时的结果生成器 */
  private batchFailure(content: ContentBlock[], message: string, notRun: number, errorCode: string): ToolResult {
    const tail = notRun > 0 ? `\n${notRun} remaining action(s) were not run.` : "";
    return { content: [...content, text(message + tail)], isError: true, errorCode };
  }
}
