import type { AppState, ProfileItem } from "../../shared.ts";
import { emptyState, escapeHtml, icon } from "../ui.ts";

/** 跨整页重渲染保留列表选中、筛选与新建栏状态，避免状态推送把表单清空 */
let lastKernelFilter = "all";
let lastSelectedId = "";
let lastShowCreateBar = false;
let lastNewProfileKernelId = "";
let lastNewProfileName = "";

export function renderProfilesView(
  state: AppState,
  onCreateProfile: (kernelId: string, name: string) => Promise<ProfileItem>,
  onSaveProfile: (profile: Partial<ProfileItem>) => Promise<void>,
  onDeleteProfile: (id: string) => Promise<void>,
  onOpenBrowser: (kernelId: string, profileId: string) => Promise<void>,
  onTestBrowser: (kernelId: string, profileId: string) => Promise<void>,
  onShowInFolder: (dirPath: string) => Promise<void>,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  let kernelFilter = lastKernelFilter;
  let selectedId = lastSelectedId || state.profiles?.[0]?.id || "";
  let showCreateBar = lastShowCreateBar;
  let newProfileKernelId =
    lastNewProfileKernelId || state.kernels.find((k) => k.isDefault)?.id || state.kernels[0]?.id || "";
  let newProfileName = lastNewProfileName;

  const renderContent = () => {
    const allProfiles = state.profiles || [];
    const filteredProfiles =
      kernelFilter === "all" ? allProfiles : allProfiles.filter((p) => p.kernelId === kernelFilter);

    const cur: ProfileItem | undefined =
      filteredProfiles.find((p) => p.id === selectedId) || filteredProfiles[0] || allProfiles[0];
    if (cur) selectedId = cur.id;

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            <h1>Profile</h1>
            <p class="page-sub">每个 Profile 是一份独立的浏览器身份，Cookie 与登录状态都存在它自己的目录里，任务运行时直接复用。</p>
          </div>
          <div class="page-actions">
            <button type="button" class="btn btn-primary" id="btn-create-profile">${icon("plus", 15)}新建 Profile</button>
          </div>
        </header>

        ${
          showCreateBar
            ? `
          <div class="notice" style="align-items: flex-end;">
            <div class="field" style="flex: 0 1 220px;">
              <label for="new-profile-kernel">所属内核</label>
              <select id="new-profile-kernel">
                ${state.kernels
                  .map(
                    (k) =>
                      `<option value="${escapeHtml(k.id)}" ${k.id === newProfileKernelId ? "selected" : ""}>${escapeHtml(k.name)} ${escapeHtml(k.ver)}</option>`,
                  )
                  .join("")}
              </select>
            </div>
            <div class="field" style="flex: 1 1 260px;">
              <label for="new-profile-name">名称</label>
              <input id="new-profile-name" type="text" value="${escapeHtml(newProfileName)}" placeholder="例如：工作账号 / 运营号 / 测试环境" />
            </div>
            <div class="page-actions">
              <button type="button" class="btn btn-ghost" id="btn-cancel-create">取消</button>
              <button type="button" class="btn btn-primary" id="btn-confirm-create">创建</button>
            </div>
          </div>
        `
            : ""
        }

        <div class="tabs" role="tablist" aria-label="按内核筛选">
          <button type="button" class="tab ${kernelFilter === "all" ? "active" : ""}" data-kernel="all">
            全部内核<span class="tab-count">${allProfiles.length}</span>
          </button>
          ${state.kernels
            .map((k) => {
              const count = allProfiles.filter((p) => p.kernelId === k.id).length;
              return `
              <button type="button" class="tab ${kernelFilter === k.id ? "active" : ""}" data-kernel="${escapeHtml(k.id)}">
                ${escapeHtml(k.name)}<span class="tab-count">${count}</span>
              </button>
            `;
            })
            .join("")}
        </div>

        ${
          !cur
            ? `<div class="panel">${emptyState({
                icon: "profile",
                title: "这里还没有 Profile",
                desc: "新建一个 Profile，登录一次目标网站，之后的任务就能直接复用这份登录状态。",
                actions: `<button type="button" class="btn btn-primary" id="btn-create-empty">${icon("plus", 15)}新建 Profile</button>`,
              })}</div>`
            : `
          <div class="split">
            <!-- 左：Profile 列表 -->
            <section class="list-panel" aria-label="Profile 列表">
              ${filteredProfiles
                .map((p) => {
                  const isSelected = p.id === cur.id;
                  return `
                  <button type="button" class="list-item ${isSelected ? "active" : ""}" data-id="${escapeHtml(p.id)}"
                    ${isSelected ? 'aria-current="true"' : ""} title="${escapeHtml(p.name)}">
                    <span class="list-item-main">
                      <span class="avatar">${escapeHtml(p.initial || p.name.slice(0, 1))}</span>
                      <span class="list-item-name clamp-2" style="flex: 1;">${escapeHtml(p.name)}</span>
                      ${p.isDefault ? '<span class="tag">默认</span>' : ""}
                    </span>
                    <span class="list-item-meta">
                      <span class="ellipsis">${escapeHtml(p.kernel)} · ${escapeHtml(p.usage)}</span>
                      <span class="mono">${escapeHtml(p.size)}</span>
                    </span>
                  </button>
                `;
                })
                .join("")}
            </section>

            <!-- 右：Profile 详情 -->
            <article class="detail">
              <div class="detail-head">
                <div class="detail-identity">
                  <span class="avatar avatar-lg">${escapeHtml(cur.initial || cur.name.slice(0, 1))}</span>
                  <div class="detail-title">
                    <h2>${escapeHtml(cur.name)} ${cur.isDefault ? '<span class="tag">默认</span>' : ""}</h2>
                    <div class="meta">
                      <span>${escapeHtml(cur.kernel)}</span>
                      <span class="meta-sep">·</span>
                      <span>${escapeHtml(cur.usage)}</span>
                      <span class="meta-sep">·</span>
                      <span class="mono">占用 ${escapeHtml(cur.size)}</span>
                    </div>
                  </div>
                </div>

                <div class="detail-actions">
                  <button type="button" class="btn btn-ghost btn-sm" id="btn-test-profile">测试连接</button>
                  <button type="button" class="btn btn-primary btn-sm" id="btn-manual-open">${icon("external", 14)}手动打开浏览器</button>
                </div>
              </div>

              <div class="divider"></div>

              <section class="section">
                <div class="field-row">
                  <div class="field" style="flex: 1 1 240px;">
                    <label for="p-name">名称</label>
                    <input id="p-name" type="text" value="${escapeHtml(cur.name)}" />
                  </div>
                  <div class="field" style="flex: 1 1 200px;">
                    <label>所属内核</label>
                    <input type="text" value="${escapeHtml(cur.kernel)}" disabled />
                  </div>
                  <div class="field" style="flex: 0 0 auto; justify-content: flex-end;">
                    <label>&nbsp;</label>
                    <button type="button" class="btn btn-secondary" id="btn-save-profile">保存名称</button>
                  </div>
                </div>

                <div class="field">
                  <label>独立数据目录</label>
                  <div class="code-row">
                    <code class="code" title="${escapeHtml(cur.dir)}">${escapeHtml(cur.dir)}</code>
                    <button type="button" class="btn btn-ghost btn-sm" id="btn-show-folder">${icon("folder", 14)}在文件夹中显示</button>
                  </div>
                  <p class="field-hint">点「手动打开浏览器」，用「${escapeHtml(cur.kernel)}」登录目标网站后关闭窗口，登录状态就会保存在这个目录里，供任务复用。</p>
                </div>
              </section>

              <div class="danger-row">
                ${
                  cur.isDefault
                    ? `<span>这是「${escapeHtml(cur.kernel)}」的默认 Profile，不能删除。</span>`
                    : `<span>删除后，这个 Profile 的 Cookie 与登录状态会一起移除，无法恢复。</span>
                       <button type="button" class="btn btn-danger btn-sm" id="btn-delete-profile">${icon("trash", 14)}删除 Profile</button>`
                }
              </div>
            </article>
          </div>
        `
        }
      </div>
    `;

    // ---- 事件 ----
    const openCreateBar = () => {
      showCreateBar = true;
      lastShowCreateBar = true;
      if (kernelFilter !== "all") {
        newProfileKernelId = kernelFilter;
        lastNewProfileKernelId = newProfileKernelId;
      }
      renderContent();
      container.querySelector<HTMLInputElement>("#new-profile-name")?.focus();
    };

    container.querySelector("#btn-create-profile")?.addEventListener("click", openCreateBar);
    container.querySelector("#btn-create-empty")?.addEventListener("click", openCreateBar);

    container.querySelector<HTMLSelectElement>("#new-profile-kernel")?.addEventListener("change", (e) => {
      newProfileKernelId = (e.target as HTMLSelectElement).value;
      lastNewProfileKernelId = newProfileKernelId;
    });

    container.querySelector<HTMLInputElement>("#new-profile-name")?.addEventListener("input", (e) => {
      newProfileName = (e.target as HTMLInputElement).value;
      lastNewProfileName = newProfileName;
    });

    container.querySelector("#btn-cancel-create")?.addEventListener("click", () => {
      showCreateBar = false;
      newProfileName = "";
      lastShowCreateBar = false;
      lastNewProfileName = "";
      renderContent();
    });

    container.querySelector("#btn-confirm-create")?.addEventListener("click", async () => {
      if (!newProfileName.trim()) {
        container.querySelector<HTMLInputElement>("#new-profile-name")?.focus();
        return;
      }
      try {
        const created = await onCreateProfile(newProfileKernelId, newProfileName.trim());
        selectedId = created.id;
        lastSelectedId = created.id;
        showCreateBar = false;
        newProfileName = "";
        lastShowCreateBar = false;
        lastNewProfileName = "";
      } catch {
        /* 创建失败已提示，保留已填内容 */
      }
    });

    container.querySelectorAll<HTMLButtonElement>(".tab").forEach((chip) => {
      chip.addEventListener("click", () => {
        const k = chip.getAttribute("data-kernel");
        if (k) {
          kernelFilter = k;
          lastKernelFilter = kernelFilter;
          renderContent();
        }
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".list-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const id = btn.getAttribute("data-id");
        if (id) {
          selectedId = id;
          lastSelectedId = id;
          renderContent();
        }
      });
    });

    if (cur) {
      container.querySelector("#btn-manual-open")?.addEventListener("click", () => {
        void onOpenBrowser(cur.kernelId, cur.id);
      });

      container.querySelector("#btn-test-profile")?.addEventListener("click", () => {
        void onTestBrowser(cur.kernelId, cur.id);
      });

      container.querySelector("#btn-show-folder")?.addEventListener("click", () => {
        void onShowInFolder(cur.dir);
      });

      container.querySelector("#btn-save-profile")?.addEventListener("click", () => {
        const newName = container.querySelector<HTMLInputElement>("#p-name")?.value.trim() || cur.name;
        void onSaveProfile({ id: cur.id, name: newName });
      });

      container.querySelector("#btn-delete-profile")?.addEventListener("click", () => {
        if (confirm(`删除「${cur.kernel}」下的 Profile「${cur.name}」？登录状态会一起移除，无法恢复。`)) {
          void onDeleteProfile(cur.id);
        }
      });
    }
  };

  renderContent();
  return container;
}
