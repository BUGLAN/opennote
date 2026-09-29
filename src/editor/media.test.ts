import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { findLinkAt } from "./media";
import { markdownSupport } from "./markdown";

function stateFor(doc: string): EditorState {
  return EditorState.create({ doc, extensions: [markdownSupport] });
}

/** Find the URL under the first occurrence of `needle`. */
function linkAt(doc: string, needle: string, offset = 0): string | null {
  const at = doc.indexOf(needle);
  expect(at, `needle ${needle} not found`).toBeGreaterThanOrEqual(0);
  return findLinkAt(stateFor(doc), at + offset);
}

describe("D27 findLinkAt 跳过代码里的 URL", () => {
  it("does not open a URL inside inline code", () => {
    expect(linkAt("用 `https://example.com/a` 表示", "https://example.com/a")).toBeNull();
  });

  it("does not open a URL inside a fenced code block", () => {
    expect(linkAt("```\nhttps://example.com/b\n```\n", "https://example.com/b")).toBeNull();
  });

  it("does not open a URL inside a fenced block with a language", () => {
    expect(linkAt("```js\n// https://example.com/c\n```\n", "https://example.com/c")).toBeNull();
  });

  it("does not open a URL inside an indented code block", () => {
    expect(linkAt("    缩进 https://example.com/d\n", "https://example.com/d")).toBeNull();
  });

  it("does not open a markdown link written inside inline code", () => {
    expect(linkAt("语法是 `[文字](https://example.com/e)`", "https://example.com/e")).toBeNull();
  });
});

describe("D27 findLinkAt 仍然能打开正常链接", () => {
  it("opens a markdown link from its label, brackets and url", () => {
    const doc = "看 [站点](https://example.com/page) 吧";
    expect(linkAt(doc, "站点", 1)).toBe("https://example.com/page");
    expect(linkAt(doc, "https://example.com/page", 3)).toBe("https://example.com/page");
  });

  it("opens a bare url in prose", () => {
    const doc = "访问 https://a.example/b?x=1 结束";
    expect(linkAt(doc, "https://a.example/b", 5)).toBe("https://a.example/b?x=1");
  });

  it("opens an autolink", () => {
    const doc = "见 <https://auto.example/x> 一节";
    expect(linkAt(doc, "https://auto.example/x", 4)).toBe("https://auto.example/x");
  });

  it("opens an image url", () => {
    const doc = "前 ![图](https://img.example/p.png) 后";
    expect(linkAt(doc, "https://img.example/p.png", 4)).toBe("https://img.example/p.png");
  });

  it("returns null on ordinary text", () => {
    expect(findLinkAt(stateFor("这里没有链接，只有中文。\n"), 4)).toBeNull();
  });

  it("returns null on an empty document", () => {
    expect(findLinkAt(stateFor(""), 0)).toBeNull();
  });
});
