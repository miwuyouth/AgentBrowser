import { useState } from "preact/hooks";
import type { AppState, ProviderKind } from "../../shared.ts";
import { errorMessage } from "../../shared.ts";
import { Modal } from "../modal.tsx";
import { toast } from "../toast.tsx";

const BASE_URL_HINT: Record<ProviderKind, string> = {
  anthropic: "使用官方服务可留空；使用代理或网关时填写它的地址。",
  "openai-compatible": "任何兼容 OpenAI Chat Completions 的服务，例如本地的 http://127.0.0.1:11434/v1。",
};

const ENV_KEY: Record<ProviderKind, string> = { anthropic: "ANTHROPIC_API_KEY", "openai-compatible": "OPENAI_API_KEY" };

/**
 * 生成 API 密钥存储状态的说明文案。
 *
 * 【调用时机】
 * 在设置弹窗中渲染 API Key 输入框下方的提示说明时调用。
 *
 * 【作用】
 * 根据密钥当前的来源（系统钥匙串 stored、环境变量 environment 或未配置 none）返回针对性的人性化提示。
 *
 * @param kind 模型服务商类别
 * @param credentials 凭据存储状态
 * @returns 提示文案
 */
function keyHint(kind: ProviderKind, credentials: AppState["provider"]["credentials"]): string {
  if (credentials === "stored") return "已保存密钥（用系统钥匙串加密）。留空则保持不变。";
  if (credentials === "environment") return `当前使用环境变量 ${ENV_KEY[kind]}。`;
  return kind === "anthropic" ? "尚未配置密钥。" : "未配置密钥（本地服务通常不需要）。";
}

/**
 * 全局模型服务配置模态弹窗组件。
 *
 * 【调用时机】
 * 用户在侧边栏左下角点击"设置"按钮、或在任务列表页顶部点击未就绪横幅的"去配置"按钮时浮层渲染。
 *
 * 【作用】
 * 统一管理 Agent 驱动所需的全局大语言模型配置：
 * 1. 切换服务商种类（Anthropic Claude 或 OpenAI 兼容协议）；
 * 2. 配置接口 BaseURL 与主要推理模型名称；
 * 3. 安全管理 API Key：支持输入新密钥（主进程系统钥匙串加密落盘）、留空保持原值、或主动一键清除已存储的密钥；
 * 4. 保存前强制检测：发送一张测试图片，模型无法识别图片（不支持视觉）则拒绝保存；
 * 5. 校验表单并通过 IPC `window.agentApi.saveSettings` 进行持久化。
 *
 * @param state 当前全局应用状态
 * @param onClose 关闭弹窗回调
 */
export function SettingsModal({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [kind, setKind] = useState<ProviderKind>(state.provider.kind);
  const p = state.providers[kind];

  const [baseURL, setBaseURL] = useState(p.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [model, setModel] = useState(p.model);
  const [saving, setSaving] = useState(false);
  // 获取模型列表 / 测试连接的临时状态（只存在于弹窗内，不会保存）
  const [models, setModels] = useState<string[]>([]);
  const [listOpen, setListOpen] = useState(false);
  const [busy, setBusy] = useState<"list" | "test" | null>(null);
  const [probe, setProbe] = useState<{ ok: boolean; message: string } | null>(null);

  const compat = kind === "openai-compatible";

  /**
   * 切换服务商类别。
   * 【调用时机】用户在顶部切换服务商分段单选标签时调用。
   * 【作用】将输入表单中的 BaseURL、模型名、高级参数同步重置为该服务商已保存的对应配置。
   */
  const switchKind = (next: ProviderKind) => {
    const q = state.providers[next];
    setKind(next);
    setBaseURL(q.baseURL);
    setApiKey("");
    setClearKey(false);
    setModel(q.model);
    setModels([]);
    setListOpen(false);
    setProbe(null);
  };

  /** 以表单当前值组装探测请求（未保存也可探测） */
  const probeReq = () => ({
    kind,
    baseURL,
    model: model.trim(),
    ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    ...(clearKey ? { ignoreStored: true } : {}),
  });

  /**
   * 获取模型列表。
   * 【调用时机】用户点击主模型输入框右侧的"获取列表"时调用。
   * 【作用】成功后展开可选列表；失败则在输入框下方提示原因，仍可手动输入。
   */
  const fetchModels = async () => {
    setBusy("list");
    setProbe(null);
    try {
      const r = await window.agentApi.listModels(probeReq());
      if (r.ok) {
        setModels(r.models);
        setListOpen(true);
      } else {
        setProbe({ ok: false, message: r.message });
      }
    } catch (err) {
      setProbe({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  /**
   * 测试连接。
   * 【调用时机】用户点击主模型输入框右侧的"测试"时调用。
   * 【作用】用当前地址、密钥与模型发一次最小请求，并在输入框下方显示结果。
   */
  const runTest = async () => {
    setBusy("test");
    setProbe(null);
    setListOpen(false);
    try {
      setProbe(await window.agentApi.testModel(probeReq()));
    } catch (err) {
      setProbe({ ok: false, message: errorMessage(err) });
    } finally {
      setBusy(null);
    }
  };

  const valid = model.trim() !== "";

  /**
   * 保存当前设置。
   * 【调用时机】用户点击右下角"保存"按钮或在表单中回车提交时调用。
   */
  const save = async () => {
    setSaving(true);
    setProbe(null);
    setListOpen(false);
    try {
      // 保存前必须通过检测：连得上，且模型能识别图片；不通过就不保存
      const check = await window.agentApi.testModel(probeReq());
      if (!check.ok) {
        setProbe(check);
        setSaving(false);
        return;
      }
      await window.agentApi.saveSettings({
        kind,
        baseURL,
        model,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(clearKey ? { clearApiKey: true } : {}),
      });
      toast("设置已保存");
      onClose();
    } catch (err) {
      toast(errorMessage(err), true);
      setSaving(false);
    }
  };

  return (
    <Modal title="设置" onClose={onClose} width={560}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (valid && !saving) void save();
        }}
      >
        <div class="modal-body">
          <div class="field">
            <label>模型服务</label>
            <div class="seg">
              <span class={!compat ? "on" : ""} onClick={() => switchKind("anthropic")}>
                Anthropic
              </span>
              <span class={compat ? "on" : ""} onClick={() => switchKind("openai-compatible")}>
                OpenAI 兼容
              </span>
            </div>
          </div>

          <div class="field">
            <label for="set-base">接口地址</label>
            <input
              id="set-base"
              class="input"
              placeholder={compat ? "https://api.openai.com/v1" : "留空使用官方 API"}
              value={baseURL}
              onInput={(e) => setBaseURL(e.currentTarget.value)}
            />
            <p class="hint-text">{BASE_URL_HINT[kind]}</p>
          </div>

          <div class="field">
            <label for="set-key">API Key</label>
            <input
              id="set-key"
              class="input"
              type="password"
              autocomplete="off"
              placeholder={p.credentials === "stored" ? "••••••••" : compat ? "sk-…（本地服务可留空）" : "sk-ant-…"}
              value={apiKey}
              onInput={(e) => setApiKey(e.currentTarget.value)}
            />
            <p class="hint-text">
              {clearKey ? "保存后将清除已保存的密钥。" : keyHint(kind, p.credentials)}
              {p.credentials === "stored" && (
                <>
                  {" "}
                  <button type="button" class="link-btn" onClick={() => setClearKey(!clearKey)}>
                    {clearKey ? "撤销" : "清除密钥"}
                  </button>
                </>
              )}
            </p>
          </div>

          <div class="field">
            <label for="set-model">模型</label>
            <div class="input-row">
              <input
                id="set-model"
                class="input mono"
                placeholder={compat ? "例如 gpt-5 / qwen3-vl / deepseek-chat，可手动输入" : "claude-opus-5-5"}
                value={model}
                onInput={(e) => {
                  setModel(e.currentTarget.value);
                  setProbe(null);
                }}
              />
              <button type="button" class="btn" disabled={busy !== null} onClick={() => (listOpen ? setListOpen(false) : void fetchModels())}>
                {busy === "list" ? "获取中…" : listOpen ? "收起" : "获取列表"}
              </button>
              <button type="button" class="btn" disabled={busy !== null || saving || model.trim() === ""} onClick={() => void runTest()}>
                {busy === "test" ? "测试中…" : "测试"}
              </button>
            </div>
            {listOpen && (
              <ul class="model-list" role="listbox">
                {models.map((m) => (
                  <li
                    key={m}
                    role="option"
                    aria-selected={m === model}
                    class={m === model ? "on" : ""}
                    onClick={() => {
                      setModel(m);
                      setListOpen(false);
                      setProbe(null);
                    }}
                  >
                    {m}
                  </li>
                ))}
              </ul>
            )}
            {probe && <p class={probe.ok ? "ok-text" : "error-text"}>{probe.message}</p>}
          </div>
        </div>

        <div class="modal-foot">
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={!valid || saving}>
            {saving ? "检测中…" : "保存"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
