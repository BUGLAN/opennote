import { describe, expect, it } from "vitest";
import { parseRepoInput, targetLabel } from "./parse";

describe("parseRepoInput", () => {
  it("四种写法解析成同一个 target（一个事实的四个外壳）", () => {
    const expected = {
      owner: "BUGLAN",
      repo: "opennote",
      ref: null,
      subPath: null,
      remote: "https://github.com/BUGLAN/opennote",
    };
    for (const input of [
      "https://github.com/BUGLAN/opennote",
      "https://github.com/BUGLAN/opennote/",
      "https://github.com/BUGLAN/opennote.git",
      "git@github.com:BUGLAN/opennote.git",
      "BUGLAN/opennote",
      "  BUGLAN/opennote  ",
    ]) {
      const parsed = parseRepoInput(input);
      expect(parsed.ok, input).toBe(true);
      if (parsed.ok) expect(parsed.value).toEqual(expected);
    }
  });

  it("/tree/<ref> 决定分支，/tree/<ref>/<子目录> 只做提示", () => {
    const bare = parseRepoInput("https://github.com/BUGLAN/opennote/tree/main");
    expect(bare.ok && bare.value.ref).toBe("main");
    expect(bare.ok && bare.value.subPath).toBeNull();

    const nested = parseRepoInput("https://github.com/BUGLAN/opennote/tree/release%2F1.0/docs/note");
    expect(nested.ok && nested.value.ref).toBe("release/1.0");
    expect(nested.ok && nested.value.subPath).toBe("docs/note");
    /*
     * 子目录里的 `..` **进不来**：WHATWG URL 会把「百分号编码的点段」按点段归一化
     * （实测 `new URL(... '/tree/main/%2E%2E/%2E%2E/etc').pathname === '/BUGLAN/opennote/etc'`），
     * 于是这里连 `/tree/` 都不剩，落到「仓库根 + 默认分支」。这条断言把「解析器替我们挡住了」
     * 记下来 —— 不是靠 normalizePath 兜的。
     */
    const escape = parseRepoInput("https://github.com/BUGLAN/opennote/tree/main/%2E%2E/%2E%2E/etc");
    expect(escape.ok && escape.value.ref).toBeNull();
    expect(escape.ok && escape.value.subPath).toBeNull();
  });

  it("认不出来时给一句能照做的话（不抛异常）", () => {
    for (const input of ["", "   ", "https://gitlab.com/a/b", "https://github.com/BUGLAN", "只有一段"]) {
      const parsed = parseRepoInput(input);
      expect(parsed.ok, input).toBe(false);
      if (!parsed.ok) expect(parsed.message.length).toBeGreaterThan(8);
    }
  });

  it("仓库名里的非法字符当面拒绝", () => {
    const parsed = parseRepoInput("BUGLAN/open note");
    expect(parsed.ok).toBe(false);
    const bad = parseRepoInput("https://github.com/BUG LAN/opennote");
    expect(bad.ok).toBe(false);
  });

  it("targetLabel 是 owner/repo", () => {
    expect(targetLabel({ owner: "BUGLAN", repo: "opennote" })).toBe("BUGLAN/opennote");
  });
});
