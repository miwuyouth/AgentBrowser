/** 截图的地址：文件存在该次运行的目录里，由主进程的 shot:// 协议读出，不经过任何消息 */
export const shotUrl = (runId: string, file: string) => `shot://run/${runId}/${file}`;
