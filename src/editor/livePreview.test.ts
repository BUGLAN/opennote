import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, type TransactionSpec } from "@codemirror/state";
import type { DecorationSet } from "@codemirror/view";
import { Decoration } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { FULL_REBUILD_LENGTH, findImageSource, livePreviewDecorations, livePreviewField } from "./livePreview";
import { setBlockPad } from "./blockHeight";
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

/**
 * 头less 测试里没有 view，语言解析靠 `setTimeout`（`Work.MaxPause` 500ms 一拍）
 * **异步**推进，每拍按**墙钟预算**（约 100ms 切片）解析多少字符取决于机器快慢
 * （见 `node_modules/@codemirror/language/dist/index.js` 的 parseWorker 调度与
 * `Work.Slice`）。而增量路径正是拿 `tree.length` 与 `value.parsedTo` 比，于是
 * 「增量 == 全量重建」这条断言会因「断言那一刻解析推进到哪」而分叉 —— CI 实测
 * step 38 多出一条过期 BulletWidget，本地却绿。
 *
 * D24 的等价性用例**不该测量解析时序**。这里把两件事都定死：
 *   1. `ensureSyntaxTree()` 同步把整篇解析完 —— 「现算的全量重建」拿到完整的树；
 *   2. 补一个「只改选区」的事务 —— 字段的 `updateDecorations()` 会走
 *      `tree.length > value.parsedTo` 那条分支，按完整的树重算一遍。
 * 之后两侧看到的是同一棵完整的树，比的才是增量算法本身。
 */
function settled(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 60_000);
  return state.update({ selection: state.selection }).state;
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
  it("标题：默认不露标记，光标在标题行上也隐藏 `## `；打开开关才露", () => {
    const doc = "## 标题\n\n正文\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toContain("0-0|md-h2");
    expect(inactive).toContain("0-3");

    // 默认 `showMarks: false`：光标在标题行上，标记**仍然**隐藏 ⇒ 文字不会横向窜动
    const activeDefault = currentKeys(stateFor(doc, { anchor: 2 }));
    expect(activeDefault).toContain("0-0|md-h2");
    expect(activeDefault).toContain("0-3");

    // 打开开关：回到「光标到哪露哪」（Typora 的默认，也是它 issue #285 的来源）
    const activeShown = currentKeys(stateFor(doc, { anchor: 2, settings: { showMarks: true } }));
    expect(activeShown).toContain("0-0|md-h2");
    expect(activeShown).not.toContain("0-3");
  });

  it("粗体：默认不露标记，激活态也隐藏 `**`；打开开关才保留标记", () => {
    const doc = "**粗体**\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toEqual(["0-2", "2-4|md-strong", "4-6"]);

    // 默认：光标落在粗体里，`**` 仍然隐藏 ⇒ 同一行后面的文字不右移
    const activeDefault = currentKeys(stateFor(doc, { anchor: 3 }));
    expect(activeDefault).toEqual(["0-2", "2-4|md-strong", "4-6"]);

    const activeShown = currentKeys(stateFor(doc, { anchor: 3, settings: { showMarks: true } }));
    expect(activeShown).toEqual(["2-4|md-strong"]);
  });

  it("行内代码：隐藏反引号", () => {
    const doc = "`码`\n";
    expect(currentKeys(stateFor(doc, { anchor: doc.length }))).toEqual(["0-1", "1-2|md-code", "2-3"]);
  });

  it("链接：默认不露标记，激活态也隐藏括号与 URL；打开开关才把 URL 标成源码", () => {
    const doc = "[站点](https://e.com)\n";
    const inactive = currentKeys(stateFor(doc, { anchor: doc.length }));
    expect(inactive).toContain("1-3|md-link");
    expect(inactive).toContain("5-18");

    const activeDefault = currentKeys(stateFor(doc, { anchor: 1 }));
    expect(activeDefault).toContain("1-3|md-link");
    expect(activeDefault).toContain("5-18");

    const activeShown = currentKeys(stateFor(doc, { anchor: 1, settings: { showMarks: true } }));
    expect(activeShown).toContain("1-3|md-link");
    expect(activeShown).toContain("5-18|md-src");
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
    // widget 里带着**块原文**（`---`）：光标进到这一行时，源码态要靠它查到
    // 「这块渲染出来有多高」并把差额补成留白（见 `blockHeight.ts` / `blockPad.ts`）。
    expect(currentKeys(stateFor(doc, { anchor: doc.length }))).toEqual(['0-3|block|HrWidget{"blockKey":"---"}']);
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

  /*
   * 守门用例（D29）：围栏行 / Setext 下划线行的露出范围必须**精确到那一行**，
   * 不能是「光标在整块内就露」。
   *
   * 原来只要光标在代码块内任意位置，首尾两条 ``` 就会露出来 —— 块高 +2 行，
   * 下方内容整块下移（真实浏览器实测 **+47px**）；Setext 下划线同理（**+29.36px**）。
   * 于是「在代码里按上下键」这种最日常的操作会持续把下面的内容推来推去。
   *
   * 现在只有光标**真的停在那两行上**才露 —— 要改语言、要删围栏，移过去仍然看得见。
   */
  it("围栏代码：光标在代码正文里时，围栏仍然隐藏（块高不随光标移动而变）", () => {
    const doc = "```ts\nconst a = 1;\n```\n";
    const inBody = doc.indexOf("const");
    const keys = currentKeys(stateFor(doc, { anchor: inBody }));
    // 正文行是「活跃」的，但两条围栏行**不**因此露出来
    expect(keys).toContain("0-0|md-hide-line");
    expect(keys).toContain("19-19|md-hide-line");
  });

  it("围栏代码：打开开关后，光标移到围栏行上才露出那两行（仍然改得动语言）", () => {
    const doc = "```ts\nconst a = 1;\n```\n";
    const onFence = currentKeys(stateFor(doc, { anchor: 1, settings: { showMarks: true } }));
    expect(keysContaining(onFence, "md-code-fence")).toHaveLength(2);
    expect(keysContaining(onFence, "md-hide-line")).toHaveLength(0);
  });

  it("setext 标题：光标在标题文字里时下划线仍隐藏；打开开关并移到下划线行才露", () => {
    const doc = "标题\n===\n";
    const inTitle = currentKeys(stateFor(doc, { anchor: 1 }));
    expect(inTitle).toContain("0-0|md-h1");
    expect(inTitle).toContain("3-3|md-hide-line");

    // 默认不露标记：即使光标就在下划线行上，也不露（块高恒定）
    const onUnderlineDefault = currentKeys(stateFor(doc, { anchor: 4 }));
    expect(onUnderlineDefault).toContain("3-3|md-hide-line");

    const onUnderlineShown = currentKeys(stateFor(doc, { anchor: 4, settings: { showMarks: true } }));
    expect(keysContaining(onUnderlineShown, "md-hide-line")).toHaveLength(0);
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

    const medium = settled(stateFor(doc));
    setSpy.mockClear();
    const grown = medium.update({ changes: { from: Math.floor(doc.length / 2), insert: "x" } }).state;
    expect(setSpy).not.toHaveBeenCalled();
    // 先断言「没走全量重建」，再定死解析进度做等价比较（settled 自己会补一个事务）。
    const settledGrown = settled(grown);
    expect(currentKeys(settledGrown)).toEqual(fullKeys(settledGrown));

    const small = stateFor("## 标题\n\n正文 **粗体**\n");
    setSpy.mockClear();
    const smallNext = small.update({ changes: { from: 2, insert: "x" } }).state;
    expect(setSpy).toHaveBeenCalled();
    expect(currentKeys(smallNext)).toEqual(fullKeys(smallNext));
    setSpy.mockRestore();
  });

  it("stays equal to a full rebuild through a scripted edit session", () => {
    let state = settled(stateFor(doc, { anchor: 0 }));
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
      state = settled(state.update(op.spec(state)).state);
      expect(currentKeys(state), op.label).toEqual(fullKeys(state));
    }
  });

  it("stays equal to a full rebuild through randomized edits", () => {
    let seed = 20260929;
    const random = () => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    let state = settled(stateFor(doc, { anchor: 0 }));
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
      // 解析推进到哪与机器快慢有关：比较前先定死（见 `settled()` 的说明）。
      state = settled(state);
      expect(currentKeys(state), `step ${step}`).toEqual(fullKeys(state));
    }
  });

  it("keeps multiple cursors consistent", () => {
    let state = settled(stateFor(doc, { anchor: 0 }));
    state = state.update({
      selection: EditorSelection.create([
        EditorSelection.cursor(1000),
        EditorSelection.cursor(20000),
        EditorSelection.range(15000, 15050),
      ]),
    }).state;
    state = settled(state);
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });

  it("rebuilds fully when the settings change", () => {
    let state = settled(stateFor(doc, { anchor: 0 }));
    state = settled(state.update({ effects: setEditorSettings.of({ focus: true }) }).state);
    expect(keysContaining(currentKeys(state), "md-focus-on").length).toBeGreaterThan(0);
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });

  it("stays equal to a full rebuild in focus mode", () => {
    const near = Math.floor(doc.length / 5);
    let state = settled(stateFor(doc, { anchor: near, settings: { focus: true } }));
    expect(currentKeys(state)).toEqual(fullKeys(state));
    state = settled(state.update({ selection: { anchor: doc.length - 5 } }).state);
    expect(currentKeys(state)).toEqual(fullKeys(state));
    state = settled(state.update({ changes: { from: doc.length - 5, insert: "文字" } }).state);
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });
});

/* ------------------------------------------- D28 · 装饰器必须追上后台解析器 */
/**
 * 守门用例（D28）。修复前的缺陷：`livePreviewField.update()` 的守卫
 *
 *     if (!tr.docChanged && !tr.selection && !settingsChanged) return value;
 *
 * 会把**只发 effect 的事务**直接放行 `return value` —— 而后台解析器推进语法树时发的
 * 正是这种事务（`node_modules/@codemirror/language/dist/index.js:621`：
 * `dispatch({ effects: Language.setState.of(...) })`）。
 *
 * 后果：文档尾部（前 3000 字符之后）一直停在**原始 markdown**，直到用户下一次点击/打字
 * 才一次性补上全部装饰 —— 那一下就是整篇重排。实测（6309 字文档）一次性新增 880 条装饰。
 *
 * 这里**刻意不用** `settled()`：`settled()` 手动补的那一次「只改选区的事务」，
 * 正是生产环境里用户必须手动点一下才能让文档渲染出来的那一次。
 */
describe("D28 装饰器必须追上后台解析器", () => {
  /**
   * 装饰集覆盖到的最远位置。文档尾部有没有被装饰，看这一个数就够 ——
   * 不用去猜 `Work.InitViewport`（3000）的边界，因为解析会停在某个块的中间，
   * 按位置硬切边界会切出几条「跨界」装饰（实测 7 条），断言就会假红。
   */
  function decoratedTo(state: EditorState): number {
    let to = 0;
    for (const iter = state.field(livePreviewField).set.iter(); iter.value; iter.next()) {
      if (iter.to > to) to = iter.to;
    }
    return to;
  }

  it("初始化只解析到前 3000 字符，文档尾部没有任何装饰（显示为原始 markdown）", () => {
    const doc = bigDoc(80); // ≈6.3k 字符
    const state = stateFor(doc);

    expect(doc.length).toBeGreaterThan(3000);
    // 树是残缺的：尾部还没解析
    expect(syntaxTree(state).length).toBeLessThan(doc.length);
    // 前段有装饰（说明装饰本身是好的）
    expect(currentKeys(state).length).toBeGreaterThan(0);
    // 尾部一条都没有 ⇒ 用户看到的是原始 markdown
    expect(decoratedTo(state)).toBeLessThan(doc.length);
  });

  it("后台解析推进后，只发 effect 的事务也必须让装饰器追上（不许等到用户点一下）", () => {
    const doc = bigDoc(80);
    let state = stateFor(doc);
    const before = currentKeys(state);
    const beforeTo = decoratedTo(state);

    // 1) 后台 ParseWorker 把整篇解析完
    ensureSyntaxTree(state, doc.length, 60_000);
    // 2) 模拟它发出的**只有 effect** 的事务：没有 docChanged、没有 selection，
    //    effect 也不是 setEditorSettings / refreshDecorations
    state = state.update({}).state;

    // 语法树已经完整 —— 这一步在修复前后都成立
    expect(syntaxTree(state).length).toBe(doc.length);

    // 装饰器必须**已经**追上，而不是等下一次用户事务
    expect(decoratedTo(state)).toBeGreaterThan(beforeTo);
    expect(currentKeys(state).length).toBeGreaterThan(before.length);
    // 而且必须与「现算的全量重建」逐条一致
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });
});

/* --------------------------------------------- 块级内容源码态补白（blockPad） */
/**
 * 块级内容换形态时两种高度不同（表格差 92px、mermaid 差 143px），而「块下方内容不动」
 * 等价于「块的高度不变」—— 所以源码态必须把差额补成留白。这一组守的是**装饰那一半**：
 * `setBlockPad` 收到的补白必须真的落到块最后一行的 `padding-bottom` 上。
 *
 * 「量出该补多少」那一半在 `blockPad.ts` 的 ViewPlugin 里，需要真实浏览器（几何断言脚本）。
 */
describe("块级内容源码态补白", () => {
  it("setBlockPad 把补白落到块最后一行的 padding-bottom 上", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    // 光标在表格里 ⇒ 表格是源码态
    let state = stateFor(doc, { anchor: 0 });
    expect(keysContaining(currentKeys(state), "md-table-src").length).toBeGreaterThan(0);
    expect(keysContaining(currentKeys(state), "padding-bottom").length).toBe(0);

    state = state.update({ effects: setBlockPad.of({ key: table, pad: 92 }) }).state;
    expect(keysContaining(currentKeys(state), "padding-bottom:92px")).toHaveLength(1);
    // 补白落在**最后一行**上（把块的下边界往下推，块自身与上方都不受影响）
    expect(keysContaining(currentKeys(state), "padding-bottom:92px")[0]).toMatch(/^\d+-\d+\|/);
  });

  it("pad 小于 1px 视为不补（否则「量→派发→重算→再量」会一直循环）", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n";
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    let state = stateFor(doc, { anchor: 0 });
    state = state.update({ effects: setBlockPad.of({ key: table, pad: 0.4 }) }).state;
    expect(keysContaining(currentKeys(state), "padding-bottom")).toHaveLength(0);
  });

  it("补白只作用在**源码态**：块渲染成 widget 时不加（否则 widget 会被垫高）", () => {
    const doc = "| a | b |\n| - | - |\n| 1 | 2 |\n\n正文\n";
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    // 光标在正文里 ⇒ 表格是渲染态
    let state = stateFor(doc, { anchor: doc.length - 1 });
    expect(keysContaining(currentKeys(state), "TableWidget")).toHaveLength(1);
    state = state.update({ effects: setBlockPad.of({ key: table, pad: 92 }) }).state;
    expect(keysContaining(currentKeys(state), "TableWidget")).toHaveLength(1);
    expect(keysContaining(currentKeys(state), "padding-bottom")).toHaveLength(0);
  });

  it("补白改变时会整体重算（增量路径不会把它带上）", () => {
    const table = "| a | b |\n| - | - |\n| 1 | 2 |";
    // 大文档里必须**真的有**那张表，否则补白没有落点
    const doc = `${table}\n\n${bigDoc(250)}`;
    let state = settled(stateFor(doc, { anchor: 0 }));
    expect(doc.length).toBeGreaterThan(FULL_REBUILD_LENGTH);
    state = state.update({ effects: setBlockPad.of({ key: table, pad: 42 }) }).state;
    expect(keysContaining(currentKeys(state), "padding-bottom:42px")).toHaveLength(1);
    expect(currentKeys(state)).toEqual(fullKeys(state));
  });
});

/* --------------------------------------------- 「块还没成立就显示源码」 */
/**
 * 默认模型是**渲染态持久**：标记不因为光标经过就露出来。源码只在两种时候出现 ——
 *
 *   ① 块还没成立（空标题 / 空引用 / 空列表项 / 空代码块）—— 这一组
 *   ② 用户正在拆它（光标停在边界按删除）—— 见 `unwrap.test.ts`
 *
 * 「敲下 `##` 看得见 → 敲进文字就消失 → 把文字删空又回来」这三件事全由 ① 给出，
 * 不需要任何额外的按键行为。
 */
describe("块还没成立就显示源码", () => {
  it("空标题露出 `# `，有文字就藏起来", () => {
    expect(keysContaining(currentKeys(stateFor("# \n", { anchor: 2 })), "md-src")).toHaveLength(1);
    expect(keysContaining(currentKeys(stateFor("# 标题\n", { anchor: 4 })), "md-src")).toHaveLength(0);
  });

  it("空引用露出 `>`，有文字就藏起来", () => {
    expect(keysContaining(currentKeys(stateFor("> \n", { anchor: 2 })), "md-src")).toHaveLength(1);
    expect(keysContaining(currentKeys(stateFor("> 引用\n", { anchor: 4 })), "md-src")).toHaveLength(0);
  });

  it("空列表项露出 `-`，有文字才换成圆点 widget", () => {
    const empty = currentKeys(stateFor("- \n", { anchor: 2 }));
    expect(keysContaining(empty, "md-src")).toHaveLength(1);
    expect(keysContaining(empty, "BulletWidget")).toHaveLength(0);

    expect(keysContaining(currentKeys(stateFor("- 项目\n", { anchor: 4 })), "BulletWidget")).toHaveLength(1);
  });

  it("空代码块：光标落在空行上也露出围栏（此刻它还不成立）", () => {
    const keys = currentKeys(stateFor("```js\n\n```\n", { anchor: 6 }));
    expect(keysContaining(keys, "md-hide-line")).toHaveLength(0);
  });

  it("有内容的代码块：光标在代码里时围栏仍然隐藏（否则块高会反复变 47px）", () => {
    const doc = "```js\nconst a = 1;\n```\n";
    const keys = currentKeys(stateFor(doc, { anchor: 10 }));
    expect(keysContaining(keys, "md-hide-line")).toHaveLength(2);
  });
});

/* ------------------------------------------- 右键菜单（编辑/删除图片）的定位 */
/**
 * 菜单拿到的是编辑器交出来的**完整源码串 + 被右键那一个的位置**，范围得问语法树要。
 * 这一组守的是「改得准 / 删得准」：拿 `indexOf` 去猜会命中第一处，那是 bug。
 */
describe("findImageSource：按完整源码定位图片", () => {
  const SOURCE = "![图](./a.png)";
  const URL = "./a.png";
  /** `![说明](` 是 5 个字符，引用串从第 5 位开始。 */
  const at = (from: number) => ({ from, to: from + SOURCE.length, urlFrom: from + 5, urlTo: from + 5 + URL.length });

  it("定位到真正的 Image 节点，并把**引用串**的范围一起给出来（编辑图片要落在它上面）", () => {
    expect(findImageSource(stateFor(`${SOURCE}\n`), SOURCE)).toEqual(at(0));
  });

  it("代码块里的字面量不算 —— 否则会改错地方", () => {
    expect(findImageSource(stateFor(`\`\`\`\n${SOURCE}\n\`\`\`\n`), SOURCE)).toBeNull();
  });

  it("**同一张图被引用两次时，命中的是右键的那一个**（不是第一处）", () => {
    const doc = `${SOURCE}\n\n文字\n\n${SOURCE}\n`;
    const second = doc.lastIndexOf(SOURCE);
    expect(second).toBeGreaterThan(0);
    // 右键的是第二处
    expect(findImageSource(stateFor(doc), SOURCE, second)).toEqual(at(second));
    // 右键的是第一处
    expect(findImageSource(stateFor(doc), SOURCE, 0)).toEqual(at(0));
  });

  it("位置对不上就返回 null —— 宁可报「没找到」，也不能删错到别的地方去", () => {
    const doc = `${SOURCE}\n\n文字\n\n${SOURCE}\n`;
    // 文档已经改过，交出来的位置不再是一张图
    expect(findImageSource(stateFor(doc), SOURCE, 1)).toBeNull();
  });

  it("没给位置时退回第一处（旧行为，只用于位置不可用时的兜底）", () => {
    const doc = `${SOURCE}\n\n文字\n\n${SOURCE}\n`;
    expect(findImageSource(stateFor(doc), SOURCE)).toEqual(at(0));
  });

  it("找不到就返回 null（宿主据此提示，而不是乱删）", () => {
    expect(findImageSource(stateFor("正文\n"), SOURCE)).toBeNull();
    expect(findImageSource(stateFor("正文\n"), "")).toBeNull();
  });

  it("**源码串缺失时只靠位置也能定位** —— 否则会莫名报「没找到这张图片」", () => {
    // 真实踩到过：vite HMR 半更新时，已挂载的编辑器还在用旧的 bridge，
    // `target.source` 是 `undefined`。位置是当时从 DOM 取的，仍然是对的。
    const doc = `${SOURCE}\n\n文字\n\n${SOURCE}\n`;
    const second = doc.lastIndexOf(SOURCE);
    expect(findImageSource(stateFor(doc), "", second)).toEqual(at(second));
    expect(findImageSource(stateFor(doc), undefined as unknown as string, second)).toEqual(at(second));
  });

  it("既没有位置也没有源码串 ⇒ null（无从下手）", () => {
    expect(findImageSource(stateFor(`${SOURCE}\n`), "")).toBeNull();
  });

  it("**解析还没追上时**靠「位置 + 文本」兜底也能定位（图片在 3000 字符之后）", () => {
    /*
     * `@codemirror/language` 的 `LanguageState.init` 只**同步**解析前 3000 个字符，
     * 其余交给后台 ParseWorker。于是刚打开一篇长笔记时，`syntaxTree()` 里可能真的
     * 还没有那个 Image 节点 —— 这是右键菜单必须能扛住的情况。
     */
    const padding = "填充文字，用来把图片推到 3000 字符之后。".repeat(200);
    const doc = `${padding}\n\n${SOURCE}\n`;
    const imageAt = doc.indexOf(SOURCE);
    expect(imageAt).toBeGreaterThan(3000);

    const state = stateFor(doc);
    // 语法树里确实还没有它
    expect(findImageSource(state, SOURCE)).toBeNull();
    // 但位置兜底可以定位，且引用串范围照样给得出来
    expect(findImageSource(state, SOURCE, imageAt)).toEqual({
      from: imageAt,
      to: imageAt + SOURCE.length,
      urlFrom: imageAt + 5,
      urlTo: imageAt + 5 + URL.length,
    });
  });
});
