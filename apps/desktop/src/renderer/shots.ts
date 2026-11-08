/**
 * 屏幕截图 URL 协议生成工具。
 *
 * 【调用时机】
 * 渲染进程展示运行步骤的缩略图、点击展开 Lightbox 大图预览时调用。
 *
 * 【作用】
 * 将运行 ID 与截图文件名转换为 Electron 特权自定义协议 `shot://run/<runId>/<file>` 地址。
 * 图片由主进程直接从运行目录磁盘流式读取，不经过任何 Base64 消息传递，极大提升页面性能。
 *
 * @param runId 运行记录唯一 ID
 * @param file 截图文件名（如 "3.png"）
 * @returns 构造完成的 shot:// URL
 */
export const shotUrl = (runId: string, file: string) => `shot://run/${runId}/${file}`;
