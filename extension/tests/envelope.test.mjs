/**
 * 信封构造单测（node --test，无依赖）。
 * 覆盖 task-5 验收项：`spec` 值、字段集合、tags 过滤、`capturedAt` ISO 格式、
 * `client{name,version}`、`selection` 判定输入、以及「扩展一律不发 overwrite」。
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  ENVELOPE_KEYS,
  REQUIRED_ENVELOPE_KEYS,
  SOURCE_KEYS,
  TARGET_KEYS,
  MAX_BODY_BYTES,
  ISO_WITH_TZ_RE,
  IMPORT_ID_RE,
  buildEnvelope,
  bodyByteLength,
  envelopeProblems,
  filterTags,
  filterTagsDetailed,
  newImportId,
  normalizeEol,
  sanitizeTitle,
  toLocalIso,
} from "../src/lib/envelope.js";
import { SPEC, CLIENT_NAME, CLIENT_VERSION, KNOWN_CODES, isKnownCode, userMessage } from "../src/lib/errors.js";

const base = () => ({
  importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
  title: "中文排版指北",
  body: "正文第一段。\r\n\r\n第二段。",
  url: "https://example.com/post?utm=1",
  pageTitle: "中文排版指北 · 示例站",
  site: "example.com",
  author: "小林",
  publishedAt: "2026-09-20T10:00:00+08:00",
  capturedAt: "2026-09-29T21:04:11+08:00",
  selection: true,
  folder: "剪藏/排版",
  tags: ["排版"],
});

test("spec 恒为 opennote.import/v1", () => {
  assert.equal(SPEC, "opennote.import/v1");
  assert.equal(buildEnvelope(base()).spec, SPEC);
});

test("顶层字段集合与契约逐字一致（不增不减；conflict 可选且默认不下发）", () => {
  const envelope = buildEnvelope(base());
  assert.deepEqual(Object.keys(envelope), [...REQUIRED_ENVELOPE_KEYS]);
  assert.deepEqual(Object.keys(envelope), ENVELOPE_KEYS.filter((key) => key !== "conflict"));
  assert.ok(!("conflict" in envelope), "默认信封信里不得有 conflict 键（判定链第 3/4 步的前提）");
  assert.deepEqual(Object.keys(envelope.source), [...SOURCE_KEYS]);
  assert.deepEqual(Object.keys(envelope.target), [...TARGET_KEYS]);
  assert.deepEqual(Object.keys(envelope.client), ["name", "version"]);
  // JSON 往返后字段集合不变（确认没有 undefined 被序列化丢掉/多出来）
  assert.deepEqual(Object.keys(JSON.parse(JSON.stringify(envelope))), [...REQUIRED_ENVELOPE_KEYS]);
});

test("client.name 必须是 chrome-extension，version 是字符串", () => {
  const envelope = buildEnvelope(base());
  assert.equal(envelope.client.name, CLIENT_NAME);
  assert.equal(envelope.client.name, "chrome-extension");
  assert.equal(envelope.client.version, CLIENT_VERSION);
  assert.equal(typeof envelope.client.version, "string");
  assert.match(envelope.client.version, /^\d+\.\d+\.\d+$/);
});

test("capturedAt 缺省 = 现在，且 ISO 8601 必带时区", () => {
  const envelope = buildEnvelope({ ...base(), capturedAt: undefined });
  assert.match(envelope.source.capturedAt, ISO_WITH_TZ_RE);
  assert.ok(!Number.isNaN(Date.parse(envelope.source.capturedAt)));
  const drift = Math.abs(Date.now() - Date.parse(envelope.source.capturedAt));
  assert.ok(drift < 5000, `capturedAt 与现在相差 ${drift}ms`);
  // 本机时区偏移形态（+08:00 / -05:00 / Z）
  assert.match(envelope.source.capturedAt, /(?:Z|[+-]\d{2}:\d{2})$/);
});

test("toLocalIso 带本机偏移且能被 Date 解析", () => {
  const iso = toLocalIso(new Date(2026, 8, 29, 21, 4, 11));
  assert.equal(iso.slice(0, 19), "2026-09-29T21:04:11");
  assert.match(iso, /[+-]\d{2}:\d{2}$/);
  assert.equal(new Date(iso).getTime(), new Date(2026, 8, 29, 21, 4, 11).getTime());
});

test("source.selection 是判定输入，必须如实反映剪藏范围", () => {
  assert.equal(buildEnvelope({ ...base(), selection: true }).source.selection, true);
  assert.equal(buildEnvelope({ ...base(), selection: false }).source.selection, false);
  assert.equal(buildEnvelope({ ...base(), selection: undefined }).source.selection, false);
});

test("tags 客户端自行过滤：逗号/换行/[]/纯数字/字符集/去重/截断/上限", () => {
  assert.deepEqual(
    filterTags(["排版, 网页剪藏", "20240929", "a\nb", "[引用]", "标签 y", "标签y", "标签y"]),
    ["排版", "网页剪藏", "ab", "引用", "标签y"],
  );
  assert.deepEqual(filterTags(["2024", "  ", "第 2 章"]), ["第2章"]);
  // 超过 32 字符 → 截断到 32
  const long = "字".repeat(40);
  const tags = filterTags([long]);
  assert.equal(tags.length, 1);
  assert.equal(tags[0].length, 32);
  // 字符集收紧：`-` `/` `_` 与中日韩/拉丁字母数字保留，其它去掉
  assert.deepEqual(filterTags(["a-b/c_d", "emoji😀tag", "日语タグ", "русский"]), ["a-b/c_d", "emojitag", "日语タグ", "русский"]);
  // 去重后数量上限 32
  const many = Array.from({ length: 40 }, (_, i) => `标签${i}`);
  assert.equal(filterTags(many).length, 32);
  // 字符串入参（popup 的输入框）按逗号拆
  assert.deepEqual(filterTags("排版, 网页剪藏"), ["排版", "网页剪藏"]);
  // 被丢弃的原因可追溯（排障用）
  const detail = filterTagsDetailed(["123", "😀"]);
  assert.equal(detail.tags.length, 0);
  assert.ok(detail.dropped.some((d) => d.reason === "pure-digits"));
  assert.ok(detail.dropped.some((d) => d.reason === "empty-after-filter"));
});

test("source.url 只允许 http(s)，其余置 null；site 缺省从 url 推导", () => {
  assert.equal(buildEnvelope({ ...base(), url: "javascript:alert(1)" }).source.url, null);
  assert.equal(buildEnvelope({ ...base(), url: "data:text/html,<b>x</b>" }).source.url, null);
  assert.equal(buildEnvelope({ ...base(), url: "file:///c:/a.html" }).source.url, null);
  assert.equal(buildEnvelope({ ...base(), url: "" }).source.url, null);
  assert.equal(buildEnvelope({ ...base(), url: null }).source.url, null);
  assert.equal(buildEnvelope({ ...base(), url: "http://127.0.0.1:5173/x" }).source.url, "http://127.0.0.1:5173/x");
  const derived = buildEnvelope({ ...base(), site: null, url: "https://news.example.org/a/b" });
  assert.equal(derived.source.site, "news.example.org");
});

test("不可解析的发布时间 → null（只 warning，不失败）", () => {
  assert.equal(buildEnvelope({ ...base(), publishedAt: "上周三" }).source.publishedAt, null);
  assert.equal(buildEnvelope({ ...base(), publishedAt: "" }).source.publishedAt, null);
  assert.equal(buildEnvelope({ ...base(), publishedAt: base().publishedAt }).source.publishedAt, "2026-09-20T10:00:00+08:00");
});

test("title：trim + 截断到 200；空 title 交给服务端判 IMP-4003", () => {
  assert.equal(sanitizeTitle("  x  "), "x");
  assert.equal(sanitizeTitle("字".repeat(300)).length, 200);
  assert.equal(buildEnvelope({ ...base(), title: "" }).title, "");
  assert.ok(envelopeProblems(buildEnvelope({ ...base(), title: "" })).includes("title 不能为空"));
});

test("body 归一化换行为 LF，空 body 合法（整页抽取为空时仍要发）", () => {
  assert.equal(buildEnvelope(base()).body, "正文第一段。\n\n第二段。");
  assert.equal(normalizeEol("a\r\nb\rc"), "a\nb\nc");
  const empty = buildEnvelope({ ...base(), body: "" });
  assert.equal(empty.body, "");
  assert.deepEqual(envelopeProblems(empty), []);
});

test("conflict 默认缺省（交给接收端判定链）；显式只接受 new/append/skip；永不发 overwrite", () => {
  // 缺省：这是判定链第 3 步（选区二次剪藏 → appended）与第 4 步（整页二次剪藏 → 收件箱）生效的前提
  assert.ok(!("conflict" in buildEnvelope(base())));
  assert.ok(!("conflict" in buildEnvelope({ ...base(), conflict: null })));
  assert.ok(!("conflict" in buildEnvelope({ ...base(), conflict: undefined })));
  // 显式：只在调用方真的要求策略时才写这个键
  assert.equal(buildEnvelope({ ...base(), conflict: "append" }).conflict, "append");
  assert.equal(buildEnvelope({ ...base(), conflict: "skip" }).conflict, "skip");
  assert.equal(buildEnvelope({ ...base(), conflict: "new" }).conflict, "new");
  // 红线：overwrite 永远不接受（02 §5.2），既不下发也不放行
  assert.ok(!("conflict" in buildEnvelope({ ...base(), conflict: "overwrite" })));
  const forged = buildEnvelope(base());
  forged.conflict = "overwrite";
  assert.ok(envelopeProblems(forged).some((p) => p.includes("conflict")));
  // 缺省不算「缺字段」
  assert.deepEqual(envelopeProblems(buildEnvelope(base())), []);
});

test("importId 缺省生成合法 UUID 且落在 [A-Za-z0-9_-]{8,128}", () => {
  const envelope = buildEnvelope({ ...base(), importId: undefined });
  assert.match(envelope.importId, IMPORT_ID_RE);
  assert.notEqual(newImportId(), newImportId());
  assert.equal(newImportId().length, 36);
});

test("envelopeProblems 对正常信封零问题，对坏信封逐条指出", () => {
  assert.deepEqual(envelopeProblems(buildEnvelope(base())), []);
  const bad = buildEnvelope(base());
  bad.spec = "opennote.import/v2";
  bad.source.capturedAt = "2026-09-29 21:04:11";
  bad.tags = ["a,b"];
  bad.extra = 1;
  const problems = envelopeProblems(bad);
  assert.ok(problems.some((p) => p.includes("spec")));
  assert.ok(problems.some((p) => p.includes("capturedAt")));
  assert.ok(problems.some((p) => p.includes("标签不合规")));
  assert.ok(problems.some((p) => p.includes("未定义字段：extra")));
});

test("body 体积上限 8 MiB（超限交给 IMP-4004，不截断）", () => {
  assert.equal(MAX_BODY_BYTES, 8 * 1024 * 1024);
  assert.equal(bodyByteLength("中"), 3);
  const big = buildEnvelope({ ...base(), body: "a".repeat(MAX_BODY_BYTES + 1) });
  assert.ok(envelopeProblems(big).some((p) => p.includes("8 MiB")));
  assert.equal(big.body.length, MAX_BODY_BYTES + 1, "不得截断用户原文");
});

test("错误码总表覆盖契约 A.3 的全部 IMP 码（不存在「未知错误」兜底）", () => {
  // 基准：docs/import/02 §A.3 错误码索引（33 条）
  const index = [
    "IMP-1001", "IMP-1002", "IMP-1003", "IMP-1004", "IMP-1005", "IMP-1006",
    "IMP-2001", "IMP-2002", "IMP-2003", "IMP-2004",
    "IMP-3001", "IMP-3002", "IMP-3003", "IMP-3004", "IMP-3005",
    "IMP-4001", "IMP-4002", "IMP-4003", "IMP-4004", "IMP-4005", "IMP-4006", "IMP-4007",
    "IMP-4008", "IMP-4009", "IMP-4010", "IMP-4011", "IMP-4012", "IMP-4013", "IMP-4014",
    "IMP-4015", "IMP-4017", "IMP-4020", "IMP-5001",
  ];
  assert.equal(index.length, 33);
  assert.deepEqual([...KNOWN_CODES].sort(), [...index].sort());
  for (const code of index) {
    assert.ok(isKnownCode(code), `缺少错误码 ${code}`);
    // 契约明令「不进用户视野」的 4 条：IMP-1005（Host 校验）、IMP-3001（进设置面板拒绝日志）、
    // IMP-3004/3005（客户端自身构造错误，正常路径不可达）→ 允许没有用户文案
    const noMessage = ["IMP-1005", "IMP-3001", "IMP-3004", "IMP-3005"];
    assert.ok(userMessage(code) || noMessage.includes(code), `${code} 缺少用户文案`);
  }
  // 逐字文案（02 §6.2 + 03 §UI-01 覆盖）
  assert.equal(
    userMessage("IMP-1001"),
    "本地接口未开启。打开桌面版 Opennote 的「设置 · 文件 · 导入与接口」，开启本地接口后重试。",
  );
  assert.equal(userMessage("IMP-4006"), "Opennote 的窗口已关闭。请重新打开 Opennote，再试一次。");
  assert.equal(userMessage("IMP-2001"), "这个客户端还没有配对。请在 Opennote 的「导入与接口」里点「配对新客户端」，输入显示的 6 位配对码。");
  assert.equal(userMessage("IMP-2002"), "访问令牌不正确或已失效。重新生成令牌后，请在客户端里更新。");
  assert.equal(userMessage("IMP-2004"), "配对码不正确或已过期，请在 Opennote 里重新生成。");
  assert.equal(userMessage("IMP-4007"), "Opennote 里还没有打开笔记本，请先打开一个文件夹（或新建浏览器笔记本）。");
  assert.equal(userMessage("IMP-4008"), "目标目录不合法：不能使用 `..`、绝对路径或系统保留字符。");
  assert.equal(userMessage("IMP-4009"), "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。");
  // 服务端 userMessage 就近优先
  assert.equal(userMessage("IMP-4008", "服务端原句"), "服务端原句");
  // 契约明令不可见的三个码
  assert.equal(userMessage("IMP-1005"), null);
  assert.equal(userMessage("IMP-3004"), null);
});
