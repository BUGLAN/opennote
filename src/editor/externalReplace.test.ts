import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { minimalReplace } from "./externalReplace";

/**
 * 外部改动落进编辑器时的那一段最小改动。
 *
 * 这里守两类契约：无论前后缀怎么切，`oldText` 应用这段改动之后必须逐字等于 `nextText`；
 * 只把改动交给 CodeMirror 时，光标与多选区也必须跟着原文映射，而不是夹进新文档长度。
 * 滚动位置的收益在真实浏览器里量（`scripts/geometry-probe` 的不变量 4）。
 */

/** 把改动应用到旧文本上 —— 与 CodeMirror 应用 ChangeSet 的结果一致。 */
function apply(oldText: string, nextText: string): string {
  const changes = minimalReplace(oldText, nextText);
  return oldText.slice(0, changes.from) + changes.insert + oldText.slice(changes.to);
}

/** 与 EditorPane 的 dispatch 一致：只传 changes，让 CodeMirror 自己映射选区。 */
function mapExternalSelection(
  oldText: string,
  nextText: string,
  selection: EditorSelection | SelectionRange,
): EditorState {
  const state = EditorState.create({
    doc: oldText,
    selection,
    extensions: EditorState.allowMultipleSelections.of(true),
  });
  return state.update({ changes: minimalReplace(oldText, nextText) }).state;
}

describe("minimalReplace：只替换公共前后缀之外的那一段", () => {
  it("末尾追加：改动只在尾部，前面一个字符都不碰", () => {
    const oldText = "第一段\n\n第二段\n";
    const nextText = `${oldText}\n第三段\n`;
    const changes = minimalReplace(oldText, nextText);
    expect(changes.from).toBe(oldText.length);
    expect(changes.to).toBe(oldText.length);
    expect(changes.insert).toBe("\n第三段\n");
  });

  it("开头插入：改动只在头部", () => {
    const oldText = "第一段\n\n第二段\n";
    const nextText = `前言\n\n${oldText}`;
    const changes = minimalReplace(oldText, nextText);
    expect(changes.from).toBe(0);
    expect(changes.to).toBe(0);
    expect(changes.insert).toBe("前言\n\n");
  });

  it("改中间一段：前后缀都保住", () => {
    const oldText = "标题\n\n旧的正文。\n\n尾部\n";
    const nextText = "标题\n\n新的正文，长一点。\n\n尾部\n";
    const changes = minimalReplace(oldText, nextText);
    expect(changes.from).toBe("标题\n\n".length);
    expect(changes.insert.startsWith("新的正文")).toBe(true);
    expect(apply(oldText, nextText)).toBe(nextText);
  });

  it("整篇重写：退化成一段全量替换（前后缀为空）", () => {
    const changes = minimalReplace("abc", "xyz");
    expect(changes).toEqual({ from: 0, to: 3, insert: "xyz" });
  });

  it("两段文本相同：空改动", () => {
    const changes = minimalReplace("同一篇\n", "同一篇\n");
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
    const changes = minimalReplace("A😀B", "A😁B");
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

  it("光标上方插入：光标跟着原来那段文字后移", () => {
    const oldText = "第一行\n我正在这里打字";
    const cursor = oldText.indexOf("这里");
    const prefix = "外部插入的一大段\n";
    const nextText = `${prefix}${oldText}`;
    const state = mapExternalSelection(oldText, nextText, EditorSelection.cursor(cursor));

    expect(state.doc.toString()).toBe(nextText);
    expect(state.selection.main.head).toBe(nextText.indexOf("这里"));
    expect(state.doc.sliceString(state.selection.main.head)).toBe("这里打字");
  });

  it("光标上方删除：光标跟着原来那段文字前移", () => {
    const prefix = "删除上一段\n再删除一行\n";
    const oldText = `${prefix}我正在这里打字`;
    const nextText = oldText.slice(prefix.length);
    const state = mapExternalSelection(oldText, nextText, EditorSelection.cursor(oldText.indexOf("这里")));

    expect(state.doc.toString()).toBe(nextText);
    expect(state.selection.main.head).toBe(nextText.indexOf("这里"));
    expect(state.doc.sliceString(state.selection.main.head)).toBe("这里打字");
  });

  it("光标下方改动：光标不动", () => {
    const oldText = "第一行\n我正在这里打字";
    const cursor = oldText.indexOf("这里");
    const nextText = `${oldText}\n外部追加在下方\n`;
    const state = mapExternalSelection(oldText, nextText, EditorSelection.cursor(cursor));

    expect(state.doc.toString()).toBe(nextText);
    expect(state.selection.main.head).toBe(cursor);
  });

  it("改动覆盖光标：光标落在改动区间边界上，不越界", () => {
    const oldText = "前文\n旧的光标位置\n后文\n";
    const nextText = "前文\n替换后的内容\n后文\n";
    const cursor = oldText.indexOf("光标");
    const changes = minimalReplace(oldText, nextText);
    const state = mapExternalSelection(oldText, nextText, EditorSelection.cursor(cursor));

    expect(changes.from).toBeLessThan(cursor);
    expect(changes.to).toBeGreaterThan(cursor);
    expect(state.selection.main.head).toBe(changes.from);
    expect(state.selection.main.head).toBeLessThanOrEqual(state.doc.length);
  });

  it("多选区全部保留，并按各自位置正确映射", () => {
    const oldText = "第一处光标\n中间一段\n第二处光标\n尾部";
    const prefix = "外部插入\n";
    const nextText = `${prefix}${oldText}`;
    const firstCursor = oldText.indexOf("光标");
    const middleFrom = oldText.indexOf("中间");
    const secondCursor = oldText.indexOf("光标", firstCursor + 1);
    const before = EditorSelection.create([
      EditorSelection.cursor(firstCursor),
      EditorSelection.range(middleFrom, middleFrom + "中间一段".length),
      EditorSelection.cursor(secondCursor),
    ]);
    const state = mapExternalSelection(oldText, nextText, before);
    const after = state.selection.ranges;

    expect(after).toHaveLength(before.ranges.length);
    expect(after.map((range) => [range.from, range.to])).toEqual(
      before.ranges.map((range) => [range.from + prefix.length, range.to + prefix.length]),
    );
    for (const [index, range] of after.entries()) {
      const original = before.ranges[index];
      expect(state.doc.sliceString(range.from, range.to)).toBe(
        oldText.slice(original.from, original.to),
      );
    }
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
