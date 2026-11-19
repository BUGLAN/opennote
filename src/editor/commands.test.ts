import { EditorState, type TransactionSpec } from "@codemirror/state";
import type { Command, EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  insertCodeBlock,
  insertHorizontalRule,
  insertMathBlock,
  insertMermaidBlock,
  insertTable,
  insertWikiLink,
  markdownCommands,
  toggleBold,
  toggleItalic,
  toggleLinePrefix,
} from "./commands";
import { opennoteParser } from "./mdExtensions";

function run(command: Command, doc: string, from: number, to = from, readOnly = false) {
  let state = EditorState.create({
    doc,
    selection: { anchor: from, head: to },
    extensions: readOnly ? EditorState.readOnly.of(true) : [],
  });
  const view = {
    get state() {
      return state;
    },
    dispatch(spec: TransactionSpec) {
      state = state.update(spec).state;
    },
    focus() {},
  } as unknown as EditorView;

  const handled = command(view);
  return { handled, state };
}

function slicesFor(source: string, name: string): string[] {
  const slices: string[] = [];
  opennoteParser.parse(source).iterate({
    enter(node) {
      if (node.name === name) slices.push(source.slice(node.from, node.to));
    },
  });
  return slices;
}

function nodeNames(source: string): string[] {
  const names: string[] = [];
  opennoteParser.parse(source).iterate({
    enter(node) {
      names.push(node.name);
    },
  });
  return names;
}

describe("toggleWrap：按定界符层次切换格式", () => {
  it("粗体里按斜体得到粗斜体", () => {
    const { state } = run(toggleItalic, "**粗体**", 2, 4);
    expect(state.doc.toString()).toBe("***粗体***");
    expect(state.sliceDoc(state.selection.main.from, state.selection.main.to)).toBe("粗体");
  });

  it("粗斜体里按斜体或粗体会去掉对应的一层", () => {
    expect(run(toggleItalic, "***粗体***", 3, 5).state.doc.toString()).toBe("**粗体**");
    expect(run(toggleBold, "***粗体***", 3, 5).state.doc.toString()).toBe("*粗体*");
  });

  it("斜体里按粗体得到粗斜体", () => {
    expect(run(toggleBold, "*斜体*", 1, 3).state.doc.toString()).toBe("***斜体***");
  });

  it("选区包含定界符时首尾同样判断", () => {
    expect(run(toggleItalic, "**粗体**", 0, 6).state.doc.toString()).toBe("***粗体***");
    expect(run(toggleItalic, "*粗体*", 0, 4).state.doc.toString()).toBe("粗体");
    expect(run(toggleBold, "***粗体***", 0, 8).state.doc.toString()).toBe("*粗体*");
  });

  it("普通文本加粗、取消加粗行为不变", () => {
    expect(run(toggleBold, "普通文字", 0, 4).state.doc.toString()).toBe("**普通文字**");
    expect(run(toggleBold, "**普通文字**", 2, 6).state.doc.toString()).toBe("普通文字");
  });
});

describe("toggleLinePrefix：列表类型互转", () => {
  it("无序、有序、任务任意互转只保留目标前缀", () => {
    const cases: Array<[Command, string, string]> = [
      [toggleLinePrefix("task"), "- 买牛奶", "- [ ] 买牛奶"],
      [toggleLinePrefix("ordered"), "- 买牛奶", "1. 买牛奶"],
      [toggleLinePrefix("bullet"), "- [ ] 买牛奶", "- 买牛奶"],
      [toggleLinePrefix("ordered"), "- [ ] 买牛奶", "1. 买牛奶"],
      [toggleLinePrefix("task"), "1. 买牛奶", "- [ ] 买牛奶"],
      [toggleLinePrefix("bullet"), "1. 买牛奶", "- 买牛奶"],
    ];

    for (const [command, source, expected] of cases) {
      expect(run(command, source, 0, source.length).state.doc.toString()).toBe(expected);
    }
  });

  it("多行转有序列表时编号连续并保留缩进", () => {
    const source = "  - 买牛奶\n* 鸡蛋\n+ 面包";
    expect(run(toggleLinePrefix("ordered"), source, 0, source.length).state.doc.toString()).toBe(
      "  1. 买牛奶\n2. 鸡蛋\n3. 面包",
    );
  });

  it("所选行全部是目标类型时取消，任务框不残留", () => {
    const cases: Array<[Command, string, string]> = [
      [toggleLinePrefix("task"), "  - [x] 买牛奶", "  买牛奶"],
      [toggleLinePrefix("bullet"), "* 买牛奶", "买牛奶"],
      [toggleLinePrefix("ordered"), "12) 买牛奶", "买牛奶"],
    ];

    for (const [command, source, expected] of cases) {
      expect(run(command, source, 0, source.length).state.doc.toString()).toBe(expected);
    }
  });

  it("混合列表统一转成目标类型", () => {
    const source = "- 买牛奶\n1. 鸡蛋";
    expect(run(toggleLinePrefix("task"), source, 0, source.length).state.doc.toString()).toBe(
      "- [ ] 买牛奶\n- [ ] 鸡蛋",
    );
  });
});

const BLOCKS = [
  { name: "代码块", command: insertCodeBlock, marker: "```", node: "FencedCode" },
  { name: "公式块", command: insertMathBlock, marker: "$$", node: "MathBlock" },
  { name: "Mermaid", command: insertMermaidBlock, marker: "```mermaid", node: "FencedCode" },
  { name: "表格", command: insertTable, marker: "| 列 1 |", node: "Table" },
] as const;

describe("insertBlock：块级内容与相邻文字隔开", () => {
  for (const block of BLOCKS) {
    it(`${block.name}：行中插入时拆开这一行，后续内容仍是独立段落`, () => {
      const doc = "前半段后半段\n\n下面还有很多内容\n# 标题";
      const cursor = doc.indexOf("后半段");
      const { state } = run(block.command, doc, cursor);
      const output = state.doc.toString();

      expect(output.startsWith(`前半段\n\n${block.marker}`)).toBe(true);
      expect(output).toContain(`\n\n后半段\n\n下面还有很多内容\n# 标题`);
      expect(slicesFor(output, block.node).every((slice) => !slice.includes("后半段"))).toBe(true);
      expect(nodeNames(output)).toContain("ATXHeading1");
    });
  }

  it("分割线：段落下一行插入后仍是 Paragraph + HorizontalRule", () => {
    const doc = "这是一段正文\n";
    const { state } = run(insertHorizontalRule, doc, doc.length);
    const output = state.doc.toString();

    expect(output).toBe("这是一段正文\n\n---\n");
    expect(nodeNames(output)).toContain("Paragraph");
    expect(nodeNames(output)).toContain("HorizontalRule");
    expect(nodeNames(output)).not.toContain("SetextHeading2");
  });

  it("空文档插入各种块时不多出空行", () => {
    const cases = [
      [insertCodeBlock, "```\n\n```"],
      [insertMathBlock, "$$\n\n$$"],
      [insertMermaidBlock, "```mermaid\ngraph TD\n  A[开始] --> B[结束]\n```"],
      [insertTable, "| 列 1 | 列 2 |\n| --- | --- |\n| 内容 | 内容 |"],
      [insertHorizontalRule, "---\n"],
    ] as const;

    for (const [command, expected] of cases) {
      expect(run(command, "", 0).state.doc.toString()).toBe(expected);
    }
  });

  it("空行插入时只在相邻文字一侧补空行", () => {
    const between = "前\n\n后";
    expect(run(insertCodeBlock, between, between.indexOf("后") - 1).state.doc.toString()).toBe(
      "前\n\n```\n\n```\n\n后",
    );

    const extraBlank = "前\n\n\n后";
    expect(run(insertCodeBlock, extraBlank, extraBlank.indexOf("后") - 2).state.doc.toString()).toBe(
      "前\n\n```\n\n```\n\n后",
    );

    const atStart = "\n后";
    expect(run(insertCodeBlock, atStart, 0).state.doc.toString()).toBe("```\n\n```\n\n后");

    const atEnd = "前\n";
    expect(run(insertCodeBlock, atEnd, atEnd.length).state.doc.toString()).toBe("前\n\n```\n\n```");
  });

  it("光标与选区仍相对块本身计算", () => {
    const doc = "前|后";
    const cursor = doc.indexOf("|");
    const cases = [
      { command: insertCodeBlock, marker: "```", offset: 4, selectLength: 0 },
      { command: insertMathBlock, marker: "$$", offset: 3, selectLength: 0 },
      { command: insertMermaidBlock, marker: "```mermaid", offset: 25, selectLength: 0 },
      { command: insertTable, marker: "| 列 1 |", offset: 2, selectLength: 3 },
      { command: insertHorizontalRule, marker: "---\n", offset: 4, selectLength: 0 },
    ] as const;

    for (const entry of cases) {
      const { state } = run(entry.command, doc, cursor);
      const output = state.doc.toString();
      const blockStart = output.indexOf(entry.marker);
      expect(state.selection.main.anchor).toBe(blockStart + entry.offset);
      expect(state.selection.main.head).toBe(blockStart + entry.offset + entry.selectLength);
    }

    const table = run(insertTable, doc, cursor);
    const tableOutput = table.state.doc.toString();
    const selection = table.state.selection.main;
    expect(tableOutput.slice(selection.from, selection.to)).toBe("列 1");
  });

  it("行内 wiki link 不引入块级空行", () => {
    const { state } = run(insertWikiLink(), "看 后", 2);
    expect(state.doc.toString()).toBe("看 [[]]后");
    expect(state.selection.main.anchor).toBe(4);
  });
});

describe("markdownCommands：只读时拒绝改动", () => {
  const doc = "**锁住的笔记**\n\n- 列表\n\n[链接](https://example.com)";

  for (const [id, command] of Object.entries(markdownCommands)) {
    it(id, () => {
      const { handled, state } = run(command, doc, 0, doc.length, true);
      expect(handled).toBe(false);
      expect(state.doc.toString()).toBe(doc);
    });
  }
});
