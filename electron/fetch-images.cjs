'use strict'

/**
 * 剪藏图片的**主进程下载器**（0.4.0）。
 *
 * 为什么必须由主进程下：桌面 CSP 是 `img-src 'self' file: data: blob:` —— 远程图片
 * 在界面里根本加载不了；而扩展侧（MV3）的 host_permissions 只有 127.0.0.1 的十条，
 * 跨域图（绝大多数文章配图都在 CDN 上）拿不到字节。主进程没有这两道限制，
 * 这是唯一能把「图片一起保存」真正做成的层。
 *
 * 安全与成本（全部在这里收口，调用方不必再验）：
 *   - 只接受 http(s)，只走 http 80 / https 443；
 *   - 每一跳都用 `dns.lookup({all:true})` 解析，所有地址都必须是公网单播地址；
 *     连接时把解析结果钉死给 `lookup`，避免 DNS 重绑定到私网；
 *   - 手动跟随最多 5 次重定向，每一跳重新解析并校验，不允许 https 降级到 http；
 *   - 拒绝 loopback、私网、链路本地、ULA、保留/文档/组播地址和云元数据地址；
 *   - 单张 ≤ 8 MiB、合计 ≤ 24 MiB、最多 32 张、每张 8 秒超时；
 *   - MIME 按**字节魔数**判定，白名单之外一律不算图片；
 *   - 返回形状与扩展侧 `content/fetch-images.js` 一致（`{url, ok, base64, byteLength, mime, error}`），
 *     应用侧只有一套组装逻辑。
 *
 * `lookupImpl` / `requestImpl` 可注入，便于在 node 里逐条验证地址、重定向、超时和响应上限。
 */

const dns = require('node:dns')
const http = require('node:http')
const https = require('node:https')
const net = require('node:net')

const MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp']
const MAX_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_ITEMS = 32
const TIMEOUT_MS = 8000
const MAX_REDIRECTS = 5

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

class ImageDownloadError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ImageDownloadError'
  }
}

/** 与扩展侧 `lib/assets.js` 的 sniffMime 同一份口径（字节魔数优先，不信任 Content-Type）。 */
function sniffMime(bytes) {
  const head = bytes.subarray(0, 16)
  const ascii = (start, length) => String.fromCharCode.apply(null, head.subarray(start, start + length))
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return 'image/png'
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg'
  if (head.length >= 4 && ascii(0, 4) === 'GIF8') return 'image/gif'
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp'
  if (head.length >= 2 && ascii(0, 2) === 'BM') return 'image/bmp'
  if (head.length >= 12 && ascii(4, 4) === 'ftyp' && /avif|avis/.test(ascii(8, 4))) return 'image/avif'
  const text = String.fromCharCode.apply(null, bytes.subarray(0, 512)).trimStart()
  if (/^<(\?xml|svg)/i.test(text) && /<svg[\s>]/i.test(text)) return 'image/svg+xml'
  return null
}

/** 主进程取图时带的请求头：浏览器的 UA + 来源页 Referer（不少 CDN 按这两个头放行）。 */
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

function ipv4ToInt(address) {
  const parts = address.split('.')
  if (parts.length !== 4) return null
  let value = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null
    const octet = Number(part)
    if (octet > 255) return null
    value = value * 256 + octet
  }
  return value >>> 0
}

function ipv4InPrefix(value, base, prefix) {
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return ((value & mask) >>> 0) === ((base & mask) >>> 0)
}

function ipv4FromInt(value) {
  const number = Number(value)
  return `${(number >>> 24) & 0xff}.${(number >>> 16) & 0xff}.${(number >>> 8) & 0xff}.${number & 0xff}`
}

/**
 * 非公网 IPv4。除私网/回环/链路本地外，也拒绝文档、基准测试、组播与保留段：
 * 这些都是「解析成功了，但不应该被用户提供的 URL 访问」的地址。
 */
const NON_PUBLIC_IPV4 = [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.31.196.0', 24],
  ['192.52.193.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['192.175.48.0', 24],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
].map(([base, prefix]) => [ipv4ToInt(base), prefix])

function isPublicIpv4(address) {
  const value = ipv4ToInt(address)
  if (value === null) return false
  return !NON_PUBLIC_IPV4.some(([base, prefix]) => ipv4InPrefix(value, base, prefix))
}

function ipv6ToBigInt(address) {
  let text = address.toLowerCase()
  if (text.includes('%')) return null
  if (text.includes('.')) {
    const lastColon = text.lastIndexOf(':')
    if (lastColon < 0) return null
    const tail = ipv4ToInt(text.slice(lastColon + 1))
    if (tail === null) return null
    text = `${text.slice(0, lastColon + 1)}${Math.floor(tail / 65536).toString(16)}:${(tail % 65536).toString(16)}`
  }

  const sides = text.split('::')
  if (sides.length > 2) return null
  const left = sides[0] ? sides[0].split(':') : []
  const right = sides.length === 2 && sides[1] ? sides[1].split(':') : []
  let parts
  if (sides.length === 1) {
    parts = left
  } else {
    const missing = 8 - left.length - right.length
    if (missing < 1) return null
    parts = [...left, ...Array(missing).fill('0'), ...right]
  }
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null

  let value = 0n
  for (const part of parts) value = (value << 16n) + BigInt(parseInt(part, 16))
  return value
}

function ipv6InPrefix(value, base, prefix) {
  const shift = BigInt(128 - prefix)
  return value >> shift === base >> shift
}

const IPV4_MAPPED_PREFIX = ipv6ToBigInt('::ffff:0:0')
const PUBLIC_IPV6_PREFIX = ipv6ToBigInt('2000::')
const NON_PUBLIC_IPV6 = [
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['2620:4f:8000::', 48],
  ['3fff::', 20],
].map(([base, prefix]) => [ipv6ToBigInt(base), prefix])

/**
 * IPv6 只放行全球单播 `2000::/3`，再排除 IANA 的特殊用途段。
 * IPv4-mapped 地址按内嵌的 IPv4 再判一次；NAT64 与 6to4 整体拒绝，
 * 避免它们把私网 IPv4 藏在一个看起来正常的 IPv6 后面。
 */
function isPublicIpv6(address) {
  const value = ipv6ToBigInt(address)
  if (value === null) return false

  if (value >> 32n === IPV4_MAPPED_PREFIX >> 32n) {
    return isPublicIpv4(ipv4FromInt(value & 0xffffffffn))
  }

  // ::/96（IPv4-compatible）早已废弃；::1 和 :: 也在这段里，直接拒绝。
  if (value >> 32n === 0n) return false

  // NAT64 的 well-known / local-use 前缀都不应成为访问私网 IPv4 的跳板。
  if (ipv6InPrefix(value, ipv6ToBigInt('64:ff9b::'), 32)) return false
  if (!ipv6InPrefix(value, PUBLIC_IPV6_PREFIX, 3)) return false
  return !NON_PUBLIC_IPV6.some(([base, prefix]) => ipv6InPrefix(value, base, prefix))
}

function isPublicIp(address) {
  const family = net.isIP(address)
  if (family === 4) return isPublicIpv4(address)
  if (family === 6) return isPublicIpv6(address)
  return false
}

function isBlockedHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/\.$/, '')
  return (
    normalized === 'localhost' ||
    normalized.endsWith('.localhost') ||
    normalized === 'local' ||
    normalized.endsWith('.local') ||
    normalized === 'internal' ||
    normalized.endsWith('.internal') ||
    normalized === 'home.arpa' ||
    normalized.endsWith('.home.arpa')
  )
}

function normalizedReferer(value) {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

function pinnedLookup(pinned) {
  return (_hostname, options, callback) => {
    const done = typeof options === 'function' ? options : callback
    if (typeof done !== 'function') return
    if (options && typeof options === 'object' && options.all) {
      done(null, [{ address: pinned.address, family: pinned.family }])
      return
    }
    done(null, pinned.address, pinned.family)
  }
}

/**
 * 解析并校验一个目标。IP 字面量不走 DNS；域名必须解析成功，且**每一条**记录都在公网。
 * 返回第一条地址供连接使用；所有记录都已验过，所以任何一条都不会把连接导向私网。
 */
async function resolveTarget(rawUrl, lookupImpl) {
  let url
  try {
    url = new URL(rawUrl)
  } catch {
    throw new ImageDownloadError('地址无效')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ImageDownloadError('只下载 http(s) 图片')
  }
  if (url.username || url.password) throw new ImageDownloadError('地址不能包含账号密码')
  // WHATWG URL 会把显式默认端口（http:80 / https:443）规范成空串；
  // 其余端口一律拒绝，避免把通道变成任意端口的探测器。
  if (url.port) throw new ImageDownloadError('只允许 http 80 / https 443 端口')
  url.hash = ''

  const hostname = (url.hostname.startsWith('[') && url.hostname.endsWith(']')
    ? url.hostname.slice(1, -1)
    : url.hostname
  ).toLowerCase()
  if (!hostname || hostname.includes('%')) throw new ImageDownloadError('地址无效')

  const literalFamily = net.isIP(hostname)
  if (literalFamily) {
    if (!isPublicIp(hostname)) throw new ImageDownloadError('只允许访问公网地址')
    return { url, address: { address: hostname, family: literalFamily } }
  }

  const dnsName = hostname.replace(/\.$/, '')
  if (isBlockedHostname(dnsName) || !dnsName.includes('.')) {
    throw new ImageDownloadError('只允许访问公网地址')
  }

  let records
  try {
    records = await lookupImpl(dnsName, { all: true, verbatim: true })
  } catch {
    throw new ImageDownloadError('域名解析失败')
  }
  if (!Array.isArray(records)) records = records ? [records] : []
  if (records.length === 0) throw new ImageDownloadError('域名解析失败')

  let chosen = null
  for (const record of records) {
    const address = typeof record === 'string' ? record : record && record.address
    if (typeof address !== 'string' || !isPublicIp(address)) {
      throw new ImageDownloadError('只允许访问公网地址')
    }
    if (!chosen) chosen = { address, family: net.isIP(address) }
  }
  return { url, address: chosen }
}

function requestOnce(url, address, headers, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) {
      const error = new Error('aborted')
      error.name = 'AbortError'
      reject(error)
      return
    }

    const transport = url.protocol === 'https:' ? https : http
    const request = transport.request(
      url,
      {
        method: 'GET',
        headers,
        agent: false,
        signal,
        lookup: pinnedLookup(address),
      },
      (response) => {
        resolve({
          status: Number(response.statusCode) || 0,
          headers: response.headers || {},
          stream: response,
        })
      },
    )
    request.once('error', reject)
    request.end()
  })
}

function readBodyCapped(stream, maxBytes, sizeLabel, signal) {
  return new Promise((resolve, reject) => {
    if (!stream || typeof stream.on !== 'function') {
      reject(new ImageDownloadError('无响应'))
      return
    }

    const chunks = []
    let size = 0
    let settled = false

    const cleanup = () => {
      if (signal) signal.removeEventListener('abort', onAbort)
    }
    const settle = (fn, value) => {
      if (settled) return
      settled = true
      cleanup()
      fn(value)
    }
    const destroyStream = () => {
      if (typeof stream.destroy === 'function') stream.destroy()
      else if (typeof stream.resume === 'function') stream.resume()
    }
    const onAbort = () => {
      const error = new Error('aborted')
      error.name = 'AbortError'
      settle(reject, error)
      destroyStream()
    }
    const onData = (chunk) => {
      if (settled) return
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > maxBytes) {
        settle(reject, new ImageDownloadError(`超过 ${sizeLabel}`))
        destroyStream()
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => settle(resolve, Buffer.concat(chunks, size))
    const onError = (error) => settle(reject, error)
    const onClose = () => {
      if (!settled) settle(reject, new ImageDownloadError('网络不可达'))
    }

    if (signal && signal.aborted) {
      onAbort()
      return
    }
    if (signal) signal.addEventListener('abort', onAbort, { once: true })
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.once('close', onClose)
  })
}

function discardResponse(response) {
  const stream = response && response.stream
  if (!stream) return
  if (typeof stream.destroy === 'function') stream.destroy()
  else if (typeof stream.resume === 'function') stream.resume()
}

function headerValue(headers, name) {
  if (!headers) return null
  let value = headers[name.toLowerCase()]
  if (value === undefined) value = headers[name]
  if (Array.isArray(value)) value = value[0]
  return typeof value === 'string' ? value.trim() : null
}

function contentLength(headers) {
  const raw = headerValue(headers, 'content-length')
  if (raw === null || raw === '') return null
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

async function downloadOne(rawUrl, headers, settings, signal) {
  let target = await resolveTarget(rawUrl, settings.lookupImpl)
  let redirects = 0

  for (;;) {
    const response = await settings.requestImpl(target.url, target.address, headers, signal)
    const status = Number(response && response.status)
    if (!Number.isInteger(status) || status <= 0) throw new ImageDownloadError('无响应')

    if (REDIRECT_STATUSES.has(status)) {
      const location = headerValue(response.headers, 'location')
      discardResponse(response)
      if (!location) throw new ImageDownloadError(`服务器返回 ${status}，但没有重定向地址`)
      if (redirects >= MAX_REDIRECTS) throw new ImageDownloadError(`重定向超过 ${MAX_REDIRECTS} 次`)

      let nextRaw
      try {
        nextRaw = new URL(location, target.url).toString()
      } catch {
        throw new ImageDownloadError('重定向地址无效')
      }
      const next = await resolveTarget(nextRaw, settings.lookupImpl)
      if (target.url.protocol === 'https:' && next.url.protocol === 'http:') {
        throw new ImageDownloadError('不允许从 https 重定向到 http')
      }
      target = next
      redirects += 1
      continue
    }

    if (status < 200 || status >= 300) {
      discardResponse(response)
      throw new ImageDownloadError(`服务器返回 ${status}`)
    }

    const declared = contentLength(response.headers)
    if (declared !== null && declared > settings.maxBytes) {
      discardResponse(response)
      throw new ImageDownloadError(`超过 ${settings.sizeLabel}`)
    }

    const bytes = await readBodyCapped(response.stream, settings.maxBytes, settings.sizeLabel, signal)
    if (settings.total + bytes.length > settings.totalMaxBytes) {
      throw new ImageDownloadError('合计太大')
    }
    const mime = sniffMime(bytes)
    if (!mime || !MIME_WHITELIST.includes(mime)) {
      throw new ImageDownloadError('不是支持的图片格式')
    }
    return { bytes, mime }
  }
}

function downloadErrorMessage(error, signal) {
  if ((signal && signal.aborted) || (error && error.name === 'AbortError')) return '下载超时'
  if (error instanceof ImageDownloadError) return error.message
  if (error && (error.code === 'ENOTFOUND' || error.code === 'EAI_AGAIN')) return '域名解析失败'
  return '网络不可达'
}

/** 下载一批图片（顺序执行：拿网页图片不是吞吐场景，顺序能让上限判定简单且可断言）。 */
async function downloadImages(options = {}) {
  const {
    lookupImpl = (hostname, lookupOptions) => dns.promises.lookup(hostname, lookupOptions),
    requestImpl = requestOnce,
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    totalMaxBytes = MAX_TOTAL_BYTES,
    limit = MAX_ITEMS,
    referer = null,
  } = options

  const urls = Array.isArray(options.urls) ? options.urls : []
  const results = []
  const sizeLabel = `${Math.round(maxBytes / 1024 / 1024)} MiB`
  const headers = {
    accept: 'image/avif,image/webp,image/*,*/*;q=0.8',
    'accept-encoding': 'identity',
    'user-agent': BROWSER_UA,
  }
  const normalized = normalizedReferer(referer)
  if (normalized) headers.referer = normalized

  let total = 0
  for (const raw of urls) {
    const url = typeof raw === 'string' ? raw : ''
    if (!url) {
      results.push({ url: '', ok: false, error: '没有可下载的地址' })
      continue
    }
    if (!/^https?:\/\//i.test(url)) {
      results.push({ url, ok: false, error: '只下载 http(s) 图片' })
      continue
    }
    if (results.length >= limit) {
      results.push({ url, ok: false, error: '超出件数上限' })
      continue
    }
    if (total >= totalMaxBytes) {
      results.push({ url, ok: false, error: '合计太大' })
      continue
    }
    if (typeof lookupImpl !== 'function' || typeof requestImpl !== 'function') {
      results.push({ url, ok: false, error: '本机没有可用的下载能力' })
      continue
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const { bytes, mime } = await downloadOne(
        url,
        headers,
        {
          lookupImpl,
          requestImpl,
          maxBytes,
          totalMaxBytes,
          sizeLabel,
          total,
        },
        controller.signal,
      )
      total += bytes.length
      results.push({
        url,
        ok: true,
        base64: Buffer.from(bytes).toString('base64'),
        byteLength: bytes.length,
        mime,
      })
    } catch (error) {
      results.push({ url, ok: false, error: downloadErrorMessage(error, controller.signal) })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

module.exports = {
  downloadImages,
  requestOnce,
  sniffMime,
  isPublicIp,
  MIME_WHITELIST,
  MAX_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ITEMS,
  MAX_REDIRECTS,
  TIMEOUT_MS,
}
