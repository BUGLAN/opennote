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
 *   - 只接受 `http(s)`；
 *   - 单张 ≤ 8 MiB、合计 ≤ 24 MiB、最多 32 张、每张 8 秒超时（AbortController）；
 *   - MIME 按**字节魔数**判定，白名单之外一律不算图片；
 *   - 返回形状与扩展侧 `content/fetch-images.js` 一致（`{url, ok, base64, byteLength, mime, error}`），
 *     应用侧只有一套组装逻辑。
 *
 * 纯函数 + 注入 `fetchImpl`：可以在 node 里用真回环服务端把成功/超时/非图片/超大逐条验。
 */

const MIME_WHITELIST = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif', 'image/svg+xml', 'image/bmp']
const MAX_BYTES = 8 * 1024 * 1024
const MAX_TOTAL_BYTES = 24 * 1024 * 1024
const MAX_ITEMS = 32
const TIMEOUT_MS = 8000

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

/** 下载一批图片（顺序执行：拿网页图片不是吞吐场景，顺序能让上限判定简单且可断言）。 */
async function downloadImages(options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = TIMEOUT_MS,
    maxBytes = MAX_BYTES,
    totalMaxBytes = MAX_TOTAL_BYTES,
    limit = MAX_ITEMS,
    referer = null,
  } = options
  const urls = Array.isArray(options.urls) ? options.urls : []
  const results = []
  let total = 0
  const sizeLabel = `${Math.round(maxBytes / 1024 / 1024)} MiB`
  const headers = { accept: 'image/avif,image/webp,image/*,*/*;q=0.8', 'user-agent': BROWSER_UA }
  // Referer 只认 http(s) 的来源页（用户在剪哪一页，就自称从哪一页来）。
  if (typeof referer === 'string' && /^https?:\/\//i.test(referer)) headers.referer = referer
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
    if (typeof fetchImpl !== 'function') {
      results.push({ url, ok: false, error: '本机没有可用的下载能力' })
      continue
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        redirect: 'follow',
        headers,
      })
      if (!response || !response.ok) {
        results.push({ url, ok: false, error: response ? `服务器返回 ${response.status}` : '无响应' })
        continue
      }
      const declared = Number(response.headers && response.headers.get ? response.headers.get('content-length') : 0)
      if (declared && declared > maxBytes) {
        results.push({ url, ok: false, error: `超过 ${sizeLabel}` })
        continue
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.length > maxBytes) {
        results.push({ url, ok: false, error: `超过 ${sizeLabel}` })
        continue
      }
      if (total + bytes.length > totalMaxBytes) {
        results.push({ url, ok: false, error: '合计太大' })
        continue
      }
      const mime = sniffMime(bytes)
      if (!mime || !MIME_WHITELIST.includes(mime)) {
        results.push({ url, ok: false, error: '不是支持的图片格式' })
        continue
      }
      total += bytes.length
      results.push({
        url,
        ok: true,
        base64: Buffer.from(bytes).toString('base64'),
        byteLength: bytes.length,
        mime,
      })
    } catch (error) {
      const name = (error && error.name) || ''
      results.push({ url, ok: false, error: name === 'AbortError' ? '下载超时' : '网络不可达' })
    } finally {
      clearTimeout(timer)
    }
  }
  return results
}

module.exports = {
  downloadImages,
  sniffMime,
  MIME_WHITELIST,
  MAX_BYTES,
  MAX_TOTAL_BYTES,
  MAX_ITEMS,
  TIMEOUT_MS,
}
