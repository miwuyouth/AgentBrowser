import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AgentApi, type UiEvent } from "./shared.ts";

const api: AgentApi = {
  getState: () => ipcRenderer.invoke(IPC.getState),
  saveSettings: (update) => ipcRenderer.invoke(IPC.saveSettings, update),
  saveTask: (task) => ipcRenderer.invoke(IPC.saveTask, task),
  deleteTask: (id) => ipcRenderer.invoke(IPC.deleteTask, id),
  runTask: (id) => ipcRenderer.invoke(IPC.runTask, id),
  retryRun: (runId) => ipcRenderer.invoke(IPC.retryRun, runId),
  deleteRuns: (ids) => ipcRenderer.invoke(IPC.deleteRuns, ids),
  getRun: (id) => ipcRenderer.invoke(IPC.getRun, id),
  cancelTask: () => ipcRenderer.invoke(IPC.cancelTask),
  createProfile: (kernelId, name) => ipcRenderer.invoke(IPC.createProfile, kernelId, name),
  saveProfile: (profile) => ipcRenderer.invoke(IPC.saveProfile, profile),
  deleteProfile: (id) => ipcRenderer.invoke(IPC.deleteProfile, id),
  openBrowser: (kernelId, profileId, url) => ipcRenderer.invoke(IPC.openBrowser, kernelId, profileId, url),
  testBrowser: (kernelId, profileId) => ipcRenderer.invoke(IPC.testBrowser, kernelId, profileId),
  releaseProfile: (pid) => ipcRenderer.invoke(IPC.releaseProfile, pid),
  showInFolder: (targetPath) => ipcRenderer.invoke(IPC.showInFolder, targetPath),
  setDefaultProfile: (profileId) => ipcRenderer.invoke(IPC.setDefaultProfile, profileId),
  installKernel: (kernelId) => ipcRenderer.invoke(IPC.installKernel, kernelId),
  uninstallKernel: (kernelId) => ipcRenderer.invoke(IPC.uninstallKernel, kernelId),
  saveKernelLicense: (kernelId, key) => ipcRenderer.invoke(IPC.saveKernelLicense, kernelId, key),
  openExternal: (url) => ipcRenderer.invoke(IPC.openExternal, url),
  copyText: (text) => ipcRenderer.invoke(IPC.copyText, text),
  setTheme: (theme) => ipcRenderer.invoke(IPC.setTheme, theme),
  onEvent(listener) {
    const handler = (_: unknown, e: UiEvent) => listener(e);
    ipcRenderer.on(IPC.event, handler);
    return () => ipcRenderer.off(IPC.event, handler);
  },
};

contextBridge.exposeInMainWorld("agentApi", api);
