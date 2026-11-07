import type { AppState } from "../../shared.ts";
import { emptyState, escapeHtml, icon, moreMenu, status } from "../ui.ts";

export function renderKernelsView(
  state: AppState,
  onSetDefaultKernel: (id: string) => void,
  onRescanKernels: () => void,
  onTestBrowser: (kernelId: string, profileId?: string) => void,
  onOpenBrowser: (kernelId: string, profileId?: string) => void,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  // 记录每个内核行上选中的 Profile ID（用于「测试 / 打开」的目标）
  const selectedProfileByKernel = new Map<string, string>();

  const renderContent = () => {
    const kernels = state.kernels || [];

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            <h1>浏览器内核</h1>
            <p class="page-sub">Agent 会启动其中一个 Chromium 内核，并加载对应 Profile 的登录状态。默认内核用于新建任务时的初始选择。</p>          </div>
          <div class="page-actions">
            <button type="button" class="btn btn-secondary" id="btn-rescan">${icon("refresh", 15)}重新扫描</button>
          </div>
        </header>

        <div class="panel">
          ${
            kernels.length === 0
              ? emptyState({
                  icon: "kernel",
                  title: "未检测到浏览器内核",
                  desc: "需要安装 Chrome、Edge 或其他 Chromium 内核浏览器。安装后点「重新扫描」。",
                  actions: `<button type="button" class="btn btn-primary" id="btn-rescan-empty">${icon("refresh", 15)}重新扫描</button>`,
                })
              : `<div class="list">
                  ${kernels
                    .map((k) => {
                      const kProfiles = state.profiles.filter((p) => p.kernelId === k.id);
                      const activeProfileId = selectedProfileByKernel.get(k.id) || kProfiles[0]?.id || "";
                      return `
                      <div class="kernel-row">
                        <div class="kernel-icon">${icon("kernel", 17)}</div>

                        <div class="kernel-main">
                          <div class="kernel-title">
                            <span>${escapeHtml(k.name)}</span>
                            <span class="ver">${escapeHtml(k.ver)}</span>
                            ${k.isDefault ? '<span class="tag tag-accent">默认</span>' : ""}
                            <span class="tag">${escapeHtml(k.source)}</span>
                          </div>
                          <div class="kernel-path" title="${escapeHtml(k.path)}">${escapeHtml(k.path)}</div>
                        </div>

                        <div class="kernel-health" title="${escapeHtml(k.health)}">
                          ${k.ok ? status("ok", "可用") : status("fail", k.health || "不可用")}
                          <span class="kernel-usage">${escapeHtml(k.usage)}</span>
                        </div>

                        <div class="kernel-actions">
                          ${
                            kProfiles.length === 0
                              ? `<span class="tag" title="该内核下还没有 Profile，测试与打开将使用默认身份">无 Profile</span>`
                              : `<select class="mono" data-kernel-id="${escapeHtml(k.id)}"
                                  style="width: 150px; height: var(--h-sm); font-size: 11.5px;"
                                  aria-label="测试 / 打开时使用的 Profile" title="测试 / 打开时使用的 Profile">
                                  ${kProfiles
                                    .map(
                                      (p) =>
                                        `<option value="${escapeHtml(p.id)}" ${p.id === activeProfileId ? "selected" : ""}>${escapeHtml(p.name)}</option>`,
                                    )
                                    .join("")}
                                </select>`
                          }
                          <button type="button" class="btn btn-secondary btn-sm btn-test-kernel" data-id="${escapeHtml(k.id)}">测试</button>
                          <button type="button" class="btn btn-ghost btn-sm btn-open-kernel" data-id="${escapeHtml(k.id)}">打开</button>
                          ${
                            !k.isDefault && k.ok
                              ? moreMenu(
                                  `<button type="button" class="menu-item btn-set-default" data-id="${escapeHtml(k.id)}">${icon("check", 14)}设为默认内核</button>`,
                                  "内核操作",
                                )
                              : ""
                          }
                        </div>
                      </div>
                    `;
                    })
                    .join("")}
                </div>`
          }
        </div>
      </div>
    `;

    // ---- 事件 ----
    container.querySelector("#btn-rescan")?.addEventListener("click", onRescanKernels);
    container.querySelector("#btn-rescan-empty")?.addEventListener("click", onRescanKernels);

    container.querySelectorAll<HTMLSelectElement>(".kernel-row select").forEach((sel) => {
      sel.addEventListener("change", () => {
        const kId = sel.getAttribute("data-kernel-id");
        if (kId) selectedProfileByKernel.set(kId, sel.value);
      });
    });

    const getSelectedProfile = (kId: string) =>
      container.querySelector<HTMLSelectElement>(`.kernel-row select[data-kernel-id="${kId}"]`)?.value ||
      selectedProfileByKernel.get(kId);

    container.querySelectorAll<HTMLButtonElement>(".btn-test-kernel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) onTestBrowser(id, getSelectedProfile(id));
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-open-kernel").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) onOpenBrowser(id, getSelectedProfile(id));
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".btn-set-default").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) onSetDefaultKernel(id);
      });
    });
  };

  renderContent();
  return container;
}
