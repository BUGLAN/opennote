import { describe, expect, it } from "vitest";
import {
  cleanInline,
  countText,
  derivePlaceholderTitle,
  deriveTags,
  deriveTitle,
  excerpt,
  firstHeadingLine,
  formatRelativeTime,
  isPlaceholderName,
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

describe("isPlaceholderName（自动改名的唯一入口条件）", () => {
  it("三个 fallback 产地与它们的序号变体都算占位名", () => {
    for (const name of ["无标题", "无标题 2", "无标题 10", "未命名", "未命名 3", "untitled", "Untitled", "UNTITLED 3"]) {
      expect(isPlaceholderName(name), name).toBe(true);
    }
  });

  it("副本 / 真实名字 / 只多一个空格以外的写法一律不算", () => {
    for (const name of ["无标题 副本", "无标题副本", "未命名草稿", "untitled 2 副本", "系统设计ABC", "index", "README", ""]) {
      expect(isPlaceholderName(name), name).toBe(false);
    }
  });

  it("前后空白不算数（文件名里的空格是 sanitizeName 的产物）", () => {
    expect(isPlaceholderName("  无标题 2  ")).toBe(true);
  });
});

describe("derivePlaceholderTitle（认 H1–H6，绝不把正文首行当标题）", () => {
  it("H1–H6 每一级都能触发（用户 5 篇占位笔记里 H1 为 0，只认 H1 等于功能没做）", () => {
    expect(derivePlaceholderTitle("# 一\n正文")).toBe("一");
    expect(derivePlaceholderTitle("## 二\n正文")).toBe("二");
    expect(derivePlaceholderTitle("### 三\n正文")).toBe("三");
    expect(derivePlaceholderTitle("#### 四\n正文")).toBe("四");
    expect(derivePlaceholderTitle("##### 五\n正文")).toBe("五");
    expect(derivePlaceholderTitle("###### 六\n正文")).toBe("六");
  });

  it("跨过正文首段去找真标题行（但首段本身永远不算标题）", () => {
    expect(derivePlaceholderTitle("intro\n\n# 标题\n\n正文")).toBe("标题");
    expect(derivePlaceholderTitle("intro\n第二行")).toBeNull();
  });

  it("★ 只有一行图片的笔记返回 null —— 否则会产出 3f1c9589….png.md 这种垃圾名", () => {
    expect(derivePlaceholderTitle("![3f1c9589f284944860bef0e22aecc5b0_720.png](.assets/ac44629b-1.png)")).toBeNull();
    expect(derivePlaceholderTitle("![图](.assets/图.png)\n")).toBeNull();
  });

  it("空文件 / 只有空白 → null（不回落成任何名字）", () => {
    expect(derivePlaceholderTitle("")).toBeNull();
    expect(derivePlaceholderTitle("   \n\n\t\n")).toBeNull();
  });

  it("跳过 front matter（里面的 title: 不是标题）、代码围栏与围栏内的假标题", () => {
    const md = "---\ntitle: 假的\n---\n\n```md\n# 围栏里的假标题\n```\n\n## 真标题\n";
    expect(derivePlaceholderTitle(md)).toBe("真标题");
    expect(derivePlaceholderTitle("---\ntitle: 只有元数据\n---\n\n正文\n")).toBeNull();
  });

  it("跳过引用块 / 表格 / 分隔线", () => {
    const md = "> # 引用里的假标题\n\n| a | b |\n| - | - |\n\n---\n\n## 真标题\n";
    expect(derivePlaceholderTitle(md)).toBe("真标题");
  });

  it("复用 cleanInline：inline 标记不进文件名；空标题行继续往下找", () => {
    expect(derivePlaceholderTitle("# **重点** 与 [链接](x) 和 `code`")).toBe("重点 与 链接 和 code");
    expect(derivePlaceholderTitle("# ** **\n\n# 后面这个才算")).toBe("后面这个才算");
    expect(derivePlaceholderTitle("# ")).toBeNull();
  });

  it("标题超长按 TITLE_LIMIT 截断（与 deriveTitle 同一口径）", () => {
    expect(derivePlaceholderTitle(`# ${"字".repeat(200)}`)).toHaveLength(90);
  });

  it("不改 deriveTitle 的默认语义：同一个文档两个函数可以给出不同答案", () => {
    const md = "只是第一行\n\n# 后面才有标题\n";
    expect(deriveTitle(md)).toBe("只是第一行");
    expect(derivePlaceholderTitle(md)).toBe("后面才有标题");
  });
});

describe("firstHeadingLine（光标是否还停在标题那一行）", () => {
  it("行号是 1 基，与编辑器的 cursor.line 同一口径（front matter 占的行要算进去）", () => {
    expect(firstHeadingLine("## 修改提示词\n正文")).toBe(1);
    expect(firstHeadingLine("intro\n\n# 标题\n")).toBe(3);
    // front matter 占 4 行（`---` / `tags: a` / `---` / 空行），body 从第 5 行开始，
    // 所以 `### 三` 就在第 5 行 —— 这个偏移不加，带 front matter 的笔记会把光标判定整体错位。
    expect(firstHeadingLine("---\ntags: a\n---\n\n### 三\n")).toBe(5);
    // 带 front matter 的文档里，body 相对行号必须换算成绝对行号（否则光标判定整体错位）：
    // `---` / `tags: a` / `---` / 空行 / `前言` / 空行 之后才是 `# 真标题`（第 7 行）。
    const md = "---\ntags: a\n---\n\n前言\n\n# 真标题\n";
    const lines = md.split("\n");
    expect(firstHeadingLine(md)).toBe(7);
    expect(lines[firstHeadingLine(md)! - 1]).toBe("# 真标题");
    expect(derivePlaceholderTitle(md)).toBe("真标题");
  });

  it("没有真标题行 → null（与 derivePlaceholderTitle 同一次扫描的结论）", () => {
    expect(firstHeadingLine("![图](.assets/图.png)")).toBeNull();
    expect(firstHeadingLine("")).toBeNull();
    expect(firstHeadingLine("```\n# 围栏里的假标题\n```\n")).toBeNull();
  });

  it("与 derivePlaceholderTitle 指向同一行（两个产地会漂移，这里咬住它们一致）", () => {
    const md = "前言\n\n> 引用\n\n#### 四\n正文";
    const line = firstHeadingLine(md)!;
    expect(md.split("\n")[line - 1].trim()).toBe("#### 四");
    expect(derivePlaceholderTitle(md)).toBe("四");
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
