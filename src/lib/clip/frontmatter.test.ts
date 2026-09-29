import { describe, expect, it } from "vitest";
import { deriveTags, deriveTitle, splitFrontMatter } from "../utils";
import { validateImportEnvelope, type ImportEnvelope } from "./envelope";
import {
  FRONT_MATTER_KEYS,
  renderAppended,
  renderBodyBlock,
  renderFrontMatter,
  renderMarkdown,
  renderTagLine,
  yamlScalar,
} from "./frontmatter";

function parsed(overrides: Record<string, unknown> = {}): ImportEnvelope {
  const value = {
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
  const result = validateImportEnvelope(value);
  if (!result.ok) throw new Error(result.problem.message);
  return result.envelope;
}

describe("front-matter 字节级模板（契约 §3.2 / 附录 A.2）", () => {
  it("8 键顺序固定：source → source_title → source_site → author → published_at → captured_at → tags → opennote_import_id", () => {
    const text = renderMarkdown(parsed(), "在浏览器里剪下的一段话。");
    const lines = text.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines.slice(1, 9).map((line) => line.split(":")[0])).toEqual([...FRONT_MATTER_KEYS]);
    expect(lines[9]).toBe("---");
    expect(lines[10]).toBe("");
    expect(lines[11]).toBe("# 写给工程师的本地优先笔记");
  });

  it("值为 null 的键整行省略（不写 `source: null`）", () => {
    const text = renderMarkdown(
      parsed({ source: { capturedAt: "2026-09-29T21:04:11+08:00", url: null } }),
      "正文",
    );
    expect(text).not.toContain("source:");
    expect(text).toContain("captured_at: 2026-09-29T21:04:11+08:00");
    expect(text).toContain("opennote_import_id: 0f1d6d9a-6c2f-4a7e-9d31-5b0f2a7c1e88");
    const keys = text.split("\n").slice(1).filter((line) => line !== "---" && line.includes(":")).map((line) => line.slice(0, line.indexOf(":")));
    expect(keys).toEqual(["captured_at", "tags", "opennote_import_id"]);
  });

  it("tag 行是行内数组 `tags: [a, b]`（deriveTags 只认这个形态）", () => {
    const text = renderMarkdown(parsed(), "正文");
    expect(text).toContain("tags: [剪藏, 本地优先]");
    // deriveTags 会排序，这里比集合。
    expect(deriveTags(text).sort()).toEqual(["剪藏", "本地优先"].sort());
    // 含特殊字符的标签走双引号，normalizeTag() 会去掉引号。
    expect(renderTagLine(["a b"])).toBe('["a b"]');
    expect(deriveTags(`---\ntags: ${renderTagLine(["a b"])}\n---\n`)).toEqual(["a b"]);
    // 全部被过滤掉时整行省略。
    expect(renderTagLine([])).toBeNull();
    expect(renderMarkdown(parsed({ tags: [] }), "正文")).not.toContain("tags:");
  });

  it("tags 全部被过滤时**整行省略** tags:（不写空数组、不写 null）", () => {
    const envelope = parsed({ tags: ["123", "a,b", "字".repeat(33)] });
    expect(envelope.tags).toEqual([]);
    expect(envelope.warnings).toContain("IMP-W007 部分标签不符合规则，已忽略。");
    const text = renderMarkdown(envelope, "正文");
    expect(text).not.toContain("tags:");
    expect(text.split("\n").filter((line) => line.startsWith("tags")).length).toBe(0);
  });

  it("tags 行按 sanitizeTags 的输出顺序（输入顺序）落字节", () => {
    const envelope = parsed({ tags: ["乙", "甲", "乙"] });
    expect(envelope.tags).toEqual(["乙", "甲"]);
    expect(renderMarkdown(envelope, "正文")).toContain("tags: [乙, 甲]");
  });

  it("正文必须以 `# <title>` 开头（deriveTitle 不读 front-matter）", () => {
    const text = renderMarkdown(parsed(), "在浏览器里剪下的一段话。");
    expect(deriveTitle(text)).toBe("写给工程师的本地优先笔记");
    expect(splitFrontMatter(text).body.startsWith("\n# 写给工程师的本地优先笔记")).toBe(true);
  });

  it("body 首个非空行已是 H1 → 降级为 H2，且全文只有一个 H1", () => {
    const text = renderMarkdown(parsed(), "# 别的标题\n\n正文");
    expect(text).toContain("# 写给工程师的本地优先笔记\n\n## 别的标题");
    expect(text.match(/^# /gm)).toHaveLength(1);
    // 只降级一次，不做全局改写。
    const many = renderMarkdown(parsed(), "# 一\n\n# 二");
    expect(many).toContain("## 一\n\n# 二");
  });

  it("空正文 → 只有 H1 行（契约 §2.6）", () => {
    const text = renderMarkdown(parsed({ body: "" }), "");
    expect(text.endsWith("# 写给工程师的本地优先笔记\n")).toBe(true);
    expect(text).not.toContain("\n\n\n");
  });

  it("文件末尾恰好一个 \\n、无 \\r、无 BOM、首行就是 ---", () => {
    const text = renderMarkdown(parsed(), "正文\r\n第二行");
    expect(text.endsWith("\n")).toBe(true);
    expect(text.endsWith("\n\n")).toBe(false);
    expect(text.includes("\r")).toBe(false);
    expect(text.charCodeAt(0)).not.toBe(0xfeff);
    expect(text.startsWith("---\n")).toBe(true);
  });

  it("正文首行恰为 `---` 时不会被当成 front-matter 的闭合（front-matter 仍在最开头）", () => {
    const text = renderMarkdown(parsed(), "---\n\n正文");
    const { front, body } = splitFrontMatter(text);
    expect(front).toContain("opennote_import_id");
    expect(body.trim().startsWith("# 写给工程师的本地优先笔记")).toBe(true);
  });

  it("YAML 标量转义：裸标量 / 引号包裹", () => {
    expect(yamlScalar("https://example.com/a")).toBe("https://example.com/a");
    expect(yamlScalar("张三")).toBe("张三");
    expect(yamlScalar("2026-09-29T21:04:11+08:00")).toBe("2026-09-29T21:04:11+08:00");
    expect(yamlScalar("")).toBe('""');
    expect(yamlScalar("a #b")).toBe('"a #b"');
    expect(yamlScalar('say "hi"')).toBe('"say \\"hi\\""');
    expect(yamlScalar("back\\slash")).toBe('"back\\\\slash"');
    expect(yamlScalar("尾随空格 ")).toBe('"尾随空格 "');
  });

  it("renderFrontMatter 与 renderMarkdown 的关系：恰好一个空行 + 正文", () => {
    const envelope = parsed();
    const head = renderFrontMatter(envelope);
    const text = renderMarkdown(envelope, "正文");
    expect(text.startsWith(`${head}\n`)).toBe(true);
    expect(renderBodyBlock(envelope.title, "正文")).toBe(`# ${envelope.title}\n\n正文`);
  });

  it("append 形态：分隔线 + 时间戳 + 正文块（契约 §3.3.3）", () => {
    const envelope = parsed();
    const existing = "# 原笔记\n\n原有内容\n";
    const next = renderAppended(existing, envelope, "追加的一段", Date.parse("2026-09-29T21:04:11+08:00"));
    expect(next.startsWith("# 原笔记\n\n原有内容\n\n---\n\n> 再次剪藏于 ")).toBe(true);
    expect(next).toContain("> 再次剪藏于 ");
    expect(next.endsWith("# 写给工程师的本地优先笔记\n\n追加的一段\n")).toBe(true);
    // 追加是加法：原有正文一字不改。
    expect(next).toContain("原有内容");
    expect(next.endsWith("\n")).toBe(true);
    expect(next.endsWith("\n\n")).toBe(false);
  });

  it("append 会把 CRLF 归一为 LF（不把 \\r 带进文件）", () => {
    const next = renderAppended("# 原\r\n\r\n内容\r\n", parsed(), "新", 0);
    expect(next.includes("\r")).toBe(false);
  });
});
