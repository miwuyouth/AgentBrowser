import { useState } from "preact/hooks";
import type { AppState, ProviderKind } from "../../shared.ts";
import { errorMessage } from "../../shared.ts";
import { Icon } from "../icons.tsx";
import { Modal } from "../modal.tsx";
import { toast } from "../toast.tsx";

type Effort = AppState["provider"]["effort"];
const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const BASE_URL_HINT: Record<ProviderKind, string> = {
  anthropic: "填写自定义网关地址时，会关闭网关可能不支持的新特性。",
  "openai-compatible": "任何兼容 OpenAI Chat Completions 的服务，例如本地的 http://127.0.0.1:11434/v1。",
};

const ENV_KEY: Record<ProviderKind, string> = { anthropic: "ANTHROPIC_API_KEY", "openai-compatible": "OPENAI_API_KEY" };

function keyHint(kind: ProviderKind, credentials: AppState["provider"]["credentials"]): string {
  if (credentials === "stored") return "已保存密钥（用系统钥匙串加密）。留空则保持不变。";
  if (credentials === "environment") return `当前使用环境变量 ${ENV_KEY[kind]}。`;
  return kind === "anthropic" ? "尚未配置密钥。" : "未配置密钥（本地服务通常不需要）。";
}

export function SettingsModal({ state, onClose }: { state: AppState; onClose: () => void }) {
  const [kind, setKind] = useState<ProviderKind>(state.provider.kind);
  const p = state.providers[kind];

  const [baseURL, setBaseURL] = useState(p.baseURL);
  const [apiKey, setApiKey] = useState("");
  const [clearKey, setClearKey] = useState(false);
  const [model, setModel] = useState(p.model);
  const [findModel, setFindModel] = useState(p.findModel);
  const [effort, setEffort] = useState<Effort>(p.effort);
  const [vision, setVision] = useState(p.vision);
  const [advOpen, setAdvOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const compat = kind === "openai-compatible";

  /** 切换服务类型时，各个字段换成该类型已保存的值 */
  const switchKind = (next: ProviderKind) => {
    const q = state.providers[next];
    setKind(next);
    setBaseURL(q.baseURL);
    setApiKey("");
    setClearKey(false);
    setModel(q.model);
    setFindModel(q.findModel);
    setEffort(q.effort);
    setVision(q.vision);
  };

  const valid = !compat || model.trim() !== "";

  const save = async () => {
    setSaving(true);
    try {
      await window.agentApi.saveSettings({
        kind,
        baseURL,
        model,
        findModel,
        ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
        ...(clearKey ? { clearApiKey: true } : {}),
        ...(kind === "anthropic" ? { effort } : { vision }),
      });
      toast("设置已保存");
      onClose();
    } catch (err) {
      toast(errorMessage(err), true);
      setSaving(false);
    }
  };

  return (
    <Modal title="设置" onClose={onClose}>
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
            <label for="set-model">主模型</label>
            <input
              id="set-model"
              class="input mono"
              placeholder={compat ? "例如 gpt-5 / qwen3-vl / deepseek-chat" : "claude-opus-5-5"}
              value={model}
              onInput={(e) => setModel(e.currentTarget.value)}
            />
          </div>

          <div class={`advbox ${advOpen ? "open" : ""}`}>
            <button type="button" class="adv" aria-expanded={advOpen} onClick={() => setAdvOpen(!advOpen)}>
              <Icon name="chevron" size={14} />
              高级设置
              <small>{compat ? "元素定位模型、截图" : "元素定位模型、思考强度"}</small>
            </button>
            {advOpen && (
              <div class="advbody advbody-one">
                <div class="field">
                  <label for="set-find">元素定位模型</label>
                  <input id="set-find" class="input mono" placeholder="留空使用默认" value={findModel} onInput={(e) => setFindModel(e.currentTarget.value)} />
                  <p class="hint-text">find 工具用的小模型。</p>
                </div>
                {!compat && (
                  <div class="field">
                    <label for="set-effort">思考强度</label>
                    <div class="select-wrap">
                      <select id="set-effort" class="input" value={effort} onChange={(e) => setEffort(e.currentTarget.value as Effort)}>
                        {EFFORTS.map((x) => (
                          <option key={x} value={x}>
                            {x}
                          </option>
                        ))}
                      </select>
                      <Icon name="chevron" size={14} />
                    </div>
                  </div>
                )}
                {compat && (
                  <div class="field">
                    <label>发送网页截图</label>
                    <button type="button" role="switch" aria-checked={vision} class={`switch ${vision ? "on" : ""}`} onClick={() => setVision(!vision)}>
                      <span>模型支持视觉</span>
                      <i />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        <div class="modal-foot">
          <button type="button" class="btn" onClick={onClose}>
            取消
          </button>
          <button type="submit" class="btn btn-primary" disabled={!valid || saving}>
            保存
          </button>
        </div>
      </form>
    </Modal>
  );
}
