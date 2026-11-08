import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { RunRecord, RunSummary } from "./shared.ts";

/**
 * 运行记录的存储：每次运行一个目录，截图是目录里的独立文件。
 *
 *   <root>/index.json            所有运行的摘要（列表用，很小）
 *   <root>/<runId>/run.json      这次运行的完整记录（不含截图内容）
 *   <root>/<runId>/shots/3.png   第 3 步的截图
 *
 * 这样运行中每一步只改自己的小文件，不用读写整个历史；列表只读索引；
 * 截图不再以 base64 的形式塞进记录或消息里。不依赖 Electron，方便测试。
 */

const ID_RE = /^[A-Za-z0-9_-]+$/;
const SHOT_RE = /^\d+\.(png|jpg|webp)$/;
const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp" };

export function summarize(r: RunRecord): RunSummary {
  return {
    id: r.id,
    ...(r.taskId ? { taskId: r.taskId } : {}),
    name: r.name,
    status: r.status,
    startTime: r.startTime,
    ...(r.endTime !== undefined ? { endTime: r.endTime } : {}),
    trigger: r.trigger,
  };
}

/** 先写临时文件再改名，避免写到一半崩溃留下半个文件 */
function writeAtomic(file: string, content: string | Uint8Array) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, content);
  renameSync(tmp, file);
}

export class RunStore {
  constructor(private root: string) {
    mkdirSync(root, { recursive: true });
  }

  private indexFile = () => path.join(this.root, "index.json");

  /** id 只允许字母数字和 - _，防止拼出越界的路径 */
  private dirOf(id: string): string | null {
    return ID_RE.test(id) ? path.join(this.root, id) : null;
  }

  /** 全部运行的摘要，最新的在最前 */
  list(): RunSummary[] {
    try {
      const data = JSON.parse(readFileSync(this.indexFile(), "utf8"));
      return Array.isArray(data) ? [...data].sort((a, b) => b.startTime - a.startTime) : [];
    } catch {
      return [];
    }
  }

  get(id: string): RunRecord | null {
    const dir = this.dirOf(id);
    if (!dir) return null;
    try {
      return JSON.parse(readFileSync(path.join(dir, "run.json"), "utf8")) as RunRecord;
    } catch {
      return null;
    }
  }

  /** 写运行记录。index 为真时同时更新索引（开始、结束时）；运行中每一步只写自己的小文件 */
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

  /** 保存一步的截图，返回文件名（记录里只存它） */
  saveShot(runId: string, step: number, mediaType: string, base64: string): string {
    const dir = this.dirOf(runId);
    if (!dir) throw new Error(`非法的运行 ID：${runId}`);
    const file = `${step}.${EXT[mediaType] ?? "png"}`;
    mkdirSync(path.join(dir, "shots"), { recursive: true });
    writeFileSync(path.join(dir, "shots", file), Buffer.from(base64, "base64"));
    return file;
  }

  /** 截图文件的真实路径；id 或文件名不合法、文件不存在都返回 null */
  shotPath(runId: string, file: string): string | null {
    const dir = this.dirOf(runId);
    if (!dir || !SHOT_RE.test(file)) return null;
    const full = path.join(dir, "shots", file);
    return existsSync(full) ? full : null;
  }

  /** 删除运行记录及它的截图，返回实际删除的条数 */
  remove(ids: string[]): number {
    const targets = new Set(ids.filter((id) => this.dirOf(id)));
    const all = this.list();
    const kept = all.filter((s) => !targets.has(s.id));
    for (const id of targets) rmSync(this.dirOf(id)!, { recursive: true, force: true });
    if (kept.length !== all.length) writeAtomic(this.indexFile(), JSON.stringify(kept));
    return all.length - kept.length;
  }
}
