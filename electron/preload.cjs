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

const invoke = (channel, ...args) => ipcRenderer.invoke(channel, ...args)

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
