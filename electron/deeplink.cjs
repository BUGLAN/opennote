'use strict'

/**
 * `opennote://` 深链解析（00 号 §6.14㉛ / 02 号 §5.6）。
 *
 * **为什么单独一个模块**：`electron/main.cjs` 依赖 Electron，没法在 vitest 里
 * 直接 require；把解析做成零依赖的纯函数，就能用真单测钉住路由与拒绝规则
 * ——这正是 0.2.0 栽过的那类跟头（`getWorkspaceInfo` 漏传、`bridgeStatusPayload`
 * 截断字段：两侧各自单测都绿，断在中间的缝）。
 *
 * 本次实现的只有两条**只读**路由：
 *   API-11  `opennote://settings/import`   打开「设置 · 文件 · 导入与接口」（02 号定为 P0）
 *   API-12  `opennote://open?path=<工作区相对路径>`  打开一篇笔记
 * **明确不做** API-09 `opennote://clip?d=…`（用户已确认「Opennote 需要打开」，
 * 剪藏主路径仍是本地桥；且它到达前必须先出确认弹窗，属独立工作量）。
 * 未实现的路由**必须明确报「暂不支持」**，绝不静默无反应（§6.14㉛）。
 */

const PROTOCOL = 'opennote'

/** 主进程 → 渲染层的深链频道（preload 用 `onDeepLink(cb)` 订阅，arity 1）。 */
const DEEPLINK_CHANNEL = 'opennote:app:deeplink'

/** 与 02 号 §5.6 一致：只认这两条路由，其余一律显式拒绝。 */
const SETTINGS_ROUTES = new Set(['settings', 'settings/import'])

/**
 * 工作区相对路径的合法性。规则与 `src/fs/paths.ts` 的 `assertSafeRelative`
 * 同源（这里再实现一遍是为了让纯函数可单测；`main.cjs` 落到磁盘前**仍必须**
 * 再走一次真正的授权根校验，两层都过才允许读文件）。
 */
function isSafeRelativePath(value) {
  if (typeof value !== 'string') return false
  // **不做 trim 归一**：`"a.md "` 与 `"a.md"` 必须被区别对待。静默 trim 会让
  // 两个拼写指向同一个文件（路径混淆），而且会让下面的「尾随空格」检查变成
  // 死代码 —— 早先的实现正是如此，被单测抓出来了。
  if (value !== value.trim()) return false
  const raw = value
  if (raw === '') return false
  if (raw.length > 1024) return false
  // 反斜杠在 URL 里是合法字符，但工作区相对路径统一用 POSIX 分隔符。
  const normalized = raw.replace(/\\/g, '/')
  if (normalized.startsWith('/')) return false
  if (/^[A-Za-z]:/.test(normalized)) return false
  if (normalized.includes('\0')) return false
  const segments = normalized.split('/')
  for (const segment of segments) {
    if (segment === '') return false // 空段（`a//b`）与尾随斜杠都拒绝
    if (segment === '.' || segment === '..') return false
    // Windows 保留字符，且不许出现盘符式冒号
    if (/[<>:"|?*]/.test(segment)) return false
    if (segment.endsWith(' ')) return false
    if (segment.endsWith('.')) return false
  }
  return true
}

/**
 * 解析一个 `opennote://` URL。
 *
 * @param {unknown} raw
 * @returns {{ok: true, kind: 'settings', section: 'import'}
 *          | {ok: true, kind: 'open', path: string}
 *          | {ok: false, reason: 'unsupported', route: string}
 *          | {ok: false, reason: 'invalid', detail: string, route: string}}
 */
function parseOpennoteUrl(raw) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'invalid', detail: '空链接', route: '' }
  }
  const text = raw.trim()
  if (!text.toLowerCase().startsWith(`${PROTOCOL}://`)) {
    return { ok: false, reason: 'invalid', detail: '不是 opennote:// 链接', route: '' }
  }

  let url
  try {
    url = new URL(text)
  } catch {
    return { ok: false, reason: 'invalid', detail: 'URL 语法错误', route: '' }
  }
  if (url.protocol !== `${PROTOCOL}:`) {
    return { ok: false, reason: 'invalid', detail: '协议不是 opennote', route: '' }
  }

  // `opennote://settings/import` 的 host 是 `settings`、pathname 是 `/import`；
  // 小写归一，避免 `OpenNote://SETTINGS/Import` 绕过匹配。
  const host = url.hostname.toLowerCase()
  const rest = url.pathname.replace(/^\/+/, '').replace(/\/+$/, '').toLowerCase()
  const route = rest === '' ? host : `${host}/${rest}`

  if (SETTINGS_ROUTES.has(route)) {
    return { ok: true, kind: 'settings', section: 'import' }
  }

  if (route === 'open') {
    const path = url.searchParams.get('path')
    if (path === null || path === '') {
      return { ok: false, reason: 'invalid', detail: '缺少 path 参数', route }
    }
    if (!isSafeRelativePath(path)) {
      return { ok: false, reason: 'invalid', detail: 'path 不是合法的工作区相对路径', route }
    }
    // 归一成 POSIX 相对路径再交给上层。**不 trim** —— 上面的校验已经拒绝了两端
    // 带空白的值，这里再 trim 就等于把校验悄悄取消掉。
    return { ok: true, kind: 'open', path: path.replace(/\\/g, '/') }
  }

  return { ok: false, reason: 'unsupported', route }
}

/** 未实现路由 / 非法链接时给用户看的中文文案（无 emoji，逐字冻结在这里）。 */
const DEEPLINK_MESSAGES = {
  unsupported: '这个链接暂不支持。剪藏请用浏览器插件里的「剪藏到 Opennote」，或直接打开 Opennote。',
  invalid: '这个链接不完整或格式不对，Opennote 无法打开它。',
}

function deeplinkMessage(result) {
  if (!result || result.ok) return ''
  return DEEPLINK_MESSAGES[result.reason] ?? DEEPLINK_MESSAGES.invalid
}

/** 从 argv 里挑出第一个 `opennote://` 参数（Windows / Linux 走这条路）。 */
function findDeeplinkInArgv(argv) {
  if (!Array.isArray(argv)) return null
  for (const item of argv) {
    if (typeof item === 'string' && item.toLowerCase().startsWith(`${PROTOCOL}://`)) return item
  }
  return null
}

module.exports = {
  PROTOCOL,
  DEEPLINK_CHANNEL,
  DEEPLINK_MESSAGES,
  deeplinkMessage,
  findDeeplinkInArgv,
  isSafeRelativePath,
  parseOpennoteUrl,
}
