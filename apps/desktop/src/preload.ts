import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AgentApi, type UiEvent } from "./shared.ts";

/**
 * Electron Preload 预加载脚本。
 * 在渲染进程主窗口加载前以沙箱化隔离环境运行，通过 contextBridge 安全地将主进程功能代理暴露至 window.agentApi。
 */

/**
 * 组装暴露给前端渲染上下文的 API 对象。
 * 所有函数均负责将前端的调用转译为对应的 IPC 通道通信，避免渲染层直接访问 Node.js / Electron 内部 API。
 */
const api: AgentApi = {
  /**
   * 【调用时机】页面初始化加载（useAppState）时由前端调用。
   * 【作用】通过 IPC 向主进程拉取全量初始全局状态（包含任务、运行摘要、内核、Profile及设置）。
   */
  getState: () => ipcRenderer.invoke(IPC.getState),

  /**
   * 【调用时机】用户在设置弹窗或环境配置页点击保存模型配置时调用。
   * 【作用】将新的服务商类型、BaseURL、API Key 等设置通过 IPC 传给主进程持久化，并返回最新状态。
   */
  saveSettings: (update) => ipcRenderer.invoke(IPC.saveSettings, update),

  /**
   * 【调用时机】用户在「设置 › 通用」里拨动开关时调用。
   * 【作用】把改动的那一项交给主进程立即生效（后台常驻、开机启动、完成通知、退出提醒），返回最新状态。
   */
  saveGeneral: (patch) => ipcRenderer.invoke(IPC.saveGeneral, patch),

  /**
   * 【调用时机】用户在设置弹窗点击"获取列表"时调用。
   * 【作用】用表单当前的地址与密钥向模型服务拉取可选模型列表（无需先保存）。
   */
  listModels: (req) => ipcRenderer.invoke(IPC.listModels, req),

  /**
   * 【调用时机】用户在设置弹窗点击"测试"时调用。
   * 【作用】用表单当前的地址、密钥与模型发一次最小请求，验证配置是否可用（无需先保存）。
   */
  testModel: (req) => ipcRenderer.invoke(IPC.testModel, req),

  /**
   * 【调用时机】用户在任务编辑页点击"保存任务"或"保存并运行"时调用。
   * 【作用】将新建或编辑后的任务对象发送给主进程写入 tasks.json，并返回保存后的完整任务对象。
   */
  saveTask: (task) => ipcRenderer.invoke(IPC.saveTask, task),

  /**
   * 【调用时机】用户在任务列表或任务编辑页点击"克隆任务"时调用。
   * 【作用】通知主进程克隆指定 ID 的任务配置，生成新副本并持久化到 tasks.json，返回克隆后的新任务对象。
   */
  cloneTask: (id) => ipcRenderer.invoke(IPC.cloneTask, id),

  /**
   * 【调用时机】用户在任务列表右侧操作区或任务编辑页点击删除并确认时调用。
   * 【作用】通知主进程从 tasks.json 中永久移除指定 ID 的任务。
   */
  deleteTask: (id) => ipcRenderer.invoke(IPC.deleteTask, id),

  /**
   * 【调用时机】用户在任务卡片上点击"运行"按钮或快捷键触发执行时调用。
   * 【作用】请求主进程任务运行器立即启动指定 ID 的任务。
   */
  runTask: (id) => ipcRenderer.invoke(IPC.runTask, id),

  /**
   * 【调用时机】用户在运行历史列表或运行详情页对失败的任务点击"从失败处重试"时调用。
   * 【作用】通知主进程以"失败重试"模式重新拉起该次运行关联的任务。
   */
  retryRun: (runId) => ipcRenderer.invoke(IPC.retryRun, runId),
  retryBatch: (batchId) => ipcRenderer.invoke(IPC.retryBatch, batchId),

  /**
   * 【调用时机】用户在运行记录页勾选历史记录并点击批量删除，或单个删除某条记录时调用。
   * 【作用】请求主进程物理删除对应运行目录及其截图，并更新索引，返回实际删除数量。
   */
  deleteRuns: (ids) => ipcRenderer.invoke(IPC.deleteRuns, ids),

  /**
   * 【调用时机】用户点击进入某次运行的详情页（RunDetailView）时调用。
   * 【作用】按需向主进程读取单次运行的完整 JSON 明细（包含全部步骤与截图相对路径）。
   */
  getRun: (id) => ipcRenderer.invoke(IPC.getRun, id),
  /**
   * 【调用时机】用户在任务的「表格」视图点「导出 CSV」时调用。
   * 【作用】由主进程弹出系统存储对话框并写入文件。
   */
  saveCsv: (defaultName, content) => ipcRenderer.invoke(IPC.saveCsv, defaultName, content),

  /**
   * 【调用时机】用户在实时视图（LiveView）中点击"终止任务"按钮时调用。
   * 【作用】向主进程的 TaskRunner 发送取消信号，强行中断当前正在执行的任务。
   */
  cancelTask: () => ipcRenderer.invoke(IPC.cancelTask),

  /**
   * 【调用时机】用户在环境配置页为某个浏览器内核新建 Profile 时调用。
   * 【作用】通知主进程为指定内核在磁盘上创建新的 Profile 目录并完成指纹等初始化。
   */
  createProfile: (kernelId, name) => ipcRenderer.invoke(IPC.createProfile, kernelId, name),

  /**
   * 【调用时机】用户在界面修改 Profile 的名称等元数据并失焦/确认时调用。
   * 【作用】通知主进程更新 profiles.json 中记录的元信息。
   */
  saveProfile: (profile) => ipcRenderer.invoke(IPC.saveProfile, profile),

  /**
   * 【调用时机】用户在环境管理页点击删除某个自定义 Profile 时调用。
   * 【作用】通知主进程删除指定 Profile 的元数据及其磁盘目录（内置 Profile 不允许删除）。
   */
  deleteProfile: (id) => ipcRenderer.invoke(IPC.deleteProfile, id),

  /**
   * 【调用时机】用户在环境页点击"打开浏览器"按钮（用于手工登录网站或验证环境）时调用。
   * 【作用】请求主进程启动对应内核与 Profile 的浏览器窗口并挂载扩展。
   */
  openBrowser: (kernelId, profileId, url) => ipcRenderer.invoke(IPC.openBrowser, kernelId, profileId, url),

  /**
   * 【调用时机】用户在环境页点击"测试连接"按钮时调用。
   * 【作用】让主进程启动浏览器并测试扩展 WebSocket 连通性及基础工具健康度。
   */
  testBrowser: (kernelId, profileId) => ipcRenderer.invoke(IPC.testBrowser, kernelId, profileId),

  /**
   * 【调用时机】当打开浏览器由于 Profile 目录被残留进程锁定、弹窗提示冲突时，用户点击"强制释放"时调用。
   * 【作用】请求主进程杀死指定 PID 的残留浏览器进程。
   */
  releaseProfile: (pid) => ipcRenderer.invoke(IPC.releaseProfile, pid),

  /**
   * 【调用时机】用户点击"在访达/资源管理器中显示"按钮时调用。
   * 【作用】通知主进程通过系统 shell 在文件管理器中高亮定位对应目录或文件。
   */
  showInFolder: (targetPath) => ipcRenderer.invoke(IPC.showInFolder, targetPath),

  /**
   * 【调用时机】用户在内核管理卡片上点击"下载"按钮时调用。
   * 【作用】触发主进程调用对应 Provider 的下载与解压安装流程。
   */
  installKernel: (kernelId) => ipcRenderer.invoke(IPC.installKernel, kernelId),

  /**
   * 【调用时机】用户在内核管理卡片上点击"卸载"按钮时调用。
   * 【作用】通知主进程清理已下载的内核二进制文件（保留 Profile 用户数据）。
   */
  uninstallKernel: (kernelId) => ipcRenderer.invoke(IPC.uninstallKernel, kernelId),

  /**
   * 【调用时机】用户在商业内核（需要 License）卡片中输入授权 Key 并提交时调用。
   * 【作用】将授权密钥写入本地内核凭据存储。
   */
  saveKernelLicense: (kernelId, key) => ipcRenderer.invoke(IPC.saveKernelLicense, kernelId, key),

  /**
   * 【调用时机】用户点击界面中的帮助外链或领取 License 链接时调用。
   * 【作用】让系统默认浏览器（如 Safari/Chrome）打开外部 HTTPS 网址。
   */
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),

  /**
   * 【调用时机】用户点击结果复制按钮或复制步骤日志时调用。
   * 【作用】将指定纯文本写入系统剪贴板。
   */
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),

  /**
   * 【调用时机】用户点击侧边栏或设置中的主题切换按钮（浅色/深色/跟随系统）时调用。
   * 【作用】同步通知主进程切换 nativeTheme 窗口外观背景色。
   */
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),

  /**
   * 【调用时机】渲染进程组件（如 useAppState、ToastHost）挂载初始化时调用。
   * 【作用】监听主进程广播的 UI 事件（state 变化、run_update 实时步骤、内核进度、轻提示 notice 等），返回取消监听函数。
   */
  /**
   * 【调用时机】主进程发来 prompt 事件、用户在应用内确认框里做出选择后调用。
   * 【作用】把选择（以及复选框是否勾选）交回主进程。
   */
  answerPrompt: (id, answer) => ipcRenderer.invoke(IPC.answerPrompt, id, answer),

  /**
   * 【调用时机】界面加载好时调用一次。
   * 【作用】补弹界面加载前主进程就已发出的确认框。
   */
  pendingPrompts: () => ipcRenderer.invoke(IPC.pendingPrompts),

  onEvent(listener) {
    const handler = (_: unknown, e: UiEvent) => listener(e);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.off(IPC.event, handler);
  },
};

// 将 API 安全地注入到 window.agentApi 上供前端 React/Preact 组件调用
contextBridge.exposeInMainWorld("agentApi", api);
