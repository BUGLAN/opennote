import { describe, expect, it } from "vitest";
import { minimalReplace } from "./externalReplace";

/**
 * 外部改动落进编辑器时的那一段最小改动。
 *
 * 这里守的是**正确性**：无论前后缀怎么切，`oldText` 应用这段改动之后必须逐字等于
 * `nextText`。滚动位置的收益在真实浏览器里量（`scripts/geometry-probe` 的不变量 4）——
 * 这一层只保证「不切错字」。
 */

/** 把改动应用到旧文本上 —— 与 CodeMirror 应用 ChangeSet 的结果一致。 */
function apply(oldText: string, nextText: string): string {
  const { changes } = minimalReplace(oldText, nextText, { anchor: 0, head: 0 });
  return oldText.slice(0, changes.from) + changes.insert + oldText.slice(changes.to);
}

describe("minimalReplace：只替换公共前后缀之外的那一段", () => {
  it("末尾追加：改动只在尾部，前面一个字符都不碰", () => {
    const oldText = "第一段\n\n第二段\n";
    const nextText = `${oldText}\n第三段\n`;
    const { changes } = minimalReplace(oldText, nextText, { anchor: 0, head: 0 });
    expect(changes.from).toBe(oldText.length);
    expect(changes.to).toBe(oldText.length);
    expect(changes.insert).toBe("\n第三段\n");
  });

  it("开头插入：改动只在头部", () => {
    const oldText = "第一段\n\n第二段\n";
    const nextText = `前言\n\n${oldText}`;
    const { changes } = minimalReplace(oldText, nextText, { anchor: 0, head: 0 });
    expect(changes.from).toBe(0);
    expect(changes.to).toBe(0);
    expect(changes.insert).toBe("前言\n\n");
  });

  it("改中间一段：前后缀都保住", () => {
    const oldText = "标题\n\n旧的正文。\n\n尾部\n";
    const nextText = "标题\n\n新的正文，长一点。\n\n尾部\n";
    const { changes } = minimalReplace(oldText, nextText, { anchor: 0, head: 0 });
    expect(changes.from).toBe("标题\n\n".length);
    expect(changes.insert.startsWith("新的正文")).toBe(true);
    expect(apply(oldText, nextText)).toBe(nextText);
  });

  it("整篇重写：退化成一段全量替换（前后缀为空）", () => {
    const { changes } = minimalReplace("abc", "xyz", { anchor: 0, head: 0 });
    expect(changes).toEqual({ from: 0, to: 3, insert: "xyz" });
  });

  it("两段文本相同：空改动", () => {
    const { changes } = minimalReplace("同一篇\n", "同一篇\n", { anchor: 2, head: 2 });
    expect(changes).toEqual({ from: "同一篇\n".length, to: "同一篇\n".length, insert: "" });
  });

  it("空文档 → 有内容", () => {
    expect(apply("", "新笔记\n")).toBe("新笔记\n");
  });

  it("有内容 → 空文档", () => {
    expect(apply("旧笔记\n", "")).toBe("");
  });

  it("不把改动边界切在代理对中间", () => {
    /* U+1F600 与 U+1F601 共用高位代理 D83D —— 逐码元比前缀会切在字符中间。 */
    const { changes } = minimalReplace("A😀B", "A😁B", { anchor: 0, head: 0 });
    expect(changes.from).toBe(1);
    expect(changes.to).toBe(3);
    expect(changes.insert).toBe("😁");
    expect(apply("A😀B", "A😁B")).toBe("A😁B");
  });

  it("换行风格不同（CRLF ↔ LF）也能得到正确的最终文本", () => {
    const oldText = "第一行\r\n第二行\r\n";
    const nextText = "第一行\n第二行\n第三行\n";
    expect(apply(oldText, nextText)).toBe(nextText);
  });

  it("选区按索引夹进新文档（与旧的整篇替换行为一致）", () => {
    const short = minimalReplace("0123456789", "012", { anchor: 8, head: 9 });
    expect(short.selection).toEqual({ anchor: 3, head: 3 });
    const long = minimalReplace("012", "0123456789", { anchor: 1, head: 2 });
    expect(long.selection).toEqual({ anchor: 1, head: 2 });
  });

  it("任意一对文本都满足「应用之后逐字等于新文本」", () => {
    const samples = [
      "",
      "a",
      "ab\n",
      "a\nb\nc\n",
      "# 标题\n\n正文\n\n- 一\n- 二\n",
      "尾部相同\n公共头部\n",
      "公共头部\n中间变了\n公共尾部\n",
      "😀 emoji 与中文混排\n",
      "x".repeat(500),
    ];
    for (const oldText of samples) {
      for (const nextText of samples) {
        expect(apply(oldText, nextText), `${JSON.stringify(oldText)} → ${JSON.stringify(nextText)}`).toBe(nextText);
      }
    }
  });
});
