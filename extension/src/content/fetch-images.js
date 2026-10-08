/**
 * ③ 图片下载开关 · **页面侧字节抓取**（自包含注入函数，纪律同 `content/extract-page.js`）。
 *
 * 为什么必须在页面里抓：`host_permissions` 按契约只有 127.0.0.1 的 10 条（红线，不许加），
 * background 的 fetch 对任意网站**必然**跨站失败 —— 这就是「图片一起保存」从来不生效的根因
 * （用户实测：勾了开关，一张图都没落盘）。内容脚本跑在**页面自己的源**上：
 * 同源图片直接可取；带 CORS 头的跨域图也能取；其余的如实降级
 * （正文保留原始网址 + 逐条 `warnings`），与 ③ 一直以来的降级口径完全一致。
 *
 * 输出是 `02 §2.5` 唯一合法的内联形状所需的原料：`{ url, ok, base64, byteLength, mime }`，
 * 最终的 `assets[]` 组装与**全部上限判定**在 `lib/assets.js` 的
 * `collectImageAssetsFromPage()`（那里是唯一产地，这里只管把字节拿回来）。
 *
 * 自包含红线：函数体里**不得引用任何模块作用域标识符**（`tests/self-contained.test.mjs`
 * 机械化校验顶层声明数 = 1），所以魔数嗅探、base64 编码、上限数字都在函数体内
 * 有一份**逐字对齐**的拷贝 —— 改上限必须两边同步（与 `inpage-bridge.js` 重复常量同一待遇）。
 */

/**
 * @param {{items:Array<{url:string}>, timeoutMs?:number, overallMs?:number,
 *          maxBytes?:number, totalMaxBytes?:number, limit?:number}} options
 * @returns {Promise<Array<{url:string, ok:boolean, base64?:string, byteLength?:number,
 *          mime?:string|null, error?:string}>>}
 */
export async function fetchImagesInPage(options) {
  const opts = options || {};
  const items = Array.isArray(opts.items) ? opts.items : [];
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  const overallMs = Number(opts.overallMs) > 0 ? Number(opts.overallMs) : 20000;
  const maxBytes = Number(opts.maxBytes) > 0 ? Number(opts.maxBytes) : 8 * 1024 * 1024;
  const totalMaxBytes =
    Number(opts.totalMaxBytes) > 0 ? Number(opts.totalMaxBytes) : 6 * 1024 * 1024;
  const limit = Number(opts.limit) > 0 ? Number(opts.limit) : 32;
  /* 与 lib/assets.js 的 MIME_WHITELIST 逐字一致（自包含拷贝，理由见文件头）。 */
  const WHITELIST = [
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/svg+xml",
    "image/bmp",
  ];
  /* 与 lib/assets.js 的 sniffMime 同一份口径（自包含拷贝）。 */
  function sniff(bytes) {
    const head = bytes.subarray(0, 16);
    const ascii = (start, length) =>
      String.fromCharCode.apply(null, head.subarray(start, start + length));
    if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)
      return "image/png";
    if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
    if (head.length >= 4 && ascii(0, 4) === "GIF8") return "image/gif";
    if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
    if (head.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
    if (head.length >= 12 && ascii(4, 4) === "ftyp" && /avif|avis/.test(ascii(8, 4))) return "image/avif";
    const text = String.fromCharCode.apply(null, bytes.subarray(0, 512)).trimStart();
    if (/^<(\?xml|svg)/i.test(text) && /<svg[\s>]/i.test(text)) return "image/svg+xml";
    return null;
  }
  /* Uint8Array → 标准 base64（分块，避免大数组压爆调用栈）；与 lib/assets.js base64Of 一致。 */
  function toBase64(bytes) {
    const CHUNK = 0x8000;
    let binary = "";
    for (let index = 0; index < bytes.length; index += CHUNK) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
    }
    return btoa(binary);
  }
  const results = [];
  let total = 0;
  const deadline = Date.now() + overallMs;
  for (const item of items) {
    const url = item && typeof item.url === "string" ? item.url : "";
    if (!url) {
      results.push({ url: "", ok: false, error: "没有可下载的地址" });
      continue;
    }
    if (results.length >= limit) {
      results.push({ url, ok: false, error: "超出件数上限" });
      continue;
    }
    if (total >= totalMaxBytes) {
      results.push({ url, ok: false, error: "合计太大" });
      continue;
    }
    if (Date.now() >= deadline) {
      results.push({ url, ok: false, error: "下载超时" });
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
      if (!response || !response.ok) {
        results.push({ url, ok: false, error: response ? `服务器返回 ${response.status}` : "无响应" });
        continue;
      }
      const declared = Number(
        response.headers && response.headers.get ? response.headers.get("content-length") : 0,
      );
      if (declared && declared > maxBytes) {
        results.push({ url, ok: false, error: "超过 8 MiB" });
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        results.push({ url, ok: false, error: "超过 8 MiB" });
        continue;
      }
      if (total + bytes.length > totalMaxBytes) {
        results.push({ url, ok: false, error: "合计太大" });
        continue;
      }
      const headerMime = response.headers && response.headers.get ? response.headers.get("content-type") : null;
      const headerOnly = String(headerMime || "").split(";")[0].trim().toLowerCase();
      const mime = sniff(bytes) || (WHITELIST.includes(headerOnly) ? headerOnly : null);
      results.push({ url, ok: true, base64: toBase64(bytes), byteLength: bytes.length, mime });
      total += bytes.length;
    } catch (error) {
      const name = (error && error.name) || "";
      results.push({ url, ok: false, error: name === "AbortError" ? "下载超时" : "没有权限、跨站限制或网络不可达" });
    } finally {
      clearTimeout(timer);
    }
  }
  return results;
}
