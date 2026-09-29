'use strict'

/**
 * Opennote 预加载脚本。
 *
 * 必须是 CommonJS（.cjs）：sandbox: true 时 Electron 不支持 ESM preload。
 * 这里只做一件事——把 ipcRenderer.invoke 包装成 window.opennote，
 * 方法名/参数顺序/返回类型必须与渲染进程的 OpennoteBridge 接口严格一致。
 */

const { contextBridge, ipcRenderer } = require('electron')

const MENU_CHANNEL = 'opennote:menu'
const VERSION_CHANNEL = 'opennote:app:version'
/** D11 关窗握手：主进程请求落盘 / 渲染层确认落盘完成。 */
const FLUSH_REQUEST_CHANNEL = 'opennote:app:request-flush'
const FLUSH_DONE_CHANNEL = 'opennote:app:flush-done'
/** D08 工作区外部变更（去抖后由主进程广播）。 */
const WORKSPACE_CHANGED_CHANNEL = 'opennote:fs:workspace-changed'

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

/** 订阅一个主进程频道，返回退订函数（与 onMenu 同一套写法）。 */
function subscribe(channel, callback) {
  if (typeof callback !== 'function') return () => {}
  const listener = (_event, payload) => {
    callback(payload)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

/**
 * app.getVersion() 只能在主进程读取，而版本号必须是同步可用的属性，
 * 所以这里用 sendSync 在页面脚本执行前取一次（主进程已提前注册该频道）。
 */
function readAppVersion() {
  try {
    const version = ipcRenderer.sendSync(VERSION_CHANNEL)
    if (typeof version === 'string' && version !== '') return version
  } catch {
    /* 忽略：回退到 Electron 版本号 */
  }
  return (process.versions && process.versions.electron) || ''
}

const bridge = {
  isElectron: true,
  platform: (process && process.platform) || '',
  version: readAppVersion(),

  fs: {
    list: (root, relPath) => invoke('opennote:fs:list', root, relPath),
    readText: (root, relPath) => invoke('opennote:fs:readText', root, relPath),
    readBytes: (root, relPath) => invoke('opennote:fs:readBytes', root, relPath),
    writeText: (root, relPath, text) => invoke('opennote:fs:writeText', root, relPath, text),
    writeBytes: (root, relPath, data) => invoke('opennote:fs:writeBytes', root, relPath, data),
    mkdir: (root, relPath) => invoke('opennote:fs:mkdir', root, relPath),
    remove: (root, relPath, options) => invoke('opennote:fs:remove', root, relPath, options),
    move: (root, from, to) => invoke('opennote:fs:move', root, from, to),
    exists: (root, relPath) => invoke('opennote:fs:exists', root, relPath),
    stat: (root, relPath) => invoke('opennote:fs:stat', root, relPath),
    /** D20：把「最近工作区」里的路径重新登记为会话授权；主进程只认自己的持久列表。 */
    authorizeRoot: (root) => invoke('opennote:fs:authorizeRoot', root),
    /** D08：监听/取消监听已授权工作区（外部改动去抖通知）。 */
    watchWorkspace: (root) => invoke('opennote:fs:watchWorkspace', root),
    unwatchWorkspace: (root) => invoke('opennote:fs:unwatchWorkspace', root),
    onWorkspaceChanged: (callback) => subscribe(WORKSPACE_CHANGED_CHANNEL, callback),
  },

  dialog: {
    pickFolder: () => invoke('opennote:dialog:pickFolder'),
    pickSaveFile: (options) => invoke('opennote:dialog:pickSaveFile', options),
    saveFile: (absolutePath, data) => invoke('opennote:dialog:saveFile', absolutePath, data),
  },

  shell: {
    showItemInFolder: (absolutePath) => invoke('opennote:shell:showItemInFolder', absolutePath),
    openExternal: (url) => invoke('opennote:shell:openExternal', url),
  },

  app: {
    getRecentWorkspaces: () => invoke('opennote:app:getRecentWorkspaces'),
    addRecentWorkspace: (absolutePath) => invoke('opennote:app:addRecentWorkspace', absolutePath),
    /** D11：主进程请求关窗前落盘，返回退订函数。 */
    onFlushRequest: (callback) => subscribe(FLUSH_REQUEST_CHANNEL, callback),
    /** D11：落盘完成，允许主进程继续关窗。 */
    flushDone: () => {
      ipcRenderer.send(FLUSH_DONE_CHANNEL)
    },
  },

  window: {
    /** 同步无边框标题栏上那三个原生按钮的底色与符号色（macOS 返回 false）。 */
    setTitleBarOverlay: (colors) => invoke('opennote:window:titlebar', colors),
  },

  /** 订阅主进程菜单命令，返回取消订阅函数。 */
  onMenu(callback) {
    if (typeof callback !== 'function') return () => {}
    const listener = (_event, command) => {
      callback(command)
    }
    ipcRenderer.on(MENU_CHANNEL, listener)
    return () => {
      ipcRenderer.removeListener(MENU_CHANNEL, listener)
    }
  },
}

contextBridge.exposeInMainWorld('opennote', bridge)
