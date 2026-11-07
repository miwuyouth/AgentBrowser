/**
 * 浏览器工具执行结果的内容块定义（ContentBlock）
 *
 * 格式与 Anthropic Messages API 的 `tool_result` 内容格式保持对齐，
 * 方便 App 直接透传给大模型。其他模型适配器（如 OpenAI 兼容接口）
 * 会基于这个标准格式进行转换。
 */
export type ImageMediaType = "image/jpeg" | "image/png" | "image/gif" | "image/webp";

/** 文本内容块 */
export interface TextBlock {
  type: "text";
  text: string;
}

/** 图像内容块（包含 base64 编码的图像数据与媒体类型） */
export interface ImageBlock {
  type: "image";
  source: { type: "base64"; media_type: ImageMediaType; data: string };
}

/** 内容块联合类型：文本或图片 */
export type ContentBlock = TextBlock | ImageBlock;

/**
 * 标准工具调用返回结果结构
 */
export interface ToolResult {
  /** 包含的内容块列表（可同时包含文本描述和页面截图） */
  content: ContentBlock[];
  /** 是否发生了执行错误 */
  isError?: boolean;
  /** 机器可识别的错误类型标识，如 tab_not_found、cancelled 等 */
  errorCode?: string;
}

/** 创建纯文本块的辅助函数 */
export const text = (t: string): TextBlock => ({ type: "text", text: t });

/** 创建 base64 图像块的辅助函数 */
export const image = (data: string, mediaType: ImageMediaType = "image/jpeg"): ImageBlock => ({
  type: "image",
  source: { type: "base64", media_type: mediaType, data },
});

/** 创建标准错误结果对象的辅助函数 */
export const errorResult = (message: string, errorCode = "execution_error"): ToolResult => ({
  content: [text(message)],
  isError: true,
  errorCode,
});
