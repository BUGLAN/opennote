/**
 * 模板系统单测（00 §6.14 ㉙）。
 *
 * 覆盖 task-13 验收里的两条硬要求：
 *   ① 模板匹配：priority 降序 / domain / path / url / 无命中兜底
 *   ② 每个变量与每个过滤器**各一条**断言（10 个变量 + 5 个过滤器，缺一个就少一条）
 * 另加：极简 `{{#if}}` 的边界（越界语法原样输出且被报出）、导入导出往返、
 * 以及「模板绝不变出 conflict: new」（§6.13⑳ 红线）。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  BUILTIN_TEMPLATES,
  MAX_TEMPLATES,
  PROPERTY_KEYS,
  TEMPLATE_BEHAVIORS,
  TEMPLATE_FILTERS,
  TEMPLATE_KEYS,
  TEMPLATE_VARIABLES,
  TRIGGER_TYPES,
  applyTemplate,
  countWords,
  domainOf,
  exportTemplates,
  importTemplates,
  matchTemplate,
  normalizeTemplate,
  pathOf,
  renderTemplate,
  scanTemplate,
  templateContext,
  templateHit,
  templateOption,
  triggerHit,
  validateTemplate,
  withBuiltins,
} from "../src/lib/templates.js";

const CTX = templateContext({
  title: "中文排版指北",
  url: "https://example.com/docs/post",
  site: "example.com",
  author: "小林",
  publishedAt: "2026-09-20T10:00:00+08:00",
  capturedAt: "2026-09-29T21:04:11+08:00",
  selection: "选中的一句话。",
  highlights: "## 高亮\n\n> 摘录",
  content: "正文第一段。\n\n正文第二段。",
});

/* ─────────────────── 白名单与内置模板 ─────────────────── */

test("白名单逐字对齐 ㉙（变量 / 过滤器 / 触发器 / behavior / 属性）", () => {
  assert.deepEqual([...TEMPLATE_VARIABLES], [
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
  assert.deepEqual([...TEMPLATE_FILTERS], ["date", "upper", "lower", "trim", "truncate"]);
  assert.deepEqual([...TRIGGER_TYPES], ["url", "domain", "path"]);
  assert.deepEqual([...TEMPLATE_BEHAVIORS], ["new", "append", "inbox"]);
  assert.deepEqual([...PROPERTY_KEYS], [
    "title",
    "source.url",
    "source.title",
    "source.site",
    "author",
    "publishedAt",
    "tags",
    "target.folder",
  ]);
  assert.deepEqual([...TEMPLATE_KEYS].sort(), [
    "appendTo",
    "behavior",
    "bodyFormat",
    "folder",
    "id",
    "name",
    "noteNameFormat",
    "priority",
    "properties",
    "tags",
    "triggers",
  ]);
});

test("内置 3 个开箱模板：默认 / 论文 / 视频", () => {
  assert.equal(BUILTIN_TEMPLATES.length, 3);
  const byName = Object.fromEntries(BUILTIN_TEMPLATES.map((template) => [template.name, template]));
  assert.ok(byName["默认"]);
  assert.deepEqual(byName["论文"].triggers.map((trigger) => trigger.value), ["arxiv.org", "doi.org"]);
  assert.deepEqual(byName["视频"].triggers.map((trigger) => trigger.value), ["youtube.com", "bilibili.com"]);
  for (const template of BUILTIN_TEMPLATES) {
    assert.deepEqual(validateTemplate(template), [], `${template.name} 必须合法`);
  }
});

/* ─────────────────── ① 匹配：priority / domain / path / url / 兜底 ─────────────────── */

test("匹配：priority 降序，第一个命中 triggers 的模板生效", () => {
  const templates = [
    { id: "low", name: "低", triggers: [{ type: "domain", value: "example.com" }], priority: 1 },
    { id: "high", name: "高", triggers: [{ type: "domain", value: "example.com" }], priority: 9 },
    { id: "mid", name: "中", triggers: [{ type: "domain", value: "example.com" }], priority: 5 },
  ];
  const picked = matchTemplate(templates, "https://example.com/a");
  assert.equal(picked.template.id, "high");
  assert.equal(picked.matchedBy, "domain:example.com");
  assert.equal(picked.fallback, false);
  // 命中即停：轨迹里只记录「试到命中为止」，能解释为什么是它
  assert.deepEqual(picked.tried.map((item) => item.id), ["high"]);
  assert.equal(picked.tried[0].hit, true);
});

test("匹配：domain / path / url 三种触发器各自命中，无命中回退内置默认模板", () => {
  assert.equal(triggerHit({ type: "domain", value: "example.com" }, "https://www.example.com/x"), true, "子域也算命中");
  assert.equal(triggerHit({ type: "domain", value: "example.com" }, "https://notexample.com/x"), false);
  assert.equal(triggerHit({ type: "path", value: "/docs/" }, "https://x.test/docs/a/b"), true);
  assert.equal(triggerHit({ type: "path", value: "/docs/" }, "https://x.test/blog/a"), false);
  assert.equal(triggerHit({ type: "url", value: "https://x.test/*/b" }, "https://x.test/docs/b"), true);
  assert.equal(triggerHit({ type: "url", value: "https://x.test/*/b" }, "https://x.test/docs/c"), false);
  assert.equal(domainOf("https://www.Example.com/a"), "example.com");
  assert.equal(pathOf("https://example.com/a?b=1#c"), "/a?b=1");

  const byPath = matchTemplate([{ id: "p", name: "路径", triggers: [{ type: "path", value: "/docs/" }], priority: 3 }], "https://x.test/docs/a");
  assert.equal(byPath.template.id, "p");
  const byUrl = matchTemplate([{ id: "u", name: "网址", triggers: [{ type: "url", value: "https://x.test/*/b" }], priority: 3 }], "https://x.test/docs/b");
  assert.equal(byUrl.template.id, "u");

  const none = matchTemplate([{ id: "p", name: "路径", triggers: [{ type: "path", value: "/docs/" }], priority: 3 }], "https://other.test/x");
  assert.equal(none.fallback, true);
  assert.equal(none.template.id, "builtin-default");
});

test("匹配：论文 / 视频模板按真实站点 URL 命中", () => {
  const templates = withBuiltins([]);
  assert.equal(matchTemplate(templates, "https://arxiv.org/abs/2401.00001").template.name, "论文");
  assert.equal(matchTemplate(templates, "https://doi.org/10.1000/xyz").template.name, "论文");
  assert.equal(matchTemplate(templates, "https://www.youtube.com/watch?v=abc").template.name, "视频");
  assert.equal(matchTemplate(templates, "https://www.bilibili.com/video/BV1xx").template.name, "视频");
  assert.equal(matchTemplate(templates, "https://blog.test/post").fallback, true, "普通站点走默认模板");
});

/* ─────────────────── ② 每个变量与过滤器各一条 ─────────────────── */

test("10 个变量各渲染一条", () => {
  assert.equal(renderTemplate("{{title}}", CTX), "中文排版指北");
  assert.equal(renderTemplate("{{url}}", CTX), "https://example.com/docs/post");
  assert.equal(renderTemplate("{{site}}", CTX), "example.com");
  assert.equal(renderTemplate("{{author}}", CTX), "小林");
  assert.equal(renderTemplate("{{publishedAt}}", CTX), "2026-09-20T10:00:00+08:00");
  assert.equal(renderTemplate("{{capturedAt}}", CTX), "2026-09-29T21:04:11+08:00");
  assert.equal(renderTemplate("{{selection}}", CTX), "选中的一句话。");
  assert.equal(renderTemplate("{{highlights}}", CTX), "## 高亮\n\n> 摘录");
  assert.equal(renderTemplate("{{content}}", CTX), "正文第一段。\n\n正文第二段。");
  assert.equal(renderTemplate("{{wordCount}}", CTX), String(countWords("正文第一段。\n\n正文第二段。")));
  // 白名单里的每个变量都确实能取到值（少一个就会在这里红）
  for (const name of TEMPLATE_VARIABLES) {
    assert.notEqual(renderTemplate(`{{${name}}}`, CTX), `{{${name}}}`, `变量 ${name} 没有被替换`);
  }
});

test("5 个过滤器各渲染一条（含链式）", () => {
  assert.equal(renderTemplate("{{capturedAt|date:YYYY-MM-DD}}", CTX), "2026-09-29");
  assert.equal(renderTemplate("{{title|upper}}", CTX), "中文排版指北".toUpperCase());
  assert.equal(renderTemplate("{{site|upper}}", CTX), "EXAMPLE.COM");
  assert.equal(renderTemplate("{{site|lower}}", { site: "Example.COM" }), "example.com");
  assert.equal(renderTemplate("{{author|trim}}", { author: "  小林  " }), "小林");
  assert.equal(renderTemplate("{{content|truncate:6}}", CTX), "正文第一段。…");
  // 链式：trim → upper → truncate
  assert.equal(renderTemplate("{{site|trim|upper|truncate:4}}", { site: "  example.com " }), "EXAM…");
  for (const name of TEMPLATE_FILTERS) {
    const rendered = renderTemplate(`{{title|${name}${name === "date" ? ":YYYY" : name === "truncate" ? ":3" : ""}}}`, CTX);
    assert.notEqual(rendered, `{{title|${name}${name === "date" ? ":YYYY" : name === "truncate" ? ":3" : ""}}}`, `过滤器 ${name} 没有生效`);
  }
});

test("{{wordCount}} 与 popup 的「约 N 字」同口径（CJK 按字 + 西文按词）", () => {
  assert.equal(countWords("中文四个字"), 5);
  assert.equal(countWords("hello world"), 2);
  assert.equal(countWords("中文 hello 世界"), 5);
  assert.equal(countWords(""), 0);
});

/* ─────────────────── 极简 {{#if}}：只认一层 ─────────────────── */

test("{{#if}} 只认一层变量，空值整段消失", () => {
  assert.equal(renderTemplate("{{#if author}}作者：{{author}}{{/if}}", CTX), "作者：小林");
  assert.equal(renderTemplate("{{#if author}}作者：{{author}}{{/if}}", { author: "   " }), "");
  assert.equal(renderTemplate("{{#if author}}有作者{{/if}}", { author: "" }), "");
  assert.equal(renderTemplate("{{#if wordCount}}有字数{{/if}}", { wordCount: "0" }), "", "0 / false 视为空");
});

test("超出范围的写法一律原样输出，并被 scanTemplate 报出来（verify V10 据此报错）", () => {
  const cases = [
    "{{#each tags}}{{name}}{{/each}}",
    "{{#if a}}x{{else}}y{{/if}}",
    "{{#unless author}}x{{/unless}}",
    "{{> partial}}",
    "{{#if author}}{{#if title}}x{{/if}}{{/if}}",
  ];
  for (const source of cases) {
    assert.equal(renderTemplate(source, CTX), source, `必须原样输出：${source}`);
    assert.ok(scanTemplate(source).issues.length > 0, `必须被报出来：${source}`);
  }
  assert.ok(scanTemplate("{{nope}}").issues.some((issue) => issue.includes("未知变量")));
  assert.ok(scanTemplate("{{title|weird}}").issues.some((issue) => issue.includes("未知过滤器")));
  assert.ok(scanTemplate("{{title").issues.some((issue) => issue.includes("不配对")));
  assert.equal(renderTemplate("{{nope}}", CTX), "{{nope}}", "未知变量原样输出，不静默清空");
});

/* ─────────────────── 应用到信封：追加落点与 conflict 纪律 ─────────────────── */

test("模板 application：noteNameFormat 决定标题、tags 合并、folder 生效", () => {
  const applied = applyTemplate(
    {
      id: "paper",
      name: "论文",
      triggers: [{ type: "domain", value: "arxiv.org" }],
      priority: 20,
      folder: "文献",
      tags: ["论文", "论文"],
      noteNameFormat: "{{title}} · {{site}}",
      properties: { author: "{{author}}", publishedAt: "{{publishedAt|date:YYYY-MM-DD}}" },
      behavior: "new",
    },
    CTX,
  );
  assert.equal(applied.title, "中文排版指北 · example.com");
  assert.equal(applied.folder, "文献");
  assert.deepEqual(applied.tags, ["论文"]);
  assert.equal(applied.properties.author, "小林");
  assert.equal(applied.properties.publishedAt, "2026-09-20");
  assert.equal(applied.conflict, null, "behavior=new 不下发 conflict");
});

test("behavior=append + appendTo → 写进 target.notePath 且 conflict=append", () => {
  const applied = applyTemplate({ id: "ap", name: "追加", behavior: "append", appendTo: "笔记/读书.md" }, CTX);
  assert.equal(applied.notePath, "笔记/读书.md");
  assert.equal(applied.conflict, "append");
});

test("behavior=inbox 不代发 conflict（进收件箱由应用侧设置决定，§6.14㉕）", () => {
  const applied = applyTemplate({ id: "in", name: "收件箱", behavior: "inbox" }, CTX);
  assert.equal(applied.conflict, null);
  assert.ok(applied.notes.some((note) => note.includes("应用侧")), "必须留一条说明：插件不代发这条指令");
});

test("behavior=append 但没有落点：不下发 conflict，并如实留说明", () => {
  const applied = applyTemplate({ id: "ap2", name: "追加无落点", behavior: "append" }, CTX);
  assert.equal(applied.conflict, null);
  assert.equal(applied.notePath, "");
  assert.ok(applied.notes.some((note) => note.includes("没有 appendTo")));
});

test("模板绝不变出 conflict: \"new\"（§6.13⑳ 红线）", () => {
  const json = exportTemplates(BUILTIN_TEMPLATES);
  assert.equal(/conflict\s*[:=]\s*"new"/.test(json), false);
  for (const behavior of TEMPLATE_BEHAVIORS) {
    const applied = applyTemplate({ id: behavior, name: behavior, behavior, appendTo: "x.md" }, CTX);
    if (behavior === "append") assert.equal(applied.conflict, "append");
    else assert.equal(applied.conflict, null, `${behavior} 不得产生 conflict`);
  }
});

test("属性面板白名单：properties 里白名单外的键被 validateTemplate 拒绝", () => {
  assert.deepEqual(validateTemplate({ id: "a", name: "a", properties: { capturedAt: "{{capturedAt}}" } }).length, 1);
  assert.deepEqual(validateTemplate({ id: "a", name: "a", properties: { title: "{{title}}" } }), []);
  assert.ok(validateTemplate({ id: "a", name: "a", triggers: [{ type: "weird", value: "x" }] }).length > 0);
  assert.ok(validateTemplate({ id: "a", name: "a", behavior: "overwrite" }).length > 0, "overwrite 不在 behavior 白名单里");
  assert.ok(validateTemplate({ id: "a", name: "a", nope: 1 }).some((problem) => problem.includes("未知字段")));
  assert.ok(validateTemplate({ id: "a", name: "a", noteNameFormat: "{{#each x}}{{y}}{{/each}}" }).some((problem) => problem.includes("超范围")));
});

test("归一化：补默认值、去重 tags、丢弃非法 trigger，绝不改字段名", () => {
  const normalized = normalizeTemplate({
    id: "  t1 ",
    name: " 我的模板 ",
    triggers: [{ type: "domain", value: " a.test " }, { type: "bogus", value: "x" }, { type: "path" }],
    tags: ["a", "a", "", 3, "b"],
    properties: { title: "{{title}}", nope: "x" },
  });
  assert.equal(normalized.id, "t1");
  assert.equal(normalized.name, "我的模板");
  assert.deepEqual(normalized.triggers, [{ type: "domain", value: "a.test" }]);
  assert.deepEqual(normalized.tags, ["a", "b"]);
  assert.deepEqual(Object.keys(normalized.properties), ["title"]);
  assert.equal(normalized.behavior, "new");
  assert.deepEqual(Object.keys(normalized).sort(), [
    "appendTo",
    "behavior",
    "bodyFormat",
    "folder",
    "id",
    "name",
    "noteNameFormat",
    "priority",
    "properties",
    "tags",
    "triggers",
  ]);
});

test("导入 / 导出 JSON：往返一致，坏数据进 problems 不静默", () => {
  const exported = exportTemplates([{ id: "rt", name: "往返", triggers: [{ type: "domain", value: "rt.test" }], priority: 2 }], { includeBuiltins: false });
  const parsed = JSON.parse(exported);
  assert.equal(parsed.spec, "opennote.templates/v1");
  assert.equal(parsed.templates.length, 1);
  const imported = importTemplates(exported);
  assert.equal(imported.problems.length, 0);
  assert.equal(imported.templates[0].id, "rt");

  assert.deepEqual(importTemplates("[1,2").templates, []);
  assert.ok(importTemplates("[1,2").problems[0].includes("JSON 解析失败"));
  const mixed = importTemplates([{ id: "ok", name: "ok" }, { id: "bad", name: "bad", properties: { nope: "x" } }]);
  assert.equal(mixed.templates.length, 1);
  assert.equal(mixed.problems.length, 1);
  const many = importTemplates(Array.from({ length: MAX_TEMPLATES + 2 }, (_, index) => ({ id: `t${index}`, name: `t${index}` })));
  assert.equal(many.templates.length, MAX_TEMPLATES);
  assert.ok(many.problems.some((problem) => problem.includes("超过")));
});

test("popup 用的一行摘要：触发器与 behavior 都可读", () => {
  const option = templateOption(BUILTIN_TEMPLATES[1], { builtin: true });
  assert.equal(option.name, "论文");
  assert.equal(option.builtin, true);
  assert.equal(option.summary, "domain:arxiv.org · domain:doi.org");
  assert.equal(templateOption(BUILTIN_TEMPLATES[0]).summary, "无触发条件（兜底）");
});
