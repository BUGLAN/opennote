/**
 * 模板系统（00 §6.14 ㉙）——Web Clipper 式「按站点自动套模板」。
 *
 * 数据模型（逐字照 ㉙）：
 *   { id, name, triggers: [{ type: "url" | "domain" | "path", value }], priority,
 *     folder, tags: [], noteNameFormat, properties: {}, appendTo, behavior: "new" | "append" | "inbox" }
 *
 * 本实现的三条自我约束：
 *   1. **零依赖**：不引第三方模板引擎，变量/过滤器/条件全部手写。
 *   2. **绝不静默**：解析不了的写法不报错、不猜，**原样输出**，同时由 `scanTemplate()`
 *      把「超出范围」与「格式错误」记下来，交给 `verify.mjs` V10 让交付物直接红。
 *   3. **模板不碰红线**：模板的 `behavior` **不会**变出 `conflict: "new"`（那会让接收端
 *      判定链第 3/4 步失效，见 00 §6.13⑳）。只有 `behavior: "append"` 且确实有落点笔记时，
 *      才会下发 `conflict: "append"`；`"inbox"` 由**应用侧设置**决定，插件只如实显示回执。
 *
 * 说明（与 d-ui 的 03 冻结前留的 TODO）：㉙ 的字段表里没有 `bodyFormat`，但变量表里有
 * `{{content}}` `{{selection}}` `{{highlights}}` `{{wordCount}}`，这四个只可能在**正文模板**里
 * 出现，所以本实现把 `bodyFormat` 当作**可选附加字段**：缺省时正文 = 抽取出来的 Markdown
 * （与 0.2.0 行为一致），显式给出时由模板决定正文组装方式。
 */

/* ───────────────────────── 白名单常量（verify V10 直接复用） ───────────────────────── */

export const TEMPLATES_KEY = "opennote.templates.v1";

export const TEMPLATE_VARIABLES = Object.freeze([
  "title",
  "url",
  "site",
  "author",
  "publishedAt",
  "capturedAt",
  "selection",
  "highlights",
  "content",
  "wordCount",
]);

export const TEMPLATE_FILTERS = Object.freeze(["date", "upper", "lower", "trim", "truncate"]);

export const TRIGGER_TYPES = Object.freeze(["url", "domain", "path"]);

export const TEMPLATE_BEHAVIORS = Object.freeze(["new", "append", "inbox"]);

export const TEMPLATE_KEYS = Object.freeze([
  "id",
  "name",
  "triggers",
  "priority",
  "folder",
  "tags",
  "noteNameFormat",
  "properties",
  "appendTo",
  "behavior",
  // 可选附加字段（见文件头说明）
  "bodyFormat",
]);

/** 属性面板 / `properties` 的键白名单 = ㉘ 列的 8 个可视化字段。 */
export const PROPERTY_KEYS = Object.freeze([
  "title",
  "source.url",
  "source.title",
  "source.site",
  "author",
  "publishedAt",
  "tags",
  "target.folder",
]);

export const MAX_TEMPLATES = 64;
export const NOTE_NAME_MAX = 120;

/* ───────────────────────── 内置 3 个开箱模板（㉙） ───────────────────────── */

export const BUILTIN_TEMPLATES = Object.freeze([
  Object.freeze({
    id: "builtin-default",
    name: "默认",
    builtin: true,
    triggers: [],
    priority: 0,
    folder: "",
    tags: [],
    noteNameFormat: "",
    properties: {},
    appendTo: "",
    behavior: "new",
  }),
  Object.freeze({
    id: "builtin-paper",
    name: "论文",
    builtin: true,
    triggers: [
      { type: "domain", value: "arxiv.org" },
      { type: "domain", value: "doi.org" },
    ],
    priority: 20,
    folder: "文献",
    tags: ["论文"],
    noteNameFormat: "{{title}}",
    properties: {
      author: "{{author}}",
      publishedAt: "{{publishedAt|date:YYYY-MM-DD}}",
      "source.site": "{{site}}",
    },
    appendTo: "",
    behavior: "new",
  }),
  Object.freeze({
    id: "builtin-video",
    name: "视频",
    builtin: true,
    triggers: [
      { type: "domain", value: "youtube.com" },
      { type: "domain", value: "bilibili.com" },
    ],
    priority: 10,
    folder: "视频",
    tags: ["视频"],
    noteNameFormat: "{{title|trim}}",
    properties: {
      author: "{{author}}",
      "source.site": "{{site}}",
    },
    appendTo: "",
    behavior: "new",
  }),
]);

/* ───────────────────────── 匹配：priority 降序 + triggers ───────────────────────── */

/** 站点域名（去掉 www.，小写）。 */
export function domainOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

/** 路径（含 query，去掉 hash）。 */
export function pathOf(url) {
  try {
    const parsed = new URL(String(url));
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return "";
  }
}

/** 单条 trigger 是否命中。`domain` 命中子域；`path` 按前缀；`url` 支持 `*` 通配。 */
export function triggerHit(trigger, url) {
  if (!trigger || typeof trigger.value !== "string" || !trigger.value) return false;
  const value = trigger.value.trim();
  if (!value) return false;
  const raw = String(url || "");
  switch (trigger.type) {
    case "url": {
      const pattern = value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      try {
        return new RegExp(`^${pattern}$`).test(raw);
      } catch {
        return false;
      }
    }
    case "domain": {
      const host = domainOf(raw);
      const want = value.toLowerCase().replace(/^www\./, "").replace(/^\*\./, "");
      return Boolean(host) && (host === want || host.endsWith(`.${want}`));
    }
    case "path": {
      const path = pathOf(raw);
      return Boolean(path) && path.startsWith(value);
    }
    default:
      return false;
  }
}

export function templateHit(template, url) {
  const triggers = Array.isArray(template && template.triggers) ? template.triggers : [];
  if (!triggers.length) return { hit: false, matchedBy: null };
  for (const trigger of triggers) {
    if (triggerHit(trigger, url)) {
      return { hit: true, matchedBy: `${trigger.type}:${trigger.value}` };
    }
  }
  return { hit: false, matchedBy: null };
}

/**
 * priority 降序挑选第一个命中的模板；没命中就用内置默认模板（㉙）。
 * 返回轨迹 `tried`，测试与 UI 都可以解释「为什么是这个模板」。
 */
export function matchTemplate(templates, url) {
  const list = Array.isArray(templates) ? templates.filter(Boolean) : [];
  const sorted = [...list].sort((a, b) => priorityOf(b) - priorityOf(a));
  const tried = [];
  for (const template of sorted) {
    const result = templateHit(template, url);
    tried.push({ id: template.id, name: template.name, priority: priorityOf(template), hit: result.hit, matchedBy: result.matchedBy });
    if (result.hit) return { template, matchedBy: result.matchedBy, tried, fallback: false };
  }
  const fallback = sorted.find((template) => template.id === "builtin-default") || BUILTIN_TEMPLATES[0];
  return { template: fallback, matchedBy: null, tried, fallback: true };
}

function priorityOf(template) {
  const value = Number(template && template.priority);
  return Number.isFinite(value) ? value : 0;
}

/** 内置 3 个 + 用户模板（同 id 时用户覆盖内置）。 */
export function withBuiltins(userTemplates) {
  const users = Array.isArray(userTemplates) ? userTemplates.filter(Boolean) : [];
  const overridden = new Set(users.map((template) => template.id));
  const builtins = BUILTIN_TEMPLATES.filter((template) => !overridden.has(template.id));
  return [...builtins, ...users];
}

/* ───────────────────────── 校验 / 归一 ───────────────────────── */

const TRIGGER_VALUE_MAX = 300;

/**
 * 校验一个模板，返回问题清单（空数组 = 合法）。
 * 只做「能安全使用」的判断，不改写调用方数据。
 */
export function validateTemplate(raw) {
  const problems = [];
  if (!raw || typeof raw !== "object") return ["模板必须是对象"];
  if (typeof raw.id !== "string" || !raw.id.trim()) problems.push("缺少 id");
  if (typeof raw.name !== "string" || !raw.name.trim()) problems.push("缺少 name");
  if (raw.triggers !== undefined) {
    if (!Array.isArray(raw.triggers)) problems.push("triggers 必须是数组");
    else {
      raw.triggers.forEach((trigger, index) => {
        if (!trigger || typeof trigger !== "object") {
          problems.push(`triggers[${index}] 必须是对象`);
          return;
        }
        if (!TRIGGER_TYPES.includes(trigger.type)) problems.push(`triggers[${index}].type 只能是 ${TRIGGER_TYPES.join("/")}`);
        if (typeof trigger.value !== "string" || !trigger.value.trim()) problems.push(`triggers[${index}].value 必须是非空字符串`);
        else if (trigger.value.length > TRIGGER_VALUE_MAX) problems.push(`triggers[${index}].value 太长`);
      });
    }
  }
  if (raw.priority !== undefined && !Number.isFinite(Number(raw.priority))) problems.push("priority 必须是数字");
  if (raw.behavior !== undefined && !TEMPLATE_BEHAVIORS.includes(raw.behavior)) {
    problems.push(`behavior 只能是 ${TEMPLATE_BEHAVIORS.join("/")}`);
  }
  if (raw.tags !== undefined && !Array.isArray(raw.tags)) problems.push("tags 必须是数组");
  if (raw.properties !== undefined) {
    if (!raw.properties || typeof raw.properties !== "object" || Array.isArray(raw.properties)) {
      problems.push("properties 必须是对象");
    } else {
      for (const key of Object.keys(raw.properties)) {
        if (!PROPERTY_KEYS.includes(key)) problems.push(`properties.${key} 不在白名单（${PROPERTY_KEYS.join(" / ")}）`);
      }
    }
  }
  for (const key of ["noteNameFormat", "folder", "appendTo", "bodyFormat"]) {
    if (raw[key] !== undefined && typeof raw[key] !== "string") problems.push(`${key} 必须是字符串`);
  }
  for (const key of Object.keys(raw)) {
    if (!TEMPLATE_KEYS.includes(key) && key !== "builtin") problems.push(`未知字段 ${key}（㉙ 的模型里没有它）`);
  }
  // 模板文本里的越界写法：原样输出，但必须在这里被记下来
  for (const key of ["noteNameFormat", "bodyFormat"]) {
    if (typeof raw[key] === "string" && raw[key]) {
      for (const issue of scanTemplate(raw[key]).issues) problems.push(`${key}: ${issue}`);
    }
  }
  if (raw.properties && typeof raw.properties === "object") {
    for (const [key, value] of Object.entries(raw.properties)) {
      if (typeof value !== "string" || !value) continue;
      for (const issue of scanTemplate(value).issues) problems.push(`properties.${key}: ${issue}`);
    }
  }
  return problems;
}

/** 归一：缺省字段补齐、非法 behavior 退回 "new"、tags 去重。**不**丢未知键的告警（由 validate 报）。 */
export function normalizeTemplate(raw) {
  const source = raw && typeof raw === "object" ? raw : {};
  const tags = Array.isArray(source.tags)
    ? Array.from(new Set(source.tags.filter((tag) => typeof tag === "string" && tag.trim()).map((tag) => tag.trim())))
    : [];
  const properties = {};
  if (source.properties && typeof source.properties === "object" && !Array.isArray(source.properties)) {
    for (const [key, value] of Object.entries(source.properties)) {
      if (PROPERTY_KEYS.includes(key) && typeof value === "string") properties[key] = value;
    }
  }
  return {
    id: typeof source.id === "string" && source.id.trim() ? source.id.trim() : `tpl-${Math.random().toString(36).slice(2, 10)}`,
    name: typeof source.name === "string" && source.name.trim() ? source.name.trim() : "未命名模板",
    triggers: (Array.isArray(source.triggers) ? source.triggers : [])
      .filter((trigger) => trigger && TRIGGER_TYPES.includes(trigger.type) && typeof trigger.value === "string" && trigger.value.trim())
      .map((trigger) => ({ type: trigger.type, value: trigger.value.trim() })),
    priority: Number.isFinite(Number(source.priority)) ? Number(source.priority) : 0,
    folder: typeof source.folder === "string" ? source.folder.trim() : "",
    tags,
    noteNameFormat: typeof source.noteNameFormat === "string" ? source.noteNameFormat : "",
    properties,
    appendTo: typeof source.appendTo === "string" ? source.appendTo.trim() : "",
    behavior: TEMPLATE_BEHAVIORS.includes(source.behavior) ? source.behavior : "new",
    bodyFormat: typeof source.bodyFormat === "string" ? source.bodyFormat : "",
  };
}

/* ───────────────────────── 变量 / 过滤器 / 极简 {{#if}} ───────────────────────── */

const FILTER_RE = /^([a-zA-Z]+)(?::(.*))?$/;

/** 扫描模板文本：报出「未知变量 / 未知过滤器 / 超范围语法 / 格式错误」。 */
export function scanTemplate(text) {
  const source = typeof text === "string" ? text : "";
  const variables = [];
  const filters = [];
  const conditionals = [];
  /** 结构性越界（循环 / else / 嵌套 / 括号不配对）：遇到就整段**原样输出**。 */
  const structural = [];
  /** 词法级问题（未知变量 / 未知过滤器 / 参数不对）：只把那一个 `{{…}}` 原样留着。 */
  const tokenIssues = [];

  // 超范围语法：循环、反向条件、局部模板、三元表达式、嵌套 if
  const outOfScope = [
    { re: /\{\{#each\b/, label: "{{#each}}（不做循环）" },
    { re: /\{\{#unless\b/, label: "{{#unless}}（只支持 {{#if}}）" },
    { re: /\{\{else\}\}/, label: "{{else}}（只支持 {{#if}}…{{/if}}，不做 else）" },
    { re: /\{\{>\s*\w+/, label: "{{> partial}}（不做局部模板）" },
    { re: /\{\{[^}]*\?[^}]*\}\}/, label: "三元表达式" },
    { re: /\{\{[^}]*\([^}]*\}\}/, label: "函数调用" },
  ];
  for (const rule of outOfScope) {
    if (rule.re.test(source)) structural.push(`超范围语法：${rule.label} 会被原样输出`);
  }

  // 括号配对
  const openCount = (source.match(/\{\{/g) || []).length;
  const closeCount = (source.match(/\}\}/g) || []).length;
  if (openCount !== closeCount) structural.push(`{{ }} 不配对（${openCount} 开 / ${closeCount} 闭）`);
  const stripped = source.replace(/\{\{[\s\S]*?\}\}/g, "");
  if (stripped.includes("{{") || stripped.includes("}}")) structural.push("存在未闭合的 {{ 或 }}");
  // 嵌套 {{#if}}：按出现顺序数深度，任何时刻深度 > 1 就是嵌套（只支持一层）
  {
    const tagRe = /\{\{#if\b[^{}]*\}\}|\{\{\/if\}\}/g;
    let depth = 0;
    let tag = tagRe.exec(source);
    while (tag) {
      if (tag[0].startsWith("{{#if")) {
        depth += 1;
        if (depth > 1) structural.push("嵌套 {{#if}}（只支持一层）");
      } else depth -= 1;
      tag = tagRe.exec(source);
    }
  }

  const ifOpens = (source.match(/\{\{#if\s+([^}]*)\}\}/g) || []).length;
  const ifCloses = (source.match(/\{\{\/if\}\}/g) || []).length;
  if (ifOpens !== ifCloses) structural.push(`{{#if}} 与 {{/if}} 数量不一致（${ifOpens} / ${ifCloses}）`);

  const tokenRe = /\{\{\s*([^{}]*?)\s*\}\}/g;
  let match = tokenRe.exec(source);
  while (match) {
    const body = match[1];
    if (body.startsWith("#if")) {
      const parts = body.split(/\s+/);
      if (parts.length !== 2) tokenIssues.push(`{{#if}} 只接受一个变量：${match[0]}`);
      else {
        conditionals.push(parts[1]);
        if (!TEMPLATE_VARIABLES.includes(parts[1])) tokenIssues.push(`{{#if ${parts[1]}}} 里的变量不在白名单`);
      }
      match = tokenRe.exec(source);
      continue;
    }
    if (body.startsWith("/") || body.startsWith("#")) {
      tokenIssues.push(`不支持的标签：${match[0]}`);
      match = tokenRe.exec(source);
      continue;
    }
    const [name, ...rest] = body.split("|").map((part) => part.trim());
    if (!TEMPLATE_VARIABLES.includes(name)) tokenIssues.push(`未知变量 {{${name}}}（白名单见 ㉙）`);
    else variables.push(name);
    for (const raw of rest) {
      const parsed = FILTER_RE.exec(raw);
      if (!parsed) {
        tokenIssues.push(`过滤器写法不对：|${raw}`);
        continue;
      }
      const [, filterName, arg] = parsed;
      if (!TEMPLATE_FILTERS.includes(filterName)) tokenIssues.push(`未知过滤器 |${filterName}`);
      else {
        filters.push(filterName);
        if (filterName === "truncate" && !/^\d+$/.test(String(arg || ""))) tokenIssues.push("|truncate 需要数字参数，例如 |truncate:60");
        if (filterName === "date" && !/^[YMD\-/.]*$/.test(String(arg || ""))) tokenIssues.push(`|date 只认 YYYY-MM-DD 这类占位，实际：${arg}`);
      }
    }
    match = tokenRe.exec(source);
  }

  return {
    variables: Array.from(new Set(variables)),
    filters: Array.from(new Set(filters)),
    conditionals: Array.from(new Set(conditionals)),
    structural: Array.from(new Set(structural)),
    tokenIssues: Array.from(new Set(tokenIssues)),
    issues: Array.from(new Set([...structural, ...tokenIssues])),
  };
}

function formatDate(value, pattern) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return String(value);
  const pad = (n, len = 2) => String(n).padStart(len, "0");
  const map = {
    YYYY: String(date.getFullYear()),
    MM: pad(date.getMonth() + 1),
    DD: pad(date.getDate()),
    HH: pad(date.getHours()),
    mm: pad(date.getMinutes()),
    SS: pad(date.getSeconds()),
  };
  const format = pattern && pattern.trim() ? pattern.trim() : "YYYY-MM-DD";
  const replaced = format.replace(/YYYY|MM|DD|HH|mm|SS/g, (token) => map[token]);
  // 非占位符字符（如 `/` `.`）留在原样；只认 YYYY-MM-DD 这一族的写法
  return /^[YMD\-/.]+$/.test(format) ? replaced : replaced;
}

function applyFilter(value, name, arg) {
  const text = value === undefined || value === null ? "" : String(value);
  switch (name) {
    case "trim":
      return text.trim();
    case "upper":
      return text.toUpperCase();
    case "lower":
      return text.toLowerCase();
    case "truncate": {
      const limit = Number(arg);
      if (!Number.isFinite(limit) || limit <= 0) return text;
      return text.length > limit ? `${text.slice(0, limit)}…` : text;
    }
    case "date":
      return formatDate(text, arg);
    default:
      return text;
  }
}

function truthy(value) {
  if (value === undefined || value === null || value === false) return false;
  const text = String(value).trim();
  return text !== "" && text !== "0" && text.toLowerCase() !== "false";
}

/**
 * 渲染一个模板文本：`{{var}}` / `{{var|filter:arg}}` / `{{#if var}}…{{/if}}`。
 * 未知变量、未知过滤器一律**原样输出**（绝不猜、绝不静默吞掉）；
 * 结构性越界（`{{#each}}`/`{{else}}`/嵌套 `{{#if}}`/括号不配对）**整段原样输出**，
 * 以保证「超范围 → 原样输出」是字面意思，交给 `verify.mjs` V10 报错。
 */
export function renderTemplate(text, context = {}) {
  if (typeof text !== "string" || !text) return "";
  const ctx = context && typeof context === "object" ? context : {};

  // 结构性越界：整段原样返回，绝不做半吊子替换
  const scan = scanTemplate(text);
  if (scan.structural.length > 0) return text;

  // 先处理条件：只支持一层 {{#if var}}…{{/if}}
  let output = text.replace(/\{\{#if\s+([^{}\s]+)\s*\}\}([\s\S]*?)\{\{\/if\}\}/g, (whole, name, inner) => {
    if (!TEMPLATE_VARIABLES.includes(name)) return whole;
    return truthy(ctx[name]) ? inner : "";
  });

  output = output.replace(/\{\{\s*([^{}]*?)\s*\}\}/g, (whole, body) => {
    if (body.startsWith("#") || body.startsWith("/")) return whole;
    const [rawName, ...rawFilters] = body.split("|").map((part) => part.trim());
    if (!TEMPLATE_VARIABLES.includes(rawName)) return whole;
    let value = ctx[rawName];
    value = value === undefined || value === null ? "" : String(value);
    for (const raw of rawFilters) {
      const parsed = FILTER_RE.exec(raw);
      if (!parsed || !TEMPLATE_FILTERS.includes(parsed[1])) return whole;
      value = applyFilter(value, parsed[1], parsed[2]);
    }
    return value;
  });

  return output;
}

/* ───────────────────────── 应用到信封 ───────────────────────── */

/** 变量上下文：把抽取结果 + 高亮 + 正文拼成模板可用的 10 个变量。 */
export function templateContext(input = {}) {
  const content = typeof input.content === "string" ? input.content : "";
  return {
    title: input.title || "",
    url: input.url || "",
    site: input.site || "",
    author: input.author || "",
    publishedAt: input.publishedAt || "",
    capturedAt: input.capturedAt || "",
    selection: input.selection || "",
    highlights: input.highlights || "",
    content,
    wordCount: String(countWords(content)),
  };
}

/** 字数：CJK 按字计、西文按词计（与 popup 的「约 N 字」同一口径）。 */
export function countWords(text) {
  const source = typeof text === "string" ? text : "";
  const cjk = (source.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
  const words = (source.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g, " ").match(/[A-Za-z0-9_'-]+/g) || []).length;
  return cjk + words;
}

/**
 * 模板 → 信封意图。**纯函数**，不碰 storage、不发请求。
 * 返回 { title, folder, tags, notePath, conflict, properties, behavior, notes[] }
 *   - `conflict` 只可能是 `null`（缺省，绝不下发 "new"）或 `"append"`（且必须有 notePath）；
 *   - `behavior: "inbox"` **不产生任何 conflict**：进不进收件箱由应用侧设置决定（㉕）。
 */
export function applyTemplate(template, context = {}, overrides = {}) {
  const notes = [];
  const tpl = normalizeTemplate(template);
  const ctx = templateContext(context);

  // 标题：noteNameFormat 决定「笔记名」（接收端用它生成 H1 与文件名）
  let title = overrides.title || "";
  if (!title && tpl.noteNameFormat) {
    const rendered = renderTemplate(tpl.noteNameFormat, ctx).trim();
    if (rendered) title = rendered.slice(0, NOTE_NAME_MAX);
  }
  if (!title) title = ctx.title;

  // 属性：白名单键 → 渲染后的值；title / tags / target.folder 直接回落点，其余作为诊断备注
  const properties = {};
  for (const [key, format] of Object.entries(tpl.properties || {})) {
    const value = renderTemplate(format, ctx).trim();
    if (value) properties[key] = value;
  }
  if (properties.title && !overrides.title) title = properties.title.slice(0, NOTE_NAME_MAX);

  const folder = overrides.folder !== undefined && overrides.folder !== null && overrides.folder !== ""
    ? String(overrides.folder)
    : (properties["target.folder"] || tpl.folder || "");

  const tags = [];
  for (const tag of tpl.tags || []) tags.push(tag);
  if (properties.tags) {
    for (const tag of properties.tags.split(/[,\s]+/)) if (tag) tags.push(tag);
  }
  for (const tag of overrides.tags || []) tags.push(tag);

  // 追加落点：用户显式选择 > 模板 appendTo
  const notePath = (overrides.notePath || tpl.appendTo || "").trim();

  let conflict = null;
  if (tpl.behavior === "append") {
    if (notePath) conflict = "append";
    else notes.push("模板 behavior=append 但没有 appendTo/落点笔记 → 不下发 conflict，交给判定链");
  } else if (tpl.behavior === "inbox") {
    notes.push("模板 behavior=inbox 不代发指令：进不进收件箱由 Opennote 应用侧设置里的「先进入收件箱」决定（00 §6.14 ㉕）");
  }

  return {
    templateId: tpl.id,
    templateName: tpl.name,
    behavior: tpl.behavior,
    title,
    folder,
    tags: Array.from(new Set(tags)),
    notePath,
    conflict,
    properties,
    bodyFormat: tpl.bodyFormat,
    notes,
  };
}

/* ───────────────────────── 导入 / 导出 JSON ───────────────────────── */

export function exportTemplates(templates, options = {}) {
  const list = (Array.isArray(templates) ? templates : []).filter(Boolean).map((template) => {
    const normalized = normalizeTemplate(template);
    if (options.includeBuiltins) return normalized;
    return normalized;
  });
  return JSON.stringify(
    {
      spec: "opennote.templates/v1",
      exportedAt: new Date().toISOString(),
      templates: options.includeBuiltins === false ? list.filter((t) => !BUILTIN_TEMPLATES.some((b) => b.id === t.id)) : list,
    },
    null,
    2,
  );
}

/** 导入：接受 `{templates:[...]}` 或裸数组；逐条校验，坏模板不静默丢（进 problems）。 */
export function importTemplates(raw) {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { templates: [], problems: [`JSON 解析失败：${error.message}`] };
    }
  }
  const list = Array.isArray(parsed) ? parsed : parsed && Array.isArray(parsed.templates) ? parsed.templates : null;
  if (!list) return { templates: [], problems: ["导入内容既不是数组，也没有 templates 字段"] };
  const templates = [];
  const problems = [];
  list.forEach((item, index) => {
    const issues = validateTemplate(item);
    if (issues.length) {
      problems.push(`第 ${index + 1} 条：${issues.join("；")}`);
      return;
    }
    templates.push(normalizeTemplate(item));
  });
  if (templates.length > MAX_TEMPLATES) {
    problems.push(`超过 ${MAX_TEMPLATES} 个模板，多余的已忽略`);
    templates.length = MAX_TEMPLATES;
  }
  return { templates, problems };
}

/** 供 popup 显示：模板选择器的一项。 */
export function templateOption(template, options = {}) {
  const tpl = normalizeTemplate(template);
  return {
    id: tpl.id,
    name: tpl.name,
    builtin: Boolean(options.builtin),
    priority: tpl.priority,
    folder: tpl.folder,
    tags: tpl.tags,
    triggers: tpl.triggers,
    behavior: tpl.behavior,
    summary: tpl.triggers.length ? tpl.triggers.map((trigger) => `${trigger.type}:${trigger.value}`).join(" · ") : "无触发条件（兜底）",
  };
}
