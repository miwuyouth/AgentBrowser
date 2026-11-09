import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunRecord, RunSummary } from "./shared.ts";

/**
 * 运行记录本地磁盘存储模块。
 * 每次运行拥有独立专属目录，截图作为独立图片文件落盘存储：
 *
 *   <root>/index.json            所有运行的摘要（供历史列表快速呈现，文件体积小）
 *   <root>/<runId>/run.json      单次运行的完整明细记录（包含文字回复与所有步骤）
 *   <root>/<runId>/shots/3.png   第 3 步操作时捕获的屏幕截图
 *
 * 核心设计优势：
 * 1. 运行中产生每一步操作只改写自己的小文件，无需反序列化与覆写庞大的全量历史；
 * 2. 列表界面只读取轻量索引；
 * 3. 截图不再以 base64 形式塞入 JSON 或跨进程 IPC 广播中，极大幅度降低内存开销。
 * 纯 Node.js 实现，不依赖 Electron，方便单独进行单元测试。
 */

/** 校验运行 ID 合法性的正则表达式（防止路径穿越攻击） */
const ID_RE = /^[A-Za-z0-9_-]+$/;

/** 校验截图文件名的正则表达式 */
const SHOT_RE = /^\d+\.(png|jpg|webp)$/;

/** 图片 MIME 格式到文件扩展名的映射字典 */
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

/**
 * 将完整的单次运行记录提取为轻量级摘要。
 *
 * 【调用时机】
 * 在 `RunStore.save` 且指定 `opts.index: true`（任务开始、结束或中断时）调用。
 *
 * 【作用】
 * 剔除详细步骤列表（steps）、截图引用、以及大段总结文字，仅提取展示历史列表所需的 ID、名称、状态、时间戳、触发方式、所用 Profile 与所属的一轮；
 * 结构化结果只留字段值（`data`，通常几十字节），让任务的「表格」视图不用逐个读取 run.json。
 *
 * @param r 完整的运行明细记录
 * @returns 精简后的运行摘要对象
 */
export function summarize(r: RunRecord): RunSummary {
  return {
    id: r.id,
    ...(r.taskId ? { taskId: r.taskId } : {}),
    name: r.name,
    status: r.status,
    startTime: r.startTime,
    ...(r.endTime !== undefined ? { endTime: r.endTime } : {}),
    trigger: r.trigger,
    ...(r.profileId ? { profileId: r.profileId } : {}),
    ...(r.profileName ? { profileName: r.profileName } : {}),
    ...(r.batch ? { batch: r.batch } : {}),
    ...(r.result?.kind === "form" ? { data: r.result.data } : {}),
  };
}

/**
 * 原子写入文件工具函数。
 *
 * 【调用时机】
 * 在写入 `run.json` 或 `index.json` 时内部调用。
 *
 * 【作用】
 * 先将数据写入同路径下的临时文件（`${file}.tmp`），写完后通过 `renameSync` 原子替换原文件。
 * 彻底防止程序异常中断或崩溃时产生只写了一半的损坏空文件。
 *
 * @param file 目标文件的最终绝对路径
 * @param content 待写入的字符串或二进制内容
 */
function writeAtomic(file: string, content: string | Uint8Array) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

/**
 * 运行记录持久化存储管理器类。
 */
export class RunStore {
  /**
   * 构造存储实例。
   *
   * @param root 运行记录的根目录绝对路径（如 `<userData>/runs`）
   */
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  /** 获取索引文件 `index.json` 的绝对路径 */
  private indexFile = () => path.join(this.root, "index.json");

  /**
   * 获取指定运行 ID 的专属目录路径。
   *
   * 【调用时机】
   * 读写、删除或存取截图时内部调用。
   *
   * 【作用】
   * 严格校验 ID 字符串，拒绝包含 `..` 或非法字符的非法请求，防止目录穿越。
   *
   * @param id 运行记录 ID
   * @returns 安全的绝对路径；若 ID 不合法则返回 null
   */
  private dirOf(id: string): string | null {
    return ID_RE.test(id) ? path.join(this.root, id) : null;
  }

  /**
   * 获取所有历史运行记录的轻量摘要列表。
   *
   * 【调用时机】
   * 1. 主进程组装应用全局状态（`state()`）时调用，推送给渲染层渲染运行列表；
   * 2. 删除记录前核验和更新索引时内部调用。
   *
   * 【作用】
   * 读取并反序列化 `index.json`，按开始时间戳降序排列（最新的排在最前）。若文件不存在则安全返回空数组。
   *
   * @returns 运行摘要数组
   */
  list(): RunSummary[] {
    try {
      const data = JSON.parse(readFileSync(this.indexFile(), "utf8"));
      return Array.isArray(data) ? [...data].sort((a, b) => b.startTime - a.startTime) : [];
    } catch {
      return [];
    }
  }

  /**
   * 读取单次运行的完整明细记录。
   *
   * 【调用时机】
   * 1. 渲染进程通过 IPC `runs:get` 请求查看运行详情页时按需加载；
   * 2. 应用启动时扫描恢复异常中断的任务状态时调用；
   * 3. 用户点击从失败记录重试时读取上次导航 URL。
   *
   * 【作用】
   * 从 `<root>/<runId>/run.json` 读取完整的执行明细（包含步骤日志）。若目录或文件不存在则返回 null。
   *
   * @param id 运行记录 ID
   * @returns 完整的 RunRecord 实体或 null
   */
  get(id: string): RunRecord | null {
    const dir = this.dirOf(id);
    if (!dir) return null;
    try {
      return JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  /**
   * 保存或更新单次运行记录。
   *
   * 【调用时机】
   * 1. 任务启动初始化记录时调用（`opts.index: true`）；
   * 2. 任务执行过程中每产生一个工具步骤或助理回复时由 TaskRunner 调用（`opts.index: false`，仅改动当前小文件）；
   * 3. 任务顺利完成或失败收尾时调用（`opts.index: true`，刷新最终状态到列表索引）。
   *
   * 【作用】
   * 创建该次运行专属目录，原子写入 `run.json`。若指定了 `opts.index: true`，则同时将最新的摘要写回全局 `index.json`。
   *
   * @param run 待保存的完整运行实体
   * @param opts 控制选项，index 为 true 时同步更新列表索引
   */
  save(run: RunRecord, opts: { index?: boolean } = {}) {
    const dir = this.dirOf(run.id);
    if (!dir) throw new Error(`非法的运行 ID：${run.id}`);
    mkdirSync(dir, { recursive: true });
    writeAtomic(path.join(dir, "run.json"), JSON.stringify(run));

    if (opts.index) {
      const rest = this.list().filter((s) => s.id !== run.id);
      writeAtomic(this.indexFile(), JSON.stringify([summarize(run), ...rest]));
    }
  }

  /**
   * 给旧的索引补上结果字段值（`data`）：这个字段是后加的，之前的摘要里没有。
   *
   * 【调用时机】应用启动时调用一次。
   * 【作用】只做一遍：完成后在根目录留下标记文件，之后直接返回；只读取有关联任务、已结束、还没有 `data` 的记录。
   *
   * @returns 补上的条数
   */
  backfillData(): number {
    const marker = path.join(this.root, ".data-backfilled");
    if (existsSync(marker)) return 0;
    const all = this.list();
    let filled = 0;
    const next = all.map((s) => {
      if (s.data || !s.taskId || s.status === "run") return s;
      const full = this.get(s.id);
      if (full?.result?.kind !== "form") return s;
      filled += 1;
      return { ...s, data: full.result.data };
    });
    if (filled > 0) writeAtomic(this.indexFile(), JSON.stringify(next));
    writeFileSync(marker, "");
    return filled;
  }

  /**
   * 保存某一步骤捕获的屏幕截图到磁盘文件。
   *
   * 【调用时机】
   * 在 `task-runner.ts` 中，Agent 的工具调用产生包含 base64 图片的 `tool_result` 事件时调用。
   *
   * 【作用】
   * 将 Base64 编码解码为二进制 Buffer，写入 `<root>/<runId>/shots/<stepNumber>.<ext>` 文件中。
   * 返回短文件名（如 "3.png"）存入对应步骤的 `screenshot` 字段，彻底避免 Base64 膨胀传输。
   *
   * @param runId 运行记录 ID
   * @param step 步骤序号
   * @param mediaType 图片 MIME 类型（如 "image/png"）
   * @param base64 图片 Base64 数据字符串
   * @returns 相对截图文件名（如 "3.png"）
   */
  saveShot(runId: string, step: number, mediaType: string, base64: string): string {
    const dir = this.dirOf(runId);
    if (!dir) throw new Error(`非法的运行 ID：${runId}`);
    const file = `${step}.${EXT[mediaType] ?? "png"}`;
    mkdirSync(path.join(dir, "shots"), { recursive: true });
    writeFileSync(path.join(dir, "shots", file), Buffer.from(base64, "base64"));
    return file;
  }

  /**
   * 获取指定截图文件在磁盘上的真实完整路径。
   *
   * 【调用时机】
   * Electron 自定义协议 `shot://run/<runId>/<file>` 收到网络请求时调用。
   *
   * 【作用】
   * 严格校验文件名格式与运行 ID 合法性，确认文件真实存在后返回绝对路径；若文件不存在或路径非法则返回 null（便于返回 404）。
   *
   * @param runId 运行记录 ID
   * @param file 截图文件名（如 "3.png"）
   * @returns 真实物理文件绝对路径或 null
   */
  shotPath(runId: string, file: string): string | null {
    const dir = this.dirOf(runId);
    if (!dir || !SHOT_RE.test(file)) return null;
    const full = path.join(dir, "shots", file);
    return existsSync(full) ? full : null;
  }

  /**
   * 批量删除运行记录及对应的磁盘截图目录。
   *
   * 【调用时机】
   * 用户在历史记录界面批量勾选并确认删除、或清空历史时（由 IPC `IPC.deleteRuns` 触发）调用。
   *
   * 【作用】
   * 1. 递归删除匹配记录的磁盘整个文件夹（包含所有截图和明细）；
   * 2. 更新并重新原子保存 `index.json` 索引；
   * 3. 返回实际删除成功的条数。
   *
   * @param ids 待删除的运行记录 ID 列表
   * @returns 实际被成功删除的记录数量
   */
  remove(ids: string[]): number {
    const targets = new Set(ids.filter((id) => this.dirOf(id)));
    const all = this.list();
    const kept = all.filter((s) => !targets.has(s.id));
    for (const id of targets) rmSync(this.dirOf(id)!, { recursive: true, force: true });
    if (kept.length !== all.length) writeAtomic(this.indexFile(), JSON.stringify(kept));
    return all.length - kept.length;
  }
}
