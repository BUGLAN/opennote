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
 *   - 令牌明文与 sha256 / last4 并列存在 userData/bridge.json 里（0.3.1 ㊴，用户知情选择
 *     「可随时复制」）；明文**绝不进日志、绝不进错误体、绝不进 status() 返回值**，也绝不
 *     写进工作区。
 *   - **令牌是唯一凭据且长期有效**：任何能读到 bridge.json、扩展 storage 或剪贴板的程序
 *     都能拿到明文并获得**导入**能力（不等于读笔记能力）。这条代价已如实写进设置面板
 *     的说明句（逐字 = ImportApiPanel.tsx 的 TOKEN_COST_HINT，由 bridge-smoke 咬住）。
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
 *     // 网页版剪藏页（0.3.2）：**必须**装配，否则 /v1/clip/folders 与
 *     // /v1/clip/commit 的落点校验一律明确失败（503 / 422），绝不假装「工作区里没有目录」。
 *     //   getFolders: () => string[] | null | Promise<string[] | null>
 *     //     同步或异步均可；**已存在**的工作区相对目录（POSIX 风格、不含 ""）；
 *     //     `[]` = 工作区里没有目录（合法）；`null` / 抛错 / 不是数组 = 拿不到（失败）。
 *     //     桥负责补 `""`（收件箱，恒为第 0 项）、去重与排序。
 *     //   clip: { distRoot?, ttlMs?, maxStages? } —— **只给自测用的覆盖**（形态同 `limits`）：
 *     //     把静态页指向临时夹具、把 TTL 调短。产品路径不传，用模块常量。
 *   }) -> BridgeController
 *
 * 网页版剪藏页（0.3.2，契约 §5.9）。三条红线决定了这个面长什么样：
 *   1. **页面永不持有长期令牌**：页面是 `chrome.tabs.create()` 打开的普通网页，
 *      所以它只拿 `stageId + k`（一次剪藏一份、15 分钟过期），三个页面端点都不用 Bearer。
 *   2. **一个事实一个产地**：`stageId` 只由本文件生成（绝不用扩展的 importId），
 *      `openUrl` 只由本文件拼（端口是 8787–8796 里选出来的，客户端不许自己拼）。
 *   3. **不另造写路径**：`POST /v1/clip/commit` 复用 `/v1/import` 的入库通路
 *      （`runEnvelopePipeline`：信封 → onEnvelope 转交渲染层 → respondWithReceipt）。
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

// 剪藏暂存区（stageId / k 生成、TTL、单次提交记录）。拆出去只为一件事：
// 「一个事实一个产地」—— stageId 与 k 的生成、过期判定、已提交指纹只在一个文件里。
const { createClipStageStore, CLIP_STAGE_TTL_MS } = require('./clip-stage.cjs')

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

// ---------------------------------------------------------------------------
// 网页版剪藏页（0.3.2）常量
// ---------------------------------------------------------------------------

/** 剪藏暂存的 spec（**与导入信封的 spec 不是同一个值**，混用就是两个产地打架）。 */
const CLIP_SPEC = 'opennote.clip/v1'
/** 剪藏页客户端的名字；L2 不认识的值按 02 §2.2 归一到 `other`（不报错）。 */
const CLIP_CLIENT_NAME = 'opennote.clip-web'
/**
 * 剪藏页构建产物根目录 = `pnpm build:clip` 的 outDir 根部。
 *
 * 这里只按约定推导（`dist-clip/clip/index.html` 与 `dist-clip/clip/assets/**`）；
 * 自测要指到临时夹具时用 `clip.distRoot`，**产品路径不读环境变量**——
 * 否则「产物在哪」就有了第二个产地。
 */
const CLIP_DIST_RELATIVE = 'dist-clip'
const CLIP_DIST_ROOT = path.join(__dirname, '..', CLIP_DIST_RELATIVE)
const CLIP_INDEX_RELATIVE = 'clip/index.html'
const CLIP_ASSETS_RELATIVE = 'clip/assets'
/** 注入的引导数据块 id：页面用 `JSON.parse(document.getElementById('clip-boot').textContent)` 读。 */
const CLIP_BOOT_ID = 'clip-boot'
/**
 * 剪藏页 CSP（逐字冻结）。`script-src 'self'` **不带** unsafe-inline ——
 * 所以引导数据走 `<script type="application/json">` 数据块（浏览器不执行它），
 * 而不是可执行内联脚本。`connect-src 'self'` 让页面能读 `/v1/clip/*`（同源）。
 */
const CLIP_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https: http:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
/** 静态资源扩展名白名单（只有这些出网，其余一律 404）。 */
const CLIP_ASSET_TYPES = {
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  woff2: 'font/woff2',
  png: 'image/png',
  svg: 'image/svg+xml',
  map: 'application/json; charset=utf-8',
}
/** stageId / k 的形态：43 字符 base64url，且长度不得小于契约要求的 32。 */
const CLIP_SECRET_PATTERN = /^[A-Za-z0-9_-]{32,128}$/
/** 单条暂存的正文上限（与导入信封的 `body` 上限同量级：8 MiB，超出 → IMP-4004）。 */
const MAX_CLIP_BODY_BYTES = 8 * 1024 * 1024
/** 单条暂存的附件数量上限（与 02 §2.7 一致：32，超出 → IMP-4013）。 */
const MAX_CLIP_ASSETS = 32

/**
 * 应用版本的**唯一产地是 `package.json`**。
 *
 * 真实运行路径上版本由主进程传进来（`main.cjs`: `getAppVersion: () => app.getVersion()`，
 * 同样源自 `package.json`）；下面这个只是**拿不到挂钩时的兜底**。
 *
 * 兜底绝不能变成「同一个事实的第二个产地」—— 0.3.2 就是这么踩的：`/v1/health` 一直回
 * `"app":"0.2.0"`（常量从 0.2.0 起没人升过），于是 Lead 和 b 都判断「用户跑的是旧版应用」，
 * 而用户跑的就是仓库版，**一条真 bug 差点被判成「本机无法复现」**。
 * **版本号是兼容性判断的唯一输入，它有两个产地就必须有咬合。**
 *
 * 两道保险：
 *   ① 这里**先直接读 `package.json`**（能读到就不再是第二个产地）；
 *   ② 读不到才用下面的常量，而 `scripts/bridge-smoke.cjs` 有一条断言盯着它
 *      「必须与 `package.json` 的 `version` 逐字一致」—— 改任何一边都会红。
 */
function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null
  } catch {
    /* 打包布局不同 / 文件读不到 → 退回兜底常量（咬合断言保证它不落后） */
    return null
  }
}

/** 读不到 `package.json` 时的兜底；**必须**与 `package.json` 的 `version` 逐字一致。 */
const APP_VERSION_FALLBACK = '0.3.2'
const APP_VERSION = readPackageVersion() || APP_VERSION_FALLBACK

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
  // 注意：已作废（0.3.1 ㉞）：配对码整体删除，本码**不再产出**；保留码号以免与历史日志/文档冲突，不得复用给别的语义。
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
  /**
   * 0.3.2（网页版剪藏页 §5.9.5）：暂存的单次性 —— 同一个 `stageId` **内容不同**必须明确失败。
   * **不借用 `IMP-4011`**：那个码的登记含义是「覆盖不可用，已改为新建」，借它就是把
   * 一个码号掰成两个含义（与本简报一路在抓的 `tokenSet` / 明文可见性同族）。
   * 内容**相同**时不报错：原样重放同一份已存回执（幂等）。
   */
  'IMP-4018': { http: 409, retryable: false, message: '暂存条目已入库且内容与当时不同', userMessage: '这个暂存条目已经入库过一次，而且当时的正文与现在不同。请回到浏览器重新剪藏一次。' },
  /**
   * 0.3.2（§5.9.2）剪藏页的 `k` 不匹配 / 缺失。**不借用 `IMP-2002`**：那是「长期令牌无效」，
   * 它的文案指的下一步是「重新生成令牌」—— 页面根本没有令牌，那句话是误导。
   */
  'IMP-4019': { http: 401, retryable: false, message: '剪藏链接的密钥不匹配', userMessage: '这个剪藏链接不完整或已被改过，无法确认它的身份。请回到浏览器重新剪藏一次。' },
  'IMP-4020': { http: 409, retryable: true, message: '同一 importId 的在途提交超过 10 s', userMessage: '上一次导入还在进行中，请稍候重试。' },
  /**
   * 0.3.2（§5.9.2）剪藏暂存不存在 / 已过期（TTL 15 分钟，或进程重启后内存清空）。
   * **不借用 `IMP-4017`**：那是「查询的 importId 不存在」，与「一次性暂存过期」不是一件事。
   */
  'IMP-4021': { http: 404, retryable: false, message: '剪藏暂存不存在或已过期', userMessage: '这条剪藏暂存已经失效（暂存只保留 15 分钟），请回到浏览器重新剪藏一次。' },
  /**
   * 0.3.2（§5.9.5）剪藏落点目录不存在。**不借用 `IMP-4008`**：那个码的登记触发条件是
   * 「绝对路径 / `..` / `\0` / `:` / 超深 / 超长」这类**字面非法**，文案也在说「不能使用 ..、
   * 绝对路径或系统保留字符」；而这里的目录名字面完全合法、只是**不存在**。
   * 更关键的是 02 §2.4 规定「目录不存在时默认创建」——「不存在」在信封契约里本来就不是错，
   * 它是剪藏页自己收窄的规定（**绝不自动创建**），所以必须自己有一个码。
   * （字面非法那一支**照旧**走 `IMP-4008`，两者不混。）
   */
  'IMP-4022': { http: 422, retryable: false, message: '剪藏落点目录不存在', userMessage: '这个目录在笔记本里不存在。请回到剪藏页重新选择落点。' },
  'IMP-5001': { http: 500, retryable: true, message: '写盘失败', userMessage: '写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。' },
  'IMP-5002': { http: 503, retryable: true, message: '本地接口未开启', userMessage: '本地接口当前不在运行状态。请先在 Opennote 的「设置 · 文件 · 导入与接口」里开启接口，再重试。' },
  /**
   * 0.3.2（§5.9.3）：剪藏页产物缺失。**不借用 `IMP-5001`**（那个码的登记含义是写盘失败），
   * 也不把 503 当成「随便挑一个 5xx」—— 缺构建产物是可修的部署问题，`retryable: true`。
   */
  'IMP-5003': { http: 503, retryable: true, message: '剪藏页产物缺失（dist-clip 未构建）', userMessage: '网页版剪藏页还没有构建（找不到 dist-clip）。请先跑一次 pnpm build:clip，再重试打开。' },
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

/**
 * 把引导数据块插进 Vite 产物：优先 `</body>` 之前，其次 `</html>` 之前，都没有就追加到末尾。
 * 纯函数（只做字符串拼接），所以「注入位置」这条规则可以被单独断言。
 */
function injectClipBoot(html, snippet) {
  const bodyEnd = html.search(/<\/body\s*>/i)
  if (bodyEnd >= 0) return `${html.slice(0, bodyEnd)}${snippet}\n${html.slice(bodyEnd)}`
  const htmlEnd = html.search(/<\/html\s*>/i)
  if (htmlEnd >= 0) return `${html.slice(0, htmlEnd)}${snippet}\n${html.slice(htmlEnd)}`
  return `${html}\n${snippet}\n`
}

// ---------------------------------------------------------------------------
// createBridge
// ---------------------------------------------------------------------------

/**
 * @param {object} options 见文件头注释（冻结接口 + 可选扩展）。
 * @returns {{start: Function, stop: Function, status: Function, regenerateToken: Function, generateToken: Function, getSessionPlaintext: Function, writeInboxState: Function, readAllowedOrigins: Function, addAllowedOrigin: Function, removeAllowedOrigin: Function}}
 *
 * `stop()` 默认只停监听（退出应用 / 窗口关闭用它，**不动**用户偏好）；面板上「关闭接口」
 * 这种用户显式关闭传 `stop({ disable: true })`（清掉偏好，下次启动不自动恢复）。见 `state.enabled`。
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
  /**
   * 剪藏页的落点列表来源（0.3.2）。同步或异步均可：主进程眼下是同步实现，
   * 但 relay 形态（渲染层应答）必然是异步的，所以这里一律 await，不把实现绑死。
   * 拿不到（缺失 / 抛错 / 不是数组）**与空数组是两件事**：前者明确失败，后者如实报「只有收件箱」。
   */
  const getFoldersHook = typeof options.getFolders === 'function' ? options.getFolders : null

  const dataDir = typeof options.dataDir === 'string' && options.dataDir !== '' ? options.dataDir : null
  const bridgeFile = dataDir ? path.join(dataDir, 'bridge.json') : null
  const logFile = dataDir ? path.join(dataDir, 'bridge.log') : null

  /** 剪藏页覆盖（只给自测；产品路径不传，用模块常量）。 */
  const clipOptions = options.clip && typeof options.clip === 'object' ? options.clip : {}
  const clipDistRoot =
    typeof clipOptions.distRoot === 'string' && clipOptions.distRoot !== '' ? clipOptions.distRoot : CLIP_DIST_ROOT
  /** 暂存区：内存 + TTL，进程退出即失效（不落盘，也不假装是持久队列）。 */
  const clipStore = createClipStageStore({ ttlMs: clipOptions.ttlMs, maxStages: clipOptions.maxStages })


  /** 内存状态。持久化只在给了 dataDir 时发生（默认零文件副作用）。 */
  const persisted = readPersisted()
  const state = {
    /** disabled | stopped | starting | running | port-busy | failed */
    status: persisted.enabled ? 'stopped' : 'disabled',
    /**
     * 注意：**`bridge.json` 里的 `enabled` = 用户偏好（他想不想让它开着）**，
     * 与 `status().enabled`（= 现在有没有在监听，取自 `running`）是**两件事**。
     *
     * 0.3.1 第一版把这两件事合并了：`persist()` 写的是「`state.status` 是不是 running/starting/
     * port-busy/failed」，而 `stop()` 会先把 `state.status` 设成 `'stopped'` 再 `persist()` ——
     * 于是**每次退出应用（`before-quit` → `stop()`）都把「用户上次开着」这个偏好清成 false**，
     * 下次启动读到 `disabled`，不自动恢复监听。用户实测原话：「我打开了本地接口，每次关了
     * 都需要重新打开，按理来说应该记住选项的」。
     *
     * 规矩（别再合并回去）：**只有用户显式开启才置 true，只有用户显式关闭才置 false**
     * （`stop({ disable: true })`）；生命周期停止（退出应用 / 窗口关闭）走**纯 `stop()`**，
     * 一律不动它。「现在在不在监听」只由 `state.status` 表达。
     */
    enabled: persisted.enabled === true,
    port: null,
    error: null,
    tokenHash: persisted.tokenHash,
    tokenLast4: persisted.tokenLast4,
    /** ㊴：明文从磁盘读回（不再是内存态）。旧版 bridge.json 没有它 → null。 */
    tokenPlaintext: persisted.tokenPlaintext,
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
   * ㊴（`00` §6.15，用户原话「还有访问令牌，可随时复制」）**令牌明文落盘**。
   *
   * 这条**推翻了 ㊲**（㊲ 要求明文只留内存、绝不落盘）。用户在最简单的方案上做了知情选择：
   * 明文与 `sha256` / `last4` 并列写进 `bridge.json`，于是**任何时候都能复制** —— 重启、
   * 换窗、几个月后再来都一样，不再有「令牌已不可见，需要时请重新生成」这种状态。
   *
   * 注意：**代价必须如实说给用户**（这是本次改动的第一要求，比代码本身重要）：明文从此
   * **落在磁盘上**，任何能读到 `bridge.json`、剪贴板或本机扩展存储的程序都能拿到它并获得
   * 导入能力。面板的代价披露句逐字写在 `ImportApiPanel.tsx` 的 `TOKEN_COST_HINT` 里，
   * `bridge-smoke` 的 ㊴/㊸ 会咬住它 —— **用户选了简单方案，不等于我们可以少说一句代价**。
   *
   * 仍然不放松的红线：明文**绝不进日志、绝不进错误体、绝不进 `status()` 返回值**，
   * 也绝不写进工作区（只写 `userData` 下的 `bridge.json`）。
   *
   * 形状校验直接复用模块级的 `TOKEN_PATTERN`（一个事实只有一个产地）。
   * **教训**：这里原本新定义了一个 `const TOKEN_PLAINTEXT_SHAPE = /^opn_…$/`，而
   * `readPersisted()` 是在本函数更靠前的地方被调用的 —— 模块级 `const` 在 `createBridge()`
   * 里是**暂时性死区**，`.test()` 抛 ReferenceError，又被 `readPersisted()` 的 catch 吞成
   * 「空状态」，于是**整个令牌被读丢了**（smoke 当场红了 4 条）。凡是「读盘要用」的东西，
   * 一律放模块级；catch 里吞掉的异常也值得再想一遍要不要吞。
   */

  /** 唯一导入队列：全局 1 并发。 */
  let importQueueActive = 0
  const importQueueWaiters = []

  /** 最近一次被拒绝的来源（UI-04/R8 的拒绝记录行）。 */
  let lastRejectedOrigin = null

  // -------------------------------------------------------------------------
  // 持久化（dataDir 未提供时全部是内存操作）
  // -------------------------------------------------------------------------

  function readPersisted() {
    const empty = { tokenHash: null, tokenLast4: null, tokenPlaintext: null, allowedOrigins: [], enabled: false }
    if (!bridgeFile) return empty
    try {
      const parsed = JSON.parse(fs.readFileSync(bridgeFile, 'utf8'))
      if (!parsed || typeof parsed !== 'object') return empty
      const hash = typeof parsed.tokenHash === 'string' && /^[a-f0-9]{64}$/.test(parsed.tokenHash) ? parsed.tokenHash : null
      const last4 = typeof parsed.tokenLast4 === 'string' && /^[A-Za-z0-9_-]{4}$/.test(parsed.tokenLast4) ? parsed.tokenLast4 : null
      // ㊴：明文与哈希并列存在磁盘上（旧版文件没有这个键 → null，面板会如实说明是旧令牌）。
      const plaintext =
        typeof parsed.tokenPlaintext === 'string' && TOKEN_PATTERN.test(parsed.tokenPlaintext)
          ? parsed.tokenPlaintext
          : null
      const origins = Array.isArray(parsed.allowedOrigins)
        ? parsed.allowedOrigins.filter((item) => typeof item === 'string' && item !== '' && item !== 'null')
        : []
      return {
        tokenHash: hash,
        tokenLast4: last4,
        tokenPlaintext: plaintext,
        allowedOrigins: [...new Set(origins)],
        enabled: parsed.enabled === true,
      }
    } catch {
      /* 文件不存在或损坏：当作空状态，不阻塞启动 */
    }
    return empty
  }

  /** 原子写 bridge.json（tmp + rename）。㊴ 起**含令牌明文**（这是用户知情选择的代价）。 */
  function persist() {
    if (!bridgeFile) return
    try {
      fs.mkdirSync(path.dirname(bridgeFile), { recursive: true })
      const payload = {
        version: 2,
        tokenHash: state.tokenHash,
        tokenLast4: state.tokenLast4,
        tokenPlaintext: state.tokenPlaintext,
        allowedOrigins: [...allowedOrigins],
        // 用户偏好，**不从 state.status 推导** —— 推导就会让「退出应用」把偏好清掉（task-27）。
        enabled: state.enabled === true,
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

  /**
   * 读 + 解析 JSON 请求体。**唯一一份**：`/v1/import`、`/v1/clip/stage`、`/v1/clip/commit`
   * 三个入口共用它，否则「空体 / 非 JSON / 顶层不是对象」这三条规则会在三处各写一遍并迟早漂移。
   *
   * 行为（与契约 §2.6 / §6.2 逐条对应）：
   *   - 超过 16 MiB → IMP-4005（`readBody` 在**解析前**按 Content-Length 拦，不读 body）；
   *   - 连接中断 → 返回 null，**不发响应**（对端已经走了）；
   *   - 空体 → IMP-3003；非 JSON → IMP-3002；顶层不是对象 → IMP-4001。
   *
   * @returns {Promise<object|null>} 失败时返回 null（响应已发或对端已断）
   */
  async function readJsonObject(req, res) {
    const body = await readBody(req, res)
    if (body.tooLarge) {
      writeLog('import.error', { code: 'IMP-4005' })
      return null
    }
    if (body.aborted) return null
    const text = body.buffer ? body.buffer.toString('utf8') : ''
    if (text.trim() === '') {
      writeLog('import.error', { code: 'IMP-3003' })
      sendError(req, res, 'IMP-3003')
      return null
    }

    let parsed = null
    try {
      parsed = JSON.parse(text)
    } catch {
      writeLog('import.error', { code: 'IMP-3002' })
      sendError(req, res, 'IMP-3002')
      return null
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      writeLog('import.error', { code: 'IMP-4001' })
      sendError(req, res, 'IMP-4001')
      return null
    }
    return parsed
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

    // 预检**只在这里判一次**（上面那段，见到 `OPTIONS` 就 return）。
    // 这里原本还有**逐字重复的第二段** OPTIONS 分支 —— 它永远不可达（本项目一路在打的
    // 「死路由 / 死订阅 / 死导入」同族），已删除；判据 `C-13m` 咬这个死代码不会复发。

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

    // 网页版剪藏页（0.3.2，契约 §5.9）：静态面 + /v1/clip/*。
    // **必须放在令牌校验之前**：剪藏页是普通网页，拿的是 `stageId + k`，不是长期令牌
    // （页面永不持有长期凭据）。POST /v1/clip/stage 仍走 Content-Type + 令牌两道。
    if (await handleClipRoutes(req, res, url, method, startedAt)) return

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

    const envelope = await readJsonObject(req, res)
    if (!envelope) return

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

    await runEnvelopePipeline(req, res, { envelope, importId, clientName, clientVersion, warnings, startedAt })
  }

  /**
   * **唯一一条入库通路**：信封 → `onEnvelope`（转交渲染层）→ `respondWithReceipt`。
   *
   * `POST /v1/import` 与 `POST /v1/clip/commit` 都走这里 —— 剪藏页复用这条通路，
   * **不许另造第二条写路径**（否则「落点分配 / 去重 / 前像 / 通知」会在两处各写一份，
   * 而其中一份迟早会漏掉 D03/D08 那类边界）。
   *
   * 调用方负责：限流、读请求体、解析、字段校验、组装信封。这里只做三件**所有**通道
   * 都必须做的事：绝对路径闸门 → 窗口在场 → 单并发排队。
   *
   * 返回值：`{ result, status }`（成功，已发响应）或 `{ errorCode, status }`（失败，已发响应）。
   * 返回值只是给调用方记账用的（剪藏页要用它记「已提交」的幂等指纹）——
   * **响应已经在这里发出**，调用方不得再写第二次。
   */
  async function runEnvelopePipeline(req, res, context) {
    const { envelope, importId, clientName, clientVersion, warnings, startedAt } = context

    if (typeof envelope.target === 'object' && envelope.target && typeof envelope.target.folder === 'string') {
      const reject = rejectIllegalFolder(envelope.target.folder)
      if (reject) {
        writeLog('import.error', { code: 'IMP-4008', importId })
        sendError(req, res, 'IMP-4008', { field: 'target.folder' })
        return { errorCode: 'IMP-4008', status: ERROR_TABLE['IMP-4008'].http }
      }
    }

    if (!onEnvelope || (hasGetWindow && !getWindow())) {
      // 窗口不在场：桥的生命周期跟随窗口，绝不假成功（契约 IMP-4006，可重试）。
      writeLog('import.error', { code: 'IMP-4006', importId, client: clientName })
      sendError(req, res, 'IMP-4006')
      return { errorCode: 'IMP-4006', status: ERROR_TABLE['IMP-4006'].http }
    }

    const acquired = await acquireImportSlot()
    if (!acquired) {
      writeLog('ratelimit', { code: 'IMP-4020', importId })
      sendError(req, res, 'IMP-4020', { importId })
      return { errorCode: 'IMP-4020', status: ERROR_TABLE['IMP-4020'].http }
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
      return { errorCode: code, status: ERROR_TABLE[code].http }
    } finally {
      releaseImportSlot()
    }

    return respondWithReceipt(req, res, receipt, { importId, clientName, warnings, startedAt })
  }

  /**
   * 落点是否**非法**（02 §2.4 的落点层规则，§11 硬红线）：绝对路径 / 盘符 / `\` / `\0` /
   * `..` 段 / 含 `:` 的段。
   *
   * 为什么连 `..` 与 `\` 也在这里拦：它们不是「目录不存在」，而是**名字本身非法** ——
   * L2 的 `assertSafeRelative()` 一定会拒（02 §7.3 要求落点层独立再跑一遍），
   * 桥先拦只是把同一个判定提前，给客户端的错误码与文案都更准确（`IMP-4008`），
   * 而不是让一个带 `..` 的落点走到「目录不存在」（`IMP-4022`）那条分支上去。
   *
   * 反过来也成立：`IMP-4022` 只留给「名字合法、但工作区里没有这个目录」。
   * 两个码号的分界线就是**合法性 vs 存在性**，不许混（一个码一个含义）。
   */
  function rejectIllegalFolder(folder) {
    if (folder === '') return false
    if (/^[A-Za-z]:/.test(folder)) return true
    if (folder.startsWith('/') || folder.startsWith('\\')) return true
    if (folder.includes('\0')) return true
    if (folder.includes('\\')) return true
    const segments = folder.split('/')
    if (segments.some((segment) => segment === '..')) return true
    if (segments.some((segment) => segment.includes(':'))) return true
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
   *
   * 返回值（**响应已经发出**，只用于调用方记账）：
   *   成功 → `{ result, status }`；失败 → `{ errorCode, status }`。
   * 剪藏页靠它把「这一份已存回执」原样重放给同一个 stageId 的重试（幂等，不写第二遍）。
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
      return { errorCode: 'IMP-5001', status: ERROR_TABLE['IMP-5001'].http }
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
      return { errorCode, status: spec.http }
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
    return { result, status }
  }

  // -------------------------------------------------------------------------
  // 网页版剪藏页（0.3.2，契约 §5.9）
  // -------------------------------------------------------------------------

  /**
   * **这里曾经有一个 `CLIP_HINTS`（按用途索引的 userMessage 覆盖表），0.3.2 已整体删除。**
   *
   * 为什么不再有它（这条要留下来，免得下次有人再造一个）：同一个码号配另一句话，
   * 就是「一个码号两个含义」—— 而且 `verify-contract` 的 C-6c/C-6f 只比对**错误表**，
   * **看不见**路由里的覆盖。也就是说那种漂移是**恒绿**的：表还是逐字一致，
   * 实现却已经给了另一个说法。恒绿的检查比没有检查更坏，所以这个口子必须关掉，
   * 而不是靠「表还一致」给它发通行证。
   *
   * 于是剪藏页的每一类失败都有自己的正式码号（各自只在一个地方产出）：
   *   `k` 不匹配 / 缺失                          → `IMP-4019`（401）
   *   暂存不存在 / 已过期                        → `IMP-4021`（404）
   *   落点目录不存在                             → `IMP-4022`（422）
   *   同一暂存已入库且内容不同                    → `IMP-4018`（409）
   *   产物未构建                                 → `IMP-5003`（503）
   *   目录列表：工作区没打开 / 挂钩拿不到          → `IMP-4007`（409）/ `IMP-4014`（500），原样用登记文案
   * **全部原样用登记文案**：一个码号只有一处文案产地。
   */

  /** 页面入口 / 静态资源目录的绝对路径（产物不存在时这里只是「一个不存在的路径」，由调用方回 503）。 */
  function clipIndexPath() {
    return path.join(clipDistRoot, CLIP_INDEX_RELATIVE)
  }

  function clipAssetsDir() {
    return path.join(clipDistRoot, CLIP_ASSETS_RELATIVE)
  }

  function safeDecode(value) {
    if (typeof value !== 'string' || value === '') return ''
    try {
      return decodeURIComponent(value)
    } catch {
      return ''
    }
  }

  /**
   * 发剪藏页 HTML：CSP 逐字冻结 + `no-store`（页面每次都要新的一份，避免旧 bundle 卡住）。
   * 引导数据走 `<script type="application/json">`：**它不会被浏览器执行**，
   * 所以 CSP 里的 `script-src 'self'` 不需要 `unsafe-inline`。
   */
  function sendHtml(req, res, httpStatus, html) {
    if (res.writableEnded || res.destroyed) return
    const body = Buffer.from(html, 'utf8')
    const headers = {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': CLIP_CSP,
      'Content-Length': body.length,
    }
    if (res.__cors && !res.__noCors) Object.assign(headers, corsHeaders(res.__cors.origin, res.__cors.preflight))
    res.writeHead(httpStatus, headers)
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * 工作区目录列表。
   *
   * 三种结果**必须分开**（一个返回值扛两种含义就是撒谎）：
   *   - `{ ok:true, folders: ["", …] }`：拿到了。`""` 恒为第 0 项（= 收件箱）；
   *     **列表真的为空**也走这里（如实说「工作区里只有收件箱」）。
   *   - `{ ok:false, code:'IMP-4007' }`：**工作区没打开**（`getWorkspaceInfo().open` 非真）。
   *     登记文案本来就是「Opennote 里还没有打开笔记本文件夹…」，语义精确，**原样用**。
   *   - `{ ok:false, code:'IMP-4014' }`：**挂钩拿不到**（缺失 / 抛错 / 返回非数组 / 10 秒无响应）。
   *     这是接口侧的内部错误，登记文案「导入时出现了内部错误…」同样是精确的，**原样用**。
   *
   * 分类顺序：先判工作区（没打开工作区时，目录列表这个问题本身问不出来）。
   */
  async function clipFolders() {
    const info = typeof options.getWorkspaceInfo === 'function' ? options.getWorkspaceInfo() : null
    if (!info || info.open !== true) return { ok: false, code: 'IMP-4007' }
    if (!getFoldersHook) return { ok: false, code: 'IMP-4014' }
    let raw
    try {
      // 同步实现与 relay（异步）实现都要能用；relay 卡死由 withTimeout 兜底。
      raw = await withTimeout(Promise.resolve().then(() => getFoldersHook()), REQUEST_TIMEOUT_MS)
    } catch {
      return { ok: false, code: 'IMP-4014' }
    }
    if (!Array.isArray(raw)) return { ok: false, code: 'IMP-4014' }
    const seen = new Set()
    for (const item of raw) {
      if (typeof item === 'string' && item.trim() !== '') seen.add(item)
    }
    // 码元序排序：不依赖 ICU 语言环境，跨机器/跨 Node 版本结果一致。
    return { ok: true, folders: ['', ...[...seen].sort()] }
  }

  /**
   * 校验 `stageId + k`（页面唯一凭据）。返回 entry；失败时已发响应并返回 null。
   *
   * 顺序：先按 stageId 取（不存在/过期 → `IMP-4021` 404），再**定时安全**比较 k
   * （不符 → `IMP-4019` 401，`timingSafeEqualText` 是本文件里唯一的比较实现）。
   * 两个码号可区分是**有意**的：stageId 是 32 字节随机数、不可枚举，泄漏「某 id 是否存在」
   * 没有可利用价值；而页面要能如实区分「链接过期了」与「链接被改过」。
   *
   * 两者**都原样用登记文案**：`k` 不是长期令牌，所以不能借 `IMP-2002`（那句让用户去
   * 「重新生成令牌」，页面上根本没有这回事）；暂存过期也不是 `IMP-4017`（查导入记录）。
   */
  function resolveClipStage(req, res, stageId, key) {
    const id = typeof stageId === 'string' && CLIP_SECRET_PATTERN.test(stageId) ? stageId : ''
    const entry = id ? clipStore.get(id) : null
    if (!entry) {
      writeLog('import.error', { code: 'IMP-4021', detail: 'clip-stage' })
      sendError(req, res, 'IMP-4021', { reason: 'unknown-or-expired' })
      return null
    }
    if (typeof key !== 'string' || !timingSafeEqualText(key, entry.key)) {
      // k 是「一份剪藏一份凭据」，与长期令牌无关：**不**记进 authFailWindow
      // （那把窗口是给长期令牌的爆破限流用的，把 k 的失败混进去会误伤真客户端）。
      writeLog('auth.fail', { code: 'IMP-4019', detail: 'clip-key' })
      sendError(req, res, 'IMP-4019', { header: 'k' })
      return null
    }
    return entry
  }

  /** url 只接受 http(s) 或 null / 空（与信封 §2.3 同一口径）。 */
  function clipUrl(value) {
    if (value === undefined || value === null || value === '') return { ok: true, value: null }
    if (typeof value !== 'string') return { ok: false }
    let parsed
    try {
      parsed = new URL(value)
    } catch {
      return { ok: false }
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false }
    return { ok: true, value }
  }

  function clipText(value) {
    return typeof value === 'string' && value !== '' ? value : null
  }

  /**
   * `POST /v1/clip/stage` —— 扩展在「还有 activeTab 授权」时把内容交给桥暂存。
   * 鉴权：Bearer 长期令牌（复用 `checkToken`），与 `/v1/import` 同一把。
   * 响应形状（**冻结，平铺、不套 `result`**）：`{ ok:true, stageId, expiresAt, openUrl }`。
   */
  async function handleClipStageCreate(req, res) {
    // 与 /v1/import 共用同一只令牌桶：都是「本机客户端往桥里塞内容」，没必要开第二套限流。
    const wait = takeToken(importBucket)
    if (wait > 0) {
      writeLog('ratelimit', { code: 'IMP-4015', detail: 'clip-stage' })
      sendJson(req, res, ERROR_TABLE['IMP-4015'].http, errorBody('IMP-4015'), { 'Retry-After': String(wait) })
      return
    }

    const payload = await readJsonObject(req, res)
    if (!payload) return

    if (payload.spec !== CLIP_SPEC) {
      writeLog('import.error', { code: 'IMP-4002', detail: 'clip-spec' })
      sendError(req, res, 'IMP-4002', { field: 'spec' })
      return
    }
    if (typeof payload.title !== 'string' || payload.title.trim() === '') {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-title' })
      sendError(req, res, 'IMP-4003', { field: 'title' })
      return
    }
    if (typeof payload.body !== 'string') {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-body' })
      sendError(req, res, 'IMP-4003', { field: 'body' })
      return
    }
    if (Buffer.byteLength(payload.body, 'utf8') > MAX_CLIP_BODY_BYTES) {
      writeLog('import.error', { code: 'IMP-4004', detail: 'clip-body' })
      sendError(req, res, 'IMP-4004', { field: 'body', limit: MAX_CLIP_BODY_BYTES })
      return
    }
    if (payload.selection !== undefined && typeof payload.selection !== 'boolean') {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-selection' })
      sendError(req, res, 'IMP-4003', { field: 'selection' })
      return
    }
    const url = clipUrl(payload.url)
    if (!url.ok) {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-url' })
      sendError(req, res, 'IMP-4003', { field: 'url' })
      return
    }

    const tags = []
    if (payload.tags !== undefined && payload.tags !== null) {
      if (!Array.isArray(payload.tags)) {
        writeLog('import.error', { code: 'IMP-4003', detail: 'clip-tags' })
        sendError(req, res, 'IMP-4003', { field: 'tags' })
        return
      }
      for (const item of payload.tags) {
        if (typeof item !== 'string') {
          writeLog('import.error', { code: 'IMP-4003', detail: 'clip-tags' })
          sendError(req, res, 'IMP-4003', { field: 'tags' })
          return
        }
        // 超过 32 个由 L2 依据 §2.7 截断 + warning；这里只是不再往暂存里堆。
        if (tags.length < 32) tags.push(item)
      }
    }

    let source = {}
    if (payload.source !== undefined && payload.source !== null) {
      if (typeof payload.source !== 'object' || Array.isArray(payload.source)) {
        writeLog('import.error', { code: 'IMP-4003', detail: 'clip-source' })
        sendError(req, res, 'IMP-4003', { field: 'source' })
        return
      }
      for (const key of ['site', 'author', 'publishedAt']) {
        const value = payload.source[key]
        if (value !== undefined && value !== null && typeof value !== 'string') {
          writeLog('import.error', { code: 'IMP-4003', detail: `clip-source-${key}` })
          sendError(req, res, 'IMP-4003', { field: `source.${key}` })
          return
        }
      }
      source = {
        site: clipText(payload.source.site),
        author: clipText(payload.source.author),
        publishedAt: clipText(payload.source.publishedAt),
      }
    }

    const assets = []
    if (payload.assets !== undefined && payload.assets !== null) {
      if (!Array.isArray(payload.assets)) {
        writeLog('import.error', { code: 'IMP-4003', detail: 'clip-assets' })
        sendError(req, res, 'IMP-4003', { field: 'assets' })
        return
      }
      if (payload.assets.length > MAX_CLIP_ASSETS) {
        writeLog('import.error', { code: 'IMP-4013', detail: 'clip-assets' })
        sendError(req, res, 'IMP-4013', { field: 'assets', limit: MAX_CLIP_ASSETS, received: payload.assets.length })
        return
      }
      for (const [index, item] of payload.assets.entries()) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) {
          writeLog('import.error', { code: 'IMP-4003', detail: 'clip-asset' })
          sendError(req, res, 'IMP-4003', { field: `assets[${index}]` })
          return
        }
        if (typeof item.name !== 'string' || item.name === '') {
          writeLog('import.error', { code: 'IMP-4003', detail: 'clip-asset-name' })
          sendError(req, res, 'IMP-4003', { field: `assets[${index}].name` })
          return
        }
        if (typeof item.mime !== 'string' || item.mime === '') {
          writeLog('import.error', { code: 'IMP-4003', detail: 'clip-asset-mime' })
          sendError(req, res, 'IMP-4003', { field: `assets[${index}].mime` })
          return
        }
        // 只搬 L0 认得的那几个键（未知字段一律忽略，02 §2.2）。base64 / MIME 白名单由 L2 判（IMP-4012）。
        const copy = { name: item.name, mime: item.mime }
        if (typeof item.dataBase64 === 'string') copy.dataBase64 = item.dataBase64
        if (typeof item.file === 'string') copy.file = item.file
        assets.push(copy)
      }
    }

    const entry = clipStore.stage({
      url: url.value,
      title: payload.title,
      body: payload.body,
      selection: payload.selection === true,
      tags,
      source,
      assets,
      // 「剪藏时间」在这里定格：这是用户按下剪藏的那一刻，不是入库那一刻。
      capturedAt: new Date().toISOString(),
    })

    // openUrl 只由桥拼（扩展不许自己拼）：端口是 8787–8796 里选出来的，客户端无法预知。
    const openUrl = `http://127.0.0.1:${listeningPort}/clip/${entry.stageId}?k=${encodeURIComponent(entry.key)}`
    // 形状冻结：平铺 { ok, stageId, expiresAt, openUrl }，**不套 result**（契约 §5.9）。
    // 这里**不写日志**：stageId / k 绝不进 bridge.log，成功暂存又没有别的可记字段。
    sendJson(req, res, 200, { ok: true, stageId: entry.stageId, expiresAt: entry.expiresAt, openUrl })
  }

  /** `GET /v1/clip/stage?stageId=&k=` —— 页面读暂存内容（新增端点，理由见契约 §5.9.4）。 */
  async function handleClipStageRead(req, res, url) {
    const entry = resolveClipStage(req, res, url.searchParams.get('stageId'), url.searchParams.get('k'))
    if (!entry) return
    const staged = entry.payload
    sendJson(req, res, 200, {
      ok: true,
      stage: {
        url: staged.url,
        title: staged.title,
        body: staged.body,
        selection: staged.selection,
        tags: staged.tags,
        source: staged.source,
        assets: staged.assets,
        capturedAt: staged.capturedAt,
      },
      expiresAt: entry.expiresAt,
    })
  }

  /** `GET /v1/clip/folders?stageId=&k=` —— 落点候选（`""` 恒为第 0 项）。 */
  async function handleClipFolders(req, res, url) {
    const entry = resolveClipStage(req, res, url.searchParams.get('stageId'), url.searchParams.get('k'))
    if (!entry) return
    const folders = await clipFolders()
    if (!folders.ok) {
      writeLog('import.error', { code: folders.code, detail: 'clip-folders' })
      sendError(
        req,
        res,
        folders.code,
        folders.code === 'IMP-4007' ? { reason: 'workspace-closed' } : { hook: 'getFolders', reason: 'unavailable' },
      )
      return
    }
    sendJson(req, res, 200, { ok: true, folders: folders.folders })
  }

  /**
   * `POST /v1/clip/commit { stageId, k, title, body, folder }`
   *   - `folder` 省略 / `""` → `target.folder: null`（不指定落点）。默认设置（㉕ `importConflict:"inbox"`）
   *     下它进收件箱；若用户改成「直接入库」则是工作区根。**页面不得承诺「一定进收件箱」**，
   *     一律以回执 `status` 为准。
   *   - `folder` 非空 → 必须是 `getFolders()` 里**已存在**的目录；不在列表 → IMP-4008，
   *     **绝不自动创建**（契约 §5.9.6）。
   *   - 内部**复用** `runEnvelopePipeline`（信封 → onEnvelope → respondWithReceipt），
   *     不另造第二条写路径。
   *   - 单次性：同一 stageId 已成功提交过 → 同内容重放同一份回执（不写第二遍）；
   *     内容不同 → IMP-4018（409），不静默覆盖。
   */
  async function handleClipCommit(req, res, startedAt) {
    const payload = await readJsonObject(req, res)
    if (!payload) return

    const entry = resolveClipStage(req, res, payload.stageId, payload.k)
    if (!entry) return

    if (typeof payload.title !== 'string' || payload.title.trim() === '') {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-commit-title' })
      sendError(req, res, 'IMP-4003', { field: 'title' })
      return
    }
    if (typeof payload.body !== 'string') {
      writeLog('import.error', { code: 'IMP-4003', detail: 'clip-commit-body' })
      sendError(req, res, 'IMP-4003', { field: 'body' })
      return
    }

    let folder = null
    if (payload.folder !== undefined && payload.folder !== null && payload.folder !== '') {
      if (typeof payload.folder !== 'string') {
        writeLog('import.error', { code: 'IMP-4003', detail: 'clip-commit-folder' })
        sendError(req, res, 'IMP-4003', { field: 'folder' })
        return
      }
      if (rejectIllegalFolder(payload.folder)) {
        writeLog('import.error', { code: 'IMP-4008', detail: 'clip-commit-folder' })
        sendError(req, res, 'IMP-4008', { field: 'folder' })
        return
      }
      folder = payload.folder
    }

    /** 幂等指纹：只认「最终要写下去的三件事」，与请求里其他噪声无关。 */
    const fingerprint = sha256Hex(JSON.stringify(['opennote.clip/commit/v1', payload.title, payload.body, folder]))

    if (entry.commit) {
      if (entry.commit.fingerprint === fingerprint) {
        // 幂等重放：同一 stageId + 同一内容 → 原样回**同一份**已存回执，磁盘不再动一次。
        sendOk(req, res, entry.commit.httpStatus, entry.commit.receipt)
        return
      }
      // 内容不同 → 正式码号 IMP-4018（409），不静默覆盖、也不把第二次提交当成一次新导入。
      writeLog('import.error', { code: 'IMP-4018', detail: 'clip-committed' })
      sendError(req, res, 'IMP-4018', { stage: 'committed', reason: 'different-content' })
      return
    }

    if (folder !== null) {
      const folders = await clipFolders()
      if (!folders.ok) {
        writeLog('import.error', { code: folders.code, detail: 'clip-folders' })
        sendError(
          req,
          res,
          folders.code,
          folders.code === 'IMP-4007' ? { reason: 'workspace-closed' } : { hook: 'getFolders', reason: 'unavailable' },
        )
        return
      }
      if (!folders.folders.includes(folder)) {
        // 目录**不存在**（名字合法）→ IMP-4022；字面非法（绝对路径 / .. / 盘符）在更上面那一支走 IMP-4008。
        writeLog('import.error', { code: 'IMP-4022', detail: 'clip-folder-missing' })
        sendError(req, res, 'IMP-4022', { field: 'folder', reason: 'not-in-workspace', folder })
        return
      }
    }

    const staged = entry.payload
    const envelope = {
      spec: SPEC_VERSION,
      // importId **由桥生成**、且与 stageId 无关：stageId 是暂存身份，importId 是幂等键。
      importId: crypto.randomUUID(),
      title: payload.title,
      body: payload.body,
      source: {
        url: staged.url,
        // `source.title` = 暂存那一刻抓到的网页标题（用户随后在页面里改的是笔记标题，
        // 不该反过来改写「来源信息」）—— 这样 front-matter 的 source_title 才有意义。
        title: staged.title,
        site: staged.source.site,
        author: staged.source.author,
        publishedAt: staged.source.publishedAt,
        capturedAt: staged.capturedAt,
        selection: staged.selection === true,
      },
      target: { folder, notePath: null },
      conflict: 'new',
      tags: staged.tags,
      assets: staged.assets,
      client: { name: CLIP_CLIENT_NAME, version: '' },
    }

    const outcome = await runEnvelopePipeline(req, res, {
      envelope,
      importId: envelope.importId,
      clientName: CLIP_CLIENT_NAME,
      clientVersion: '',
      warnings: [],
      startedAt,
    })
    // 只有**成功**才记「已提交」：失败必须能用同一个 stageId 重试（失败不该把暂存用掉）。
    if (outcome && outcome.result) {
      clipStore.recordCommit(entry.stageId, fingerprint, outcome.result, outcome.status)
    }
  }

  /** 静态资源名：单段、白名单扩展名、无量词可疑字符（穿越/盘符/反斜杠/NUL）。 */
  function isClipAssetName(name) {
    if (typeof name !== 'string' || name === '' || name.length > 200) return false
    if (name.includes('/') || name.includes('\\') || name.includes('\0') || name.includes(':')) return false
    if (name.includes('..')) return false
    if (path.basename(name) !== name) return false
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:js|css|woff2|png|svg|map)$/.test(name)) return false
    return true
  }

  /** 静态资源的一律 404（路径穿越、白名单外、文件不存在都是它，不区分）。 */
  function clipAssetMiss(req, res) {
    // 用 import.error（「这个请求被拒绝了」）而不是 origin.reject：后者是「来源不被允许」的专属事件，
    // 拿它记一个资源 404 会把日志的语义搅浑。
    writeLog('import.error', { code: 'IMP-3005', detail: 'clip-asset' })
    sendError(req, res, 'IMP-3005', { path: '/clip/assets/<file>' })
  }

  /** `GET /clip/assets/<file>` —— 无令牌，只服务产物 `clip/assets/**`。 */
  function handleClipAsset(req, res, route) {
    const prefix = '/clip/assets/'
    if (!route.startsWith(prefix)) {
      clipAssetMiss(req, res)
      return
    }
    const name = safeDecode(route.slice(prefix.length))
    if (!isClipAssetName(name)) {
      clipAssetMiss(req, res)
      return
    }
    const dir = clipAssetsDir()
    const target = path.join(dir, name)
    const relative = path.relative(dir, target)
    if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) {
      clipAssetMiss(req, res)
      return
    }
    let stat = null
    let body = null
    try {
      stat = fs.statSync(target)
      if (stat.isFile()) body = fs.readFileSync(target)
    } catch {
      body = null
    }
    if (!body) {
      clipAssetMiss(req, res)
      return
    }
    const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase()
    const headers = {
      'Content-Type': CLIP_ASSET_TYPES[ext] || 'application/octet-stream',
      'Content-Length': body.length,
      // no-store：产物可能刚重建，别让浏览器吃旧 bundle。
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    }
    if (res.__cors && !res.__noCors) Object.assign(headers, corsHeaders(res.__cors.origin, res.__cors.preflight))
    res.writeHead(200, headers)
    res.end(req.method === 'HEAD' ? undefined : body)
  }

  /**
   * `GET /clip/<stageId>?k=` —— 剪藏页本体：产物原文 + 注入的引导数据块。
   * 无令牌（页面永不持有长期令牌），凭 `k`；`k` 不对 → 401、暂存不存在/过期 → 404。
   * 产物不存在 → **503 + 明确文案**，绝不回空 200（空 200 会让页面白屏且没人知道为什么）。
   */
  function handleClipPage(req, res, url, rawStageId) {
    const entry = resolveClipStage(req, res, safeDecode(rawStageId), url.searchParams.get('k'))
    if (!entry) return
    let html
    try {
      html = fs.readFileSync(clipIndexPath(), 'utf8')
    } catch {
      // 产物不存在 → 503 + 明确文案，**绝不回空 200**（空 200 会让页面白屏且查不出原因）。
      // 用正式码号 IMP-5003：它与 IMP-5001（写盘失败）是两件事，不借码。
      writeLog('import.error', { code: 'IMP-5003', detail: 'clip-page-missing' })
      sendError(req, res, 'IMP-5003', { artifact: `${CLIP_DIST_RELATIVE}/${CLIP_INDEX_RELATIVE}` })
      return
    }
    // `<` 转义成 `\u003c`：即便将来某个值里出现 `<`，也绝不可能从 JSON 里逃出 `</script>`。
    const boot = JSON.stringify({ port: listeningPort, stageId: entry.stageId, k: entry.key }).replace(/</g, '\\u003c')
    const snippet = `<script type="application/json" id="${CLIP_BOOT_ID}">${boot}</script>`
    sendHtml(req, res, 200, injectClipBoot(html, snippet))
  }

  /**
   * 剪藏页路由。返回 true = 已处理（响应已发/已在发）。
   *
   * 鉴权分两种（**页面永不持有长期令牌**）：
   *   `POST /v1/clip/stage` → Bearer 长期令牌（扩展在还有 activeTab 授权时提交）
   *   其余三个端点            → `stageId + k`（页面自己拿到的一次性凭据，15 分钟过期）
   * 静态面 `/clip/*`         → 无令牌，凭 `k`；不校验 Content-Type（是导航/资源请求）
   */
  async function handleClipRoutes(req, res, url, method, startedAt) {
    const route = url.pathname

    if (route === '/clip' || route.startsWith('/clip/')) {
      if (method !== 'GET') {
        sendError(req, res, 'IMP-3005', { method: req.method, path: '/clip/*' })
        return true
      }
      if (route === '/clip/assets' || route.startsWith('/clip/assets/')) {
        handleClipAsset(req, res, route)
        return true
      }
      handleClipPage(req, res, url, route.slice('/clip/'.length))
      return true
    }

    if (route === '/v1/clip/stage') {
      if (method === 'POST') {
        if (!checkContentType(req, res)) return true
        if (!checkToken(req, res)) return true
        await handleClipStageCreate(req, res)
        return true
      }
      if (method === 'GET') {
        await handleClipStageRead(req, res, url)
        return true
      }
      sendError(req, res, 'IMP-3005', { method: req.method, path: route })
      return true
    }

    if (route === '/v1/clip/folders' && method === 'GET') {
      await handleClipFolders(req, res, url)
      return true
    }

    if (route === '/v1/clip/commit' && method === 'POST') {
      if (!checkContentType(req, res)) return true
      await handleClipCommit(req, res, startedAt)
      return true
    }

    return false
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

  /**
   * 开启监听（用户显式开启，或启动时按偏好自动恢复）。
   *
   * `state.enabled`（用户偏好）在这里置 true 并落盘 —— **只要用户点过「开启」就算数**，
   * 哪怕这次没监听成功（端口占满）：那是「他的意愿」，不是「当前状态」。
   */
  async function start() {
    if (state.status === 'running' && server) {
      return { port: listeningPort }
    }
    // 用户想让接口开着（偏好），与这次能不能开起来是两件事。
    if (!state.enabled) {
      state.enabled = true
      persist()
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

  /**
   * 关闭监听。**默认只停监听，不动用户偏好** —— `main.cjs` 的 `before-quit` / 窗口关闭
   * 走的就是这条路径：退出应用不代表用户想关掉这个功能，下次开应用要按偏好自动恢复。
   *
   * 面板上「关闭接口」那种**用户显式关闭**要传 `stop({ disable: true })`：它把偏好置 false
   * 并落盘，下次启动就是 `disabled`、不自动恢复。两者必须分开，否则就回到 task-27 那个
   * 「一个字段两个语义」的 bug。
   *
   * 注：这里**不**把 `state.status` 改成 `'disabled'` —— 用户可见的状态串（已停止 / 未开启）
   * 按 `03` 的既有规定不动，偏好只体现在**下次启动**的初始状态上。
   */
  async function stop(options) {
    const disable = Boolean(options && options.disable === true)
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
    // 只有**用户显式关闭**才改偏好；纯 stop()（退出应用 / 窗口关闭）保持原样（task-27）。
    if (disable) state.enabled = false
    persist()
  }

  // -------------------------------------------------------------------------
  // 令牌
  // -------------------------------------------------------------------------

  /**
   * 生成/轮换令牌：立刻作废旧令牌，返回新明文，并把明文与哈希一起**写进 `bridge.json`**（㊴）。
   * 于是**任何时候都能复制** —— 重启、换窗、几个月后再来都一样。
   *
   * `status().tokenVisible` 因此恒为 `true`（只要生成过一次）。
   */
  function regenerateToken() {
    const token = generateToken()
    state.tokenHash = sha256Hex(token)
    state.tokenLast4 = token.slice(-4)
    state.tokenPlaintext = token
    persist()
    return token
  }

  /**
   * ㊴ **只读**取回令牌明文：**从磁盘状态读回**（不再是 ㊲ 的内存态），拿不到就返回 `null`。
   *
   * **调用它绝不轮换令牌、绝不写盘、绝不改任何状态** —— 这是它与 `regenerateToken()` 的本质区别：
   * `regenerateToken()` = 「重新生成」（旧令牌立刻作废），这里只是把那串**已经有效**的明文
   * 再交出来一次。IPC 层（`opennote:bridge:token`）用它解决「整窗重载后界面拿不到明文，
   * 于是『复制』变成点不动的按钮」—— 那正是本项目一路在打的假开关 / 死按钮缺陷。
   *
   * `null` 只剩一个可达场景：`bridge.json` 是**旧版本**（㊲ 之前或 ㊲ 期间）写的 —— 它只有
   * `sha256` + `last4`，明文不可能凭空长出来；或外部用 `setTokenHash()` 塞了一个哈希。
   * **两种情况都不代表令牌失效**：令牌仍然长期有效，只是要重新生成一次才有明文。
   */
  function getSessionPlaintext() {
    return typeof state.tokenPlaintext === 'string' && state.tokenPlaintext !== '' ? state.tokenPlaintext : null
  }

  function setTokenHash(hash, last4) {
    if (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)) return false
    state.tokenHash = hash
    state.tokenLast4 = typeof last4 === 'string' ? last4.slice(-4) : null
    // 外部改写了哈希 → 盘上那串明文已经不对应了，必须丢掉（否则面板会复制一串已失效的令牌）。
    state.tokenPlaintext = null
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
      /**
       * 面板的开关读它 = 「**现在**有没有在监听」。与 `bridge.json` 里的 `enabled`
       * （= 用户偏好，见 `state.enabled`）是**两件事**，别再把它们当同一个。
       */
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
       * ㊴：**明文是否真的握在手里（在盘上）**，也就是「复制」能不能用。
       *
       * 它**不是** `tokenSet` 的重复产地：`tokenSet` 说「有没有令牌」，这里说「有没有明文」。
       * 两者唯一不等的场景是**旧版 `bridge.json`**（只有 `sha256` + `last4`，明文不可能凭空
       * 长出来）或外部 `setTokenHash()` 塞进来的哈希 —— 那时面板必须如实说明是旧令牌，
       * 而不是画一个永远点不动的复制按钮（本项目一路在打的死按钮缺陷）。
       */
      tokenVisible: typeof state.tokenPlaintext === 'string' && state.tokenPlaintext !== '',
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
    /** ㊴ 只读取回明文（IPC `opennote:bridge:token` 用；从磁盘状态读，绝不轮换、绝不写盘）。 */
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
  /** 咬合断言要盯的两个值：生效版本（优先读 package.json）与兜底常量（必须与 package.json 一致）。 */
  APP_VERSION,
  APP_VERSION_FALLBACK,
  TOKEN_PATTERN,
  ERROR_TABLE,
  STATE_NAMES,
  generateToken,
  sha256Hex,
  // 网页版剪藏页（0.3.2）：只导出常量（供 smoke 与文档咬合断言），不导出任何运行时状态。
  CLIP_SPEC,
  CLIP_DIST_RELATIVE,
  CLIP_DIST_ROOT,
  CLIP_BOOT_ID,
  CLIP_CSP,
  CLIP_ASSET_TYPES,
  CLIP_STAGE_TTL_MS,
  MAX_CLIP_ASSETS,
  MAX_CLIP_BODY_BYTES,
}
