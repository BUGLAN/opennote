/**
 * A（网页版剪藏页）· 暂存请求体 —— **形状在这里定义一次**。
 *
 * 依据：交接文档 §四-A 已冻结的接口契约（不许改字段/形状，要改先改 02 号文档）：
 *
 *   POST /v1/clip/stage
 *     请求体 { spec:"opennote.clip/v1", url, title, body, selection, tags[],
 *              source{site,author,publishedAt}, assets[] }
 *     响应   { ok:true, stageId:"<接口生成的不透明 id>", expiresAt:<ms>,
 *              openUrl:"http://127.0.0.1:<port>/clip/<stageId>?k=<不可猜的键>" }
 *
 * 两条不可越界的纪律（都写在这里，免得实现时又各写一套）：
 *   1. **`openUrl` 的唯一产地是接口返回值**：`stageId` 是接口生成的不透明 id、端口是接口从
 *      8787–8796 里选出来的 —— 扩展侧**一律不推导、不拼接**。`openUrlOf()` 只做「取不到就是 null」。
 *   2. `selection` 恒为 `false`：两个按钮（元素选择 / 整页提取）都不是文本选区（00 §6.15㉝㊶），
 *      所以判定链第 4 步（同 URL、不同正文 → 进收件箱）仍然成立。
 *   3. `assets[]` 的元素形状由 02 §2.5 冻结：`{ name, mime, dataBase64 }` —— **有字节才发**，
 *      拿不到字节就**这一条不进 assets**、正文里的原始 URL 原样保留、原因进 `warnings[]`。
 *      `{url, alt}` 这种信封里不存在的形状会被桥 422 拒掉（`IMP-4003`），一条都不许发。
 *
 * 纯函数、零依赖、不引用任何 chrome API —— 所以「请求体形状」是**可执行断言**的对象，
 * 而不是靠读源码猜。
 */

export const STAGE_SPEC = "opennote.clip/v1";

/** 请求体的键集合（顺序即契约书写顺序）。测试按它逐字比对，防止「少一个键」悄悄漂移。 */
export const STAGE_REQUEST_KEYS = Object.freeze([
  "spec",
  "url",
  "title",
  "body",
  "selection",
  "tags",
  "source",
  "assets",
]);

export const STAGE_SOURCE_KEYS = Object.freeze(["site", "author", "publishedAt"]);

/**
 * ③ 图片下载开关的**默认值**：关。写成常量，让「默认关」是一个可以被断言的事实，
 * 而不是散落在界面里的一个字面量。
 */
export const IMAGE_DOWNLOAD_DEFAULT = false;

/**
 * 形状不合法的资产被丢掉时的那句话（**唯一产地**：门禁、单测与界面都引用它）。
 * 依据是 ③ 的降级口径：拿不到字节 → 这一条不进 `assets[]`，正文里的原始 URL 原样保留。
 */
export const IMAGE_UNUSABLE_WARNING = "有 1 张图片没能保存成可入库的格式，正文里保留原始网址。";

/**
 * 一条 `assets[]` 元素的**唯一合法形状**（02 §2.5）：`{ name, mime, dataBase64 }`。
 * 缺一不可、也不许多带键 —— 桥按这个形状校验，`{url, alt}` 之类会被 422
 * `IMP-4003 detail.field = "assets[0].name"` 直接拒掉（独立验证者用真桥探到过）。
 */
export function normalizeAsset(candidate) {
  const item = candidate || {};
  const name = typeof item.name === "string" ? item.name.trim() : "";
  const mime = typeof item.mime === "string" ? item.mime.trim() : "";
  const dataBase64 = typeof item.dataBase64 === "string" ? item.dataBase64.trim() : "";
  if (!name || !mime || !dataBase64) return null;
  return { name, mime, dataBase64 };
}

/**
 * 组装请求体。
 *
 * **`assets` 只接受 `{name, mime, dataBase64}`**（见 `normalizeAsset`）：形状不对的条目
 * 一律**丢掉并记一条 warning**，绝不换个形状发出去 —— 「绝不发一个桥必拒的形状」这条
 * 是在这里兜底的，调用方（`lib/assets.js` 的下载器）已经产出合法形状。
 *
 * @param {object} input
 * @param {string} input.url        页面地址（`location.href`）
 * @param {string} input.title      信封必填的标题（取不到时由调用方给真实兜底）
 * @param {string} input.body       正文（界面上那一份，所见即所剪；原始 URL 原样保留）
 * @param {boolean} input.selection 是否文本选区（本产品恒 false）
 * @param {?string} input.site / author / publishedAt  取不到就传 `null`（**不许填占位值**）
 * @param {?Array<{name:string,mime:string,dataBase64:string}>} input.assets 已下载到字节的图片
 * @param {?string[]} input.warnings 降级原因（来自下载器，逐条如实带回去）
 * @returns {{request:object, warnings:string[]}}
 */
export function buildStageRequest(input) {
  const data = input || {};
  const assets = [];
  const warnings = Array.isArray(data.warnings) ? data.warnings.filter((item) => typeof item === "string" && item) : [];
  for (const candidate of Array.isArray(data.assets) ? data.assets : []) {
    const asset = normalizeAsset(candidate);
    if (!asset) {
      // 形状不合法 = 这一条拿不到字节，按 ③ 的降级口径处理：丢掉 + 如实说，**不改形状硬发**。
      warnings.push(IMAGE_UNUSABLE_WARNING);
      continue;
    }
    assets.push(asset);
  }
  const request = {
    spec: STAGE_SPEC,
    url: typeof data.url === "string" ? data.url : "",
    title: typeof data.title === "string" ? data.title : "",
    body: typeof data.body === "string" ? data.body : "",
    selection: data.selection === true,
    tags: [],
    source: {
      site: data.site === undefined ? null : data.site,
      author: data.author === undefined ? null : data.author,
      publishedAt: data.publishedAt === undefined ? null : data.publishedAt,
    },
    assets,
  };
  return { request, warnings };
}

/**
 * 从 `POST /v1/clip/stage` 的结果里取 `openUrl`。
 * **只有一条规则**：接口给了非空字符串就用它，没给就是 `null`（调用方据此**不打开页面**）。
 * 这里不生成、不补全、不改写 —— 端口与 stageId 都不是扩展的事实。
 */
export function openUrlOf(result) {
  if (!result || typeof result.openUrl !== "string") return null;
  const value = result.openUrl.trim();
  return value || null;
}
