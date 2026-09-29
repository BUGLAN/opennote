import { describe, expect, it } from "vitest";
import {
  IMPORT_ERRORS,
  IMPORT_WARNINGS,
  MAX_ASSETS,
  decodeBase64,
  encodeBase64,
  importProblem,
  isImportRejection,
  isSafeSvg,
  isTimestampWithTimezone,
  normalizeFolder,
  normalizeNotePath,
  sanitizeTags,
  serializeEnvelopeJson,
  toImportErrorBody,
  validateEnvelope,
  validateImportEnvelope,
  warningText,
  ImportRejection,
  type ImportEnvelope,
} from "./envelope";

/** 一个合法信封；`overrides` 走浅合并，够用且读起来像测试数据。 */
function envelope(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    spec: "opennote.import/v1",
    importId: "0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e88",
    title: "写给工程师的本地优先笔记",
    body: "在浏览器里剪下的一段话。",
    source: {
      url: "https://example.com/posts/local-first",
      title: "Local-first notes for engineers",
      site: "example.com",
      author: "张三",
      publishedAt: "2026-08-14T09:30:00+08:00",
      capturedAt: "2026-09-29T21:04:11+08:00",
      selection: false,
    },
    target: { folder: "剪藏/技术", notePath: null },
    conflict: "new",
    tags: ["剪藏", "本地优先"],
    assets: [],
    client: { name: "chrome-extension", version: "0.1.4" },
    ...overrides,
  };
}

function ok(value: unknown): ImportEnvelope {
  const result = validateImportEnvelope(value);
  if (!result.ok) throw new Error(`期望校验通过，实际 ${result.problem.code}`);
  return result.envelope;
}

function codeOf(value: unknown): string {
  const result = validateImportEnvelope(value);
  return result.ok ? "OK" : result.problem.code;
}

describe("信封校验（契约 §2 / §10.1）", () => {
  it("spec 缺失 / v2 / 大小写不同 → IMP-4002", () => {
    expect(codeOf(envelope({ spec: undefined }))).toBe("IMP-4002");
    expect(codeOf(envelope({ spec: "opennote.import/v2" }))).toBe("IMP-4002");
    expect(codeOf(envelope({ spec: "Opennote.Import/V1" }))).toBe("IMP-4002");
  });

  it("顶层不是对象 / 数组 / null → IMP-4001", () => {
    expect(codeOf(null)).toBe("IMP-4001");
    expect(codeOf([])).toBe("IMP-4001");
    expect(codeOf("x")).toBe("IMP-4001");
  });

  it("importId 长度与字符集受限", () => {
    expect(codeOf(envelope({ importId: "short" }))).toBe("IMP-4003");
    expect(codeOf(envelope({ importId: "a".repeat(129) }))).toBe("IMP-4003");
    expect(codeOf(envelope({ importId: "有中文的标识符" }))).toBe("IMP-4003");
    expect(codeOf(envelope({ importId: "abcdefgh" }))).toBe("OK");
  });

  it("title 空串 → IMP-4003；201 字符 → 截断 + warning", () => {
    expect(codeOf(envelope({ title: "" }))).toBe("IMP-4003");
    expect(codeOf(envelope({ title: "   " }))).toBe("IMP-4003");
    expect(codeOf(envelope({ title: undefined }))).toBe("IMP-4003");
    const parsed = ok(envelope({ title: "字".repeat(201) }));
    expect(parsed.title).toHaveLength(200);
    expect(parsed.warnings.some((item) => item.includes("截断"))).toBe(true);
  });

  it("body 缺失 → IMP-4003；空正文 → 成功 + IMP-W001；body 与 bodyFile 必须二选一", () => {
    expect(codeOf(envelope({ body: undefined }))).toBe("IMP-4003");
    expect(codeOf(envelope({ body: null }))).toBe("IMP-4003");
    expect(codeOf(envelope({ body: 123 }))).toBe("IMP-4003");
    const parsed = ok(envelope({ body: "" }));
    expect(parsed.warnings).toContain("IMP-W001 正文为空，只写入了标题。");
    // 外置形态：body 为 null 时必须给 bodyFile。
    expect(codeOf(envelope({ body: null, bodyFile: "clip/body.md" }))).toBe("OK");
    expect(codeOf(envelope({ body: null, bodyFile: "../x.md" }))).toBe("IMP-4003");
  });

  it("capturedAt 必填且必须含时区", () => {
    expect(codeOf(envelope({ source: { capturedAt: undefined } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00" } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-13-45T21:00:00+08:00" } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z" } }))).toBe("OK");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00+08:00" } }))).toBe("OK");
    expect(isTimestampWithTimezone("2026-09-29T21:00:00+0800")).toBe(true);
    expect(isTimestampWithTimezone("2026-09-29 21:00:00+08:00")).toBe(true);
    expect(isTimestampWithTimezone("2026-09-29T21:00:00")).toBe(false);
  });

  it("source.url 只接受 http(s)；null 允许", () => {
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", url: "javascript:alert(1)" } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", url: "file:///etc/passwd" } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", url: "data:text/plain,x" } }))).toBe("IMP-4003");
    expect(codeOf(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", url: null } }))).toBe("OK");
    const parsed = ok(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", url: null } }));
    expect(parsed.source.url).toBeNull();
  });

  it("publishedAt 非法 → 成功 + IMP-W006，且写 null", () => {
    const parsed = ok(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", publishedAt: "昨天" } }));
    expect(parsed.source.publishedAt).toBeNull();
    expect(parsed.warnings).toContain("IMP-W006 网页发布时间无法识别，已忽略。");
  });

  it("selection 只认布尔 true", () => {
    expect(ok(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", selection: true } })).source.selection).toBe(true);
    expect(ok(envelope({ source: { capturedAt: "2026-09-29T21:00:00Z", selection: "true" } })).source.selection).toBe(false);
  });

  it("target.folder 非法 → IMP-4008", () => {
    const bad = ["../x", "C:\\x", "a/b/../../c", "a\u0000b", "a:b", "a\\b", "x/".repeat(11) + "x", "深".repeat(81)];
    for (const folder of bad) {
      expect(codeOf(envelope({ target: { folder, notePath: null } }))).toBe("IMP-4008");
    }
  });

  it("target.folder 合法形态被清洗成 POSIX 段（目录创建是 L2 的事，不在这里失败）", () => {
    expect(normalizeFolder("剪藏/技术")).toBe("剪藏/技术");
    expect(normalizeFolder("")).toBe("");
    expect(normalizeFolder(null)).toBe("");
    expect(normalizeFolder("a//b/./c")).toBe("a/b/c");
    // 非法形态直接抛 ImportRejection：`message` 是给开发看的短句，`userMessage` 才是
    // 契约 §6.2 的规范用户文案（两者分工不同，测试断言后者）。
    let thrown: unknown;
    try {
      normalizeFolder("a:b");
    } catch (error) {
      thrown = error;
    }
    expect(isImportRejection(thrown)).toBe(true);
    if (!isImportRejection(thrown)) return;
    expect(thrown.code).toBe("IMP-4008");
    expect(thrown.message).toBe("target 路径非法");
    expect(thrown.userMessage).toBe("目标目录不合法：不能使用 `..`、绝对路径或系统保留字符。");
    expect(thrown.http).toBe(422);
    expect(thrown.retryable).toBe(false);
  });

  it("target.notePath 必须是安全的 Markdown 相对路径", () => {
    expect(normalizeNotePath("剪藏/技术/已有笔记.md")).toBe("剪藏/技术/已有笔记.md");
    expect(normalizeNotePath(null)).toBeNull();
    expect(codeOf(envelope({ target: { folder: null, notePath: "../x.md" } }))).toBe("IMP-4008");
    expect(codeOf(envelope({ target: { folder: null, notePath: "banner.png" } }))).toBe("IMP-4008");
  });

  it("conflict 为 new 时 notePath 被忽略并给 warning", () => {
    const parsed = ok(envelope({ conflict: "new", target: { folder: null, notePath: "已有.md" } }));
    expect(parsed.target.notePath).toBeNull();
    expect(parsed.warnings.some((item) => item.includes("notePath"))).toBe(true);
    const append = ok(envelope({ conflict: "append", target: { folder: null, notePath: "已有.md" } }));
    expect(append.target.notePath).toBe("已有.md");
  });

  it("conflict 是枚举，未知值 → IMP-4003；缺省 = new 且 conflictExplicit 为 false", () => {
    expect(codeOf(envelope({ conflict: "overwrite-all" }))).toBe("IMP-4003");
    expect(ok(envelope({ conflict: undefined })).conflict).toBe("new");
    expect(ok(envelope({ conflict: undefined })).conflictExplicit).toBe(false);
    expect(ok(envelope({ conflict: "new" })).conflictExplicit).toBe(true);
  });

  it("未知顶层字段一律忽略（v1 客户端在 v2 服务端上仍可工作）", () => {
    const parsed = ok(envelope({ foo: 1, nested: { x: 2 }, extra: "x" }));
    expect(parsed.title).toBe("写给工程师的本地优先笔记");
    expect(Object.keys(parsed)).not.toContain("foo");
  });

  it("client.name 未知值归一到 other", () => {
    expect(ok(envelope({ client: { name: "vim", version: "1" } })).client.name).toBe("other");
    expect(ok(envelope({ client: { name: "cli", version: "0.3.0" } })).client.name).toBe("cli");
    expect(ok(envelope({ client: undefined })).client.name).toBe("manual");
  });

  it("validateEnvelope（冻结签名）失败时给 errorCode + 中文文案", () => {
    const result = validateEnvelope(envelope({ spec: "v2" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errorCode).toBe("IMP-4002");
      expect(result.message).toBe("这个客户端版本太旧（或太新），请更新后再试。");
    }
  });
});

describe("错误码表（契约 §6.2 逐字）", () => {
  it("userMessage 是规范文案，message 只是开发短句，两者不混用", () => {
    expect(IMPORT_ERRORS["IMP-4008"].userMessage).toBe("目标目录不合法：不能使用 `..`、绝对路径或系统保留字符。");
    expect(IMPORT_ERRORS["IMP-4003"].userMessage).toBe("导入内容缺少必要信息（标题、来源时间或地址），请重试。");
    expect(IMPORT_ERRORS["IMP-4009"].userMessage).toBe("找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。");
    for (const entry of Object.values(IMPORT_ERRORS)) {
      // 每个码两套文案各司其职，且 userMessage 绝不能是内部短句。
      expect(entry.userMessage).not.toBe(entry.message);
      expect(entry.userMessage.endsWith("。")).toBe(true);
      // T-07：用户可见文案里不得出现宿主机路径 / 令牌。
      expect(entry.userMessage).not.toMatch(/[A-Za-z]:\\|\/Users\/|token|Bearer/i);
      expect(entry.http).toBeGreaterThanOrEqual(400);
    }
  });

  it("IMP-4013 的规范文案逐字照抄 `02:1703`（「请减少后用重新剪藏」，含「用」）", () => {
    expect(IMPORT_ERRORS["IMP-4013"].userMessage).toBe("附件太多或太大，请减少后用重新剪藏。");
    expect(IMPORT_ERRORS["IMP-4013"].http).toBe(413);
    // 唯一文案源在 02 号；这里再钉一次，防止有人「顺手改通顺」而让逐字护栏失去基准。
    expect(IMPORT_ERRORS["IMP-4013"].userMessage).not.toBe("附件太多或太大，请减少后重新剪藏。");
  });

  it("警告文案逐字（含 IMP-W004 / IMP-W008）", () => {
    expect(IMPORT_WARNINGS["IMP-W004"]).toBe("目标笔记有外部改动，已另存为新文件以免覆盖。");
    expect(IMPORT_WARNINGS["IMP-W008"]).toBe("本次追加没有留下可回退的前像，撤销将只把笔记移入回收站。");
    expect(warningText("IMP-W002")).toBe("IMP-W002 正文里有未声明的本地附件引用，已原样保留。");
  });
});

describe("跨模块域错误归一化（toImportErrorBody，按结构判、不按类判）", () => {
  it("任何带 IMP-#### + 非空 userMessage 的对象都算域错误，与它是什么类无关", () => {
    // 别的模块的域错误类（`InboxError`）：name 不是 ImportRejection，信息一样完整。
    const foreign = Object.assign(new Error("收件箱已满（500 条），请先处理一些条目。"), {
      name: "InboxError",
      code: "IMP-4013",
      userMessage: "收件箱已满（500 条），请先处理一些条目。",
    });
    expect(toImportErrorBody(foreign)).toEqual({
      code: "IMP-4013",
      message: "收件箱已满（500 条），请先处理一些条目。",
      userMessage: "收件箱已满（500 条），请先处理一些条目。",
      // 域错误不带 HTTP 语义 → 从总表按码补齐（否则桥/CLI 的状态码会错）。
      http: 413,
      retryable: false,
    });
    // 精确的类守卫仍然只认自己人（语义不动），但结构化判定是并列的第二条通路。
    expect(isImportRejection(foreign)).toBe(false);
  });

  it("ImportRejection 与结构等价的普通对象归一化结果一致（不变量）", () => {
    const template = importProblem("IMP-4007");
    const rejection = new ImportRejection(template);
    const twin = Object.assign(new Error(template.message), {
      name: "WhateverError",
      code: "IMP-4007",
      userMessage: template.userMessage,
    });
    expect(toImportErrorBody(rejection)).toEqual(toImportErrorBody(twin));
    expect(toImportErrorBody(rejection)).toEqual({ ...template });
  });

  it("不满足条件的一律返回 null（交给调用方归到 IMP-5001）", () => {
    expect(toImportErrorBody(new Error("普通的写盘失败"))).toBeNull();
    expect(toImportErrorBody("IMP-4013 文案齐全的字符串")).toBeNull();
    expect(toImportErrorBody(null)).toBeNull();
    expect(toImportErrorBody(undefined)).toBeNull();
    // 码形状不对
    expect(toImportErrorBody({ code: "IMP-40", userMessage: "文案" })).toBeNull();
    expect(toImportErrorBody({ code: "4013", userMessage: "文案" })).toBeNull();
    expect(toImportErrorBody({ code: "OTHER-1", userMessage: "文案" })).toBeNull();
    // 文案缺失 / 空串 / 只有空格
    expect(toImportErrorBody({ code: "IMP-4013" })).toBeNull();
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "" })).toBeNull();
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "   " })).toBeNull();
  });

  it("http / retryable 显式给了就用，没给才回落到总表；detail 只透传普通对象", () => {
    const withHttp = toImportErrorBody({ code: "IMP-4013", userMessage: "文案", http: 507, retryable: true });
    expect(withHttp).toMatchObject({ http: 507, retryable: true });
    // 非整数 / 非布尔的乱值不采信，回落总表。
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "文案", http: 4.5, retryable: "yes" })).toMatchObject({
      http: 413,
      retryable: false,
    });
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "文案", detail: { field: "assets" } })).toMatchObject({
      detail: { field: "assets" },
    });
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "文案", detail: [1, 2] })).not.toHaveProperty("detail");
    expect(toImportErrorBody({ code: "IMP-4013", userMessage: "文案", detail: null })).not.toHaveProperty("detail");
  });

  it("码不在总表里也认（域错误语义优先），http 用 500 兜底", () => {
    expect(toImportErrorBody({ code: "IMP-4099", userMessage: "未来的错误码。" })).toMatchObject({
      code: "IMP-4099",
      http: 500,
      retryable: true,
    });
  });
});

describe("标签过滤（契约 §2.2 / 00 号 §6.11③）", () => {
  it("逗号、换行、方括号、引号 → 整条丢弃 + IMP-W007", () => {
    expect(sanitizeTags(["a,b"]).tags).toEqual([]);
    expect(sanitizeTags(["a,b"]).dropped).toBe(true);
    expect(sanitizeTags(["a\nb"]).tags).toEqual([]);
    expect(sanitizeTags(["[a]"]).tags).toEqual([]);
    expect(sanitizeTags(['"a"']).tags).toEqual([]);
    const parsed = ok(envelope({ tags: ["好标签", "a,b"] }));
    expect(parsed.tags).toEqual(["好标签"]);
    expect(parsed.warnings).toContain("IMP-W007 部分标签不符合规则，已忽略。");
  });

  it("纯数字 → 丢弃", () => {
    expect(sanitizeTags(["123", "v2", "2026"]).tags).toEqual(["v2"]);
  });

  it("超过 32 字符 → 丢弃（不静默截断）", () => {
    expect(sanitizeTags(["字".repeat(33)]).tags).toEqual([]);
    expect(sanitizeTags(["字".repeat(32)]).tags).toEqual(["字".repeat(32)]);
  });

  it("字符集按 [\\p{L}\\p{N}_\\-/] 收紧，去重且保持顺序", () => {
    expect(sanitizeTags(["本地优先！", "a b", "剪藏", "剪藏"]).tags).toEqual(["本地优先", "ab", "剪藏"]);
    expect(sanitizeTags(["！？"]).tags).toEqual([]);
    expect(sanitizeTags(["foo/bar", "snake_case", "kebab-case"]).tags).toEqual(["foo/bar", "snake_case", "kebab-case"]);
  });

  it("tags 超过 32 个 → 截断 + warning", () => {
    const many = Array.from({ length: 40 }, (_, index) => `tag${index}`);
    const parsed = ok(envelope({ tags: many }));
    expect(parsed.tags).toHaveLength(32);
    expect(parsed.warnings.some((item) => item.includes("标签超过 32 个"))).toBe(true);
  });

  it("输出顺序 = 输入顺序（去重后）：front-matter 字节稳定，不在这里排序", () => {
    // 排序是 deriveTags() 读回来时的行为；写入时保持输入顺序，同一信封才字节一致（§3.2 规则 4）。
    expect(sanitizeTags(["乙", "甲", "乙", "丙"]).tags).toEqual(["乙", "甲", "丙"]);
    expect(sanitizeTags(["剪藏", "本地优先"]).tags).toEqual(["剪藏", "本地优先"]);
    expect(sanitizeTags(["本地优先", "剪藏"]).tags).toEqual(["本地优先", "剪藏"]);
  });

  it("tags 不是数组时按空处理", () => {
    expect(ok(envelope({ tags: "a,b" })).tags).toEqual([]);
    expect(ok(envelope({ tags: undefined })).tags).toEqual([]);
  });
});

describe("附件校验（契约 §2.5 / §10.1）", () => {
  const png = encodeBase64(new Uint8Array([137, 80, 78, 71]));

  it("MIME 白名单", () => {
    expect(codeOf(envelope({ assets: [{ name: "a.pdf", mime: "application/pdf", dataBase64: png }] }))).toBe("IMP-4012");
    expect(codeOf(envelope({ assets: [{ name: "a.png", mime: "image/png", dataBase64: png }] }))).toBe("OK");
  });

  it("base64 解码失败 → IMP-4012；缺少载荷 → IMP-4012", () => {
    expect(codeOf(envelope({ assets: [{ name: "a.png", mime: "image/png", dataBase64: "###" }] }))).toBe("IMP-4012");
    expect(codeOf(envelope({ assets: [{ name: "a.png", mime: "image/png" }] }))).toBe("IMP-4012");
    expect(codeOf(envelope({ assets: [{ name: "", mime: "image/png", dataBase64: png }] }))).toBe("IMP-4012");
  });

  it("附件数量 > 32 → IMP-4013；外置 file 越界 → IMP-4012", () => {
    const many = Array.from({ length: MAX_ASSETS + 1 }, (_, index) => ({ name: `a${index}.png`, mime: "image/png", dataBase64: png }));
    expect(codeOf(envelope({ assets: many }))).toBe("IMP-4013");
    expect(codeOf(envelope({ assets: [{ name: "a.png", mime: "image/png", file: "../../x.png" }] }))).toBe("IMP-4012");
    expect(codeOf(envelope({ assets: [{ name: "a.png", mime: "image/png", file: "assets/a.png" }] }))).toBe("OK");
  });

  it("base64 允许换行与 +/=", () => {
    const raw = new Uint8Array([0xfb, 0xef, 0xbe]);
    const encoded = encodeBase64(raw);
    expect(encoded).toContain("+");
    expect(decodeBase64(encoded.replace(/(.{2})/, "$1\n"))).toEqual(raw);
  });

  it("SVG 净化：<script / on*= / javascript: / 外部 href 一律拒", () => {
    const svg = (inner: string) => new TextEncoder().encode(`<svg xmlns="http://www.w3.org/2000/svg">${inner}</svg>`);
    expect(isSafeSvg(svg("<rect/>"))).toBe(true);
    expect(isSafeSvg(svg("<script>alert(1)</script>"))).toBe(false);
    expect(isSafeSvg(svg('<rect onclick="alert(1)"/>'))).toBe(false);
    expect(isSafeSvg(svg('<a href="javascript:alert(1)">x</a>'))).toBe(false);
    expect(isSafeSvg(svg('<image href="https://evil.test/x.png"/>'))).toBe(false);
  });
});

describe("serializeEnvelope（收件箱队列用）", () => {
  it("正文内联、附件统一为 dataBase64，可 JSON 往返", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const parsed = ok(
      envelope({ assets: [{ name: "a.png", mime: "image/png", dataBase64: encodeBase64(bytes) }] }),
    );
    const json = serializeEnvelopeJson(parsed);
    const round = JSON.parse(json) as Record<string, unknown>;
    expect(round.spec).toBe("opennote.import/v1");
    expect(round.body).toBe(parsed.body);
    expect((round.assets as { dataBase64: string }[])[0].dataBase64).toBe(encodeBase64(bytes));
    expect(json).not.toContain("Uint8Array");
  });
});
