/**
 * ③ 图片下载开关（插件侧）· **字节层**。
 *
 * 为什么必须是「字节」而不是「网址」：`assets[]` 的元素形状由 02 §2.5 冻结 ——
 * `{ name, mime, dataBase64 | file }`。扩展只能产出**内联**形态（`file` 是通道级扩展、
 * 指工作区相对路径，扩展没有工作区），所以：
 *
 *   **有字节才发**：`{ name, mime, dataBase64 }`（`dataBase64` 是纯 base64，不带 `data:` 前缀）；
 *   **拿不到字节就降级**：这一条**不进 `assets[]`**，正文里的原始 URL **原样保留**，
 *   并把原因如实写进 `warnings[]`（不许把 `{url, alt}` 这种信封里不存在的形状发出去 ——
 *   桥会直接 422 `IMP-4003 detail.field = "assets[0].name"`，用户看到的会是一句「字段不合法」
 *   且不打开页面，恰好违反 ③ 的降级口径）。
 *
 * 权限事实（决定了「降级是常态」）：`host_permissions` 只有 127.0.0.1 的 10 条；
 * `activeTab` 只给**当前标签所在源**的临时权限 ⇒ 第三方 CDN 上的图**大概率拿不到字节**。
 * 那是**预期内的降级**，不是要靠加权限去修的缺陷（红线：不新增权限、零依赖、新增令牌 0）。
 *
 * 纯函数 + 注入 fetch：所以「下载成功 / 各类失败降级」都能在 node 里用真回环服务端验。
 */

/** 02 §2.2：单件解码后 ≤ 8 MiB。 */
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
/**
 * 02 §2.5 的 MIME 白名单（与桥同一份口径；SVG 的净化是应用侧的事，见 02 §7.2）。
 */
export const MIME_WHITELIST = Object.freeze([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
]);
/** 02 §2.2：`assets` ≤ 32 个。 */
export const MAX_ASSETS = 32;
/**
 * 合计上限。02 §2.2 说「合计解码后 ≤ 24 MiB」，但 02 §2.6 又要求**请求体 > 16 MiB 直接拒**
 * （`IMP-4005`，按 `Content-Length` 在解析前拦下）。base64 会放大约 4/3，
 * 所以原始字节合计压到 6 MiB（≈8 MiB base64），给正文与元数据留出余量 ——
 * 宁可少带几张图并如实说，也不发一个**必被拒**的请求体。
 */
export const MAX_ASSETS_TOTAL_BYTES = 6 * 1024 * 1024;

const EXT_BY_MIME = Object.freeze({
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/avif": ".avif",
  "image/svg+xml": ".svg",
  "image/bmp": ".bmp",
});

/** Uint8Array → 标准 base64（不含 `data:` 前缀）。分块转换，避免大数组把调用栈压爆。 */
export function base64Of(bytes) {
  const CHUNK = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + CHUNK));
  }
  return btoa(binary);
}

/** 按魔数嗅探 MIME（不信任 `Content-Type`：它可能是错的，桥那边也会再判一次）。 */
export function sniffMime(bytes) {
  const head = bytes.subarray(0, 16);
  const ascii = (start, length) => String.fromCharCode.apply(null, head.subarray(start, start + length));
  if (head.length >= 8 && head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return "image/png";
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return "image/jpeg";
  if (head.length >= 4 && ascii(0, 4) === "GIF8") return "image/gif";
  if (head.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (head.length >= 2 && ascii(0, 2) === "BM") return "image/bmp";
  if (head.length >= 12 && ascii(4, 4) === "ftyp" && /avif|avis/.test(ascii(8, 4))) return "image/avif";
  const text = String.fromCharCode.apply(null, bytes.subarray(0, 512)).trimStart();
  if (/^<(\?xml|svg)/i.test(text) && /<svg[\s>]/i.test(text)) return "image/svg+xml";
  return null;
}

/** 归一化响应头里的 `Content-Type`（去掉 `; charset=…`，只留白名单内的值，否则 null）。 */
export function mimeFromHeader(value) {
  const raw = String(value || "").split(";")[0].trim().toLowerCase();
  if (raw === "image/jpg") return "image/jpeg";
  return MIME_WHITELIST.includes(raw) ? raw : null;
}

/** 从 URL 末段推导文件名；`.` 收进白名单对应的扩展名（02 §2.5：名字必须带合法扩展名）。 */
export function assetNameOf(url, mime) {
  let base = "image";
  try {
    const parsed = new URL(String(url || ""));
    const last = parsed.pathname.split("/").filter(Boolean).pop() || "";
    base = decodeURIComponent(last).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").trim() || "image";
  } catch {
    base = "image";
  }
  const ext = EXT_BY_MIME[mime] || "";
  const current = (base.match(/\.[A-Za-z0-9]{1,5}$/) || [])[0];
  if (!current) base += ext;
  else if (ext && current.toLowerCase() !== ext) base = base.slice(0, -current.length) + ext;
  return base.slice(0, 80);
}

/**
 * 一条资产的**唯一合法形状**（02 §2.5）+ 校验。
 * 非法就返回 `{ error }`，调用方必须降级（丢这条 + 记 warning），**不许**换个形状发出去。
 */
export function assetFromBytes(input) {
  const data = input || {};
  const bytes = data.bytes instanceof Uint8Array ? data.bytes : null;
  if (!bytes || bytes.length === 0) return { error: "空文件" };
  if (bytes.length > MAX_ASSET_BYTES) return { error: "超过 8 MiB" };
  const mime = data.mime || sniffMime(bytes);
  if (!mime || !MIME_WHITELIST.includes(mime)) return { error: "不是支持的图片格式" };
  const name = String(data.name || "").trim() || assetNameOf(data.url, mime);
  if (!name) return { error: "文件名取不到" };
  return { asset: { name, mime, dataBase64: base64Of(bytes) } };
}

/** 把一次失败翻译成一句人能读懂的原因（警告文案要如实，不许统一糊成「失败」）。 */
export function downloadFailureReason(error) {
  const name = (error && error.name) || "";
  const code = (error && error.cause && error.cause.code) || (error && error.code) || "";
  if (name === "AbortError" || name === "TimeoutError") return "下载超时";
  if (name === "TypeError" || code === "EACCES" || code === "EPERM") return "没有权限、跨站限制或网络不可达";
  return "下载失败";
}

/**
 * 逐张下载 → 逐张产出 02 §2.5 形状的资产。
 * **失败一律降级**：这一条不进 `assets`，正文里的原始 URL 保持不变，原因进 `warnings`。
 * @returns {Promise<{assets:Array<{name:string,mime:string,dataBase64:string}>, warnings:string[], downloaded:number, failed:number}>}
 */
export async function collectImageAssets(items, options = {}) {
  const {
    fetchImpl = globalThis.fetch,
    timeoutMs = 8000,
    maxBytes = MAX_ASSET_BYTES,
    totalMaxBytes = MAX_ASSETS_TOTAL_BYTES,
    limit = MAX_ASSETS,
  } = options;
  const assets = [];
  const warnings = [];
  let total = 0;
  let failed = 0;
  let skipped = 0;
  const list = Array.isArray(items) ? items : [];
  for (const item of list) {
    const url = item && typeof item.url === "string" ? item.url : "";
    if (!url) {
      failed += 1;
      warnings.push("有 1 张图片没有可下载的地址，正文里保留原始网址。");
      continue;
    }
    if (assets.length >= limit) {
      skipped += 1; // 件数上限：不下载、不报错，最后由一句汇总如实说清
      continue;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(url, {
        signal: controller.signal,
        credentials: "omit",
        cache: "no-store",
        redirect: "follow",
      });
      if (!response || !response.ok) {
        failed += 1;
        warnings.push(`图片没能下载（服务器返回 ${response ? response.status : "无响应"}），正文里保留原始网址：${url}`);
        continue;
      }
      const declared = Number(response.headers && response.headers.get ? response.headers.get("content-length") : 0);
      if (declared && declared > maxBytes) {
        failed += 1;
        warnings.push(`图片太大（超过 8 MiB），正文里保留原始网址：${url}`);
        continue;
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length > maxBytes) {
        failed += 1;
        warnings.push(`图片太大（超过 8 MiB），正文里保留原始网址：${url}`);
        continue;
      }
      if (total + bytes.length > totalMaxBytes) {
        failed += 1;
        warnings.push(`这一页要下载的图片合计太大（超过 ${Math.round(totalMaxBytes / 1024 / 1024)} MiB），剩下的在正文里保留原始网址：${url}`);
        continue;
      }
      const headerMime = response.headers && response.headers.get ? response.headers.get("content-type") : null;
      const sniffed = sniffMime(bytes);
      const mime = sniffed || mimeFromHeader(headerMime);
      const built = assetFromBytes({ bytes, mime, name: assetNameOf(url, mime), url });
      if (built.error) {
        failed += 1;
        warnings.push(`图片没能保存（${built.error}），正文里保留原始网址：${url}`);
        continue;
      }
      total += bytes.length;
      assets.push(built.asset);
    } catch (error) {
      failed += 1;
      warnings.push(`图片没能下载（${downloadFailureReason(error)}），正文里保留原始网址：${url}`);
    } finally {
      clearTimeout(timer);
    }
  }
  if (skipped > 0) {
    warnings.push(`只下载了前 ${assets.length} 张图片，其余 ${skipped} 张在正文里保留原始网址。`);
  }
  return { assets, warnings, downloaded: assets.length, failed, skipped };
}
