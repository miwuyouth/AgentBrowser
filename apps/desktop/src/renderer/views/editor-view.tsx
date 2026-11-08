import { useEffect, useRef, useState } from "preact/hooks";
import { AUTO_PROFILE_LABEL, AUTO_PROFILE_VALUE, errorMessage, type AppState, type TaskItem } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import { nextSlot, scheduleLabel, type RepeatKind } from "../../schedule.ts";
import type { Navigate } from "../sidebar.tsx";
import { formatUpcoming } from "../time.ts";

type ResultFormat = TaskItem["resultFormat"];
type Repeat = "manual" | Exclude<RepeatKind, "manual" | "once">;
const REPEATS: { value: Repeat; label: string }[] = [
  { value: "manual", label: "手动运行" },
  { value: "daily", label: "每天" },
  { value: "weekday", label: "工作日" },
  { value: "weekly", label: "每周一" },
  { value: "hours", label: "每 6 小时" },
];
const TIME_RE = /^\d{2}:\d{2}$/;
const DEFAULT_MAX_STEPS = 30;
const DEFAULT_TIMEOUT_MINUTES = 10;
/** 正整数且不超过上限；否则返回 null */
const toLimit = (v: string, max: number) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null);
const FORMATS: { value: ResultFormat; label: string }[] = [
  { value: "text", label: "文字" },
  { value: "json", label: "JSON" },
  { value: "markdown", label: "Markdown" },
];

/** 没填名称时，取目标的第一行前 24 个字 */
function autoName(goal: string): string {
  const line = (goal.trim().split("\n")[0] ?? "").replace(/\s+/g, " ");
  return line.length > 24 ? `${line.slice(0, 24)}…` : line;
}

function Select({ id, value, onChange, children }: { id: string; value: string; onChange: (v: string) => void; children: preact.ComponentChildren }) {
  return (
    <div class="select-wrap">
      <select id={id} class="input" value={value} onChange={(e) => onChange(e.currentTarget.value)}>
        {children}
      </select>
      <Icon name="chevron" size={14} />
    </div>
  );
}

export function EditorView({ state, taskId, go }: { state: AppState; taskId: string | undefined; go: Navigate }) {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : undefined;

  // 只列出已经安装的内核；一个都没装时才退回显示全部
  const installed = state.kernels.filter((k) => k.installed);
  const kernels = installed.length > 0 ? installed : state.kernels;
  const defaultKernel = kernels.find((k) => k.isDefault) ?? kernels[0];

  const [goal, setGoal] = useState(task?.goal ?? "");
  const [url, setUrl] = useState(task?.url ?? "");
  const [name, setName] = useState(task?.name ?? "");
  const [kernelId, setKernelId] = useState(task?.kernelId || defaultKernel?.id || "");
  /** "" 表示「用该内核的默认 Profile」，不把具体选择提前写死 */
  const [profileChoice, setProfileChoice] = useState(task ? (task.autoProfile ? AUTO_PROFILE_VALUE : task.profileId) : "");
  const [doneCondition, setDoneCondition] = useState(task?.doneCondition ?? "");
  /** 数字输入框用字符串存，方便用户清空重填；保存时再转成整数 */
  const [maxSteps, setMaxSteps] = useState(String(task?.maxSteps ?? DEFAULT_MAX_STEPS));
  const [timeoutMinutes, setTimeoutMinutes] = useState(String(task?.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES));
  const [resultFormat, setResultFormat] = useState<ResultFormat>(task?.resultFormat ?? "text");
  const [autoClose, setAutoClose] = useState(task?.autoClose ?? true);
  const [repeat, setRepeat] = useState<Repeat>(
    task?.mode === "cron" && task.repeatKind && task.repeatKind !== "manual" && task.repeatKind !== "once" ? task.repeatKind : "manual",
  );
  const [time, setTime] = useState(task?.repeatTime || "08:30");
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const goalRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const el = goalRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [goal]);

  // 新建任务时直接把光标放在目标输入框（autofocus 属性在页面内跳转时不生效）
  useEffect(() => {
    if (!task) goalRef.current?.focus();
  }, []);

  if (taskId && !task) {
    return (
      <div class="page">
        <div class="empty">
          <h2>找不到这个任务</h2>
          <p>它可能已经被删除了。</p>
          <button type="button" class="btn" onClick={() => go("tasks")}>
            返回任务
          </button>
        </div>
      </div>
    );
  }

  const kernel = kernels.find((k) => k.id === kernelId);
  const profiles = state.profiles.filter((p) => p.kernelId === kernelId);
  const choiceValid = profileChoice === AUTO_PROFILE_VALUE || profiles.some((p) => p.id === profileChoice);
  // 没选、或选的 Profile 已不存在：用默认 Profile；该内核没有任何 Profile 时，运行时自动创建
  const profileValue =
    profileChoice && choiceValid ? profileChoice : (profiles.find((p) => p.isDefault)?.id ?? profiles[0]?.id ?? AUTO_PROFILE_VALUE);
  const profileLabel = profileValue === AUTO_PROFILE_VALUE ? AUTO_PROFILE_LABEL : (profiles.find((p) => p.id === profileValue)?.name ?? "");

  const scheduled = repeat !== "manual";
  const timeOk = !scheduled || TIME_RE.test(time);
  const upcoming = scheduled && timeOk ? nextSlot({ mode: "cron", repeatKind: repeat, repeatTime: time }, Date.now()) : null;
  const stepsValue = toLimit(maxSteps, 500);
  const timeoutValue = toLimit(timeoutMinutes, 600);
  const canSave = goal.trim() !== "" && timeOk && stepsValue !== null && timeoutValue !== null && !saving;

  const save = async (thenRun: boolean) => {
    setSaving(true);
    setError("");
    try {
      const autoProfile = profileValue === AUTO_PROFILE_VALUE;
      const saved = await window.agentApi.saveTask({
        ...(task ? { id: task.id } : {}),
        name: name.trim() || autoName(goal),
        goal: goal.trim(),
        url: url.trim(),
        doneCondition: doneCondition.trim(),
        maxSteps: stepsValue!,
        timeoutMinutes: timeoutValue!,
        kernelId,
        autoProfile,
        ...(autoProfile ? {} : { profileId: profileValue }),
        autoClose,
        resultFormat,
        ...(scheduled
          ? { mode: "cron" as const, repeatKind: repeat, repeatTime: time, schedule: scheduleLabel(repeat, time) }
          : { mode: "now" as const, repeatKind: "manual" as const, schedule: "手动" }),
      });
      if (thenRun) {
        void window.agentApi.runTask(saved.id);
        go("live");
      } else {
        go("tasks");
      }
    } catch (err) {
      setError(errorMessage(err));
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!task || !window.confirm(`删除任务「${task.name}」？它的运行记录会保留。`)) return;
    await window.agentApi.deleteTask(task.id);
    go("tasks");
  };

  return (
    <div class="editor">
      <div class="page">
        <PageHead title={task ? "编辑任务" : "新建任务"} desc="用一句话告诉 Agent 要做什么" />

        <div class="card">
          <div class="goal">
            <label for="task-goal">任务目标</label>
            <textarea
              id="task-goal"
              ref={goalRef}
              rows={1}
              placeholder="例如：打开商城首页，进入个人中心，完成每日签到"
              value={goal}
              onInput={(e) => setGoal(e.currentTarget.value)}
            />
          </div>
          <div class="goal-extra">
            <div class="field full">
              <label>什么时候运行</label>
              <div class="chips">
                {REPEATS.map((r) => (
                  <button key={r.value} type="button" class={`chip ${repeat === r.value ? "on" : ""}`} aria-pressed={repeat === r.value} onClick={() => setRepeat(r.value)}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>
            {scheduled && (
              <div class="field">
                <label for="task-time">{repeat === "hours" ? "从几点开始" : "运行时间"}</label>
                <input id="task-time" class="input" type="time" value={time} onInput={(e) => setTime(e.currentTarget.value)} />
              </div>
            )}
            <div class={`field ${scheduled ? "" : "full"}`}>
              <label for="task-url">起始网址（可选）</label>
              <input id="task-url" class="input" placeholder="https://" value={url} onInput={(e) => setUrl(e.currentTarget.value)} />
            </div>
          </div>
        </div>

        <div class={`advbox ${advOpen ? "open" : ""}`}>
          <button type="button" class="adv" aria-expanded={advOpen} onClick={() => setAdvOpen(!advOpen)}>
            <Icon name="chevron" size={14} />
            高级设置
            <small>名称、内核、Profile、步数与超时</small>
          </button>
          {advOpen && (
            <div class="advbody">
              <div class="field full">
                <label for="task-name">任务名称</label>
                <input
                  id="task-name"
                  class="input"
                  placeholder={autoName(goal) || "默认取目标的前几个字"}
                  value={name}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label for="task-kernel">浏览器内核</label>
                <Select
                  id="task-kernel"
                  value={kernelId}
                  onChange={(v) => {
                    setKernelId(v);
                    setProfileChoice("");
                  }}
                >
                  {kernels.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </Select>
              </div>
              <div class="field">
                <label for="task-profile">Profile</label>
                <Select id="task-profile" value={profileValue} onChange={setProfileChoice}>
                  {profiles.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  <option value={AUTO_PROFILE_VALUE}>{AUTO_PROFILE_LABEL}</option>
                </Select>
              </div>
              <div class="field full">
                <label for="task-done">完成条件（可选）</label>
                <input
                  id="task-done"
                  class="input"
                  placeholder="例如：页面出现「签到成功」"
                  value={doneCondition}
                  onInput={(e) => setDoneCondition(e.currentTarget.value)}
                />
              </div>
              <div class="field">
                <label for="task-steps">最大步数</label>
                <input
                  id="task-steps"
                  class={`input ${stepsValue === null ? "invalid" : ""}`}
                  type="number"
                  min={1}
                  max={500}
                  value={maxSteps}
                  onInput={(e) => setMaxSteps(e.currentTarget.value)}
                />
                <p class="hint-text">Agent 最多执行这么多轮操作，超过就判为失败。</p>
              </div>
              <div class="field">
                <label for="task-timeout">超时（分钟）</label>
                <input
                  id="task-timeout"
                  class={`input ${timeoutValue === null ? "invalid" : ""}`}
                  type="number"
                  min={1}
                  max={600}
                  value={timeoutMinutes}
                  onInput={(e) => setTimeoutMinutes(e.currentTarget.value)}
                />
                <p class="hint-text">运行超过这个时间会自动终止。</p>
              </div>
              <div class="field">
                <label>结果格式</label>
                <div class="seg">
                  {FORMATS.map((f) => (
                    <span key={f.value} class={resultFormat === f.value ? "on" : ""} onClick={() => setResultFormat(f.value)}>
                      {f.label}
                    </span>
                  ))}
                </div>
              </div>
              <div class="field">
                <label>完成后关闭浏览器</label>
                <button type="button" role="switch" aria-checked={autoClose} class={`switch ${autoClose ? "on" : ""}`} onClick={() => setAutoClose(!autoClose)}>
                  <span>任务结束后自动关闭</span>
                  <i />
                </button>
              </div>
            </div>
          )}
        </div>

        {task && (
          <button type="button" class="link-btn danger" onClick={remove}>
            删除这个任务
          </button>
        )}
      </div>

      <div class="action-bar">
        <div class="action-bar-inner">
          <div class="sum">
            <span class="ic">
              <Icon name="window" size={16} />
            </span>
            <div class="tx">
              {error ? (
                <b class="error-text-inline">{error}</b>
              ) : scheduled ? (
                <>
                  <b>{scheduleLabel(repeat, time)}</b> 自动运行{upcoming && <> · {repeat === "hours" ? "首次" : "下次"} <b>{formatUpcoming(upcoming)}</b></>}
                  <small>
                    {kernel?.name ?? "未选择内核"} · {profileLabel} · 完成后{autoClose ? "自动关闭" : "保留"}浏览器
                  </small>
                </>
              ) : (
                <>
                  <b>{kernel?.name ?? "未选择内核"}</b> · {profileLabel}
                  <small>完成后{autoClose ? "自动关闭" : "保留"}浏览器</small>
                </>
              )}
            </div>
          </div>
          <button type="button" class="btn" onClick={() => go("tasks")}>
            取消
          </button>
          {scheduled ? (
            <button type="button" class="btn btn-primary btn-lg" disabled={!canSave} onClick={() => void save(false)}>
              {task ? "保存" : "保存并启用"}
            </button>
          ) : (
            <>
              <button type="button" class="btn" disabled={!canSave} onClick={() => void save(false)}>
                仅保存
              </button>
              <button
                type="button"
                class="btn btn-primary btn-lg"
                disabled={!canSave || state.running}
                title={state.running ? "已有任务正在运行" : undefined}
                onClick={() => void save(true)}
              >
                保存并运行
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
