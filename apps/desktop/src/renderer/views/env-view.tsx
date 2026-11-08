import { useRef, useState } from "preact/hooks";
import type { AppState, KernelItem, ProfileItem } from "../../shared.ts";
import { errorMessage } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { PageHead } from "../page.tsx";
import { toast } from "../toast.tsx";

/**
 * 包装执行带状态返回值的异步操作，并统一向用户反馈轻提示。
 *
 * 【调用时机】
 * 在安装/卸载内核、保存 License Key、释放被占用 Profile 等 IPC 调用处触发。
 *
 * 【作用】
 * 执行操作，若返回 ok: false 或抛出异常则展示错误轻提示，否则展示成功提示。
 *
 * @param action 异步执行闭包，返回包含 ok 与 message 的对象
 */
async function report(action: () => Promise<{ ok: boolean; message: string }>) {
  try {
    const r = await action();
    toast(r.message, !r.ok);
  } catch (err) {
    toast(errorMessage(err), true);
  }
}

/**
 * 包装执行普通无返回值的异步操作，仅在发生异常时弹窗报错。
 *
 * 【调用时机】
 * 在删除 Profile、设为默认 Profile 等无需成功提示的 IPC 调用处触发。
 *
 * 【作用】
 * 尝试执行异步函数，若抛出异常则通过 toast 弹出红色错误提示。
 *
 * @param action 异步操作闭包
 */
async function attempt(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    toast(errorMessage(err), true);
  }
}

/* ───────────────────────── Profile ───────────────────────── */

/**
 * 单个 Profile 列表项行组件。
 *
 * 【调用时机】
 * 在各个内核卡片（`KernelCard`）下方遍历渲染其归属的所有 Profile 时调用。
 *
 * 【作用】
 * 1. 展现 Profile 名称（双击或点击编辑图标支持内联行内重命名）；
 * 2. 标记是否为全局默认（默认 Profile 带有高亮徽章）；
 * 3. 展现该 Profile 真实占用的本地磁盘空间大小；
 * 4. 操作按钮组：
 *    - "打开"：在独立窗口中拉起浏览器（供用户人工操作或登录网站），若被残留进程锁定则弹出释放引导；
 *    - "设为默认"：将此 Profile 持久化为全局默认（默认内核随之联动）；
 *    - "重命名"：进入行内编辑框修改名称；
 *    - "删除"：物理删除自定义 Profile（内置不可删除 Profile 不提供此按钮）。
 *
 * @param profile 目标 Profile 实体
 * @param kernel 所属浏览器内核实体
 * @param busy 当前是否有任务正在运行中
 */
function ProfileRow({ profile: p, kernel, busy }: { profile: ProfileItem; kernel: KernelItem; busy: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  /** 这一轮重命名是否已经结束：回车、Esc 之后输入框卸载还会触发一次失焦，不能再处理第二遍 */
  const settled = useRef(true);

  const canOpen = kernel.installed && !busy;
  const openTitle = !kernel.installed ? "先安装这个浏览器内核" : busy ? "有任务正在运行" : "打开浏览器，手动登录网站";

  /**
   * 打开浏览器供用户手动操作。
   * 【调用时机】用户点击该 Profile 右侧"打开"按钮时调用。
   */
  const open = async () => {
    try {
      let r = await window.agentApi.openBrowser(p.kernelId, p.id);
      // 被残留的浏览器进程占用：问一句，同意就关掉它再试一次
      if (!r.ok && r.lockedPid && window.confirm(`这个 Profile 正被另一个浏览器进程占用（PID ${r.lockedPid}）。关闭它并重试？`)) {
        const released = await window.agentApi.releaseProfile(r.lockedPid);
        if (!released.ok) return toast(released.message, true);
        r = await window.agentApi.openBrowser(p.kernelId, p.id);
      }
      toast(r.message, !r.ok);
    } catch (err) {
      toast(errorMessage(err), true);
    }
  };

  /**
   * 进入重命名编辑状态。
   * 【调用时机】用户点击重命名笔图标时调用。
   */
  const startRename = () => {
    settled.current = false;
    setRenaming(true);
  };

  /**
   * 提交并持久化保存重命名后的 Profile 名称。
   * 【调用时机】重命名输入框失焦（onBlur）或用户按下 Enter 键时调用。
   */
  const rename = async () => {
    if (settled.current) return;
    settled.current = true;
    const next = name.trim();
    setRenaming(false);
    if (!next || next === p.name) return setName(p.name);
    try {
      await window.agentApi.saveProfile({ id: p.id, name: next });
    } catch (err) {
      setName(p.name);
      toast(errorMessage(err), true);
    }
  };

  /**
   * 删除自定义 Profile。
   * 【调用时机】用户点击垃圾桶删除图标时调用。
   */
  const remove = () => {
    const parts = [`删除 Profile「${p.name}」？`];
    if (p.taskCount > 0) parts.push(`有 ${p.taskCount} 个任务指定了它，删除后会改用其他 Profile。`);
    if (p.isDefault) parts.push("它是默认 Profile，删除后会自动换成另一个。");
    parts.push("它保存的网站登录状态会一并删除，无法恢复。");
    if (window.confirm(parts.join("\n"))) void attempt(() => window.agentApi.deleteProfile(p.id));
  };

  return (
    <li class="row row-static">
      <div class="row-main">
        {renaming ? (
          <input
            class="input input-sm"
            ref={(el) => el?.focus()}
            value={name}
            onInput={(e) => setName(e.currentTarget.value)}
            onBlur={() => void rename()}
            onKeyDown={(e) => {
              if (e.key === "Enter") void rename();
              if (e.key === "Escape") {
                settled.current = true;
                setName(p.name);
                setRenaming(false);
              }
            }}
          />
        ) : (
          <div class="row-name">
            {p.name}
            {p.isDefault && <span class="badge">默认</span>}
          </div>
        )}
      </div>

      <span class="row-actions">
        <button type="button" class="btn btn-sm" disabled={!canOpen} title={openTitle} onClick={() => void open()}>
          <Icon name="window" size={13} />
          打开
        </button>
        {!p.isDefault && (
          <button type="button" class="btn btn-sm" onClick={() => void attempt(() => window.agentApi.setDefaultProfile(p.id))}>
            设为默认
          </button>
        )}
        <button type="button" class="icon-btn" aria-label="重命名" title="重命名" onClick={startRename}>
          <Icon name="edit" size={15} />
        </button>
        {!p.builtin && (
          <button type="button" class="icon-btn" aria-label="删除" title="删除" onClick={remove}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </span>
      <span class="row-meta">{p.size}</span>
    </li>
  );
}

/**
 * 新建 Profile 模态弹窗对话框组件。
 *
 * 【调用时机】
 * 用户在某个内核卡片底部点击"新建 Profile"按钮时浮层渲染。
 *
 * 【作用】
 * 收集用户输入的自定义 Profile 名称，提交调用 `window.agentApi.createProfile` 完成物理目录创建与指纹初始化。
 *
 * @param kernel 目标归属内核对象
 * @param onClose 关闭弹窗回调
 */
function NewProfileDialog({ kernel, onClose }: { kernel: KernelItem; onClose: () => void }) {
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    try {
      const created = await window.agentApi.createProfile(kernel.id, name.trim());
      toast(`已创建「${created.name}」`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), true);
      setSaving(false);
    }
  };

  return (
    <Modal title={`新建 Profile · ${kernel.name}`} onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && !saving) void create();
        }}
      >
        <div class="modal-body">
          <div class="field">
            <label for="np-name">名称</label>
            <input id="np-name" class="input" ref={(el) => el?.focus()} placeholder="例如：商城账号" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </div>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={!name.trim() || saving}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── 浏览器内核（连同它的 Profile） ───────────────────────── */

/**
 * 单个浏览器内核展示与管理卡片组件。
 *
 * 【调用时机】
 * 在 `EnvView` 主工作区中遍历渲染检测到的所有浏览器内核时调用。
 *
 * 【作用】
 * 1. 展现内核名称、安装状态、版本号或下载进度文字；
 * 2. 状态操作：提供"下载"、"重试下载"或"卸载"按钮；
 * 3. 下载过程中展示动态进度条；
 * 4. 商业授权支持：若该内核需要授权 License 且尚未设置，内联展示 Key 输入表单与官方领取链接；
 * 5. 罗列归属该内核的所有 Profile 列表，并在内核已安装时提供"新建 Profile"入口。
 *
 * @param kernel 目标内核实体
 * @param profiles 归属该内核的 Profile 列表
 * @param busy 当前是否有任务在运行中
 * @param onNew 点击触发新建 Profile 弹窗的回调
 */
function KernelCard({ kernel: k, profiles, busy, onNew }: { kernel: KernelItem; profiles: ProfileItem[]; busy: boolean; onNew: () => void }) {
  const [key, setKey] = useState("");

  const percent = k.progress !== undefined ? Math.round(k.progress * 100) : undefined;
  const needKey = !k.installed && !k.installing && k.needsLicense && k.licenseMissing;
  const failed = !k.installed && !k.installing && !needKey && !!k.installError;

  const subtitle = k.installed
    ? k.ver
    : k.installing
      ? (k.progressText ?? "正在下载…")
      : failed
        ? k.installError
        : needKey
          ? "需要授权 key 才能使用"
          : "未安装";

  /**
   * 卸载已下载安装的浏览器内核。
   * 【调用时机】用户点击内核头部的"卸载"按钮并确认时调用。
   */
  const uninstall = () => {
    const used = k.taskCount > 0 ? `有 ${k.taskCount} 个任务用到它。` : "";
    if (window.confirm(`卸载「${k.name}」？${used}已有的 Profile 数据会保留。`)) void report(() => window.agentApi.uninstallKernel(k.id));
  };

  return (
    <section class="card env-card">
      <div class="env-head">
        <div class="env-title">
          <h2>{k.name}</h2>
          <span class={`env-sub ${failed ? "err" : ""}`}>{subtitle}</span>
        </div>

        {k.installed && (
          <span class="row-actions">
            <button type="button" class="btn btn-sm" onClick={uninstall}>
              卸载
            </button>
          </span>
        )}
        {!k.installed && !k.installing && !needKey && (
          <button type="button" class="btn btn-sm" onClick={() => void report(() => window.agentApi.installKernel(k.id))}>
            {failed ? "重试下载" : "下载"}
          </button>
        )}
      </div>

      {k.installing && (
        <div class={`ob-progress env-progress ${percent === undefined ? "indeterminate" : ""}`}>
          <i style={percent !== undefined ? { width: `${percent}%` } : undefined} />
        </div>
      )}

      {needKey && (
        <form
          class="env-key"
          onSubmit={(e) => {
            e.preventDefault();
            if (key.trim()) void report(() => window.agentApi.saveKernelLicense(k.id, key.trim())).then(() => setKey(""));
          }}
        >
          <input class="input" type="password" autocomplete="off" placeholder="cb_…" value={key} onInput={(e) => setKey(e.currentTarget.value)} />
          <button type="submit" class="btn btn-primary" disabled={!key.trim()}>
            保存
          </button>
          {k.claimUrl && (
            <button type="button" class="link-btn" onClick={() => void window.agentApi.openExternal(k.claimUrl!)}>
              领取 key
            </button>
          )}
        </form>
      )}

      {profiles.length > 0 && (
        <ul class="env-profiles">
          {profiles.map((p) => (
            <ProfileRow key={p.id} profile={p} kernel={k} busy={busy} />
          ))}
        </ul>
      )}

      {k.installed && (
        <div class="env-add">
          <button type="button" class="add-btn" onClick={onNew}>
            <Icon name="plus" size={14} />
            新建 Profile
          </button>
        </div>
      )}
    </section>
  );
}

/* ───────────────────────── 页面 ───────────────────────── */

/**
 * 运行环境管理工作区视图组件。
 *
 * 【调用时机】
 * 用户点击侧边栏"运行环境"菜单项（`view === "env"`）时在主工作区渲染。
 *
 * 【作用】
 * 统一管理任务执行所依托的底层浏览器内核与 Profile 登录身份环境：
 * 1. 列表呈现检测到的各浏览器内核卡片（Chromium、指纹型内核等）；
 * 2. 支持下载、重试、卸载内核；
 * 3. 在各内核下查看、打开、设为默认、重命名、删除或新建 Profile；
 * 4. 控制新建 Profile 弹窗的开闭状态。
 *
 * @param state 当前全局应用状态
 */
export function EnvView({ state }: { state: AppState }) {
  const [creatingIn, setCreatingIn] = useState<KernelItem | null>(null);

  return (
    <div class="page">
      <PageHead title="运行环境" desc="任务在哪个浏览器、以什么登录身份运行" />

      <div class="env-list">
        {state.kernels.map((k) => (
          <KernelCard key={k.id} kernel={k} profiles={state.profiles.filter((p) => p.kernelId === k.id)} busy={state.running} onNew={() => setCreatingIn(k)} />
        ))}
      </div>

      {creatingIn && <NewProfileDialog kernel={creatingIn} onClose={() => setCreatingIn(null)} />}
    </div>
  );
}
