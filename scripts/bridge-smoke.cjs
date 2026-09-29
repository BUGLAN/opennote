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

  await check('④ 受信任 Origin 精确回显，绝不用 * / 绝不 credentials', async () => {
    assert.equal(bridge.addAllowedOrigin(DEV_ORIGIN), true)
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
  section('⑦ 配对：6 位码 / 120 s / 一次性 / 扩展来源放宽（Lead 裁定）')
  // -------------------------------------------------------------------------
  await check('⑦ 未受信 Origin: https://evil.com + 正确配对码 → 403 IMP-3001（扩展放宽不适用于网页）', async () => {
    const code = bridge.newPairCode().code
    const res = await postPair(port, code, 'https://evil.com', { name: 'attacker', version: '1' })
    expectError(res, 'IMP-3001', 403)
    assert.equal(bridge.status().origins.includes('https://evil.com'), false, '未受信来源不得进入 allowedOrigins')
    return '403 IMP-3001'
  })

  await check('⑦ 扩展来源 + 正确配对码 → 200 拿到 token，且 origin 入 allowedOrigins', async () => {
    const pair = makeBridge({ noWindow: true })
    const code = pair.bridge.newPairCode()
    assert.match(code.code, /^\d{6}$/)
    assert.ok(code.expiresAt > Date.now() && code.expiresAt - Date.now() <= 120000, '配对码有效期 120 s')
    pair.bridge.regenerateToken()
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postPair(started.port, code.code, EXT_ORIGIN)
      assert.equal(res.status, 200, `应成功，实际 ${res.status} ${res.text.slice(0, 200)}`)
      assert.equal(res.json.ok, true)
      const result = res.json.result
      assert.equal(result.spec, 'opennote.import/v1')
      assert.equal(result.endpoint, `http://127.0.0.1:${started.port}`)
      assert.equal(result.origin, EXT_ORIGIN)
      assert.match(result.token, /^opn_[A-Za-z0-9_-]{43}$/)
      assert.equal(pair.bridge.status().origins.includes(EXT_ORIGIN), true, 'origin 必须入 allowedOrigins')
      assert.equal(res.headers['access-control-allow-origin'], EXT_ORIGIN, '配对响应必须可被扩展读取')
      return `200 + origin 入白名单（配对码 ${code.code}）`
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 同上但配对码错误 → 401 IMP-2004 且 allowedOrigins 不含该 origin', async () => {
    const pair = makeBridge({ noWindow: true })
    pair.bridge.regenerateToken()
    pair.bridge.newPairCode()
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postPair(started.port, '000000', EXT_ORIGIN)
      expectError(res, 'IMP-2004', 401)
      assert.equal(pair.bridge.status().origins.includes(EXT_ORIGIN), false, '失败路径绝不得写 allowedOrigins')
      const file = JSON.stringify(pair.bridge.status())
      assert.equal(file.includes('chrome-extension://'), false)
      return '401 IMP-2004 且白名单不变'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ moz-extension:// 同样可作配对候选', async () => {
    const pair = makeBridge({ noWindow: true })
    pair.bridge.regenerateToken()
    const code = pair.bridge.newPairCode().code
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postPair(started.port, code, MOZ_ORIGIN, { name: 'firefox-extension', version: '0.1.0' })
      assert.equal(res.status, 200, res.text.slice(0, 200))
      assert.equal(pair.bridge.status().origins.includes(MOZ_ORIGIN), true)
      return '200'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 配对码一次性：同一码第二次 → 401 IMP-2004，且不新增 origin', async () => {
    const pair = makeBridge({ noWindow: true })
    pair.bridge.regenerateToken()
    const code = pair.bridge.newPairCode().code
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const first = await postPair(started.port, code, EXT_ORIGIN)
      assert.equal(first.status, 200)
      const other = 'chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
      const second = await postPair(started.port, code, other)
      expectError(second, 'IMP-2004', 401)
      assert.equal(pair.bridge.status().origins.includes(other), false, '失败路径绝不得写 allowedOrigins')
      return '一次性生效'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 配对码失败 5 次即作废当前码 / 第 6 次触发 429 IMP-2003', async () => {
    const pair = makeBridge({ noWindow: true })
    pair.bridge.regenerateToken()
    const code = pair.bridge.newPairCode().code
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      for (let i = 0; i < 5; i += 1) {
        const res = await postPair(started.port, '111111', EXT_ORIGIN)
        assert.equal(res.status, 401, `第 ${i + 1} 次失败应为 401，实际 ${res.status}`)
        assert.equal(res.json.error.code, 'IMP-2004')
      }
      assert.equal(pair.bridge.status().pairingCode, null, '失败 5 次后当前配对码必须作废')
      const sixth = await postPair(started.port, code, EXT_ORIGIN)
      expectError(sixth, 'IMP-2003', 429)
      assert.ok(sixth.headers['retry-after'], '429 必须带 Retry-After')
      assert.equal(pair.bridge.status().origins.includes(EXT_ORIGIN), false)
      return '失败 5 次作废 + 第 6 次 429'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 配对接口无 Origin 头（CLI）也能换到 token', async () => {
    const pair = makeBridge({ noWindow: true })
    pair.bridge.regenerateToken()
    const code = pair.bridge.newPairCode().code
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const res = await postPair(started.port, code, null, { name: 'cli', version: '0.2.0' })
      assert.equal(res.status, 200, res.text.slice(0, 200))
      assert.equal(res.json.result.origin, null)
      return '无 Origin 放行 + 成功'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 配对交付令牌：未交付的明文直接交付；已交付过则轮换 rotated:true（旧令牌立刻失效）', async () => {
    const pair = makeBridge({})
    const first = pair.bridge.regenerateToken()
    const code1 = pair.bridge.newPairCode().code
    const started = await pair.bridge.startWithPort(privatePortCounter++)
    try {
      const res1 = await postPair(started.port, code1, EXT_ORIGIN)
      assert.equal(res1.status, 200, res1.text.slice(0, 200))
      assert.equal(res1.json.result.token, first, '尚未交付过的明文应直接交付（不轮换）')
      assert.equal(res1.json.result.rotated, false)

      // 明文已交付 → 第二次配对必须轮换，否则客户端会拿到 null 的假成功。
      const code2 = pair.bridge.newPairCode().code
      const res2 = await postPair(started.port, code2, MOZ_ORIGIN)
      assert.equal(res2.status, 200, res2.text.slice(0, 200))
      const second = res2.json.result.token
      assert.equal(typeof second, 'string', '配对必须交出可用的明文令牌，绝不返回 null')
      assert.match(second, /^opn_[A-Za-z0-9_-]{43}$/)
      assert.notEqual(second, first, '已交付过就必须轮换')
      assert.equal(res2.json.result.rotated, true)

      const old = await postImport(started.port, first, validEnvelope())
      expectError(old, 'IMP-2002', 401)
      const fresh = await postImport(started.port, second, validEnvelope())
      assert.equal(fresh.status, 201, `新令牌应可用，实际 ${fresh.status}`)

      const statusJson = JSON.stringify(pair.bridge.status())
      assert.equal(statusJson.includes(second), false, 'status() 不得回显新明文')
      assert.equal(pair.bridge.status().tokenLast4, second.slice(-4), 'last4 必须跟着换')

      // 面板据此提示「已配对 1 个客户端」与轮换警告（UI-04/R4b）。
      const last = pair.bridge.status().lastPairing
      assert.equal(typeof last, 'object', 'status().lastPairing 必须存在（面板无新 IPC 可依赖）')
      assert.equal(last.origin, MOZ_ORIGIN, 'lastPairing.origin 应为最近配对的来源')
      assert.equal(last.rotated, true, 'lastPairing.rotated 必须如实反映轮换')
      assert.equal(Number.isFinite(last.at), true)
      assert.equal(statusJson.includes(second), false, 'lastPairing 不得含明文')
      return '未交付直接交付 / 已交付则轮换 / lastPairing 可观测'
    } finally {
      await pair.bridge.stop()
    }
  })

  await check('⑦ 控制器级 pair(code)：错码 → {ok:false,errorCode}，正确 → {ok:true,token}', async () => {
    const pair = makeBridge({ noWindow: true })
    const expected = pair.bridge.regenerateToken()
    const code = pair.bridge.newPairCode().code
    const bad = pair.bridge.pair('000000')
    assert.equal(bad.ok, false)
    assert.equal(bad.errorCode, 'IMP-2004')
    const good = pair.bridge.pair(code)
    assert.equal(good.ok, true)
    assert.equal(good.token, expected)
    return '冻结接口 pair() 形态一致'
  })

  await check('S-11 伪造扩展来源不被信任（长度/大小写/协议不符）', async () => {
    const bogus = [
      'chrome-extension://ABC',
      'chrome-extension://ABCDEFGHIJKLMNOP',
      'CHROME-EXTENSION://abcdefghijklmnopabcdefghijklmnop',
      'chrome-extension://',
      'chrome-extension://abcdefghijklmnopabcdefghijklmnop/extra',
      'moz-extension://short',
      'safari-web-extension://abcdefghijklmnopabcdefghijklmnop',
      'http://chrome-extension://abcdefghijklmnop',
    ]
    const code = bridge.newPairCode().code
    for (const origin of bogus) {
      const res = await postPair(port, code, origin)
      assert.equal(res.status, 403, `【${origin}】应 403，实际 ${res.status} ${res.text.slice(0, 120)}`)
      assert.equal(res.json.error.code, 'IMP-3001')
      assert.equal(bridge.status().origins.includes(origin), false, `【${origin}】不得进入白名单`)
    }
    return `${bogus.length} 种伪造来源全部 403`
  })

  await check('扩展放宽只作用于 /v1/pair：未受信扩展来源访问 import / workspace 仍 403', async () => {
    const fresh = 'chrome-extension://qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    const imported = await postImport(port, token, validEnvelope(), { Origin: fresh })
    expectError(imported, 'IMP-3001', 403)
    assert.equal(imported.headers['access-control-allow-origin'], undefined, '不得回显 CORS 头')
    const ws = await request({ port, path: '/v1/workspace', headers: withHost(port, { Origin: fresh, Authorization: `Bearer ${token}` }) })
    expectError(ws, 'IMP-3001', 403)
    const list = await request({ port, path: '/v1/imports', headers: withHost(port, { Origin: fresh, Authorization: `Bearer ${token}` }) })
    expectError(list, 'IMP-3001', 403)
    return 'import / workspace / imports 都 403'
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

  await check('S-08 日志搜不到令牌明文与配对码，status() 不含令牌明文；都不写进工作区', async () => {
    const code = bridge.newPairCode().code
    const logs = holder.logs
    assert.ok(logs.length > 0, '应有日志产出')
    const logText = logs.join('\n')
    assert.equal(logText.includes(token), false, '日志不得含令牌明文')
    assert.equal(logText.includes(code), false, '日志不得含配对码')
    const statusJson = JSON.stringify(bridge.status())
    assert.equal(statusJson.includes(token), false, 'status() 不得含令牌明文')
    // status() 里的 pairingCode 是 UI 显示配对码的正规通道（有效期内），不属于泄漏；
    // 但令牌明文在任何情况下都不得出现。
    assert.equal(/opn_[A-Za-z0-9_-]{20,}/.test(statusJson), false, 'status() 不得出现任何完整令牌')
    const inWorkspace = listFilesRecursive(workspace).filter((file) => /bridge\.(log|json)$/.test(file))
    assert.deepEqual(inWorkspace, [], '日志不得写进工作区')
    const disk = path.join(dataDir, 'bridge.log')
    if (fs.existsSync(disk)) {
      const raw = fs.readFileSync(disk, 'utf8')
      assert.equal(raw.includes(token), false, 'bridge.log 不得含令牌明文')
      assert.equal(raw.includes(code), false, 'bridge.log 不得含配对码')
      for (const line of raw.trim().split('\n')) {
        const parsed = JSON.parse(line)
        assert.equal(typeof parsed.ts, 'string')
        assert.equal(typeof parsed.event, 'string')
      }
    }
    return `${logs.length} 行日志，无令牌/配对码`
  })

  await check('日志事件名与字段在白名单内（JSONL）', async () => {
    const allowed = new Set([
      'bridge.start', 'bridge.stop', 'bridge.listen-error', 'pair.ok', 'pair.fail',
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
