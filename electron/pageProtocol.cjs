'use strict'

/**
 * HTML 页面在**桌面端**的专用协议（`opennote-page:`）。
 *
 * ## 为什么不能直接把 HTML 塞进 iframe（srcdoc / blob:）
 *
 * 子框架会**继承父文档的 CSP**。应用窗口的策略是
 * `script-src 'self' file: ...`（见 `main.cjs` 的 `cspPolicy()`），而原型页面的脚本
 * 一律是**内联**的 ⇒ 页面自己的 `<script>` 会被静默挡掉：用户看到的是一片白，
 * 只有 DevTools 里有一行 CSP 报错。这不是「配置没调对」，是规范强制的继承关系，
 * 所以必须让页面从一个**自带策略的独立 URL** 加载 —— 这就是本协议存在的全部理由。
 *
 * ## 为什么 URL 里带完整路径，而不是一个 token
 *
 * 相对资源（`<img src="./logo.png">`、`<link href="style.css">`、CSS 里的 `url()`）
 * 是相对于**文档 URL** 解析的。把文档挂在与工作区同构的路径上
 * （`opennote-page://page/原型/登录页.html`），`./logo.png` 自然落到
 * `opennote-page://page/原型/logo.png` —— 不用改写正文、不用把资源内联成 data URL，
 * 页面在别处（浏览器 / 编辑器预览）怎么显示，在这里就怎么显示。
 *
 * ## 这个文件为什么是零 Electron 依赖的纯函数
 *
 * `main.cjs` 依赖 Electron，没法在 vitest 里 require。把「URL ⇄ 相对路径」与
 * 「这条路径准不准服务」拆出来，就能用真单测钉住越权规则 —— 与 `deeplink.cjs` 同一套做法。
 * 真正的读盘仍然在 `main.cjs` 里，且**必须**再走一次
 * `requireAuthorizedRoot` + `resolveInsideRoot` + realpath 检查（两层都过才允许读）。
 */

/** 协议名。改这里必须同步改 `main.cjs` 的 `registerSchemesAsPrivileged`。 */
const PAGE_SCHEME = 'opennote-page'

/** 协议里的 host 段。带 host 才让 `standard: true` 下的相对路径解析正常工作。 */
const PAGE_HOST = 'page'

/**
 * 页面文档自己的 CSP —— **与应用的策略完全独立**，这是本协议的核心产出。
 *
 * 逐条理由：
 *   - `default-src 'none'`：没写到的都关掉（与应用的基线同一习惯）。
 *   - `script-src 'unsafe-inline' 'unsafe-eval'`：原型页面必然用内联脚本与模板引擎，
 *     没有别的办法。**不给** `'self'` —— 否则页面可以
 *     `<script src="../../index.js">` 去加载应用自己的打包产物，那等于把宿主代码拉进
 *     一个不可信的上下文里跑。
 *   - `style-src`：内联样式 + 同目录的 .css 文件。
 *   - `img-src / font-src / media-src`：只认本协议与内联数据；**不放 https**，
 *     所以远程图片照旧显示不出来（与桌面版既有的 `img-src` 裁决一致）。
 *   - `connect-src` **故意不写**（落到 `default-src 'none'`）：页面的 fetch / XHR /
 *     WebSocket 全部被拦。原型页面本来就不该访问网络。
 *   - `frame-ancestors`：只允许应用自己的两个来源（打包版 `file:`、开发版 dev server）。
 *     写成 `'self'` 会**嵌不进去**：应用是 `file://`，与本协议的 origin 不同。
 *   - `sandbox` 不在这里给：它由 iframe 的 `sandbox` 属性控制（见 `HtmlPageView`），
 *     两处都写会让人分不清哪一处真正生效。
 */
const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline' opennote-page:",
  'img-src opennote-page: data: blob:',
  'font-src opennote-page: data:',
  'media-src opennote-page: data: blob:',
  "worker-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors file: http://127.0.0.1:*",
].join('; ')

/** 允许服务的扩展名 → Content-Type。表外的一律 403（协议不是通用文件服务器）。 */
const MIME_BY_EXT = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
}

/**
 * `.opennote/` 下**允许**服务的子目录。
 *
 * 这个目录里不是只有用户内容：`.opennote/sync.json` 存着 E2EE 的 `did ↔ 路径` 映射
 * （`src/sync/state.ts`：明确要求「绝不能跨端」），`github.json` 存远端配置，
 * `state.json` 存星标与显示名。这些一旦能被页面 fetch 到，沙箱就白做了。
 *
 * 但**不能整个目录一律拒绝**：回收站与历史快照里放的是用户自己的页面
 * （`library.ts` 的注释写明「回收站其实也就只是一个普通的目录」），
 * 拒绝它们等于「页面进了回收站就再也看不了」。所以按子树白名单：
 * `trash` / `history` 放行，其余一切拒绝。
 */
const ALLOWED_META_SUBDIRS = new Set(['trash', 'history'])

/** 工作区相对路径 → URL 路径（逐段编码，保留分隔符）。 */
function encodePathForUrl(relPath) {
  return String(relPath || '')
    .replace(/\\/g, '/')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
}

/**
 * 工作区相对路径 → 协议 URL。
 *
 * 调用方传的是**页面 id**（= 工作区相对路径，与 `Note.id` 同一方言），
 * 例如 `原型/登录页.html` → `opennote-page://page/%E5%8E%9F%E5%9E%8B/...`。
 */
function pageUrlFor(relPath) {
  const encoded = encodePathForUrl(relPath)
  if (!encoded) throw new Error('页面路径为空')
  return PAGE_SCHEME + '://' + PAGE_HOST + '/' + encoded
}

/**
 * 判断一条工作区相对路径准不准被协议服务。
 *
 * @param {string} relPath 已归一（POSIX 分隔符、无 ..、无空段）
 * @returns {{ ok: true, kind: 'page' | 'asset' } | { ok: false, reason: string }}
 */
function classifyServablePath(relPath) {
  const segments = String(relPath || '').split('/').filter((segment) => segment !== '')
  if (segments.length === 0) return { ok: false, reason: '空路径' }
  for (const segment of segments) {
    if (segment === '..' || segment === '.') return { ok: false, reason: '路径越界' }
    if (segment.includes('\0')) return { ok: false, reason: '路径包含非法字符' }
    if (segment.includes(':')) return { ok: false, reason: '路径包含冒号' }
  }
  const fileName = segments[segments.length - 1]
  const dot = fileName.lastIndexOf('.')
  // 开头就是点的名字没有扩展名（与 shared/paths.ts 的 extName 同一语义）
  const ext = dot <= 0 ? '' : fileName.slice(dot).toLowerCase()
  const mime = MIME_BY_EXT[ext]
  if (!mime) return { ok: false, reason: '不服务这种文件类型：' + (ext || '(无扩展名)') }

  if (segments[0] === '.opennote') {
    const sub = segments[1]
    if (!sub || !ALLOWED_META_SUBDIRS.has(sub)) {
      return { ok: false, reason: '笔记本元数据目录不对页面开放' }
    }
    // 子树里也拒绝 JSON：trash / history 里不会有我们自己的账本，但保留这条兜网。
    if (ext === '.json') return { ok: false, reason: '笔记本元数据文件不对页面开放' }
    return { ok: true, kind: ext === '.html' || ext === '.htm' ? 'page' : 'asset' }
  }

  return { ok: true, kind: ext === '.html' || ext === '.htm' ? 'page' : 'asset' }
}

/**
 * 协议请求 → 工作区相对路径。
 *
 * @param {string} rawUrl 形如 `opennote-page://page/%E5%8E%9F...`
 * @returns {{ ok: true, path: string, kind: 'page' | 'asset' } | { ok: false, reason: string, status: number }}
 */
function resolvePageRequest(rawUrl) {
  let url
  try {
    url = new URL(String(rawUrl || ''))
  } catch {
    return { ok: false, reason: 'URL 语法错误', status: 400 }
  }
  if (url.protocol !== PAGE_SCHEME + ':') return { ok: false, reason: '协议不符', status: 400 }
  if (url.hostname !== PAGE_HOST) return { ok: false, reason: '主机不符', status: 400 }

  // 逐段解码：%2F **不**当作分隔符（先按 / 切再解码），否则编码后的斜杠会被当成路径层级。
  const rawSegments = url.pathname.split('/').filter((segment) => segment !== '')
  const segments = []
  for (const raw of rawSegments) {
    let decoded
    try {
      decoded = decodeURIComponent(raw)
    } catch {
      return { ok: false, reason: '路径编码非法', status: 400 }
    }
    // 解码之后才出现分隔符 ⇒「编码过的分隔符」，一律拒绝（路径混淆的经典入口）。
    if (decoded.includes('/') || decoded.includes('\\')) {
      return { ok: false, reason: '路径包含编码后的分隔符', status: 400 }
    }
    segments.push(decoded)
  }
  const relPath = segments.join('/')
  const verdict = classifyServablePath(relPath)
  if (!verdict.ok) return { ok: false, reason: verdict.reason, status: 403 }
  return { ok: true, path: relPath, kind: verdict.kind }
}

/** 扩展名 → Content-Type（表外返回 application/octet-stream，由调用方决定是否已经拒过）。 */
function contentTypeFor(relPath) {
  const name = String(relPath || '')
  const dot = name.lastIndexOf('.')
  const ext = dot <= 0 ? '' : name.slice(dot).toLowerCase()
  return MIME_BY_EXT[ext] || 'application/octet-stream'
}

module.exports = {
  PAGE_SCHEME,
  PAGE_HOST,
  PAGE_CSP,
  ALLOWED_META_SUBDIRS,
  MIME_BY_EXT,
  pageUrlFor,
  encodePathForUrl,
  classifyServablePath,
  resolvePageRequest,
  contentTypeFor,
}
