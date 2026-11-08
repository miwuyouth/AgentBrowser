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

/* ───────────────────────── 浏览器内核 ───────────────────────── */

function KernelCard({ kernel: k }: { kernel: KernelItem }) {
  const [key, setKey] = useState("");

  const percent = k.progress !== undefined ? Math.round(k.progress * 100) : undefined;
  const needKey = !k.installed && !k.installing && k.needsLicense && k.licenseMissing;

  const subtitle = k.installed
    ? [k.ver, k.usage].filter(Boolean).join(" · ")
    : k.installing
      ? (k.progressText ?? "正在下载…")
      : k.installError && !needKey
        ? k.installError
        : needKey
          ? "需要授权 key 才能使用"
          : "未安装";

  const uninstall = () => {
    if (!window.confirm(`卸载「${k.name}」？已有的 Profile 数据会保留。`)) return;
    void report(() => window.agentApi.uninstallKernel(k.id));
  };

  return (
    <div class="card kcard">
      <div class="kcard-top">
        <span class="kico">
          <Icon name="env" size={18} />
        </span>
        <div class="kcard-title">
          <h3>
            {k.name}
            {k.installed && k.isDefault && <span class="badge solid">默认</span>}
          </h3>
          <div class={`kcard-sub ${k.installError && !k.installed && !needKey ? "err" : ""}`}>{subtitle}</div>
        </div>
      </div>

      {k.installing && (
        <div class={`ob-progress ${percent === undefined ? "indeterminate" : ""}`}>
          <i style={percent !== undefined ? { width: `${percent}%` } : undefined} />
        </div>
      )}

      {needKey && (
        <form
          class="kcard-key"
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

      {!k.installed && !k.installing && !needKey && (
        <div class="kcard-act">
          <span />
          <button type="button" class="btn" onClick={() => void report(() => window.agentApi.installKernel(k.id))}>
            {k.installError ? "重试下载" : "下载"}
          </button>
        </div>
      )}

      {k.installed && (
        <div class="kcard-act">
          <span>已安装</span>
          <span class="kcard-btns">
            {!k.isDefault && (
              <button type="button" class="btn btn-sm" onClick={() => void window.agentApi.setDefaultKernel(k.id)}>
                设为默认
              </button>
            )}
            <button type="button" class="btn btn-sm" onClick={uninstall}>
              卸载
            </button>
          </span>
        </div>
      )}
    </div>
  );
}

/* ───────────────────────── Profile ───────────────────────── */

function ProfileRow({ profile: p, kernel, busy }: { profile: ProfileItem; kernel: KernelItem | undefined; busy: boolean }) {
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(p.name);
  /** 这一轮重命名是否已经结束：回车、Esc 之后输入框卸载还会触发一次失焦，不能再处理第二遍 */
  const settled = useRef(true);

  const canOpen = !!kernel?.installed && !busy;
  const openTitle = !kernel?.installed ? "先安装对应的浏览器内核" : busy ? "有任务正在运行" : "打开浏览器，手动登录网站";

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

  const remove = async () => {
    if (!window.confirm(`删除 Profile「${p.name}」？它保存的网站登录状态会一并删除，无法恢复。`)) return;
    try {
      await window.agentApi.deleteProfile(p.id);
    } catch (err) {
      toast(errorMessage(err), true);
    }
  };

  return (
    <li class="row row-static">
      <span class="avatar">{p.initial}</span>
      <div class="row-main">
        {renaming ? (
          <input
            class="input input-sm"
            autofocus
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
        <div class="row-sub">{[p.kernel, p.usage].filter(Boolean).join(" · ")}</div>
      </div>

      <span class="row-actions">
        <button type="button" class="btn btn-sm" disabled={!canOpen} title={openTitle} onClick={() => void open()}>
          <Icon name="window" size={13} />
          打开
        </button>
        <button type="button" class="icon-btn" aria-label="重命名" title="重命名" onClick={startRename}>
          <Icon name="edit" size={15} />
        </button>
        {!p.isDefault && (
          <button type="button" class="icon-btn" aria-label="删除" title="删除" onClick={() => void remove()}>
            <Icon name="trash" size={15} />
          </button>
        )}
      </span>
      <span class="row-meta">{p.size}</span>
    </li>
  );
}

function NewProfileDialog({ kernels, onClose }: { kernels: KernelItem[]; onClose: () => void }) {
  const [name, setName] = useState("");
  const [kernelId, setKernelId] = useState((kernels.find((k) => k.isDefault) ?? kernels[0])?.id ?? "");
  const [saving, setSaving] = useState(false);

  const create = async () => {
    setSaving(true);
    try {
      const created = await window.agentApi.createProfile(kernelId, name.trim());
      toast(`已创建「${created.name}」`);
      onClose();
    } catch (err) {
      toast(errorMessage(err), true);
      setSaving(false);
    }
  };

  return (
    <Modal title="新建 Profile" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim() && kernelId && !saving) void create();
        }}
      >
        <div class="modal-body">
          <div class="field">
            <label for="np-name">名称</label>
            <input id="np-name" class="input" autofocus ref={(el) => el?.focus()} placeholder="例如：商城账号" value={name} onInput={(e) => setName(e.currentTarget.value)} />
          </div>
          {kernels.length > 1 && (
            <div class="field">
              <label for="np-kernel">浏览器内核</label>
              <div class="select-wrap">
                <select id="np-kernel" class="input" value={kernelId} onChange={(e) => setKernelId(e.currentTarget.value)}>
                  {kernels.map((k) => (
                    <option key={k.id} value={k.id}>
                      {k.name}
                    </option>
                  ))}
                </select>
                <Icon name="chevron" size={14} />
              </div>
            </div>
          )}
        </div>
        <div class="modal-foot">
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={!name.trim() || !kernelId || saving}>
            创建
          </button>
        </div>
      </form>
    </Modal>
  );
}

/* ───────────────────────── 页面 ───────────────────────── */

export function EnvView({ state }: { state: AppState }) {
  const [creating, setCreating] = useState(false);
  const installed = state.kernels.filter((k) => k.installed);

  return (
    <div class="page">
      <PageHead title="运行环境" desc="任务在哪个浏览器、以什么登录身份运行" />

      <section class="section-block">
        <div class="sec-head">
          <div>
            <h2>浏览器内核</h2>
            <p>任务使用的浏览器程序。默认内核已就绪时，通常无需调整。</p>
          </div>
        </div>
        <div class="kgrid">
          {state.kernels.map((k) => (
            <KernelCard key={k.id} kernel={k} />
          ))}
        </div>
      </section>

      <section class="section-block">
        <div class="sec-head">
          <div>
            <h2>Profile</h2>
            <p>独立的登录身份与数据目录，账号登录一次即可反复使用。</p>
          </div>
          <button
            type="button"
            class="btn btn-primary btn-sm"
            disabled={installed.length === 0}
            title={installed.length === 0 ? "先安装一个浏览器内核" : undefined}
            onClick={() => setCreating(true)}
          >
            新建 Profile
          </button>
        </div>

        {state.profiles.length === 0 ? (
          <div class="empty">
            <h2>还没有 Profile</h2>
            <p>安装浏览器内核后，会自动生成一个默认 Profile。</p>
          </div>
        ) : (
          <ul class="list">
            {state.profiles.map((p) => (
              <ProfileRow key={p.id} profile={p} kernel={state.kernels.find((k) => k.id === p.kernelId)} busy={state.running} />
            ))}
          </ul>
        )}
      </section>

      {creating && <NewProfileDialog kernels={installed} onClose={() => setCreating(false)} />}
    </div>
  );
}
