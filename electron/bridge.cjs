'use strict'

/**
 * Opennote 本地桥（桌面版主进程内的极小 HTTP 服务）。
 *
 * 契约来源：docs/import/02-接口契约-导入信封与通道.md §5.2（绑地址/端口/四道校验/
 * 限流/令牌）、§10（IPC 频道）、§11（硬红线）、§12（S-01…S-12 门禁）；
 * 0.3.1 起以 00 号 §6.15 的 ㉞/㉟/㊱ 为准：**配对整体删除，改用「URL + 长期令牌」**。
 *
 * 设计边界（逐条对应硬红线）：
 *   - 零新依赖：只用 node:http / node:crypto / node:fs，没有 express/fastify/ws。
 *   - 只绑 127.0.0.1：server.listen(port, '127.0.0.1')，绝不 listen(port)、绝不 0.0.0.0/::1。
 *   - 桥只做「传输 + 安全校验」：信封落盘一律经 onEnvelope 转交渲染层
 *     （主进程写正文会被 rescanWorkspace() 起始的 flushAll() 覆盖）。
 *   - 唯一可由主进程写的内容是 .opennote/inbox/<entry>/state.json，且原子写（tmp + rename）。
 *   - 只提供导入，不提供读取/删除/移动/任意 mkdir；绝不接受信封里的绝对路径。
 *   - 令牌服务端只存 sha256，明文只在 generateToken() 的那一刻返回一次。
 *   - **令牌是唯一凭据且长期有效**（0.3.1 ㉞）：任何能读到扩展 storage 或剪贴板的程序
 *     都能拿到明文并获得**导入**能力（不等于读笔记能力）。这条代价已写进设置面板说明句。
 *
 * 来源（第 2 道校验）在 0.3.1 改为**按类型**：扩展 `chrome-extension://` / `moz-extension://`、
 * 本机回环 `http://127.0.0.1[:port]`、`file://` 放行；`Origin: null`、空串与任何普通网页
 * 来源一律 403 —— 去掉配对是少一道人工步骤，不是让任意网站都能驱动本机接口。
 *
 * 挂钩接口（与 Lead 冻结的接口逐字一致）：
 *   createBridge({
 *     getWindow, onEnvelope, onInboxStateWrite, isEnabled, getTokenHash,
 *     getAdvancedOverwrite, log,
 *     // 可选扩展（不传即退化，不影响冻结面）：
 *     dataDir, getWorkspaceInfo, getAppVersion, getInboxEnabled, getRecentImports,
 *     getImportRecord, getTags, getInboxMode,
 *   }) -> BridgeController
 *
 * 只读交付模式（㉕）：`GET /v1/health` 与 `GET /v1/workspace` 的响应都带 `inboxMode` 字段：
 *   - `"inbox"`：非应用内通道的导入会**先进入收件箱**等待用户确认（0.3.0 起应用侧默认值）；
 *   - `"direct"`：直接落盘（0.2.0 行为）；
 *   - `null`：挂载方没有提供 `getInboxMode()`，桥**不知道**应用侧的设置。客户端不得据此
 *     推断交付方式，一律以导入回执的 `status`（`created` / `pending` / `deduped`）为准。
 * 该字段是**只读**的：请求体里出现同名键一律忽略，不影响任何写入路径。
 */

const http = require('node:http')
const crypto = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')

// ---------------------------------------------------------------------------
// 常量（契约 §5.2 数字逐字）
// ---------------------------------------------------------------------------

const DEFAULT_PORT = 8787
const PORT_RANGE_START = 8787
const PORT_RANGE_END = 8796
/** 顺序尝试的端口个数（默认 8787–8796 共 10 个）。 */
const PORT_COUNT = PORT_RANGE_END - PORT_RANGE_START + 1
const CUSTOM_PORT_MIN = 1024
const CUSTOM_PORT_MAX = 65535

const TOKEN_PREFIX = 'opn_'
/** randomBytes(32) → base64url = 43 字符；加前缀共 47。 */
const TOKEN_SECRET_LENGTH = 43
const TOKEN_LENGTH = TOKEN_PREFIX.length + TOKEN_SECRET_LENGTH
const TOKEN_PATTERN = /^opn_[A-Za-z0-9_-]{43}$/

const SPEC_VERSION = 'opennote.import/v1'
const APP_VERSION = '0.2.0'

/** 请求体 16 MiB（解析前按 Content-Length 拒绝）。 */
const MAX_REQUEST_BYTES = 16 * 1024 * 1024
/** 令牌桶：容量 10、补充 60/分钟 → 1 令牌/秒。 */
const RATE_CAPACITY = 10
const RATE_REFILL_PER_MS = 60 / 60000
/** 鉴权失败 10 次/分钟。 */
const AUTH_FAIL_LIMIT = 10
const AUTH_FAIL_WINDOW_MS = 60000
/**
 * 0.3.1（00 号 §6.15㉞）**配对功能整体删除**：`POST /v1/pair`、6 位配对码、120 s 有效期、
 * 一次性、连续 5 次作废、「配对成功即轮换令牌」全部移除。客户端改用「URL + 长期令牌」：
 * 在设置面板复制一次令牌，粘贴到客户端，长期有效（只在用户重新生成时失效）。
 */
/** 同时进行的 /v1/import 为 1，排队超过 10 s → 409 IMP-4020。 */
const IMPORT_QUEUE_LIMIT_MS = 10000
/** 单请求最长处理时间。 */
const REQUEST_TIMEOUT_MS = 10000

const CONTENT_TYPES = ['application/json', 'application/opennote+json']
const CORS_METHODS = 'GET, POST, OPTIONS'
const CORS_HEADERS = 'Authorization, Content-Type, X-Opennote-Token'

const ENTRY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

const STATE_NAMES = {
  disabled: '未开启',
  stopped: '已停止',
  starting: '正在启动',
  running: '运行中',
  'port-busy': '端口被占用',
  failed: '启动失败',
}

/** 错误码表：HTTP 状态 + 简报文案 + 是否可重试。文案取自契约 §6.2。 */
const ERROR_TABLE = {
  'IMP-1001': { http: 503, retryable: true, message: '客户端连不上本地接口', userMessage: '本地接口未开启。请在 Opennote 的「设置 · 文件 · 导入与接口」里开启，然后重试。' },
  'IMP-1002': { http: 500, retryable: false, message: '本地接口启动失败', userMessage: '本地接口启动失败，端口可能被安全软件占用。可在设置里换一个端口，或查看日志。' },
  'IMP-1003': { http: 409, retryable: true, message: '端口全部被占用', userMessage: '8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。' },
  'IMP-1004': { http: 504, retryable: true, message: '请求超时', userMessage: '本地接口没有及时响应。请确认 Opennote 正在运行。' },
  'IMP-1005': { http: 403, retryable: false, message: 'Host 头缺失或不在白名单', userMessage: '请求被本地接口拒绝。' },
  'IMP-1006': { http: 409, retryable: false, message: '当前平台不支持该导入形态', userMessage: '这个导入方式需要 Opennote 桌面版。' },
  // 0.3.1（㉞）：语义从「还没配对」改为「还没配置令牌」——配对已删除，凭据只有令牌。
  'IMP-2001': { http: 401, retryable: false, message: '缺少访问令牌', userMessage: '这个客户端还没有配置访问令牌。请在 Opennote 的「导入与接口」里复制令牌，粘贴到客户端。' },
  'IMP-2002': { http: 401, retryable: false, message: '令牌格式错误或哈希不匹配', userMessage: '访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。' },
  'IMP-2003': { http: 429, retryable: true, message: '鉴权失败次数过多', userMessage: '尝试次数过多，请稍后再试。' },
  // ⚠️ 已作废（0.3.1 ㉞）：配对码整体删除，本码**不再产出**；保留码号以免与历史日志/文档冲突，不得复用给别的语义。
  'IMP-2004': { http: 401, retryable: false, message: '配对码错误、过期或已使用', userMessage: '配对码不正确或已过期，请在 Opennote 里重新生成。' },
  // 0.3.1：Origin 判据改为按类型（扩展 / 本机回环 / file://），不再是「信任列表 + 配对」。
  'IMP-3001': { http: 403, retryable: false, message: 'Origin 类型不被接受', userMessage: '来源未被允许。本地接口只接受浏览器扩展与本机程序发来的请求。' },
  'IMP-3002': { http: 400, retryable: false, message: 'JSON 解析失败', userMessage: '导入内容不是有效的 JSON，请重试。' },
  'IMP-3003': { http: 400, retryable: false, message: '请求体为空', userMessage: '导入内容为空。' },
  'IMP-3004': { http: 415, retryable: false, message: 'Content-Type 不被接受', userMessage: '请求格式不被接受。' },
  'IMP-3005': { http: 404, retryable: false, message: '方法或路径不存在', userMessage: '接口地址或方法不对。' },
  'IMP-4001': { http: 400, retryable: false, message: '请求体不是 JSON 对象', userMessage: '导入内容格式不正确。' },
  'IMP-4002': { http: 422, retryable: false, message: 'spec 缺失或版本不匹配', userMessage: '这个客户端版本太旧（或太新），请更新后再试。' },
  'IMP-4003': { http: 422, retryable: false, message: '必填字段缺失或取值非法', userMessage: '导入内容缺少必要信息（标题、来源时间或地址），请重试。' },
  'IMP-4004': { http: 413, retryable: false, message: '正文超过 8 MiB', userMessage: '正文太长了（超过 8 MB），请分次导入。' },
  'IMP-4005': { http: 413, retryable: false, message: '请求体超过 16 MiB', userMessage: '这次剪藏的内容太大（超过 16 MB），请分次导入或去掉图片。' },
  // ㉗（00 号 §6.14）：区分「应用没运行」（4006）与「工作区没打开」（4007），逐字冻结。
  'IMP-4006': { http: 409, retryable: true, message: '应用窗口不在场', userMessage: 'Opennote 没有在运行。请先打开 Opennote，再试一次。' },
  'IMP-4007': { http: 409, retryable: false, message: '工作区未打开', userMessage: 'Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。' },
  'IMP-4008': { http: 422, retryable: false, message: 'target.folder 非法', userMessage: '目标目录不合法：不能使用 ..、绝对路径或系统保留字符。' },
  'IMP-4009': { http: 404, retryable: false, message: '目标笔记不存在或目录无法创建', userMessage: '找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。' },
  'IMP-4010': { http: 409, retryable: false, message: '无法分配文件名', userMessage: '这个目录里同名文件太多了，请换一个目录或改标题。' },
  'IMP-4011': { http: 409, retryable: false, message: 'overwrite 条件不满足，已降级为 new', userMessage: '「覆盖」不可用，已改为新建一篇。' },
  'IMP-4012': { http: 415, retryable: false, message: '附件无法导入', userMessage: '有一个附件无法导入（格式不支持或太大）。' },
  'IMP-4013': { http: 413, retryable: false, message: '附件数量或体积超限', userMessage: '附件太多或太大，请减少后用重新剪藏。' },
  'IMP-4014': { http: 500, retryable: true, message: '内部一致性错误', userMessage: '导入时出现了内部错误，已记录日志。请重试一次。' },
  'IMP-4015': { http: 429, retryable: true, message: '超过限流', userMessage: '导入太频繁了，请稍等几秒再试。' },
  'IMP-4017': { http: 404, retryable: false, message: '查询的 importId 不存在', userMessage: '没有找到这条导入记录。' },
  'IMP-4020': { http: 409, retryable: true, message: '同一 importId 的在途提交超过 10 s', userMessage: '上一次导入还在进行中，请稍候重试。' },
  'IMP-5001': { http: 500, retryable: true, message: '写盘失败', userMessage: '写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。' },
  'IMP-5002': { http: 503, retryable: true, message: '本地接口未开启', userMessage: '本地接口当前不在运行状态。请先在 Opennote 的「设置 · 文件 · 导入与接口」里开启接口，再重试。' },
}

const WARNING_TEXT = {
  'IMP-W001': '正文为空，只写入了标题。',
  'IMP-W002': '正文里有未声明的本地附件引用，已原样保留。',
  'IMP-W003': '没找到要追加的笔记，已新建一篇。',
  'IMP-W004': '目标笔记有外部改动，已另存为新文件以免覆盖。',
  'IMP-W005': '幂等索引写入失败，重复导入可能产生副本。',
  'IMP-W006': '网页发布时间无法识别，已忽略。',
  'IMP-W007': '部分标签不符合规则，已忽略。',
  'IMP-W008': '本次追加没有留下可回退的前像，撤销将只把笔记移入回收站。',
  'IMP-4011': '「覆盖」不可用，已改为新建一篇。',
}

/** 日志事件名（契约 §10 逐字）。 */
const LOG_EVENTS = new Set([
  'bridge.start', 'bridge.stop', 'bridge.listen-error',
  'import.ok', 'import.deduped', 'import.error', 'auth.fail', 'origin.reject',
  'host.reject', 'ratelimit',
])

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function clampText(value, max) {
  const text = typeof value === 'string' ? value : String(value == null ? '' : value)
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex')
}

/** 定时安全比较两个十六进制哈希（长度不等直接 false，不抛异常）。 */
function timingSafeEqualText(a, b) {
  const left = Buffer.from(String(a || ''), 'utf8')
  const right = Buffer.from(String(b || ''), 'utf8')
  if (left.length !== right.length || left.length === 0) return false
  return crypto.timingSafeEqual(left, right)
}

/** 生成 47 字符令牌：opn_ + 43 字符 base64url。 */
function generateToken() {
  return TOKEN_PREFIX + crypto.randomBytes(32).toString('base64url')
}

/** 端口合法性：整数、非 0、落在 1024–65535。 */
function normalizePort(value) {
  const port = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof port !== 'number' || !Number.isInteger(port)) return null
  if (port < CUSTOM_PORT_MIN || port > CUSTOM_PORT_MAX) return null
  return port
}

/** Content-Type：只要不带参数的主类型命中白名单（允许 charset 参数）。 */
function isJsonContentType(value) {
  if (typeof value !== 'string') return false
  const main = value.split(';')[0].trim().toLowerCase()
  return CONTENT_TYPES.includes(main)
}

/**
 * 来源类型判据（0.3.1 ㉞）：不再靠「配对成功后加入白名单」，而是**按类型**判断。
 *   放行：`chrome-extension://<id>`、`moz-extension://<id>`、`http://127.0.0.1:<port>`、`file://`
 *   拒绝：任何普通网页来源（`https://evil.example`、任何非回环 http(s) 域名）
 * 普通网页能带令牌发请求 → 等于任意网站都能驱动本机接口，所以**去掉配对不等于放宽这一条**。
 */
function isExtensionOrigin(value) {
  return /^(?:chrome|moz)-extension:\/\/[a-z0-9]{8,64}$/.test(String(value))
}

/** 本机回环来源（只认 127.0.0.1 字面量，端口可省）。`localhost` 不在白名单内。 */
function isLoopbackOrigin(value) {
  return /^http:\/\/127\.0\.0\.1(?::\d{1,5})?$/.test(String(value))
}

/** 本地文件来源（字面量 `file://`；注意浏览器给 `file://` 页面发的是 `Origin: null`，那条仍然拒绝）。 */
function isFileOrigin(value) {
  return /^file:\/\//.test(String(value))
}

/** 按类型放行来源。 */
function isAcceptedOrigin(value) {
  return isExtensionOrigin(value) || isLoopbackOrigin(value) || isFileOrigin(value)
}

/** 日志脱敏：令牌明文绝不出现在日志/错误消息里。 */
function redact(text) {
  if (typeof text !== 'string') return text
  return text
    .replace(/opn_[A-Za-z0-9_-]{10,}/g, 'opn_***')
    .replace(/\b\d{6}\b/g, '******')
}

/** 从配置里读一个正整数阈值；非法/缺失时用契约默认值。 */
function readLimit(value, fallback) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return fallback
  return number
}

function newTokenBucket(capacity, refillPerMs) {
  return { tokens: capacity, capacity, refillPerMs, at: Date.now() }
}

/** 取走一个令牌；成功返回 0，失败返回需要等待的秒数。 */
function takeToken(bucket) {
  const now = Date.now()
  const elapsed = now - bucket.at
  bucket.at = now
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + elapsed * bucket.refillPerMs)
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1
    return 0
  }
  const waitMs = Math.ceil((1 - bucket.tokens) / bucket.refillPerMs)
  return Math.max(1, Math.ceil(waitMs / 1000))
}

function newSlidingWindow(limit, windowMs) {
  return { hits: [], limit, windowMs }
}

/** 记录一次失败；返回 true 表示已超过阈值。 */
function recordHit(window, now = Date.now()) {
  window.hits = window.hits.filter((at) => now - at < window.windowMs)
  window.hits.push(now)
  return window.hits.length > window.limit
}

function windowRetryAfter(window, now = Date.now()) {
  const oldest = window.hits.find((at) => now - at < window.windowMs)
  if (oldest == null) return 1
  return Math.max(1, Math.ceil((oldest + window.windowMs - now) / 1000))
}

// ---------------------------------------------------------------------------
// createBridge
// ---------------------------------------------------------------------------

/**
 * @param {object} options 见文件头注释（冻结接口 + 可选扩展）。
 * @returns {{start: Function, stop: Function, status: Function, regenerateToken: Function, generateToken: Function, getSessionPlaintext: Function, writeInboxState: Function, readAllowedOrigins: Function, addAllowedOrigin: Function, removeAllowedOrigin: Function}}
 */
function createBridge(options = {}) {
  const hasGetWindow = typeof options.getWindow === 'function'
  const getWindow = hasGetWindow ? options.getWindow : () => null
  const onEnvelope = typeof options.onEnvelope === 'function' ? options.onEnvelope : null
  const onInboxStateWrite = typeof options.onInboxStateWrite === 'function' ? options.onInboxStateWrite : null
  const isEnabled = typeof options.isEnabled === 'function' ? options.isEnabled : null
  const getTokenHash = typeof options.getTokenHash === 'function' ? options.getTokenHash : null
  const getAdvancedOverwrite = typeof options.getAdvancedOverwrite === 'function' ? options.getAdvancedOverwrite : null
  const isLogEnabled = typeof options.isLogEnabled === 'function' ? options.isLogEnabled : null
  const userLog = typeof options.log === 'function' ? options.log : () => {}

  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== '' ? options.dataDir : null
  const bridgeFile = dataDir ? path.join(dataDir, 'bridge.json') : null
  const logFile = dataDir ? path.join(dataDir, 'bridge.log') : null

  /** 内存状态。持久化只在给了 dataDir 时发生（默认零文件副作用）。 */
  const persisted = readPersisted()
  const state = {
    /** disabled | stopped | starting | running | port-busy | failed */
    status: persisted.enabled ? 'stopped' : 'disabled',
    port: null,
    error: null,
    tokenHash: persisted.tokenHash,
    tokenLast4: persisted.tokenLast4,
    tls: null,
  }

  /** allowedOrigins：默认空。 */
  const allowedOrigins = new Set(persisted.allowedOrigins)

  let server = null
  const startPort = normalizePort(options.startPort) || readEnvPort() || DEFAULT_PORT
  /** `start({ port })` 指定的端口：优先于 startPort，使用后保留到下次显式指定。 */
  let startPortOverride = null
  let listeningPort = null
  const sockets = new Set()

  /** 限流与计数。默认值 = 契约 §5.2 数字；`options.limits` 仅供自测覆盖。 */
  const overrides = options.limits && typeof options.limits === 'object' ? options.limits : {}
  const limits = {
    importCapacity: readLimit(overrides.importCapacity, RATE_CAPACITY),
    importRefillPerMinute: readLimit(overrides.importRefillPerMinute, 60),
    authFailLimit: readLimit(overrides.authFailLimit, AUTH_FAIL_LIMIT),
    authFailWindowMs: readLimit(overrides.authFailWindowMs, AUTH_FAIL_WINDOW_MS),
  }
  const importBucket = newTokenBucket(limits.importCapacity, limits.importRefillPerMinute / 60000)
  const authFailWindow = newSlidingWindow(limits.authFailLimit, limits.authFailWindowMs)

  /**
   * ㊲（00 号 §6.15）**本会话保留的令牌明文**：`bridge.json` 仍然只存 sha256 + 后 4 位
   * （明文**绝不落盘**），但明文在本进程内存里留到「应用退出」或「用户重新生成」为止，
   * 于是面板可以在本次会话内反复复制同一串明文。
   *
   * 为什么值得留：令牌是长期有效的**唯一凭据**，而用户拿到它的唯一途径就是这串明文。
   * 只允许「显示一次」会把「长期有效」变成自相矛盾的承诺 —— 误关一次面板就只能重新生成，
   * 而每次重新生成都会让此前所有已配置的客户端失效。内存保留是「能用」与「不落盘」之间
   * 唯一站得住的折中。
   *
   * 绝不出现在 `status()` 的返回值里（只通过 `tokenVisible` 报「还在不在」），
   * 也绝不写进日志、错误体或 `bridge.json`。
   */
  let sessionPlaintext = null

  /** 唯一导入队列：全局 1 并发。 */
  let importQueueActive = 0
  const importQueueWaiters = []

  /** 最近一次被拒绝的来源（UI-04/R8 的拒绝记录行）。 */
  let lastRejectedOrigin = null

  // -------------------------------------------------------------------------
  // 持久化（dataDir 未提供时全部是内存操作）
  // -------------------------------------------------------------------------

  function readPersisted() {
    const empty = { tokenHash: null, tokenLast4: null, allowedOrigins: [], enabled: false }
    if (!bridgeFile) return empty
    try {
      const parsed = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return empty
      const hash = typeof parsed.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.tokenHash) ? parsed.tokenHash : null
      const last4 = typeof parsed.tokenLast4 === 'string' && /^[A-Za-z0-9_-]{4}$/.test(parsed.tokenLast4) ? parsed.tokenLast4 : null
      const origins = Array.isArray(parsed.allowedOrigins)
        ? parsed.allowedOrigins.filter((item) => typeof item === 'string' && item !== '' && item !== 'null')
        : []
      return { tokenHash: hash, tokenLast4: last4, allowedOrigins: [...new Set(origins)], enabled: parsed.enabled === true }
    } catch {
      /* 文件不存在或损坏：当作空状态，不阻塞启动 */
    }
    return empty
  }

  /** 原子写 bridge.json（tmp + rename）。绝不含令牌明文。 */
  function persist() {
    if (!bridgeFile) return
    try {
      fs.mkdirSync(path.dirname(bridgeFile), { recursive: true })
      const payload = {
        version: 1,
        tokenHash: state.tokenHash,
        tokenLast4: state.tokenLast4,
        allowedOrigins: [...allowedOrigins],
        enabled: state.status === 'running' || state.status === 'starting' || state.status === 'port-busy' || state.status === 'failed',
        updatedAt: new Date().toISOString(),
      }
      const tmp = `${bridgeFile}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
      fs.renameSync(tmp, bridgeFile)
    } catch (error) {
      writeLog('bridge.listen-error', { code: 'IMP-1002', detail: redact(String(error && error.message)) })
    }
  }

  /**
   * 写一行 JSONL 日志。字段白名单：令牌、配对码、正文、绝对路径一律不落。
   * `options.isLogEnabled()` 返回 false 时整条跳过（UI-04/R8 的开关，默认开）。
   */
  function writeLog(event, fields = {}) {
    if (isLogEnabled && !isLogEnabled()) return
    const name = LOG_EVENTS.has(event) ? event : 'bridge.listen-error'
    const line = { ts: new Date().toISOString(), event: name }
    if (fields.origin != null) line.origin = clampText(fields.origin, 200)
    if (fields.client != null) line.client = clampText(fields.client, 80)
    if (fields.importId != null) line.importId = clampText(fields.importId, 120)
    if (fields.path != null) line.path = clampText(fields.path, 300)
    if (fields.code != null) line.code = clampText(fields.code, 40)
    if (fields.ms != null) line.ms = Number(fields.ms) || 0
    if (fields.port != null) line.port = Number(fields.port) || 0
    if (fields.detail != null) line.detail = clampText(redact(String(fields.detail)), 200)
    const text = JSON.stringify(line)
    // 主进程副本：`log(event, fields)`（Lead 的挂钩形态）。只传事件名 + 白名单行，
    // 绝不把整个 fields 打进主进程控制台（那里不脱敏）。
    // 契约 §5.2 冻结形态是 `log(msg: string)`，多传一个参数对单参实现无害。
    try {
      userLog(name, line)
    } catch {
      /* 日志失败不得影响请求 */
    }
    if (!logFile) return
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true })
      fs.appendFileSync(logFile, `${text}\n`, 'utf8')
    } catch {
      /* 日志失败不得影响请求 */
    }
  }

  // -------------------------------------------------------------------------
  // HTTP 响应helper
  // -------------------------------------------------------------------------

  function corsHeaders(origin, preflight) {
    const headers = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': CORS_METHODS,
      'Access-Control-Allow-Headers': CORS_HEADERS,
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    }
    // 绝不返回 Access-Control-Allow-Credentials。
    if (preflight) headers['Access-Control-Allow-Private-Network'] = 'false'
    return headers
  }

  function sendJson(req, res, httpStatus, payload, extra = {}) {
    if (res.writableEnded || res.destroyed) return
    const body = JSON.stringify(payload)
    const headers = {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Length': Buffer.byteLength(body),
      ...extra,
    }
    if (res.__cors && !res.__noCors) Object.assign(headers, corsHeaders(res.__cors.origin, res.__cors.preflight))
    res.writeHead(httpStatus, headers)
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * 发错误响应。
   * 第 5 参数兼容两种形态：**数字** = 只覆盖 HTTP 状态（沿用的旧调用），
   * **对象** = `{ http?, userMessage? }`，其中 `userMessage` 用于只有本接口才知道的特定说明
   * （例如 `/v1/pair` 已下线）。两者都不改 `ERROR_TABLE` —— 那张表必须与 `02` 附录 A.3
   * 逐字一致（见 verify-contract 的 C-6c）。
   */
  function sendError(req, res, code, detail, overrides) {
    const spec = ERROR_TABLE[code] || ERROR_TABLE['IMP-5001']
    const object = overrides && typeof overrides === 'object' ? overrides : null
    const http = typeof overrides === 'number' ? overrides : object && object.http ? object.http : spec.http
    const payload = {
      ok: false,
      error: {
        code,
        message: spec.message,
        userMessage: object && object.userMessage ? object.userMessage : spec.userMessage,
        http,
        retryable: spec.retryable,
      },
    }
    if (detail !== undefined) payload.error.detail = sanitizeDetail(detail)
    sendJson(req, res, http, payload)
  }

  /** detail 不得含宿主机绝对路径 / 用户名 / 令牌。 */
  function sanitizeDetail(detail) {
    if (detail == null) return detail
    if (Array.isArray(detail)) return detail.map((item) => sanitizeDetail(item))
    if (typeof detail === 'object') {
      const out = {}
      for (const [key, value] of Object.entries(detail)) out[key] = sanitizeDetail(value)
      return out
    }
    if (typeof detail !== 'string') return detail
    return redact(detail)
      // 盘符/UNC/POSIX 家目录：用负向边界避免误伤 `chrome-extension://`、`http://`。
      .replace(/(^|[^A-Za-z0-9])([A-Za-z]:[\\/][^\s"']*)/g, '$1<path>')
      .replace(/\\\\[A-Za-z0-9._-]+\\[^\s"']*/g, '<path>')
      .replace(/\/(?:Users|home|root|var|etc|opt|mnt|media|private)\/[^\s"']*/g, '<path>')
      .replace(/opn_[A-Za-z0-9_-]+/g, 'opn_***')
  }

  function sendOk(req, res, status, result) {
    sendJson(req, res, status, { ok: true, result })
  }

  // -------------------------------------------------------------------------
  // 四道前置校验
  // -------------------------------------------------------------------------

  /** 第 1 道：Host 白名单（防 DNS rebinding）。 */
  function checkHost(req, res) {
    const port = listeningPort || startPort
    const allowed = new Set([
      `127.0.0.1:${port}`,
      '127.0.0.1',
      `localhost:${port}`,
      'localhost',
    ])
    const host = req.headers.host
    if (typeof host !== 'string' || host.trim() === '') {
      // 缺失 → 400（HTTP/1.1 缺 Host 时 Node 的解析层会先一步回 400，这里是兜底路径）。
      writeLog('host.reject', { code: 'IMP-1005', detail: 'missing' })
      sendError(req, res, 'IMP-1005', { header: 'Host' }, 400)
      return false
    }
    if (!allowed.has(host.trim().toLowerCase())) {
      writeLog('host.reject', { code: 'IMP-1005', detail: host })
      sendError(req, res, 'IMP-1005', { header: 'Host' })
      return false
    }
    return true
  }

  /**
   * 第 2 道：Origin，**按类型**判断（0.3.1 ㉞，不再查白名单）。
   *   无 Origin（curl/CLI/agent）→ 放行（非浏览器客户端不发这个头）
   *   扩展来源 / 本机回环 / `file://` → 放行
   *   `null`、空串、普通网页来源（任何非回环 http(s) 域名）→ 403 且不加 CORS 头
   * 通过时在 res.__cors 上记下来源，之后所有响应都会精确回显。
   */
  function checkOrigin(req, res) {
    const origin = req.headers.origin
    if (origin === undefined) return true
    const value = String(origin)
    if (value === '' || value === 'null' || !isAcceptedOrigin(value)) {
      lastRejectedOrigin = value || 'null'
      writeLog('origin.reject', { code: 'IMP-3001', origin: value || 'null' })
      sendError(req, res, 'IMP-3001', { origin: value || 'null', accepted: 'extension | loopback | file' })
      return false
    }
    res.__cors = { origin: value, preflight: req.method === 'OPTIONS' }
    return true
  }

  /** 当前生效的扫描起点：本次覆盖 > 配置的起始端口 > 默认 8787。 */
  function effectiveStartPort() {
    return normalizePort(startPortOverride) || startPort
  }

  /** 令牌哈希来源：优先主进程持久状态，回调没给有效值时退回桥自己的内存状态。 */
  function resolveExpectedHash() {
    if (getTokenHash) {
      const provided = getTokenHash()
      if (typeof provided === 'string' && provided !== '') return provided
    }
    return state.tokenHash
  }

  /** 第 3 道：Content-Type（POST 才校验；GET/OPTIONS 不校验）。 */
  function checkContentType(req, res) {
    if (req.method !== 'POST') return true
    if (!isJsonContentType(req.headers['content-type'])) {
      writeLog('import.error', { code: 'IMP-3004', detail: String(req.headers['content-type'] || 'missing') })
      sendError(req, res, 'IMP-3004', { contentType: String(req.headers['content-type'] || '') })
      return false
    }
    return true
  }

  /** 第 4 道：令牌。定时比较 sha256；失败 10 次/分钟 → 429 IMP-2003。 */
  function checkToken(req, res) {
    const header = req.headers.authorization
    let raw = ''
    if (typeof header === 'string' && header.trim() !== '') {
      const match = /^Bearer\s+(.+)$/i.exec(header.trim())
      raw = (match ? match[1] : header).trim()
    } else if (typeof req.headers['x-opennote-token'] === 'string') {
      raw = req.headers['x-opennote-token'].trim()
    }

    if (raw === '') {
      if (recordHit(authFailWindow)) {
        writeLog('ratelimit', { code: 'IMP-2003', detail: 'auth' })
        sendJson(req, res, ERROR_TABLE['IMP-2003'].http, errorBody('IMP-2003'), { 'Retry-After': String(windowRetryAfter(authFailWindow)) })
        return false
      }
      writeLog('auth.fail', { code: 'IMP-2001' })
      sendError(req, res, 'IMP-2001', { header: 'Authorization' })
      return false
    }

    const expected = resolveExpectedHash()
    const malformed = !TOKEN_PATTERN.test(raw) || raw.length !== TOKEN_LENGTH
    const matched = !malformed && typeof expected === 'string' && timingSafeEqualText(sha256Hex(raw), expected)

    if (malformed || !matched) {
      if (recordHit(authFailWindow)) {
        writeLog('ratelimit', { code: 'IMP-2003', detail: 'auth' })
        sendJson(req, res, ERROR_TABLE['IMP-2003'].http, errorBody('IMP-2003'), { 'Retry-After': String(windowRetryAfter(authFailWindow)) })
        return false
      }
      writeLog('auth.fail', { code: 'IMP-2002' })
      sendError(req, res, 'IMP-2002', { header: 'Authorization' })
      return false
    }
    return true
  }

  function errorBody(code, detail) {
    const spec = ERROR_TABLE[code] || ERROR_TABLE['IMP-5001']
    const error = { code, message: spec.message, userMessage: spec.userMessage, http: spec.http, retryable: spec.retryable }
    if (detail !== undefined) error.detail = sanitizeDetail(detail)
    return { ok: false, error }
  }

  // -------------------------------------------------------------------------
  // 请求体
  // -------------------------------------------------------------------------

  /**
   * 超限后就地掐断连接：响应先冲刷完，再半关写侧（半关而不是立刻 destroy，
   * 否则客户端可能只看到连接重置而读不到 413 响应体）。
   */
  function cutConnection(req, res) {
    const socket = req.socket
    if (!socket) return
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      try {
        if (!socket.destroyed) socket.end()
      } catch {
        /* 已断开 */
      }
    }
    if (res.writableFinished) close()
    else res.once('finish', close)
    // 客户端一直不停写就强制回收，避免连接被长期占用。
    const timer = setTimeout(() => {
      try {
        if (!socket.destroyed) socket.destroy()
      } catch {
        /* 已断开 */
      }
    }, 2000)
    if (typeof timer.unref === 'function') timer.unref()
  }

  /**
   * 读取请求体：
   *   - Content-Length 存在且 > 16 MiB → 413 IMP-4005 + Connection: close，**不读 body**。
   *   - 缺失（chunked）→ 边读边计数，超限立即掐断连接。
   */
  function readBody(req, res) {
    return new Promise((resolve) => {
      const declared = Number(req.headers['content-length'])
      if (Number.isFinite(declared) && declared > MAX_REQUEST_BYTES) {
        res.setHeader('Connection', 'close')
        sendError(req, res, 'IMP-4005', { limit: MAX_REQUEST_BYTES, received: declared })
        // 不消费 body（避免内存放大）；Node 会在响应结束后丢弃剩余数据并关闭连接。
        cutConnection(req, res)
        resolve({ tooLarge: true })
        return
      }

      let total = 0
      const chunks = []
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      req.on('data', (chunk) => {
        if (settled) return
        total += chunk.length
        if (total > MAX_REQUEST_BYTES) {
          chunks.length = 0
          res.setHeader('Connection', 'close')
          sendError(req, res, 'IMP-4005', { limit: MAX_REQUEST_BYTES, received: total })
          cutConnection(req, res)
          finish({ tooLarge: true })
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => finish({ buffer: Buffer.concat(chunks) }))
      req.on('error', () => finish({ buffer: Buffer.concat(chunks) }))
      req.on('aborted', () => finish({ aborted: true }))
    })
  }

  // -------------------------------------------------------------------------
  // 导入队列（全局 1 并发）
  // -------------------------------------------------------------------------

  function acquireImportSlot() {
    return new Promise((resolve) => {
      if (importQueueActive === 0) {
        importQueueActive = 1
        resolve(true)
        return
      }
      let done = false
      const timer = setTimeout(() => {
        if (done) return
        done = true
        const index = importQueueWaiters.indexOf(waiter)
        if (index >= 0) importQueueWaiters.splice(index, 1)
        resolve(false)
      }, IMPORT_QUEUE_LIMIT_MS)
      const waiter = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        resolve(true)
      }
      importQueueWaiters.push(waiter)
    })
  }

  function releaseImportSlot() {
    const next = importQueueWaiters.shift()
    if (next) next()
    else importQueueActive = 0
  }

  // -------------------------------------------------------------------------
  // 路由
  // -------------------------------------------------------------------------

  async function handleRequest(req, res) {
    const startedAt = Date.now()
    const url = new URL(req.url || '/', 'http://127.0.0.1')
    const route = url.pathname

    // 桥未开启时不开一个「只会说我没开」的端口（契约 §5.2.6）：健康探测也一律拒绝。
    if (state.status !== 'running') {
      sendError(req, res, 'IMP-5002', { state: state.status })
      return
    }

    // OPTIONS 预检：只走 Host + Origin，不校验令牌（预检不携带 Authorization）。
    if (req.method === 'OPTIONS') {
      if (!checkHost(req, res)) return
      if (!checkOrigin(req, res)) return
      if (!route.startsWith('/v1/')) {
        sendError(req, res, 'IMP-3005', { path: route })
        return
      }
      res.writeHead(204, { 'Cache-Control': 'no-store', 'Content-Length': 0, ...(res.__cors ? corsHeaders(res.__cors.origin, true) : {}) })
      res.end()
      return
    }

    const method = req.method === 'HEAD' ? 'GET' : req.method

    // OPTIONS 预检：只走 Host + Origin，不校验令牌（预检不携带 Authorization）。
    if (req.method === 'OPTIONS') {
      if (!checkHost(req, res)) return
      if (!checkOrigin(req, res)) return
      if (!route.startsWith('/v1/')) {
        sendError(req, res, 'IMP-3005', { path: route })
        return
      }
      res.writeHead(204, { 'Cache-Control': 'no-store', 'Content-Length': 0, ...(res.__cors ? corsHeaders(res.__cors.origin, true) : {}) })
      res.end()
      return
    }

    if (!checkHost(req, res)) return
    if (!checkOrigin(req, res)) return

    // GET /v1/health —— 唯一不需要令牌的接口，且不加任何 CORS 头。
    if (route === '/v1/health' && method === 'GET') {
      res.__noCors = true
      sendOk(req, res, 200, healthResult())
      return
    }

    /*
     * POST /v1/pair 已于 0.3.1（00 号 §6.15㉞）整体下线。
     * 这里**明确**告诉客户端「配对已删除、改用什么」，而不是让它撞上通用 404 ——
     * 老版本扩展/CLI 的唯一补救方式就是这条说明。走四道前置校验（Host/Origin 已过），
     * 回复不带任何凭据，也不写 allowedOrigins。
     */
    if (route === '/v1/pair') {
      writeLog('import.error', { code: 'IMP-3005', detail: 'pair-retired' })
      sendError(req, res, 'IMP-3005', {
        route: '/v1/pair',
        removedIn: '0.3.1',
        replacement: 'url + long-lived token',
      }, {
        userMessage:
          '配对功能已经在 0.3.1 删除。请改用「URL + 长期令牌」：在 Opennote 的「设置 · 文件 · 导入与接口」里复制令牌，粘贴到客户端。',
      })
      return
    }

    if (!checkContentType(req, res)) return

    // 需要令牌的接口（0.3.1 起没有例外：所有写接口都要令牌）。
    if (!checkToken(req, res)) return

    if (route === '/v1/import' && method === 'POST') {
      await handleImport(req, res, startedAt)
      return
    }
    if (route === '/v1/imports' && method === 'GET') {
      await handleRecentImports(req, res, url)
      return
    }
    const single = /^\/v1\/imports\/([^/]+)$/.exec(route)
    if (single && method === 'GET') {
      await handleImportRecord(req, res, single[1])
      return
    }
    if (route === '/v1/workspace' && method === 'GET') {
      sendOk(req, res, 200, workspaceResult())
      return
    }
    if (route === '/v1/tags' && method === 'GET') {
      const tags = typeof options.getTags === 'function' ? options.getTags() : null
      if (tags == null) {
        sendError(req, res, 'IMP-3005', { path: route })
        return
      }
      sendOk(req, res, 200, { tags: Array.isArray(tags) ? tags : [] })
      return
    }

    sendError(req, res, 'IMP-3005', { method: req.method, path: route })
  }

  function healthResult() {
    const workspace = workspaceResult()
    return {
      bridge: 'running',
      spec: SPEC_VERSION,
      app: typeof options.getAppVersion === 'function' ? String(options.getAppVersion() || APP_VERSION) : APP_VERSION,
      port: listeningPort,
      workspace: { open: workspace.open === true, name: workspace.name ?? null },
      inbox: typeof options.getInboxEnabled === 'function' ? Boolean(options.getInboxEnabled()) : false,
      inboxMode: inboxModeValue(),
      authRequired: true,
      time: new Date().toISOString(),
    }
  }

  /**
   * 交付模式（只读，㉕）：交给客户端**判断这次导入会不会先进收件箱**。
   * 缺省（没传挂钩 / 挂钩抛错 / 返回值不认识）一律 `null`——桥不知道就说不知道，
   * 绝不用 `"direct"` 假装默认，那会让客户端对用户承诺错误的落点。
   */
  function inboxModeValue() {
    let raw = null
    try {
      raw = typeof options.getInboxMode === 'function' ? options.getInboxMode() : null
    } catch {
      return null
    }
    if (raw === true) return 'inbox'
    if (raw === false) return 'direct'
    if (raw === 'inbox' || raw === 'direct') return raw
    return null
  }

  /** 只返回笔记本名与是否打开：绝不返回绝对路径、用户名、笔记标题、目录树。 */
  function workspaceResult() {
    const info = typeof options.getWorkspaceInfo === 'function' ? options.getWorkspaceInfo() : null
    const open = Boolean(info && info.open)
    return {
      open,
      name: open && typeof info.name === 'string' ? info.name : null,
      defaultFolder: typeof options.getDefaultFolder === 'function' ? options.getDefaultFolder() : null,
      inboxEnabled: typeof options.getInboxEnabled === 'function' ? Boolean(options.getInboxEnabled()) : false,
      inboxMode: inboxModeValue(),
    }
  }

  async function handleRecentImports(req, res, url) {
    const getRecent = typeof options.getRecentImports === 'function' ? options.getRecentImports : null
    if (!getRecent) {
      sendError(req, res, 'IMP-3005', { path: url.pathname })
      return
    }
    const limitRaw = Number(url.searchParams.get('limit'))
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 200) : 20
    const list = await getRecent(limit)
    sendOk(req, res, 200, { imports: Array.isArray(list) ? list : [] })
  }

  async function handleImportRecord(req, res, importId) {
    const lookup = typeof options.getImportRecord === 'function' ? options.getImportRecord : null
    if (lookup) {
      const record = await lookup(decodeURIComponent(importId))
      if (record && typeof record === 'object') {
        sendOk(req, res, 200, record)
        return
      }
    }
    sendError(req, res, 'IMP-4017', { importId: decodeURIComponent(importId) })
  }

  // -------------------------------------------------------------------------
  // POST /v1/import
  // -------------------------------------------------------------------------

  async function handleImport(req, res, startedAt) {
    const wait = takeToken(importBucket)
    if (wait > 0) {
      writeLog('ratelimit', { code: 'IMP-4015', detail: 'import' })
      sendJson(req, res, ERROR_TABLE['IMP-4015'].http, errorBody('IMP-4015'), { 'Retry-After': String(wait) })
      return
    }

    const body = await readBody(req, res)
    if (body.tooLarge) {
      writeLog('import.error', { code: 'IMP-4005' })
      return
    }
    if (body.aborted) return
    const text = body.buffer ? body.buffer.toString('utf8') : ''
    if (text.trim() === '') {
      writeLog('import.error', { code: 'IMP-3003' })
      sendError(req, res, 'IMP-3003')
      return
    }

    let envelope = null
    try {
      envelope = JSON.parse(text)
    } catch {
      writeLog('import.error', { code: 'IMP-3002' })
      sendError(req, res, 'IMP-3002')
      return
    }
    if (envelope === null || typeof envelope !== 'object' || Array.isArray(envelope)) {
      writeLog('import.error', { code: 'IMP-4001' })
      sendError(req, res, 'IMP-4001')
      return
    }

    const client = envelope.client && typeof envelope.client === 'object' ? envelope.client : {}
    const clientName = typeof client.name === 'string' ? client.name.slice(0, 80) : 'unknown'
    const clientVersion = typeof client.version === 'string' ? client.version.slice(0, 40) : ''
    const importId = typeof envelope.importId === 'string' ? envelope.importId : ''

    // overwrite 的桥侧降级：四条件任一不满足就改成 new 并在响应里带警告。
    const warnings = []
    if (envelope.conflict === 'overwrite') {
      const advanced = typeof getAdvancedOverwrite === 'function' ? Boolean(getAdvancedOverwrite()) : false
      if (!advanced) {
        envelope.conflict = 'new'
        envelope.__bridgeOverwriteDowngraded = true
        warnings.push('IMP-4011')
      }
    }

    if (typeof envelope.target === 'object' && envelope.target && typeof envelope.target.folder === 'string') {
      const reject = rejectAbsoluteFolder(envelope.target.folder)
      if (reject) {
        writeLog('import.error', { code: 'IMP-4008', importId })
        sendError(req, res, 'IMP-4008', { field: 'target.folder' })
        return
      }
    }

    if (!onEnvelope || (hasGetWindow && !getWindow())) {
      // 窗口不在场：桥的生命周期跟随窗口，绝不假成功（契约 IMP-4006，可重试）。
      writeLog('import.error', { code: 'IMP-4006', importId, client: clientName })
      sendError(req, res, 'IMP-4006')
      return
    }

    const acquired = await acquireImportSlot()
    if (!acquired) {
      writeLog('ratelimit', { code: 'IMP-4020', importId })
      sendError(req, res, 'IMP-4020', { importId })
      return
    }

    let receipt
    try {
      receipt = await withTimeout(
        onEnvelope(JSON.stringify(envelope), { clientName, clientVersion }),
        REQUEST_TIMEOUT_MS,
      )
    } catch (error) {
      const timedOut = error && error.__timeout === true
      const code = timedOut ? 'IMP-1004' : 'IMP-5001'
      writeLog('import.error', { code, importId, client: clientName, ms: Date.now() - startedAt })
      sendError(req, res, code, { importId })
      return
    } finally {
      releaseImportSlot()
    }

    respondWithReceipt(req, res, receipt, { importId, clientName, warnings, startedAt })
  }

  /** 桥不接受来自信封的绝对路径（§11 硬红线）。 */
  function rejectAbsoluteFolder(folder) {
    if (folder === '') return false
    if (/^[A-Za-z]:/.test(folder)) return true
    if (folder.startsWith('/') || folder.startsWith('\\')) return true
    if (folder.includes('\0')) return true
    return false
  }

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new Error('bridge timeout')
        error.__timeout = true
        reject(error)
      }, ms)
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer)
          resolve(value)
        },
        (error) => {
          clearTimeout(timer)
          reject(error)
        },
      )
    })
  }

  /**
   * 渲染层回执 → HTTP 响应。
   * 兼容三种回执形态：
   *   1) 错误：`{ ok:false, error:{ code } }` 或 `{ code:'IMP-xxxx' }`
   *   2) 完整：`{ ok:true, status:200, result:{…} }`
   *   3) 结果：`{ status:'created', path, … }`
   */
  function respondWithReceipt(req, res, receipt, context) {
    const { importId, clientName, warnings, startedAt } = context
    let value = receipt
    if (typeof value === 'string') {
      try {
        value = JSON.parse(value)
      } catch {
        value = null
      }
    }

    if (value == null) {
      writeLog('import.error', { code: 'IMP-5001', importId, client: clientName, ms: Date.now() - startedAt })
      sendError(req, res, 'IMP-5001', { importId })
      return
    }

    const errorCode =
      (value.ok === false && value.error && typeof value.error.code === 'string' && value.error.code) ||
      (typeof value.code === 'string' && /^IMP-\d{4}$/.test(value.code) && value.code) ||
      null

    if (errorCode) {
      const spec = ERROR_TABLE[errorCode] || ERROR_TABLE['IMP-5001']
      const error = {
        code: errorCode,
        message: (value.error && value.error.message) || spec.message,
        userMessage: (value.error && value.error.userMessage) || spec.userMessage,
        http: spec.http,
        retryable: value.error && typeof value.error.retryable === 'boolean' ? value.error.retryable : spec.retryable,
      }
      if (value.error && value.error.detail !== undefined) error.detail = sanitizeDetail(value.error.detail)
      writeLog('import.error', { code: errorCode, importId, client: clientName, ms: Date.now() - startedAt })
      sendJson(req, res, spec.http, { ok: false, error })
      return
    }

    const result = value.result && typeof value.result === 'object' ? value.result : value
    if (Array.isArray(result.warnings)) {
      for (const item of warnings) if (!result.warnings.includes(item)) result.warnings.push(item)
    } else if (warnings.length) {
      result.warnings = [...warnings]
    }

    const status = typeof value.status === 'number' ? value.status : result.status === 'deduped' || result.status === 'skipped' ? 200 : 201
    const event = result.status === 'deduped' || result.deduped === true ? 'import.deduped' : 'import.ok'
    writeLog(event, {
      importId: result.importId || importId,
      client: clientName,
      path: typeof result.path === 'string' ? result.path : undefined,
      ms: Date.now() - startedAt,
    })
    sendOk(req, res, status, result)
  }

  /*
   * 0.3.1（㉞）：POST /v1/pair 与配套的配对码状态机（120 s / 一次性 / 5 次作废 /
   * 「配对成功即轮换令牌」）已整体删除，客户端改用「URL + 长期令牌」。
   * 路由层的「已下线」响应见 handleRequest；这里不再保留任何配对实现。
   */
  // -------------------------------------------------------------------------
  // 生命周期
  // -------------------------------------------------------------------------

  function tryListen(port) {
    return new Promise((resolve) => {
      const candidate = http.createServer()
      let settled = false
      const done = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      candidate.on('request', (req, res) => {
        res.__cors = null
        handleRequest(req, res).catch((error) => {
          userLog('bridge.listen-error', { code: 'IMP-5001', detail: redact(String(error && error.message)) })
          try {
            sendError(req, res, 'IMP-5001')
          } catch {
            /* 响应可能已经开始 */
          }
        })
      })
      candidate.on('connection', (socket) => {
        sockets.add(socket)
        socket.on('close', () => sockets.delete(socket))
      })
      candidate.on('clientError', (_error, socket) => {
        if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
      })
      candidate.once('error', (error) => {
        try {
          candidate.close()
        } catch {
          /* 未监听时 close 会回调错误，忽略 */
        }
        done({ ok: false, code: error && error.code ? error.code : 'EUNKNOWN' })
      })
      candidate.once('listening', () => done({ ok: true, server: candidate }))

      try {
        // 硬红线：必须显式绑 127.0.0.1，绝不 listen(port)。
        candidate.listen(port, '127.0.0.1')
      } catch (error) {
        done({ ok: false, code: error && error.code ? error.code : 'EUNKNOWN' })
      }
    })
  }

  async function start() {
    if (state.status === 'running' && server) {
      return { port: listeningPort }
    }
    if (!state.tokenHash) {
      // 未设置令牌时桥不允许开启（否则等于开了一个无鉴权的写入端口）。
      state.status = state.status === 'stopped' ? 'stopped' : 'disabled'
      state.error = '未设置访问令牌，无法开启本地接口。请先生成令牌。'
      writeLog('bridge.listen-error', { code: 'IMP-1002', detail: 'no-token' })
      return { port: null, error: state.error, code: 'IMP-1002' }
    }

    state.status = 'starting'
    state.error = null

    const requested = normalizePort(startPortOverride)
    const first = effectiveStartPort()
    // 「起始端口」= 扫描起点；从它开始顺序尝试 10 个连续端口（默认 8787–8796）。
    const candidates = []
    const last = Math.min(first + PORT_COUNT - 1, CUSTOM_PORT_MAX)
    for (let port = first; port <= last; port += 1) candidates.push(port)

    let lastCode = null
    for (const port of candidates) {
      const result = await tryListen(port)
      if (result.ok) {
        server = result.server
        listeningPort = port
        state.port = port
        state.status = 'running'
        persist()
        writeLog('bridge.start', { port })
        return { port }
      }
      lastCode = result.code
      if (result.code !== 'EADDRINUSE') break
    }

    state.status = lastCode === 'EADDRINUSE' ? 'port-busy' : 'failed'
    state.error =
      lastCode === 'EADDRINUSE'
        ? `${candidates[0]} 到 ${candidates[candidates.length - 1]} 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。`
        : `本地接口启动失败（${lastCode || '未知错误'}）。`
    state.port = null
    listeningPort = null
    persist()
    writeLog('bridge.listen-error', { code: lastCode === 'EADDRINUSE' ? 'IMP-1003' : 'IMP-1002', detail: lastCode || 'unknown' })
    return { port: null, error: state.error, code: lastCode === 'EADDRINUSE' ? 'IMP-1003' : 'IMP-1002' }
  }

  /** 关闭 = server.close() + 立刻断开全部 keep-alive 连接。 */
  async function stop() {
    const active = server
    server = null
    listeningPort = null
    state.port = null

    if (active) {
      await new Promise((resolve) => {
        try {
          active.close(() => resolve())
        } catch {
          resolve()
        }
        for (const socket of sockets) {
          try {
            socket.destroy()
          } catch {
            /* 已断开 */
          }
        }
        sockets.clear()
        setTimeout(resolve, 500)
      })
      writeLog('bridge.stop', {})
    }

    state.status = 'stopped'
    state.error = null
    persist()
  }

  // -------------------------------------------------------------------------
  // 令牌
  // -------------------------------------------------------------------------

  /**
   * 生成/轮换令牌：立刻作废旧令牌，返回新明文，并把它**留在本会话内存里**（㊲）。
   * 服务端只持久化 sha256 + last4 —— 明文进不了 `bridge.json`。
   *
   * `status().tokenVisible` 因此为 `true`：面板可以在本次会话内反复复制同一串明文，
   * 直到应用退出或用户再点一次「重新生成」。
   */
  function regenerateToken() {
    const token = generateToken()
    state.tokenHash = sha256Hex(token)
    state.tokenLast4 = token.slice(-4)
    sessionPlaintext = token
    persist()
    return token
  }

  /**
   * ㊲③ **只读**取回本会话的令牌明文：仍持有就返回它，否则返回 `null`。
   *
   * **调用它绝不轮换令牌、绝不写盘、绝不改任何状态** —— 这是它与 `newToken()` 的本质区别：
   * `newToken()` = 「重新生成」（旧令牌立刻作废），这里只是把内存里那串**已经有效**的明文
   * 再交出来一次。IPC 层（`opennote:bridge:token`）用它解决「整窗重载后界面拿不到明文，
   * 于是「复制令牌」变成点不动的按钮」—— 那正是本项目一路在打的假开关 / 死按钮缺陷。
   *
   * 返回 `null` 只代表「本会话不再持有明文」（应用重启过 / 被 `setTokenHash` 丢弃），
   * **不代表令牌失效**：令牌仍然长期有效，只是要重新生成一次才能再看到明文。
   */
  function getSessionPlaintext() {
    return typeof sessionPlaintext === 'string' && sessionPlaintext !== '' ? sessionPlaintext : null
  }

  function setTokenHash(hash, last4) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false
    state.tokenHash = hash
    state.tokenLast4 = typeof last4 === 'string' ? last4.slice(-4) : null
    // 外部改写了哈希 → 内存里那串明文已经不对应了，必须丢掉（否则面板会复制一串已失效的令牌）。
    sessionPlaintext = null
    persist()
    return true
  }

  // -------------------------------------------------------------------------
  // 收件箱状态（唯一允许主进程写的内容）
  // -------------------------------------------------------------------------

  /**
   * 原子写 .opennote/inbox/<entryId>/state.json。
   * root 必须由调用方（主进程自己的当前工作区）给出，绝不来自请求体。
   */
  async function writeInboxState(root, entryId, stateJson) {
    if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('收件箱状态写入需要绝对工作区路径')
    if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) throw new Error('条目 id 不合法')
    if (typeof stateJson !== 'string') throw new Error('收件箱状态必须是字符串')
    const dir = path.join(root, '.opennote', 'inbox', entryId)
    const target = path.join(dir, 'state.json')
    if (onInboxStateWrite) {
      await onInboxStateWrite(entryId, stateJson)
      return { ok: true, delegated: true }
    }
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${target}.tmp`
    fs.writeFileSync(tmp, stateJson, 'utf8')
    fs.renameSync(tmp, target)
    return { ok: true, delegated: false }
  }

  // -------------------------------------------------------------------------
  // status
  // -------------------------------------------------------------------------

  /**
   * 6 枚举状态（契约 §5.2.2 逐字）：
   *   disabled 未开启 / stopped 已停止 / starting 正在启动 / running 运行中 /
   *   port-busy 端口被占用 / failed 启动失败
   * `stopped` 与 `disabled` 的区别是「本次会话里用户关过」；用户把开关设回关闭后
   * 报告 disabled。纯计算，不产生副作用。
   */
  function effectiveStatus() {
    if (state.status === 'stopped' && isEnabled && !isEnabled()) return 'disabled'
    return state.status
  }

  function status() {
    const current = effectiveStatus()
    const running = current === 'running' && server != null
    return {
      enabled: running,
      state: current,
      stateLabel: STATE_NAMES[current],
      port: running ? listeningPort : null,
      address: running ? `http://127.0.0.1:${listeningPort}` : null,
      endpoint: running ? `http://127.0.0.1:${listeningPort}` : null,
      addressText: running ? `http://127.0.0.1:${listeningPort}` : '—',
      running,
      tokenLast4: state.tokenLast4,
      tokenSet: Boolean(state.tokenHash),
      /**
       * 令牌是否已落到 userData/bridge.json。没有 dataDir 时纯内存，
       * 重启会丢令牌 —— UI 必须如实告知，不能让人以为长期有效。
       */
      tokenPersisted: Boolean(state.tokenHash && bridgeFile),
      /**
       * ㊲：本会话是否仍持有令牌明文（= 面板能不能反复复制）。
       * `false` 只代表「明文不在内存里了」（应用重启过 / 刚 `setTokenHash` 读回旧哈希），
       * **不代表令牌失效** —— 令牌仍然长期有效，只是要重新生成一次才能再看到明文。
       * 面板必须据此**如实降级**成一句说明，而不是留一个点了没反应的按钮。
       */
      tokenVisible: typeof sessionPlaintext === 'string' && sessionPlaintext !== '',
      origins: [...allowedOrigins],
      allowedOrigins: [...allowedOrigins],
      lastRejectedOrigin,
      logPath: logFile,
      inboxWatch: typeof options.getInboxWatchMode === 'function' ? options.getInboxWatchMode() : false,
      startPort,
      /** 当前生效的起始端口段（元组 `[起, 止]`，与 `src/desktop/bridge.ts` 逐字一致）。 */
      portRange: [effectiveStartPort(), Math.min(effectiveStartPort() + PORT_COUNT - 1, CUSTOM_PORT_MAX)],
      error: state.error,
      spec: SPEC_VERSION,
    }
  }

  // -------------------------------------------------------------------------
  // 对外 API
  // -------------------------------------------------------------------------

  return {
    /** 冻结接口。 */
    start,
    stop,
    status,
    regenerateToken,
    /** ㊲③ 只读取回本会话明文（IPC `opennote:bridge:token` 用；绝不轮换、绝不写盘）。 */
    getSessionPlaintext,
    /** 与 start/stop 同源的别名，供 IPC 层直接调用。 */
    startWithPort(port) {
      if (port == null) return start()
      const normalized = normalizePort(port)
      if (normalized == null) {
        return Promise.resolve({ port: null, error: '端口要在 1024 到 65535 之间。', code: 'IMP-1002' })
      }
      startPortOverride = normalized
      return start()
    },
    /** 生成新令牌（= regenerateToken，语义别名）。 */
    generateToken: regenerateToken,
    /**
     * 允许来源管理（0.3.1 起**不再用于放行判定**：来源按类型判断，见 `checkOrigin`）。
     * 保留读写接口只为清理 0.3.1 之前写进 `bridge.json` 的历史遗留条目。
     */
    addAllowedOrigin(origin) {
      if (typeof origin !== 'string' || origin === '' || origin === 'null') return false
      allowedOrigins.add(origin)
      persist()
      return true
    },
    removeAllowedOrigin(origin) {
      const removed = allowedOrigins.delete(origin)
      persist()
      return removed
    },
    /** 收件箱状态（唯一允许主进程写的文件形态）。 */
    writeInboxState,
    /** 诊断。 */
    getLogPath() {
      return logFile
    },
    getAuthFailures() {
      return authFailWindow.hits.length
    },
    setTokenHash,
    isRunning() {
      return state.status === 'running' && server != null
    },
    /**
     * 真实监听地址（诊断/自测用）：`{ address, family, port }`。
     * address 必须是 '127.0.0.1' —— 这是「只绑回环」的自证，不是配置声称。
     */
    getBoundAddress() {
      if (!server) return null
      try {
        const info = server.address()
        if (!info || typeof info !== 'object') return null
        return { address: info.address, family: info.family, port: info.port }
      } catch {
        return null
      }
    },
    /** 真实监听的连接数（诊断用）。 */
    getConnectionCount() {
      return sockets.size
    },
    getListeningPort() {
      return listeningPort
    },
    readInboxState(root, entryId) {
      if (typeof root !== 'string' || !path.isAbsolute(root)) return null
      if (typeof entryId !== 'string' || !ENTRY_ID_PATTERN.test(entryId)) return null
      try {
        return fs.readFileSync(path.join(root, '.opennote', 'inbox', entryId, 'state.json'), 'utf8')
      } catch {
        return null
      }
    },
  }
}

function readEnvPort() {
  const value = normalizePort(process.env.OPENNOTE_BRIDGE_PORT)
  return value || null
}

module.exports = {
  createBridge,
  // 供 smoke 脚本与主进程复用的常量/工具
  DEFAULT_PORT,
  PORT_RANGE_START,
  PORT_RANGE_END,
  TOKEN_LENGTH,
  SPEC_VERSION,
  TOKEN_PATTERN,
  ERROR_TABLE,
  STATE_NAMES,
  generateToken,
  sha256Hex,
}
