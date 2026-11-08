import type { AppState, TaskItem } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { getReadiness } from "../readiness.ts";
import { PageHead } from "../page.tsx";
import type { Navigate } from "../sidebar.tsx";

/**
 * 任务列表单项条目组件。
 *
 * 【调用时机】
 * 在 `TasksView` 任务列表中遍历渲染各个任务时调用。
 *
 * 【作用】
 * 1. 展示任务名称；
 * 2. 点击整行条目跳转该任务的编辑页面（`go("editor", task.id)`）；
 * 3. 右侧提供"运行"（若当前正在跑该任务则显示为"运行中"并支持直达 LiveView）按钮，处理并发互斥状态（`busy && !running` 时禁用）。
 *
 * @param task 任务实体对象
 * @param busy 当前是否有任何任务在运行中
 * @param running 当前正在执行的任务是否正是本任务
 * @param go 路由导航函数
 */
function TaskRow({
  task,
  busy,
  running,
  go,
}: {
  task: TaskItem;
  busy: boolean;
  running: boolean;
  go: Navigate;
}) {
  const open = () => go("editor", task.id);

  return (
    <li
      class="row"
      role="link"
      tabIndex={0}
      aria-label={`编辑「${task.name}」`}
      onClick={open}
      onKeyDown={(e) => e.key === "Enter" && open()}
    >
      <span class="row-name">{task.name}</span>

      <button
        type="button"
        class="btn btn-sm"
        disabled={busy && !running}
        title={busy && !running ? "已有任务正在运行" : running ? "查看实时运行" : undefined}
        onClick={(e) => {
          e.stopPropagation();
          if (running) {
            go("live");
          } else {
            void window.agentApi.runTask(task.id);
            go("live");
          }
        }}
      >
        <Icon name="play" size={12} />
        {running ? "运行中" : "运行"}
      </button>

      <Icon name="chevron" size={14} />
    </li>
  );
}

/**
 * 运行环境就绪检查提示条组件。
 *
 * 【调用时机】
 * 在任务列表页面顶部渲染。
 *
 * 【作用】
 * 评估模型服务商密钥与浏览器内核安装状态。
 * 若尚未配置模型 API Key 或未下载安装浏览器内核，在列表顶部浮动展示指引横幅，并提供直达设置弹窗或环境管理页的一键修复按钮。
 *
 * @param state 当前全局应用状态
 * @param go 路由导航函数
 * @param onOpenSettings 唤起设置模态框回调
 */
function SetupHint({ state, go, onOpenSettings }: { state: AppState; go: Navigate; onOpenSettings: () => void }) {
  const r = getReadiness(state);
  if (r.model && r.kernel) return null;

  const needModel = !r.model;
  const title = needModel ? "先配置模型，才能开始运行任务" : r.kernelStatus === "installing" ? "正在下载浏览器" : "还没有可用的浏览器";
  const desc = needModel ? "需要一个 API Key，约一分钟完成。" : "到运行环境里下载一个浏览器内核。";

  return (
    <div class="hint">
      <Icon name="settings" size={18} />
      <div>
        <b>{title}</b>
        <span>{desc}</span>
      </div>
      <button type="button" class="btn btn-primary btn-sm" onClick={needModel ? onOpenSettings : () => go("env")}>
        {needModel ? "去配置" : "查看"}
      </button>
    </div>
  );
}

/**
 * 任务主列表视图组件。
 *
 * 【调用时机】
 * 用户点击侧边栏"任务"标签页（`view === "tasks"`）时在主视区渲染。
 *
 * 【作用】
 * 1. 按最近更新时间戳（updatedAt）倒序排列呈现所有持久化任务；
 * 2. 在无任务时呈现引导创建第一个任务的空状态插画与按钮；
 * 3. 顶部配合 `SetupHint` 提示未就绪的基础依赖；
 * 4. 汇总任务数量并展示在页面标头。
 *
 * @param state 当前全局应用状态
 * @param go 路由导航函数
 * @param onOpenSettings 唤起设置弹窗回调
 */
export function TasksView({ state, go, onOpenSettings }: { state: AppState; go: Navigate; onOpenSettings: () => void }) {
  // 最近改动的排在最前
  const tasks = [...state.tasks].sort((a, b) => b.updatedAt - a.updatedAt);

  if (tasks.length === 0) {
    return (
      <div class="page">
        <PageHead title="任务" desc="创建第一个自动化任务" />
        <SetupHint state={state} go={go} onOpenSettings={onOpenSettings} />
        <div class="empty">
          <h2>还没有任务</h2>
          <p>用一句话告诉 Agent 要做什么，它会替你操作浏览器。</p>
          <button type="button" class="btn btn-primary btn-lg" onClick={() => go("editor")}>
            新建任务
          </button>
        </div>
      </div>
    );
  }

  return (
    <div class="page">
      <PageHead title="任务" desc={`${tasks.length} 个任务`} />
      <SetupHint state={state} go={go} onOpenSettings={onOpenSettings} />
      <ul class="list">
        {tasks.map((t) => (
          <TaskRow
            key={t.id}
            task={t}
            busy={state.running}
            running={state.activeRun?.taskId === t.id}
            go={go}
          />
        ))}
      </ul>
    </div>
  );
}
