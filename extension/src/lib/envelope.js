/**
 * L0 导入信封 `opennote.import/v1` 的构造与自检（纯函数，无浏览器依赖，可直接在 node 里跑单测）。
 *
 * 字段名逐字来自 docs/import/02-interface §2.2：不得改名、不得新增必填字段。
 * 本模块**只产出契约里有的 10 个顶层键**，未知字段一律不写。
 *
 * 注意 `conflict` 是**可选键**，且扩展默认**不下发**它（见 `buildEnvelope()` 的注释）：
 * 接收端 `src/lib/clip/envelope.ts` 用 `conflictExplicit` 区分「缺省」与「显式 new」，
 * 判定链第 3 步（同 URL + 选区二次剪藏 → appended）与第 4 步（同 URL + 整页 → 进收件箱）
 * **只在缺省时才会发生**；一旦显式下发 `new`，这两步永远不生效。
 */

import { SPEC, CLIENT_NAME, CLIENT_VERSION } from "./errors.js";

/** 02 §2.2 的 10 个顶层字段，顺序即契约示例里的顺序。 */
export const ENVELOPE_KEYS = Object.freeze([
  "spec",
  "importId",
  "title",
  "body",
  "source",
  "target",
  "conflict",
  "tags",
  "assets",
  "client",
]);

/**
 * 可以**缺省**的顶层键。今天只有 `conflict`：
 * 缺省 = 「没有显式请求冲突策略」，由接收端按判定链自行决定（第 3 步 appended / 第 4 步 收件箱）。
 */
export const OPTIONAL_ENVELOPE_KEYS = Object.freeze(["conflict"]);

/** 必须出现的顶层键（= ENVELOPE_KEYS 去掉可选键，保持声明顺序）。 */
export const REQUIRED_ENVELOPE_KEYS = Object.freeze(
  ENVELOPE_KEYS.filter((key) => !OPTIONAL_ENVELOPE_KEYS.includes(key)),
);

/** 02 §2.3 `source` 的 7 个字段。 */
export const SOURCE_KEYS = Object.freeze([
  "url",
  "title",
  "site",
  "author",
  "publishedAt",
  "capturedAt",
  "selection",
]);

/** 02 §2.4 `target` 的 2 个字段。 */
export const TARGET_KEYS = Object.freeze(["folder", "notePath"]);

/** 02 §2.2：扩展**一律不发** `overwrite`（只有桌面版本地桥 + 用户显式开启才接受）。 */
export const ALLOWED_CONFLICTS = Object.freeze(["new", "append", "skip"]);

export const TITLE_MAX = 200; // UTF-16 码元计数（02 §2.2）
export const TAG_MAX_CHARS = 32;
export const TAG_MAX_COUNT = 32;
export const SOURCE_TITLE_MAX = 300;
export const SOURCE_FIELD_MAX = 120;
export const MAX_BODY_BYTES = 8 * 1024 * 1024; // 02 §2.7：body（UTF-8 字节）8 MiB
export const IMPORT_ID_RE = /^[A-Za-z0-9_-]{8,128}$/;
/**
 * 「追加到指定笔记」的落点格式（00 §6.14 ㉘）：工作区**相对**路径 + `.md`。
 * 绝对路径 / 盘符 / `..` / 反斜杠一律拒绝——信封不能指定绝对路径这条红线不变。
 */
export const NOTE_PATH_MAX = 300;
export const NOTE_PATH_RE = /^(?![/\\])(?!.*(?:^|[/\\])\.\.(?:[/\\]|$))(?!.*:)[^\\]+\.md$/;
/** 02 §2.3：capturedAt 必须含时区（`Z` 或 `±HH:MM`）。 */
export const ISO_WITH_TZ_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;
/** 02 §2.2 item ⑤：字符集收紧到 `[\p{L}\p{N}_\-/]`。 */
export const TAG_ALLOWED_RE = /^[\p{L}\p{N}_\-/]+$/u;
const TAG_STRIP_RE = /[,\r\n[\]"']/g;
const TAG_DISALLOWED_RE = /[^\p{L}\p{N}_\-/]/gu;
const PURE_DIGITS_RE = /^\d+$/;

/** 02 §3.5：换行一律归一为 LF（`normalizeEol()`，src/lib/utils.ts:36 同义）。 */
export function normalizeEol(text) {
  return String(text == null ? "" : text).replace(/\r\n?/g, "\n");
}

/** UTF-8 字节长度（用于 8 MiB 上限判定，不用于计数展示）。 */
export function utf8Bytes(text) {
  return new TextEncoder().encode(String(text == null ? "" : text)).length;
}

export function bodyByteLength(body) {
  return utf8Bytes(body);
}

/** 按 UTF-16 码元截断到 `max`（02 §2.2 明确 UTF-16 码元计数）。 */
export function clampText(raw, max) {
  const text = String(raw == null ? "" : raw);
  return text.length <= max ? text : text.slice(0, max);
}

/**
 * 本机时区的 ISO 8601 串（`2026-09-29T21:04:11+08:00`）。
 * 02 §2.3 要求「必须含时区」，且 §3.2 保留了原字符串不做时区换算——
 * 用本机偏移比 `toISOString()` 的 UTC 串更贴近「用户当时的当地时间」。
 */
export function toLocalIso(date = new Date()) {
  const pad = (n, w = 2) => String(Math.abs(n)).padStart(w, "0");
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offset = `${sign}${pad(Math.floor(Math.abs(offsetMin) / 60))}:${pad(Math.abs(offsetMin) % 60)}`;
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}${offset}`
  );
}

/** 02 §2.3：`url` 只允许 `http:` / `https:`，其它协议 → 置 null（否则服务端 IMP-4003）。 */
export function isHttpUrl(url) {
  if (typeof url !== "string" || !url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function siteOf(url) {
  if (!isHttpUrl(url)) return null;
  try {
    return new URL(url).hostname || null;
  } catch {
    return null;
  }
}

/** 可解析的 ISO 时间戳原样保留；不可解析 → null（服务端只会 warning IMP-W006，不失败）。 */
export function normalizeTimestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const text = value.trim();
  const ms = Date.parse(text);
  return Number.isNaN(ms) ? null : clampText(text, 64);
}

/**
 * 标签清洗（02 §2.2 tags 行的 ①–⑤，**客户端必须在写入前自己做完**）：
 * ① 去掉逗号；② 去掉换行与 `[` `]`；③ 每个 ≤32 字符；④ 丢弃纯数字；
 * ⑤ 字符集收紧到 `[\p{L}\p{N}_\-/]`；最后去重、数量 ≤32。
 *
 * 注意 02 §2.2 明令：**不得**声称「已由 `normalizeTag()` 清洗」——那个函数是模块私有且
 * 只做去引号/trim/拒纯数字/截断 32，没有任何字符白名单过滤。
 */
export function filterTagsDetailed(input) {
  // 数组入参也要按逗号拆：服务端 `tags: ["a,b"]` 会**按逗号拆成两个标签**，
  // 客户端若不拆，用户的「排版, 网页剪藏」就会静默变成一个标签「排版网页剪藏」。
  const list = Array.isArray(input) ? input : [input];
  const raw = [];
  for (const item of list) {
    const text = String(item == null ? "" : item);
    for (const piece of text.split(",")) raw.push(piece);
  }
  const tags = [];
  const dropped = [];
  for (const item of raw) {
    const original = String(item == null ? "" : item);
    if (!original.trim()) continue;
    let tag = original.replace(TAG_STRIP_RE, "");
    tag = tag.replace(TAG_DISALLOWED_RE, "");
    tag = tag.trim();
    if (!tag) {
      dropped.push({ input: original, reason: "empty-after-filter" });
      continue;
    }
    if (PURE_DIGITS_RE.test(tag)) {
      dropped.push({ input: original, reason: "pure-digits" });
      continue;
    }
    if (tag.length > TAG_MAX_CHARS) {
      dropped.push({ input: original, reason: "too-long-truncated" });
      tag = tag.slice(0, TAG_MAX_CHARS);
    }
    if (tags.includes(tag)) {
      dropped.push({ input: original, reason: "duplicate" });
      continue;
    }
    tags.push(tag);
  }
  const overflow = tags.splice(TAG_MAX_COUNT);
  for (const tag of overflow) dropped.push({ input: tag, reason: "over-count" });
  return { tags, dropped };
}

/** 只关心结果时的便捷入口。 */
export function filterTags(input) {
  return filterTagsDetailed(input).tags;
}

/** 标题：trim + 截断到 200；空串交给调用方决定兜底（02：空 → IMP-4003）。 */
export function sanitizeTitle(raw) {
  return clampText(String(raw == null ? "" : raw).trim(), TITLE_MAX);
}

/** 新 `importId`：UUIDv4（02 §4.2 对浏览器插件的建议）。重试时必须复用同一个值。 */
export function newImportId() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  // 极端兜底：仍然满足 `[A-Za-z0-9_-]{8,128}`。
  const hex = [];
  for (let i = 0; i < 32; i += 1) hex.push(Math.floor(Math.random() * 16).toString(16));
  return `fallback-${hex.join("")}`;
}

/**
 * 构造信封。
 * @param {object} input
 * @param {string} [input.importId] 复用同一个 id 才能让「同一次导入」保持幂等
 * @param {string} input.title      正文标题（会写进正文首个 H1，由 L2 完成）
 * @param {string} input.body       Markdown 正文（未归一化前会做 normalizeEol）
 * @param {string|null} [input.url] 来源地址；非 http(s) 会被置 null
 * @param {string|null} [input.pageTitle]
 * @param {string|null} [input.site] 缺省从 url 推导
 * @param {string|null} [input.author]
 * @param {string|null} [input.publishedAt]
 * @param {string} [input.capturedAt] 缺省 = 现在（本机时区偏移）
 * @param {boolean} [input.selection] **判定输入**，不是纯展示：true=选区，false=整页
 * @param {string|null} [input.folder]
 * @param {string[]|string} [input.tags]
 * @param {string} [input.version]
 */
export function buildEnvelope(input) {
  const {
    importId,
    title,
    body,
    url = null,
    pageTitle = null,
    site = null,
    author = null,
    publishedAt = null,
    capturedAt,
    selection = false,
    folder = null,
    tags = [],
    notePath = null,
    version = CLIENT_VERSION,
  } = input || {};

  const safeUrl = isHttpUrl(url) ? String(url) : null;
  const envelope = {
    spec: SPEC,
    importId: importId || newImportId(),
    title: sanitizeTitle(title),
    body: normalizeEol(body),
    source: {
      url: safeUrl,
      title: pageTitle ? clampText(String(pageTitle).trim(), SOURCE_TITLE_MAX) : null,
      site: site ? clampText(String(site).trim(), SOURCE_FIELD_MAX) : siteOf(safeUrl),
      author: author ? clampText(String(author).trim(), SOURCE_FIELD_MAX) : null,
      publishedAt: normalizeTimestamp(publishedAt),
      capturedAt: capturedAt || toLocalIso(new Date()),
      selection: Boolean(selection),
    },
    target: {
      folder: typeof folder === "string" && folder.trim() ? folder.trim() : null,
      // `notePath` 只在 `conflict: "append"` / `"overwrite"` 时有效（02 §2.4）；
      // 「追加到指定笔记」写到这里，其余情况保持 null（不得凭空指一个笔记）。
      notePath: typeof notePath === "string" && notePath.trim() ? notePath.trim() : null,
    },
    tags: filterTags(tags),
    assets: [],
    client: { name: CLIENT_NAME, version: String(version || CLIENT_VERSION) },
  };
  // 注意 `conflict` **默认不写**——这是本契约里最容易踩的一条：
  //    接收端把「键缺省」解释为「客户端没有指定冲突策略」，于是按判定链自行决定：
  //      第 3 步：同 `source.url`、正文哈希不同、`source.selection === true` → `appended`（追加到既有笔记）；
  //      第 4 步：同 `source.url`、正文哈希不同、`source.selection === false` → `pending`（进收件箱，等人工确认）。
  //    如果此处硬编码 `conflict: "new"`，接收端的 `conflictExplicit` 会变成 true，
  //    上面两步**永远不生效** ⇒ 插件侧再也进不了收件箱，选区二次剪藏也不追加。
  //    0.3.0（00 §6.14 ㉘）现实的三条出口：
  //      「进收件箱」（默认）= 不下发 conflict，由**应用侧**设置 `UiSettings.importConflict` 决定（㉕）；
  //      「追加到指定笔记」= 显式 `conflict: "append"` + `target.notePath`；
  //      「跳过」= `"skip"`。`overwrite` 永不接受（02 §5.2：只有桌面版本地桥 + 用户显式开启进阶开关才允许）。
  if (input.conflict !== undefined && input.conflict !== null) {
    const requested = String(input.conflict);
    if (ALLOWED_CONFLICTS.includes(requested)) envelope.conflict = requested;
  }
  return envelope;
}

/**
 * 发送前的自检（纯函数）。返回的 `problems` 为空才允许发出去——
 * 这样「字段名/枚举/时间格式」这类错误不会浪费一次 HTTP 往返。
 */
export function envelopeProblems(envelope) {
  const problems = [];
  if (!envelope || typeof envelope !== "object" || Array.isArray(envelope)) {
    return ["envelope 不是对象"];
  }
  const keys = Object.keys(envelope);
  for (const key of keys) {
    if (!ENVELOPE_KEYS.includes(key)) problems.push(`出现未定义字段：${key}`);
  }
  // `conflict` 允许缺省（缺省 = 交给接收端判定链），其余键必须存在。
  for (const key of REQUIRED_ENVELOPE_KEYS) {
    if (!(key in envelope)) problems.push(`缺少字段：${key}`);
  }
  if (envelope.spec !== SPEC) problems.push(`spec 必须是 ${SPEC}`);
  if (typeof envelope.importId !== "string" || !IMPORT_ID_RE.test(envelope.importId)) {
    problems.push("importId 必须是 8–128 字符的 [A-Za-z0-9_-]");
  }
  if (typeof envelope.title !== "string" || envelope.title.length < 1) problems.push("title 不能为空");
  if (typeof envelope.title === "string" && envelope.title.length > TITLE_MAX) {
    problems.push(`title 超过 ${TITLE_MAX} 字符`);
  }
  if (typeof envelope.body !== "string") problems.push("body 必须是字符串（可为空串）");
  if (typeof envelope.body === "string" && bodyByteLength(envelope.body) > MAX_BODY_BYTES) {
    problems.push("body 超过 8 MiB（IMP-4004）");
  }
  const source = envelope.source;
  if (!source || typeof source !== "object") {
    problems.push("source 必须是对象");
  } else {
    for (const key of Object.keys(source)) {
      if (!SOURCE_KEYS.includes(key)) problems.push(`source 出现未定义字段：${key}`);
    }
    if (source.url !== null && !isHttpUrl(source.url)) {
      problems.push("source.url 只能是 http(s) 或 null");
    }
    if (typeof source.capturedAt !== "string" || !ISO_WITH_TZ_RE.test(source.capturedAt)) {
      problems.push("source.capturedAt 必须是含时区的 ISO 8601（IMP-4003）");
    }
    if (typeof source.selection !== "boolean") problems.push("source.selection 必须是布尔值");
  }
  const target = envelope.target;
  if (!target || typeof target !== "object") {
    problems.push("target 必须是对象");
  } else {
    for (const key of Object.keys(target)) {
      if (!TARGET_KEYS.includes(key)) problems.push(`target 出现未定义字段：${key}`);
    }
    if (target.folder !== null && typeof target.folder !== "string") {
      problems.push("target.folder 必须是字符串或 null");
    }
    if (target.notePath !== null) {
      // 「追加到指定笔记」（00 §6.14 ㉘）：只在 `conflict: "append"` 时有效（02 §2.4）。
      if (typeof target.notePath !== "string" || !target.notePath.trim()) {
        problems.push("target.notePath 必须是非空字符串或 null");
      } else {
        const notePath = target.notePath.trim();
        if (notePath.length > NOTE_PATH_MAX) problems.push(`target.notePath 超过 ${NOTE_PATH_MAX} 字符`);
        if (!NOTE_PATH_RE.test(notePath)) {
          problems.push(`target.notePath 必须是工作区相对 .md 路径（不得绝对路径 / .. / 反斜杠）：${notePath}`);
        }
        if (envelope.conflict !== "append") {
          problems.push('target.notePath 只在 conflict: "append" 时有效（02 §2.4）：要追加请显式下发 conflict: "append"，否则置 null');
        }
      }
    }
  }
  // 有则校验：缺省合法（交给接收端判定链），出现则必须是 new/append/skip。
  if ("conflict" in envelope && !ALLOWED_CONFLICTS.includes(envelope.conflict)) {
    problems.push(`conflict 只能是 ${ALLOWED_CONFLICTS.join(" / ")} 或整个键缺省（插件一律不发 overwrite）`);
  }
  if (!Array.isArray(envelope.tags)) {
    problems.push("tags 必须是数组");
  } else {
    if (envelope.tags.length > TAG_MAX_COUNT) problems.push("tags 超过 32 个");
    for (const tag of envelope.tags) {
      if (typeof tag !== "string" || !TAG_ALLOWED_RE.test(tag) || tag.length > TAG_MAX_CHARS) {
        problems.push(`标签不合规：${JSON.stringify(tag)}`);
      }
    }
  }
  if (!Array.isArray(envelope.assets)) problems.push("assets 必须是数组");
  if (!envelope.client || envelope.client.name !== CLIENT_NAME) {
    problems.push(`client.name 必须是 ${CLIENT_NAME}`);
  }
  if (envelope.client && typeof envelope.client.version !== "string") {
    problems.push("client.version 必须是字符串");
  }
  return problems;
}
