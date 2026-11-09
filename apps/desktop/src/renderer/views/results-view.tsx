import { useState } from "preact/hooks";
import { finishedRuns, groupRounds, profileKey, profileOptions } from "../../result-table.ts";
import type { AppState, TaskItem } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import { exportCsv, ResultTable } from "../result-table.tsx";
import type { Navigate } from "../sidebar.tsx";

/** 上次看的任务：从侧边栏再进来时还显示它 */
let lastTaskId: string | undefined;
/** 每个任务上次在表格里选的 Profile（空字符串 = 全部） */
const lastProfile = new Map<string, string>();

/**
 * 没指定任务时默认显示哪个：上次看的；没有就选最近运行过的；都没运行过就选第一个。
 *
 * @param tasks 定义了结果字段的任务
 * @param state 全局状态（取运行记录）
 */
function defaultTask(tasks: TaskItem[], state: AppState): TaskItem | undefined {
  const last = tasks.find((t) => t.id === lastTaskId);
  if (last) return last;
  const ids = new Set(tasks.map((t) => t.id));
  const latest = state.runs.filter((r) => r.taskId && ids.has(r.taskId)).sort((a, b) => b.startTime - a.startTime)[0];
  return tasks.find((t) => t.id === latest?.taskId) ?? tasks[0];
}

/**
 * 一个任务的结果表格：一次运行一行、一个字段一列，最新的在最上面。
 *
 * 【调用时机】「结果」页选中某个任务后渲染。
 *
 * 【作用】
 * - 只绑一个 Profile 的任务：第一列是时间；
 * - 多 Profile 任务：默认按轮分组（轮次标题行 + 每个 Profile 一行，顺序固定）；
 *   在下拉框里选某个 Profile 后，去掉分组，一天一行，专门看这个账号的变化；
 * - 「导出 CSV」导出当前看到的这些行（长格式），交给表格软件做进一步分析。
 */
function TaskTable({ state, task, go }: { state: AppState; task: TaskItem; go: Navigate }) {
  const [profile, setProfile] = useState(lastProfile.get(task.id) ?? "");
  const fields = task.fields ?? [];
  const names = new Map(state.profiles.map((p) => [p.id, p.name]));
  const order = state.profiles.map((p) => p.id);

  const all = finishedRuns(state.runs.filter((r) => r.taskId === task.id));
  const options = profileOptions(all, order, names);
  const multi = options.length > 1;
  // 选过的 Profile 在历史里已经没有了（记录被清理）就回到「全部」
  const picked = multi && options.some((o) => o.key === profile) ? profile : "";
  const runs = picked ? all.filter((r) => profileKey(r) === picked) : all;
  const groups = groupRounds(runs, order);
  const byRound = multi && !picked;

  const pick = (key: string) => {
    lastProfile.set(task.id, key);
    setProfile(key);
  };

  if (all.length === 0) {
    return (
      <div class="empty">
        <h2>这个任务还没有运行结果</h2>
        <p>任务运行完成后，每次提交的结果会排成一行出现在这里。</p>
      </div>
    );
  }

  return (
    <>
      <div class="rt-bar">
        {multi && (
          <div class="select-wrap rt-select">
            <select class="input input-sm" aria-label="只看某个 Profile" value={picked} onChange={(e) => pick(e.currentTarget.value)}>
              <option value="">全部 Profile</option>
              {options.map((o) => (
                <option key={o.key} value={o.key}>
                  {o.name}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={13} />
          </div>
        )}
        <span class="rt-count">{runs.length} 行</span>
        <button
          type="button"
          class="btn btn-sm"
          onClick={() => void exportCsv(task.name, groups.flatMap((g) => g.runs), fields, multi, names)}
        >
          导出 CSV
        </button>
      </div>
      <ResultTable fields={fields} groups={groups} firstCol={byRound ? "profile" : "time"} groupHeads={byRound} names={names} go={go} />
    </>
  );
}

/**
 * 「结果」页：按任务查看历次运行提交的结果，像看一张表一样看每天的变化。
 *
 * 【调用时机】
 * 用户点侧边栏「结果」（`view === "results"`），或在一轮页、运行详情页点「全部结果 ›」（带任务 ID）时渲染。
 *
 * 【作用】
 * 1. 右上角的下拉框只列出定义了结果字段的任务；没指定任务时显示上次看的（见 `defaultTask`）；
 * 2. 下面是这个任务的结果表格（见 `TaskTable`）；
 * 3. 一个定义了结果字段的任务都没有时，说明怎么让结果出现在这里。
 * 「运行记录」只管每次运行的过程与状态，结果的汇总查看都在这里。
 *
 * @param state 当前全局应用状态
 * @param taskId 要看的任务 ID（可选）
 * @param go 路由导航函数
 */
export function ResultsView({ state, taskId, go }: { state: AppState; taskId: string | undefined; go: Navigate }) {
  const tasks = state.tasks.filter((t) => t.fields?.length);
  const task = tasks.find((t) => t.id === taskId) ?? defaultTask(tasks, state);
  if (task) lastTaskId = task.id;

  const keep = state.general.keepRunsDays;
  const desc = task ? `每次运行提交的结果，按时间排列${keep > 0 ? ` · 保留最近 ${keep} 天` : ""}` : undefined;

  return (
    <div class="page">
      <PageHead title="结果" desc={desc}>
        {tasks.length > 0 && (
          <div class="select-wrap task-select">
            <select class="input input-sm" aria-label="选择任务" value={task?.id ?? ""} onChange={(e) => go("results", e.currentTarget.value)}>
              {tasks.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
            <Icon name="chevron" size={13} />
          </div>
        )}
      </PageHead>

      {task ? (
        <TaskTable key={task.id} state={state} task={task} go={go} />
      ) : (
        <div class="empty">
          <h2>还没有可以汇总的结果</h2>
          <p>在任务的「结果表单」里添加字段，之后每次运行提交的结果会按时间排成表格出现在这里。</p>
        </div>
      )}
    </div>
  );
}
