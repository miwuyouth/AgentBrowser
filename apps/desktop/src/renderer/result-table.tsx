import { useEffect, useRef, useState } from "preact/hooks";
import { cellValue, csvTime, profileLabel, toCsv, type ResultGroup } from "../result-table.ts";
import { errorMessage, type FormField, type RunSummary, type TaskItem } from "../shared.ts";
import { Icon } from "./icons.tsx";
import type { Navigate } from "./sidebar.tsx";
import { formatDateTime } from "./time.ts";
import { toast } from "./toast.tsx";

/** 数字按本地习惯加千分位，小数不做四舍五入 */
const formatNumber = (n: number) => n.toLocaleString("zh-CN", { maximumFractionDigits: 10 });

/**
 * 任务结果表格：一次运行一行、一个字段一列。
 *
 * 【调用时机】任务的运行记录页切到「表格」时，以及一轮页（多 Profile 任务的一次运行）里渲染。
 *
 * 【作用】
 * - 第一列是时间或 Profile，横向滑动时固定在左边；表头在表格内纵向滚动时固定在顶部；
 * - 单元格只显示一行，太长的用「…」截断，悬停看全文；数字列右对齐、等宽数字；
 * - 失败的那次在第一列加小红点，没有值的格子显示「—」；
 * - 多 Profile 任务可以带轮次标题行（横向滑动时同样固定在左边）；
 * - 右边还有列没显示出来时，右边缘出现一道淡淡的渐隐；
 * - 点一行进入那次运行的详情。
 *
 * @param fields 任务的结果字段（列，按定义顺序）
 * @param groups 按轮分好组的运行
 * @param firstCol 第一列显示时间还是 Profile
 * @param groupHeads 是否显示轮次标题行
 * @param names 现有 Profile 的 ID → 名称
 * @param go 路由导航函数
 */
export function ResultTable({
  fields,
  groups,
  firstCol,
  groupHeads,
  names,
  go,
}: {
  fields: FormField[];
  groups: ResultGroup[];
  firstCol: "time" | "profile";
  groupHeads: boolean;
  names: Map<string, string>;
  go: Navigate;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const [moreRight, setMoreRight] = useState(false);

  // 右边是否还有没显示出来的列：滚动、窗口尺寸、内容变化时重新判断
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const check = () => setMoreRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    check();
    el.addEventListener("scroll", check, { passive: true });
    const ro = new ResizeObserver(check);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener("scroll", check);
      ro.disconnect();
    };
  }, []);

  const label = (run: RunSummary) => (firstCol === "time" ? formatDateTime(run.startTime) : profileLabel(run, names));
  const open = (run: RunSummary) => go("run", run.id);

  return (
    <div class={`rt-wrap${moreRight ? " more-right" : ""}`}>
      <div class="rt-scroll" ref={scroller}>
        <table class="rt">
          <thead>
            <tr>
              <th class="rt-first">
                <div class="rt-c">{firstCol === "time" ? "时间" : "Profile"}</div>
              </th>
              {fields.map((f) => (
                <th key={f.id || f.name} class={f.type === "number" ? "num" : ""} title={f.description || f.name}>
                  <div class="rt-c">{f.name}</div>
                </th>
              ))}
              <th class="rt-fill" aria-hidden="true" />
            </tr>
          </thead>
          {groups.map((g) => (
            <tbody key={g.id}>
              {groupHeads && (
                <tr class="rt-group">
                  <td colSpan={fields.length + 2}>
                    <span>{formatDateTime(g.startTime)}</span>
                  </td>
                </tr>
              )}
              {g.runs.map((run) => {
                const failed = run.status === "fail";
                return (
                  <tr
                    key={run.id}
                    class="rt-row"
                    tabIndex={0}
                    role="link"
                    aria-label={`${label(run)}${failed ? "，失败" : ""}`}
                    onClick={() => open(run)}
                    onKeyDown={(e) => e.key === "Enter" && open(run)}
                  >
                    <td class="rt-first" title={failed ? "这次运行失败了" : undefined}>
                      <div class="rt-c rt-first-in">
                        <span class="rt-label">{label(run)}</span>
                        {failed && <i class="dot fail" />}
                      </div>
                    </td>
                    {fields.map((f) => {
                      const v = cellValue(run, f);
                      const text = v === null ? "" : typeof v === "number" ? formatNumber(v) : v;
                      return (
                        <td key={f.id || f.name} class={f.type === "number" ? "num" : ""} title={text || undefined}>
                          <div class="rt-c">{v === null ? <span class="rt-empty">—</span> : text}</div>
                        </td>
                      );
                    })}
                    <td class="rt-fill" aria-hidden="true" />
                  </tr>
                );
              })}
            </tbody>
          ))}
        </table>
      </div>
    </div>
  );
}

/**
 * 「全部结果 ›」：从一轮页、运行详情页跳到「结果」页并选中这个任务，看历次运行的结果表格。
 *
 * 【调用时机】一轮页、运行详情页标题下那行灰字的末尾渲染。
 * 【作用】
 * 它是跳转、不是对这条记录的操作，所以做成不带边框的文字链接放在说明行里，右上角只留重试、删除这类操作；
 * 只有定义了结果字段的任务才显示（「结果」页只列这些任务）；任务已被删除时也不显示。
 *
 * @param taskId 这次运行所属的任务
 * @param tasks 当前所有任务
 * @param go 路由导航函数
 */
export function AllResultsLink({ taskId, tasks, go }: { taskId: string | undefined; tasks: TaskItem[]; go: Navigate }) {
  const task = tasks.find((t) => t.id === taskId);
  if (!task?.fields?.length) return null;
  return (
    <button type="button" class="desc-link" title={`查看「${task.name}」历次运行的结果`} onClick={() => go("results", task.id)}>
      全部结果
      <Icon name="chevron" size={11} />
    </button>
  );
}

/**
 * 把运行导出成 CSV 文件（弹出系统存储对话框）。
 *
 * 【调用时机】用户点「导出 CSV」时调用。
 * 【作用】长格式：一个 Profile 的一次运行一行；文件名默认「任务名-日期.csv」；存好后轻提示一下。
 *
 * @param taskName 任务名（用于默认文件名）
 * @param runs 要导出的运行，按行顺序
 * @param fields 结果字段
 * @param names 现有 Profile 的 ID → 名称
 */
export async function exportCsv(
  taskName: string,
  runs: RunSummary[],
  fields: FormField[],
  names: Map<string, string>,
) {
  try {
    const day = csvTime(Date.now()).slice(0, 10);
    const saved = await window.agentApi.saveCsv(`${taskName}-${day}.csv`, toCsv(runs, fields, names));
    if (saved) toast(`已导出 ${runs.length} 行`);
  } catch (err) {
    toast(`导出失败：${errorMessage(err)}`, true);
  }
}
