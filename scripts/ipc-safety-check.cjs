#!/usr/bin/env node
'use strict'

/**
 * Opennote 主进程 IPC 安全自测护栏（T3）。
 *
 * 用法：node scripts/ipc-safety-check.cjs [--keep] [--verbose]
 *
 * 做法：stub 掉 require('electron')，加载**真实的** electron/main.cjs，捕获它注册的
 * 全部 IPC handler 与窗口配置，然后直接调用这些 handler 断言安全行为。覆盖：
 *   D20 root 授权白名单 / addRecentWorkspace 门控 / saveFile 旁路封堵
 *   D29 remove('.') 等归一化写法不能删根目录
 *   D31 junction / 符号链接越界（读/写/stat/exists/list 全 handler）
 *   D35 回传错误不含宿主机绝对路径        D36 `:` / ADS 路径被拒
 *   D21 原子写无 .tmp 残留                D06 空目录回退 rmdir
 *   D38 CSP 只注入 file://，dev server 不注入
 *   D11 关窗握手（flush-done 放行 + 1.5s 超时兜底）
 *   D08 watchWorkspace 门控 + 去抖通知
 *   红线：webPreferences 不得放宽、preload 既有方法名/参数顺序不得改变
 *
 * 任何一项 FAIL 都会让进程以退出码 1 结束，可直接当回归测试跑。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { createHash } = require('node:crypto')

const REPO_ROOT = path.resolve(__dirname, '..')
const MAIN_PATH = path.join(REPO_ROOT, 'electron', 'main.cjs')
const PRELOAD_PATH = path.join(REPO_ROOT, 'electron', 'preload.cjs')

/** 与 electron/main.cjs 的 CSP 基线逐字一致（冻结契约 + Lead 裁决：仅 style/font 放行 jsdelivr）。 */
const BASE_CSP_SCRIPT_SRC = "script-src 'self' file:"
const EXPECTED_CSP =
  "default-src 'none'; " +
  `${BASE_CSP_SCRIPT_SRC}; ` +
  "style-src 'self' file: 'unsafe-inline' https://cdn.jsdelivr.net; " +
  "img-src 'self' file: data: blob:; " +
  "font-src 'self' file: data: https://cdn.jsdelivr.net; " +
  "connect-src 'self' file:; " +
  "media-src 'self' file: blob: data:; " +
  "object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self' blob:"

/** 内联脚本哈希会被追加进 script-src（桌面构建的启动脚本需要它）。 */
function expectedCsp(hashes = []) {
  return EXPECTED_CSP.replace(BASE_CSP_SCRIPT_SRC, `script-src ${["'self'", 'file:', ...hashes].join(' ')}`)
}

/** 计算内联脚本 hash：与主进程一致，先把换行归一成 LF（HTML 输入流预处理）。 */
function sha256OfScript(body) {
  return `'sha256-${createHash('sha256').update(body.replace(/\r\n?/g, '\n'), 'utf8').digest('base64')}'`
}

/** 不做换行归一化的原始 hash，用于证明 CRLF 场景取的是归一化后的值。 */
function sha256OfRawScript(body) {
  return `'sha256-${createHash('sha256').update(body, 'utf8').digest('base64')}'`
}

function inlineScriptHashesOf(html) {
  return [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1])
    .filter((body) => body.trim() !== '')
    .map((body) => sha256OfScript(body))
}

const EXISTING_FS_METHODS = ['list', 'readText', 'readBytes', 'writeText', 'writeBytes', 'mkdir', 'remove', 'move', 'exists', 'stat']
/** 绝对路径泄漏正则：盘符 / UNC / 常见 POSIX 家目录前缀。 */
const ABSOLUTE_PATH_PATTERN = /[A-Za-z]:[\\/]|\\\\[A-Za-z0-9._-]+[\\/]|\/(?:Users|home|root|tmp|var|etc|opt|mnt|media|private)\//
const UNNAUTHORIZED = '未授权的工作区目录'

const KEEP_TEMP = process.argv.includes('--keep')
const VERBOSE = process.argv.includes('--verbose')
/** 可选：拉起真实 Electron 做 D38 端到端验证（需要可用的桌面会话，默认不跑）。 */
const ELECTRON_PROBE = process.argv.includes('--with-electron-probe')

/**
 * 真实 Electron 探针源码（写到临时目录再执行）。不用模板字符串，方便内嵌。
 * 断言三件事：file:// 会触发 onHeadersReceived、hash 内联脚本放行而未授权的被挡、
 * http://127.0.0.1 dev server 不被注入。
 */
const ELECTRON_CSP_PROBE_SOURCE = String.raw`
'use strict'
const fs = require('node:fs')
const http = require('node:http')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { app, BrowserWindow, session } = require('electron')

const DIR = __dirname
app.setPath('userData', path.join(DIR, 'userData'))
const ALLOWED = 'window.__allowedRan=1;'
const BLOCKED = 'window.__blockedRan=1;'
const hash = 'sha256-' + createHash('sha256').update(ALLOWED, 'utf8').digest('base64')
const policy = "default-src 'none'; script-src 'self' file: '" + hash + "'; style-src 'self' 'unsafe-inline'"
const fileHtml =
  '<!doctype html><html><head><meta charset="utf-8"><script>' + ALLOWED + '</script><script>' + BLOCKED +
  '</script></head><body>ok</body></html>'
const httpHtml = '<!doctype html><html><head><meta charset="utf-8"><script>window.__httpInlineRan=1;</script></head><body>dev</body></html>'
fs.writeFileSync(path.join(DIR, 'page.html'), fileHtml, 'utf8')

const result = { injectedUrls: [], filePage: null, httpPage: null, consoles: [] }
let finished = false
function report(code, detail) {
  if (finished) return
  finished = true
  if (detail) result.error = detail
  try { fs.writeFileSync(path.join(DIR, 'result.json'), JSON.stringify(result), 'utf8') } catch (e) {}
  app.exit(code)
}
setTimeout(function () { result.timeout = true; report(2) }, 40000)

app.whenReady().then(async function () {
  try {
    session.defaultSession.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, function (details, callback) {
      result.injectedUrls.push(details.url)
      const headers = Object.assign({}, details.responseHeaders || {})
      headers['Content-Security-Policy'] = [policy]
      callback({ responseHeaders: headers })
    })
    function makeWindow() {
      const win = new BrowserWindow({
        show: false,
        webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, webSecurity: true },
      })
      win.webContents.on('console-message', function () {
        const details = arguments[0]
        const message =
          details && typeof details === 'object' && typeof details.message === 'string'
            ? details.message
            : String(arguments[2] || '')
        if (message) result.consoles.push(message.slice(0, 200))
      })
      return win
    }
    const fileWin = makeWindow()
    await fileWin.loadFile(path.join(DIR, 'page.html'))
    result.filePage = JSON.parse(
      await fileWin.webContents.executeJavaScript(
        'JSON.stringify({ url: location.href, allowedRan: window.__allowedRan === 1, blockedRan: window.__blockedRan === 1 })',
      ),
    )
    const server = http.createServer(function (_req, res) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(httpHtml)
    })
    await new Promise(function (resolve) { server.listen(0, '127.0.0.1', resolve) })
    const port = server.address().port
    const httpWin = makeWindow()
    await httpWin.loadURL('http://127.0.0.1:' + port + '/')
    result.httpPage = JSON.parse(
      await httpWin.webContents.executeJavaScript(
        'JSON.stringify({ url: location.href, inlineRan: window.__httpInlineRan === 1 })',
      ),
    )
    server.close()
    report(0)
  } catch (error) {
    report(1, String((error && error.name) + ': ' + (error && error.message)))
  }
})
`

let passCount = 0
let failCount = 0
let skipCount = 0
const failures = []
const mainLogs = []
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function section(title) {
  console.log(`\n── ${title} ──`)
}

async function check(name, fn) {
  try {
    const detail = await fn()
    passCount += 1
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    if (error && error.__skip) {
      skipCount += 1
      console.log(`  SKIP ${name} — ${error.message}`)
      return
    }
    failCount += 1
    failures.push(`${name}: ${error && error.message}`)
    console.log(`  FAIL ${name} — ${error && error.message}`)
  }
}

function skip(reason) {
  const error = new Error(reason)
  error.__skip = true
  throw error
}

/** 断言调用被拒绝，并可选校验错误信息。 */
async function expectReject(fn, messagePattern, label) {
  let result
  try {
    result = await fn()
  } catch (error) {
    const message = error && error.message ? error.message : String(error)
    if (messagePattern && !messagePattern.test(message)) {
      throw new Error(`拒绝信息不匹配：期望 ${messagePattern}，实际「${message}」`)
    }
    return message
  }
  throw new Error(`期望被拒绝，但成功返回 ${JSON.stringify(result)}${label ? `（${label}）` : ''}`)
}

function listFilesRecursive(dir) {
  const out = []
  const walk = (current) => {
    let entries
    try {
      entries = fs.readdirSync(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name)
      out.push(full)
      if (entry.isDirectory()) walk(full)
    }
  }
  walk(dir)
  return out
}

// ---------------------------------------------------------------------------
// Electron stub
// ---------------------------------------------------------------------------

function createHarness(options = {}) {
  const state = {
    userData: options.userData,
    handlers: new Map(),
    listeners: new Map(),
    windows: [],
    webRequestHandlers: [],
    openDialog: { canceled: true, filePaths: [] },
    saveDialog: { canceled: true, filePath: undefined },
    appEvents: new Map(),
    quitCalls: 0,
    openedExternal: [],
    shownInFolder: [],
    titleBarOverlay: [],
  }

  class FakeWebContents {
    constructor() {
      this.destroyed = false
      this.events = new Map()
      this.sent = []
      this.windowOpenHandler = null
    }
    on(event, handler) {
      const list = this.events.get(event) || []
      list.push(handler)
      this.events.set(event, list)
      return this
    }
    once(event, handler) {
      return this.on(event, handler)
    }
    emit(event, ...args) {
      for (const handler of [...(this.events.get(event) || [])]) handler(...args)
    }
    send(channel, ...args) {
      this.sent.push({ channel, args })
    }
    isDestroyed() {
      return this.destroyed
    }
    setWindowOpenHandler(handler) {
      this.windowOpenHandler = handler
    }
  }

  class FakeBrowserWindow {
    constructor(opts) {
      this.options = opts
      this.webContents = new FakeWebContents()
      this.events = new Map()
      this.destroyed = false
      this.closeCalls = 0
      this.destroyCalls = 0
      this.showCalls = 0
      state.windows.push(this)
    }
    on(event, handler) {
      const list = this.events.get(event) || []
      list.push(handler)
      this.events.set(event, list)
      return this
    }
    once(event, handler) {
      return this.on(event, handler)
    }
    emit(event, ...args) {
      for (const handler of [...(this.events.get(event) || [])]) handler(...args)
    }
    show() {
      this.showCalls += 1
    }
    isDestroyed() {
      return this.destroyed
    }
    close() {
      this.closeCalls += 1
      const event = {
        defaultPrevented: false,
        preventDefault() {
          this.defaultPrevented = true
        },
      }
      this.emit('close', event)
      if (!event.defaultPrevented) this.destroy()
    }
    destroy() {
      this.destroyCalls += 1
      if (this.destroyed) return
      this.destroyed = true
      this.webContents.destroyed = true
      this.emit('closed')
    }
    loadURL(url) {
      this.loadedUrl = url
      return Promise.resolve()
    }
    loadFile(file) {
      this.loadedFile = file
      return Promise.resolve()
    }
    getBounds() {
      return { width: 1280, height: 840 }
    }
    getContentBounds() {
      return { width: 1280, height: 800 }
    }
    setTitleBarOverlay(colors) {
      state.titleBarOverlay.push(colors)
    }
    static getFocusedWindow() {
      return null
    }
    static getAllWindows() {
      return state.windows.filter((window) => !window.isDestroyed())
    }
    static fromWebContents(contents) {
      return state.windows.find((window) => window.webContents === contents) || null
    }
  }

  const ipcMain = {
    handle(channel, handler) {
      state.handlers.set(channel, handler)
    },
    on(channel, handler) {
      const list = state.listeners.get(channel) || []
      list.push(handler)
      state.listeners.set(channel, list)
    },
    removeListener(channel, handler) {
      const list = state.listeners.get(channel) || []
      state.listeners.set(
        channel,
        list.filter((item) => item !== handler),
      )
    },
    emit(channel, ...args) {
      const sender = state.windows[0] ? state.windows[0].webContents : { send() {}, isDestroyed: () => false }
      for (const handler of [...(state.listeners.get(channel) || [])]) handler({ sender }, ...args)
    },
  }

  const app = {
    isPackaged: false,
    getAppPath: () => options.appRoot || REPO_ROOT,
    getVersion: () => '0.2.0-test',
    getPath: () => state.userData,
    setAppUserModelId() {},
    whenReady: () => Promise.resolve(),
    /**
     * 0.3.0 新增：`main.cjs` 用单实例锁把第二个实例挡掉，并注册 `opennote://` 协议
     * （00 号 §6.14㉛）。stub **必须**提供这两个 API —— 不然护栏会在 require
     * main.cjs 时直接抛异常，从而**静默跳过**其对 IPC 面的全部检查。
     * 这里返回 `true`（拿到锁）以保证护栏走的是正常启动分支。
     */
    requestSingleInstanceLock: () => true,
    setAsDefaultProtocolClient: () => true,
    on(event, handler) {
      const list = state.appEvents.get(event) || []
      list.push(handler)
      state.appEvents.set(event, list)
    },
    quit() {
      state.quitCalls += 1
    },
  }

  const dialog = {
    showOpenDialog: async () => state.openDialog,
    showSaveDialog: async () => state.saveDialog,
  }

  const session = {
    defaultSession: {
      webRequest: {
        onHeadersReceived(filter, listener) {
          state.webRequestHandlers.push({ filter, listener })
        },
      },
    },
  }

  const Menu = {
    setApplicationMenu() {},
    getApplicationMenu() {
      return null
    },
    buildFromTemplate: (template) => template,
  }

  const shell = {
    showItemInFolder(target) {
      state.shownInFolder.push(target)
    },
    openExternal: async (url) => {
      state.openedExternal.push(url)
    },
  }

  return {
    state,
    /** 模拟渲染层 → 主进程的 ipcMain.on 消息。 */
    emit: (channel, ...args) => ipcMain.emit(channel, ...args),
    electronStub: { app, BrowserWindow: FakeBrowserWindow, Menu, dialog, ipcMain, session, shell },
  }
}

function loadMainFresh(harness) {
  const resolved = require.resolve(MAIN_PATH)
  delete require.cache[resolved]
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return harness.electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    require(MAIN_PATH)
  } finally {
    Module._load = originalLoad
  }
}

/** 加载 main.cjs 并等到 whenReady 里的 handler 注册完成、窗口建好。 */
async function bootHarness(harness) {
  const originalLog = console.log
  const originalError = console.error
  const originalWarn = console.warn
  const capture = (...args) => {
    mainLogs.push(args.map((item) => (typeof item === 'string' ? item : String(item))).join(' '))
  }
  console.log = capture
  console.error = capture
  console.warn = capture
  try {
    loadMainFresh(harness)
    const deadline = Date.now() + 4000
    while (!harness.state.handlers.has('opennote:fs:authorizeRoot') && Date.now() < deadline) await delay(5)
    while (harness.state.windows.length === 0 && Date.now() < deadline) await delay(5)
    await delay(20)
    if (!harness.state.handlers.has('opennote:fs:authorizeRoot')) throw new Error('main.cjs 未在超时内注册 IPC handler')
    if (harness.state.windows.length === 0) throw new Error('main.cjs 未在超时内创建 BrowserWindow')
  } finally {
    console.log = originalLog
    console.error = originalError
    console.warn = originalWarn
  }
  return harness
}

function makeCaller(harness) {
  const fakeEvent = {
    sender: harness.state.windows[0] ? harness.state.windows[0].webContents : { send() {}, isDestroyed: () => false },
    returnValue: undefined,
  }
  return (channel, ...args) => {
    const handler = harness.state.handlers.get(channel)
    if (!handler) throw new Error(`未注册的 IPC handler：${channel}`)
    return handler(fakeEvent, ...args)
  }
}

// ---------------------------------------------------------------------------
// preload stub
// ---------------------------------------------------------------------------

function loadPreloadBridge() {
  const state = { exposed: null, listeners: new Map(), sent: [], sync: [], invoked: [] }
  const ipcRenderer = {
    invoke: async (channel, ...args) => {
      state.invoked.push({ channel, args })
      return undefined
    },
    sendSync: (channel) => {
      state.sync.push(channel)
      return '9.9.9-test'
    },
    send: (channel, ...args) => {
      state.sent.push({ channel, args })
    },
    on: (channel, listener) => {
      const list = state.listeners.get(channel) || []
      list.push(listener)
      state.listeners.set(channel, list)
    },
    removeListener: (channel, listener) => {
      const list = state.listeners.get(channel) || []
      state.listeners.set(
        channel,
        list.filter((item) => item !== listener),
      )
    },
  }
  const electronStub = {
    contextBridge: {
      exposeInMainWorld: (key, value) => {
        state.exposed = { key, value }
      },
    },
    ipcRenderer,
  }
  const resolved = require.resolve(PRELOAD_PATH)
  delete require.cache[resolved]
  const originalLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    require(PRELOAD_PATH)
  } finally {
    Module._load = originalLoad
  }
  return state
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  console.log('Opennote IPC 安全自测（stub electron + 真实 electron/main.cjs）')
  console.log(`node=${process.version} platform=${process.platform}`)

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-ipc-check-'))
  const userDataA = path.join(base, 'userData-a')
  const userDataC = path.join(base, 'userData-c')
  const ws = path.join(base, 'workspace')
  const outside = path.join(base, 'outside')
  const otherDir = path.join(base, 'other')
  fs.mkdirSync(userDataA, { recursive: true })
  fs.mkdirSync(userDataC, { recursive: true })
  fs.mkdirSync(ws, { recursive: true })
  fs.mkdirSync(outside, { recursive: true })
  fs.mkdirSync(otherDir, { recursive: true })
  fs.writeFileSync(path.join(ws, 'note.md'), '# 笔记\n第一行\n', 'utf8')
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'SECRET-OUTSIDE-ROOT', 'utf8')
  fs.writeFileSync(path.join(base, 'secret-outside.txt'), 'SECRET-PARENT-DIR', 'utf8')
  console.log(`临时目录：${base}${KEEP_TEMP ? '（--keep：不清理）' : ''}`)

  // ---------------------------------------------------------------- Harness A
  // appRoot 用一个不含 dist/index.html 的空目录：CSP 退化成冻结基线，断言确定。
  const emptyAppRoot = path.join(base, 'app-root-empty')
  fs.mkdirSync(emptyAppRoot, { recursive: true })
  const harnessA = await bootHarness(createHarness({ userData: userDataA, appRoot: emptyAppRoot }))
  const callA = makeCaller(harnessA)
  const stateA = harnessA.state

  section('D20 未授权 root：fs:* 全部拒绝')
  await check("readText(未授权 root) reject「未授权的工作区目录」", async () => {
    await expectReject(() => callA('opennote:fs:readText', outside, 'secret.txt'), new RegExp(UNNAUTHORIZED))
    return '拒绝信息正确'
  })
  await check('writeText(未授权 root) 拒绝且不落盘', async () => {
    await expectReject(() => callA('opennote:fs:writeText', outside, 'planted.md', 'ATTACKER'), new RegExp(UNNAUTHORIZED))
    assert.equal(fs.existsSync(path.join(outside, 'planted.md')), false, '文件不应被创建')
    return '无落盘'
  })
  await check('remove(未授权 root, ".", recursive) 拒绝且目录仍存在', async () => {
    await expectReject(() => callA('opennote:fs:remove', outside, '.', { recursive: true }), new RegExp(UNNAUTHORIZED))
    assert.equal(fs.existsSync(outside), true, 'outside 目录不应被删除')
    return '目录保留'
  })
  await check('list / stat / exists / mkdir / move 未授权 root 全部拒绝', async () => {
    await expectReject(() => callA('opennote:fs:list', outside, ''), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:stat', outside, 'secret.txt'), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:exists', outside, 'secret.txt'), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:mkdir', outside, 'newdir'), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:move', outside, 'secret.txt', 'moved.txt'), new RegExp(UNNAUTHORIZED))
    assert.equal(fs.existsSync(path.join(outside, 'newdir')), false)
    assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true)
    return '5 个 handler 全拒'
  })
  await check('writeBytes / readBytes / watchWorkspace 未授权 root 全部拒绝', async () => {
    await expectReject(() => callA('opennote:fs:writeBytes', outside, 'bytes.bin', new Uint8Array([1, 2, 3])), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:readBytes', outside, 'secret.txt'), new RegExp(UNNAUTHORIZED))
    await expectReject(() => callA('opennote:fs:watchWorkspace', outside), new RegExp(UNNAUTHORIZED))
    return '3 个 handler 全拒'
  })

  section('D20 正路：pickFolder 授权 + authorizeRoot')
  await check('pickFolder 返回工作区路径', async () => {
    stateA.openDialog = { canceled: false, filePaths: [ws] }
    const picked = await callA('opennote:dialog:pickFolder')
    assert.equal(picked, path.resolve(ws))
    return `picked=${picked}`
  })
  await check('授权后 list / readText / writeText 正常', async () => {
    const items = await callA('opennote:fs:list', ws, '')
    assert.ok(items.some((item) => item.name === 'note.md' && item.kind === 'file'), 'note.md 应出现')
    const text = await callA('opennote:fs:readText', ws, 'note.md')
    assert.match(text, /第一行/)
    await callA('opennote:fs:writeText', ws, 'written.md', 'hello')
    assert.equal(fs.readFileSync(path.join(ws, 'written.md'), 'utf8'), 'hello')
    return `entries=${items.length}`
  })
  await check('authorizeRoot 只认已信任的路径', async () => {
    assert.equal(await callA('opennote:fs:authorizeRoot', ws), true, '已授权 root 应为 true')
    assert.equal(await callA('opennote:fs:authorizeRoot', otherDir), false, '陌生目录应为 false')
    assert.equal(await callA('opennote:fs:authorizeRoot', 'not-absolute'), false)
    await expectReject(() => callA('opennote:fs:readText', otherDir, 'x.txt'), new RegExp(UNNAUTHORIZED))
    return 'authorizeRoot 不是任意路径后门'
  })
  await check('addRecentWorkspace 不能给任意路径授权', async () => {
    await expectReject(() => callA('opennote:app:addRecentWorkspace', otherDir), /未授权的工作区目录/)
    await expectReject(() => callA('opennote:fs:readText', otherDir, 'x.txt'), new RegExp(UNNAUTHORIZED))
    return '陌生目录被拒且未被登记'
  })
  await check('addRecentWorkspace(pickFolder 路径) 成功并写入 recent-workspaces.json', async () => {
    await callA('opennote:app:addRecentWorkspace', ws)
    const file = path.join(userDataA, 'recent-workspaces.json')
    assert.equal(fs.existsSync(file), true, 'recent-workspaces.json 应存在')
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    assert.deepEqual(parsed, [path.resolve(ws)])
    return `recent=${JSON.stringify(parsed)}`
  })

  section('D29 remove 的 "." 等归一化写法不能删根目录')
  await check('remove(root, ".", "./", ".//", ".\\\\", "././", "", undefined, null) 全部拒绝', async () => {
    const variants = ['.', './', './/', '.\\', '././', '', undefined, null]
    for (const variant of variants) {
      await expectReject(
        () => callA('opennote:fs:remove', ws, variant, { recursive: true }),
        /不能删除笔记本根目录/,
        `relPath=${JSON.stringify(variant)}`,
      )
    }
    assert.equal(fs.existsSync(ws), true, '工作区目录必须保留')
    assert.equal(fs.readFileSync(path.join(ws, 'note.md'), 'utf8').includes('第一行'), true, '正文必须保留')
    assert.equal(fs.existsSync(path.join(ws, 'written.md')), true)
    return `8 种写法全部拒绝`
  })
  await check('remove(root, "sub/..") 也被拒（.. 段词法校验仍在）', async () => {
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true })
    await expectReject(() => callA('opennote:fs:remove', ws, 'sub/..', { recursive: true }), /路径越界/)
    assert.equal(fs.existsSync(ws), true)
    return '路径越界'
  })

  section('D36 NTFS 备用数据流（ADS）')
  await check('writeText(root, "a.md:secret") 被拒且不产生文件', async () => {
    await expectReject(() => callA('opennote:fs:writeText', ws, 'a.md:secret', 'HIDDEN'), /路径无效/)
    assert.equal(fs.existsSync(path.join(ws, 'a.md:secret')), false)
    assert.equal(fs.existsSync(path.join(ws, 'a.md')), false, '不得创建 a.md 空壳')
    return '冒号路径被拒'
  })
  await check('readText / remove 的 ":" 路径同样被拒', async () => {
    await expectReject(() => callA('opennote:fs:readText', ws, 'note.md:secret'), /路径无效/)
    await expectReject(() => callA('opennote:fs:remove', ws, 'note.md:secret'), /路径无效/)
    return '一致拒绝'
  })

  section('D33 缺失路径文案与渲染层后端对齐（找不到：<relPath>）')
  await check('readText / readBytes / list 缺失时统一「找不到：<relPath>」', async () => {
    for (const [channel, relPath] of [
      ['opennote:fs:readText', '缺失.md'],
      ['opennote:fs:readBytes', '缺失.md'],
      ['opennote:fs:list', '缺失目录'],
    ]) {
      const message = await expectReject(() => callA(channel, ws, relPath), undefined, channel)
      assert.equal(message, `找不到：${relPath}`, `${channel} 文案应为「找不到：${relPath}」，实际「${message}」`)
    }
    return '三条文案逐字一致'
  })
  await check('stat 缺失仍返回 null，exists 缺失仍返回 false（语义不动）', async () => {
    assert.equal(await callA('opennote:fs:stat', ws, '缺失.md'), null)
    assert.equal(await callA('opennote:fs:exists', ws, '缺失.md'), false)
    return 'null / false'
  })
  await check('非缺失 errno 仍走「读取失败：<relPath>（code）」', async () => {
    fs.mkdirSync(path.join(ws, '目录不可读'), { recursive: true })
    const message = await expectReject(() => callA('opennote:fs:readText', ws, '目录不可读'), /^读取失败：目录不可读（/)
    assert.equal(ABSOLUTE_PATH_PATTERN.test(message), false)
    return `message=「${message}」`
  })

  section('相对路径穿越防护未削弱（回归）')
  await check('"../" 系列不能读到工作区外的文件', async () => {
    const attempts = ['../secret-outside.txt', '..\\secret-outside.txt', 'a/../../secret-outside.txt']
    for (const rel of attempts) {
      const message = await expectReject(() => callA('opennote:fs:readText', ws, rel), /路径越界/, rel)
      assert.ok(!/SECRET-PARENT-DIR/.test(message))
    }
    return '3 种写法全部路径越界'
  })
  await check('绝对路径 / 盘符 / UNC / NUL 全部拒绝', async () => {
    const attempts = ['C:\\Windows\\win.ini', 'C:ws', 'c:/x', '//server/share/x', 'a\0b.md', path.join(base, 'secret-outside.txt')]
    for (const rel of attempts) {
      await expectReject(() => callA('opennote:fs:readText', ws, rel), undefined, rel)
    }
    return `${attempts.length} 种写法全部拒绝`
  })
  await check('%2e%2e/x 与 ....//x 不构成逃逸', async () => {
    for (const rel of ['%2e%2e/secret-outside.txt', '....//secret-outside.txt']) {
      const message = await expectReject(() => callA('opennote:fs:readText', ws, rel), undefined, rel)
      assert.ok(!/SECRET-PARENT-DIR|SECRET-OUTSIDE-ROOT/.test(message), '不得读到工作区外内容')
    }
    return '按普通文件名处理，未逃逸'
  })

  section('D31 junction / 符号链接越界')
  const junction = path.join(ws, 'junction-out')
  let junctionReady = false
  try {
    fs.symlinkSync(outside, junction, 'junction')
    junctionReady = true
  } catch (error) {
    junctionReady = false
  }
  await check('readText 经 junction 读工作区外文件被拒', async () => {
    if (!junctionReady) skip('本机无法创建 junction（需要权限或平台不支持）')
    await expectReject(() => callA('opennote:fs:readText', ws, 'junction-out/secret.txt'), /路径越界/)
    return '拒绝越界读'
  })
  await check('writeText 经 junction 写工作区外文件被拒且不落盘', async () => {
    if (!junctionReady) skip('本机无法创建 junction')
    await expectReject(() => callA('opennote:fs:writeText', ws, 'junction-out/planted.md', 'ATTACKER'), /路径越界/)
    assert.equal(fs.existsSync(path.join(outside, 'planted.md')), false, '工作区外不得出现文件')
    return '拒绝越界写'
  })
  await check('list / stat / exists 经 junction 一律被拒', async () => {
    if (!junctionReady) skip('本机无法创建 junction')
    await expectReject(() => callA('opennote:fs:list', ws, 'junction-out'), /路径越界/)
    await expectReject(() => callA('opennote:fs:stat', ws, 'junction-out/secret.txt'), /路径越界/)
    await expectReject(() => callA('opennote:fs:exists', ws, 'junction-out/secret.txt'), /路径越界/)
    await expectReject(() => callA('opennote:fs:remove', ws, 'junction-out/secret.txt', { recursive: false }), /路径越界/)
    assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true, '链接目标不得被删')
    return '4 个 handler 全拒'
  })
  await check('list(工作区) 仍不列出目录链接（既有行为）', async () => {
    if (!junctionReady) skip('本机无法创建 junction')
    const items = await callA('opennote:fs:list', ws, '')
    assert.ok(!items.some((item) => item.name === 'junction-out'), '目录链接不应出现在列表里')
    return '列表已跳过'
  })
  await check('把链接本身当写入目标（link 在最后一段）也被拒，且不在工作区外留临时文件', async () => {
    if (!junctionReady) skip('本机无法创建 junction')
    const before = fs.readdirSync(outside).sort()
    await expectReject(() => callA('opennote:fs:writeText', ws, 'junction-out', 'ATTACKER'), /路径越界/)
    await expectReject(() => callA('opennote:fs:writeBytes', ws, 'junction-out', new Uint8Array([1])), /路径越界/)
    assert.deepEqual(fs.readdirSync(outside).sort(), before, '链接目标目录不得被写入任何文件（含 .tmp）')
    return '写入目标自身也做 realpath 校验'
  })
  await check('remove(junction 本身) 只删链接，不动链接目标', async () => {
    if (!junctionReady) skip('本机无法创建 junction')
    await callA('opennote:fs:remove', ws, 'junction-out', { recursive: true })
    assert.equal(fs.existsSync(junction), false, '链接本身应被删除')
    assert.equal(fs.existsSync(path.join(outside, 'secret.txt')), true, '链接目标内容必须保留')
    assert.equal(fs.readdirSync(outside).length, 1, '目标目录不应被清空')
    return '仅删链接'
  })
  // 文件级符号链接：只查父目录会漏掉「文件名本身是链接」的写入越界。
  const innerReal = path.join(ws, 'real-inner.md')
  const innerLink = path.join(ws, 'link-inner.md')
  const outerLink = path.join(ws, 'link-out.md')
  const outerTarget = path.join(outside, 'secret-target.txt')
  fs.writeFileSync(innerReal, 'inner', 'utf8')
  fs.writeFileSync(outerTarget, 'OUTSIDE-TARGET', 'utf8')
  let fileLinkReady = true
  try {
    fs.symlinkSync(innerReal, innerLink, 'file')
    fs.symlinkSync(outerTarget, outerLink, 'file')
  } catch {
    fileLinkReady = false
  }
  await check('文件符号链接指向工作区外：读/写/exists 全部被拒', async () => {
    if (!fileLinkReady) skip('本机无法创建文件符号链接（Windows 需开发者模式/管理员）')
    await expectReject(() => callA('opennote:fs:readText', ws, 'link-out.md'), /路径越界/)
    await expectReject(() => callA('opennote:fs:writeText', ws, 'link-out.md', 'ATTACKER'), /路径越界/)
    await expectReject(() => callA('opennote:fs:exists', ws, 'link-out.md'), /路径越界/)
    assert.equal(fs.readFileSync(outerTarget, 'utf8'), 'OUTSIDE-TARGET', '链接目标不得被改写')
    const strayTemps = listFilesRecursive(outside).filter((file) => file.endsWith('.tmp'))
    assert.deepEqual(strayTemps, [], `工作区外不得出现临时文件：${strayTemps.join(', ')}`)
    return '拒绝越界读写'
  })
  await check('文件符号链接指向工作区内：写链接 = 写它指向的文件（语义保持）', async () => {
    if (!fileLinkReady) skip('本机无法创建文件符号链接')
    assert.equal(await callA('opennote:fs:readText', ws, 'link-inner.md'), 'inner')
    await callA('opennote:fs:writeText', ws, 'link-inner.md', 'inner-v2')
    assert.equal(fs.readFileSync(innerReal, 'utf8'), 'inner-v2', '应写入链接指向的真实文件')
    assert.equal(fs.lstatSync(innerLink).isSymbolicLink(), true, '链接本身不应被替换成普通文件')
    return '写透链接'
  })
  await check('writeText(root, "") 被拒且不在工作区外留下临时文件', async () => {
    await expectReject(() => callA('opennote:fs:writeText', ws, '', 'x'), /不能写入笔记本根目录/)
    const strayTemps = fs.readdirSync(base).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(strayTemps, [], `工作区外不得出现临时文件：${strayTemps.join(', ')}`)
    return '根目录不可写'
  })

  section('D21 原子写（临时文件 + rename）')
  await check('writeText 覆盖写 + writeBytes 后目录内无 .tmp 残留', async () => {
    await callA('opennote:fs:writeText', ws, 'atomic.md', 'v1')
    await callA('opennote:fs:writeText', ws, 'atomic.md', 'v2-覆盖')
    assert.equal(fs.readFileSync(path.join(ws, 'atomic.md'), 'utf8'), 'v2-覆盖')
    await callA('opennote:fs:writeBytes', ws, 'bytes.bin', new Uint8Array([1, 2, 3, 4]))
    const bytes = await callA('opennote:fs:readBytes', ws, 'bytes.bin')
    assert.deepEqual(Array.from(bytes), [1, 2, 3, 4])
    const leftovers = listFilesRecursive(ws).filter((file) => file.endsWith('.tmp'))
    assert.deepEqual(leftovers, [], `不应有临时文件残留：${leftovers.join(', ')}`)
    return '无 .tmp 残留'
  })
  await check('写入嵌套新目录同样原子且不留 .tmp', async () => {
    await callA('opennote:fs:writeText', ws, 'a/b/c/deep.md', 'deep')
    assert.equal(fs.readFileSync(path.join(ws, 'a', 'b', 'c', 'deep.md'), 'utf8'), 'deep')
    const leftovers = listFilesRecursive(ws).filter((file) => file.endsWith('.tmp'))
    assert.deepEqual(leftovers, [])
    return '嵌套目录 OK'
  })

  section('D06 删除空目录回退 rmdir')
  await check('remove(空目录) 不传 recursive 也能成功', async () => {
    await callA('opennote:fs:mkdir', ws, '空目录')
    assert.equal(fs.existsSync(path.join(ws, '空目录')), true)
    await callA('opennote:fs:remove', ws, '空目录')
    assert.equal(fs.existsSync(path.join(ws, '空目录')), false)
    return 'rmdir 回退生效'
  })
  await check('remove(非空目录) 不传 recursive 仍报错且不删', async () => {
    await callA('opennote:fs:mkdir', ws, '非空')
    await callA('opennote:fs:writeText', ws, '非空/a.md', 'x')
    await expectReject(() => callA('opennote:fs:remove', ws, '非空'), /删除失败/)
    assert.equal(fs.existsSync(path.join(ws, '非空', 'a.md')), true)
    await callA('opennote:fs:remove', ws, '非空', { recursive: true })
    assert.equal(fs.existsSync(path.join(ws, '非空')), false)
    return '先报错后递归删除成功'
  })
  await check('remove(不存在的路径) 幂等成功（force）', async () => {
    await callA('opennote:fs:remove', ws, '根本没有这个文件.md', { recursive: true })
    await callA('opennote:fs:remove', ws, '没有这个目录')
    return '幂等'
  })

  section('D20 saveFile 旁路封堵')
  await check('未 pickSaveFile 的任意绝对路径不可写', async () => {
    const target = path.join(outside, 'saved.md')
    await expectReject(() => callA('opennote:dialog:saveFile', target, 'ATTACKER'), /未授权的保存位置/)
    assert.equal(fs.existsSync(target), false, '不得创建文件')
    await expectReject(() => callA('opennote:dialog:saveFile', 'relative.md', 'x'), /路径无效/)
    return '拒绝写入'
  })
  await check('pickSaveFile 后的路径可写', async () => {
    const target = path.join(outside, 'saved.md')
    stateA.saveDialog = { canceled: false, filePath: target }
    const picked = await callA('opennote:dialog:pickSaveFile', { defaultName: 'saved.md' })
    assert.equal(picked, path.resolve(target))
    assert.equal(await callA('opennote:dialog:saveFile', picked, 'ok-content'), true)
    assert.equal(fs.readFileSync(target, 'utf8'), 'ok-content')
    return '写入成功'
  })
  await check('saveFile 只认自己 pick 过的路径（另一个路径仍被拒）', async () => {
    await expectReject(() => callA('opennote:dialog:saveFile', path.join(outside, 'other.md'), 'x'), /未授权的保存位置/)
    assert.equal(fs.existsSync(path.join(outside, 'other.md')), false)
    return '门控按路径生效'
  })

  section('D08 工作区监听（去抖通知）')
  await check('watchWorkspace 未授权 root 被拒 / 授权 root 返回 true', async () => {
    await expectReject(() => callA('opennote:fs:watchWorkspace', otherDir), new RegExp(UNNAUTHORIZED))
    assert.equal(await callA('opennote:fs:watchWorkspace', ws), true)
    return '门控正确'
  })
  await check('外部写入后收到去抖的 workspace-changed 通知', async () => {
    const contents = stateA.windows[0].webContents
    const before = contents.sent.filter((item) => item.channel === 'opennote:fs:workspace-changed').length
    fs.writeFileSync(path.join(ws, 'external-change.md'), 'from outside', 'utf8')
    const deadline = Date.now() + 3000
    let events = []
    while (Date.now() < deadline) {
      events = contents.sent.filter((item) => item.channel === 'opennote:fs:workspace-changed')
      if (events.length > before) break
      await delay(25)
    }
    assert.ok(events.length > before, '应收到 workspace-changed')
    const sameRoot = events.filter((item) => item.args[0] === path.resolve(ws)).length
    assert.ok(sameRoot >= 1, 'payload 应为工作区绝对路径')
    assert.equal(contents.sent.filter((item) => item.channel === 'opennote:fs:workspace-changed').length - before, 1, '一次改动只通知一次（去抖）')
    return `收到 ${events.length - before} 次通知`
  })
  await check('unwatchWorkspace 生效（不再通知）', async () => {
    assert.equal(await callA('opennote:fs:unwatchWorkspace', ws), true)
    assert.equal(await callA('opennote:fs:unwatchWorkspace', ws), false, '重复取消返回 false')
    const contents = stateA.windows[0].webContents
    const before = contents.sent.filter((item) => item.channel === 'opennote:fs:workspace-changed').length
    fs.writeFileSync(path.join(ws, 'external-change-2.md'), 'again', 'utf8')
    await delay(900)
    const after = contents.sent.filter((item) => item.channel === 'opennote:fs:workspace-changed').length
    assert.equal(after, before, '取消监听后不应再有通知')
    return '已停止'
  })

  section('D38 CSP（只注入 file://）')
  await check('注册了 file:// 过滤的 onHeadersReceived', async () => {
    assert.equal(stateA.webRequestHandlers.length, 1, '应恰好注册一个 CSP 监听')
    assert.deepEqual(stateA.webRequestHandlers[0].filter, { urls: ['file://*/*'] })
    return JSON.stringify(stateA.webRequestHandlers[0].filter)
  })
  await check('file:// 响应注入冻结的 CSP 策略', async () => {
    const { listener } = stateA.webRequestHandlers[0]
    let captured
    listener({ url: 'file:///E:/repo/opennote/dist/index.html', responseHeaders: { 'Content-Type': ['text/html'] } }, (result) => {
      captured = result
    })
    assert.ok(captured, 'callback 必须被调用')
    assert.deepEqual(captured.responseHeaders['Content-Security-Policy'], [EXPECTED_CSP])
    assert.deepEqual(captured.responseHeaders['Content-Type'], ['text/html'], '其它响应头必须保留')
    return EXPECTED_CSP.slice(0, 48) + '…'
  })
  await check('CSP 中 script-src / connect-src / default-src 不含 cdn.jsdelivr.net', async () => {
    assert.equal(/script-src[^;]*cdn\.jsdelivr/.test(EXPECTED_CSP), false)
    assert.equal(/connect-src[^;]*cdn\.jsdelivr/.test(EXPECTED_CSP), false)
    assert.equal(/default-src[^;]*cdn\.jsdelivr/.test(EXPECTED_CSP), false)
    assert.equal(/style-src[^;]*cdn\.jsdelivr/.test(EXPECTED_CSP), true, 'style-src 应放行霞鹜文楷 CDN')
    assert.equal(/font-src[^;]*cdn\.jsdelivr/.test(EXPECTED_CSP), true, 'font-src 应放行霞鹜文楷 CDN')
    return '仅 style/font 例外'
  })
  await check('dev server（http://127.0.0.1:5173）不注入 CSP', async () => {
    const { listener } = stateA.webRequestHandlers[0]
    let captured
    listener({ url: 'http://127.0.0.1:5173/src/main.tsx', responseHeaders: { 'Content-Type': ['text/javascript'] } }, (result) => {
      captured = result
    })
    assert.ok(captured)
    const keys = Object.keys(captured.responseHeaders || {}).map((key) => key.toLowerCase())
    assert.equal(keys.includes('content-security-policy'), false, 'dev 响应绝不能带 CSP')
    return 'HMR 不受影响'
  })
  await check('已有 CSP 头会被替换而不是叠加', async () => {
    const { listener } = stateA.webRequestHandlers[0]
    let captured
    listener(
      { url: 'file:///tmp/index.html', responseHeaders: { 'content-security-policy': ["default-src 'self'"], 'X-Other': ['1'] } },
      (result) => {
        captured = result
      },
    )
    const cspKeys = Object.keys(captured.responseHeaders).filter((key) => key.toLowerCase() === 'content-security-policy')
    assert.equal(cspKeys.length, 1, '同名头只能有一个')
    assert.deepEqual(captured.responseHeaders[cspKeys[0]], [EXPECTED_CSP])
    assert.deepEqual(captured.responseHeaders['X-Other'], ['1'])
    return '替换成功'
  })
  await check('桌面构建的内联启动脚本用 sha256 放行（不用 unsafe-inline）', async () => {
    // 造一个 appRoot/dist/index.html：1 个内联脚本 + 1 个外链脚本 + 1 个空内联脚本。
    const appRoot = path.join(base, 'app-root-inline')
    fs.mkdirSync(path.join(appRoot, 'dist'), { recursive: true })
    // 内联脚本故意用 CRLF：验证哈希按 HTML 解析后的 LF 文本计算。
    const inlineBody = 'window.__inline_boot_check__=1;\r\nvar second=2;\r\n'
    const html =
      '<!doctype html><html><head>\n' +
      `<script>${inlineBody}</script>\n` +
      '<script type="module" src="./assets/index-abc.js"></script>\n' +
      '<script></script>\n' +
      '</head><body></body></html>'
    fs.writeFileSync(path.join(appRoot, 'dist', 'index.html'), html, 'utf8')
    const harnessG = await bootHarness(createHarness({ userData: userDataC, appRoot }))
    const { listener } = harnessG.state.webRequestHandlers[0]
    let captured
    listener({ url: 'file:///app/dist/index.html', responseHeaders: {} }, (result) => {
      captured = result
    })
    const policy = captured.responseHeaders['Content-Security-Policy'][0]
    assert.equal(policy, expectedCsp([sha256OfScript(inlineBody)]), `策略应为基线 + 内联脚本哈希，实际「${policy}」`)
    assert.equal(/unsafe-inline/.test(policy.split('; ')[1]), false, "script-src 不得出现 'unsafe-inline'")
    assert.equal(policy.split('; ')[1].split(' ').length, 4, 'script-src 应恰好是 self/file:/一个 hash')
    assert.equal(policy.includes(sha256OfRawScript(inlineBody)), false, 'CRLF 原文哈希不应出现（浏览器按 LF 计算）')
    return "script-src 'self' file: 'sha256-…'（CRLF 已归一）"
  })
  await check('真实 dist/index.html 的内联脚本全部被放行（防桌面端自锁）', async () => {
    const realIndex = path.join(REPO_ROOT, 'dist', 'index.html')
    if (!fs.existsSync(realIndex)) skip('dist/index.html 不存在（未构建）')
    const html = fs.readFileSync(realIndex, 'utf8')
    const hashes = inlineScriptHashesOf(html)
    assert.ok(hashes.length > 0, 'index.html 应至少有一个内联脚本（主题/启动兜底）')
    const harnessReal = await bootHarness(createHarness({ userData: userDataC, appRoot: REPO_ROOT }))
    const { listener } = harnessReal.state.webRequestHandlers[0]
    let captured
    listener({ url: 'file:///app/dist/index.html', responseHeaders: {} }, (result) => {
      captured = result
    })
    const policy = captured.responseHeaders['Content-Security-Policy'][0]
    for (const hash of hashes) {
      assert.ok(policy.includes(hash), `策略缺少内联脚本哈希 ${hash}`)
    }
    return `已放行 ${hashes.length} 个内联脚本`
  })

  section('红线：窗口安全配置不得放宽')
  await check('webPreferences 与 preload 路径保持安全基线', async () => {
    const options = stateA.windows[0].options
    const prefs = options.webPreferences
    assert.equal(prefs.contextIsolation, true)
    assert.equal(prefs.nodeIntegration, false)
    assert.equal(prefs.sandbox, true)
    assert.equal(prefs.webSecurity, true)
    assert.equal(path.basename(prefs.preload), 'preload.cjs')
    assert.equal(path.resolve(prefs.preload), PRELOAD_PATH)
    return JSON.stringify({ contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true })
  })
  await check('setWindowOpenHandler 一律 deny，will-navigate 已注册', async () => {
    const contents = stateA.windows[0].webContents
    assert.equal(typeof contents.windowOpenHandler, 'function', '必须注册 setWindowOpenHandler')
    assert.deepEqual(contents.windowOpenHandler({ url: 'https://example.com' }), { action: 'deny' })
    assert.ok(contents.events.has('will-navigate'), '必须注册 will-navigate')
    return '窗口/协议加固在位'
  })

  section('D11 关窗握手：flush-done 放行')
  await check('close 先 preventDefault 并发出 request-flush', async () => {
    assert.ok(stateA.listeners.has('opennote:app:flush-done'), '主进程必须监听 flush-done')
    const window = stateA.windows[0]
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    window.emit('close', event)
    assert.equal(event.defaultPrevented, true, '必须先阻止关闭等待 flush')
    const requests = window.webContents.sent.filter((item) => item.channel === 'opennote:app:request-flush')
    assert.equal(requests.length, 1, '应发出一次 request-flush')
    // 第二次点击关闭不应重复发起握手
    window.emit('close', { defaultPrevented: false, preventDefault() {} })
    assert.equal(window.webContents.sent.filter((item) => item.channel === 'opennote:app:request-flush').length, 1)
    assert.equal(window.destroyed, false, 'flush 完成前窗口不能关闭')
    return 'preventDefault + request-flush'
  })
  await check('收到 flush-done 后放行关闭', async () => {
    const window = stateA.windows[0]
    harnessA.emit('opennote:app:flush-done')
    await delay(80)
    assert.ok(window.closeCalls >= 1, 'flush-done 后必须调用 close()')
    assert.equal(window.destroyed, true, '窗口应已关闭')
    return `closeCalls=${window.closeCalls}`
  })

  section('D35 错误信息脱敏（不复用 A 的 userData）')
  // recent-workspaces.json 换成目录 → 写入必然失败 → 检查回传消息里没有绝对路径。
  fs.writeFileSync(path.join(userDataC, 'placeholder'), '')
  fs.mkdirSync(path.join(userDataC, 'recent-workspaces.json'), { recursive: true })
  const harnessC = await bootHarness(createHarness({ userData: userDataC, appRoot: emptyAppRoot }))
  const callC = makeCaller(harnessC)
  await check('addRecentWorkspace 写盘失败时消息不含绝对路径', async () => {
    harnessC.state.openDialog = { canceled: false, filePaths: [ws] }
    await callC('opennote:dialog:pickFolder')
    const message = await expectReject(() => callC('opennote:app:addRecentWorkspace', ws), /保存最近工作区失败/)
    assert.equal(ABSOLUTE_PATH_PATTERN.test(message), false, `消息泄漏绝对路径：「${message}」`)
    return `message=「${message}」`
  })
  await check('move 失败消息不含绝对路径（只带相对路径与 errno）', async () => {
    const message = await expectReject(() => callC('opennote:fs:move', ws, '不存在.md', '目标.md'), /移动失败/)
    assert.equal(ABSOLUTE_PATH_PATTERN.test(message), false, `消息泄漏绝对路径：「${message}」`)
    return `message=「${message}」`
  })
  await check('readText 失败消息不含绝对路径（D33 文案）', async () => {
    const message = await expectReject(() => callC('opennote:fs:readText', ws, '缺失.md'), /^找不到：缺失\.md$/)
    assert.equal(ABSOLUTE_PATH_PATTERN.test(message), false, `消息泄漏绝对路径：「${message}」`)
    return `message=「${message}」`
  })

  section('根目录授权：重启后仍能打开最近工作区')
  const harnessB = await bootHarness(createHarness({ userData: userDataA, appRoot: emptyAppRoot }))
  const callB = makeCaller(harnessB)
  await check('新进程未 pickFolder 即可读写 recent-workspaces.json 里的工作区', async () => {
    const text = await callB('opennote:fs:readText', ws, 'note.md')
    assert.match(text, /第一行/)
    await callB('opennote:fs:writeText', ws, 'after-restart.md', 'ok')
    assert.equal(fs.readFileSync(path.join(ws, 'after-restart.md'), 'utf8'), 'ok')
    return '持久授权生效'
  })
  await check('重启后 authorizeRoot(最近工作区) 返回 true，陌生目录仍 false', async () => {
    assert.equal(await callB('opennote:fs:authorizeRoot', ws), true)
    assert.equal(await callB('opennote:fs:authorizeRoot', otherDir), false)
    return 'true / false'
  })
  await check('重启后 addRecentWorkspace(最近工作区) 仍可用（保持列表顺序）', async () => {
    await callB('opennote:app:addRecentWorkspace', ws)
    const parsed = JSON.parse(fs.readFileSync(path.join(userDataA, 'recent-workspaces.json'), 'utf8'))
    assert.equal(parsed.length, 1, '同一路径不应重复')
    return JSON.stringify(parsed)
  })

  section('D11 关窗握手：超时兜底（不卡死窗口）')
  const harnessD = await bootHarness(createHarness({ userData: userDataA, appRoot: emptyAppRoot }))
  await check('渲染层不响应时 1.5s 后仍放行关闭', async () => {
    const window = harnessD.state.windows[0]
    const event = {
      defaultPrevented: false,
      preventDefault() {
        this.defaultPrevented = true
      },
    }
    window.emit('close', event)
    assert.equal(event.defaultPrevented, true)
    await delay(1000)
    assert.equal(window.destroyed, false, '1.5s 之前不应放行')
    await delay(800)
    assert.equal(window.destroyed, true, '超时后必须放行关闭')
    return `closeCalls=${window.closeCalls}`
  })

  section('preload 面：既有契约不得改变，新 API 必须存在')
  const preload = loadPreloadBridge()
  /**
   * **声明的删除**（与 `verify-contract.cjs` 的 `BR-14` 同一范式）。
   *
   * `onMenu` 于 0.3.3 按 `00` 号 §6.16 ㊿ 删除：`main.cjs` 的 `installApplicationMenu()`
   * 在非 darwin 上 `Menu.setApplicationMenu(null)`、darwin 上只装纯 role 的最小菜单
   * （注释写明「不额外增加自定义项」）⇒ **菜单栏是被故意移除的**，主进程从不下发
   * `opennote:menu`，preload 那个订阅是「听了没人发」的死订阅（`C-12c` 咬的就是它）。
   *
   * 豁免必须**自证**，且**只对这里列出的名字生效**：
   *   ① 名字要能在 `electron/preload.cjs` 的**注释**里找到（写清为什么删、以及恢复时的接入点）；
   *   ② 它必须**真的不存在** —— 哪天它又冒出来，这一条就要删掉、恢复 arity 断言，
   *      否则「声明的删除」会变成一张永久免死金牌。
   */
  const DECLARED_PRELOAD_REMOVALS = {
    onMenu: 'C-12c 删死订阅：菜单栏被故意移除（00 §6.16 ㊿）；preload 顶部注释是恢复接入点',
  }
  await check('contextBridge 只暴露 window.opennote，不泄漏 require/process', async () => {
    assert.equal(preload.exposed.key, 'opennote')
    const bridge = preload.exposed.value
    assert.equal(bridge.require, undefined)
    assert.equal(bridge.process, undefined)
    assert.equal(bridge.isElectron, true)
    assert.equal(bridge.version, '9.9.9-test')
    return `version=${bridge.version}`
  })
  await check('声明的删除必须自证：被删的名字写在 preload 注释里，且它真的不在', async () => {
    const bridge = preload.exposed.value
    const source = fs.readFileSync(PRELOAD_PATH, 'utf8')
    for (const [name, reason] of Object.entries(DECLARED_PRELOAD_REMOVALS)) {
      assert.ok(source.includes(name), `声明的删除 ${name} 必须在 preload.cjs 的注释里自证（${reason}）`)
      assert.equal(bridge[name], undefined, `${name} 已声明删除，但它又出现了：请从 DECLARED_PRELOAD_REMOVALS 删掉这一条并恢复 arity 断言`)
    }
    return `${Object.keys(DECLARED_PRELOAD_REMOVALS).join('、')} 已自证`
  })
  await check('既有 fs / dialog / shell / app 方法名与参数个数不变', async () => {
    const bridge = preload.exposed.value
    const arity = {
      'fs.list': 2,
      'fs.readText': 2,
      'fs.readBytes': 2,
      'fs.writeText': 3,
      'fs.writeBytes': 3,
      'fs.mkdir': 2,
      'fs.remove': 3,
      'fs.move': 3,
      'fs.exists': 2,
      'fs.stat': 2,
      'dialog.pickFolder': 0,
      'dialog.pickSaveFile': 1,
      'dialog.saveFile': 2,
      'shell.showItemInFolder': 1,
      'shell.openExternal': 1,
      'app.getRecentWorkspaces': 0,
      'app.addRecentWorkspace': 1,
      'window.setTitleBarOverlay': 1,
    }
    for (const name of EXISTING_FS_METHODS) {
      assert.equal(typeof bridge.fs[name], 'function', `fs.${name} 必须存在`)
    }
    for (const [name, expected] of Object.entries(arity)) {
      const [group, method] = name.split('.')
      const target = method ? bridge[group][method] : bridge[group]
      assert.equal(typeof target, 'function', `${name} 必须存在`)
      assert.equal(target.length, expected, `${name} 参数个数应为 ${expected}`)
    }
    // `onMenu` 已按 DECLARED_PRELOAD_REMOVALS 声明删除，**不在这里再断言它存在**
    // （那会让「故意删掉一个既有 API」这件事永远无法落地）；自证在下面单独一条里咬。
    return `${Object.keys(arity).length + EXISTING_FS_METHODS.length} 项一致（另有 ${Object.keys(DECLARED_PRELOAD_REMOVALS).length} 项声明的删除）`
  })
  await check('新增 API：authorizeRoot / watch / flush 握手齐全', async () => {
    const bridge = preload.exposed.value
    assert.equal(bridge.fs.authorizeRoot.length, 1)
    assert.equal(bridge.fs.watchWorkspace.length, 1)
    assert.equal(bridge.fs.unwatchWorkspace.length, 1)
    assert.equal(bridge.fs.onWorkspaceChanged.length, 1)
    assert.equal(bridge.app.onFlushRequest.length, 1)
    assert.equal(bridge.app.flushDone.length, 0)
    return '6 个新方法'
  })
  await check('onFlushRequest 收到 request-flush 且返回退订函数；flushDone 发对频道', async () => {
    const bridge = preload.exposed.value
    let calls = 0
    const unsubscribe = bridge.app.onFlushRequest(() => {
      calls += 1
    })
    assert.equal(typeof unsubscribe, 'function')
    const listeners = preload.listeners.get('opennote:app:request-flush') || []
    assert.equal(listeners.length, 1, '应注册监听')
    listeners[0]({}, undefined)
    assert.equal(calls, 1)
    unsubscribe()
    assert.equal((preload.listeners.get('opennote:app:request-flush') || []).length, 0, '退订后应移除监听')
    bridge.app.flushDone()
    assert.ok(preload.sent.some((item) => item.channel === 'opennote:app:flush-done'), 'flushDone 必须发 opennote:app:flush-done')
    return '握手频道正确'
  })
  await check('onWorkspaceChanged 透传 root，退订后移除监听（回归）', async () => {
    const bridge = preload.exposed.value
    const roots = []
    const offWorkspace = bridge.fs.onWorkspaceChanged((root) => roots.push(root))
    ;(preload.listeners.get('opennote:fs:workspace-changed') || [])[0]({}, '/ws/path')
    assert.deepEqual(roots, ['/ws/path'])
    offWorkspace()
    // 这一条原来还测 `onMenu` 的透传（`opennote:menu`）。那个订阅已按
    // `DECLARED_PRELOAD_REMOVALS` 删除（主进程从不下发它），所以这里只剩
    // `onWorkspaceChanged` —— **不是漏测，是那条链路不存在了**。
    assert.equal((preload.listeners.get('opennote:fs:workspace-changed') || []).length, 0, '退订后应移除监听')
    return '透传正常'
  })
  await check('非函数入参不会抛异常（返回空退订函数）', async () => {
    const bridge = preload.exposed.value
    for (const method of [bridge.fs.onWorkspaceChanged, bridge.app.onFlushRequest, bridge.onDeepLink, bridge.onInboxChanged]) {
      const off = method(undefined)
      assert.equal(typeof off, 'function')
      off()
    }
    return '安全降级'
  })

  // ------------------------------------------- 自更新（GitHub Releases → 覆盖重启）
  section('自更新：入口只许「五条命令 + 一条订阅」，未打包时完全不动网络')

  // 单开一个 harness：前面几个 harness 的窗口已经被 D11 关窗握手销毁了，
  // 而 update handler 有来源校验（`isTrustedSender`）——用旧 harness 会误判成「未授权」。
  const harnessU = await bootHarness(createHarness({ userData: userDataC, appRoot: emptyAppRoot }))
  const callU = makeCaller(harnessU)

  await check('preload 的 update 组只有 status/check/download/cancel/restart/onChanged（没有传 URL/路径的入口）', async () => {
    const bridge = preload.exposed.value
    assert.deepEqual(
      Object.keys(bridge.update).sort(),
      ['cancel', 'check', 'download', 'onChanged', 'restart', 'status'],
      '渲染层不得有「指定 URL / 路径 / 版本」的入口',
    )
    const arity = { status: 0, check: 1, download: 0, cancel: 0, restart: 0, onChanged: 1 }
    for (const [name, expected] of Object.entries(arity)) {
      assert.equal(typeof bridge.update[name], 'function', `update.${name} 必须存在`)
      assert.equal(bridge.update[name].length, expected, `update.${name} 参数个数应为 ${expected}`)
    }
    return `${Object.keys(arity).length} 项一致`
  })

  await check('update 的五个 invoke 频道在主进程都有 handler（不是死调用）', async () => {
    const channels = [
      'opennote:update:status',
      'opennote:update:check',
      'opennote:update:download',
      'opennote:update:cancel',
      'opennote:update:restart',
    ]
    for (const channel of channels) {
      assert.ok(harnessU.state.handlers.has(channel), `${channel} 必须注册 handler`)
    }
    return `${channels.length} 个通道配对`
  })

  await check('未打包（isPackaged=false）时 supported=false：状态如实、check 不发请求、restart 明确拒绝', async () => {
    const status = await callU('opennote:update:status')
    assert.equal(status.supported, false)
    assert.equal(status.phase, 'idle')
    assert.equal(status.canAutoInstall, false)
    assert.equal(status.latest, null)
    const checked = await callU('opennote:update:check', { force: true })
    assert.equal(checked.supported, false)
    assert.equal(checked.phase, 'idle', '未支持时必须直接返回，不得进入 checking')
    const restarted = await callU('opennote:update:restart')
    assert.deepEqual(restarted, { ok: false, reason: 'UNSUPPORTED' })
    return 'supported=false 时全部退化，且不写盘'
  })

  await check('未授权来源调用 update handler 被拒（覆盖磁盘上的 exe 不该由任意 webContents 触发）', async () => {
    const handler = harnessU.state.handlers.get('opennote:update:restart')
    const rogue = { sender: { send() {}, isDestroyed: () => false } }
    await assert.rejects(() => handler(rogue), /未授权的调用来源/)
    return '来源校验生效'
  })

  await check('update:changed 的订阅能透传状态并退订（不留死订阅）', async () => {
    const bridge = preload.exposed.value
    const seen = []
    const off = bridge.update.onChanged((status) => seen.push(status))
    assert.equal(typeof off, 'function')
    const listeners = preload.listeners.get('opennote:update:changed') || []
    assert.equal(listeners.length, 1, '应注册监听')
    listeners[0]({}, { phase: 'available', latest: '0.6.0' })
    assert.equal(seen.length, 1)
    assert.equal(seen[0].latest, '0.6.0')
    off()
    assert.equal((preload.listeners.get('opennote:update:changed') || []).length, 0, '退订后应移除监听')
    return '透传 + 退订正常'
  })

  // ------------------------------------------------------------------ summary
  if (ELECTRON_PROBE) {
    section('真实 Electron 端到端：file:// CSP 生效、dev server 不注入（--with-electron-probe）')
    await check('file:// 注入生效（hash 放行 / 未授权内联被挡），http://127.0.0.1 不注入', async () => {
      let binary
      try {
        const resolved = require('electron')
        binary = typeof resolved === 'string' && fs.existsSync(resolved) ? resolved : null
      } catch {
        binary = null
      }
      if (!binary) skip('未找到 electron 可执行文件')
      const dir = path.join(base, 'electron-probe')
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'main.js'), ELECTRON_CSP_PROBE_SOURCE, 'utf8')
      const env = { ...process.env }
      delete env.ELECTRON_RUN_AS_NODE
      const { spawnSync } = require('node:child_process')
      const spawned = spawnSync(binary, [path.join(dir, 'main.js')], { env, stdio: 'ignore', timeout: 90000 })
      const resultFile = path.join(dir, 'result.json')
      if (!fs.existsSync(resultFile)) {
        skip(`探针未产出结果（status=${spawned.status} signal=${spawned.signal}）`)
      }
      const probe = JSON.parse(fs.readFileSync(resultFile, 'utf8'))
      assert.ok(
        probe.injectedUrls.some((url) => url.startsWith('file://')),
        `file:// 请求必须触发 onHeadersReceived（实际 ${JSON.stringify(probe.injectedUrls)}）`,
      )
      assert.deepEqual(
        probe.injectedUrls.filter((url) => url.startsWith('http')),
        [],
        'http 请求不得被注入',
      )
      assert.equal(probe.filePage && probe.filePage.allowedRan, true, '带 sha256 的内联脚本必须执行')
      assert.equal(probe.filePage && probe.filePage.blockedRan, false, '未授权的内联脚本必须被 CSP 挡住')
      assert.equal(probe.httpPage && probe.httpPage.inlineRan, true, 'dev server 页面不得被注入 CSP')
      return `file:// 注入=${probe.injectedUrls.length} 次，hash 放行=true，未授权被挡=true，http 未注入=true`
    })
  }

  console.log('\n=== 自测摘要 ===')
  console.log(`PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`)
  if (!ELECTRON_PROBE) {
    console.log('提示：node scripts/ipc-safety-check.cjs --with-electron-probe 可追加真实 Electron 的 D38 端到端验证')
  }
  if (failCount > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  if (VERBOSE || failCount > 0) {
    console.log('\n主进程输出（stub 环境）：')
    for (const line of mainLogs) console.log(`  | ${line}`)
  }

  if (!KEEP_TEMP) {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* 清理失败无妨 */
    }
  } else {
    console.log(`\n临时目录保留在：${base}`)
  }

  if (failCount > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error('自测脚本自身异常：', error)
  process.exitCode = 1
})
