/**
 * Chrome MV3 后台 Service Worker 入口文件。
 *
 * MV3 Service Worker 生命周期机制：
 * Chrome MV3 不允许持久运行的后台页面（Background Page），Service Worker 会在空闲数十秒后被系统自动挂起（Suspend）。
 * 为了保证 Agent 自动化随时可用：
 * 1. 注册基于 `chrome.alarms` 的定时唤醒闹钟（每 30 秒触发一次），在 Service Worker 挂起后被定期唤醒并重新与 App 建立连接；
 * 2. 监听 `chrome.runtime.onStartup` 与 `chrome.runtime.onInstalled` 事件自动重连；
 * 3. 当 WebSocket 处于活跃通信状态并有 ping 消息往返时，Chrome 不会挂起 Service Worker。
 */

import { connect } from "./connection.ts";

const KEEPALIVE_ALARM = "agent-browser-keepalive";

// 创建半分钟周期的防挂起唤醒定时器
chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === KEEPALIVE_ALARM) void connect();
});
chrome.runtime.onStartup.addListener(() => void connect());
chrome.runtime.onInstalled.addListener(() => void connect());

// 立即尝试建立连接
void connect();
