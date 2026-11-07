/**
 * Agent 专属标签页分组（Tab Group）安全隔离管理器。
 *
 * 安全边界设计：
 * 为保护用户隐私和工作不受干扰，Agent 只能在专属的 Chrome 标签页组（名为 "Agent"，橙色标识）内活动。
 * 所有浏览器操作工具（页面导航、点击、读取、关闭等）都会经过 `requireTab` 权限校验：
 * 严禁 Agent 触碰或读取该组以外的用户其他标签页，从底层杜绝误操作用户已有网页的风险。
 */

import { ToolError } from "./errors.ts";

/** Agent 专属标签页分组标题名称与持久化 Key */
const GROUP_TITLE = "Agent";
const STORAGE_KEY = "agentGroupId";
const BLANK_URLS = /^(about:blank|chrome:\/\/newtab\/?|chrome:\/\/new-tab-page\/?|chrome-search:\/\/local-ntp)/;

/** 标签页描述结构 */
export interface TabInfo {
  id: number;
  title: string;
  url: string;
  active: boolean;
}

/** 检查指定 ID 的标签页分组当前是否真实存在 */
async function groupExists(id: number): Promise<boolean> {
  try {
    await chrome.tabGroups.get(id);
    return true;
  } catch {
    return false;
  }
}

/**
 * Agent 标签页组核心管理类
 */
class AgentTabGroup {
  private groupId: number | null = null;

  /** 获取当前 Agent 标签页组 ID（依次探测内存、SessionStorage、Chrome 分组查询） */
  async getGroupId(): Promise<number | null> {
    if (this.groupId !== null && (await groupExists(this.groupId))) return this.groupId;
    const stored = (await chrome.storage.session.get(STORAGE_KEY))[STORAGE_KEY];
    if (typeof stored === "number" && (await groupExists(stored))) return this.remember(stored);
    const [found] = await chrome.tabGroups.query({ title: GROUP_TITLE });
    if (found) return this.remember(found.id);
    this.groupId = null;
    return null;
  }

  /** 确保 Agent 分组存在；若不存在则接管空白启动窗口或新建窗口并创建分组 */
  async ensureGroup(): Promise<number> {
    const existing = await this.getGroupId();
    if (existing !== null) return existing;

    // 优先接管启动时打开的空白窗口，否则新建独立窗口
    let tab: chrome.tabs.Tab | undefined;
    for (const win of await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] })) {
      const tabs = win.tabs ?? [];
      const blank = tabs.length > 0 && tabs.every((t) => t.groupId === chrome.tabGroups.TAB_GROUP_ID_NONE && BLANK_URLS.test(t.pendingUrl || t.url || ""));
      if (blank) {
        tab = tabs[0];
        break;
      }
    }
    if (tab?.id !== undefined) {
      await chrome.tabs.update(tab.id, { url: "about:blank", active: true });
    } else {
      const win = await chrome.windows.create({ url: "about:blank", focused: true });
      tab = win?.tabs?.[0];
    }
    if (tab?.id === undefined) throw new ToolError("tab_create_failed", "Could not open a window for the agent.");
    const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: "orange", collapsed: false });
    return this.remember(groupId);
  }

  /** 查询 Agent 分组内的所有标签页 */
  async tabs(): Promise<TabInfo[]> {
    const groupId = await this.getGroupId();
    if (groupId === null) return [];
    const tabs = await chrome.tabs.query({ groupId });
    return tabs
      .filter((t) => t.id !== undefined)
      .map((t) => ({ id: t.id!, title: t.title || "", url: t.pendingUrl || t.url || "", active: t.active }));
  }

  /** 在 Agent 分组中创建新标签页 */
  async createTab(url = "about:blank"): Promise<chrome.tabs.Tab> {
    const groupId = await this.ensureGroup();
    const [first] = await chrome.tabs.query({ groupId });
    const tab = await chrome.tabs.create({ url, active: true, ...(first ? { windowId: first.windowId } : {}) });
    if (tab.id === undefined) throw new ToolError("tab_create_failed", "Chrome did not return the new tab.");
    await chrome.tabs.group({ groupId, tabIds: [tab.id] });
    return tab;
  }

  /**
   * 标签页操作权限校验：
   * 确保 tabId 真实存在且归属于 Agent 专属分组。
   * 若试图操作组外标签页，立即拦截抛出安全错误。
   */
  async requireTab(tabId: number): Promise<chrome.tabs.Tab> {
    let tab: chrome.tabs.Tab;
    try {
      tab = await chrome.tabs.get(tabId);
    } catch {
      throw new ToolError("tab_not_found", `Tab ${tabId} does not exist (it may have been closed). Call tabs_context_mcp for current tab IDs.`);
    }
    const groupId = await this.getGroupId();
    if (groupId === null || tab.groupId !== groupId) {
      throw new ToolError(
        "tab_not_in_group",
        `Tab ${tabId} is not in the agent's tab group. Call tabs_context_mcp to see the tabs you may use, or tabs_create_mcp to open one.`,
      );
    }
    return tab;
  }

  /** 将标签页激活置顶并恢复窗口最小化，确保正常渲染与截图输出 */
  async focus(tab: chrome.tabs.Tab) {
    if (!tab.active && tab.id !== undefined) await chrome.tabs.update(tab.id, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    if (win.state === "minimized") await chrome.windows.update(tab.windowId, { state: "normal" });
  }

  private async remember(id: number) {
    this.groupId = id;
    await chrome.storage.session.set({ [STORAGE_KEY]: id });
    return id;
  }
}

export const tabGroup = new AgentTabGroup();

/** 格式化标签页列表为 Agent 易读的文本概要 */
export function formatTabs(tabs: TabInfo[], executedOn?: number): string {
  if (tabs.length === 0) return "The agent's tab group has no tabs. Use tabs_context_mcp with createIfEmpty: true or tabs_create_mcp.";
  const lines = tabs.map(
    (t) => `• tabId ${t.id}: ${JSON.stringify(t.title || "(untitled)")} (${t.url || "about:blank"})${t.active ? " [active]" : ""}`,
  );
  const head = executedOn !== undefined ? `Executed on tabId ${executedOn}. ` : "";
  return `${head}Tabs in the agent group:\n${lines.join("\n")}`;
}
