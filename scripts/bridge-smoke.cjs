#!/usr/bin/env node
'use strict'

/**
 * Opennote 本地桥自测（C3）。**不需要 Electron**：直接起 `electron/bridge.cjs`，
 * 用真实的 HTTP 回环请求逐条断言契约 §5.2 / §10 / §11 / §12 的门禁。
 *
 * 用法：node scripts/bridge-smoke.cjs [--verbose] [--keep]
 * 退出码：0 = 全部 PASS（允许 SKIP）；1 = 有 FAIL。
 *
 * 隔离策略：功能断言跑在一个「放宽限流」的主实例上（`limits` 覆盖），
 * 限流/鉴权失败/端口占用等断言各自起**默认限流**的独立实例，互不污染。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')

const {
  createBridge,
  ERROR_TABLE,
  PORT_RANGE_START,
  PORT_RANGE_END,
  TOKEN_LENGTH,
  APP_VERSION,
  APP_VERSION_FALLBACK,
  sha256Hex,
  CLIP_SPEC,
  CLIP_DIST_RELATIVE,
  CLIP_DIST_ROOT,
  CLIP_BOOT_ID,
  CLIP_CSP,
  CLIP_STAGE_TTL_MS,
  MAX_CLIP_ASSETS,
} = require(process.env.OPENNOTE_BRIDGE_UNDER_TEST || '../electron/bridge.cjs')

const ROOT_DIR = path.join(__dirname, '..')

/**
 * 应用版本的**唯一产地**：`package.json`。
 *
 * 事故背景（0.3.2 排查）：`/v1/health` 一直回 `"app":"0.2.0"`，Lead 与 b 因此判断「用户跑的是
 * 旧版应用」，其实跑的是仓库版，**一条真 bug 差点被判成「本机无法复现」**。
 * 更糟的是**这个自测脚本自己就抄了一份 0.2.0**（旧 L324 的 `getAppVersion: () => '0.2.0'` +
 * 旧 L1624 的 `assert.equal(result.app, '0.2.0')`）—— 两个产地一起错，所以它一直绿。
 * 教训：**断言里不许再抄一份事实**，必须去读那个唯一的产地（否则自测只是自我确认）。
 */
const PKG = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'))
const PKG_VERSION = PKG.version

const VERBOSE = process.argv.includes('--verbose')
const KEEP = process.argv.includes('--keep')
const BASE_PORT = 8787
const FALLBACK_PORT = 8788
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const MOZ_ORIGIN = 'moz-extension://fedcba9876543210fedcba9876543210'
const DEV_ORIGIN = 'http://127.0.0.1:5173'
/** UI 文案的**唯一来源**：设置面板 R1 的四个选项名必须与它逐字一致（㉕ 把「推荐」移到了收件箱）。 */
const UI_SPEC_PATH = path.join(ROOT_DIR, 'docs', 'import', '03-UI设计规范-剪藏与导入.md')
const PANEL_PATH = path.join(ROOT_DIR, 'src', 'components', 'ImportApiPanel.tsx')
/**
 * 桥源码（**永远是仓库里的那份**，即使行为跑的是 `OPENNOTE_BRIDGE_UNDER_TEST` 指向的变异副本）：
 * 用来断言「配对实现真的被删干净了」这类**源码级**事实。
 * 变异自检只替换行为（`require` 的目标），不替换这份源码 —— 否则变异会把自己的锚点也改掉。
 */
const BRIDGE_PATH = path.join(ROOT_DIR, 'electron', 'bridge.cjs')
/** 私有端口：给隔离实例用，避开 8787–8796（那条范围要留给「全占用」断言）。 */
let privatePortCounter = 19870

let passCount = 0
let failCount = 0
let skipCount = 0
const failures = []

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
    if (VERBOSE && error && error.stack) console.log(error.stack)
  }
}

function skip(reason) {
  const error = new Error(reason)
  error.__skip = true
  throw error
}

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

function listFilesRecursive(dir) {
  const out = []
  const walk = (current) => {
    let entries = []
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
// HTTP 客户端
// ---------------------------------------------------------------------------

function request(options) {
  const {
    port,
    method = 'GET',
    path: requestPath = '/v1/health',
    headers = {},
    body,
    timeoutMs = 5000,
    /** true 时只冲刷请求头（用于超大 Content-Length 的「不读 body」断言）。 */
    headersOnly = false,
  } = options

  return new Promise((resolve, reject) => {
    const payload = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(String(body), 'utf8')
    const finalHeaders = { ...headers }
    const hasLength = Object.keys(finalHeaders).some((key) => key.toLowerCase() === 'content-length')
    if (payload && !hasLength) finalHeaders['Content-Length'] = payload.length

    const req = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers: finalHeaders, setHost: false },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode, headers: res.headers, text, json })
        })
        res.on('error', reject)
      },
    )
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`请求超时（${timeoutMs}ms）`))
    })
    req.on('error', reject)

    if (headersOnly) {
      req.flushHeaders()
      return
    }
    if (payload) req.write(payload)
    req.end()
  })
}

/** 原始 socket 请求（用来构造 Node 客户端不方便发的形态）。 */
function rawRequest(port, payload) {
  const net = require('node:net')
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(payload))
    let text = ''
    socket.setTimeout(5000, () => socket.destroy(new Error('raw 请求超时')))
    socket.on('data', (chunk) => {
      text += chunk.toString('utf8')
    })
    socket.on('error', reject)
    socket.on('close', () => {
      const match = /^HTTP\/1\.[01] (\d{3})/.exec(text)
      const bodyStart = text.indexOf('\r\n\r\n')
      let body = bodyStart >= 0 ? text.slice(bodyStart + 4) : ''
      // 处理 chunked 编码（Node 对 400 默认会分块）。
      if (/transfer-encoding:\s*chunked/i.test(text)) {
        const parts = body.split('\r\n')
        body = parts.length > 1 ? parts[1] : ''
      }
      let json = null
      try {
        json = JSON.parse(body)
      } catch {
        json = null
      }
      resolve({ status: match ? Number(match[1]) : 0, raw: text, text: body, json })
    })
  })
}

function withHost(port, extra = {}) {
  return { Host: `127.0.0.1:${port}`, ...extra }
}

function jsonHeaders(port, token, extra = {}) {
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers.Authorization = `Bearer ${token}`
  return withHost(port, { ...headers, ...extra })
}

function expectError(response, code, httpStatus) {
  assert.ok(response.json, `响应不是 JSON：${response.text.slice(0, 200)}`)
  assert.equal(response.json.ok, false, `期望失败响应，实际 ${response.text.slice(0, 200)}`)
  assert.equal(response.json.error.code, code, `错误码应为 ${code}，实际 ${response.json.error.code}`)
  if (httpStatus != null) {
    assert.equal(response.status, httpStatus, `HTTP 状态应为 ${httpStatus}，实际 ${response.status}`)
  }
  assert.equal(typeof response.json.error.message, 'string')
  assert.ok(response.json.error.userMessage && response.json.error.userMessage !== '', 'userMessage 必须存在')
  assert.equal(typeof response.json.error.retryable, 'boolean', 'retryable 必须存在')
  return response.json.error
}

function validEnvelope(overrides = {}) {
  return {
    spec: 'opennote.import/v1',
    importId: crypto.randomUUID(),
    title: '写给工程师的本地优先笔记',
    body: '在浏览器里剪下的一段话。',
    source: {
      url: 'https://example.com/posts/local-first',
      title: '写给工程师的本地优先笔记',
      site: 'example.com',
      author: null,
      publishedAt: null,
      capturedAt: new Date().toISOString(),
      selection: true,
    },
    target: { folder: '剪藏/技术', notePath: null },
    conflict: 'new',
    tags: ['剪藏'],
    assets: [],
    client: { name: 'chrome-extension', version: '0.1.4' },
    ...overrides,
  }
}

function postImport(port, token, envelope, extraHeaders = {}) {
  return request({
    port,
    path: '/v1/import',
    method: 'POST',
    headers: jsonHeaders(port, token, extraHeaders),
    body: JSON.stringify(envelope),
  })
}

function postPair(port, code, origin, client = { name: 'chrome-extension', version: '0.1.4' }) {
  const headers = { 'Content-Type': 'application/json' }
  if (origin) headers.Origin = origin
  return request({ port, path: '/v1/pair', method: 'POST', headers: withHost(port, headers), body: JSON.stringify({ code, client }) })
}

/** `Origin` 头 + 校验用的最小请求（默认打 /v1/health，无需令牌）。 */
function withOrigin(port, origin, overrides = {}) {
  const headers = { Origin: origin, ...(overrides.headers || {}) }
  return request({ port, path: overrides.path || '/v1/health', method: overrides.method || 'GET', headers: withHost(port, headers), body: overrides.body })
}

/** 占住一个端口，返回释放函数。 */
function occupy(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => res.end('busy'))
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(() => new Promise((done) => server.close(done))))
  })
}

/** 探测端口是否空闲（true = 没人监听）。 */
function isFree(port) {
  return new Promise((resolve) => {
    const server = http.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)))
  })
}

/** 连接被拒（端口不再监听）→ true。 */
function isRefused(port) {
  return request({ port, timeoutMs: 1500 }).then(
    () => false,
    () => true,
  )
}

/**
 * 注入缝隙：让指定端口的 `listen()` 以给定错误码失败，并记录**所有被尝试过的端口**。
 *
 * 为什么必须有这条缝：`EACCES` 是 **Windows 系统保留端口段**（Hyper-V / WSL / Docker 的
 * `winnat`）的产物，测试里造不出来 —— `occupy()` 只能造 `EADDRINUSE`，而且占满 `8787–8796`
 * 还要先停掉主桥、跑完再起回来。没有它，「起始端口一被系统保留就整段放弃」这个**真实故障
 * 现场**（`8755–8854` 被保留 → 8787 起全段 `EACCES`）就没有任何回归护栏，改回去也不会有人发现。
 *
 * 为什么可行：`bridge.cjs` 顶层 `const http = require('node:http')` 拿到的是**同一个模块对象**，
 * 而 `tryListen` 是在调用时才做 `http.createServer()` —— 替换属性对它可见。
 *
 * **只改测试，不改产品**：产品侧不留任何「测试模式」开关。
 */
async function withListenErrors(ports, code, fn) {
  const originalCreateServer = http.createServer
  const blocked = new Map(ports.map((port) => [port, code]))
  const attempted = []
  http.createServer = function patchedCreateServer(...args) {
    const server = originalCreateServer.apply(this, args)
    const originalListen = server.listen
    server.listen = function patchedListen(...listenArgs) {
      const target = listenArgs.find((item) => typeof item === 'number')
      attempted.push(target)
      if (blocked.has(target)) {
        // 异步派发：`tryListen` 先注册 `once('error')` 再调 `listen()`，同步派发会丢事件。
        setImmediate(() => {
          server.emit(
            'error',
            Object.assign(new Error(`listen ${code}: injected by smoke 127.0.0.1:${target}`), {
              code,
              errno: code === 'EACCES' ? -4092 : -4091,
              syscall: 'listen',
              port: target,
            }),
          )
        })
        return server
      }
      return originalListen.apply(server, listenArgs)
    }
    return server
  }
  try {
    return await fn({ attempted })
  } finally {
    http.createServer = originalCreateServer
  }
}

/** `EACCES` = 端口被系统保留（Windows 保留段）。 */
function withEaccesPorts(ports, fn) {
  return withListenErrors(ports, 'EACCES', fn)
}

/** 冻结默认段 `8787–8796` 的全量列表（与 `bridge.cjs` 的 `FROZEN_PORTS` 同一个事实）。 */
function frozenPorts() {
  const out = []
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) out.push(port)
  return out
}

/** 造一个带最小渲染层替身的桥实例（默认端口见参数）。 */
function makeBridge(options = {}) {
  const holder = { tokenHash: null, calls: [], inboxWrites: [], logs: [], logEvents: [] }
  const renderer = {
    mode: 'ok',
    async handle(envelopeJson, meta) {
      holder.calls.push({ envelopeJson, meta })
      if (renderer.mode === 'no-window') return { ok: false, error: { code: 'IMP-4006', http: 409 } }
      if (renderer.mode === 'throw') throw new Error('渲染层异常')
      if (renderer.mode === 'hang') return new Promise(() => {})
      const env = JSON.parse(envelopeJson)
      const folder = env.target && typeof env.target.folder === 'string' ? env.target.folder : ''
      if (folder.split(/[\\/]/).includes('..') || /^([A-Za-z]:|[\\/])/.test(folder)) {
        return { ok: false, error: { code: 'IMP-4008', http: 422, detail: { field: 'target.folder' } } }
      }
      const warnings = []
      if (env.__bridgeOverwriteDowngraded) warnings.push('IMP-4011')
      return {
        ok: true,
        result: {
          status: 'created',
          importId: env.importId,
          path: `${folder ? `${folder}/` : ''}${env.title}.md`,
          deduped: false,
          dedupedBy: null,
          assets: [],
          tags: env.tags || [],
          revertible: true,
          preimage: null,
          warnings,
          committedAt: new Date().toISOString(),
        },
      }
    },
  }

  const bridge = createBridge({
    dataDir: options.dataDir,
    getWindow: () => (options.noWindow ? null : { id: 1 }),
    onEnvelope: options.hang ? () => new Promise(() => {}) : (json, meta) => renderer.handle(json, meta),
    onInboxStateWrite: options.onInboxStateWrite === false
      ? undefined
      : async (entryId, stateJson) => {
          holder.inboxWrites.push({ entryId, stateJson })
        },
    isEnabled: () => (options.enabled === false ? false : true),
    getTokenHash: () => holder.tokenHash,
    getAdvancedOverwrite: () => options.advancedOverwrite === true,
    getWorkspaceInfo: options.workspace ? () => ({ open: true, name: options.workspaceName || '我的笔记' }) : undefined,
    /**
     * 网页版剪藏页（0.3.2）的落点候选。替身是**函数形态**：可以抛错、可以返回 Promise、
     * 也可以返回 `[]` —— 「空数组」与「拿不到」是两件事，这两种都必须能被断言。
     */
    getFolders: typeof options.folders === 'function' ? options.folders : undefined,
    /** 剪藏页自测覆盖（`{ distRoot, ttlMs, maxStages }`）：静态页夹具 + 短 TTL。 */
    clip: options.clip,
    // 版本号**不抄一份**：主进程真实接线传的就是 `package.json` 的版本（`app.getVersion()`）。
    getAppVersion: () => (options.appVersion === undefined ? PKG_VERSION : options.appVersion),
    getInboxEnabled: () => false,
    // ㉕ 交付模式挂钩：只有显式传了 `inboxMode` 才接线，用来验证「没接线 = null」。
    getInboxMode: 'inboxMode' in options ? options.inboxMode : undefined,
    getRecentImports: () => [],
    getImportRecord: (importId) =>
      importId === 'known-id' ? { importId, status: 'created', path: '剪藏/a.md', committedAt: new Date().toISOString(), errors: [] } : null,
    limits: options.limits,
    // 挂钩形态是 `log(event, fields)`（Lead 的 main.cjs 就这么用）。
    // 桥写进 userData/bridge.log 的正是 `fields` 那一份 JSONL，所以这里按它重放。
    log: (event, fields = {}) => {
      holder.logEvents.push(event)
      holder.logs.push(JSON.stringify(fields))
    },
  })
  return { bridge, holder, renderer }
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  const workspace = tempDir('opennote-bridge-ws-')
  fs.mkdirSync(path.join(workspace, '.opennote'), { recursive: true })
  const dataDir = tempDir('opennote-bridge-userdata-')

  // 剪藏页夹具：**不依赖 `pnpm build:clip` 的产物**（产物还没构建也必须能测全部用例）。
  // 目录形状与真实产物逐字一致：`clip/index.html` + `clip/assets/**`。
  const clipDistRoot = tempDir('opennote-clip-dist-')
  const emptyClipRoot = tempDir('opennote-clip-empty-')
  fs.mkdirSync(path.join(clipDistRoot, 'clip', 'assets', 'sub'), { recursive: true })
  fs.writeFileSync(
    path.join(clipDistRoot, 'clip', 'index.html'),
    [
      '<!doctype html>',
      '<html lang="zh-CN">',
      '  <head><meta charset="utf-8"><title>Opennote 剪藏</title></head>',
      '  <body>',
      '    <div id="app">CLIP_FIXTURE_PAGE</div>',
      '  </body>',
      '</html>',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(path.join(clipDistRoot, 'clip', 'assets', 'app.js'), 'window.__CLIP_APP__ = "CLIP_FIXTURE_APP_JS";\n', 'utf8')
  fs.writeFileSync(path.join(clipDistRoot, 'clip', 'assets', 'style.css'), '.clip-fixture { color: red; }\n', 'utf8')
  // 下面三个文件都**不允许**出网：白名单外扩展名 / 目录外 / 子目录里。
  fs.writeFileSync(path.join(clipDistRoot, 'clip', 'assets', 'secret.txt'), 'CLIP_FIXTURE_TXT\n', 'utf8')
  fs.writeFileSync(path.join(clipDistRoot, 'clip', 'outside.js'), 'window.__CLIP_OUTSIDE__ = "CLIP_OUTSIDE_SENTINEL";\n', 'utf8')
  fs.writeFileSync(path.join(clipDistRoot, 'clip', 'assets', 'sub', 'inner.js'), 'window.__CLIP_INNER__ = "CLIP_NESTED_SENTINEL";\n', 'utf8')

  console.log('Opennote 本地桥自测（不需要 Electron）')
  console.log(`node=${process.version} platform=${process.platform}`)
  console.log(`临时工作区：${workspace}${KEEP ? '（--keep：不清理）' : ''}`)
  if (process.env.OPENNOTE_BRIDGE_UNDER_TEST) {
    console.log(`被测桥：${process.env.OPENNOTE_BRIDGE_UNDER_TEST}（变异副本；源码级断言仍读仓库里的 bridge.cjs）`)
  }

  // 主实例：放宽限流，专做功能断言（限流本身由独立实例断言）。
  const main = makeBridge({
    dataDir,
    workspace: true,
    limits: { importCapacity: 5000, importRefillPerMinute: 6000, authFailLimit: 5000 },
    onInboxStateWrite: false,
    // 落点替身故意带上重复项与空串：桥必须自己补 ""、去重、排序。
    folders: () => ['归档', '剪藏/技术', '归档', ''],
    clip: { distRoot: clipDistRoot },
  })
  const bridge = main.bridge
  const holder = main.holder
  const renderer = main.renderer

  let token = null
  let port = null
  const canUseDefaultPort = (await isFree(BASE_PORT)) && (await isFree(FALLBACK_PORT))
  if (!canUseDefaultPort) {
    console.log(`  提示：${BASE_PORT}/${FALLBACK_PORT} 已被其它进程占用，默认端口断言将按本机实际情况降级。`)
  }

  // -------------------------------------------------------------------------
  section('① 未开启时不监听（默认关闭）')
  // -------------------------------------------------------------------------
  await check('start() 之前状态是 disabled 且不持有任何监听 socket', async () => {
    const status = bridge.status()
    assert.equal(status.state, 'disabled', `初始状态应为 disabled，实际 ${status.state}`)
    assert.equal(status.stateLabel, '未开启')
    assert.equal(status.running, false)
    assert.equal(status.port, null)
    assert.equal(status.address, null)
    assert.equal(status.addressText, '—')
    assert.equal(bridge.getBoundAddress(), null, '未开启时不得持有监听 socket')
    // OS 探针只在默认端口本来就空着时才断言（共享机器上 8787 可能被别人占着）。
    if (canUseDefaultPort) assert.equal(await isRefused(BASE_PORT), true, `${BASE_PORT} 不应有人监听`)
    return canUseDefaultPort ? 'disabled + 端口不可达' : 'disabled + 无监听 socket（8787 被外部占用，跳过探针）'
  })

  await check('未设置令牌时不允许开启（不开无鉴权写入端口）', async () => {
    const fresh = createBridge({ log: () => {} })
    const result = await fresh.start()
    assert.equal(result.port, null, '没有令牌不得监听')
    assert.ok(result.error, '必须给出中文原因')
    assert.equal(fresh.status().running, false)
    assert.equal(fresh.getBoundAddress(), null, '不得持有监听 socket')
    if (canUseDefaultPort) assert.equal(await isRefused(BASE_PORT), true)
    return `error=「${result.error}」`
  })

  await check('C-6 回归：IMP-1001 与 IMP-5002 文案必须区分（Verifier 发现过逐字相同的缺陷）', async () => {
    const a = ERROR_TABLE['IMP-1001']
    const b = ERROR_TABLE['IMP-5002']
    assert.ok(a && b, '两个码都必须在错误码表里')
    assert.notEqual(a.userMessage, b.userMessage, '「从未开启」与「不在运行态」对用户是不同动作，文案不得相同')
    assert.equal(a.userMessage, '本地接口未开启。请在 Opennote 的「设置 · 文件 · 导入与接口」里开启，然后重试。')
    assert.equal(
      b.userMessage,
      '本地接口当前不在运行状态。请先在 Opennote 的「设置 · 文件 · 导入与接口」里开启接口，再重试。',
    )
    assert.equal(a.http, 503)
    assert.equal(b.http, 503)
    assert.equal(a.retryable, true)
    assert.equal(b.retryable, true)
    // 每个错误码都必须有完整四件套，且 detail 永不含「绝对路径/令牌」这类东西。
    for (const [code, spec] of Object.entries(ERROR_TABLE)) {
      assert.ok(/^IMP-\d{4}$/.test(code), `错误码形态不对：${code}`)
      assert.equal(typeof spec.message, 'string', `${code} 缺 message`)
      assert.equal(typeof spec.userMessage, 'string', `${code} 缺 userMessage`)
      assert.ok(Number.isInteger(spec.http) && spec.http >= 400 && spec.http <= 599, `${code} 的 http 不合法`)
      assert.equal(typeof spec.retryable, 'boolean', `${code} 缺 retryable`)
      assert.equal(spec.userMessage.endsWith('。'), true, `${code} 的 userMessage 必须以句号收尾`)
      assert.equal(spec.userMessage.length >= 5, true, `${code} 的 userMessage 太短`)
    }
    return `${Object.keys(ERROR_TABLE).length} 个错误码齐全，1001/5002 文案已区分`
  })

  await check('㉕ 面板 R1 的四个选项名与 03 号 UI-04 逐字咬合（「（推荐）」必须在收件箱上）', async () => {
    let raw
    try {
      raw = fs.readFileSync(UI_SPEC_PATH, 'utf8')
    } catch {
      skip('读不到 03 号规范，无法比对 R1 选项名')
    }
    // `| R1 选项（…） | `直接入库` · `先进入收件箱（推荐）` |`
    // 只认**值那一格**里的反引号——标签格的说明文字里也会出现反引号（例如 `` `（推荐）` 只在 `inbox` 上 ``）。
    const row = raw.split(/\r?\n/).find((line) => /^\|\s*R1 选项/.test(line))
    if (!row) skip('03 号里找不到「R1 选项」这一行')
    const cells = row.split('|')
    const valueCell = cells.length >= 3 ? cells[2] : row
    const docLabels = (valueCell.match(/`[^`]+`/g) || []).map((item) => item.slice(1, -1))
    const stale = '直接入库（推荐）'
    // ① 03 号必须已经把「（推荐）」移到收件箱（0.3.0 的默认值是 inbox，见 00 §6.14㉕）。
    assert.equal(
      docLabels.includes(stale),
      false,
      `03 号「R1 选项」还没更新，仍是：${docLabels.join(' / ')}（应改为 直接入库 / 追加到已有笔记 / 跳过重复内容 / 先进入收件箱（推荐））——这是 d-ui 的文件，我这边不改`,
    )
    assert.equal(docLabels.includes('先进入收件箱（推荐）'), true, '03 号的「（推荐）」必须在「先进入收件箱」上')
    // ② 四个选项名必须齐全（追加/跳过这两项 03 号原先没列，㉕ 之后按裁定补齐）。
    for (const label of ['直接入库', '追加到已有笔记', '跳过重复内容', '先进入收件箱（推荐）']) {
      assert.equal(docLabels.includes(label), true, `03 号「R1 选项」缺少「${label}」`)
    }
    assert.equal(docLabels.length, 4, `03 号 R1 选项应恰好 4 个，实得 ${docLabels.length}：${docLabels.join(' / ')}`)
    // ③ 面板必须逐字实现 03 号冻死的这四个，且不得残留旧的「（推荐）」标签。
    const panel = fs.readFileSync(PANEL_PATH, 'utf8')
    for (const label of docLabels) {
      assert.equal(panel.includes(`"${label}"`), true, `面板缺少 03 号冻结的选项名「${label}」`)
    }
    assert.equal(panel.includes(`"${stale}"`), false, `面板不得再出现旧的「${stale}」`)
    // ④ 分段控件的取值表里永远不许有 `overwrite`（红线）。
    const table = panel.slice(panel.indexOf('CONFLICT_LABELS'), panel.indexOf('CONFLICT_NOTES'))
    assert.equal(/overwrite/.test(table), false, 'R1 取值表里不得出现 overwrite')
    return `4 个选项名与 03 号逐字一致（收件箱=推荐）`
  })

  await check('㊸ 文档咬合：03 的活规格不得再把 R4b 当活规格（漏句 / 改句 / 造按钮三种漂移）', async () => {
    // 起因：task-22 把面板的 R4b 并入 R4，而 03 里还躺着 41 行把它当活规格，甚至写着一个
    // **从来没实现过的按钮**（生成并复制新令牌）。当时 verify-contract / verify-e2e / 单测全绿 ——
    // 说明「文档 ↔ 实现」的漂移此前**没有任何自动检查**（只有下面 ㉕ 那一处）。
    //
    // 存档区**按行内容匹配**，不按行号（行号会漂）：划掉的作废行、§11.2 变更记录、mock 作废说明。
    const ARCHIVE = [
      (t) => t.includes('~~R4b 配对新客户端~~'),
      (t) => t.includes('~~R4b 复制令牌（两块并存时）~~'),
      (t) => /^\|\s*`R4b 配对新客户端` 整块/.test(t),
      (t) => /^\|\s*配对流程的一切用户可见文案\s*\|/.test(t),
      (t) => /^\|\s*`03-settings-import-api\.html`\s*\|/.test(t),
    ]
    // 活规格里提到 R4b 时必须带「并入 / 作废 / 留痕」这类语境，否则就是在拿它当活规格。
    // 另有一类是**回顾性**文字（写明「教训 / 写给后来者 / 不得再…」），同样不是活规格。
    const MERGED_CONTEXT = ['并入', '合并', '作废', '删除', '留痕', '不存在', '取代', '教训', '不得再']
    let doc
    try {
      doc = fs.readFileSync(UI_SPEC_PATH, 'utf8')
    } catch {
      // 03 号是这些文案的产地：读不到就是红的，不许 SKIP（一个会告诉人怎么修的 FAIL，比
      // 一个安静的 SKIP 有价值）。
      assert.equal(false, true, '读不到 03 号规范：它是活规格的产地，缺失必须红')
      return ''
    }
    // 反「静默通过」：文件被清空/截断时，后面的 includes 断言会全部落空却显得「没问题」。
    // （这不是假想：我自己做红证明时用错 PowerShell 重载，真的把 03 写成过空文件 ——
    //   当时的「存档区只匹配到 0 行」安全阀把它抓成了 FAIL。）
    assert.equal(
      doc.length > 20000,
      true,
      `03 号只有 ${doc.length} 字符，疑似被清空或截断 —— 文档咬合绝不能靠「什么都不剩」通过`,
    )
    const lines = doc.split(/\r?\n/)
    const archiveHits = lines.filter((line) => ARCHIVE.some((match) => match(line.trim())))
    // 安全阀：切档必须真的切到了东西，否则「切完什么都不剩」会让下面的断言静默通过。
    assert.equal(archiveHits.length >= 5, true, `存档区只匹配到 ${archiveHits.length} 行，过滤器可能已失效`)
    const live = lines.filter((line) => !ARCHIVE.some((match) => match(line.trim())))

    // ① 布局树里不得再有一个 R4b 节点（最具体的一种「当活规格」形态，先查它，报错更准）。
    assert.equal(doc.includes('├ R4b 复制令牌'), false, '03 布局树里还有 `├ R4b 复制令牌`')
    const treeR4b = lines.find((line) => /^\s*[├└│]+ *`?R4b/.test(line))
    assert.equal(treeR4b === undefined, true, `03 布局树里还有一个 R4b 节点：${String(treeR4b).trim().slice(0, 80)}`)
    // ② 全文不得出现那个**从来没实现过**的按钮（含存档区）。
    assert.equal(
      doc.includes('生成并复制新令牌'),
      false,
      '03 里出现了 `生成并复制新令牌` —— 这个按钮在实现里从来不存在（实现只有「重新生成」）',
    )
    // ③ 活规格区：`R4b` 只能出现在「已并入 / 已作废」语境里。
    const liveR4b = live.filter((line) => line.includes('R4b'))
    for (const line of liveR4b) {
      assert.equal(
        MERGED_CONTEXT.some((word) => line.includes(word)),
        true,
        `03 活规格里有一行在拿 R4b 当活规格（缺「并入/作废」语境）：${line.trim().slice(0, 90)}——这是 d-ui 的文件，我这边不改`,
      )
    }

    // ④⑤ 逐字比对：文案只有实现一个产地，文档必须与它**逐字**一致。
    const panel = fs.readFileSync(PANEL_PATH, 'utf8')
    const constString = (name) => {
      const at = panel.indexOf(`const ${name} =`)
      assert.notEqual(at, -1, `面板里找不到 ${name}（咬合断言的产地没了，必须先修断言）`)
      const literal = panel.slice(at).match(/"(?:[^"\\]|\\.)*"/)
      assert.notEqual(literal, null, `${name} 不是字符串字面量`)
      return JSON.parse(literal[0])
    }
    const cost = constString('TOKEN_COST_HINT')
    // ㊴：披露句换了新版，这里只做「有没有被掏空」的最低限度自检（逐字冻结在 ㊴④ 那条断言里）。
    assert.equal(cost.includes('令牌明文就保存在本机 Opennote 数据目录的 bridge.json 里'), true, '代价披露句被改过了')
    assert.equal(cost.includes('不提供读取和删除'), true, '代价披露句被改过了')
    assert.equal(doc.includes(cost), true, `03 缺少代价披露的**完整实现句**：${cost}`)
    for (const name of ['R4_READY', 'R4_NO_TOKEN', 'R4_LEGACY', 'R4_HINT']) {
      const text = constString(name)
      assert.equal(doc.includes(text), true, `03 缺少/改动了 ${name} 的逐字文案：${text}`)
    }
    // 三条状态句必须互斥（同一个事实只有一个产地）：任何两句都不允许同时是另一句的子串。
    const three = ['R4_READY', 'R4_NO_TOKEN', 'R4_LEGACY'].map(constString)
    for (const a of three) {
      for (const b of three) {
        if (a !== b) assert.equal(a.includes(b), false, `状态句不是互斥的：${b} ⊂ ${a}`)
      }
    }
    return `存档 ${archiveHits.length} 行；活规格 R4b ${liveR4b.length} 处都带「已并入」语境；无「生成并复制新令牌」；㊴ 披露句 + 四句状态文案逐字一致`
  })

  await check('㉗ 逐字：IMP-4006「应用没运行」与 IMP-4007「工作区没打开」必须区分且逐字', async () => {
    assert.equal(ERROR_TABLE['IMP-4006'].userMessage, 'Opennote 没有在运行。请先打开 Opennote，再试一次。')
    assert.equal(
      ERROR_TABLE['IMP-4007'].userMessage,
      'Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。',
    )
    // 两条讲的是两件事：一条要用户去启动应用，另一条要用户去选文件夹。
    assert.notEqual(ERROR_TABLE['IMP-4006'].userMessage, ERROR_TABLE['IMP-4007'].userMessage)
    // ㉗ 禁令：被否决的旧措辞一个都不许再出现。
    for (const banned of ['或新建浏览器笔记本', '请先打开一个文件夹。', '的窗口已关闭']) {
      for (const code of ['IMP-4006', 'IMP-4007']) {
        assert.equal(
          ERROR_TABLE[code].userMessage.includes(banned),
          false,
          `${code} 不得再出现被 ㉗ 否决的旧措辞「${banned}」`,
        )
      }
    }
    // 冻结码不得被顺手改掉（D-V08 已冻结的那条）。
    assert.equal(ERROR_TABLE['IMP-4013'].userMessage, '附件太多或太大，请减少后用重新剪藏。')
    return '4006/4007 逐字 + 旧措辞 0 处 + 4013 未动'
  })

  // -------------------------------------------------------------------------
  section('⑩ 令牌：47 字符 / 明文只返回一次 / 服务端只存 sha256')
  // -------------------------------------------------------------------------
  await check('regenerateToken() 返回 47 字符 opn_ 令牌，status() 只给 last4', async () => {
    token = bridge.regenerateToken()
    assert.equal(typeof token, 'string')
    assert.equal(token.length, TOKEN_LENGTH, `令牌长度应为 ${TOKEN_LENGTH}`)
    assert.match(token, /^opn_[A-Za-z0-9_-]{43}$/)
    const status = bridge.status()
    assert.equal(status.tokenSet, true)
    assert.equal(status.tokenLast4, token.slice(-4))
    assert.equal(JSON.stringify(status).includes(token), false, 'status() 泄漏令牌明文')
    return `${token.slice(0, 4)}…${token.slice(-4)}（${token.length} 字符）`
  })

  await check('第二次 regenerateToken() 换新令牌，旧令牌哈希被替换', async () => {
    const old = token
    token = bridge.regenerateToken()
    assert.notEqual(token, old, '轮换必须换一把')
    assert.equal(bridge.status().tokenLast4, token.slice(-4))
    assert.notEqual(sha256Hex(old), sha256Hex(token))
    return '旧令牌立刻失效'
  })

  await check('㊴ bridge.json 存 sha256 + last4 + **明文**（明文可以落盘，但只能落这里）', async () => {
    // 注意：这条断言原本写的是「bridge.json **绝不**含明文」—— ㊴（用户知情选择「随时可复制」）
    // **有意推翻了那个事实**，所以这里必须**换成新事实的守卫**（盘上必须有明文），而不是删掉：
    // 删掉就等于以后没人守「明文到底有没有落盘」。
    //
    // 原则（写给后来者）：**当一条裁定有意推翻某个事实时，所有编码了旧事实的断言必须与裁定
    // 同轮更新 —— 这不是「让它变绿」，是「换成新事实的守卫」。** 否则下一个人看到红，会以为
    // 代码错了，跑去改代码而不改断言。
    // 同一族的另一例：verifier 的 `BR-9` 标题写着「只存 sha256 + last4」——**标题错了、断言
    // 仍成立**，所以四个脚本全绿也发现不了；这条是**断言本身错了**，所以它会红。区别只在
    // 「错在哪一层」：一层靠人读，一层靠机制。
    const file = path.join(dataDir, 'bridge.json')
    assert.equal(fs.existsSync(file), true, 'dataDir 给定时应写 bridge.json')
    const raw = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(raw)
    assert.match(parsed.tokenHash, /^[a-f0-9]{64}$/, 'tokenHash 必须是 sha256 十六进制')
    assert.equal(parsed.tokenHash, sha256Hex(token), '哈希必须等于 sha256(明文)')
    assert.equal(parsed.tokenLast4, token.slice(-4))
    // ㊴ 推翻了 0.3.1 第一版的「绝不含明文」：用户知情选择了「随时可复制」。
    assert.equal(parsed.tokenPlaintext, token, 'bridge.json 必须与哈希并列存明文（面板的披露句就是这么说的）')
    assert.equal(/^opn_[A-Za-z0-9_-]{43}$/.test(parsed.tokenPlaintext), true, '盘上必须是完整 47 字符明文')
    assert.deepEqual(parsed.allowedOrigins, [], 'allowedOrigins 默认空')
    return `tokenHash=${parsed.tokenHash.slice(0, 16)}… last4=${parsed.tokenLast4} 明文=盘上（㊴）`
  })

  await check('磁盘无 bridge.json.tmp 残留（原子写）', async () => {
    const strays = fs.readdirSync(dataDir).filter((name) => name.endsWith('.tmp'))
    assert.deepEqual(strays, [], `不应有 .tmp 残留：${strays.join(', ')}`)
    return '无残留'
  })

  // 主进程在生产里用同一份状态提供 getTokenHash。
  holder.tokenHash = sha256Hex(token)

  // -------------------------------------------------------------------------
  section('② 默认端口 8787 / 占用后回落 8788 / 只绑 127.0.0.1')
  // -------------------------------------------------------------------------
  // 默认端口段可能被本机其它程序（含另一个并发的自测实例）占用 —— 那是环境问题，
  // 不是桥的问题。此时用私有端口把主桥起起来，保证后面所有功能断言仍然确定可跑。
  if (!canUseDefaultPort) {
    const isolated = await bridge.startWithPort(privatePortCounter++)
    assert.ok(isolated.port, `私有端口也应能启动：${isolated.error || '未知'}`)
    port = isolated.port
  }

  await check('start() 监听 8787，状态 running', async () => {
    if (!canUseDefaultPort) skip(`${BASE_PORT} 被其它进程占用，无法断言默认端口`)
    const result = await bridge.start()
    assert.equal(result.port, BASE_PORT, `应监听 ${BASE_PORT}，实际 ${result.port}（${result.error || ''}）`)
    port = result.port
    const status = bridge.status()
    assert.equal(status.state, 'running')
    assert.equal(status.stateLabel, '运行中')
    assert.equal(status.enabled, true)
    assert.equal(status.running, true)
    assert.equal(status.address, `http://127.0.0.1:${BASE_PORT}`)
    assert.equal(status.endpoint, `http://127.0.0.1:${BASE_PORT}`)
    return `${status.address} / ${status.stateLabel}`
  })

  await check('S-01/S-02 真实绑定地址是 127.0.0.1（不是 0.0.0.0 / ::）', async () => {
    if (port == null) skip('桥未启动')
    const bound = bridge.getBoundAddress()
    assert.ok(bound, '必须能读到真实绑定地址')
    assert.equal(bound.address, '127.0.0.1', `绑地址必须是 127.0.0.1，实际 ${bound.address}`)
    assert.equal(bound.family, 'IPv4', `必须是 IPv4，实际 ${bound.family}`)
    assert.equal(bound.port, port)
    assert.notEqual(bound.address, '0.0.0.0')
    assert.notEqual(bound.address, '::')
    return JSON.stringify(bound)
  })

  await check('S-02 非白名单 Host 一律 403，含 0.0.0.0 / ::1 / 局域网 IP', async () => {
    if (port == null) skip('桥未启动')
    for (const bad of [`0.0.0.0:${port}`, `[::1]:${port}`, `192.168.1.9:${port}`, `evil.com:${port}`, 'localhost.evil.com']) {
      const res = await request({ port, path: '/v1/health', headers: { Host: bad } })
      expectError(res, 'IMP-1005', 403)
    }
    return '5 种 Host 全部 403'
  })

  await check('② 8787 被占用时顺序回落到 8788（并回到 8787）', async () => {
    if (port == null) skip('桥未启动')
    if (!canUseDefaultPort) skip(`${BASE_PORT}/${FALLBACK_PORT} 被其它进程占用，无法断言默认端口回落`)
    await bridge.stop()
    assert.equal(bridge.status().state, 'stopped', '停止后状态应为 stopped')
    assert.equal(bridge.status().stateLabel, '已停止')
    assert.equal(await isRefused(BASE_PORT), true, '停止后端口不应再监听')
    const release = await occupy(BASE_PORT)
    try {
      const result = await bridge.start()
      assert.equal(result.port, FALLBACK_PORT, `应回落到 ${FALLBACK_PORT}，实际 ${result.port}`)
      port = result.port
      assert.equal(bridge.status().port, port)
      assert.equal(bridge.status().address, `http://127.0.0.1:${port}`)
    } finally {
      await release()
      await bridge.stop()
      const back = await bridge.start()
      port = back.port
    }
    return `占用 ${BASE_PORT} → 监听 ${FALLBACK_PORT} → 回到 ${port}`
  })

  await check('S-12 关闭本地桥后端口不再监听（真的 close，不是假装）', async () => {
    if (port == null) skip('桥未启动')
    const activePort = port
    await bridge.stop()
    const status = bridge.status()
    assert.equal(status.state, 'stopped')
    assert.equal(status.running, false)
    assert.equal(status.port, null)
    assert.equal(status.address, null)
    assert.equal(status.addressText, '—')
    assert.equal(bridge.getBoundAddress(), null, '关闭后不得还有 server 持有端口')
    assert.equal(await isRefused(activePort), true, `关闭后 ${activePort} 仍可连接`)
    const again = await bridge.start()
    port = again.port
    return `${activePort} 已不可达（未假装关闭）`
  })

  // -------------------------------------------------------------------------
  section('③④⑤⑥ 四道前置校验（顺序固定：Host → Origin → Content-Type → token）')
  // -------------------------------------------------------------------------
  await check('③ Host 缺失 → 400（HTTP/1.0 走应用层 IMP-1005；HTTP/1.1 被 Node 解析层先挡）', async () => {
    // HTTP/1.0 没有 Host 强制要求 → 一定到达我们的 handler。
    const raw = await rawRequest(port, 'POST /v1/import HTTP/1.0\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}')
    assert.equal(raw.status, 400, `HTTP/1.0 缺 Host 应为 400，实际 ${raw.status}`)
    assert.ok(raw.json, `应返回 JSON 错误体，实际 ${raw.text.slice(0, 120)}`)
    assert.equal(raw.json.error.code, 'IMP-1005')
    assert.equal(raw.json.error.http, 400)
    // HTTP/1.1 缺 Host：Node 的 HTTP 解析层直接 400（请求到不了应用层，绝不落盘）。
    const ver11 = await rawRequest(port, 'POST /v1/import HTTP/1.1\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}')
    assert.equal(ver11.status, 400, `HTTP/1.1 缺 Host 应为 400，实际 ${ver11.status}`)
    return `1.0 → 400 IMP-1005；1.1 → 400（解析层）`
  })

  await check('③ Host 存在但不在白名单 → 403 IMP-1005（detail 不泄漏内部信息）', async () => {
    const res = await request({ port, path: '/v1/health', headers: { Host: `not-localhost:${port}` } })
    const error = expectError(res, 'IMP-1005', 403)
    assert.equal(error.retryable, false)
    return '403 IMP-1005'
  })

  await check('S-03 Host: evil.com:8787 → 403 IMP-1005，且工作区无新文件', async () => {
    const before = listFilesRecursive(workspace).length
    const res = await postImport(port, token, validEnvelope(), { Host: `evil.com:${port}` })
    expectError(res, 'IMP-1005', 403)
    assert.equal(listFilesRecursive(workspace).length, before, '工作区不得出现新文件')
    assert.equal(holder.calls.length, 0, 'Host 校验失败不得转交渲染层')
    return '403 IMP-1005 且不落盘'
  })

  await check('③ Host 白名单 4 条形态都放行', async () => {
    for (const host of [`127.0.0.1:${port}`, '127.0.0.1', `localhost:${port}`, 'localhost']) {
      const res = await request({ port, path: '/v1/health', headers: { Host: host } })
      assert.equal(res.status, 200, `Host: ${host} 应通过，实际 ${res.status}`)
    }
    return '127.0.0.1[:port] / localhost[:port]'
  })

  await check('④ Origin: null（sandbox/iframe/data:）→ 403 IMP-3001', async () => {
    const res = await postImport(port, token, validEnvelope(), { Origin: 'null' })
    expectError(res, 'IMP-3001', 403)
    return '403 IMP-3001'
  })

  await check('S-04 Origin: https://evil.com → 403 IMP-3001 且响应无任何 CORS 头', async () => {
    const before = listFilesRecursive(workspace).length
    const res = await postImport(port, token, validEnvelope(), { Origin: 'https://evil.com' })
    expectError(res, 'IMP-3001', 403)
    const corsKeys = Object.keys(res.headers).filter((key) => key.startsWith('access-control-'))
    assert.deepEqual(corsKeys, [], `不得返回 CORS 头，实际 ${corsKeys.join(', ')}`)
    assert.equal(listFilesRecursive(workspace).length, before, '工作区不得出现新文件')
    return '403 且 0 个 access-control-* 头'
  })

  await check('④ 无 Origin 头（curl/CLI）放行', async () => {
    const res = await postImport(port, token, validEnvelope())
    assert.equal(res.status, 201, res.text.slice(0, 200))
    return '201（无 Origin 放行）'
  })

  await check('④ 本机回环来源精确回显，绝不用 * / 绝不 credentials（0.3.1 起按类型放行，不经白名单）', async () => {
    // ㉞：来源不再需要「入白名单」——`http://127.0.0.1:<port>` 按类型直接放行。
    assert.equal(bridge.status().origins.includes(DEV_ORIGIN), false, '本用例故意不把来源写进列表')
    const res = await postImport(port, token, validEnvelope(), { Origin: DEV_ORIGIN })
    assert.equal(res.status, 201, `应成功，实际 ${res.status} ${res.text.slice(0, 200)}`)
    assert.equal(res.headers['access-control-allow-origin'], DEV_ORIGIN, '必须精确回显来源')
    assert.notEqual(res.headers['access-control-allow-origin'], '*')
    assert.equal(res.headers['access-control-allow-credentials'], undefined, '绝不返回 credentials')
    assert.equal(res.headers.vary, 'Origin', 'Vary: Origin 必须存在')
    assert.match(String(res.headers['access-control-allow-headers']), /X-Opennote-Token/)
    assert.match(String(res.headers['access-control-allow-methods']), /POST/)
    assert.equal(res.headers['access-control-max-age'], '600')
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.match(String(res.headers['content-type']), /^application\/json; charset=utf-8$/)
    return `回显 ${res.headers['access-control-allow-origin']}`
  })

  await check('⑤ Content-Type: text/plain → 415 IMP-3004（拒绝 CSRF 简单请求）', async () => {
    const before = holder.calls.length
    const res = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: withHost(port, { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }),
      body: JSON.stringify(validEnvelope()),
    })
    expectError(res, 'IMP-3004', 415)
    assert.equal(holder.calls.length, before, 'Content-Type 校验失败不得转交渲染层')
    return '415 IMP-3004'
  })

  await check('⑤ form-urlencoded / multipart / 缺失 Content-Type 全部 415', async () => {
    const before = holder.calls.length
    for (const bad of ['application/x-www-form-urlencoded', 'multipart/form-data; boundary=x', undefined]) {
      const headers = { Authorization: `Bearer ${token}` }
      if (bad) headers['Content-Type'] = bad
      const res = await request({ port, path: '/v1/import', method: 'POST', headers: withHost(port, headers), body: 'x=1' })
      expectError(res, 'IMP-3004', 415)
    }
    assert.equal(holder.calls.length, before, 'Content-Type 校验失败不得转交渲染层')
    return '3 种全部 415'
  })

  await check('⑤ application/json; charset=utf-8 与 application/opennote+json 放行', async () => {
    for (const good of ['application/json; charset=utf-8', 'application/opennote+json']) {
      const res = await request({
        port,
        path: '/v1/import',
        method: 'POST',
        headers: withHost(port, { 'Content-Type': good, Authorization: `Bearer ${token}` }),
        body: JSON.stringify(validEnvelope()),
      })
      assert.equal(res.status, 201, `${good} 应放行，实际 ${res.status} ${res.text.slice(0, 160)}`)
    }
    return '2 种都放行'
  })

  await check('⑥ 无 Authorization → 401 IMP-2001（响应体不含 opn_）', async () => {
    const res = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: withHost(port, { 'Content-Type': 'application/json' }),
      body: JSON.stringify(validEnvelope()),
    })
    expectError(res, 'IMP-2001', 401)
    assert.equal(res.text.includes('opn_'), false, '响应体不得出现 opn_ 前缀')
    return '401 IMP-2001'
  })

  await check('⑥ 令牌格式错误（无 opn_ / 长度不符）→ 401 IMP-2002，且不回显令牌', async () => {
    for (const bad of ['not-a-token', 'opn_short', `opn_${'A'.repeat(44)}`, `X${token}`]) {
      const res = await postImport(port, bad, validEnvelope())
      expectError(res, 'IMP-2002', 401)
      assert.equal(res.text.includes(bad), false, '响应体不得回显令牌')
    }
    return '4 种格式全部 401 IMP-2002'
  })

  await check('⑥ 哈希不匹配的合法格式令牌 → 401 IMP-2002（X-Opennote-Token 同样校验）', async () => {
    const wrong = `opn_${crypto.randomBytes(32).toString('base64url')}`
    const res = await postImport(port, null, validEnvelope(), { 'X-Opennote-Token': wrong })
    expectError(res, 'IMP-2002', 401)
    assert.equal(res.text.includes(wrong), false)
    return 'X-Opennote-Token 一致'
  })

  await check('⑥ 正确令牌 → 201（正路）', async () => {
    const res = await postImport(port, token, validEnvelope())
    assert.equal(res.status, 201, res.text.slice(0, 200))
    return '201'
  })

  await check('OPTIONS 预检 → 204 空体、不校验令牌、带 CORS 头', async () => {
    const res = await request({
      port,
      path: '/v1/import',
      method: 'OPTIONS',
      headers: withHost(port, {
        Origin: DEV_ORIGIN,
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization,content-type',
      }),
    })
    assert.equal(res.status, 204, `预检应为 204，实际 ${res.status}`)
    assert.equal(res.text, '', '预检响应体必须为空')
    assert.equal(res.headers['access-control-allow-origin'], DEV_ORIGIN)
    assert.match(String(res.headers['access-control-allow-methods']), /POST/)
    return '204 空体 + CORS'
  })

  await check('OPTIONS 预检：未受信来源 → 403 IMP-3001 且无 CORS 头（预检不校验令牌）', async () => {
    const res = await request({
      port,
      path: '/v1/import',
      method: 'OPTIONS',
      headers: withHost(port, { Origin: 'https://evil.com', 'Access-Control-Request-Method': 'POST' }),
    })
    expectError(res, 'IMP-3001', 403)
    const corsKeys = Object.keys(res.headers).filter((key) => key.startsWith('access-control-'))
    assert.deepEqual(corsKeys, [], `预检失败也不得返回 CORS 头：${corsKeys.join(', ')}`)
    return '403 且无 CORS 头'
  })

  // -------------------------------------------------------------------------
  section('⑦ 来源按类型校验（0.3.1 ㉞）+ 配对已下线')
  // -------------------------------------------------------------------------
  await check('⑦ ①普通网页来源（https://evil.example）被拒 403 IMP-3001，且不回显 CORS', async () => {
    const res = await postImport(port, token, validEnvelope(), { Origin: 'https://evil.example' })
    expectError(res, 'IMP-3001', 403)
    assert.equal(res.headers['access-control-allow-origin'], undefined, '拒绝时不得回显任何 CORS 头')
    const pre = await request({
      port,
      path: '/v1/import',
      method: 'OPTIONS',
      headers: withHost(port, { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }),
    })
    expectError(pre, 'IMP-3001', 403)
    assert.equal(pre.headers['access-control-allow-origin'], undefined, '预检被拒也不得回显 CORS 头')
    assert.equal(bridge.status().lastRejectedOrigin, 'https://evil.example', 'R8 的拒绝记录行要能看到这个来源')
    return '403（含预检）+ lastRejectedOrigin 记录'
  })

  await check('⑦ ②扩展来源放行：chrome-extension:// 与 moz-extension:// 都能导入（精确回显 Origin）', async () => {
    for (const origin of [EXT_ORIGIN, MOZ_ORIGIN]) {
      const res = await postImport(port, token, validEnvelope(), { Origin: origin })
      assert.equal(res.status, 201, `【${origin}】应 201，实际 ${res.status} ${res.text.slice(0, 160)}`)
      assert.equal(res.headers['access-control-allow-origin'], origin, '必须精确回显该来源')
      assert.equal(res.headers['access-control-allow-credentials'], undefined, '绝不回 Allow-Credentials')
      assert.equal(res.headers['access-control-allow-origin'] === '*', false, '绝不用通配符')
    }
    return 'chrome-extension:// 与 moz-extension:// 都 201'
  })

  await check('⑦ ②b 本机回环与 file:// 放行；localhost / 伪造扩展 / null 一律 403', async () => {
    const allowed = [`http://127.0.0.1:${port}`, 'file://']
    for (const origin of allowed) {
      // 用 import 而不是 /v1/health：health 按设计不加任何 CORS 头，看不到回显。
      const res = await postImport(port, token, validEnvelope(), { Origin: origin })
      assert.equal(res.status, 201, `【${origin}】应放行，实际 ${res.status} ${res.text.slice(0, 160)}`)
      assert.equal(res.headers['access-control-allow-origin'], origin, '必须精确回显该来源')
    }
    const rejected = [
      'https://evil.example',
      'http://localhost:5173',
      'http://127.0.0.1.evil.example',
      'chrome-extension://ABC',
      'CHROME-EXTENSION://abcdefghijklmnopabcdefghijklmnop',
      'safari-web-extension://abcdefghijklmnopabcdefghijklmnop',
      'null',
    ]
    for (const origin of rejected) {
      const res = await withOrigin(port, origin)
      expectError(res, 'IMP-3001', 403)
      assert.equal(res.headers['access-control-allow-origin'], undefined, `【${origin}】不得回显 CORS 头`)
    }
    // 历史遗留的 allowedOrigins 列表**已经不参与放行判定**：塞进去也不放行。
    assert.equal(bridge.addAllowedOrigin('https://evil.example'), true)
    const forced = await withOrigin(port, 'https://evil.example')
    expectError(forced, 'IMP-3001', 403)
    assert.equal(bridge.removeAllowedOrigin('https://evil.example'), true, '遗留条目应可清理（removeOrigin 保留的用途）')
    return `放行 ${allowed.length} 类；拒绝 ${rejected.length} 类；列表已不参与放行`
  })

  await check('⑦ ③ POST /v1/pair 明确「已下线」：404 + 文案说清改用令牌，不得静默 404 无说明', async () => {
    const retired = await postPair(port, '123456', EXT_ORIGIN)
    expectError(retired, 'IMP-3005', 404)
    const error = retired.json.error
    assert.match(error.userMessage, /配对/, '文案必须说明配对这件事')
    assert.match(error.userMessage, /删除|下线|取消/, '文案必须说清「已经删除」')
    assert.match(error.userMessage, /0\.3\.1/, '文案必须点明版本')
    assert.match(error.userMessage, /令牌/, '文案必须给出替代方式（复制令牌）')
    assert.equal(error.detail.route, '/v1/pair')
    assert.equal(error.detail.removedIn, '0.3.1')
    assert.notEqual(error.userMessage, ERROR_TABLE['IMP-3005'].userMessage, '必须是针对本路由的说明，不能是通用 404 文案')
    // 已下线的路由不得成为绕过其它校验的口子：普通网页来源仍然被拒。
    const fromWeb = await request({
      port,
      path: '/v1/pair',
      method: 'POST',
      headers: withHost(port, { 'Content-Type': 'application/json', Origin: 'https://evil.example' }),
      body: JSON.stringify({ code: '123456' }),
    })
    expectError(fromWeb, 'IMP-3001', 403)
    assert.equal(bridge.status().origins.includes(EXT_ORIGIN), false, '下线路由绝不得写 allowedOrigins')
    return `404 + 「${error.userMessage.slice(0, 24)}…」`
  })

  await check('⑦ ④令牌长期有效：桥重启后同一令牌仍可用；只有「重新生成」能让它失效', async () => {
    const dir = tempDir('opennote-bridge-longtoken-')
    const first = makeBridge({ dataDir: dir })
    const shared = first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(privatePortCounter++)
    try {
      const ok = await postImport(up.port, shared, validEnvelope())
      assert.equal(ok.status, 201, '重启前应可用')
    } finally {
      await first.bridge.stop()
    }
    // 「关掉 Opennote 再打开」：同一 dataDir 起一个新实例读回哈希。
    const second = makeBridge({ dataDir: dir })
    const status = second.bridge.status()
    assert.equal(status.tokenSet, true, '重启后应读回令牌哈希')
    assert.equal('pairingCode' in status, false, 'status() 不得再有配对码字段')
    assert.equal('lastPairing' in status, false, 'status() 不得再有配对结果字段')
    const again = await second.bridge.startWithPort(privatePortCounter++)
    try {
      const reused = await postImport(again.port, shared, validEnvelope())
      assert.equal(reused.status, 201, `重启后同一令牌必须仍可用（长期有效），实际 ${reused.status}`)
      second.bridge.regenerateToken()
      const stale = await postImport(again.port, shared, validEnvelope())
      expectError(stale, 'IMP-2002', 401)
    } finally {
      await second.bridge.stop()
    }
    return '重启后同一令牌 201；重新生成后旧令牌 401'
  })

  await check('㊴ 明文随时可复制：tokenVisible=true，且明文不进 status()', async () => {
    const inst = makeBridge({})
    const plain = inst.bridge.regenerateToken()
    const first = inst.bridge.status()
    assert.equal(first.tokenVisible, true, '刚生成后本会话必须持有明文')
    const json = JSON.stringify(first)
    assert.equal(json.includes(plain), false, 'status() 绝不回显明文')
    assert.equal(/opn_[A-Za-z0-9_-]{20,}/.test(json), false, 'status() 不得出现任何完整令牌')
    // 关掉接口再开不该影响明文：明文在盘上，面板开关一次后仍然能复制。
    await inst.bridge.startWithPort(privatePortCounter++)
    await inst.bridge.stop()
    assert.equal(inst.bridge.status().tokenVisible, true, 'stop() 不得清掉明文（㊴：明文在盘上，生命周期停止与它无关）')
    const again = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal(inst.bridge.status().tokenVisible, true, 'start() 后仍应可复制')
      const res = await postImport(again.port, plain, validEnvelope())
      assert.equal(res.status, 201, '本会话内这串明文必须一直可用')
    } finally {
      await inst.bridge.stop()
    }
    return 'tokenVisible=true 跨 start/stop 保持；明文不出现在 status()'
  })

  await check('㊴① 重启（新 controller）后**立刻**能取回明文：明文落盘，不再有「已不可见」', async () => {
    const dir = tempDir('opennote-bridge-plaintext-')
    const first = makeBridge({ dataDir: dir })
    const plain = first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201)
    } finally {
      await first.bridge.stop()
    }
    // 应用重启 = 新的 controller。㊲ 时代这里读回 null（要用户重新生成才能再复制）；
    // ㊴ 之后**直接就能取回** —— 这正是用户要的「随时能复制」。
    const second = makeBridge({ dataDir: dir })
    const status = second.bridge.status()
    assert.equal(second.bridge.getSessionPlaintext(), plain, '㊴：新 controller 必须立刻能取回磁盘上的明文')
    assert.equal(status.tokenVisible, true, 'tokenVisible 必须为 true —— 面板据此才能给出可点的「复制」')
    assert.equal(status.tokenSet, true, '令牌本身仍然有效')
    assert.equal(JSON.stringify(status).includes(plain), false, 'status() 绝不回显明文（落盘 ≠ 到处乱放）')
    const again = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(again.port, plain, validEnvelope())).status, 201, '令牌长期有效：重启不影响')
      // 重新生成 → 盘上的明文同步换成新串；旧令牌同时作废。
      const fresh = second.bridge.regenerateToken()
      assert.equal(second.bridge.getSessionPlaintext(), fresh, '重新生成后取回的必须是新串')
      assert.notEqual(fresh, plain)
      expectError(await postImport(again.port, plain, validEnvelope()), 'IMP-2002', 401)
      const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'))
      assert.equal(onDisk.tokenPlaintext, fresh, '重新生成必须同步改写盘上的明文（否则重启后复制到的是废令牌）')
    } finally {
      await second.bridge.stop()
    }
    return '重启后立刻取回同一串明文且令牌仍 201；重新生成换新、盘上同步、旧令牌 401'
  })

  await check('㊴② bridge.json 里确实有明文（与 sha256 / last4 并列），且明文不进日志', async () => {
    const dir = tempDir('opennote-bridge-plaintextfile-')
    const inst = makeBridge({ dataDir: dir })
    const plain = inst.bridge.regenerateToken()
    await inst.bridge.startWithPort(privatePortCounter++)
    await inst.bridge.stop()
    const raw = fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8')
    const parsed = JSON.parse(raw)
    // 这条断言就是面板披露句的**事实依据**：句子里说「明文保存在 bridge.json 里」，
    // 那就必须真的在那里 —— 否则披露句又变成假话（只是假的方向反了过来）。
    assert.equal(parsed.tokenPlaintext, plain, 'bridge.json 必须与 sha256 / last4 并列存明文')
    assert.equal(/^opn_[A-Za-z0-9_-]{43}$/.test(parsed.tokenPlaintext), true, '盘上那串必须是完整 47 字符明文，不是掩码')
    assert.equal(parsed.tokenHash, sha256Hex(plain), '哈希与明文必须对应同一串')
    assert.equal(parsed.tokenLast4, plain.slice(-4))
    assert.equal(raw.includes('••'), false, '盘上不得存掩码形态')
    // 明文只允许落在这一个文件里：日志里出现就等于「到处乱放」。
    const log = path.join(dir, 'bridge.log')
    if (fs.existsSync(log)) {
      assert.equal(fs.readFileSync(log, 'utf8').includes(plain), false, '日志里不得出现令牌明文')
    }
    return `bridge.json 含明文 ${plain.length} 字符 + 对应哈希 + 后四位；日志无明文`
  })

  await check('㊴ setTokenHash 读回外部哈希时必须丢弃盘上明文（否则会复制一串不对应的令牌）', async () => {
    const inst = makeBridge({ noWindow: true })
    inst.bridge.regenerateToken()
    assert.equal(inst.bridge.status().tokenVisible, true)
    const other = createBridge({ log: () => {} })
    const otherPlain = other.regenerateToken()
    assert.equal(inst.bridge.setTokenHash(sha256Hex(otherPlain), otherPlain.slice(-4)), true)
    assert.equal(inst.bridge.status().tokenVisible, false, '明文与哈希不再对应 → 必须丢弃')
    assert.equal(inst.bridge.getSessionPlaintext(), null, '只读频道同理：读回 null，不得交出不对应的明文')
    assert.equal(inst.bridge.status().tokenLast4, otherPlain.slice(-4))
    return 'setTokenHash → 明文丢弃 / 只读频道 null'
  })

  await check('㊴ getSessionPlaintext() 与「面板可复制的那串」逐字相同，而且真的能用', async () => {
    const inst = makeBridge({})
    const plain = inst.bridge.regenerateToken()
    const read = inst.bridge.getSessionPlaintext()
    assert.equal(read, plain, '读回来的必须与生成的明文逐字相同（面板就是把这串放进剪贴板）')
    assert.equal(read.length, 47, '47 字符 = `opn_` + 43 base64url；不是掩码、不是后四位')
    assert.equal(read.startsWith('opn_'), true)
    assert.equal(read.includes('•'), false, '不得返回掩码形态')
    assert.notEqual(read, sha256Hex(plain), '不得返回哈希')
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      // 用「面板可复制的那串」直接导入：逐字相同还不够，它必须真的是那把钥匙。
      const res = await postImport(up.port, read, validEnvelope())
      assert.equal(res.status, 201, '面板复制的那串必须真的能导入')
    } finally {
      await inst.bridge.stop()
    }
    return `${read.length} 字符、非掩码非哈希；直接用它导入 201`
  })

  await check('㊴ 只读频道绝不轮换：连调两次同一串，读取前后旧令牌都能导入', async () => {
    const inst = makeBridge({})
    const plain = inst.bridge.regenerateToken()
    const before = inst.bridge.status()
    const a = inst.bridge.getSessionPlaintext()
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201, '读取之前旧令牌可用')
      const b = inst.bridge.getSessionPlaintext()
      assert.equal(a, b, '两次读取必须同一串 —— 轮换会让面板复制到一串即将失效的令牌')
      assert.equal(a, plain)
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201, '读取之后旧令牌**仍然**可用：只读不得有副作用')
    } finally {
      await inst.bridge.stop()
    }
    assert.equal(inst.bridge.status().tokenLast4, before.tokenLast4, '后四位不得变（= 哈希没被改写）')
    assert.equal(inst.bridge.status().tokenVisible, true, '读一次不该把「可复制」读没')
    return '两次同一串；读取前后旧令牌都 201，tokenLast4 不变'
  })

  await check('㊴ 重启（新 controller）后只读频道返回**同一串**明文，令牌也仍然有效', async () => {
    const dir = tempDir('opennote-bridge-sessiontoken-')
    const first = makeBridge({ dataDir: dir })
    const plain = first.bridge.regenerateToken()
    assert.equal(first.bridge.getSessionPlaintext(), plain)
    // 应用重启 = 新的 controller。㊴ 之后明文从磁盘读回，所以这里**不是** null。
    const second = makeBridge({ dataDir: dir })
    assert.equal(second.bridge.getSessionPlaintext(), plain, '㊴：读盘后必须拿到同一串（面板要能直接复制）')
    assert.equal(second.bridge.status().tokenVisible, true)
    assert.equal(second.bridge.status().tokenSet, true)
    const up = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201, '令牌本身仍然有效')
      assert.equal(second.bridge.getSessionPlaintext(), plain, '再读一次仍是同一串（只读、无副作用）')
    } finally {
      await second.bridge.stop()
    }
    return '重启后读回同一串明文；令牌仍 201'
  })

  await check('㊴③ 面板里再没有任何「已不可见 / 本会话内可以反复复制」的用户可见文案', async () => {
    const panel = fs.readFileSync(PANEL_PATH, 'utf8')
    // 只看**字符串字面量**：注释里保留这段历史是对的（它记录了 task-22 那个矛盾），
    // 但**给用户看的字**不能再出现 ㊲ 的措辞 —— 那些话在 ㊴ 之后已经是假话。
    const literals = (panel.match(/"(?:[^"\\]|\\.)*"/g) || []).map((item) => JSON.parse(item))
    for (const banned of ['已不可见', '本会话内可以反复复制', '本会话内可反复复制', '绝不落盘', '明文只在生成']) {
      const hit = literals.find((text) => text.includes(banned))
      assert.equal(hit === undefined, true, `面板还有用户可见文案在说「${banned}」：${String(hit)}`)
    }
    // 也不许再出现 ㊲ 时代的两个常量名（删掉的东西不该留壳）。
    assert.equal(panel.includes('R4_INVISIBLE'), false, 'R4_INVISIBLE 必须删掉')
    assert.equal(panel.includes('R4_RELOADED'), false, 'R4_RELOADED 必须删掉')
    return `${literals.length} 条字面量里没有 ㊲ 措辞；R4_INVISIBLE / R4_RELOADED 已删`
  })

  await check('㊴④ 披露句逐字 = ㊴ 新版（好处 → 文件位置 → 新增暴露面 → 只提供导入）', async () => {
    const panel = fs.readFileSync(PANEL_PATH, 'utf8')
    const pick = (name) => {
      const at = panel.indexOf(`const ${name} =`)
      assert.notEqual(at, -1, `面板里找不到 ${name}`)
      const literal = panel.slice(at).match(/"(?:[^"\\]|\\.)*"/)
      assert.notEqual(literal, null, `${name} 不是字符串字面量`)
      return JSON.parse(literal[0])
    }
    // 测试自己就是「第二个产地」，所以这里**冻死**期望值：面板改了句子而没改这里的期望，
    // 或者反过来，都必须红。四个要点一个都不能少。
    const expected =
      '在新客户端里粘贴一次即可，长期有效、不用再配对。令牌明文就保存在本机 Opennote 数据目录的 bridge.json 里，所以任何时候都能复制。任何能读到这个文件、剪贴板或扩展存储的程序，都能拿到这串令牌并获得导入能力；桥只提供导入，不提供读取和删除。'
    assert.equal(pick('TOKEN_COST_HINT'), expected, '披露句必须逐字等于 ㊴ 冻结版（Lead 已同步 02/03）')
    for (const must of ['bridge.json', '任何时候都能复制', '这个文件、剪贴板或扩展存储', '不提供读取和删除']) {
      assert.equal(expected.includes(must), true, `披露句必须说清「${must}」`)
    }
    // 没有数据目录时那句必须**不**声称「保存在 bridge.json 里」，否则又是一句假话。
    const noDisk = pick('TOKEN_NO_DISK_HINT')
    assert.equal(noDisk.includes('bridge.json'), false, '没有数据目录时不得再说「保存在 bridge.json 里」')
    assert.equal(noDisk.includes('不提供读取和删除'), true, '两种情况都必须保留「只提供导入」这一半')
    assert.equal(panel.includes('status?.tokenPersisted === false ? TOKEN_NO_DISK_HINT'), true, '披露句必须按事实分支渲染')
    return '披露句逐字冻结版 + 无数据目录分支；两个分支都保留「只提供导入」'
  })

  await check('㊴ 明文绝不外溢：status() 的 JSON 里不含 `opn_` 前缀子串', async () => {
    const inst = makeBridge({ noWindow: true })
    const plain = inst.bridge.regenerateToken()
    const json = JSON.stringify(inst.bridge.status())
    assert.equal(json.includes('opn_'), false, 'status() 不得出现任何 `opn_` 前缀子串')
    assert.equal(json.includes(plain), false)
    assert.equal(json.includes(plain.slice(-8)), false, '连后 8 位也不额外外溢（只有后 4 位是有意公开的）')
    assert.equal(json.includes('sessionPlaintext'), false, '连内存字段名都不该出现')
    return 'status() 无 opn_ 子串、无明文中段、无内存字段名'
  })

  await check('㊴ tokenVisible 要能穿过 IPC：main.cjs 的 bridgeStatusPayload 必须 `...raw` 展开', async () => {
    // 第 4 类「假开关」缺陷就是这么来的：桥给了字段，主进程逐字段重建 payload 时静默丢掉。
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    const start = main.indexOf('function bridgeStatusPayload()')
    assert.notEqual(start, -1, 'main.cjs 里找不到 bridgeStatusPayload()')
    const body = main.slice(start, start + 4000)
    assert.equal(body.includes('...raw'), true, '必须展开 `...raw` —— 否则 tokenVisible 这类字段传不到渲染层，面板只会永远显示「不可见」')
    const spread = body.indexOf('...raw')
    const explicit = body.indexOf('state: raw.state')
    if (explicit > -1) assert.equal(spread < explicit, true, '`...raw` 必须在显式字段之前（否则显式字段之外的都会被丢掉）')
    // IPC 是结构化克隆 / JSON 序列化：字段必须能往返，不能是 undefined 或函数。
    const inst = makeBridge({ noWindow: true })
    inst.bridge.regenerateToken()
    const roundTrip = JSON.parse(JSON.stringify(inst.bridge.status()))
    assert.equal(roundTrip.tokenVisible, true, 'tokenVisible 必须在序列化后仍然可读')
    assert.equal(typeof roundTrip.tokenVisible, 'boolean')
    return 'payload 展开 ...raw；tokenVisible 可序列化往返'
  })

  await check('㊴ 只读频道三处接线必须一致（preload arity 0 / main 走只读方法 / 不得挂到轮换）', async () => {
    // 「同一个值的多个产地」：频道名、arity、以及 main 到底调用哪个控制器方法，三处都要咬合。
    const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.cjs'), 'utf8')
    assert.equal(
      /const BRIDGE_TOKEN_CHANNEL = 'opennote:bridge:token'/.test(preload),
      true,
      'preload 必须有 `opennote:bridge:token` 频道常量',
    )
    assert.equal(
      /token:\s*\(\)\s*=>\s*invoke\(BRIDGE_TOKEN_CHANNEL\)/.test(preload),
      true,
      'preload 的 `token` 必须是 arity 0（不传任何参数）',
    )
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    // main 用的是字面频道名（没有常量），所以按字面量定位到**这一个 handler**，
    // 窗口切到下一个 `handle(` 为止 —— 否则会把旁边 newToken 的 regenerateToken 算进来。
    const at = main.indexOf("'opennote:bridge:token'")
    assert.notEqual(at, -1, 'main.cjs 没有接上这条频道')
    const next = main.indexOf('\n  handle(', at)
    const handler = main.slice(at, next === -1 ? at + 800 : next)
    assert.equal(
      handler.includes('getSessionPlaintext'),
      true,
      'main 必须调用只读的 getSessionPlaintext()',
    )
    assert.equal(
      /regenerateToken/.test(handler),
      false,
      '只读频道**绝不能**接到 regenerateToken —— 那会让「复制令牌」变成静默轮换、把已配置的客户端全部踢下线',
    )
    return 'preload arity 0 → main → getSessionPlaintext（未接轮换）'
  })

  await check('⑦ IMP-2004 保留码号但不再产出；IMP-2001 语义为「还没配置令牌」；配对实现零残留', async () => {
    assert.equal(typeof ERROR_TABLE['IMP-2004'], 'object', '码号必须留在表里（不得复用给别的语义）')
    assert.equal(
      ERROR_TABLE['IMP-2001'].userMessage,
      '这个客户端还没有配置访问令牌。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。',
      'IMP-2001 文案必须逐字（02 附录 A.3 由 d-contract 同步）',
    )
    // 无令牌 → 401 IMP-2001，且 userMessage 不再提「配对」。
    const noToken = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: { Host: `127.0.0.1:${port}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(validEnvelope()),
    })
    expectError(noToken, 'IMP-2001', 401)
    assert.equal(/配对/.test(noToken.json.error.userMessage), false, 'IMP-2001 文案里不得再提配对')
    // 源码级：配对实现必须删干净（行为断言之外再钉一层）。
    const source = fs.readFileSync(BRIDGE_PATH, 'utf8')
    for (const name of [
      'newPairCode',
      'clearPairCode',
      'verifyPairCode',
      'handlePair',
      'pendingPlaintext',
      'takeDeliverableToken',
      'PAIR_CODE_TTL_MS',
      'PAIR_FAIL_LIMIT',
      'PAIR_ATTEMPT_LIMIT',
      'pairBucket',
      'pairAttemptWindow',
      'lastPairing',
      'pairingCode',
      'pairingCodeExpiresAt',
    ]) {
      assert.equal(source.includes(name), false, `桥里不得再残留配对实现：${name}`)
    }
    // IMP-2004 的唯一合法出现位置是 ERROR_TABLE 定义那一行（作废注释可以提它）。
    const productive = source
      .split('\n')
      .filter((line) => line.includes('IMP-2004') && !line.includes("'IMP-2004':") && !line.includes('//'))
    assert.deepEqual(productive.map((line) => line.trim()), [], '不得有任何代码路径产出 IMP-2004')
    return '码号保留 / 不再产出 / 实现零残留 / IMP-2001 逐字'
  })
  // -------------------------------------------------------------------------
  section('⑨ 合法信封经 onEnvelope 转交并返回回执（桥不写笔记正文）')
  // -------------------------------------------------------------------------
  await check('⑨ onEnvelope 收到信封与 client meta，回执映射为 201', async () => {
    const before = holder.calls.length
    const envelope = validEnvelope()
    const res = await postImport(port, token, envelope, { Origin: DEV_ORIGIN })
    assert.equal(res.status, 201, res.text.slice(0, 200))
    assert.equal(holder.calls.length, before + 1, '应恰好转交一次')
    const call = holder.calls[holder.calls.length - 1]
    assert.equal(call.meta.clientName, 'chrome-extension')
    assert.equal(call.meta.clientVersion, '0.1.4')
    const forwarded = JSON.parse(call.envelopeJson)
    assert.equal(forwarded.spec, 'opennote.import/v1')
    assert.equal(forwarded.importId, envelope.importId)
    assert.equal(forwarded.title, envelope.title)
    assert.equal(res.json.ok, true)
    assert.equal(res.json.result.status, 'created')
    assert.equal(res.json.result.importId, envelope.importId)
    return `201 / status=${res.json.result.status}`
  })

  await check('桥不在主进程写任何笔记正文（工作区除 .opennote 外零文件）', async () => {
    const notesRoot = path.join(workspace, '.opennote')
    const files = listFilesRecursive(workspace).filter((file) => file !== notesRoot && !file.startsWith(notesRoot + path.sep))
    assert.deepEqual(files, [], `桥不得写笔记：${files.join(', ')}`)
    // .opennote 下也只允许 inbox/<entry>/state.json（本用例此刻还没写过）。
    return '工作区 0 个笔记文件'
  })

  await check('⑨ 渲染层返回 status=deduped → HTTP 200 且 deduped=true', async () => {
    const original = renderer.handle.bind(renderer)
    renderer.handle = async (json, meta) => {
      const receipt = await original(json, meta)
      if (receipt.ok) {
        receipt.result.status = 'deduped'
        receipt.result.deduped = true
        receipt.result.dedupedBy = 'importId'
      }
      return receipt
    }
    const res = await postImport(port, token, validEnvelope())
    renderer.handle = original
    assert.equal(res.status, 200, `去重应为 200，实际 ${res.status}`)
    assert.equal(res.json.result.deduped, true)
    return '200 deduped'
  })

  await check('⑨ folder 越界（../../etc）→ 422 IMP-4008，且工作区外无新文件', async () => {
    const before = listFilesRecursive(path.dirname(workspace)).filter((file) => file.startsWith(workspace)).length
    const res = await postImport(port, token, validEnvelope({ target: { folder: '../../etc', notePath: null } }))
    expectError(res, 'IMP-4008', 422)
    const after = listFilesRecursive(path.dirname(workspace)).filter((file) => file.startsWith(workspace)).length
    assert.equal(after, before, '越界请求不得产生任何文件')
    // 桥侧先拦（§2.4 的落点层规则：`..` 段是**非法**，不是「不存在」）；渲染层的 `assertSafeRelative()`
    // 仍然独立跑一遍（02 §7.3），两层给的是同一个码号。
    return '422 IMP-4008（桥侧落点层先拦）'
  })

  await check('S-09 桥侧直接拒绝信封里的绝对路径 target.folder', async () => {
    for (const folder of ['C:\\Windows\\Temp', '/etc/passwd', '\\\\server\\share', 'D:/x']) {
      const res = await postImport(port, token, validEnvelope({ target: { folder, notePath: null } }))
      expectError(res, 'IMP-4008', 422)
    }
    return '4 种绝对路径全部 422'
  })

  await check('桥不接受来自信封的「落盘绝对路径」字段（未知字段被忽略而不是当路径用）', async () => {
    const before = holder.calls.length
    const res = await postImport(port, token, validEnvelope({ absolutePath: 'C:\\Windows\\Temp\\pwn.md', root: 'C:\\' }))
    assert.equal(res.status, 201, res.text.slice(0, 200))
    assert.equal(holder.calls.length, before + 1)
    // 桥只把原始 JSON 转交，绝不自己解释这些字段。
    const forwarded = JSON.parse(holder.calls[holder.calls.length - 1].envelopeJson)
    assert.equal(forwarded.absolutePath, 'C:\\Windows\\Temp\\pwn.md')
    const outside = fs.existsSync('C:\\Windows\\Temp\\pwn.md')
    assert.equal(outside, false, '不得在绝对路径落盘')
    return '原样转交渲染层，桥不落盘'
  })

  await check('窗口不在场（getWindow() === null）→ 409 IMP-4006，不假成功', async () => {
    const offline = makeBridge({ noWindow: true })
    const offlineToken = offline.bridge.regenerateToken()
    const started = await offline.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postImport(started.port, offlineToken, validEnvelope())
      const error = expectError(res, 'IMP-4006', 409)
      assert.equal(error.retryable, true, 'IMP-4006 必须 retryable')
      assert.equal(offline.holder.calls.length, 0, '窗口不在场时不得调用 onEnvelope')
    } finally {
      await offline.bridge.stop()
    }
    return '409 IMP-4006'
  })

  await check('渲染层抛异常 → 500 IMP-5001（不假成功）', async () => {
    const broken = makeBridge({})
    broken.renderer.mode = 'throw'
    const brokenToken = broken.bridge.regenerateToken()
    const started = await broken.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postImport(started.port, brokenToken, validEnvelope())
      expectError(res, 'IMP-5001', 500)
    } finally {
      await broken.bridge.stop()
    }
    return '500 IMP-5001'
  })

  await check('overwrite：进阶开关关闭 → 桥侧降级为 new 并带 IMP-4011 警告', async () => {
    const before = holder.calls.length
    const res = await postImport(port, token, validEnvelope({ conflict: 'overwrite', target: { folder: '剪藏', notePath: '剪藏/旧.md' } }))
    assert.equal(res.status, 201, res.text.slice(0, 200))
    assert.equal(holder.calls.length, before + 1)
    const forwarded = JSON.parse(holder.calls[holder.calls.length - 1].envelopeJson)
    assert.equal(forwarded.conflict, 'new', 'overwrite 必须被桥降级为 new')
    assert.ok(res.json.result.warnings.includes('IMP-4011'), `回执必须带 IMP-4011，实际 ${JSON.stringify(res.json.result.warnings)}`)
    return 'conflict=new + IMP-4011'
  })

  await check('overwrite：进阶开关开启 → 原样透传渲染层', async () => {
    const advanced = makeBridge({ advancedOverwrite: true })
    const advancedToken = advanced.bridge.regenerateToken()
    const started = await advanced.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postImport(started.port, advancedToken, validEnvelope({ conflict: 'overwrite' }))
      assert.equal(res.status, 201, res.text.slice(0, 200))
      const forwarded = JSON.parse(advanced.holder.calls[advanced.holder.calls.length - 1].envelopeJson)
      assert.equal(forwarded.conflict, 'overwrite', '四条件齐备时必须透传')
    } finally {
      await advanced.bridge.stop()
    }
    return 'overwrite 透传'
  })

  // -------------------------------------------------------------------------
  section('⑧ 限流与体积上限（默认限流，独立实例）')
  // -------------------------------------------------------------------------
  await check('⑧ 令牌桶（容量 10 / 补充 60 每分钟）：61 次内触发 429 IMP-4015 + Retry-After', async () => {
    const rate = makeBridge({})
    const rateToken = rate.bridge.regenerateToken()
    const started = await rate.bridge.startWithPort(privatePortCounter++)
    try {
      let created = 0
      let tooMany = 0
      let retryAfterSeen = false
      for (let i = 0; i < 61; i += 1) {
        const res = await postImport(started.port, rateToken, validEnvelope())
        if (res.status === 201) created += 1
        else if (res.status === 429) {
          tooMany += 1
          expectError(res, 'IMP-4015', 429)
          if (res.headers['retry-after']) retryAfterSeen = true
        } else {
          throw new Error(`第 ${i + 1} 次请求意外状态 ${res.status}：${res.text.slice(0, 160)}`)
        }
      }
      assert.ok(created >= 10, `容量 10 应全部放行，实际成功 ${created}`)
      assert.ok(created <= 14, `限流必须真的生效（容量 10 + 少量补充），实际成功 ${created}/61`)
      assert.ok(tooMany > 0, '应触发 429')
      assert.equal(retryAfterSeen, true, '429 必须带 Retry-After')
      return `201×${created} / 429×${tooMany}（Retry-After 齐备）`
    } finally {
      await rate.bridge.stop()
    }
  })

  await check('⑧ 鉴权失败 10 次/分钟 → 第 11 次 429 IMP-2003', async () => {
    const auth = makeBridge({})
    auth.bridge.regenerateToken()
    const started = await auth.bridge.startWithPort(privatePortCounter++)
    try {
      const codes = []
      for (let i = 0; i < 11; i += 1) {
        const res = await postImport(started.port, `opn_${'A'.repeat(43)}`, validEnvelope())
        codes.push(`${res.status}:${res.json && res.json.error ? res.json.error.code : '?'}`)
      }
      assert.equal(codes[9], '401:IMP-2002', `第 10 次应为 401 IMP-2002，实际 ${codes[9]}`)
      assert.equal(codes[10], '429:IMP-2003', `第 11 次应为 429 IMP-2003，实际 ${codes[10]}`)
      return `${codes[0]} … ${codes[9]} → ${codes[10]}`
    } finally {
      await auth.bridge.stop()
    }
  })

  await check('S-10 Content-Length 32 MiB + 畸形 JSON → 413 IMP-4005（未解析 JSON）', async () => {
    const res = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: withHost(port, {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Length': String(32 * 1024 * 1024),
      }),
      headersOnly: true,
    })
    expectError(res, 'IMP-4005', 413)
    assert.match(String(res.headers.connection || ''), /close/i, '应声明 Connection: close')
    return '413 IMP-4005（不读 body、不解析 JSON）'
  })

  await check('chunked 超 16 MiB → 413 IMP-4005 或直接掐断连接', async () => {
    const res = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: '/v1/import',
          headers: withHost(port, {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'Transfer-Encoding': 'chunked',
          }),
        },
        (res) => {
          const chunks = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let json = null
            try {
              json = JSON.parse(text)
            } catch {
              json = null
            }
            resolve({ status: res.statusCode, headers: res.headers, text, json })
          })
          res.on('error', () => resolve({ status: 0, headers: {}, text: 'aborted', json: null }))
        },
      )
      req.on('error', (error) => resolve({ status: 0, headers: {}, text: String(error && error.message), json: null }))
      const chunk = Buffer.alloc(1024 * 1024, 0x61)
      let sent = 0
      const pump = () => {
        while (sent < 17) {
          sent += 1
          if (!req.write(chunk)) {
            req.once('drain', pump)
            return
          }
        }
        req.end()
      }
      pump()
    })

    if (res.status === 0) return '连接被服务端掐断（符合「超限立即销毁连接」）'
    expectError(res, 'IMP-4005', 413)
    return '413 IMP-4005'
  })

  // -------------------------------------------------------------------------
  section('其它接口与请求形态')
  // -------------------------------------------------------------------------
  await check('未知路径 → 404 IMP-3005；/v1/import 用 GET → 404', async () => {
    const unknown = await request({ port, path: '/v1/nope', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    expectError(unknown, 'IMP-3005', 404)
    const wrongMethod = await request({ port, path: '/v1/import', method: 'GET', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    expectError(wrongMethod, 'IMP-3005', 404)
    return '两条 404'
  })

  await check('空 body → IMP-3003；畸形 JSON → IMP-3002；数组 → IMP-4001', async () => {
    const empty = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: withHost(port, { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, 'Content-Length': '0' }),
      body: '',
    })
    expectError(empty, 'IMP-3003', 400)
    const broken = await request({
      port,
      path: '/v1/import',
      method: 'POST',
      headers: jsonHeaders(port, token),
      body: '{"spec": ',
    })
    expectError(broken, 'IMP-3002', 400)
    const array = await request({ port, path: '/v1/import', method: 'POST', headers: jsonHeaders(port, token), body: '[1,2,3]' })
    expectError(array, 'IMP-4001', 400)
    const scalar = await request({ port, path: '/v1/import', method: 'POST', headers: jsonHeaders(port, token), body: '"x"' })
    expectError(scalar, 'IMP-4001', 400)
    return '3003 / 3002 / 4001 / 4001'
  })

  await check('GET /v1/imports/{id} → 命中 200，未命中 404 IMP-4017', async () => {
    const hit = await request({ port, path: '/v1/imports/known-id', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    assert.equal(hit.status, 200, hit.text.slice(0, 160))
    assert.equal(hit.json.result.importId, 'known-id')
    const miss = await request({ port, path: '/v1/imports/unknown-id', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    expectError(miss, 'IMP-4017', 404)
    return '200 / 404'
  })

  await check('GET /v1/health 字段齐全，且不返回绝对路径 / 用户名 / 笔记标题', async () => {
    const res = await request({ port, path: '/v1/health', headers: withHost(port) })
    assert.equal(res.status, 200)
    const result = res.json.result
    assert.equal(result.bridge, 'running')
    assert.equal(result.spec, 'opennote.import/v1')
    assert.equal(result.app, PKG_VERSION, 'health 回的应用版本必须与 package.json 逐字一致（挂钩优先）')
    assert.equal(result.port, port)
    assert.equal(result.authRequired, true)
    assert.equal(result.inbox, false)
    // ㉕：主桥没接 getInboxMode → 必须是 null（桥不知道就说不知道，不得假装 direct）。
    assert.equal(result.inboxMode, null, '没接 getInboxMode 时必须如实返回 null')
    assert.equal(result.workspace.open, true, 'workspace.open 必须如实返回（插件据此区分 IMP-4007）')
    assert.equal(result.workspace.name, '我的笔记')
    assert.equal(typeof result.time, 'string')
    for (const key of ['root', 'path', 'username', 'notes', 'noteCount']) {
      assert.equal(key in result.workspace, false, `health 不得返回 workspace.${key}`)
    }
    assert.equal(res.text.includes(workspace), false, 'health 不得泄漏工作区绝对路径')
    assert.equal(res.text.includes(token), false, 'health 不得回显令牌')
    assert.equal(res.headers['access-control-allow-origin'], undefined, 'health 不加 CORS 头')
    return `${result.app} / workspace.open=${result.workspace.open}`
  })

  await check('GET /v1/workspace 只给名字与 open，不给绝对路径', async () => {
    const res = await request({ port, path: '/v1/workspace', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    assert.equal(res.status, 200)
    assert.equal(res.json.result.open, true)
    assert.equal(res.json.result.name, '我的笔记')
    assert.equal(res.json.result.inboxMode, null, '没接 getInboxMode 时 /v1/workspace 也必须给 null')
    assert.equal(res.text.includes(workspace), false, '不得返回绝对路径')
    return 'open=true name=我的笔记'
  })

  await check('GET /v1/imports?limit=20 返回列表', async () => {
    const res = await request({ port, path: '/v1/imports?limit=20', headers: withHost(port, { Authorization: `Bearer ${token}` }) })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json.result.imports, [])
    return '200 []'
  })

  // -------------------------------------------------------------------------
  section('⑪ 交付模式：只读 inboxMode（㉕，两个端点都给，缺省有确定行为）')
  // -------------------------------------------------------------------------
  await check('inboxMode 三态归一：字符串 / 布尔 / 不认识 / 没接线 / 挂钩抛错', async () => {
    const cases = [
      { hook: () => 'inbox', expect: 'inbox', label: 'hook=()=>"inbox"' },
      { hook: () => 'direct', expect: 'direct', label: 'hook=()=>"direct"' },
      { hook: () => true, expect: 'inbox', label: 'hook=()=>true' },
      { hook: () => false, expect: 'direct', label: 'hook=()=>false' },
      { hook: () => 'nonsense', expect: null, label: 'hook 返回不认识的串' },
      { hook: () => null, expect: null, label: 'hook 返回 null' },
      { hook: () => { throw new Error('挂钩炸了') }, expect: null, label: 'hook 抛错' },
      { noHook: true, expect: null, label: '没接线（缺省）' },
    ]
    const seen = []
    for (const item of cases) {
      const inst = makeBridge({
        workspace: true,
        ...(item.noHook ? {} : { inboxMode: item.hook }),
      })
      const modeToken = inst.bridge.regenerateToken()
      const up = await inst.bridge.startWithPort(privatePortCounter++)
      try {
        const health = await request({ port: up.port, path: '/v1/health', headers: withHost(up.port) })
        assert.equal(health.status, 200, `${item.label}: /v1/health 必须仍然 200`)
        const inHealth = health.json.result.inboxMode
        const ws = await request({
          port: up.port,
          path: '/v1/workspace',
          headers: withHost(up.port, { Authorization: `Bearer ${modeToken}` }),
        })
        assert.equal(ws.status, 200, `${item.label}: /v1/workspace 必须仍然 200`)
        const inWs = ws.json.result.inboxMode
        assert.equal(inHealth, item.expect, `${item.label}: /v1/health 的 inboxMode 应为 ${item.expect}`)
        assert.equal(inWs, item.expect, `${item.label}: /v1/workspace 的 inboxMode 应为 ${item.expect}`)
        assert.equal(inHealth, inWs, '两个端点必须给同一个答案')
        // 只读字段只可能是这三态；绝不允许把内部对象/布尔原样漏出去。
        assert.equal([null, 'inbox', 'direct'].includes(inHealth), true, `${item.label}: 越界取值 ${String(inHealth)}`)
        seen.push(`${item.label}→${String(inHealth)}`)
      } finally {
        await inst.bridge.stop()
      }
    }
    return seen.join(' / ')
  })

  await check('inboxMode 是只读：请求体里带同名键不影响任何行为，也不能当开关用', async () => {
    const readonly = makeBridge({ workspace: true, inboxMode: () => 'inbox' })
    const roToken = readonly.bridge.regenerateToken()
    const up = await readonly.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal(readonly.bridge.status().inboxMode, undefined, 'status() 不得凭空多出这个字段')
      // 请求体里塞 inboxMode/direct 是无效的：交付模式由应用侧设置决定，客户端说了不算。
      const res = await postImport(up.port, roToken, { ...validEnvelope(), inboxMode: 'direct' })
      assert.equal(res.status, 201, `带 inboxMode 的导入仍应 201 正常落盘，实得 ${res.status}`)
      const health = await request({ port: up.port, path: '/v1/health', headers: withHost(up.port) })
      assert.equal(health.json.result.inboxMode, 'inbox', '请求体里的 inboxMode 不得改写服务端答案')
      // 鉴权面未放宽：/v1/workspace 没令牌仍然 401。
      const noToken = await request({ port: up.port, path: '/v1/workspace', headers: withHost(up.port) })
      assert.equal(noToken.status, 401, '/v1/workspace 仍必须要求令牌')
      // 只读字段不得泄漏路径类信息。
      assert.equal(health.text.includes(workspace), false, 'inboxMode 落点不得带出工作区绝对路径')
    } finally {
      await readonly.bridge.stop()
    }
    return '只读 / 鉴权未放宽 / 无路径泄漏'
  })

  // -------------------------------------------------------------------------
  section('收件箱状态（唯一允许主进程写的内容）+ 日志脱敏')
  // -------------------------------------------------------------------------
  await check('writeInboxState() 原子写 state.json（tmp + rename）且不残留 .tmp', async () => {
    const result = await bridge.writeInboxState(workspace, 'entry-1', JSON.stringify({ status: 'pending' }))
    assert.equal(result.ok, true)
    const target = path.join(workspace, '.opennote', 'inbox', 'entry-1', 'state.json')
    assert.equal(fs.existsSync(target), true, 'state.json 应存在')
    assert.equal(JSON.parse(fs.readFileSync(target, 'utf8')).status, 'pending')
    const strays = listFilesRecursive(workspace).filter((file) => file.endsWith('.tmp'))
    assert.deepEqual(strays, [], `不应有 .tmp 残留：${strays.join(', ')}`)
    return '原子写'
  })

  await check('writeInboxState() 拒绝越界 entryId 与非绝对 root', async () => {
    for (const bad of ['../escape', 'a/b', '', '..', 'x\0y', '.opennote']) {
      let rejected = false
      try {
        await bridge.writeInboxState(workspace, bad, '{}')
      } catch {
        rejected = true
      }
      assert.equal(rejected, true, `entryId=${JSON.stringify(bad)} 必须被拒`)
    }
    let rootRejected = false
    try {
      await bridge.writeInboxState('relative/path', 'entry-1', '{}')
    } catch {
      rootRejected = true
    }
    assert.equal(rootRejected, true, '非绝对 root 必须被拒')
    const strays = listFilesRecursive(workspace).filter((file) => file.endsWith('escape') || file.endsWith('state.json.tmp'))
    assert.deepEqual(strays, [], '不得写出越界文件')
    return '6 种非法 id + 相对 root 全部拒绝'
  })

  await check('S-08 日志搜不到令牌明文，status() 不含令牌明文；都不写进工作区', async () => {
    const logs = holder.logs
    assert.ok(logs.length > 0, '应有日志产出')
    const logText = logs.join('\n')
    assert.equal(logText.includes(token), false, '日志不得含令牌明文')
    const statusJson = JSON.stringify(bridge.status())
    assert.equal(statusJson.includes(token), false, 'status() 不得含令牌明文')
    assert.equal(/opn_[A-Za-z0-9_-]{20,}/.test(statusJson), false, 'status() 不得出现任何完整令牌')
    const inWorkspace = listFilesRecursive(workspace).filter((file) => /bridge\.(log|json)$/.test(file))
    assert.deepEqual(inWorkspace, [], '日志不得写进工作区')
    const disk = path.join(dataDir, 'bridge.log')
    if (fs.existsSync(disk)) {
      const raw = fs.readFileSync(disk, 'utf8')
      assert.equal(raw.includes(token), false, 'bridge.log 不得含令牌明文')
      for (const line of raw.trim().split('\n')) {
        const parsed = JSON.parse(line)
        assert.equal(typeof parsed.ts, 'string')
        assert.equal(typeof parsed.event, 'string')
        assert.equal(/^pair\./.test(parsed.event), false, '配对事件名必须已删除（0.3.1 ㉞）')
      }
    }
    return `${logs.length} 行日志，无令牌明文、无配对事件`
  })

  await check('日志事件名与字段在白名单内（JSONL）', async () => {
    const allowed = new Set([
      'bridge.start', 'bridge.stop', 'bridge.listen-error',
      'import.ok', 'import.deduped', 'import.error', 'auth.fail', 'origin.reject',
      'host.reject', 'ratelimit',
    ])
    const allowedFields = new Set(['ts', 'event', 'origin', 'client', 'importId', 'path', 'code', 'ms', 'port', 'detail'])
    let parsedLines = 0
    let textLines = 0
    holder.logs.forEach((line, index) => {
      // 只对 JSON 行做字段断言：`log()` 是主进程副本，可能带纯文本行。
      if (!line.trimStart().startsWith('{')) {
        textLines += 1
        return
      }
      const parsed = JSON.parse(line)
      parsedLines += 1
      assert.equal(allowed.has(parsed.event), true, `未登记的事件名：${parsed.event}`)
      for (const key of Object.keys(parsed)) {
        assert.equal(allowedFields.has(key), true, `未登记的字段：${key}`)
      }
      // 挂钩的第一参数（主进程控制台用）必须与 JSONL 行里的事件名一致。
      assert.equal(holder.logEvents[index], parsed.event, `log() 第一参数与 JSONL 事件名不一致：${holder.logEvents[index]} / ${parsed.event}`)
    })
    assert.equal(parsedLines > 0, true, '必须至少有一行 JSONL 事件')
    return `${parsedLines} 行 JSONL 全部合规${textLines ? `（另有 ${textLines} 行纯文本）` : ''}`
  })

  await check('日志里不出现 userData 绝对路径与盘符路径', async () => {
    const logText = holder.logs.join('\n')
    assert.equal(logText.includes(dataDir), false, '日志不得含 userData 绝对路径')
    // 盘符形态（C:\ / D:/），用负向边界避免把 http:// 误判成绝对路径。
    assert.equal(/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/.test(logText), false, `日志不得含盘符绝对路径：${logText.slice(0, 200)}`)
    return '无绝对路径'
  })

  // -------------------------------------------------------------------------
  section('端口全占用 / 自定义端口 / 持久化 / 关闭')
  // -------------------------------------------------------------------------
  await check('⑧ 8787–8796 全被占用 → port-busy + IMP-1003，start() 返回 port:null', async () => {
    if (!canUseDefaultPort) skip(`${BASE_PORT} 已被其它进程占用，本机无法构造「全空闲转全占用」场景`)
    await bridge.stop()
    const releases = []
    try {
      for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p += 1) releases.push(await occupy(p))
    } catch (error) {
      for (const release of releases) await release()
      skip(`无法占满 ${PORT_RANGE_START}–${PORT_RANGE_END}：${error.code || error.message}`)
    }
    const busy = makeBridge({ noWindow: true })
    busy.bridge.regenerateToken()
    try {
      const result = await busy.bridge.start()
      assert.equal(result.port, null, '全占用时不得监听成功')
      assert.ok(result.error, '必须给出中文原因')
      assert.equal(result.code, 'IMP-1003')
      const status = busy.bridge.status()
      assert.equal(status.state, 'port-busy')
      assert.equal(status.stateLabel, '端口被占用')
      assert.equal(status.running, false)
      assert.equal(status.port, null)
      assert.equal(status.error, '8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。')
      return `port-busy / 「${result.error}」`
    } finally {
      for (const release of releases) await release()
      await busy.bridge.stop()
      const back = await bridge.start()
      port = back.port
    }
  })

  await check('自定义起始端口：非法值被拒（必须落在 1024–65535）', async () => {
    const custom = makeBridge({ noWindow: true })
    custom.bridge.regenerateToken()
    for (const bad of [0, 80, 1023, 65536, -1, 'abc', 1.5]) {
      const result = await custom.bridge.startWithPort(bad)
      assert.equal(result.port, null, `端口 ${JSON.stringify(bad)} 必须被拒`)
      assert.ok(result.error, '必须给出中文原因')
      assert.equal(custom.bridge.status().running, false)
    }
    return '7 种非法值全部拒绝'
  })

  await check('自定义起始端口：合法值被采纳（19850）', async () => {
    const custom = makeBridge({ noWindow: true })
    custom.bridge.regenerateToken()
    const result = await custom.bridge.startWithPort(19850)
    try {
      assert.equal(result.port, 19850, `应监听 19850，实际 ${result.port}（${result.error || ''}）`)
      assert.equal(custom.bridge.status().address, 'http://127.0.0.1:19850')
      assert.equal(custom.bridge.getBoundAddress().address, '127.0.0.1')
      return '19850'
    } finally {
      await custom.bridge.stop()
    }
  })

  await check('「起始端口」= 扫描起点：占用 19860/19861 后落到 19862', async () => {
    const custom = makeBridge({})
    const customToken = custom.bridge.regenerateToken()
    const releaseA = await occupy(19860)
    const releaseB = await occupy(19861)
    let started = null
    try {
      started = await custom.bridge.startWithPort(19860)
      assert.equal(started.port, 19862, `应顺序回落到 19862，实际 ${started.port}（${started.error || ''}）`)
      assert.equal(custom.bridge.status().portRange[0], 19860, 'portRange[0] 应跟随起始端口')
      assert.equal(custom.bridge.status().portRange[1], 19869, 'portRange[1] 应是起点 + 9')
      const res = await postImport(started.port, customToken, validEnvelope())
      assert.equal(res.status, 201, res.text.slice(0, 160))
      return '19860 被占 → 19862'
    } finally {
      await custom.bridge.stop()
      await releaseA()
      await releaseB()
    }
  })

  await check('起始端口 + 10 个端口全占用 → port-busy 且报错文案跟随起始端口', async () => {
    const custom = makeBridge({ noWindow: true })
    custom.bridge.regenerateToken()
    const releases = []
    try {
      for (let p = 20270; p <= 20279; p += 1) releases.push(await occupy(p))
    } catch (error) {
      for (const release of releases) await release()
      skip(`无法占满自定义端口段：${error.code || error.message}`)
    }
    try {
      const result = await custom.bridge.startWithPort(20270)
      assert.equal(result.port, null)
      assert.equal(result.code, 'IMP-1003')
      assert.equal(custom.bridge.status().state, 'port-busy')
      assert.equal(result.error, '20270 到 20279 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。')
      return result.error
    } finally {
      for (const release of releases) await release()
      await custom.bridge.stop()
    }
  })

  // ── 系统保留端口段（EACCES）与「默认段优先」 ───────────────────────────────
  // 真实故障现场：Windows 的 `MaxUserPort` 把动态端口范围拉到 1024–15000，
  // HNS/`winnat` 的保留段因此压到 8755–8854，于是 8787 起全段 `listen()` 返回 `EACCES`。
  // 上面这些用例都造不出 `EACCES`（`occupy()` 只有 `EADDRINUSE`），所以走注入缝隙。
  await check('系统保留段① EACCES 不再中断扫描：起始端口被保留时继续试下一个', async () => {
    const custom = makeBridge({ noWindow: true })
    custom.bridge.regenerateToken()
    const reserved = privatePortCounter
    privatePortCounter += 2
    let result = null
    try {
      result = await withEaccesPorts([reserved], async () => custom.bridge.startWithPort(reserved))
      assert.equal(
        result.port,
        reserved + 1,
        `起始端口被系统保留时应继续扫到 ${reserved + 1}，实际 ${result.port}（${result.error || ''}）`,
      )
      return `${reserved} EACCES → ${result.port}（旧代码会停在 ${reserved} 直接失败）`
    } finally {
      await custom.bridge.stop().catch(() => {})
    }
  })

  await check('系统保留段② 8787–8796 整段被保留 → failed + IMP-1002（**不是** port-busy）', async () => {
    const reserved = makeBridge({ noWindow: true })
    reserved.bridge.regenerateToken()
    let result = null
    try {
      result = await withEaccesPorts(frozenPorts(), async () => reserved.bridge.start())
      assert.equal(result.port, null, '整段被保留时不得监听成功')
      assert.equal(result.code, 'IMP-1002', '被系统保留 ≠ 被程序占用，码号必须是 IMP-1002')
      assert.equal(result.error, '本地接口启动失败（EACCES）。')
      const status = reserved.bridge.status()
      assert.equal(status.state, 'failed')
      assert.equal(status.stateLabel, '启动失败')
      assert.equal(status.running, false)
      assert.equal(status.port, null)
      return `failed / IMP-1002 /「${result.error}」`
    } finally {
      await reserved.bridge.stop().catch(() => {})
    }
  })

  await check('默认段优先① 冻结段可用时就用冻结段（旧扩展 / 旧 Skill 只认这段）', async () => {
    const dir = tempDir('opennote-bridge-frozen-first-')
    const fallback = privatePortCounter
    privatePortCounter += 10
    const first = makeBridge({ dataDir: dir, workspace: true })
    first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(fallback)
    assert.equal(up.port, fallback, `兜底端口本身要能起来：${up.error || ''}`)
    await first.bridge.stop()

    let freeFrozen = null
    for (const candidate of frozenPorts()) {
      if (await isFree(candidate)) {
        freeFrozen = candidate
        break
      }
    }
    if (freeFrozen == null) {
      fs.rmSync(dir, { recursive: true, force: true })
      skip('冻结段全部被其它进程占用，无法断言「默认段优先」')
    }

    const second = makeBridge({ dataDir: dir, workspace: true })
    try {
      const result = await second.bridge.start()
      assert.ok(
        result.port >= PORT_RANGE_START && result.port <= PORT_RANGE_END,
        `冻结段可用时应优先用它，实际 ${result.port}（持久化兜底是 ${fallback}）`,
      )
      assert.equal(await isFree(fallback), true, '兜底端口应仍空闲 —— 证明没有优先用它')
      return `冻结段可用 → ${result.port}（而不是持久化的 ${fallback}）`
    } finally {
      await second.bridge.stop().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('默认段优先② 冻结段整段被保留时才启用用户持久化的兜底端口', async () => {
    const dir = tempDir('opennote-bridge-fallback-')
    const fallback = privatePortCounter
    privatePortCounter += 10
    const first = makeBridge({ dataDir: dir, workspace: true })
    first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(fallback)
    assert.equal(up.port, fallback, `兜底端口本身要能起来：${up.error || ''}`)
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'))
    assert.equal(onDisk.startPort, fallback, 'bridge.json 必须记住用户点名的起始端口（跨重启）')
    assert.equal(onDisk.port, fallback, 'bridge.json 必须公布实际绑定端口')
    await first.bridge.stop()

    const second = makeBridge({ dataDir: dir, workspace: true })
    let attempted = []
    try {
      const result = await withEaccesPorts(frozenPorts(), async (probe) => {
        const started = await second.bridge.start()
        attempted = probe.attempted.slice()
        return started
      })
      assert.equal(result.port, fallback, `应落到用户自己的兜底端口，实际 ${result.port}（${result.error || ''}）`)
      assert.deepEqual(attempted.slice(0, 10), frozenPorts(), '冻结段必须整段排在兜底段之前')
      assert.equal(attempted[10], fallback, `兜底段应紧接冻结段之后，实际 ${attempted[10]}`)
      return `冻结段全 EACCES → ${attempted[0]}…${attempted[9]} → ${attempted[10]}`
    } finally {
      await second.bridge.stop().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('FR-41：冻结段只是「被别人占用」→ port-busy 明确提示，**不**偷偷用兜底端口', async () => {
    const dir = tempDir('opennote-bridge-fr41-')
    const fallback = privatePortCounter
    privatePortCounter += 10
    const first = makeBridge({ dataDir: dir, workspace: true })
    first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(fallback)
    assert.equal(up.port, fallback, `兜底端口本身要能起来：${up.error || ''}`)
    await first.bridge.stop()

    const second = makeBridge({ dataDir: dir, workspace: true })
    try {
      const result = await withListenErrors(frozenPorts(), 'EADDRINUSE', async () => second.bridge.start())
      assert.equal(result.port, null, '被占用时不得换到范围外（FR-41 要求明确提示而不是静默换端口）')
      assert.equal(result.code, 'IMP-1003')
      assert.equal(result.error, '8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。')
      assert.equal(second.bridge.status().state, 'port-busy')
      assert.equal(await isFree(fallback), true, '兜底端口应仍空闲 —— 证明桥没有偷偷换过去')
      return 'port-busy + IMP-1003，兜底端口未被偷用'
    } finally {
      await second.bridge.stop().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('bridge.json 公布实际绑定端口（未运行 / 运行中 / 停止后回落）', async () => {
    const dir = tempDir('opennote-bridge-port-publish-')
    const target = privatePortCounter
    privatePortCounter += 10
    const inst = makeBridge({ dataDir: dir, workspace: true })
    inst.bridge.regenerateToken()
    const readDisk = () => JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8'))
    try {
      assert.equal(readDisk().port, null, '未运行时 port 必须是 null（不猜）')
      const started = await inst.bridge.startWithPort(target)
      assert.equal(started.port, target, `应绑定 ${target}：${started.error || ''}`)
      assert.equal(readDisk().port, target, '运行中 bridge.json.port 必须等于实际绑定端口')
      await inst.bridge.stop()
      assert.equal(readDisk().port, null, '停止后 port 必须回落 null（客户端据此回退扫描）')
      return `null → ${target} → null`
    } finally {
      await inst.bridge.stop().catch(() => {})
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  await check('㊴ 持久化：新实例读回 tokenHash + last4 + allowedOrigins，**并且明文也能读回**', async () => {
    // 自己播种遗留列表，不依赖前面用例跑过（红的时候不该连坐）。
    assert.equal(bridge.addAllowedOrigin(DEV_ORIGIN), true)
    const reloaded = makeBridge({ dataDir, workspace: true })
    const status = reloaded.bridge.status()
    assert.equal(status.tokenSet, true, '应读回令牌哈希')
    assert.equal(status.tokenLast4, token.slice(-4))
    assert.equal(status.tokenPersisted, true)
    assert.ok(status.origins.includes(DEV_ORIGIN), 'allowedOrigins 应被读回')
    assert.equal(JSON.stringify(status).includes(token), false, 'status 不得回显明文')
    // ㊴：「明文不可恢复」已经作废 —— 新实例必须能直接把它交出来（用户要的就是这个）。
    assert.equal(reloaded.bridge.getSessionPlaintext(), token, '㊴：新实例必须能从磁盘读回明文')
    assert.equal(status.tokenVisible, true)
    const started = await reloaded.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postImport(started.port, token, validEnvelope())
      assert.equal(res.status, 201, `读回的哈希应能验证原令牌，实际 ${res.status}`)
      return '哈希 + 明文都能读回；原令牌仍有效'
    } finally {
      await reloaded.bridge.stop()
    }
  })

  await check('没有 dataDir 时零文件副作用（tokenPersisted=false）', async () => {
    const clean = tempDir('opennote-bridge-nodir-')
    const marker = fs.readdirSync(clean).length
    const memory = createBridge({ log: () => {} })
    memory.regenerateToken()
    const status = memory.status()
    assert.equal(status.tokenPersisted, false, '没有 dataDir 时不得声称已持久化')
    assert.equal(status.logPath, null)
    assert.equal(fs.readdirSync(clean).length, marker, '不得产生任何文件')
    return 'tokenPersisted=false / 0 文件'
  })

  await check('start() 幂等：重复调用返回同一端口', async () => {
    const idem = makeBridge({ noWindow: true })
    idem.bridge.regenerateToken()
    const first = await idem.bridge.startWithPort(privatePortCounter++)
    try {
      const second = await idem.bridge.start()
      assert.equal(second.port, first.port)
      return `port=${first.port} 幂等`
    } finally {
      await idem.bridge.stop()
    }
  })

  await check('isEnabled()=false 时 status() 报 disabled（用户关掉开关）', async () => {
    const off = makeBridge({ noWindow: true, enabled: false })
    off.bridge.regenerateToken()
    const started = await off.bridge.startWithPort(privatePortCounter++)
    try {
      assert.ok(started.port, '显式 start() 仍应能监听（等价于用户点开启）')
      await off.bridge.stop()
      assert.equal(off.bridge.status().state, 'disabled')
      assert.equal(off.bridge.status().stateLabel, '未开启')
    } finally {
      await off.bridge.stop()
    }
    return 'stopped → disabled'
  })

  await check('stop() 在 5 s 内关闭并断开 keep-alive 长连接', async () => {
    const keep = makeBridge({ noWindow: true })
    const keepToken = keep.bridge.regenerateToken()
    const started = await keep.bridge.startWithPort(privatePortCounter++)
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
    const call = () =>
      new Promise((resolve, reject) => {
        const req = http.request(
          { host: '127.0.0.1', port: started.port, path: '/v1/health', method: 'GET', agent, headers: withHost(started.port) },
          (res) => {
            res.resume()
            res.on('end', () => resolve(res.statusCode))
          },
        )
        req.on('error', reject)
        req.end()
      })
    try {
      assert.equal(await call(), 200, '首个请求应成功（复用连接）')
      const start = Date.now()
      await keep.bridge.stop()
      const elapsed = Date.now() - start
      assert.ok(elapsed < 5000, `stop() 应在 5 s 内完成，实际 ${elapsed}ms`)
      assert.equal(await isRefused(started.port), true, '关闭后端口必须不可达')
      let failed = false
      try {
        await call()
      } catch {
        failed = true
      }
      assert.equal(failed, true, 'keep-alive 连接必须被断开')
      assert.ok(keepToken)
      return `${elapsed}ms 内关闭并断开长连接`
    } finally {
      agent.destroy()
      await keep.bridge.stop()
    }
  })

  // -------------------------------------------------------------------------
  // ⑫ 用户偏好：本地接口开关要记住（task-27，用户实测）
  // -------------------------------------------------------------------------
  section('⑫ 用户偏好：本地接口开关要记住（task-27）')

  /** 读 `bridge.json` 里的用户偏好（测试只看这一个产地）。 */
  const readPref = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'bridge.json'), 'utf8')).enabled

  await check('task-27① start() 后用户偏好为 true 并写进 bridge.json', async () => {
    const dir = tempDir('opennote-bridge-pref-')
    const inst = makeBridge({ dataDir: dir })
    inst.bridge.regenerateToken()
    assert.equal(readPref(dir), false, '还没开过 → 偏好 false（未开启）')
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal(up.port !== null, true, '应当监听成功')
      assert.equal(inst.bridge.status().enabled, true, 'status().enabled = 现在在监听（与偏好同名不同义）')
      assert.equal(readPref(dir), true, '用户点过开启 → 偏好必须落盘为 true')
    } finally {
      await inst.bridge.stop()
    }
  })

  await check('task-27② 端到端：开 → stop()（= 退出应用）→ 新 controller → 按偏好自动恢复并可用', async () => {
    // 这条就是用户实测的复现路径：0.3.1 第一版在第 2 步把偏好写成了 false，于是第 3 步
    // 读到 disabled、第 4 步永远不恢复（「我打开了本地接口，每次关了都需要重新打开」）。
    const dir = tempDir('opennote-bridge-pref-e2e-')
    const first = makeBridge({ dataDir: dir })
    const plain = first.bridge.regenerateToken()
    // ① 开
    const up = await first.bridge.startWithPort(privatePortCounter++)
    assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201, '① 开启后应能导入')
    // ② stop() = main.cjs 的 before-quit / 窗口关闭路径
    await first.bridge.stop()
    assert.equal(readPref(dir), true, '② 退出应用的 stop() 不得清掉用户偏好（这就是本 bug 的核心断言）')
    assert.equal(first.bridge.status().state, 'stopped', '停监听 ≠ 关偏好：会话内状态仍是 stopped')
    // 顺带：别的 persist() 路径也不许顺手改偏好（同一个 bug 的第二张脸）。
    first.bridge.addAllowedOrigin(DEV_ORIGIN)
    assert.equal(readPref(dir), true, 'addAllowedOrigin 这类 persist() 不得改偏好')
    // ③ 新 controller = 重启应用：初始状态必须是 stopped（会恢复），而不是 disabled
    const second = makeBridge({ dataDir: dir })
    assert.equal(second.bridge.status().state, 'stopped', '③ 偏好为 true 时初始状态必须是 stopped，不是 disabled')
    assert.equal(second.bridge.status().enabled, false, '此时确实没在监听（两件事必须能同时成立）')
    // ④ 按偏好自动恢复（main.cjs 在窗口创建时做的事）
    const restored = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal(restored.port !== null, true, '④ 自动恢复必须真的监听')
      assert.equal((await postImport(restored.port, plain, validEnvelope())).status, 201, '④ 恢复后旧令牌仍可用')
    } finally {
      await second.bridge.stop()
    }
  })

  await check('task-27③ 显式关闭（stop({disable:true})）→ 偏好 false，重启后 disabled 且不自动恢复', async () => {
    const dir = tempDir('opennote-bridge-pref-off-')
    const first = makeBridge({ dataDir: dir })
    first.bridge.regenerateToken()
    await first.bridge.startWithPort(privatePortCounter++)
    await first.bridge.stop()
    assert.equal(readPref(dir), true, '先确认：纯 stop() 之后偏好还是 true')
    // 用户显式关闭（面板上的「关闭接口」→ main.cjs 的 opennote:bridge:stop）
    await first.bridge.stop({ disable: true })
    assert.equal(readPref(dir), false, '用户显式关闭 → 偏好必须落盘为 false')
    const second = makeBridge({ dataDir: dir })
    assert.equal(second.bridge.status().state, 'disabled', '重启后是 disabled —— 不自动恢复的依据')
    assert.equal(second.bridge.status().tokenSet, true, '关掉接口不代表把令牌删了')
    // 显式关闭不是「上锁」：用户再点一次开启仍然能开，并且偏好回到 true。
    const again = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal(again.port !== null, true, '再开启必须成功')
      assert.equal(readPref(dir), true, '再开启后偏好回到 true')
    } finally {
      await second.bridge.stop()
    }
  })

  await check('task-27④ 偏好只由「用户开/关」决定：起不来（端口占满）也算用户想开着', async () => {
    // 「他的意愿」与「这次能不能开起来」是两件事：端口占满时偏好照样要记住，
    // 否则用户遇到一次端口冲突，下次启动就再也不恢复了（另一种「开关不记住」）。
    const dir = tempDir('opennote-bridge-pref-busy-')
    const inst = makeBridge({ dataDir: dir })
    inst.bridge.regenerateToken()
    const base = privatePortCounter
    privatePortCounter += 10
    const releases = []
    try {
      for (let p = base; p < base + 10; p += 1) releases.push(await occupy(p))
      const res = await inst.bridge.startWithPort(base)
      assert.equal(res.port, null, '这一段端口全被占 → 起不来')
      assert.equal(res.code, 'IMP-1003')
      assert.equal(readPref(dir), true, '起不来也要记住「用户想开着」')
      const restarted = makeBridge({ dataDir: dir })
      assert.equal(restarted.bridge.status().state, 'stopped', '重启后仍应尝试恢复（stopped）')
    } finally {
      for (const release of releases) await release()
      await inst.bridge.stop()
    }
  })

  // -------------------------------------------------------------------------
  // ⑬ 版本号咬合：同一个事实（应用版本）不许有两个产地
  // -------------------------------------------------------------------------
  section('⑬ 版本号咬合：APP_VERSION ↔ package.json')

  await check('⑬ 咬合：bridge.cjs 的 APP_VERSION/FALLBACK 与 package.json 的 version 逐字一致', () => {
    // 这条断言看着「废话」，但 0.3.2 的排查事故就是它缺位造成的：
    // 桥的常量停在 0.2.0，而**断言里也抄了一份 0.2.0**，于是两边一起错、全绿。
    assert.equal(APP_VERSION, PKG_VERSION, 'APP_VERSION（生效值）必须等于 package.json 的 version')
    assert.equal(APP_VERSION_FALLBACK, PKG_VERSION, 'APP_VERSION_FALLBACK（兜底常量）必须等于 package.json 的 version')
    assert.equal(
      /const APP_VERSION_FALLBACK = '[^']+'/.test(fs.readFileSync(BRIDGE_PATH, 'utf8')),
      true,
      '兜底常量必须仍然是**显式字面量**（不然这条断言就没东西可盯了）',
    )
    return `package.json=${PKG_VERSION} · APP_VERSION=${APP_VERSION} · FALLBACK=${APP_VERSION_FALLBACK}`
  })

  await check('⑬ main.cjs 必须把真实版本挂钩传进桥（挂钩没了会静默退回兜底常量）', () => {
    const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.cjs'), 'utf8')
    assert.equal(
      main.includes('getAppVersion: () => app.getVersion()'),
      true,
      'main.cjs 必须传 `getAppVersion: () => app.getVersion()`（应用版本的唯一产地 = package.json）',
    )
    return 'main.cjs: getAppVersion: () => app.getVersion()'
  })

  await check('⑬ 挂钩优先：getAppVersion 返回什么，/v1/health 就回什么（哨兵值，不写死真版本）', async () => {
    const sentinel = '9.9.9-sentinel'
    const inst = makeBridge({ appVersion: sentinel })
    inst.bridge.regenerateToken()
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await request({ port: up.port, path: '/v1/health', headers: withHost(up.port) })
      assert.equal(res.status, 200)
      assert.equal(res.json.result.app, sentinel, 'health 必须如实转述挂钩给的版本（挂钩优先于兜底常量）')
    } finally {
      await inst.bridge.stop()
    }
  })

  // -------------------------------------------------------------------------
  section('⑭ 网页版剪藏页：/v1/clip/* 与 /clip/ 静态服务（0.3.2）')
  // -------------------------------------------------------------------------
  // 判据盯的是**用户看得见的那条路径**：扩展把内容交给桥 → 页面用 k 读到它 →
  // 用户在页面里改完 → commit 走**同一条**入库通路 → 落点/单次性/日志红线。
  // 静态页全部用夹具（真实产物要跑 pnpm build:clip，不能让人「没构建就跳过用例」）。

  const CLIP_BODY = '在浏览器里剪下的一段话。\n\n## 为什么\n\n本地优先。'
  /** 一条合法的剪藏暂存请求体（字段逐字来自冻结契约）。 */
  const clipStageBody = (overrides = {}) => ({
    spec: 'opennote.clip/v1',
    url: 'https://example.com/posts/local-first',
    title: '写给工程师的本地优先笔记',
    body: CLIP_BODY,
    selection: false,
    tags: ['剪藏', '本地优先'],
    source: { site: 'example.com', author: '张三', publishedAt: '2026-08-14T09:30:00+08:00' },
    assets: [],
    ...overrides,
  })

  const stageClip = (portNo, tokenValue, overrides = {}) =>
    request({
      port: portNo,
      path: '/v1/clip/stage',
      method: 'POST',
      headers: jsonHeaders(portNo, tokenValue),
      body: JSON.stringify(clipStageBody(overrides)),
    })

  const clipGet = (portNo, pathname) => request({ port: portNo, path: pathname, headers: withHost(portNo) })

  const clipPost = (portNo, tokenValue, pathname, body) =>
    request({
      port: portNo,
      path: pathname,
      method: 'POST',
      headers: jsonHeaders(portNo, tokenValue),
      body: JSON.stringify(body),
    })

  /** 断言 stage 回执形状（**平铺，不套 result**），并解出 stageId / k / 端口。 */
  const clipStagedInfo = (res) => {
    assert.equal(res.status, 200, `stage 应 200，实际 ${res.status}：${res.text.slice(0, 200)}`)
    assert.ok(res.json, `stage 必须回 JSON：${res.text.slice(0, 200)}`)
    assert.equal(res.json.ok, true)
    assert.equal('result' in res.json, false, 'stage 形状是平铺 { ok, stageId, expiresAt, openUrl }，不套 result')
    assert.equal(typeof res.json.stageId, 'string')
    assert.equal(typeof res.json.expiresAt, 'number')
    assert.equal(typeof res.json.openUrl, 'string')
    const parsed = new URL(res.json.openUrl)
    return { stageId: res.json.stageId, expiresAt: res.json.expiresAt, key: parsed.searchParams.get('k'), parsed }
  }

  /** 起一个独立的剪藏页实例（自己的 dataDir / 端口 / 钩子），用完就停。 */
  const withClipBridge = async (options, fn) => {
    const dir = tempDir('opennote-clip-inst-')
    const inst = makeBridge({
      dataDir: dir,
      // `workspace` 决定 `/v1/clip/folders` 走哪条失败分支：工作区没打开 → IMP-4007；
      // 工作区打开但挂钩拿不到 → IMP-4014。两种都必须能被断言。
      workspace: options.workspace === true,
      clip: { distRoot: clipDistRoot, ...(options.clip || {}) },
      folders: options.folders,
    })
    const plain = inst.bridge.regenerateToken()
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      assert.ok(up.port, `剪藏页实例应能监听：${up.error || '未知'}`)
      return await fn({ bridge: inst.bridge, holder: inst.holder, port: up.port, token: plain, dataDir: dir })
    } finally {
      await inst.bridge.stop()
    }
  }

  /** 读一个实例自己的 bridge.log（日志红线与「记一条 IMP-4014」都要看盘上那份）。 */
  const readBridgeLog = (dir) => {
    try {
      return fs.readFileSync(path.join(dir, 'bridge.log'), 'utf8')
    } catch {
      return ''
    }
  }

  let clipStaged = null

  await check('⑭ 冻结常量：spec / 注入块 id / CSP 逐字 / TTL / 附件上限 / 五个剪藏码号', () => {
    assert.equal(CLIP_SPEC, 'opennote.clip/v1', '暂存的 spec 与导入信封的 spec 不是同一个值')
    assert.equal(CLIP_BOOT_ID, 'clip-boot')
    assert.equal(
      CLIP_CSP,
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'CSP 必须逐字等于契约冻结值',
    )
    assert.equal(/script-src[^;]*unsafe-inline/.test(CLIP_CSP), false, 'script-src 不得放开内联脚本（引导数据走 JSON 数据块）')
    assert.equal(CLIP_STAGE_TTL_MS, 15 * 60 * 1000, '暂存 TTL 冻结为 15 分钟')
    assert.equal(MAX_CLIP_ASSETS, 32, '单条暂存附件上限 = 02 §2.7 的 32')
    // 剪藏页的每一类失败都有自己的码号（一个码号一个含义、一处文案产地）。
    const clipCodes = [
      ['IMP-4018', 409, false],
      ['IMP-4019', 401, false],
      ['IMP-4021', 404, false],
      ['IMP-4022', 422, false],
      ['IMP-5003', 503, true],
    ]
    for (const [code, http, retryable] of clipCodes) {
      const row = ERROR_TABLE[code]
      assert.ok(row, `${code} 必须在 ERROR_TABLE 里（不许再借别的码号）`)
      assert.equal(row.http, http, `${code} 的 http 登记值`)
      assert.equal(row.retryable, retryable, `${code} 的 retryable 登记值`)
      assert.equal(row.userMessage.includes('`'), false, `${code} 的文案不得含反引号`)
    }
    return `spec=opennote.clip/v1 · id=clip-boot · TTL=15min · assets<=32 · ${clipCodes.length} 个剪藏码号`
  })

  await check('⑭ 路由层不许再「借码号 + 换文案」（CLIP_HINTS 已删除；表比对看不见这种漂移）', () => {
    // 为什么单列这条：C-6c/C-6f 只比对 ERROR_TABLE，**看不见** sendError 的 userMessage 覆盖 ——
    // 那种漂移是恒绿的。所以「没有这个口子」必须由行为之外的源码断言来守。
    // **只认代码、不认注释**：桥里留了一段解释「这个口子为什么被关掉」的注释，它当然会提到这个名字。
    const source = fs.readFileSync(BRIDGE_PATH, 'utf8')
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, ' '))
      .replace(/^[ \t]*\/\/.*$/gm, (line) => ' '.repeat(line.length))
    assert.equal(code.includes('CLIP_HINTS'), false, '桥的**代码**里不得再有 userMessage 覆盖表（一句话两个产地的口子）')
    // 锚点在**原文**里找（它们本身就是注释文字，剥注释时会被抹掉），
    // 但切片切的是**剥过注释的代码**（两处替换都保长度，所以偏移量一一对应）。
    // 起点必须取**最后一次**出现：`handleRequest` 里的路由注释也含同样的字串，
    // 从它开始切会把 `respondWithReceipt()`（那里合法地有 userMessage）一起圈进来 —— 假红。
    const start = source.lastIndexOf('// 网页版剪藏页（0.3.2，契约 §5.9）')
    const end = source.indexOf('POST /v1/pair 与配套的配对码状态机')
    assert.ok(start > 0 && end > start, '剪藏段落的锚点漂了，这条断言必须先修（否则它会静默变空）')
    const clipSection = code.slice(start, end)
    assert.ok(clipSection.length > 4000, `剪藏段落只有 ${clipSection.length} 字符，锚点可能已失效`)
    assert.equal(
      clipSection.includes('function respondWithReceipt'),
      false,
      '切片的起点锚错了（把回执映射那些合法代码也圈进来了）—— 先修锚点，别信这条断言的红',
    )
    assert.equal(
      /userMessage\s*:/.test(clipSection),
      false,
      '剪藏路由里不得出现任何 userMessage 覆盖：每类失败都用自己的码号 + 登记文案',
    )
    return `代码里 CLIP_HINTS 0 处；剪藏段 ${clipSection.length} 字符内 userMessage 覆盖 0 处`
  })

  await check('⑭ stage：POST /v1/clip/stage 生成 stageId + openUrl（stageId 不是客户端的 importId）', async () => {
    const callsBefore = holder.calls.length
    const res = await stageClip(port, token, { importId: 'client-supplied-import-id-0001' })
    clipStaged = clipStagedInfo(res)
    assert.match(clipStaged.stageId, /^[A-Za-z0-9_-]{32,}$/, `stageId 必须是 >=32 字符的 base64url，实际「${clipStaged.stageId}」`)
    assert.notEqual(clipStaged.stageId, 'client-supplied-import-id-0001', 'stageId 只由桥生成 —— 绝不用客户端给的 importId')
    assert.equal(clipStaged.parsed.origin, `http://127.0.0.1:${port}`, 'openUrl 只由桥拼：回环地址 + 实际监听端口')
    assert.equal(clipStaged.parsed.pathname, `/clip/${clipStaged.stageId}`, 'openUrl 路径必须逐字是 /clip/<stageId>')
    assert.ok(
      typeof clipStaged.key === 'string' && clipStaged.key.length >= 32,
      `k 必须不可猜（>=32 字符），实际「${String(clipStaged.key)}」`,
    )
    assert.notEqual(clipStaged.key, token, 'k 绝不能是长期令牌（页面永不持有长期凭据）')
    const ttl = clipStaged.expiresAt - Date.now()
    assert.ok(ttl > 14 * 60 * 1000 && ttl <= 15 * 60 * 1000, `TTL 应在 14-15 分钟之间，实际 ${Math.round(ttl / 1000)} 秒`)
    assert.equal(holder.calls.length, callsBefore, '暂存不得触碰入库通路（onEnvelope）—— 暂存不等于写盘')
    return `stageId ${clipStaged.stageId.length} 字符 · k ${clipStaged.key.length} 字符 · ${clipStaged.parsed.pathname}`
  })

  await check('⑭ stage：令牌非法一律 401（缺令牌 IMP-2001 / 错令牌 IMP-2002）', async () => {
    expectError(await stageClip(port, null), 'IMP-2001', 401)
    expectError(await stageClip(port, `opn_${'A'.repeat(43)}`), 'IMP-2002', 401)
    return '缺令牌 401 IMP-2001；错令牌 401 IMP-2002'
  })

  await check('⑭ stage：请求形态错误 → 明确 4xx（spec / title / body / url / 超大正文）', async () => {
    expectError(await stageClip(port, token, { spec: 'opennote.import/v1' }), 'IMP-4002', 422)
    expectError(await stageClip(port, token, { title: '   ' }), 'IMP-4003', 422)
    expectError(await stageClip(port, token, { body: 42 }), 'IMP-4003', 422)
    expectError(await stageClip(port, token, { url: 'javascript:alert(1)' }), 'IMP-4003', 422)
    expectError(await stageClip(port, token, { body: 'x'.repeat(8 * 1024 * 1024 + 1) }), 'IMP-4004', 413)
    return 'spec→4002；title/body/url→4003；8 MiB+1 → 4004'
  })

  await check('⑭ GET /clip/<stageId>：产物原文 + clip-boot JSON 数据块 + CSP 逐字', async () => {
    const page = await clipGet(port, `/clip/${clipStaged.stageId}?k=${encodeURIComponent(clipStaged.key)}`)
    assert.equal(page.status, 200, `页面应 200，实际 ${page.status}：${page.text.slice(0, 200)}`)
    assert.match(String(page.headers['content-type']), /^text\/html/, 'Content-Type 必须是 text/html')
    assert.equal(page.headers['cache-control'], 'no-store')
    assert.equal(page.headers['x-content-type-options'], 'nosniff')
    assert.equal(page.headers['content-security-policy'], CLIP_CSP, 'CSP 必须逐字等于冻结值')
    assert.ok(page.text.includes('CLIP_FIXTURE_PAGE'), '产物原文必须原样返回')
    const match = new RegExp(`<script type="application/json" id="${CLIP_BOOT_ID}">([\\s\\S]*?)</script>`).exec(page.text)
    assert.ok(match, `必须注入 <script type="application/json" id="${CLIP_BOOT_ID}"> 数据块`)
    const boot = JSON.parse(match[1])
    assert.equal(boot.port, port, '引导数据的 port 必须是实际监听端口')
    assert.equal(boot.stageId, clipStaged.stageId)
    assert.equal(boot.k, clipStaged.key)
    assert.deepEqual(Object.keys(boot).sort(), ['k', 'port', 'stageId'], '引导数据只允许 { port, stageId, k } 三个键')
    assert.ok(page.text.indexOf('id="clip-boot"') < page.text.indexOf('</body>'), '数据块必须在 </body> 之前（页面脚本先拿到它）')
    return `HTML ${page.text.length} 字节 · boot={port,stageId,k} 三键 · CSP 逐字一致`
  })

  await check('⑭ /clip/<stageId>：k 错 → 401 IMP-4019（原样用登记文案，不借令牌码）', async () => {
    const wrong = await clipGet(port, `/clip/${clipStaged.stageId}?k=${'A'.repeat(43)}`)
    const error = expectError(wrong, 'IMP-4019', 401)
    assert.equal(error.userMessage, ERROR_TABLE['IMP-4019'].userMessage, '正式码号 + 登记文案，路由里不许再覆盖')
    assert.notEqual(error.userMessage, ERROR_TABLE['IMP-2002'].userMessage, '页面上的 k 不是长期令牌：不许借 IMP-2002')
    assert.equal(wrong.text.includes('CLIP_FIXTURE_PAGE'), false, 'k 不对时绝不能把页面吐出来')
    return `${error.code} 401「${error.userMessage}」`
  })

  await check('⑭ /clip/<stageId>：k 缺失 → 401 IMP-4019；stageId 不存在 → 404 IMP-4021', async () => {
    expectError(await clipGet(port, `/clip/${clipStaged.stageId}`), 'IMP-4019', 401)
    const missing = await clipGet(port, `/clip/${'B'.repeat(43)}?k=${'A'.repeat(43)}`)
    const error = expectError(missing, 'IMP-4021', 404)
    assert.equal(error.userMessage, ERROR_TABLE['IMP-4021'].userMessage, '正式码号 + 登记文案；不许借 IMP-4017')
    assert.notEqual(error.userMessage, ERROR_TABLE['IMP-4017'].userMessage, '「暂存过期」不是「查不到导入记录」')
    return 'k 缺失 401 IMP-4019；stageId 不存在 404 IMP-4021'
  })

  await check('⑭ 过期：TTL 到期后 stageId + k 一律失效（404 IMP-4021，不假装还能用）', async () => {
    await withClipBridge({ clip: { ttlMs: 60 }, folders: () => [] }, async (inst) => {
      const staged = clipStagedInfo(await stageClip(inst.port, inst.token))
      const live = await clipGet(inst.port, `/v1/clip/stage?stageId=${staged.stageId}&k=${encodeURIComponent(staged.key)}`)
      assert.equal(live.status, 200, `未过期时必须能读到（先证明这条例程本来是通的）：${live.text.slice(0, 160)}`)
      await new Promise((resolve) => setTimeout(resolve, 140))
      const gone = await clipGet(inst.port, `/v1/clip/stage?stageId=${staged.stageId}&k=${encodeURIComponent(staged.key)}`)
      expectError(gone, 'IMP-4021', 404)
      const page = await clipGet(inst.port, `/clip/${staged.stageId}?k=${encodeURIComponent(staged.key)}`)
      expectError(page, 'IMP-4021', 404)
      return '未过期可读；过期后读端点与页面都 404 IMP-4021'
    })
  })

  await check('⑭ 产物缺失：GET /clip/<stageId> → 503 + IMP-5003（绝不回空 200）', async () => {
    await withClipBridge({ clip: { distRoot: emptyClipRoot }, folders: () => [] }, async (inst) => {
      const staged = clipStagedInfo(await stageClip(inst.port, inst.token))
      const res = await clipGet(inst.port, `/clip/${staged.stageId}?k=${encodeURIComponent(staged.key)}`)
      assert.equal(res.status, 503, `产物不存在必须 503，实际 ${res.status}`)
      const error = expectError(res, 'IMP-5003', 503)
      assert.equal(error.userMessage, ERROR_TABLE['IMP-5003'].userMessage, '原样用登记文案，不覆盖')
      assert.ok(error.userMessage.includes('pnpm build:clip'), `文案必须告诉用户怎么修，实际「${error.userMessage}」`)
      assert.equal(error.retryable, true, '缺构建产物是可修的部署问题，必须可重试')
      // 静态资源同理：缺产物时 404，不得假装 200。
      expectError(await clipGet(inst.port, '/clip/assets/app.js'), 'IMP-3005', 404)
      return `503 IMP-5003「${error.userMessage}」+ 资源 404`
    })
  })

  await check('⑭ 静态资源：白名单扩展名可读、内容一致、no-store', async () => {
    const js = await clipGet(port, '/clip/assets/app.js')
    assert.equal(js.status, 200, `app.js 应 200，实际 ${js.status}：${js.text.slice(0, 160)}`)
    assert.match(String(js.headers['content-type']), /^text\/javascript/, 'js 的 Content-Type 不能含糊')
    assert.equal(js.headers['cache-control'], 'no-store')
    assert.ok(js.text.includes('CLIP_FIXTURE_APP_JS'), 'js 内容必须与产物逐字一致')
    const css = await clipGet(port, '/clip/assets/style.css')
    assert.equal(css.status, 200)
    assert.match(String(css.headers['content-type']), /^text\/css/)
    return `app.js ${js.text.length} 字节 + style.css ${css.text.length} 字节`
  })

  await check('⑭ 静态资源：白名单外的扩展名一律 404（含产物里的 index.html）', async () => {
    for (const bad of ['secret.txt', 'index.html', 'data.json', 'noext']) {
      const res = await clipGet(port, `/clip/assets/${bad}`)
      expectError(res, 'IMP-3005', 404)
      assert.equal(res.text.includes('CLIP_FIXTURE_TXT'), false, `${bad} 的内容绝不能出网`)
    }
    return 'txt / html / json / 无扩展名 全部 404'
  })

  await check('⑭ 路径穿越一律 404，且 assets 目录外的文件绝不出网', async () => {
    // 判据盯**契约与意图**（「一律 404 + 一个字节都不外泄」），不盯某个具体码号：
    // `new URL()` 会先把路径里的 `..` 段正规化掉（`/clip/assets/../outside.js` → `/clip/outside.js`），
    // 于是它落到页面路由上，回的是 IMP-4017（同为 404）而不是资源面的 IMP-3005。
    // 两者都是「拒绝」，而且都读不到文件 —— 真正要守的是这一条，不是码号长相。
    const attacks = [
      '/clip/assets/../outside.js',
      '/clip/assets/%2e%2e/outside.js',
      '/clip/assets/%2e%2e%2foutside.js',
      '/clip/assets/..%2foutside.js',
      '/clip/assets/..%5coutside.js',
      '/clip/assets//outside.js',
      '/clip/assets/sub/inner.js',
      '/clip/assets/C:%5Cwindows%5Cwin.js',
      '/clip/assets/%2Fetc%2Fpasswd.js',
    ]
    const codes = []
    for (const pathName of attacks) {
      const res = await clipGet(port, pathName)
      assert.equal(res.status, 404, `${pathName} 必须是 404，实际 ${res.status}`)
      assert.ok(res.json && res.json.ok === false, `${pathName} 必须回明确失败，实际 ${res.text.slice(0, 120)}`)
      codes.push(`${pathName}→${res.json.error && res.json.error.code}`)
      assert.equal(res.text.includes('CLIP_OUTSIDE_SENTINEL'), false, `${pathName} 读到了 assets 目录外的文件`)
      assert.equal(res.text.includes('CLIP_NESTED_SENTINEL'), false, `${pathName} 读到了子目录里的文件`)
      assert.equal(res.text.includes('CLIP_FIXTURE_TXT'), false, `${pathName} 读到了白名单外的文件`)
    }
    return `${attacks.length} 种写法全部 404 且 0 字节外泄：${codes.join(' ')}`
  })

  await check('⑭ 页面读暂存：GET /v1/clip/stage 返回正文/标题/来源/标签/时间', async () => {
    const res = await clipGet(port, `/v1/clip/stage?stageId=${clipStaged.stageId}&k=${encodeURIComponent(clipStaged.key)}`)
    assert.equal(res.status, 200, `读暂存应 200，实际 ${res.status}：${res.text.slice(0, 200)}`)
    assert.equal(res.json.ok, true)
    assert.equal('result' in res.json, false, '形状是平铺 { ok, stage, expiresAt }')
    const staged = res.json.stage
    assert.equal(staged.body, CLIP_BODY, '页面必须能拿到**正文**（没有这条端点页面就是个空壳）')
    assert.equal(staged.title, '写给工程师的本地优先笔记')
    assert.equal(staged.url, 'https://example.com/posts/local-first')
    assert.equal(staged.selection, false)
    assert.equal(typeof staged.selection, 'boolean', '契约里 selection 是布尔（不是「选中的那段文字」，选中的文字走 body）')
    assert.deepEqual(staged.tags, ['剪藏', '本地优先'])
    assert.deepEqual(staged.source, { site: 'example.com', author: '张三', publishedAt: '2026-08-14T09:30:00+08:00' })
    assert.deepEqual(staged.assets, [])
    assert.match(String(staged.capturedAt), /(Z|[+-]\d{2}:\d{2})$/, 'capturedAt 必须含时区')
    assert.equal(res.json.expiresAt, clipStaged.expiresAt, 'expiresAt 与 stage 回执必须是同一个值（一个产地）')
    return `${staged.body.length} 字符正文 + 来源/标签/时间齐备`
  })

  await check('⑭ 落点列表：folders[0] === ""（收件箱）+ 去重 + 排序', async () => {
    const res = await clipGet(port, `/v1/clip/folders?stageId=${clipStaged.stageId}&k=${encodeURIComponent(clipStaged.key)}`)
    assert.equal(res.status, 200, `folders 应 200，实际 ${res.status}：${res.text.slice(0, 200)}`)
    assert.equal(res.json.ok, true)
    const folders = res.json.folders
    assert.ok(Array.isArray(folders), 'folders 必须是数组')
    assert.equal(folders[0], '', 'folders[0] 必须是 ""（= 收件箱）—— 页面第一项就是它')
    assert.deepEqual(folders, ['', '剪藏/技术', '归档'], '挂钩给的重复项与空串必须被去重，且顺序确定（码元序）')
    return JSON.stringify(folders)
  })

  await check('⑭ 落点列表：挂钩回 [] → 只有收件箱（空数组 != 读失败）', async () => {
    await withClipBridge({ workspace: true, folders: () => [] }, async (inst) => {
      const staged = clipStagedInfo(await stageClip(inst.port, inst.token))
      const res = await clipGet(inst.port, `/v1/clip/folders?stageId=${staged.stageId}&k=${encodeURIComponent(staged.key)}`)
      assert.equal(res.status, 200, '工作区里没有目录不是失败：必须如实回「只有收件箱」')
      assert.deepEqual(res.json.folders, [''])
      return JSON.stringify(res.json.folders)
    })
  })

  await check('⑭ 落点列表：工作区没打开 → IMP-4007（409，原样用登记文案）', async () => {
    await withClipBridge({ folders: () => ['归档'] }, async (inst) => {
      const staged = clipStagedInfo(await stageClip(inst.port, inst.token))
      const res = await clipGet(inst.port, `/v1/clip/folders?stageId=${staged.stageId}&k=${encodeURIComponent(staged.key)}`)
      const error = expectError(res, 'IMP-4007', 409)
      assert.equal(error.userMessage, ERROR_TABLE['IMP-4007'].userMessage, '工作区没打开是登记语义的精确命中，不许换文案')
      // 非空落点的提交也要在同一处被拦住（不能先写盘再去发现没有工作区）。
      const commit = await clipPost(inst.port, inst.token, '/v1/clip/commit', {
        stageId: staged.stageId,
        k: staged.key,
        title: 't',
        body: 'b',
        folder: '归档',
      })
      expectError(commit, 'IMP-4007', 409)
      assert.equal(inst.holder.calls.length, 0, '工作区没打开时绝不能进入库通路')
      return `folders 与 commit 都 409 IMP-4007（原样文案），入库通路 0 次`
    })
  })

  await check('⑭ 落点列表：挂钩缺失 → IMP-4014（500，原样文案 + 日志留痕）', async () => {
    await withClipBridge({ workspace: true, folders: undefined }, async (inst) => {
      const staged = clipStagedInfo(await stageClip(inst.port, inst.token))
      const res = await clipGet(inst.port, `/v1/clip/folders?stageId=${staged.stageId}&k=${encodeURIComponent(staged.key)}`)
      const error = expectError(res, 'IMP-4014', 500)
      assert.equal(error.userMessage, ERROR_TABLE['IMP-4014'].userMessage, '内部错误用登记文案，不另编一句')
      assert.equal('folders' in (res.json.result || {}), false, '失败响应里不得夹带一个空 folders 数组')
      const commit = await clipPost(inst.port, inst.token, '/v1/clip/commit', {
        stageId: staged.stageId,
        k: staged.key,
        title: '没有目录列表',
        body: 'x',
        folder: '剪藏/技术',
      })
      expectError(commit, 'IMP-4014', 500)
      assert.equal(inst.holder.calls.length, 0, '拿不到目录列表时绝不能进入库通路（否则等于静默改落点）')
      const log = readBridgeLog(inst.dataDir)
      assert.ok(log.includes('"code":"IMP-4014"'), '挂钩拿不到目录列表必须在 bridge.log 留一条事实')
      assert.equal(log.includes(staged.stageId), false, '日志里不得出现 stageId')
      assert.equal(log.includes(staged.key), false, '日志里不得出现 k')
      return '两个端点都 500 IMP-4014 + 日志留痕（不含 stageId/k），入库通路 0 次'
    })
  })

  await check('⑭ commit：复用入库通路（onEnvelope 被调用，信封逐字段正确）', async () => {
    const staged = clipStagedInfo(await stageClip(port, token))
    const before = holder.calls.length
    const res = await clipPost(port, token, '/v1/clip/commit', {
      stageId: staged.stageId,
      k: staged.key,
      title: '改写后的标题',
      body: '页面里编辑过的正文。',
      folder: '',
    })
    assert.equal(res.status, 201, `commit 应 201，实际 ${res.status}：${res.text.slice(0, 200)}`)
    assert.equal(res.json.ok, true)
    assert.equal(holder.calls.length, before + 1, 'commit 必须走 onEnvelope（入库通路）—— 不许另造第二条写路径')
    const envelope = JSON.parse(holder.calls[before].envelopeJson)
    assert.equal(envelope.spec, 'opennote.import/v1')
    assert.equal(envelope.title, '改写后的标题', '标题取 commit 的（页面里编辑过的那份）')
    assert.equal(envelope.body, '页面里编辑过的正文。', '正文取 commit 的')
    assert.equal(envelope.conflict, 'new')
    assert.deepEqual(envelope.target, { folder: null, notePath: null }, 'folder 省略/"" = 不指定落点')
    assert.equal(envelope.client.name, 'opennote.clip-web')
    assert.deepEqual(envelope.tags, ['剪藏', '本地优先'], 'tags 从暂存带过来')
    assert.equal(envelope.source.url, 'https://example.com/posts/local-first')
    assert.equal(envelope.source.title, '写给工程师的本地优先笔记', 'source.title = 抓取那一刻的网页标题')
    assert.equal(envelope.source.site, 'example.com')
    assert.equal(envelope.source.author, '张三')
    assert.equal(envelope.source.publishedAt, '2026-08-14T09:30:00+08:00')
    assert.equal(envelope.source.selection, false)
    assert.match(String(envelope.source.capturedAt), /(Z|[+-]\d{2}:\d{2})$/, 'capturedAt 必须含时区（02 §2.3 硬要求）')
    assert.deepEqual(envelope.assets, [])
    assert.ok(
      typeof envelope.importId === 'string' && envelope.importId.length >= 8,
      `importId 必须是桥生成的有效值，实际「${String(envelope.importId)}」`,
    )
    assert.notEqual(envelope.importId, staged.stageId, 'importId（幂等键）与 stageId（暂存身份）是两件事')
    assert.equal(holder.calls[before].meta.clientName, 'opennote.clip-web', 'meta.clientName 也要如实（日志与 UI 展示用）')
    assert.equal(res.json.result.status, 'created')
    assert.equal(res.json.result.path, '改写后的标题.md', '回执形状与 /v1/import 同形，落点来自渲染层')
    return `信封 ${Object.keys(envelope).length} 键逐项正确；path=${res.json.result.path}`
  })

  await check('⑭ commit：非空落点必须是已存在目录（不存在 → 422 IMP-4022，且不进入库通路）', async () => {
    const missStaged = clipStagedInfo(await stageClip(port, token))
    const beforeMiss = holder.calls.length
    const miss = await clipPost(port, token, '/v1/clip/commit', {
      stageId: missStaged.stageId,
      k: missStaged.key,
      title: '落点不存在',
      body: 'x',
      folder: '不存在的目录',
    })
    const missError = expectError(miss, 'IMP-4022', 422)
    assert.equal(missError.userMessage, ERROR_TABLE['IMP-4022'].userMessage, '目录不存在有自己的码号，登记文案原样用')
    assert.notEqual(missError.userMessage, ERROR_TABLE['IMP-4008'].userMessage, '「不存在」不是「字面非法」，不许借 IMP-4008')
    assert.equal(holder.calls.length, beforeMiss, '落点非法时必须拦在入库通路之前（绝不自动创建目录）')

    // 字面非法那一支**照旧**走 IMP-4008（两条分支不许混成一个码）。
    const absStaged = clipStagedInfo(await stageClip(port, token))
    expectError(
      await clipPost(port, token, '/v1/clip/commit', {
        stageId: absStaged.stageId,
        k: absStaged.key,
        title: '绝对路径',
        body: 'x',
        folder: '../../etc',
      }),
      'IMP-4008',
      422,
    )

    const okStaged = clipStagedInfo(await stageClip(port, token))
    const beforeOk = holder.calls.length
    const ok = await clipPost(port, token, '/v1/clip/commit', {
      stageId: okStaged.stageId,
      k: okStaged.key,
      title: '落到已有目录',
      body: 'x',
      folder: '剪藏/技术',
    })
    assert.equal(ok.status, 201, `已有目录应能落，实际 ${ok.status}：${ok.text.slice(0, 200)}`)
    const envelope = JSON.parse(holder.calls[beforeOk].envelopeJson)
    assert.equal(envelope.target.folder, '剪藏/技术')
    assert.equal(ok.json.result.path, '剪藏/技术/落到已有目录.md')
    return '不存在 → 422 IMP-4022（未入库）；字面非法 → 422 IMP-4008；已有目录 → 201'
  })

  await check('⑭ commit：单次性（同内容重放同一份回执 200/201；不同内容 409 IMP-4018）', async () => {
    const staged = clipStagedInfo(await stageClip(port, token))
    const body = { stageId: staged.stageId, k: staged.key, title: '单次性', body: '第一版正文。', folder: '' }
    const first = await clipPost(port, token, '/v1/clip/commit', body)
    assert.equal(first.status, 201, `首次提交应 201，实际 ${first.status}：${first.text.slice(0, 200)}`)
    const afterFirst = holder.calls.length
    const replay = await clipPost(port, token, '/v1/clip/commit', { ...body })
    assert.equal(replay.status, first.status, '幂等重放必须是同一个 HTTP 状态')
    assert.deepEqual(replay.json.result, first.json.result, '同内容重放必须逐字段返回**同一份**已存回执')
    assert.equal(holder.calls.length, afterFirst, '幂等重放不得再走一次入库通路（不写第二遍）')
    const different = await clipPost(port, token, '/v1/clip/commit', { ...body, body: '第二版正文（不同）。' })
    const error = expectError(different, 'IMP-4018', 409)
    assert.equal(error.userMessage, ERROR_TABLE['IMP-4018'].userMessage, '正式码号，原样用登记文案')
    assert.equal(error.retryable, false, '同一暂存 + 不同内容重试也没用：必须换一次剪藏')
    assert.equal(holder.calls.length, afterFirst, '内容不同也不许写入（不得静默覆盖）')
    return `首次 ${first.status} → 同内容重放 ${replay.status}（同一 importId，通路未再调）→ 改内容 409 IMP-4018`
  })

  await check('⑭ commit：k 错 401 IMP-4019 / stageId 不存在 404 IMP-4021 / Content-Type 非 JSON 415', async () => {
    const staged = clipStagedInfo(await stageClip(port, token))
    const base = { stageId: staged.stageId, k: staged.key, title: 't', body: 'b', folder: '' }
    expectError(await clipPost(port, token, '/v1/clip/commit', { ...base, k: 'A'.repeat(43) }), 'IMP-4019', 401)
    expectError(
      await clipPost(port, token, '/v1/clip/commit', { ...base, stageId: 'B'.repeat(43), k: 'A'.repeat(43) }),
      'IMP-4021',
      404,
    )
    const badType = await request({
      port,
      path: '/v1/clip/commit',
      method: 'POST',
      headers: withHost(port, { 'Content-Type': 'text/plain', Authorization: `Bearer ${token}` }),
      body: JSON.stringify(base),
    })
    expectError(badType, 'IMP-3004', 415)
    return '401 / 404 / 415'
  })

  await check('⑭ 日志红线：bridge.log 里没有 k / stageId / 正文 / 令牌', async () => {
    const logPath = path.join(dataDir, 'bridge.log')
    const text = fs.readFileSync(logPath, 'utf8')
    assert.ok(text.trim() !== '', '日志必须真有内容 —— 否则这条断言只是空跑（恒绿的检查比没有检查更坏）')
    assert.ok(text.includes('"event":"import.ok"'), '剪藏页的 commit 走同一条入库通路，应留下 import.ok')
    const secrets = [
      ['k', clipStaged.key],
      ['stageId', clipStaged.stageId],
      ['暂存正文', CLIP_BODY],
      ['页面里编辑过的正文', '页面里编辑过的正文。'],
      ['长期令牌', token],
    ]
    for (const [label, value] of secrets) {
      assert.equal(text.includes(value), false, `bridge.log 不得出现${label}`)
    }
    return `${text.split('\n').filter(Boolean).length} 行日志；5 类敏感值 0 命中`
  })

  await check('⑭ 产物路径：默认目录 = 仓库根下的 dist-clip，且 build:clip 脚本存在', () => {
    assert.equal(
      CLIP_DIST_RELATIVE,
      'dist-clip',
      '产物目录名不得漂移：package.json 的 build:clip 就写它，.gitignore 与 electron-builder.yml 也按它排除/打包',
    )
    assert.equal(typeof PKG.scripts['build:clip'], 'string', 'package.json 必须有 build:clip 脚本（503 的文案就是让用户跑它）')
    const configPath = path.join(ROOT_DIR, 'vite.clip.config.ts')
    if (fs.existsSync(configPath)) {
      assert.ok(
        fs.readFileSync(configPath, 'utf8').includes('dist-clip'),
        'vite.clip.config.ts 的产物目录必须是 dist-clip（否则桥按约定找不到剪藏页）',
      )
    } else {
      console.log('  INFO vite.clip.config.ts 还不存在（clip-web 正在写）：本轮只钉「目录名 = dist-clip」这一半')
    }
    assert.equal(path.basename(CLIP_DIST_ROOT), 'dist-clip')
    assert.equal(
      path.relative(CLIP_DIST_ROOT, path.join(CLIP_DIST_ROOT, 'clip', 'index.html')).split(path.sep).join('/'),
      'clip/index.html',
      '页面入口必须在产物根的 clip/index.html（与契约逐字一致）',
    )
    if (!process.env.OPENNOTE_BRIDGE_UNDER_TEST) {
      assert.equal(path.resolve(CLIP_DIST_ROOT), path.join(ROOT_DIR, 'dist-clip'), '默认产物目录必须就在仓库根下')
    }
    return `${CLIP_DIST_RELATIVE}；真实产物 ${fs.existsSync(path.join(ROOT_DIR, 'dist-clip', 'clip', 'index.html')) ? '已存在' : '尚未构建（本轮用夹具替身）'}`
  })

  await check('⑭ 真产物（若已构建）：默认产物路径能读到 dist-clip/clip/index.html', async () => {
    const realIndex = path.join(ROOT_DIR, 'dist-clip', 'clip', 'index.html')
    if (process.env.OPENNOTE_BRIDGE_UNDER_TEST) {
      // 变异自检时被测桥是临时目录里的副本（`__dirname/..` = 临时目录），默认产物路径天然指向别处；
      // 这条断言在那种跑法下**不可比**，但不是失败 —— 夹具替身已覆盖同一路径的全部行为。
      skip('被测桥是临时目录里的变异副本：默认产物路径不可比')
    }
    if (!fs.existsSync(realIndex)) {
      skip('dist-clip/clip/index.html 还没构建（clip-web 的 pnpm build:clip）；夹具替身已覆盖同一路径的全部行为')
    }
    // 不传 clip.distRoot：走的就是产品路径（与 main.cjs 装配出来的一模一样）。
    const inst = makeBridge({ dataDir: tempDir('opennote-clip-real-'), folders: () => [] })
    const plain = inst.bridge.regenerateToken()
    const up = await inst.bridge.startWithPort(privatePortCounter++)
    try {
      const staged = clipStagedInfo(await stageClip(up.port, plain))
      const page = await clipGet(up.port, `/clip/${staged.stageId}?k=${encodeURIComponent(staged.key)}`)
      assert.equal(page.status, 200, `默认路径必须能读到真实产物，实际 ${page.status}：${page.text.slice(0, 200)}`)
      assert.ok(page.text.includes(`id="${CLIP_BOOT_ID}"`), '真实产物也必须被注入引导数据块')
      assert.equal(page.headers['content-security-policy'], CLIP_CSP)
      // **用户看得见的那条路径**：页面引用的每个静态资源都必须真的能取到 ——
      // 产物里写的是相对路径（`../clip/assets/index-*.js`），只要桥的路由或产物的 base 有一边漂了，
      // 页面就是一片白（脚本 404）。这里逐个按页面 URL 解析并真取一遍，比断言字符串可靠。
      const refs = [...page.text.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1]).filter((ref) => !ref.startsWith('data:'))
      assert.ok(refs.length > 0, '产物必须引用至少一个静态资源（否则页面不可能渲染）')
      for (const ref of refs) {
        const assetUrl = new URL(ref, `http://127.0.0.1:${up.port}/clip/${staged.stageId}`)
        assert.equal(
          assetUrl.pathname.startsWith('/clip/assets/'),
          true,
          `产物引用的 ${ref} 解析成 ${assetUrl.pathname}，落在桥不服务的位置（只服务 /clip/assets/）`,
        )
        const asset = await clipGet(up.port, `${assetUrl.pathname}${assetUrl.search}`)
        assert.equal(asset.status, 200, `产物引用的资源取不到：${assetUrl.pathname} → ${asset.status}`)
      }
      return `真实产物 ${page.text.length} 字节 + 注入块 + ${refs.length} 个引用资源全部 200`
    } finally {
      await inst.bridge.stop()
    }
  })

  // -------------------------------------------------------------------------
  // 收尾
  // -------------------------------------------------------------------------
  await bridge.stop()
  await main.bridge.stop()

  console.log(`\n${'='.repeat(66)}`)
  console.log(`PASS ${passCount} · FAIL ${failCount} · SKIP ${skipCount}`)
  if (failCount > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  console.log('='.repeat(66))

  if (!KEEP) {
    for (const dir of [workspace, dataDir, clipDistRoot, emptyClipRoot]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论 */
      }
    }
  } else {
    console.log(`保留临时目录：${workspace} / ${dataDir} / ${clipDistRoot} / ${emptyClipRoot}`)
  }

  if (failCount > 0) process.exitCode = 1
}

/**
 * 必测十条（任务验收）对照：
 *   ① 未开启时不监听                       → 「① 未开启时不监听（默认关闭）」
 *   ② 默认 8787 / 占用后回落 8788          → 「② 默认端口…」
 *   ③ Host 非 127.0.0.1/localhost 被拒     → 「③ …」
 *   ④ Origin 不合法被拒                    → 「④ …」
 *   ⑤ text/plain 被拒                      → 「⑤ Content-Type…」
 *   ⑥ token 不匹配 401/对应错误码          → 「⑥ …」
 *   ⑦ 配对码错误被拒 / 正确换 token        → 「⑦ 配对…」
 *   ⑧ 限流触发                             → 「⑧ 限流与体积上限…」
 *   ⑨ 合法信封经 onEnvelope 转交并返回回执 → 「⑨ 合法信封…」
 *   ⑩ 令牌明文只返回一次、内部只存 sha256  → 「⑩ 令牌…」
 *   ⑭ 网页版剪藏页（/v1/clip/*、/clip/）   → 「⑭ …」（0.3.2）
 * 契约 S-01…S-12 见各断言名前缀。
 */

// ---------------------------------------------------------------------------
// 变异自检（node scripts/bridge-smoke.cjs --mutations）
// ---------------------------------------------------------------------------
//
// 为什么自成一段：**守卫的价值不在被写出来，而在被证明能红**。上面那批 ⑭ 用例如果
// 恒绿（例如判据盯错了对象），它们比没有检查更坏 —— 会让下一个人以为这条覆盖了。
// 所以每条变异对应**用户看得见的一条契约**，逐个证明「删掉它，用例真的会红」：
//
//   M1 去掉 k 校验          → 任何人拿到 stageId 就能读走用户正在编辑的剪藏内容
//   M2 commit 绕开入库通路  → 剪藏页变成第二条写路径（落点/去重/前像/通知全绕过）
//   M3 folders[0] 不是 ""   → 页面第一项不再是收件箱，用户点「收件箱」会落到别处
//   M4 产物缺失回空 200     → 页面白屏且没人知道为什么（任务书明令禁止的行为）
//   M5 把 k 的失败改回借 IMP-2002 + 覆盖文案 → 证明「借码号 + 一句话两个产地」这条口子也被守着
//      （C-6c/C-6f 只比对错误表，看不见路由里的覆盖，那种漂移是恒绿的 —— 所以必须自证能红）
//
// 纪律（今天花代价换来的）：
//   - **先证明落地**：打印「锚点命中 N 处 + 改动前后 sha256」；没落地 / 命中数不符 /
//     回读不一致 / `node --check` 失败 → 报 `NO_EFFECT` 并 **exit 2**，不许进入红绿判定。
//   - **M0 零变异对照**：先把**未变异**的副本跑一遍，必须全绿 —— 证明「红」来自变异本身，
//     而不是复制/加载/夹具坏了（否则我们会把工具坏了当成守卫有效）。
//   - 变异只写临时目录，**绝不碰仓库里的 bridge.cjs**。
const MUTATIONS = [
  {
    id: 'M1',
    title: '去掉 /clip 页面的 k 校验（定时安全比较被短路）',
    anchor: "    if (typeof key !== 'string' || !timingSafeEqualText(key, entry.key)) {",
    replace: '    if (false) {',
    expectHits: 1,
    expectFail: '⑭ /clip/<stageId>：k 错',
  },
  {
    id: 'M2',
    title: 'commit 绕过入库通路，自己造一份回执（第二条写路径）',
    // 锚点必须覆盖**整个调用表达式**（含它的参数对象），只替第一行会把参数悬空 → 语法错误，
    // 那样「红」来自 SyntaxError 而不是产品行为（第一次跑就是这么被 node --check 拦下的）。
    anchor: [
      '    const outcome = await runEnvelopePipeline(req, res, {',
      '      envelope,',
      '      importId: envelope.importId,',
      '      clientName: CLIP_CLIENT_NAME,',
      "      clientVersion: '',",
      '      warnings: [],',
      '      startedAt,',
      '    })',
    ].join('\n'),
    replace: [
      '    const outcome = await (async () => {',
      "      const receipt = { status: 'created', importId: envelope.importId, path: `${envelope.title}.md`,",
      '        deduped: false, dedupedBy: null, assets: [], tags: envelope.tags, revertible: true,',
      '        preimage: null, warnings: [], committedAt: new Date().toISOString() }',
      '      sendOk(req, res, 201, receipt)',
      '      return { result: receipt, status: 201 }',
      '    })()',
    ].join('\n'),
    expectHits: 1,
    expectFail: '⑭ commit：复用入库通路',
  },
  {
    id: 'M3',
    title: 'folders 第一项不再是 ""（收件箱从列表里消失）',
    anchor: "    return { ok: true, folders: ['', ...[...seen].sort()] }",
    replace: '    return { ok: true, folders: [...seen].sort() }',
    expectHits: 1,
    expectFail: '⑭ 落点列表：folders[0]',
  },
  {
    id: 'M4',
    title: '产物缺失时回空 200（页面白屏且无人知道原因）',
    anchor: "      writeLog('import.error', { code: 'IMP-5003', detail: 'clip-page-missing' })",
    replace: ["      sendHtml(req, res, 200, '')", "      writeLog('import.error', { code: 'IMP-5003', detail: 'clip-page-missing' })"].join('\n'),
    expectHits: 1,
    expectFail: '⑭ 产物缺失',
  },
  {
    id: 'M5',
    title: 'k 的失败改回「借 IMP-2002 + 覆盖 userMessage」（一句话两个产地）',
    anchor: "      sendError(req, res, 'IMP-4019', { header: 'k' })",
    replace:
      "      sendError(req, res, 'IMP-2002', { header: 'k' }, { userMessage: '剪藏链接的密钥不正确。请回到插件里重新剪藏一次。' })",
    expectHits: 1,
    expectFail: '⑭ /clip/<stageId>：k 错',
  },
]

function countOccurrences(text, needle) {
  return text.split(needle).length - 1
}

/** 把一份（可能变异过的）桥源码落到临时目录：连同 `clip-stage.cjs` 与 `package.json`。 */
function writeBridgeCopy(dir, name, source) {
  const root = path.join(dir, name)
  fs.mkdirSync(path.join(root, 'electron'), { recursive: true })
  fs.writeFileSync(path.join(root, 'electron', 'bridge.cjs'), source, 'utf8')
  fs.copyFileSync(path.join(ROOT_DIR, 'electron', 'clip-stage.cjs'), path.join(root, 'electron', 'clip-stage.cjs'))
  fs.copyFileSync(path.join(ROOT_DIR, 'package.json'), path.join(root, 'package.json'))
  return path.join(root, 'electron', 'bridge.cjs')
}

/** 跑一遍自测（子进程），返回 `{ code, stdout, summary }`。 */
function runSmoke(bridgeFile) {
  const { spawnSync } = require('node:child_process')
  const result = spawnSync(process.execPath, [__filename], {
    encoding: 'utf8',
    env: { ...process.env, OPENNOTE_BRIDGE_UNDER_TEST: bridgeFile },
    timeout: 180000,
    maxBuffer: 32 * 1024 * 1024,
  })
  const stdout = `${result.stdout || ''}${result.stderr || ''}`
  const summary = /^PASS (\d+) · FAIL (\d+) · SKIP (\d+)$/m.exec(stdout)
  return { code: result.status, stdout, summary: summary ? summary[0] : '(没有拿到汇总行)' }
}

async function runMutations() {
  const source = fs.readFileSync(BRIDGE_PATH, 'utf8')
  const dir = tempDir('opennote-bridge-mutants-')
  console.log('='.repeat(66))
  console.log('桥变异自检：每条变异都必须让指定用例变红（纪律：先证明落地，再判红绿）')
  console.log('='.repeat(66))

  // ---- M0 零变异对照 -------------------------------------------------------
  const m0File = writeBridgeCopy(dir, 'm0', source)
  const m0 = runSmoke(m0File)
  console.log(`\n── M0 零变异对照（未变异的副本，必须全绿）──`)
  console.log(`  sha256 ${sha256Hex(fs.readFileSync(m0File, 'utf8'))}`)
  console.log(`  ${m0.summary}`)
  const m0Fail = /FAIL 0/.test(m0.summary)
  if (!m0Fail || m0.code !== 0) {
    console.log('  NO_EFFECT：未变异的副本自己就跑不绿 —— 之后的红绿判定无效（问题在夹具/复制环节，不在守卫）')
    console.log(m0.stdout.split(/\r?\n/).filter((line) => /FAIL/.test(line)).slice(0, 12).join('\n'))
    process.exit(2)
  }

  let survived = 0
  for (const mutation of MUTATIONS) {
    console.log(`\n── ${mutation.id} ${mutation.title} ──`)
    const hits = countOccurrences(source, mutation.anchor)
    const beforeSha = sha256Hex(source)
    console.log(`  锚点：${JSON.stringify(mutation.anchor)}`)
    console.log(`  锚点命中 ${hits} 处（要求 ${mutation.expectHits} 处）`)
    if (hits !== mutation.expectHits) {
      console.log(`  NO_EFFECT：命中 ${hits} 处，期望 ${mutation.expectHits} 处 —— 变异没落地，禁止进入红绿判定`)
      process.exit(2)
    }
    const mutated = source.split(mutation.anchor).join(mutation.replace)
    const afterSha = sha256Hex(mutated)
    console.log(`  sha256 ${beforeSha} → ${afterSha}`)
    if (afterSha === beforeSha) {
      console.log('  NO_EFFECT：改动前后 sha256 相同（替换没有产生任何字节差异），禁止进入红绿判定')
      process.exit(2)
    }
    const file = writeBridgeCopy(dir, mutation.id.toLowerCase(), mutated)
    // 落地自检：回读确认盘上的字节就是我们要的那份。
    const back = sha256Hex(fs.readFileSync(file, 'utf8'))
    if (back !== afterSha) {
      console.log(`  NO_EFFECT：回读 sha256 ${back} != 期望 ${afterSha}（写盘没落地或读到了别的文件）`)
      process.exit(2)
    }
    const { spawnSync } = require('node:child_process')
    const syntax = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    console.log(`  node --check：${syntax.status === 0 ? '通过（变异后仍可加载）' : '失败'}`)
    if (syntax.status !== 0) {
      console.log(`  NO_EFFECT：变异把文件改成了语法错误，「红」不是产品行为造成的\n${syntax.stderr || ''}`)
      process.exit(2)
    }
    const run = runSmoke(file)
    const failLines = run.stdout.split(/\r?\n/).filter((line) => /^\s+FAIL /.test(line))
    const hit = failLines.find((line) => line.includes(mutation.expectFail))
    console.log(`  该次自测：${run.summary}`)
    if (hit && run.code !== 0) {
      console.log(`  RED 如期：${hit.trim()}`)
      if (failLines.length > 1) console.log(`  （另有 ${failLines.length - 1} 条一并变红，符合预期：同一份实现被多处用例守着）`)
    } else if (!hit) {
      console.log(`  MUTATION SURVIVED：变异已落地，但「${mutation.expectFail}」没有变红 —— 这条守卫是恒绿的，必须修`)
      survived += 1
    } else {
      console.log(`  MUTATION SURVIVED：目标用例红了，但退出码是 ${run.code}（应当非 0）`)
      survived += 1
    }
  }

  console.log(`\n${'='.repeat(66)}`)
  console.log(survived === 0 ? `变异自检 PASS：M0 对照绿 + ${MUTATIONS.length}/${MUTATIONS.length} 条变异如期变红` : `变异自检 FAIL：${survived} 条变异存活`)
  console.log('='.repeat(66))
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* 清理失败不影响结论 */
  }
  process.exit(survived === 0 ? 0 : 1)
}

if (process.argv.includes('--mutations')) {
  runMutations().catch((error) => {
    console.error('\n[bridge-smoke --mutations] 未捕获异常：')
    console.error(error && error.stack ? error.stack : error)
    process.exit(2)
  })
} else {
  main().catch((error) => {
    console.error('\n[bridge-smoke] 未捕获异常：')
    console.error(error && error.stack ? error.stack : error)
    process.exitCode = 1
  })
}
