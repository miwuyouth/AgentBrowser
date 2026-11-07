import type { AgentApi, AppState, ProviderKind } from "../../shared.ts";
import { applyTheme, getStoredTheme } from "../theme.ts";

export class SettingsModalController {
  private dialog: HTMLDialogElement;
  private form: HTMLFormElement;
  private providerSelect: HTMLSelectElement;
  private baseUrlInput: HTMLInputElement;
  private baseUrlHint: HTMLParagraphElement;
  private apiKeyInput: HTMLInputElement;
  private clearKeyCheck: HTMLInputElement;
  private credHint: HTMLParagraphElement;
  private modelInput: HTMLInputElement;
  private findModelInput: HTMLInputElement;
  private effortSelect: HTMLSelectElement;
  private effortRow: HTMLElement;
  private visionCheck: HTMLInputElement;
  private visionRow: HTMLElement;

  private state: AppState | null = null;

  constructor(private api: AgentApi, private onStateChange: (state: AppState) => void) {
    this.dialog = document.getElementById("settings-dialog") as HTMLDialogElement;
    this.form = document.getElementById("settings-form") as HTMLFormElement;

    this.providerSelect = document.getElementById("provider") as HTMLSelectElement;
    this.baseUrlInput = document.getElementById("base-url") as HTMLInputElement;
    this.baseUrlHint = document.getElementById("base-url-hint") as HTMLParagraphElement;
    this.apiKeyInput = document.getElementById("api-key") as HTMLInputElement;
    this.clearKeyCheck = document.getElementById("clear-key") as HTMLInputElement;
    this.credHint = document.getElementById("cred-hint") as HTMLParagraphElement;
    this.modelInput = document.getElementById("model") as HTMLInputElement;
    this.findModelInput = document.getElementById("find-model") as HTMLInputElement;
    this.effortSelect = document.getElementById("effort") as HTMLSelectElement;
    this.effortRow = document.getElementById("effort-row") as HTMLElement;
    this.visionCheck = document.getElementById("vision") as HTMLInputElement;
    this.visionRow = document.getElementById("vision-row") as HTMLElement;

    this.initEvents();
  }

  private initEvents() {
    document.getElementById("close-settings")?.addEventListener("click", () => this.dialog.close());
    document.getElementById("cancel-settings")?.addEventListener("click", () => this.dialog.close());

    this.providerSelect.addEventListener("change", () => {
      this.fillProviderSettings(this.providerSelect.value as ProviderKind);
    });

    const themeButtons = document.querySelectorAll<HTMLButtonElement>("#theme-segmented .segmented-btn");
    themeButtons.forEach((btn) => {
      btn.addEventListener("click", () => {
        const val = btn.getAttribute("data-theme-val") as any;
        if (val) {
          applyTheme(val);
          this.updateThemeButtons();
        }
      });
    });

    this.form.addEventListener("submit", async (e) => {
      e.preventDefault();
      await this.save();
    });
  }

  open(state: AppState) {
    this.state = state;
    this.updateThemeButtons();
    this.fillProviderSettings(state.provider.kind);
    this.dialog.showModal();
  }

  private updateThemeButtons() {
    const cur = getStoredTheme();
    document.querySelectorAll<HTMLButtonElement>("#theme-segmented .segmented-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.getAttribute("data-theme-val") === cur);
    });
  }

  private fillProviderSettings(kind: ProviderKind) {
    if (!this.state) return;
    const p = this.state.providers[kind];
    this.providerSelect.value = kind;
    this.baseUrlInput.value = p.baseURL;
    this.baseUrlInput.placeholder = kind === "anthropic" ? "留空使用官方 API" : "https://api.openai.com/v1";
    this.baseUrlHint.textContent =
      kind === "anthropic"
        ? "填写自定义网关地址时，会关闭网关可能不支持的新特性（context editing、fallback、自适应思考等）。"
        : "任何兼容 OpenAI Chat Completions 的服务，例如本地的 http://127.0.0.1:11434/v1。";
    this.apiKeyInput.value = "";
    this.clearKeyCheck.checked = false;
    this.credHint.textContent =
      p.credentials === "stored"
        ? "已保存密钥（用系统钥匙串加密）。"
        : p.credentials === "environment"
          ? `当前使用环境变量 ${kind === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"}。`
          : kind === "anthropic"
            ? "尚未配置密钥。"
            : "未配置密钥（本地服务通常不需要）。";
    this.modelInput.value = p.model;
    this.modelInput.placeholder = kind === "anthropic" ? "claude-opus-5-5" : "例如 gpt-5 / qwen3-vl / deepseek-chat";
    this.findModelInput.value = p.findModel;
    this.effortSelect.value = p.effort;
    this.visionCheck.checked = p.vision;
    this.effortRow.hidden = kind !== "anthropic";
    this.visionRow.hidden = kind !== "openai-compatible";
  }

  private async save() {
    const kind = this.providerSelect.value as ProviderKind;
    const apiKey = this.apiKeyInput.value.trim();

    try {
      const newState = await this.api.saveSettings({
        kind,
        baseURL: this.baseUrlInput.value,
        model: this.modelInput.value,
        findModel: this.findModelInput.value,
        ...(apiKey ? { apiKey } : {}),
        ...(this.clearKeyCheck.checked ? { clearApiKey: true } : {}),
        ...(kind === "anthropic" ? { effort: this.effortSelect.value as AppState["provider"]["effort"] } : {}),
        ...(kind === "openai-compatible" ? { vision: this.visionCheck.checked } : {}),
      });

      this.state = newState;
      this.onStateChange(newState);
      this.dialog.close();
    } catch (err) {
      alert(String(err instanceof Error ? err.message : err));
    }
  }
}
