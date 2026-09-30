import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { FULL_REBUILD_LENGTH, livePreviewDecorations, livePreviewField } from "./livePreview";
import { markdownSupport } from "./markdown";
import { editorSettings, setEditorSettings, type EditorSettings } from "./settings";

/* --------------------------------------------------------------- test tools */

type Spec = {
  class?: string;
  attributes?: Record<string, string>;
  block?: boolean;
  widget?: { constructor: { name: string } };
};

/** A stable, comparable description of one decoration. */
function describeRange(from: number, to: number, value: unknown): string {
  const spec = (value as { spec: Spec }).spec;
  const parts = [`${from}-${to}`];
  if (spec.class) parts.push(spec.class);
  if (spec.attributes) parts.push(JSON.stringify(spec.attributes));
  if (spec.block) parts.push("block");
  if (spec.widget) parts.push(`${spec.widget.constructor.name}${JSON.stringify(spec.widget)}`);
  return parts.join("|");
}

function decoKeys(set: DecorationSet): string[] {
  const out: string[] = [];
  for (const iter = set.iter(); iter.value; iter.next()) out.push(describeRange(iter.from, iter.to, iter.value));
  return out.sort();
}

function stateFor(doc: string, options: { anchor?: number | EditorSelection; settings?: Partial<EditorSettings> } = {}) {
  return EditorState.create({
    doc,
    selection:
      options.anchor == null
        ? undefined
        : typeof options.anchor === "number"
          ? { anchor: options.anchor }
          : options.anchor,
    extensions: [
      markdownSupport,
      editorSettings({ ...options.settings }),
      livePreviewField,
    ],
  });
}

function currentKeys(state: EditorState): string[] {
  return decoKeys(state.field(livePreviewField).set);
}

/** The full, non-incremental build for the same state — what the field must agree with. */
function fullKeys(state: EditorState): string[] {
  return decoKeys(livePreviewDecorations(state));
}

function keysContaining(keys: string[], needle: string): string[] {
  return keys.filter((key) => key.includes(needle));
}

/** Roughly 88 characters per block, like the D24 benchmark document. */
function bigDoc(blocks: number): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i += 1) {
    parts.push(`## 标题 ${i}`, "", `一段包含 **粗体**、*斜体*、==高亮==、\`代码\`、$a+b$ 与 [[链接${i}]] 的正文。`, "");
    parts.push("- 列表项一", "- [ ] 任务项", "", "> 引用一行", "");
  }
  return parts.join("\n");
}

/* ------------------------------------------------------------ D13 · 未闭合公式 */

describe("D13 未闭合 $$ 不再吞掉后续内容", () => {
  const unclosed = "$$\n\\frac{1}{2}\n\n## 标题\n\n正文段落\n";
  /** [from, to] of the first `$$` block, closing fence included. */
  const blockSpan = (doc: string, fence = "$$") => {
    const from = doc.indexOf(fence);
    return [from, doc.indexOf(fence, from + fence.length) + fence.length] as const;
  };

  it("keeps the heading and paragraph after the blank line rendered", () => {
    const state = stateFor(unclosed, { anchor: unclosed.length });
    const keys = currentKeys(state);
    const from = 0;
    const to = unclosed.indexOf("\n\n");
    // the formula itself still renders as a block widget …
    const widgets = keysContaining(keys, "MathWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0].startsWith(`${from}-${to}|`)).toBe(true);
    expect(widgets[0]).toContain("block");
    // … and the heading is a heading, not part of a formula
    expect(keysContaining(keys, "md-h2")).toHaveLength(1);
    expect(keysContaining(keys, "md-math-src")).toHaveLength(0);
  });

  it("leaves the heading and paragraph lines free of formula decorations", () => {
    const state = stateFor(unclosed, { anchor: unclosed.length });
    const keys = currentKeys(state);
    const paragraphLine = state.doc.line(6).from;
    expect(keysContaining(keys, `${paragraphLine}-`)).toHaveLength(0);
    const [widget] = keysContaining(keys, "MathWidget");
    const widgetTo = Number(widget.split("|")[0].split("-")[1]);
    expect(widgetTo).toBeLessThan(state.doc.line(3).from); // stops before the blank line
  });

  it("still renders a closed block as one widget (unchanged behaviour)", () => {
    const doc = "引入\n\n$$\na = b\n$$\n\n## 后面的标题\n";
    const state = stateFor(doc, { anchor: doc.length });
    const keys = currentKeys(state);
    const [from, to] = blockSpan(doc);
    const widgets = keysContaining(keys, "MathWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toContain("block");
    expect(widgets[0].startsWith(`${from}-${to}|`)).toBe(true);
    expect(keysContaining(keys, "md-h2")).toHaveLength(1);
  });

  it("renders a closed multi-line block including its blank lines", () => {
    // a closed fence with a blank line inside keeps the old, single-widget shape
    const doc = "$$\na\nb\n$$\n";
    const state = stateFor(doc, { anchor: doc.length });
    expect(keysContaining(currentKeys(state), "MathWidget")).toHaveLength(1);
  });

  it("shows a huge unclosed block as source instead of one giant widget", () => {
    const doc = `$$\n${"a\n".repeat(80)}\n## 标题\n`;
    const state = stateFor(doc, { anchor: doc.length });
    const keys = currentKeys(state);
    expect(keysContaining(keys, "MathWidget")).toHaveLength(0);
    expect(keysContaining(keys, "md-math-src").length).toBeGreaterThan(60);
    expect(keysContaining(keys, "md-h2")).toHaveLength(1);
  });

  it("keeps a huge closed block as a widget", () => {
    const doc = `$$\n${"a\n".repeat(80)}$$\n`;
    const state = stateFor(doc, { anchor: doc.length });
    const keys = currentKeys(state);
    expect(keysContaining(keys, "MathWidget")).toHaveLength(1);
    expect(keysContaining(keys, "md-math-src")).toHaveLength(0);
  });

  it("uses md-math-src while the cursor is inside the formula", () => {
    const state = stateFor(unclosed, { anchor: 3 });
    const keys = currentKeys(state);
    expect(keysContaining(keys, "md-math-src").length).toBeGreaterThan(0);
  });
});

/* -------------------------------------------------- D27 · 样式类可达性（保留 CSS） */

describe("D27 md-table-src / md-math-src 仍然可达", () => {
  it("marks table source lines while the cursor is in the table", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const state = stateFor(doc, { anchor: 3 });
    expect(keysContaining(currentKeys(state), "md-table-src").length).toBeGreaterThan(0);
  });

  it("marks formula source lines while the cursor is in the formula", () => {
    const doc = "$$\na = b\n$$\n";
    const state = stateFor(doc, { anchor: 4 });
    const keys = currentKeys(state);
    expect(keysContaining(keys, "md-math-src")).toHaveLength(3);
    expect(keysContaining(keys, "MathWidget")).toHaveLength(0);
  });
});

/* -------------------------------------------- 装饰器基线（审计已核对的行为） */

describe("装饰器基线：未改动的形态保持原样", () => {
  it("标题：非激活态隐藏 `## ` 并打上行类，激活态只留行类", () => {
    const doc = "## 标题\n\n正文\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toContain("0-0|md-h2");
    expect(inactive).toContain("0-3");
    const active = currentKeys(stateFor(doc, { anchor: 2 }));
    expect(active).toContain("0-0|md-h2");
    expect(active).not.toContain("0-3");
  });

  it("粗体：非激活态隐藏 `**`，激活态保留标记", () => {
    const doc = "**粗体**\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toEqual(["0-2", "2-4|md-strong", "4-6"]);
    const active = currentKeys(stateFor(doc, { anchor: 3 }));
    expect(active).toEqual(["2-4|md-strong"]);
  });

  it("行内代码：隐藏反引号", () => {
    const doc = "`码`\n";
    expect(currentKeys(stateFor(doc, { anchor: doc.length }))).toEqual(["0-1", "1-2|md-code", "2-3"]);
  });

  it("链接：非激活态隐藏括号与 URL，激活态把 URL 标成源码", () => {
    const doc = "[站点](https://e.com)\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toContain("1-3|md-link");
    expect(inactive).toContain("5-18");
    const active = currentKeys(stateFor(doc, { anchor: 1 }));
    expect(active).toContain("1-3|md-link");
    expect(active).toContain("5-18|md-src");
  });

  it("图片：非激活态换成 ImageWidget（独占一行时加行类）", () => {
    const doc = "![图](https://i.example/p.png)\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    const widgets = keysContaining(keys, "ImageWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toContain('"raw":"https://i.example/p.png"');
    expect(keysContaining(keys, "md-media-line")).toHaveLength(1);
  });

  it("图片：widget 收的是**笔记路径** —— 相对引用的基准目录由它派生，编辑设置里不再有 baseDir", () => {
    const doc = "![图](./备注.assets/x.png)\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length, settings: { notePath: "归档/备注 2.md" } }));
    const widgets = keysContaining(keys, "ImageWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toContain('"notePath":"归档/备注 2.md"');
    expect(widgets[0]).not.toContain("baseDir");
  });

  it("wiki 链接：非激活态换成 WikiLinkWidget", () => {
    const doc = "参考 [[笔记]] 结束\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keysContaining(keys, "WikiLinkWidget")).toEqual(['3-9|WikiLinkWidget{"label":"笔记","exists":false}']);
  });

  it("列表与任务：项目符号与复选框换成 widget", () => {
    const doc = "- [ ] 任务\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keys).toContain('0-1|BulletWidget{"depth":1}');
    expect(keys).toContain('2-5|CheckboxWidget{"checked":false}');
  });

  it("分隔线：整行换成块级 HrWidget", () => {
    const doc = "---\n";
    expect(currentKeys(stateFor(doc, { anchor: doc.length }))).toEqual(["0-3|block|HrWidget{}"]);
  });

  it("引用：行类 + 隐藏 `>`", () => {
    const doc = "> 引用\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keys).toContain("0-0|md-quote md-quote-1");
    expect(keys).toContain("0-2");
  });

  it("setext 标题：隐藏下划线行", () => {
    const doc = "标题\n===\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keys).toContain("0-0|md-h1");
    expect(keys).toContain("3-3|md-hide-line");
    expect(keys).toContain("3-6");
  });

  it("围栏代码：非激活态隐藏围栏行，正文行带语言属性", () => {
    const doc = "```ts\nconst a = 1;\n```\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keys).toContain("0-0|md-hide-line");
    expect(keys).toContain("19-19|md-hide-line");
    expect(keys).toContain('6-6|md-code-line md-code-first md-code-last|{"data-lang":"ts"}');
  });

  it("mermaid：非激活态换成块级 MermaidWidget", () => {
    const doc = "```mermaid\ngraph TD\n  A-->B\n```\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    const widgets = keysContaining(keys, "MermaidWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toContain('"code":"graph TD\\n  A-->B"');
    expect(widgets[0]).toContain("block");
  });

  it("表格：非激活态换成块级 TableWidget", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    const widgets = keysContaining(keys, "TableWidget");
    expect(widgets).toHaveLength(1);
    expect(widgets[0]).toContain("block");
    expect(widgets[0]).toContain("<table");
  });

  it("专注模式：只给光标所在块加行类", () => {
    const doc = "# 标题\n\n正文一\n\n正文二\n";
    const keys = currentKeys(stateFor(doc, { anchor: 7, settings: { focus: true } }));
    expect(keysContaining(keys, "md-focus-on")).toEqual(["6-6|md-focus-on"]);
  });

  it("未闭合标记不会误隐藏（审计基线）", () => {
    const doc = "**未闭合 与 `码 与 [[链接 与 $x\n";
    const keys = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(keysContaining(keys, "md-strong")).toHaveLength(0);
    expect(keysContaining(keys, "md-code")).toHaveLength(0);
    expect(keysContaining(keys, "WikiLinkWidget")).toHaveLength(0);
    expect(keysContaining(keys, "MathWidget")).toHaveLength(0);
  });
});

/* ----------------------------------------------------------------- D24 · 增量重建 */
describe("D24 大文档增量重建", () => {
  const doc = bigDoc(250); // ≈22k 字符，超过全量重建阈值

  it("uses the incremental path above the threshold and the full build below it", () => {
    expect(doc.length).toBeGreaterThan(FULL_REBUILD_LENGTH);
    const setSpy = vi.spyOn(Decoration, "set");

    const medium = stateFor(doc);
    setSpy.mockClear();
    const grown = medium.update({ changes: { from: Math.floor(doc.length / 2), insert: "x" } }).state;
    expect(setSpy).not.toHaveBeenCalled();
    expect(currentKeys(grown)).toEqual(fullKeys(grown));

    const small = stateFor("## 标题\n\n正文 **粗体**\n");
    setSpy.mockClear();
    const smallNext = small.update({ changes: { from: 2, insert: "x" } }).state;
    expect(setSpy).toHaveBeenCalled();
    expect(currentKeys(smallNext)).toEqual(fullKeys(smallNext));
    setSpy.mockRestore();
  });

  it("stays equal to a full rebuild through a scripted edit session", () => {
    let state = stateFor(doc, { anchor: 0 });
    const ops: { label: string; spec: (s: EditorState) => TransactionSpec }[] = [
      { label: "在中间插入字符", spec: () => ({ changes: { from: 20000, insert: "新" } }) },
      { label: "拆分段落", spec: () => ({ changes: { from: 20010, insert: "\n" } }) },
      { label: "输入标题标记", spec: () => ({ changes: { from: 20012, insert: "#### " } }) },
      {
        label: "勾选任务",
        spec: (s) => {
          const at = s.doc.toString().indexOf("[ ]");
          return { changes: { from: at + 1, to: at + 2, insert: "x" } };
        },
      },
      { label: "删除一段", spec: () => ({ changes: { from: 19900, to: 20100, insert: "" } }) },
      { label: "光标移到文首", spec: () => ({ selection: { anchor: 0 } }) },
      { label: "光标移到文末", spec: (s) => ({ selection: { anchor: s.doc.length } }) },
      { label: "选中一片区域", spec: () => ({ selection: { anchor: 15000, head: 15100 } }) },
      { label: "把光标放进表格", spec: () => ({ changes: { from: 0, insert: "| a | b |\n| - | - |\n| 1 | 2 |\n\n" } }) },
      { label: "在文首追加引用", spec: () => ({ changes: { from: 0, insert: "> 引用\n\n" } }) },
      { label: "插入未闭合公式", spec: () => ({ changes: { from: 100, insert: "$$\n\\frac{1}{2}\n\n" } }) },
      { label: "补上公式闭合", spec: () => ({ changes: { from: 130, insert: "$$\n" } }) },
      {
        label: "整体替换文档",
        spec: (s) => ({ changes: { from: 0, to: s.doc.length, insert: doc + doc } }),
      },
    ];
    for (const op of ops) {
      state = state.update(op.spec(state)).state;
      expect(currentKeys(state), op.label).toEqual(fullKeys(state));
    }
  });

  it("stays equal to a full rebuild through randomized edits", () => {
    let seed = 20260929;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let state = stateFor(doc, { anchor: 0 });
    for (let step = 0; step < 60; step += 1) {
      const len = state.doc.length;
      const roll = random();
      if (roll < 0.35) {
        const pos = Math.floor(random() * len);
        const insert = ["x", "\n", "\n## 标题\n", "**粗体**", "$$", "| a | b |\n| - | - |\n", "- [ ] 任务\n"][
          Math.floor(random() * 7)
        ];
        state = state.update({ changes: { from: pos, insert } }).state;
      } else if (roll < 0.6) {
        const from = Math.floor(random() * len);
        const to = Math.min(len, from + Math.floor(random() * 200));
        state = state.update({ changes: { from, to, insert: random() < 0.5 ? "" : "替换" } }).state;
      } else if (roll < 0.85) {
        state = state.update({ selection: { anchor: Math.floor(random() * len) } }).state;
      } else {
        const from = Math.floor(random() * (len - 10));
        state = state.update({ selection: { anchor: from, head: from + Math.floor(random() * 10) } }).state;
      }
      expect(currentKeys(state), `step ${step}`).toEqual(fullKeys(state));
    }
  });

  it("keeps multiple cursors consistent", () => {
    let state = stateFor(doc, { anchor: 0 });
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.cursor(1000),
        EditorSelection.cursor(20000),
        EditorSelection.range(15000, 15050),
      ]),
    }).state;
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });

  it("rebuilds fully when the settings change", () => {
    let state = stateFor(doc, { anchor: 0 });
    state = state.update({ effects: setEditorSettings.of({ focus: true }) }).state;
    expect(keysContaining(currentKeys(state), "md-focus-on").length).toBeGreaterThan(0);
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });

  it("stays equal to a full rebuild in focus mode", () => {
    const near = Math.floor(doc.length / 5);
    let state = stateFor(doc, { anchor: near, settings: { focus: true } });
    expect(currentKeys(state)).toEqual(fullKeys(state));
    state = state.update({ selection: { anchor: doc.length - 5 } }).state;
    expect(currentKeys(state)).toEqual(fullKeys(state));
    state = state.update({ changes: { from: doc.length - 5, insert: "文字" } }).state;
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });
});
