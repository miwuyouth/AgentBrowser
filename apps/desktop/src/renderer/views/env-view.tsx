import { useRef, useState } from "preact/hooks";
import type { AppState, KernelItem, ProfileItem } from "../../shared.ts";
import { errorMessage } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { PageHead } from "../page.tsx";
import { toast } from "../toast.tsx";

/** 调用一个返回 {ok, message} 的操作，并把结果用轻提示告诉用户 */
async function report(action: () => Promise<{ ok: boolean; message: string }>) {
  try {
    const r = await action();
    toast(r.message, !r.ok);
  } catch (err) {
    toast(errorMessage(err), true);
  }
}

/** 调用一个没有返回值的操作，失败时提示 */
async function attempt(action: () => Promise<unknown>) {
  try {
    await action();
  } catch (err) {
    toast(errorMessage(err), true);
  }
}

/* ───────────────────────── Profile ───────────────────────── */

function ProfileRow({ profile: p, kernel, busy }: { profile: ProfileItem; kernel: KernelItem; busy: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  /** 这一轮重命名是否已经结束：回车、Esc 之后输入框卸载还会触发一次失焦，不能再处理第二遍 */
  const settled = useRef(true);

  const canOpen = kernel.installed && !busy;
  const openTitle = !kernel.installed ? "先安装这个浏览器内核" : busy ? "有任务正在运行" : "打开浏览器，手动登录网站";

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

  const startRename = () => {
    settled.current = false;
    setRenaming(true);
  };

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
