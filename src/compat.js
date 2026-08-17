import { tauriAPI } from './api/tauri.js'

// 创建兼容层，让现有的 window.electronAPI 代码能够继续工作
window.electronAPI = {
  // ==================== 认证 ====================
  validateCredentials: (jmsUrl, keyId, secret) =>
    tauriAPI.validateCredentials(jmsUrl, keyId, secret),

  // ==================== 资产 ====================
  getAssets: (jmsUrl, keyId, secret) =>
    tauriAPI.getAssets(jmsUrl, keyId, secret),

  // ==================== SSH 连接（多 tab 支持）====================
  connectToAsset: (jmsUrl, keyId, secret, username, assetId, tabId, cols, rows) =>
    tauriAPI.connectToAsset(jmsUrl, keyId, secret, username, assetId, tabId, cols, rows),

  disconnectSSH: (tabId) =>
    tauriAPI.disconnectSSH(tabId),

  disconnectAllSSH: () =>
    tauriAPI.disconnectAllSSH(),

  // 发送终端输入（带 tabId）
  sendTerminalData: (tabId, data) =>
    tauriAPI.sendTerminalData(tabId, data),

  // 调整终端大小（带 tabId）
  sendTerminalResize: (tabId, cols, rows) =>
    tauriAPI.sendTerminalResize(tabId, cols, rows),

  // 监听终端数据（带 tabId 回传）
  onTerminalData: (callback) =>
    tauriAPI.onTerminalData(callback),

  // 监听 SSH 状态（带 tabId 回传）
  onSSHStatus: (callback) =>
    tauriAPI.onSSHStatus(callback),

  // ==================== 设置 ====================
  getSettings: () =>
    tauriAPI.getSettings(),

  saveSettings: (settings) =>
    tauriAPI.saveSettings(settings)
}
