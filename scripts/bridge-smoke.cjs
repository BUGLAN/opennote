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

const { createBridge, ERROR_TABLE, PORT_RANGE_START, PORT_RANGE_END, TOKEN_LENGTH, sha256Hex } = require('../electron/bridge.cjs')

const VERBOSE = process.argv.includes('--verbose')
const KEEP = process.argv.includes('--keep')
const BASE_PORT = 8787
const FALLBACK_PORT = 8788
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
const MOZ_ORIGIN = 'moz-extension://fedcba9876543210fedcba9876543210'
const DEV_ORIGIN = 'http://127.0.0.1:5173'
/** UI 文案的**唯一来源**：设置面板 R1 的四个选项名必须与它逐字一致（㉕ 把「推荐」移到了收件箱）。 */
const UI_SPEC_PATH = path.join(__dirname, '..', 'docs', 'import', '03-UI设计规范-剪藏与导入.md')
const PANEL_PATH = path.join(__dirname, '..', 'src', 'components', 'ImportApiPanel.tsx')
/** 桥源码：用来断言「配对实现真的被删干净了」，而不是只看行为。 */
const BRIDGE_PATH = path.join(__dirname, '..', 'electron', 'bridge.cjs')
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
    getAppVersion: () => '0.2.0',
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

  console.log('Opennote 本地桥自测（不需要 Electron）')
  console.log(`node=${process.version} platform=${process.platform}`)
  console.log(`临时工作区：${workspace}${KEEP ? '（--keep：不清理）' : ''}`)

  // 主实例：放宽限流，专做功能断言（限流本身由独立实例断言）。
  const main = makeBridge({
    dataDir,
    workspace: true,
    limits: { importCapacity: 5000, importRefillPerMinute: 6000, authFailLimit: 5000 },
    onInboxStateWrite: false,
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

  await check('bridge.json 只存 sha256 十六进制 + last4，绝不含明文', async () => {
    const file = path.join(dataDir, 'bridge.json')
    assert.equal(fs.existsSync(file), true, 'dataDir 给定时应写 bridge.json')
    const raw = fs.readFileSync(file, 'utf8')
    assert.equal(raw.includes(token), false, 'bridge.json 不得含令牌明文')
    const parsed = JSON.parse(raw)
    assert.match(parsed.tokenHash, /^[a-f0-9]{64}$/, 'tokenHash 必须是 sha256 十六进制')
    assert.equal(parsed.tokenHash, sha256Hex(token), '哈希必须等于 sha256(明文)')
    assert.equal(parsed.tokenLast4, token.slice(-4))
    assert.deepEqual(parsed.allowedOrigins, [], 'allowedOrigins 默认空')
    return `tokenHash=${parsed.tokenHash.slice(0, 16)}… last4=${parsed.tokenLast4}`
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

  await check('㊲ 本会话内明文可反复复制：tokenVisible=true，且明文不进 status()', async () => {
    const inst = makeBridge({})
    const plain = inst.bridge.regenerateToken()
    const first = inst.bridge.status()
    assert.equal(first.tokenVisible, true, '刚生成后本会话必须持有明文')
    const json = JSON.stringify(first)
    assert.equal(json.includes(plain), false, 'status() 绝不回显明文')
    assert.equal(/opn_[A-Za-z0-9_-]{20,}/.test(json), false, 'status() 不得出现任何完整令牌')
    // 关掉接口再开**不是**「应用退出」：明文必须还在，否则面板会在开关一次后突然不能复制。
    await inst.bridge.startWithPort(privatePortCounter++)
    await inst.bridge.stop()
    assert.equal(inst.bridge.status().tokenVisible, true, 'stop() 不得清掉本会话明文')
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

  await check('㊲ 重启（新 controller）后 tokenVisible=false，但令牌**没有**失效', async () => {
    const dir = tempDir('opennote-bridge-tokenvisible-')
    const first = makeBridge({ dataDir: dir })
    const plain = first.bridge.regenerateToken()
    const up = await first.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201)
    } finally {
      await first.bridge.stop()
    }
    // 应用重启 = 新的 controller：内存明文没了，磁盘上的哈希还在。
    const second = makeBridge({ dataDir: dir })
    const status = second.bridge.status()
    assert.equal(status.tokenVisible, false, '重启后不得声称还持有明文（否则面板会复制一串拿不到的东西）')
    assert.equal(status.tokenSet, true, '令牌本身仍然有效')
    assert.equal(JSON.stringify(status).includes(plain), false)
    const again = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(again.port, plain, validEnvelope())).status, 201, '令牌长期有效：重启不影响')
      // 重新生成 → 本会话重新持有明文；旧令牌同时作废。
      const fresh = second.bridge.regenerateToken()
      assert.equal(second.bridge.status().tokenVisible, true, '重新生成后本会话重新持有明文')
      assert.notEqual(fresh, plain)
      const stale = await postImport(again.port, plain, validEnvelope())
      expectError(stale, 'IMP-2002', 401)
    } finally {
      await second.bridge.stop()
    }
    return '重启后不可复制但令牌仍有效；重新生成后恢复可复制'
  })

  await check('㊲ setTokenHash 读回外部哈希时必须丢弃内存明文（否则会复制一串不对应的令牌）', async () => {
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

  await check('㊲③ getSessionPlaintext() 与「面板可复制的那串」逐字相同，而且真的能用', async () => {
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

  await check('㊲③ 只读频道绝不轮换：连调两次同一串，读取前后旧令牌都能导入', async () => {
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

  await check('㊲③ 重启（新 controller）后只读频道返回 null，但令牌本身仍然有效', async () => {
    const dir = tempDir('opennote-bridge-sessiontoken-')
    const first = makeBridge({ dataDir: dir })
    const plain = first.bridge.regenerateToken()
    assert.equal(first.bridge.getSessionPlaintext(), plain)
    // 应用重启 = 新的 controller：内存明文没了，磁盘上的哈希还在 —— 这两件事必须分开断言。
    const second = makeBridge({ dataDir: dir })
    assert.equal(second.bridge.getSessionPlaintext(), null, '不可见：内存明文随进程消失')
    assert.equal(second.bridge.status().tokenVisible, false)
    assert.equal(second.bridge.status().tokenSet, true, '不可见 ≠ 失效')
    const up = await second.bridge.startWithPort(privatePortCounter++)
    try {
      assert.equal((await postImport(up.port, plain, validEnvelope())).status, 201, '令牌本身仍然有效')
      assert.equal(second.bridge.getSessionPlaintext(), null, '仍然 null —— 不能因为被用了一次就冒出来')
    } finally {
      await second.bridge.stop()
    }
    return '读回 null 且 tokenSet=true；令牌仍 201'
  })

  await check('㊲③ 明文绝不外溢：status() 的 JSON 里不含 `opn_` 前缀子串', async () => {
    const inst = makeBridge({ noWindow: true })
    const plain = inst.bridge.regenerateToken()
    const json = JSON.stringify(inst.bridge.status())
    assert.equal(json.includes('opn_'), false, 'status() 不得出现任何 `opn_` 前缀子串')
    assert.equal(json.includes(plain), false)
    assert.equal(json.includes(plain.slice(-8)), false, '连后 8 位也不额外外溢（只有后 4 位是有意公开的）')
    assert.equal(json.includes('sessionPlaintext'), false, '连内存字段名都不该出现')
    return 'status() 无 opn_ 子串、无明文中段、无内存字段名'
  })

  await check('㊲ tokenVisible 要能穿过 IPC：main.cjs 的 bridgeStatusPayload 必须 `...raw` 展开', async () => {
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

  await check('㊲③ 只读频道三处接线必须一致（preload arity 0 / main 走只读方法 / 不得挂到轮换）', async () => {
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

  await check('⑨ 渲染层报 IMP-4008（folder 越界）→ 422，且工作区外无新文件', async () => {
    const before = listFilesRecursive(path.dirname(workspace)).filter((file) => file.startsWith(workspace)).length
    const res = await postImport(port, token, validEnvelope({ target: { folder: '../../etc', notePath: null } }))
    expectError(res, 'IMP-4008', 422)
    const after = listFilesRecursive(path.dirname(workspace)).filter((file) => file.startsWith(workspace)).length
    assert.equal(after, before, '越界请求不得产生任何文件')
    return '422 IMP-4008'
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
    assert.equal(result.app, '0.2.0')
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

  await check('持久化：新实例读回 tokenHash + last4 + allowedOrigins（明文不可恢复）', async () => {
    // 自己播种遗留列表，不依赖前面用例跑过（红的时候不该连坐）。
    assert.equal(bridge.addAllowedOrigin(DEV_ORIGIN), true)
    const reloaded = makeBridge({ dataDir, workspace: true })
    const status = reloaded.bridge.status()
    assert.equal(status.tokenSet, true, '应读回令牌哈希')
    assert.equal(status.tokenLast4, token.slice(-4))
    assert.equal(status.tokenPersisted, true)
    assert.ok(status.origins.includes(DEV_ORIGIN), 'allowedOrigins 应被读回')
    assert.equal(JSON.stringify(status).includes(token), false, 'status 不得回显明文')
    const started = await reloaded.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postImport(started.port, token, validEnvelope())
      assert.equal(res.status, 201, `读回的哈希应能验证原令牌，实际 ${res.status}`)
      return '哈希读回 + 原令牌仍有效'
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
    for (const dir of [workspace, dataDir]) {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论 */
      }
    }
  } else {
    console.log(`保留临时目录：${workspace} / ${dataDir}`)
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
 * 契约 S-01…S-12 见各断言名前缀。
 */
main().catch((error) => {
  console.error('\n[bridge-smoke] 未捕获异常：')
  console.error(error && error.stack ? error.stack : error)
  process.exitCode = 1
})
