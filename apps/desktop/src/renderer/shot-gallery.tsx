import { useState } from "preact/hooks";
import type { RunStep } from "../shared.ts";
import { Lightbox } from "./lightbox.tsx";
import { shotUrl } from "./shots.ts";
import { describeStep } from "./step-format.ts";

/** 默认只展示最后几张：最终停留的画面最能说明结果，其余按需展开 */
const COLLAPSED_COUNT = 8;

/**
 * 运行过程截图图集组件。
 *
 * 【调用时机】
 * 运行详情页（RunDetailView）在结果区下方渲染；没有任何截图时不渲染。
 *
 * 【作用】
 * 1. 把运行中各步骤捕获的截图排成缩略图网格（按执行顺序），比文字日志更直观；
 * 2. 默认只显示最后 8 张，超出时提供"显示全部"入口；
 * 3. 点击缩略图打开灯箱大图，支持左右切换浏览整个图集，并显示"第 N 步 · 动作"说明。
 *
 * @param runId 所属运行记录 ID
 * @param steps 该次运行的全部可见步骤（只取其中带截图的）
 */
export function ShotGallery({ runId, steps }: { runId: string; steps: RunStep[] }) {
  const [all, setAll] = useState(false);
  const [index, setIndex] = useState<number | null>(null);

  const shots = steps.filter((s) => s.screenshot);
  if (shots.length === 0) return null;

  const hidden = all ? 0 : Math.max(0, shots.length - COLLAPSED_COUNT);
  const offset = hidden; // 可见缩略图在 shots 中的起始下标
  const open = index !== null ? shots[index] : undefined;

  const caption = (s: RunStep) => {
    const { label, target } = describeStep(s);
    return `第 ${s.stepNumber} 步 · ${label}${target ? ` ${target}` : ""}`;
  };

  return (
    <section class="section">
      <h2 class="section-title">
        过程截图
        <span class="section-aside">共 {shots.length} 张</span>
      </h2>
      <div class="shot-grid">
        {shots.slice(offset).map((s, i) => (
          <button
            key={s.stepNumber}
            type="button"
            class="shot-thumb"
            title={caption(s)}
            onClick={() => setIndex(offset + i)}
          >
            <img src={shotUrl(runId, s.screenshot!)} alt={caption(s)} loading="lazy" />
            <span class="shot-no">{s.stepNumber}</span>
          </button>
        ))}
      </div>
      {hidden > 0 && (
        <button type="button" class="link-btn shot-more" onClick={() => setAll(true)}>
          显示全部 {shots.length} 张
        </button>
      )}

      {open && index !== null && (
        <Lightbox
          src={shotUrl(runId, open.screenshot!)}
          caption={`${caption(open)}　(${index + 1}/${shots.length})`}
          onClose={() => setIndex(null)}
          onPrev={index > 0 ? () => setIndex(index - 1) : undefined}
          onNext={index < shots.length - 1 ? () => setIndex(index + 1) : undefined}
        />
      )}
    </section>
  );
}
