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
/**
 * 导入与本地桥。命名一律 `opennote:<group>:<op>`，**只追加、不改既有频道名**。
 * 方法名与参数个数由 `scripts/ipc-safety-check.cjs` 冻结，改动会让护栏变红。
 */
const BRIDGE_STATUS_CHANNEL = 'opennote:bridge:status'
const BRIDGE_START_CHANNEL = 'opennote:bridge:start'
const BRIDGE_STOP_CHANNEL = 'opennote:bridge:stop'
const BRIDGE_NEW_TOKEN_CHANNEL = 'opennote:bridge:newToken'
const BRIDGE_NEW_PAIR_CODE_CHANNEL = 'opennote:bridge:newPairCode'
const BRIDGE_REMOVE_ORIGIN_CHANNEL = 'opennote:bridge:removeOrigin'
const BRIDGE_OPEN_LOG_CHANNEL = 'opennote:bridge:openLog'
const BRIDGE_SET_LOG_ENABLED_CHANNEL = 'opennote:bridge:setLogEnabled'
const IMPORT_RECENT_CHANNEL = 'opennote:import:recent'
const IMPORT_UNDO_CHANNEL = 'opennote:import:undo'
const IMPORT_LOG_CHANNEL = 'opennote:import:log'
const INBOX_LIST_CHANNEL = 'opennote:inbox:list'
const INBOX_COMMIT_CHANNEL = 'opennote:inbox:commit'
const INBOX_DISCARD_CHANNEL = 'opennote:inbox:discard'
/** 入库完成后主进程广播（`deduped`/`duplicate`/`skipped` 不发）。 */
const IMPORT_NOTICE_CHANNEL = 'opennote:import:notice'
/** 收件箱目录变化。`.opennote/**` 被工作区 watcher 跳过，故这是独立 watcher。 */
const INBOX_CHANGED_CHANNEL = 'opennote:inbox:changed'
/**
 * 主进程 → 渲染层的落盘转交。
 *
 * 为什么需要它：桥只做「传输 + 安全校验」，信封落盘必须回到渲染层——渲染层才是
 * 工作区状态的唯一持有者，主进程直接写正文会被 `rescanWorkspace()` 起始的
 * `flushAll()` 覆盖。收件箱的入库/丢弃/列表同理，只有一份实现（`src/data/inbox.ts`）。
 *
 * `opennote:import:receipt` 专用于信封（契约 §10 命名），`opennote:import:request`
 * 用于其余操作；两者共用一条回执频道，靠 `reqId` 配对。
 */
const IMPORT_RECEIPT_CHANNEL = 'opennote:import:receipt'
const IMPORT_REQUEST_CHANNEL = 'opennote:import:request'
const IMPORT_REPLY_CHANNEL = 'opennote:import:reply'

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

  /**
   * 本地桥的控制面。设置面板读桥状态**只经 IPC**——绝不为了它放开
   * CSP `connect-src`，页面也不会去 fetch 本地 HTTP。
   */
  bridge: {
    status: () => invoke(BRIDGE_STATUS_CHANNEL),
    start: (options) => invoke(BRIDGE_START_CHANNEL, options),
    stop: () => invoke(BRIDGE_STOP_CHANNEL),
    /** 唯一一次返回令牌明文；主进程只存 sha256 与后四位。 */
    newToken: (options) => invoke(BRIDGE_NEW_TOKEN_CHANNEL, options),
    newPairCode: () => invoke(BRIDGE_NEW_PAIR_CODE_CHANNEL),
    removeOrigin: (options) => invoke(BRIDGE_REMOVE_ORIGIN_CHANNEL, options),
    openLog: () => invoke(BRIDGE_OPEN_LOG_CHANNEL),
    // R8「记录本地接口日志」：开关的真实行为在主进程（决定是否往 bridge.log 落行）。
    setLogEnabled: (options) => invoke(BRIDGE_SET_LOG_ENABLED_CHANNEL, options),
  },

  /** 导入查询、撤销与收件箱操作。 */
  import: {
    recent: (options) => invoke(IMPORT_RECENT_CHANNEL, options),
    undo: (options) => invoke(IMPORT_UNDO_CHANNEL, options),
    log: (options) => invoke(IMPORT_LOG_CHANNEL, options),
    inboxList: () => invoke(INBOX_LIST_CHANNEL),
    inboxCommit: (options) => invoke(INBOX_COMMIT_CHANNEL, options),
    inboxDiscard: (options) => invoke(INBOX_DISCARD_CHANNEL, options),
    /**
     * 回执一次主进程转交（信封或收件箱操作）。必须与 reqId 一一对应，
     * 且 outcome 要能 JSON 序列化——主进程把抛出的异常退化成字符串，
     * 所以这里传的是 `{ ok:true, result }` 或 `{ ok:false, error }`。
     */
    replyToImport: (reqId, outcome) => {
      ipcRenderer.send(IMPORT_REPLY_CHANNEL, { reqId, outcome })
    },
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

  /** 入库完成后主进程的通知（`deduped`/`duplicate`/`skipped` 不发）。 */
  onImportNotice: (callback) => subscribe(IMPORT_NOTICE_CHANNEL, callback),

  /** 收件箱目录变化（独立 watcher，去抖 450ms）；浏览器后端下不可用。 */
  onInboxChanged: (callback) => subscribe(INBOX_CHANGED_CHANNEL, callback),

  /**
   * 本地桥转交来的信封：回调收到 `{ reqId, envelope, client }`，
   * 必须用 `import.replyToImport(reqId, outcome)` 回执。
   */
  onImportReceipt: (callback) => subscribe(IMPORT_RECEIPT_CHANNEL, callback),

  /**
   * 主进程转交的导入/收件箱操作：回调收到 `{ reqId, op, args }`，
   * 同样用 `import.replyToImport(reqId, outcome)` 回执。
   */
  onImportRequest: (callback) => subscribe(IMPORT_REQUEST_CHANNEL, callback),
}

contextBridge.exposeInMainWorld('opennote', bridge)
