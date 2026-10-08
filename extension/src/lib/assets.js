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
 * 权限事实（决定了「在哪抓字节」）：`host_permissions` 只有 127.0.0.1 的 10 条，
 * background 的 fetch 对任意网站**必然**跨站失败 —— 用户实测「勾了图片一起保存，
 * 一张图都没落盘」就是这个原因。0.4.0 起字节改由**页面侧**抓（`content/fetch-images.js`，
 * 内容脚本跑在页面自己的源上：同源直接可取，带 CORS 的跨域图也能取），
 * 这里只负责把回传的 `{url, ok, base64, …}` 结果**组装成 `assets[]`** 并执行全部上限判定。
 * 真跨域且无 CORS 的图仍然拿不到 —— 那是**预期内的降级**，不是要靠加权限去修的缺陷
 * （红线：不新增权限、零依赖、新增令牌 0）。
 *
 * 纯函数：结果组装不碰网络，所以「成功 / 各类失败降级」都能在 node 里逐条验。
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

/** 标准 base64（不含 `data:` 前缀）→ Uint8Array；解码失败返回 null（调用方降级）。 */
export function bytesFromBase64(base64) {
  const raw = String(base64 || "");
  if (!raw) return null;
  try {
    const binary = atob(raw);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * 把**页面侧**抓回的字节结果（`content/fetch-images.js` 的返回值）组装成 02 §2.5 形状的资产。
 *
 * 这里是 `assets[]` 的**唯一组装产地**，全部上限在这里执行：
 * 单件 ≤ 8 MiB、合计 ≤ 6 MiB、件数 ≤ 32 —— 页面侧的那份拷贝只是为了少传必拒的大 payload，
 * **不作数**（不信任注入环境的自报），这里逐条重验。
 * **失败一律降级**：这一条不进 `assets`，正文里的原始 URL 保持不变，原因进 `warnings`。
 *
 * @param {Array<{url:string}>} items 图片候选清单（与 `extract-page.js` 的 `collectImages` 同源）
 * @param {Array<{url:string, ok:boolean, base64?:string, byteLength?:number, mime?:string|null, error?:string}>} results
 * @returns {{assets:Array<{name:string,mime:string,dataBase64:string}>, warnings:string[], downloaded:number, failed:number, skipped:number, urlNames:Array<{url:string,name:string}>}}
 *   `urlNames` 是**成功那批**的 `url → assets[].name` 映射：正文引用改写要用它，
 *   而且**必须一一对应**（两个不同 URL 撞同一个 basename 时，第二个改名 `x-2.png`，
 *   否则两处引用都会指到同一张图 —— 那是「图串了」的经典成因）。
 */
export function collectImageAssetsFromPage(items, results, options = {}) {
  const {
    maxBytes = MAX_ASSET_BYTES,
    totalMaxBytes = MAX_ASSETS_TOTAL_BYTES,
    limit = MAX_ASSETS,
  } = options;
  const assets = [];
  const warnings = [];
  const urlNames = [];
  const used = new Set();
  /** 同一个 basename 只允许一次：第二次起 `名字-2.png`、`名字-3.png`（与 02 §2.5 的命名习惯一致）。 */
  const uniqueName = (base) => {
    if (!used.has(base)) {
      used.add(base);
      return base;
    }
    const dot = base.lastIndexOf(".");
    const stem = dot > 0 ? base.slice(0, dot) : base;
    const ext = dot > 0 ? base.slice(dot) : "";
    for (let index = 2; index < 100; index += 1) {
      const candidate = `${stem}-${index}${ext}`;
      if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
      }
    }
    const fallback = `${stem}-${Date.now().toString(36)}${ext}`;
    used.add(fallback);
    return fallback;
  };
  const byUrl = new Map();
  for (const result of Array.isArray(results) ? results : []) {
    if (result && typeof result.url === "string") byUrl.set(result.url, result);
  }
  let total = 0;
  let failed = 0;
  let skipped = 0;
  for (const item of Array.isArray(items) ? items : []) {
    const url = item && typeof item.url === "string" ? item.url : "";
    if (!url) {
      failed += 1;
      warnings.push("有 1 张图片没有可下载的地址，正文里保留原始网址。");
      continue;
    }
    if (assets.length >= limit) {
      skipped += 1; // 件数上限：不报错，最后由一句汇总如实说清
      continue;
    }
    const result = byUrl.get(url);
    if (!result) {
      failed += 1;
      warnings.push(`图片没能下载（页面没有返回这张图的结果），正文里保留原始网址：${url}`);
      continue;
    }
    if (!result.ok) {
      failed += 1;
      warnings.push(`图片没能下载（${result.error || "下载失败"}），正文里保留原始网址：${url}`);
      continue;
    }
    const bytes = bytesFromBase64(result.base64);
    if (!bytes || bytes.length === 0) {
      failed += 1;
      warnings.push(`图片没能保存（空文件），正文里保留原始网址：${url}`);
      continue;
    }
    if (bytes.length > maxBytes) {
      failed += 1;
      warnings.push(`图片太大（超过 8 MiB），正文里保留原始网址：${url}`);
      continue;
    }
    if (total + bytes.length > totalMaxBytes) {
      failed += 1;
      warnings.push(
        `这一页要下载的图片合计太大（超过 ${Math.round(totalMaxBytes / 1024 / 1024)} MiB），剩下的在正文里保留原始网址：${url}`,
      );
      continue;
    }
    /* MIME 以本地重嗅为准（不信任注入环境自报的 `mime`，桥那边也会再判一次）。 */
    const mime = sniffMime(bytes) || mimeFromHeader(result.mime);
    const name = uniqueName(assetNameOf(url, mime));
    const built = assetFromBytes({ bytes, mime, name, url });
    if (built.error) {
      failed += 1;
      warnings.push(`图片没能保存（${built.error}），正文里保留原始网址：${url}`);
      continue;
    }
    total += bytes.length;
    assets.push(built.asset);
    urlNames.push({ url, name: built.asset.name });
  }
  if (skipped > 0) {
    warnings.push(`只下载了前 ${assets.length} 张图片，其余 ${skipped} 张在正文里保留原始网址。`);
  }
  return { assets, warnings, downloaded: assets.length, failed, skipped, urlNames };
}

/**
 * 正文里的**远程图片引用**改写成本地落名（`![alt](<原始网址>)` → `![alt](assets/<名>)`）。
 *
 * 为什么必须做：应用侧的 `rewriteAssetRefs()`（契约 §3.4）只认两种**客户端写法** ——
 * `./assets/<名>` 与裸名 `](<名>)`。远程 URL 不在其中，所以「字节到手了、却没有任何东西
 * 把正文指向那张图」—— 图片落盘成孤儿，正文继续指着一个桌面 CSP `img-src 'self' file:
 * data: blob:` 根本加载不了的地址（用户实测：桌面端没有显示）。
 *
 * 只改写**真的拿到字节那批**（`urlNames` 就是那批）：拿不到字节的引用原样保留，
 * 与「逐条降级 + warnings 如实说」完全一致；应用侧还有一层兜底（设置开着时自己下载）。
 *
 * 精确整串替换（`split/join`，不是正则）：URL 里的 `?`、`&`、`%`、`(` 都不是正则安全的，
 * 而这些 URL 是从页面里原样抽出来的。
 */
export function rewriteRemoteImageRefs(body, urlNames) {
  let next = String(body || "");
  for (const entry of Array.isArray(urlNames) ? urlNames : []) {
    const url = entry && typeof entry.url === "string" ? entry.url : "";
    const name = entry && typeof entry.name === "string" ? entry.name : "";
    if (!url || !name) continue;
    next = next.split(`](${url})`).join(`](assets/${name})`);
    // 尖括号写法 `](<url>)`（URL 带空格/括号时页面可能这么给）
    next = next.split(`](<${url}>)`).join(`](assets/${name})`);
  }
  return next;
}
