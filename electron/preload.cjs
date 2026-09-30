'use strict'

/**
 * Opennote 预加载脚本。
 *
 * 必须是 CommonJS（.cjs）：sandbox: true 时 Electron 不支持 ESM preload。
 * 这里只做一件事——把 ipcRenderer.invoke 包装成 window.opennote，
 * 方法名/参数顺序/返回类型必须与渲染进程的 OpennoteBridge 接口严格一致。
 */

const { contextBridge, ipcRenderer } = require('electron')

/**
 * 原生菜单命令（`opennote:menu`）**已删除**，不是漏发。
 *
 * `main.cjs` 的 `installApplicationMenu()` 在非 darwin 上 `Menu.setApplicationMenu(null)`，
 * darwin 上只有纯 role 的最小菜单，注释写明「不额外增加自定义项」——菜单栏是被**故意移除**的。
 * 所以 preload 这里原来那个 `onMenu` 订阅**听了没人发**（`verify-contract.cjs` 的 C-12c
 * 死订阅判据咬的就是这一条）。
 *
 * **若将来恢复原生菜单，这里是接入点**：主进程用 `webContents.send` 往这个频道发命令，
 * preload 用上面那个 `subscribe` 订阅并暴露给渲染层，`src/App.tsx` 里重建命令映射表。
 * 三处要一起加，只加一处就是「配对只守一半」。
 */
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
const BRIDGE_REMOVE_ORIGIN_CHANNEL = 'opennote:bridge:removeOrigin'
const BRIDGE_OPEN_LOG_CHANNEL = 'opennote:bridge:openLog'
const BRIDGE_SET_LOG_ENABLED_CHANNEL = 'opennote:bridge:setLogEnabled'
const BRIDGE_SET_INBOX_MODE_CHANNEL = 'opennote:bridge:setInboxMode'
/** ㊲ 只读取回当前令牌明文（绝不轮换）。 */
const BRIDGE_TOKEN_CHANNEL = 'opennote:bridge:token'
/** `opennote://` 深链（main 侧由 electron/deeplink.cjs 定义同一个字符串）。 */
const DEEPLINK_CHANNEL = 'opennote:app:deeplink'
const IMPORT_RECENT_CHANNEL = 'opennote:import:recent'
const IMPORT_UNDO_CHANNEL = 'opennote:import:undo'
const IMPORT_LOG_CHANNEL = 'opennote:import:log'
const INBOX_LIST_CHANNEL = 'opennote:inbox:list'
const INBOX_COMMIT_CHANNEL = 'opennote:inbox:commit'
const INBOX_DISCARD_CHANNEL = 'opennote:inbox:discard'
/** 入库完成后的 `opennote:import:notice` 广播**已删除**（同上：主进程从未发过它）。
 * 它想做的那三件事都已经各有产地，逐条比对见 `docs/import/00-项目简报与范围锁定.md`：
 *   ① 文件变化后重扫 → `opennote:fs:workspace-changed`（`library.ts:startWatching` → 去抖重扫）
 *   ② 收件箱计数与列表刷新 → `opennote:inbox:changed`（main.cjs 的独立 watcher，去抖 450ms）
 *   ③ 入库成功提示与撤销入口 → L2 的 `announce()`（`src/lib/clip/receive.ts`，唯一一份实现）
 * 只剩「自动打开刚入库的那条笔记」没有产地 —— 那是个**没人要求的功能**，不为了门禁变绿把它补上。 */
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

/** 订阅一个主进程频道，返回退订函数（与 `onDeepLink` / `onInboxChanged` 同一套写法）。 */
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
    /* 忽略：下面如实返回空串 */
  }
  // 读不到应用版本时**返回空串**，由界面显示「版本未知」。
  // 以前这里回退到 `process.versions.electron` —— 那是拿另一个数字冒充应用版本：
  // 用户会看到 "v38.4.5" 并以为那是 Opennote 的版本。**宁可显示未知，也不要拿别的数字冒充。**
  // 这与 `bridge.cjs` 的 APP_VERSION 是同一个原则：一个字段的含义不能被兜底改掉。
  return ''
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
    removeOrigin: (options) => invoke(BRIDGE_REMOVE_ORIGIN_CHANNEL, options),
    openLog: () => invoke(BRIDGE_OPEN_LOG_CHANNEL),
    // R8「记录本地接口日志」：开关的真实行为在主进程（决定是否往 bridge.log 落行）。
    setLogEnabled: (options) => invoke(BRIDGE_SET_LOG_ENABLED_CHANNEL, options),
    /**
     * 交付模式（00 号 §6.14㉕）：把 `ui.importConflict` 推给主进程，桥据此在
     * `/v1/health` 与 `/v1/workspace` 里如实回报 `inboxMode`。arity 1。
     */
    setInboxMode: (options) => invoke(BRIDGE_SET_INBOX_MODE_CHANNEL, options),
    /**
     * ㊲：取回**当前**令牌明文，用于「整窗重载后仍可复制」。**绝不轮换令牌**
     * （那是 newToken 的职责）。本会话不再持有时返回 null，绝不假装可用。arity 0。
     */
    token: () => invoke(BRIDGE_TOKEN_CHANNEL),
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

  /**
   * `opennote://` 深链（00 号 §6.14㉛ / 02 号 §5.6）。
   * payload 形如 `{ ok:true, kind:"settings", section:"import" }` 或
   * `{ ok:true, kind:"open", path:"剪藏/a.md" }`；**未实现/非法的链接不会走到这里**，
   * 由主进程用系统对话框如实告知（绝不静默）。arity 1。
   */
  onDeepLink: (callback) => subscribe(DEEPLINK_CHANNEL, callback),

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
