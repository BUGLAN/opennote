import { describe, expect, it } from "vitest";
import {
  cleanInline,
  countText,
  deriveTags,
  deriveTitle,
  excerpt,
  formatRelativeTime,
  safeFileName,
  splitFrontMatter,
  stripMarkdown,
  uniqueName,
} from "./utils";

describe("deriveTitle", () => {
  it("uses the first heading when the note opens with one", () => {
    expect(deriveTitle("# 标题\n\n正文")).toBe("标题");
  });

  it("falls back to the first plain line", () => {
    expect(deriveTitle("intro\n\n# 标题\n\n正文")).toBe("intro");
    expect(deriveTitle("只是第一行\n第二行")).toBe("只是第一行");
  });

  it("skips front matter, fences and rules", () => {
    const md = "---\ntags: [a]\n---\n\n```ts\nconst x = 1\n```\n\n真正的标题\n";
    expect(deriveTitle(md)).toBe("真正的标题");
  });

  it("uses the fallback for an empty document", () => {
    expect(deriveTitle("   \n\n")).toBe("无标题");
    expect(deriveTitle("", "九月")).toBe("九月");
  });

  it("cleans inline syntax", () => {
    expect(deriveTitle("# **重点** 与 [链接](x) 和 `code`")).toBe("重点 与 链接 和 code");
  });
});

describe("splitFrontMatter", () => {
  it("separates yaml front matter from the body", () => {
    const { front, body } = splitFrontMatter("---\ntags: [a, b]\n---\n# hi\n");
    expect(front).toBe("tags: [a, b]");
    expect(body).toBe("# hi\n");
  });

  it("leaves documents without front matter untouched", () => {
    expect(splitFrontMatter("# hi").body).toBe("# hi");
  });
});

describe("deriveTags", () => {
  it("reads inline tags", () => {
    expect(deriveTags("今天想到 #想法 和 #reading/list")).toContain("想法");
    expect(deriveTags("今天想到 #想法 和 #reading/list")).toContain("reading/list");
  });

  it("does not treat headings as tags", () => {
    expect(deriveTags("# 标题\n## 二级")).toEqual([]);
  });

  it("reads front matter tags in both shapes", () => {
    expect(deriveTags("---\ntags: [a, b]\n---\nbody")).toEqual(["a", "b"]);
    expect(deriveTags("---\ntags:\n  - x\n  - y\n---\nbody")).toEqual(["x", "y"]);
  });

  it("ignores tags inside code fences", () => {
    expect(deriveTags("```\n#不是标签\n```\n只 #真的")).toEqual(["真的"]);
  });
});

describe("countText", () => {
  it("counts CJK characters and latin words", () => {
    const counts = countText("你好 world 世界 hello");
    expect(counts.cjk).toBe(4);
    expect(counts.words).toBe(6);
  });

  it("ignores markdown syntax", () => {
    expect(countText("# **hi**").words).toBe(1);
  });
});

describe("stripMarkdown / excerpt / cleanInline", () => {
  it("strips structure", () => {
    const text = stripMarkdown("# 标题\n\n> 引用\n\n- 项目\n\n`code`\n");
    expect(text).toContain("标题");
    expect(text).not.toContain("#");
    expect(text).not.toContain(">");
  });

  it("truncates excerpts", () => {
    expect(excerpt("a".repeat(400), 10)).toBe("aaaaaaaaaa…");
  });

  it("removes inline markers", () => {
    expect(cleanInline("**粗** ~~删~~ ==高==")).toBe("粗 删 高");
  });
});

describe("file names", () => {
  it("keeps CJK and strips illegal characters", () => {
    expect(safeFileName("九月/日记: 第一周?")).toBe("九月 日记 第一周");
  });

  it("falls back when everything is illegal", () => {
    expect(safeFileName("///")).toBe("untitled");
  });

  it("deduplicates with a counter", () => {
    const taken = new Set(["笔记.md"]);
    expect(uniqueName("笔记.md", taken)).toBe("笔记 2.md");
  });
});

describe("formatRelativeTime", () => {
  const now = Date.parse("2025-05-05T12:00:00");
  it("describes recent times in words", () => {
    expect(formatRelativeTime(now - 30_000, now)).toBe("刚刚");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5 分钟前");
    expect(formatRelativeTime(now - 3 * 3600_000, now)).toBe("3 小时前");
  });

  it("falls back to a date for older notes", () => {
    expect(formatRelativeTime(Date.parse("2025-01-02T08:00:00"), now)).toBe("1 月 2 日");
    expect(formatRelativeTime(Date.parse("2024-01-02T08:00:00"), now)).toBe("2024-01-02");
  });
});
