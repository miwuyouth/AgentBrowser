import { useEffect, useRef, useState } from "preact/hooks";
import { AUTO_PROFILE_LABEL, AUTO_PROFILE_VALUE, errorMessage, type AppState, type FormField } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { PageHead } from "../page.tsx";
import { nextSlot, scheduleLabel, type RepeatKind } from "../../schedule.ts";
import type { Navigate } from "../sidebar.tsx";
import { formatUpcoming } from "../time.ts";

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

/** 正整数且不超过上限校验器；合法返回解析数值，否则返回 null */
const toLimit = (v: string, max: number) => (/^\d+$/.test(v.trim()) && Number(v) >= 1 && Number(v) <= max ? Number(v) : null);

/**
 * 统一样式的表单下拉选择控件。
 *
 * 【调用时机】
 * 在任务内核选择、Profile 选择、表单字段类型选择时渲染。
 *
 * 【作用】
 * 包装标准 HTML `<select>`，附加右侧自定义箭头图标与统一样式。
 */
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

/**
 * 任务创建与编辑主页面视图组件。
 *
 * 【调用时机】
 * 用户点击侧边栏"新建任务"（⌘N）、从任务卡片进入编辑模式、或通过快捷链接跳转时（`view === "editor"`）在主工作区渲染。
 *
 * 【作用】
 * 完整的任务配置工作台：
 * 1. 录入任务名称（必填）、核心目标 Prompt（支持高度自动撑开）与可选起始网址；
 * 2. 调度执行排程（支持手动或每天/工作日/每周一/每6小时的重复周期与时间）；
 * 3. 结构化表单设计器（支持定义让 Agent 在完成目标后提取填写的字段名、字段类型与说明）；
 * 4. 高级参数折叠面板（内核与 Profile 选择、自动创建新 Profile 开关、完成判定条件、最大步数、超时时间、自动关闭浏览器选项等）；
 * 5. 底部固定条：实时计算并预览调度规则或内核 Profile 摘要，支持「仅保存」、「保存并运行」或「保存并启用」。
 *
 * @param state 当前全局应用状态
 * @param taskId 当前编辑的任务 ID；若新建任务则为 undefined
 * @param go 路由导航函数
 */
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
  const [autoClose, setAutoClose] = useState(task?.autoClose ?? true);
  const [repeat, setRepeat] = useState<Repeat>(
    task?.mode === "cron" && task.repeatKind && task.repeatKind !== "manual" && task.repeatKind !== "once" ? task.repeatKind : "manual",
  );
  const [time, setTime] = useState(task?.repeatTime || "08:30");
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [fields, setFields] = useState<FormField[]>(task?.fields ?? []);

  /**
   * 添加一个结构化表单提取字段。
   * 【调用时机】用户在"结果表单"卡片中点击"添加字段"按钮时调用。
   */
  const addField = () => {
    setFields((prev) => [
      ...prev,
      { id: `f-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, name: "", type: "text", description: "" },
    ]);
  };

  /**
   * 更新指定字段的部分配置。
   * 【调用时机】用户修改字段名称、类型下拉选项或说明输入框时调用。
   */
  const updateField = (id: string, patch: Partial<FormField>) => {
    setFields((prev) => prev.map((f) => (f.id === id ? { ...f, ...patch } : f)));
  };

  /**
   * 删除指定的表单提取字段。
   * 【调用时机】用户点击该字段行右侧的删除垃圾桶图标时调用。
   */
  const removeField = (id: string) => {
    setFields((prev) => prev.filter((f) => f.id !== id));
  };

  // 新建任务时直接把光标放在最上面的名称输入框（autofocus 属性在页面内跳转时不生效）
  const nameRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!task) nameRef.current?.focus();
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
  /** 第一个导致无法保存的原因；为空表示表单可以保存，用于底部条提示与按钮悬浮说明 */
  const blocker =
    name.trim() === ""
      ? "请填写任务名称"
      : goal.trim() === ""
        ? "请填写任务目标"
        : !timeOk
          ? "请填写正确的运行时间"
          : stepsValue === null
            ? "最大步数需为 1–500 的整数"
            : timeoutValue === null
              ? "超时时间需为 1–600 分钟的整数"
              : "";
  const canSave = blocker === "" && !saving;

  /**
   * 保存任务并选择性地立即发起执行。
   *
   * 【调用时机】
   * 用户在页面底部操作条点击「保存」、「仅保存」或「保存并运行」时调用。
   *
   * 【作用】
   * 1. 组装表单与高级参数；
   * 2. 调用 IPC `window.agentApi.saveTask` 写入本地持久化 tasks.json；
   * 3. 若 `thenRun === true`，通过 IPC 立即触发任务执行并跳转至实时监控页面（`go("live")`）；
   * 4. 否则返回主任务列表（`go("tasks")`）。
   *
   * @param thenRun 保存完成后是否立即拉起任务执行
   */
  const save = async (thenRun: boolean) => {
    setSaving(true);
    setError("");
    try {
      const autoProfile = profileValue === AUTO_PROFILE_VALUE;
      const saved = await window.agentApi.saveTask({
        ...(task ? { id: task.id } : {}),
        name: name.trim(),
        goal: goal.trim(),
        url: url.trim(),
        doneCondition: doneCondition.trim(),
        fields: fields
          .map((f) => ({ ...f, name: f.name.trim(), description: f.description?.trim() || undefined }))
          .filter((f) => f.name !== ""),
        maxSteps: stepsValue!,
        timeoutMinutes: timeoutValue!,
        kernelId,
        autoProfile,
        ...(autoProfile ? {} : { profileId: profileValue }),
        autoClose,
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

  /**
   * 删除当前编辑的任务。
   *
   * 【调用时机】
   * 用户点击高级设置底部的"删除这个任务"链接并确认对话框时调用。
   *
   * 【作用】
   * 弹出系统确认框；确认后调用 IPC `window.agentApi.deleteTask(task.id)` 物理删除并返回任务列表。
   */
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
            <div class="goal-name">
              <label for="task-name">任务名称</label>
              <input
                id="task-name"
                ref={nameRef}
                class="input"
                required
                placeholder="例如：每日签到"
                value={name}
                onInput={(e) => setName(e.currentTarget.value)}
              />
            </div>
            <label for="task-goal">任务目标</label>
            <textarea
              id="task-goal"
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

        <div class="card form-builder-card">
          <div class="form-builder-head">
            <div>
              <span class="form-builder-title">结果表单（可选）</span>
              <p class="form-builder-desc">设置让 Agent 提取的字段，任务执行后将以结构化表单呈现</p>
            </div>
            <button type="button" class="btn btn-sm" onClick={addField}>
              <Icon name="plus" size={12} />
              添加字段
            </button>
          </div>

          {fields.length === 0 ? (
            <div class="form-builder-empty">
              <span>默认返回纯文本总结。若需提取具体数据（如商品价格、状态等），可点击上方「添加字段」。</span>
            </div>
          ) : (
            <div class="form-fields-list">
              <div class="form-field-row form-field-header" aria-hidden="true">
                <span class="form-field-num">#</span>
                <span class="form-field-col name">字段名称</span>
                <span class="form-field-col type">类型</span>
                <span class="form-field-col desc">提取说明</span>
                <span class="form-field-del-spacer" />
              </div>
              {fields.map((f, i) => (
                <div key={f.id} class="form-field-row">
                  <span class="form-field-num">{i + 1}</span>
                  <div class="form-field-col name">
                    <input
                      class="input"
                      placeholder="字段名称，例如：商品价格"
                      value={f.name}
                      onInput={(e) => updateField(f.id, { name: e.currentTarget.value })}
                    />
                  </div>
                  <div class="form-field-col type">
                    <Select
                      id={`field-type-${f.id}`}
                      value={f.type}
                      onChange={(v) => updateField(f.id, { type: v as "text" | "number" })}
                    >
                      <option value="text">文本</option>
                      <option value="number">数字</option>
                    </Select>
                  </div>
                  <div class="form-field-col desc">
                    <input
                      class="input"
                      placeholder="提取说明（可选，例如：包含单位或纯数字）"
                      value={f.description ?? ""}
                      onInput={(e) => updateField(f.id, { description: e.currentTarget.value })}
                    />
                  </div>
                  <button
                    type="button"
                    class="icon-btn form-field-del"
                    title="删除此字段"
                    aria-label="删除此字段"
                    onClick={() => removeField(f.id)}
                  >
                    <Icon name="trash" size={14} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div class={`advbox ${advOpen ? "open" : ""}`}>
          <button type="button" class="adv" aria-expanded={advOpen} onClick={() => setAdvOpen(!advOpen)}>
            <Icon name="chevron" size={14} />
            高级设置
            <small>内核、Profile、步数与超时</small>
          </button>
          {advOpen && (
            <div class="advbody">
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
              <button
                type="button"
                role="switch"
                aria-checked={autoClose}
                class={`switch-row full ${autoClose ? "on" : ""}`}
                onClick={() => setAutoClose(!autoClose)}
              >
                <span class="switch-row-text">
                  <b>完成后关闭浏览器</b>
                  <small>{autoClose ? "任务结束后自动关闭窗口" : "任务结束后保留窗口，方便查看现场"}</small>
                </span>
                <i class="switch-knob" />
              </button>
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
              ) : blocker ? (
                <>
                  <b>{blocker}</b>
                  <small>填好后才能保存</small>
                </>
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
            <button type="button" class="btn btn-primary btn-lg" disabled={!canSave} title={blocker || undefined} onClick={() => void save(false)}>
              {task ? "保存" : "保存并启用"}
            </button>
          ) : (
            <>
              <button type="button" class="btn" disabled={!canSave} title={blocker || undefined} onClick={() => void save(false)}>
                仅保存
              </button>
              <button
                type="button"
                class="btn btn-primary btn-lg"
                disabled={!canSave || state.running}
                title={blocker || (state.running ? "已有任务正在运行" : undefined)}
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
