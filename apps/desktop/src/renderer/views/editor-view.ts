import type { AppState, ProfileItem, TaskItem } from "../../shared.ts";
import { escapeHtml, icon } from "../ui.ts";

export function renderEditorView(
  state: AppState,
  editingTaskId: string | undefined,
  onNavigate: (view: "tasks" | "editor" | "live" | "runs" | "kernels" | "profiles", taskId?: string) => void,
  onSaveTask: (task: Partial<TaskItem>, runImmediately: boolean) => Promise<void>,
  onOpenSettings: () => void,
  onTestBrowser: (kernelId: string, profileId: string) => Promise<void>,
  onOpenBrowser: (kernelId: string, profileId: string, url?: string) => Promise<void>,
  onCreateProfile: (kernelId: string, name: string) => Promise<ProfileItem>,
): HTMLElement {
  const container = document.createElement("main");
  container.className = "page";

  const existingTask = editingTaskId ? state.tasks.find((t) => t.id === editingTaskId) : null;
  const isEdit = !!existingTask;

  const defaultKernelObj = state.kernels.find((k) => k.isDefault) || state.kernels[0];
  let kernelId =
    (existingTask?.kernelId && state.kernels.some((k) => k.id === existingTask.kernelId)
      ? existingTask.kernelId
      : state.kernels.find((k) => k.name === existingTask?.kernel)?.id) ||
    defaultKernelObj?.id ||
    "";

  const getProfilesForKernel = (kId: string) => state.profiles.filter((p) => p.kernelId === kId);

  const initialProfiles = getProfilesForKernel(kernelId);
  let profileId =
    (existingTask?.profileId && initialProfiles.some((p) => p.id === existingTask.profileId)
      ? existingTask.profileId
      : initialProfiles.find((p) => p.name === existingTask?.profile)?.id) ||
    initialProfiles[0]?.id ||
    "";

  // 表单状态
  let name = existingTask?.name || "";
  let goal = existingTask?.goal || "";
  let url = existingTask?.url || "";
  let doneCondition = existingTask?.doneCondition || "";
  let autoClose = existingTask?.autoClose ?? true;

  let mode: "now" | "cron" = existingTask?.mode || "now";
  let repeat: "daily" | "weekday" | "weekly" | "hours" | "once" =
    existingTask?.repeatKind && existingTask.repeatKind !== "manual" ? existingTask.repeatKind : "daily";
  let time = existingTask?.repeatTime || "08:30";

  let maxSteps = existingTask?.maxSteps || 30;
  let timeoutMinutes = existingTask?.timeoutMinutes || 10;
  let resultFormat: "text" | "json" | "markdown" = existingTask?.resultFormat || "text";

  let showNewProfileInput = false;
  let newProfileName = "";

  /** 校验：目标为空时阻止保存，并给出可操作的提示 */
  let goalError = false;
  let advancedOpen = false;

  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const formatFutureDate = (daysAhead: number, timeStr: string) => {
    const d = new Date(now.getTime() + daysAhead * 86400000);
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${timeStr}`;
  };

  /** 由所选时间推导 cron，避免「时间改成 09:15 但 cron 还是 8:30」的误导 */
  const getRepeatDefs = (tStr: string) => {
    const [rawH, rawM] = tStr.split(":");
    const h = String(Math.min(23, Math.max(0, Number(rawH) || 8)));
    const m = String(Math.min(59, Math.max(0, Number(rawM) || 0)));
    const tomorrow = new Date(now.getTime() + 86400000);

    return {
      daily: {
        cron: `${m} ${h} * * *`,
        runs: [formatFutureDate(1, tStr), formatFutureDate(2, tStr), formatFutureDate(3, tStr)],
        label: `每天 ${tStr} 自动开始`,
      },
      weekday: {
        cron: `${m} ${h} * * 1-5`,
        runs: [formatFutureDate(1, tStr), formatFutureDate(2, tStr), formatFutureDate(3, tStr)],
        label: `工作日 ${tStr} 自动开始`,
      },
      weekly: {
        cron: `${m} ${h} * * 1`,
        runs: [formatFutureDate(7, tStr), formatFutureDate(14, tStr), formatFutureDate(21, tStr)],
        label: `每周一 ${tStr} 自动开始`,
      },
      hours: {
        cron: `${m} */6 * * *`,
        runs: ["下个整点", "下个周期 (+6h)", "下下个周期 (+12h)"],
        label: `每 6 小时自动开始一次（${tStr} 起算）`,
      },
      once: {
        cron: `${m} ${h} ${tomorrow.getDate()} ${tomorrow.getMonth() + 1} *`,
        runs: [formatFutureDate(1, tStr)],
        label: `执行一次（${formatFutureDate(1, tStr)}）`,
      },
    };
  };

  const renderContent = () => {
    const isCron = mode === "cron";
    const repeatDefs = getRepeatDefs(time);
    const repInfo = repeatDefs[repeat] || repeatDefs.daily;
    const whenLine = isCron ? repInfo.label : "保存后马上开始";
    const primaryLabel = isCron ? "保存并启用" : "保存并立即执行";

    const selectedKernel = state.kernels.find((k) => k.id === kernelId) || state.kernels[0];
    const kernelProfiles = getProfilesForKernel(kernelId);
    if (!kernelProfiles.some((p) => p.id === profileId)) {
      profileId = kernelProfiles[0]?.id || "";
    }
    const selectedProfile = kernelProfiles.find((p) => p.id === profileId) || kernelProfiles[0];

    container.innerHTML = `
      <div class="page-inner">
        <header class="page-head">
          <div class="page-head-main">
            <button type="button" class="back-link" id="breadcrumb-tasks">${icon("arrowLeft", 14)}任务</button>
            <h1>${isEdit ? "编辑任务" : "新建任务"}</h1>
            <p class="page-sub">用自然语言写清目标，选好浏览器身份与执行方式。只有名称和目标必填。</p>
          </div>
          <div class="page-actions">
            <button type="button" class="btn btn-ghost" id="btn-cancel">取消</button>
            <button type="button" class="btn btn-secondary" id="btn-save-only">仅保存</button>
            <button type="button" class="btn btn-primary" id="btn-save-primary">${primaryLabel}</button>
          </div>
        </header>

        <div class="editor-grid">
          <div class="editor-form">
            <!-- 1. 任务内容 -->
            <section class="section">
              <div class="section-head">
                <h2 class="section-title">任务</h2>
              </div>

              <div class="field">
                <label for="task-name">名称</label>
                <input id="task-name" type="text" value="${escapeHtml(name)}" placeholder="例如：每日签到 / 价格监控 / 简报抓取" />
              </div>

              <div class="field">
                <label for="task-goal">目标</label>
                <textarea id="task-goal" rows="4" aria-invalid="${goalError}"
                  placeholder="描述 Agent 要在网页里做什么、做到什么程度。例如：打开网站点击签到领取奖励，成功后返回签到天数。">${escapeHtml(goal)}</textarea>
                ${
                  goalError
                    ? `<p class="field-error" role="alert">${icon("alert", 13)}请先写下任务目标，Agent 需要它才知道要做什么。</p>`
                    : `<p class="field-hint">写得越具体，执行越稳定：先做什么、点什么、结果要什么格式。</p>`
                }
              </div>

              <div class="field-row">
                <div class="field">
                  <label for="task-url">起始网址<span class="field-hint">（可选）</span></label>
                  <input id="task-url" class="mono" type="url" value="${escapeHtml(url)}" placeholder="https://example.com" />
                </div>
                <div class="field">
                  <label for="task-done">完成判定<span class="field-hint">（可选）</span></label>
                  <input id="task-done" type="text" value="${escapeHtml(doneCondition)}" placeholder="例如：页面出现「签到成功」" />
                </div>
              </div>
            </section>

            <div class="divider"></div>

            <!-- 2. 执行方式 -->
            <section class="section">
              <div class="section-head">
                <h2 class="section-title">执行方式</h2>
                <span class="section-hint">${escapeHtml(whenLine)}</span>
              </div>

              <div class="segmented">
                <button type="button" class="segmented-btn ${!isCron ? "active" : ""}" data-mode="now">立即执行</button>
                <button type="button" class="segmented-btn ${isCron ? "active" : ""}" data-mode="cron">定时执行</button>
              </div>

              ${
                isCron
                  ? `
                <div class="field">
                  <label>重复</label>
                  <div class="choice-row">
                    <button type="button" class="choice ${repeat === "daily" ? "active" : ""}" data-repeat="daily">每天</button>
                    <button type="button" class="choice ${repeat === "weekday" ? "active" : ""}" data-repeat="weekday">工作日</button>
                    <button type="button" class="choice ${repeat === "weekly" ? "active" : ""}" data-repeat="weekly">每周一</button>
                    <button type="button" class="choice ${repeat === "hours" ? "active" : ""}" data-repeat="hours">每 6 小时</button>
                    <button type="button" class="choice ${repeat === "once" ? "active" : ""}" data-repeat="once">只执行一次</button>
                  </div>
                </div>

                <div class="field" style="max-width: 160px;">
                  <label for="task-time">时间</label>
                  <input id="task-time" class="mono" type="text" value="${escapeHtml(time)}" placeholder="08:30" />
                  <p class="field-hint">24 小时制，例如 08:30</p>
                </div>
              `
                  : `<p class="field-hint">保存后立即启动所选浏览器内核与 Profile，Agent 开始执行。</p>`
              }
            </section>

            <div class="divider"></div>

            <!-- 3. 运行环境 -->
            <section class="section">
              <div class="section-head">
                <h2 class="section-title">运行环境</h2>
                <div class="page-actions">
                  <button type="button" class="btn btn-secondary btn-sm" id="btn-test-browser">测试连接</button>
                  <button type="button" class="btn btn-ghost btn-sm" id="btn-open-browser">手动打开</button>
                  <button type="button" class="btn btn-ghost btn-sm" id="btn-toggle-new-profile">新建 Profile</button>
                </div>
              </div>

              <div class="field-row">
                <div class="field">
                  <label for="task-kernel">浏览器内核</label>
                  <select id="task-kernel">
                    ${state.kernels
                      .map(
                        (k) =>
                          `<option value="${escapeHtml(k.id)}" ${k.id === kernelId ? "selected" : ""}>${escapeHtml(k.name)} ${escapeHtml(k.ver)}${k.isDefault ? "（默认）" : ""}</option>`,
                      )
                      .join("")}
                  </select>
                </div>
                <div class="field">
                  <label for="task-profile">Profile</label>
                  <select id="task-profile">
                    ${kernelProfiles
                      .map(
                        (p) =>
                          `<option value="${escapeHtml(p.id)}" ${p.id === profileId ? "selected" : ""}>${escapeHtml(p.name)}${p.isDefault ? "（默认）" : ""} · ${escapeHtml(p.size)}</option>`,
                      )
                      .join("")}
                  </select>
                </div>
              </div>

              ${
                showNewProfileInput
                  ? `
                <div class="notice" style="align-items: flex-end;">
                  <div class="field" style="flex: 1 1 240px;">
                    <label for="input-new-profile-name">在「${escapeHtml(selectedKernel?.name || "")}」下新建 Profile</label>
                    <input id="input-new-profile-name" type="text" value="${escapeHtml(newProfileName)}" placeholder="例如：工作账号 / 测试号" />
                  </div>
                  <div class="page-actions">
                    <button type="button" class="btn btn-secondary btn-sm" id="btn-cancel-new-profile">取消</button>
                    <button type="button" class="btn btn-primary btn-sm" id="btn-confirm-new-profile">创建并选中</button>
                  </div>
                </div>
              `
                  : ""
              }

              <label class="check">
                <input type="checkbox" id="check-auto-close" ${autoClose ? "checked" : ""} />
                任务完成后自动关闭浏览器
              </label>
            </section>

            <!-- 4. 高级：默认收起，需要时展开 -->
            <details class="disclosure" id="advanced-disclosure" ${advancedOpen ? "open" : ""}>
              <summary>${icon("chevronRight", 13)}高级设置</summary>
              <div class="disclosure-body">
                <div class="field-row">
                  <div class="field" style="max-width: 160px;">
                    <label for="task-steps">最大步数</label>
                    <input id="task-steps" class="mono" type="number" min="1" value="${maxSteps}" />
                  </div>
                  <div class="field" style="max-width: 160px;">
                    <label for="task-timeout">超时（分钟）</label>
                    <input id="task-timeout" class="mono" type="number" min="1" value="${timeoutMinutes}" />
                  </div>
                  <div class="field" style="max-width: 200px;">
                    <label for="task-format">结果格式</label>
                    <select id="task-format">
                      <option value="text" ${resultFormat === "text" ? "selected" : ""}>文字摘要</option>
                      <option value="json" ${resultFormat === "json" ? "selected" : ""}>JSON</option>
                      <option value="markdown" ${resultFormat === "markdown" ? "selected" : ""}>Markdown</option>
                    </select>
                  </div>
                </div>

                ${
                  isCron
                    ? `
                  <div class="field">
                    <label for="task-cron">Cron 表达式</label>
                    <input id="task-cron" class="mono" type="text" value="${escapeHtml(repInfo.cron)}" />
                    <p class="field-hint">由上面的重复规则自动生成，一般不需要改。</p>
                  </div>
                `
                    : ""
                }
              </div>
            </details>
          </div>

          <!-- 右侧：保存后会发生什么（保持上下文，不跳转） -->
          <aside class="editor-aside" aria-label="运行预览">
            <div class="aside-title">保存后会这样运行</div>
            <ol class="preview-list">
              <li class="preview-item"><span class="step-num">1</span><span>${escapeHtml(whenLine)}</span></li>
              <li class="preview-item">
                <span class="step-num">2</span>
                <span>启动「${escapeHtml(selectedKernel?.name || "Chromium")}」，使用 Profile「${escapeHtml(selectedProfile?.name || "默认")}」，进入${url ? `「${escapeHtml(url)}」` : "起始页"}</span>
              </li>
              <li class="preview-item">
                <span class="step-num">3</span>
                <span>Agent 循环「观察 → 规划 → 操作」，最多 ${maxSteps} 步、${timeoutMinutes} 分钟</span>
              </li>
              <li class="preview-item">
                <span class="step-num">4</span>
                <span>完成后${autoClose ? "自动关闭浏览器，" : "保留浏览器窗口，"}把结果写入运行记录</span>
              </li>
            </ol>

            <div class="aside-meta">
              <span>模型</span>
              <span class="mono ellipsis" title="${escapeHtml(state.provider?.model || "未配置")}">${escapeHtml(state.provider?.model || "未配置")}</span>
              <a href="#" id="link-change-model">修改</a>
            </div>
          </aside>
        </div>
      </div>
    `;

    // ---- 表单绑定 ----
    container.querySelector<HTMLInputElement>("#task-name")?.addEventListener("input", (e) => {
      name = (e.target as HTMLInputElement).value;
    });
    container.querySelector<HTMLTextAreaElement>("#task-goal")?.addEventListener("input", (e) => {
      goal = (e.target as HTMLTextAreaElement).value;
      if (goalError && goal.trim()) {
        goalError = false;
        (e.target as HTMLTextAreaElement).removeAttribute("aria-invalid");
        container.querySelector(".field-error")?.remove();
      }
    });
    container.querySelector<HTMLInputElement>("#task-url")?.addEventListener("input", (e) => {
      url = (e.target as HTMLInputElement).value;
    });
    container.querySelector<HTMLInputElement>("#task-done")?.addEventListener("input", (e) => {
      doneCondition = (e.target as HTMLInputElement).value;
    });
    container.querySelector<HTMLInputElement>("#check-auto-close")?.addEventListener("change", (e) => {
      autoClose = (e.target as HTMLInputElement).checked;
      renderContent();
    });

    container.querySelector<HTMLInputElement>("#task-steps")?.addEventListener("input", (e) => {
      maxSteps = parseInt((e.target as HTMLInputElement).value || "30", 10) || 30;
    });
    container.querySelector<HTMLInputElement>("#task-timeout")?.addEventListener("input", (e) => {
      timeoutMinutes = parseInt((e.target as HTMLInputElement).value || "10", 10) || 10;
    });
    container.querySelector<HTMLSelectElement>("#task-format")?.addEventListener("change", (e) => {
      resultFormat = (e.target as HTMLSelectElement).value as typeof resultFormat;
    });

    // 记住高级设置的展开状态，避免重渲染后收起
    const disclosure = container.querySelector<HTMLDetailsElement>("#advanced-disclosure");
    disclosure?.addEventListener("toggle", () => {
      advancedOpen = !!disclosure.open;
    });

    // 切换内核时，自动切换到该内核下的第一个 Profile
    container.querySelector<HTMLSelectElement>("#task-kernel")?.addEventListener("change", (e) => {
      kernelId = (e.target as HTMLSelectElement).value;
      profileId = getProfilesForKernel(kernelId)[0]?.id || "";
      renderContent();
    });

    container.querySelector<HTMLSelectElement>("#task-profile")?.addEventListener("change", (e) => {
      profileId = (e.target as HTMLSelectElement).value;
      renderContent();
    });

    container.querySelector("#btn-test-browser")?.addEventListener("click", () => {
      if (kernelId && profileId) void onTestBrowser(kernelId, profileId);
    });

    container.querySelector("#btn-open-browser")?.addEventListener("click", () => {
      if (kernelId && profileId) void onOpenBrowser(kernelId, profileId, url.trim() || undefined);
    });

    container.querySelector("#btn-toggle-new-profile")?.addEventListener("click", () => {
      showNewProfileInput = !showNewProfileInput;
      newProfileName = "";
      renderContent();
      container.querySelector<HTMLInputElement>("#input-new-profile-name")?.focus();
    });

    container.querySelector<HTMLInputElement>("#input-new-profile-name")?.addEventListener("input", (e) => {
      newProfileName = (e.target as HTMLInputElement).value;
    });

    container.querySelector("#btn-cancel-new-profile")?.addEventListener("click", () => {
      showNewProfileInput = false;
      newProfileName = "";
      renderContent();
    });

    container.querySelector("#btn-confirm-new-profile")?.addEventListener("click", async () => {
      if (!newProfileName.trim()) return;
      try {
        const created = await onCreateProfile(kernelId, newProfileName.trim());
        state.profiles.push(created);
        profileId = created.id;
        showNewProfileInput = false;
        newProfileName = "";
        renderContent();
      } catch {
        /* 创建失败已提示，保留输入框内容 */
      }
    });

    container.querySelectorAll<HTMLButtonElement>(".segmented-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        mode = btn.getAttribute("data-mode") as typeof mode;
        renderContent();
      });
    });

    container.querySelectorAll<HTMLButtonElement>(".choice").forEach((chip) => {
      chip.addEventListener("click", () => {
        repeat = chip.getAttribute("data-repeat") as typeof repeat;
        renderContent();
      });
    });

    container.querySelector<HTMLInputElement>("#task-time")?.addEventListener("input", (e) => {
      time = (e.target as HTMLInputElement).value;
    });

    container.querySelector("#breadcrumb-tasks")?.addEventListener("click", () => onNavigate("tasks"));
    container.querySelector("#btn-cancel")?.addEventListener("click", () => onNavigate("tasks"));
    container.querySelector("#link-change-model")?.addEventListener("click", (e) => {
      e.preventDefault();
      onOpenSettings();
    });

    const collectData = (): Partial<TaskItem> => ({
      ...(existingTask ? { id: existingTask.id } : {}),
      // validate() 已保证 goal 非空，名称一定能从目标首行推导出来；"未命名任务" 只是防御性兜底
      /* v8 ignore next */
      name: name.trim() || goal.trim().split("\n")[0]?.slice(0, 24) || "未命名任务",
      goal: goal.trim(),
      url: url.trim(),
      doneCondition: doneCondition.trim(),
      kernelId,
      kernel: selectedKernel?.name || "Chromium",
      profileId,
      profile: selectedProfile?.name || "默认 Profile",
      autoClose,
      mode,
      schedule: isCron ? repInfo.label : "手动",
      cronExpr: isCron ? container.querySelector<HTMLInputElement>("#task-cron")?.value || repInfo.cron : undefined,
      repeatKind: isCron ? repeat : "manual",
      repeatTime: time,
      maxSteps: parseInt(container.querySelector<HTMLInputElement>("#task-steps")?.value || "30", 10) || 30,
      timeoutMinutes: parseInt(container.querySelector<HTMLInputElement>("#task-timeout")?.value || "10", 10) || 10,
      resultFormat: (container.querySelector<HTMLSelectElement>("#task-format")?.value as typeof resultFormat) || "text",
    });

    /** 保存前的校验：目标必填，错误就地显示并聚焦 */
    const validate = (): boolean => {
      if (!goal.trim()) {
        goalError = true;
        renderContent();
        const el = container.querySelector<HTMLTextAreaElement>("#task-goal");
        el?.focus();
        el?.scrollIntoView({ block: "center", behavior: "smooth" });
        return false;
      }
      return true;
    };

    container.querySelector("#btn-save-only")?.addEventListener("click", async () => {
      if (!validate()) return;
      try {
        await onSaveTask(collectData(), false);
        onNavigate("tasks");
      } catch {
        /* 保存失败已提示，留在编辑页保住输入 */
      }
    });

    container.querySelector("#btn-save-primary")?.addEventListener("click", async () => {
      if (!validate()) return;
      const data = collectData();
      try {
        await onSaveTask(data, mode === "now");
        onNavigate(mode === "now" ? "live" : "tasks");
      } catch {
        /* 同上 */
      }
    });
  };

  renderContent();
  return container;
}
