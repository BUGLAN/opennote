/**
 * 高亮数据模型（00 §6.14 ㉚）。
 *
 * - 记录形态：`{ text, note?, color?, createdAt, selector }`（+ 内部 id）
 * - 存储：`chrome.storage.local`，键 `opennote.highlights.v1`，**按 URL 分组**
 * - 写入正文：末尾追加 `## 高亮` 小节，每条 `> 摘录`；有批注时**空一行**后 `— {批注}`；
 *   摘录内部的换行**折叠成单个空格**（03 §UI-14「写入正文的形态」逐字节可照做）
 * - **高亮为空时不生成该小节**
 * - 高亮**不改变** `source.selection`：那个标志是「本次取的是选区」，影响接收端判定链
 *   第 3/4 步（00 §6.13⑳）；高亮只是 `body` 的一部分。
 */

export const HIGHLIGHTS_KEY = "opennote.highlights.v1";
export const HIGHLIGHTS_SPEC = "opennote.highlights/v1";

/** 正文里的小节标题（㉚ 逐字）。 */
export const HIGHLIGHT_SECTION_TITLE = "## 高亮";

/**
 * 底色**只有两档**（03 §UI-14「`color` 只做两档」）。
 *
 * 理由（必须留下）：`tokens.css` 里只有**一个**高亮底色令牌 `--mark`。第二种及更多颜色
 * 只能靠新增令牌（违反 00 §6.13⑰「新增设计令牌 0」）或硬写色值（凭空造第二套配色）——
 * 两条都破线。所以：
 *   - `"yellow"` → 底 `--mark`（默认，不改就是它）
 *   - `"accent"` → 底 `--accent-soft` + 1px `--accent-line` 描边
 *   - **其它任何值**（含 0.2.0 期间可能已写进存储的 `red`/`green`/`blue`/`purple`）
 *     → **按 `"yellow"` 渲染**，但**原值原样保留在存储里**（不得静默改写用户数据）。
 */
export const HIGHLIGHT_COLORS = Object.freeze(["yellow", "accent"]);
/** 历史值：只用于「读得进来、原样存回去」，一律按 yellow 渲染。 */
export const HIGHLIGHT_LEGACY_COLORS = Object.freeze(["red", "green", "blue", "purple"]);
export const MAX_GROUPS = 200;
export const MAX_HIGHLIGHTS_PER_URL = 100;
export const HIGHLIGHT_TEXT_MAX = 2000;
export const HIGHLIGHT_NOTE_MAX = 500;
export const HIGHLIGHT_SELECTOR_MAX = 300;

/** 渲染档位：只有 `"accent"` 与 `"yellow"`，其它一律 `"yellow"`。 */
export function highlightTier(color) {
  return color === "accent" ? "accent" : "yellow";
}

/** 两档在批注编辑态里的名字（03 §UI-14/S10 逐字）。 */
export const HIGHLIGHT_SWATCHES = Object.freeze([
  { value: "yellow", label: "默认底色" },
  { value: "accent", label: "强调底色" },
]);

/** 正文里的小节/条目形态（03 §UI-14 逐字）；`formatHighlightBody` 是它的别名。 */
export const HIGHLIGHT_BODY_SHAPE = Object.freeze({
  sectionTitle: HIGHLIGHT_SECTION_TITLE,
  quotePrefix: "> ",
  notePrefix: "— ",
  foldNewlines: true,
});

/** URL 归一：去掉 hash（`#section` 不算不同页面），其余保留。 */
export function normalizeUrl(url) {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const parsed = new URL(raw);
    parsed.hash = "";
    return parsed.toString();
  } catch {
    const index = raw.indexOf("#");
    return index >= 0 ? raw.slice(0, index) : raw;
  }
}

export function defaultHighlights() {
  return { spec: HIGHLIGHTS_SPEC, groups: {} };
}

function clampText(value, max) {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? text.slice(0, max) : text;
}

let counter = 0;

/** 归一一条高亮；返回 null 表示没有可用文本（空白不算高亮）。 */
export function normalizeHighlight(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const text = String(source.text === undefined || source.text === null ? "" : source.text).trim();
  if (!text) return null;
  const note = clampText(String(source.note === undefined || source.note === null ? "" : source.note).trim(), HIGHLIGHT_NOTE_MAX);
  // 两档 + 历史值：历史值**原样保留**（不静默改写用户数据），渲染时按 yellow（highlightTier）
  const color = HIGHLIGHT_COLORS.includes(source.color) || HIGHLIGHT_LEGACY_COLORS.includes(source.color) ? source.color : null;
  const createdAt = typeof source.createdAt === "string" && source.createdAt ? source.createdAt : new Date().toISOString();
  const selector = clampText(String(source.selector || ""), HIGHLIGHT_SELECTOR_MAX);
  counter += 1;
  const id = typeof source.id === "string" && source.id ? source.id : `hl-${Date.now().toString(36)}-${counter.toString(36)}`;
  return { id, text: clampText(text, HIGHLIGHT_TEXT_MAX), note, color, createdAt, selector };
}

function normalizeStore(store) {
  const source = store && typeof store === "object" ? store : {};
  const groups = {};
  const rawGroups = source.groups && typeof source.groups === "object" ? source.groups : {};
  for (const [key, value] of Object.entries(rawGroups)) {
    const items = (Array.isArray(value && value.items) ? value.items : []).map(normalizeHighlight).filter(Boolean);
    if (!items.length) continue;
    groups[key] = {
      url: (value && value.url) || key,
      title: (value && value.title) || "",
      updatedAt: (value && value.updatedAt) || "",
      items,
    };
  }
  return { spec: HIGHLIGHTS_SPEC, groups };
}

/** 高亮列表（按 URL）。 */
export function listHighlights(store, url) {
  const normalized = normalizeStore(store);
  const key = normalizeUrl(url);
  const group = normalized.groups[key];
  if (!group) return [];
  // 后加的排后面；读取时按时间正序，正文小节顺序稳定
  return [...group.items].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

/** 加一条高亮。返回新 store（不改原对象）+ 结果说明。 */
export function addHighlight(store, input = {}) {
  const normalized = normalizeStore(store);
  const key = normalizeUrl(input.url);
  if (!key) return { store: normalized, item: null, added: false, reason: "no-url" };
  const item = normalizeHighlight(input);
  if (!item) return { store: normalized, item: null, added: false, reason: "empty-text" };

  const group = normalized.groups[key] || { url: key, title: "", updatedAt: "", items: [] };
  // 完全相同的摘录 + 批注不重复记（用户会连点）
  const duplicate = group.items.find((existing) => existing.text === item.text && existing.note === item.note);
  if (duplicate) {
    return { store: normalized, item: duplicate, added: false, reason: "duplicate" };
  }

  const items = [...group.items, item];
  let evicted = null;
  while (items.length > MAX_HIGHLIGHTS_PER_URL) evicted = items.shift() || evicted;

  const groups = {
    ...normalized.groups,
    [key]: {
      url: key,
      title: clampText(String(input.title || group.title || ""), 200),
      updatedAt: new Date().toISOString(),
      items,
    },
  };

  // 组数上限：淘汰最久没更新的那一组（整组丢，绝不静默）
  const keys = Object.keys(groups);
  if (keys.length > MAX_GROUPS) {
    const oldest = keys
      .filter((candidate) => candidate !== key)
      .sort((a, b) => String(groups[a].updatedAt).localeCompare(String(groups[b].updatedAt)))[0];
    if (oldest) delete groups[oldest];
  }

  return { store: { spec: HIGHLIGHTS_SPEC, groups }, item, added: true, evicted, reason: evicted ? "evicted-oldest" : "ok" };
}

export function removeHighlight(store, url, id) {
  const normalized = normalizeStore(store);
  const key = normalizeUrl(url);
  const group = normalized.groups[key];
  if (!group) return { store: normalized, removed: false };
  const items = group.items.filter((item) => item.id !== id);
  if (items.length === group.items.length) return { store: normalized, removed: false };
  const groups = { ...normalized.groups };
  if (items.length) groups[key] = { ...group, items, updatedAt: new Date().toISOString() };
  else delete groups[key];
  return { store: { spec: HIGHLIGHTS_SPEC, groups }, removed: true };
}

export function clearHighlights(store, url) {
  const normalized = normalizeStore(store);
  const key = normalizeUrl(url);
  if (!normalized.groups[key]) return { store: normalized, cleared: 0 };
  const cleared = normalized.groups[key].items.length;
  const groups = { ...normalized.groups };
  delete groups[key];
  return { store: { spec: HIGHLIGHTS_SPEC, groups }, cleared };
}

export function countHighlights(store) {
  const normalized = normalizeStore(store);
  return Object.values(normalized.groups).reduce((sum, group) => sum + group.items.length, 0);
}

/**
 * 一条高亮的 Markdown（03 §UI-14「写入正文的形态」逐字节）：
 *   `> 摘录`；摘录内部的换行**折叠成单个空格**；有批注时空一行再写 `— 批注`。
 */
export function highlightLine(item) {
  const normalized = normalizeHighlight(item);
  if (!normalized) return "";
  const folded = normalized.text.replace(/\s*\r?\n+\s*/g, " ").trim();
  const quoted = `> ${folded}`;
  return normalized.note ? `${quoted}\n\n— ${normalized.note}` : quoted;
}

/**
 * `## 高亮` 小节。**空高亮返回空字符串**（㉚：不生成该小节）。
 */
export function highlightSection(items) {
  const list = (Array.isArray(items) ? items : []).map(normalizeHighlight).filter(Boolean);
  if (!list.length) return "";
  const blocks = list.map(highlightLine).filter(Boolean);
  if (!blocks.length) return "";
  return `${HIGHLIGHT_SECTION_TITLE}\n\n${blocks.join("\n\n")}`;
}

/**
 * 把高亮小节追加到正文末尾。没有高亮时**原样返回**（连空行都不多加）。
 */
export function withHighlightSection(body, items) {
  const source = typeof body === "string" ? body : "";
  const section = highlightSection(items);
  if (!section) return source;
  const trimmed = source.replace(/\s+$/, "");
  return trimmed ? `${trimmed}\n\n${section}\n` : `${section}\n`;
}

/** 供 popup 高亮区显示的一项。 */
export function highlightOption(item, index = 0) {
  const normalized = normalizeHighlight(item);
  if (!normalized) return null;
  return {
    id: normalized.id,
    index: index + 1,
    text: normalized.text,
    note: normalized.note,
    color: normalized.color,
    tier: highlightTier(normalized.color),
    truncated: normalized.text.length >= HIGHLIGHT_TEXT_MAX,
    createdAt: normalized.createdAt,
    selector: normalized.selector,
    excerpt: normalized.text.length > 120 ? `${normalized.text.slice(0, 120)}…` : normalized.text,
  };
}
