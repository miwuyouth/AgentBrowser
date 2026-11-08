import type { ComponentChildren } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState, ProviderKind } from "../shared.ts";
import { errorMessage } from "../shared.ts";
import { Icon } from "./icons.tsx";
import { getReadiness } from "./readiness.ts";

type StepStatus = "done" | "active" | "todo" | "error";

function Step({
  n,
  status,
  title,
  desc,
  children,
}: {
  n: number;
  status: StepStatus;
  title: string;
  desc: string;
  children?: ComponentChildren;
}) {
  return (
    <li class={`ob-step ${status}`}>
      <span class="ob-mark">{status === "done" ? <Icon name="check" size={12} /> : status === "error" ? "!" : n}</span>
      <div class="ob-body">
        <div class="ob-title">{title}</div>
        <div class="ob-desc">{desc}</div>
        {children}
      </div>
    </li>
  );
}

/** 第 1 步：填写模型服务。默认只要一个 API Key；用 OpenAI 兼容接口的人才需要多填两项 */
function ModelForm({ state }: { state: AppState }) {
  const [kind, setKind] = useState<ProviderKind>(state.provider.kind);
  const [apiKey, setApiKey] = useState("");
  const [baseURL, setBaseURL] = useState(state.providers["openai-compatible"].baseURL);
  const [model, setModel] = useState(state.providers["openai-compatible"].model);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const compat = kind === "openai-compatible";
  // Anthropic 必须填密钥；兼容接口（本地服务）密钥可留空，但必须填模型名
  const valid = compat ? model.trim() !== "" : apiKey.trim() !== "";

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await window.agentApi.saveSettings({
        kind,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(compat ? { baseURL: baseURL.trim(), model: model.trim() } : {}),
      });
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      class="ob-form"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid && !saving) void save();
      }}
    >
      <div class="seg">
        <span class={kind === "anthropic" ? "on" : ""} onClick={() => setKind("anthropic")}>
          Anthropic
        </span>
        <span class={compat ? "on" : ""} onClick={() => setKind("openai-compatible")}>
          OpenAI 兼容
        </span>
      </div>

      {compat && (
        <>
          <div class="field">
            <label for="ob-base">接口地址</label>
            <input id="ob-base" class="input" value={baseURL} onInput={(e) => setBaseURL(e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="ob-model">模型名称</label>
            <input
              id="ob-model"
              class="input mono"
              placeholder="例如 gpt-5、qwen3、deepseek-chat"
              value={model}
              onInput={(e) => setModel(e.currentTarget.value)}
            />
          </div>
        </>
      )}

      <div class="field">
        <label for="ob-key">{compat ? "API Key（本地服务可留空）" : "API Key"}</label>
        <div class="ob-inline">
          <input
            id="ob-key"
            class="input"
            type="password"
            autocomplete="off"
            placeholder={compat ? "sk-…" : "sk-ant-…"}
            value={apiKey}
            onInput={(e) => setApiKey(e.currentTarget.value)}
          />
          <button type="submit" class="btn btn-primary" disabled={!valid || saving}>
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
        <p class="hint-text">密钥只保存在本机，并用系统钥匙串加密。</p>
        {error && <p class="error-text">{error}</p>}
      </div>
    </form>
  );
}

export function Onboarding({ state, onDone }: { state: AppState; onDone: () => void }) {
  const r = getReadiness(state);
  const installStarted = useRef(false);
  const profileStarted = useRef(false);

  // 自动下载默认内核：整个引导期间只自动发起一次，失败后由用户点「重试」
  useEffect(() => {
    if (!r.downloadTarget || r.kernelStatus !== "idle" || installStarted.current) return;
    installStarted.current = true;
    void window.agentApi.installKernel(r.downloadTarget.id);
  }, [r.downloadTarget?.id, r.kernelStatus]);

  // 个别内核（如指纹浏览器）不会自动带默认 Profile，这里补建一个
  useEffect(() => {
    if (!r.kernel || r.profile || profileStarted.current) return;
    profileStarted.current = true;
    void window.agentApi.createProfile(r.kernel.id, "默认 Profile");
  }, [r.kernel?.id, r.profile]);

  const target = r.downloadTarget;
  const retry = () => target && void window.agentApi.installKernel(target.id);

  const kernelDesc =
    r.kernelStatus === "done"
      ? `${r.kernel?.name} ${r.kernel?.ver}`
      : r.kernelStatus === "error"
        ? (target?.installError ?? "下载失败")
        : r.kernelStatus === "installing"
          ? `正在下载 ${target?.name}${target?.progressText ? ` · ${target.progressText}` : ""}`
          : "即将开始下载，首次使用需要联网";

  const percent = target?.progress !== undefined ? Math.round(target.progress * 100) : undefined;

  return (
    <div class="ob">
      <div class="ob-drag" />
      <div class="ob-card">
        <h1 class="ob-heading">欢迎使用 Agent Browser</h1>
        <p class="ob-sub">完成下面三步，就可以开始运行任务。其中两步会自动进行。</p>

        <ol class="ob-steps">
          <Step
            n={1}
            status={r.model ? "done" : "active"}
            title="配置模型"
            desc={r.model ? `已配置${state.provider.model ? ` · ${state.provider.model}` : ""}` : "需要一个 API Key，约一分钟完成"}
          >
            {!r.model && <ModelForm state={state} />}
          </Step>

          <Step
            n={2}
            status={r.kernelStatus === "done" ? "done" : r.kernelStatus === "error" ? "error" : "active"}
            title="准备浏览器"
            desc={kernelDesc}
          >
            {r.kernelStatus === "installing" && (
              <div class={`ob-progress ${percent === undefined ? "indeterminate" : ""}`}>
                <i style={percent !== undefined ? { width: `${percent}%` } : undefined} />
              </div>
            )}
            {r.kernelStatus === "error" && (
              <button type="button" class="btn ob-retry" onClick={retry}>
                重试下载
              </button>
            )}
          </Step>

          <Step
            n={3}
            status={r.profile ? "done" : r.kernel ? "active" : "todo"}
            title="创建默认 Profile"
            desc={r.profile ? "已创建，用来保存网站的登录状态" : "浏览器就绪后自动创建"}
          />
        </ol>

        <div class="ob-foot">
          <button type="button" class="link-btn" onClick={onDone}>
            跳过，稍后再配置
          </button>
          <button type="button" class="btn btn-primary btn-lg" disabled={!r.all} onClick={onDone}>
            开始使用
          </button>
        </div>
      </div>
    </div>
  );
}
