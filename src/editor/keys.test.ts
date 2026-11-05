import { describe, expect, it } from "vitest";
import { keyKit } from "./testing/keyKit";

/**
 * 按键语义的回归用例：每一条都是 2026-11 排查报告里**实测复现过**的缺陷。
 *
 * 光标用 `‸` 标在文档里，选区用 `[[[` … `]]]`。夹具走的是真实编辑器的整套扩展与真实的
 * keymap 优先级（见 `testing/keyKit.ts`），所以这里断言的就是「用户按下这个键会发生什么」。
 */

describe("标题", () => {
  it("在标题文字开头按退格 ⇒ 变成普通段落（不是 `##标题`）", () => {
    const kit = keyKit("## ‸标题");
    kit.press("Backspace");
    expect(kit.show()).toBe("‸标题");
  });

  it("在标题文字开头按回车 ⇒ 上方插一个空行，标题保持不变", () => {
    const kit = keyKit("## ‸标题");
    kit.press("Enter");
    expect(kit.show()).toBe("\n## ‸标题");
  });

  it("光标落在被隐藏的 `## ` 里 ⇒ 吸附到文字开头（打字不会写到 `#` 前面）", () => {
    const kit = keyKit("## 标题");
    kit.view.dispatch({ selection: { anchor: 0 } });
    expect(kit.show()).toBe("## ‸标题");
    kit.type("新");
    expect(kit.state.doc.toString()).toBe("## 新标题");
  });

  it("从标题文字开头按 ← ⇒ 去上一行末尾，不会被吸附卡住", () => {
    const kit = keyKit("前一行\n## ‸标题");
    kit.press("ArrowLeft");
    expect(kit.show()).toBe("前一行‸\n## 标题");
  });

  it("已在文字开头时点行首 / Home（落点 = 行首）⇒ 留在文字开头，不跳到上一行", () => {
    const kit = keyKit("前一行\n## ‸标题");
    kit.view.dispatch({ selection: { anchor: 4 }, userEvent: "select.pointer" });
    expect(kit.show()).toBe("前一行\n## ‸标题");
  });

  it("引用 / 列表里的标题，文字开头回车 ⇒ 上方插一行同样的容器前缀，标题不动", () => {
    let kit = keyKit("> ## ‸标题");
    kit.press("Enter");
    expect(kit.show()).toBe("> \n> ## ‸标题");
    kit = keyKit("- ## ‸标题");
    kit.press("Enter");
    expect(kit.show()).toBe("- \n- ## ‸标题");
  });

  it("在上一段末尾按 Delete ⇒ 把标题文字并上来，不留下一个字面的 `## `", () => {
    const kit = keyKit("前一行‸\n## 标题");
    kit.press("Delete");
    expect(kit.show()).toBe("前一行‸标题");
  });

  it("空标题（`## ` 还没文字）不吸附 —— 此刻源码是可见的", () => {
    const kit = keyKit("## ");
    kit.view.dispatch({ selection: { anchor: 1 } });
    expect(kit.show()).toBe("#‸# ");
  });
});

describe("行内标记", () => {
  it("`**粗** ` 后面按退格 ⇒ 删掉空格，而不是先拆开粗体", () => {
    const kit = keyKit("**粗** ‸后");
    kit.press("Backspace");
    expect(kit.show()).toBe("**粗**‸后");
  });

  it("在链接文字末尾按 Delete ⇒ 先拆开链接，绝不一键删掉看不见的 `](url)`", () => {
    const kit = keyKit("[文字‸](https://a.com) 后");
    expect(kit.press("Delete")).toBe(true);
    expect(kit.state.doc.toString()).toBe("[文字](https://a.com) 后");
  });

  it("选中粗体里的字按 ⌘I ⇒ 粗体 + 斜体（不是把粗体变成斜体）", () => {
    const kit = keyKit("**[[[粗体]]]**");
    kit.press("Mod-i");
    expect(kit.state.doc.toString()).toBe("***粗体***");
  });

  it("选中斜体里的字按 ⌘I ⇒ 取消斜体", () => {
    const kit = keyKit("前 *[[[斜体]]]* 后");
    kit.press("Mod-i");
    expect(kit.state.doc.toString()).toBe("前 斜体 后");
  });

  it("光标停在粗体里（没有选区）按 ⌘B ⇒ 取消这段粗体", () => {
    const kit = keyKit("前 **粗‸体** 后");
    kit.press("Mod-b");
    expect(kit.show()).toBe("前 粗‸体 后");
  });

  it("普通文字里没有选区按 ⌘B ⇒ 插入占位并选中", () => {
    const kit = keyKit("前 ‸ 后");
    kit.press("Mod-b");
    expect(kit.show()).toBe("前 **[[[粗体]]]** 后");
  });
});

describe("列表 / 标题命令替换已有前缀", () => {
  it("无序项转有序 ⇒ `1. 项`", () => {
    const kit = keyKit("- 项‸");
    kit.press("Mod-Shift-7");
    expect(kit.state.doc.toString()).toBe("1. 项");
  });

  it("无序项转任务 ⇒ `- [ ] 项`", () => {
    const kit = keyKit("- 项‸");
    kit.press("Mod-Shift-9");
    expect(kit.state.doc.toString()).toBe("- [ ] 项");
  });

  it("任务项转无序 ⇒ `- 项`", () => {
    const kit = keyKit("- [ ] 项‸");
    kit.press("Mod-Shift-8");
    expect(kit.state.doc.toString()).toBe("- 项");
  });

  it("再按一次同类 ⇒ 取消列表", () => {
    const kit = keyKit("1. 项‸");
    kit.press("Mod-Shift-7");
    expect(kit.state.doc.toString()).toBe("项");
  });

  it("引用里的行转无序 ⇒ 列表在引用里面", () => {
    const kit = keyKit("> 项‸");
    kit.press("Mod-Shift-8");
    expect(kit.state.doc.toString()).toBe("> - 项");
  });

  it("列表项设成二级标题 ⇒ `- ## 项`（标题在列表项里）", () => {
    const kit = keyKit("- 项‸");
    kit.press("Mod-2");
    expect(kit.state.doc.toString()).toBe("- ## 项");
  });

  it("引用行设成二级标题 ⇒ `> ## 引`", () => {
    const kit = keyKit("> 引‸");
    kit.press("Mod-2");
    expect(kit.state.doc.toString()).toBe("> ## 引");
  });

  it("标题换级别 / 再按同级取消", () => {
    const kit = keyKit("### 标‸题");
    kit.press("Mod-2");
    expect(kit.state.doc.toString()).toBe("## 标题");
    kit.press("Mod-2");
    expect(kit.state.doc.toString()).toBe("标题");
  });
});

describe("表格", () => {
  const TABLE = "| a | b |\n| - | - |\n| 1 | 2 |";

  it("单元格里按回车 ⇒ 在下面插一行，光标进同一列（不拆开当前行）", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | ‸2 |");
    kit.press("Enter");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1 | 2 |\n|  | ‸ |");
  });

  it("空的最后一行再按回车 ⇒ 删掉空行、跳出表格，下面隔一个空行", () => {
    const kit = keyKit(`${TABLE}\n| |  |   |`);
    kit.press("Enter");
    expect(kit.show()).toBe(`${TABLE}\n\n‸`);
  });

  it("⌘回车 ⇒ 直接跳出表格", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| ‸1 | 2 |");
    kit.press("Mod-Enter");
    expect(kit.show()).toBe(`${TABLE}\n\n‸`);
  });

  it("单元格开头按退格 ⇒ 什么都不删（不会删掉看不见的空格和竖线）", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | ‸2 |");
    kit.press("Backspace");
    expect(kit.state.doc.toString()).toBe(TABLE);
  });

  it("单元格末尾按 Delete ⇒ 什么都不删", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.press("Delete");
    expect(kit.state.doc.toString()).toBe(TABLE);
  });

  it("Tab / Shift-Tab ⇒ 在单元格之间跳，跳过分隔行", () => {
    const kit = keyKit("| a | ‸b |\n| - | - |\n| 1 | 2 |");
    kit.press("Tab");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.press("Shift-Tab");
    expect(kit.show()).toBe("| a | b‸ |\n| - | - |\n| 1 | 2 |");
  });

  it("最后一格按 Tab ⇒ 新起一行", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | 2‸ |");
    kit.press("Tab");
    expect(kit.show()).toBe(`${TABLE}\n| ‸ |  |`);
  });

  it("单元格里打 `|` ⇒ 写成 `\\|`，不会多出一列", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.press("|");
    expect(kit.state.doc.toString()).toBe("| a | b |\n| - | - |\n| 1\\| | 2 |");
  });
});

describe("补全", () => {
  it("wiki 链接补全不会和自动补全的括号叠成 `]]]]`", async () => {
    const kit = keyKit("[[‸]]");
    const { wikiCompletion } = await import("./completion");
    const { CompletionContext } = await import("@codemirror/autocomplete");
    type CompletionResult = import("@codemirror/autocomplete").CompletionResult;
    const result = wikiCompletion(() => ["笔记"])(new CompletionContext(kit.state, 2, true)) as CompletionResult | null;
    expect(result).toBeTruthy();
    const option = result!.options[0];
    expect(typeof option.apply).toBe("function");
    (option.apply as (view: unknown, completion: unknown, from: number, to: number) => void)(kit.view, option, result!.from, 2);
    expect(kit.state.doc.toString()).toBe("[[笔记]]");
  });
});

describe("链接浮层", () => {
  it("光标停在链接里 ⇒ 有浮层（地址藏着、光标又走不进去，这是唯一入口）", async () => {
    const { linkTip } = await import("./linkTip");
    const kit = keyKit("前 [文‸字](https://a.com) 后");
    expect(kit.state.field(linkTip)?.pos).toBe(2);
  });

  it("光标不在链接里 / 链接已拆开 ⇒ 没有浮层", async () => {
    const { linkTip } = await import("./linkTip");
    const { unwrapSource } = await import("./unwrapEffect");
    const kit = keyKit("前‸ [文字](https://a.com) 后");
    expect(kit.state.field(linkTip)).toBeNull();
    kit.view.dispatch({ selection: { anchor: 4 }, effects: unwrapSource.of({ from: 2, to: 21 }) });
    expect(kit.state.field(linkTip)).toBeNull();
  });
});

describe("表格：光标吸附与工具条", () => {
  it("光标落在隐藏的竖线 / 空白上 ⇒ 吸到格子文字边上", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | 2 |‸");
    kit.view.dispatch({ selection: { anchor: 20 } }); // 第三行行首的 `|` 前面
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| ‸1 | 2 |");
    kit.view.dispatch({ selection: { anchor: 29 } }); // 第三行行尾 `|` 后面
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1 | 2‸ |");
  });

  it("光标落到分隔行上 ⇒ 从上面来进正文第一行，从下面来回表头", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | 2 |");
    kit.view.dispatch({ selection: { anchor: 3 } });
    kit.view.dispatch({ selection: { anchor: 12 } });
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.view.dispatch({ selection: { anchor: 12 } });
    expect(kit.show()).toBe("| a‸ | b |\n| - | - |\n| 1 | 2 |");
  });

  it("← / → 到格子边界 ⇒ 跳到相邻格子", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.press("ArrowRight");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1 | ‸2 |");
    kit.press("ArrowLeft");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1‸ | 2 |");
  });

  it("工具条：右侧插列 / 删行 / 居中，整张表一次重写", async () => {
    const { applyTableOp } = await import("./tableEdit");
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |\n| 3 | 4 |");
    applyTableOp(kit.view, "colRight");
    expect(kit.show()).toBe("| a |  | b |\n| --- | --- | --- |\n| 1 | ‸ | 2 |\n| 3 |  | 4 |");
    applyTableOp(kit.view, "center");
    expect(kit.state.doc.line(2).text).toBe("| --- | :---: | --- |");
    applyTableOp(kit.view, "rowDelete");
    expect(kit.state.doc.toString()).toBe("| a |  | b |\n| --- | :---: | --- |\n| 3 |  | 4 |");
  });
});

describe("原子范围", () => {
  it("相邻的隐藏范围合并成一段（链接的 `](url)` 是一整块，中间没有可停的交界）", async () => {
    const { atomsOf } = await import("./livePreview");
    const kit = keyKit("前 [文字](https://a.com) 后‸");
    const spans: string[] = [];
    atomsOf(kit.state).between(0, kit.state.doc.length, (from, to) => {
      spans.push(kit.state.sliceDoc(from, to));
    });
    expect(spans).toEqual(["[", "](https://a.com)"]);
  });
});

describe("审查报告：删除与原子范围", () => {
  it("两个元素的隐藏标记紧挨着：退格 / Delete 先拆开，不删看不见的标记", () => {
    let kit = keyKit("前 **a**[‸b](u) 后");
    kit.press("Backspace");
    expect(kit.state.doc.toString()).toBe("前 **a**[b](u) 后");
    kit = keyKit("前 **a‸**[b](u) 后");
    kit.press("Delete");
    expect(kit.state.doc.toString()).toBe("前 **a**[b](u) 后");
    kit = keyKit("前 [a‸](u)**b** 后");
    kit.press("Delete");
    expect(kit.state.doc.toString()).toBe("前 [a](u)**b** 后");
    kit = keyKit("前 *a*`‸c` 后");
    kit.press("Backspace");
    expect(kit.state.doc.toString()).toBe("前 *a*`c` 后");
  });

  it("不同元素的原子不合并（中间留着一个可停的位置）", async () => {
    const { atomsOf } = await import("./livePreview");
    const kit = keyKit("**a**[b](u)‸");
    const spans: string[] = [];
    atomsOf(kit.state).between(0, kit.state.doc.length, (from, to) => {
      spans.push(kit.state.sliceDoc(from, to));
    });
    expect(spans).toEqual(["**", "**", "[", "](u)"]);
  });
});

describe("审查报告：表格", () => {
  it("引用里的表格：回车新行带 `> `、列数不变；空行回车跳出时留在引用里", () => {
    const kit = keyKit("> | a | b |\n> | - | - |\n> | 1 | 2‸ |");
    kit.press("Enter");
    expect(kit.show()).toBe("> | a | b |\n> | - | - |\n> | 1 | 2 |\n> |  | ‸ |");
    kit.press("Enter");
    expect(kit.show()).toBe("> | a | b |\n> | - | - |\n> | 1 | 2 |\n>\n> ‸");
  });

  it("列表里缩进的表格：工具条保留缩进，不多出首列", async () => {
    const { applyTableOp } = await import("./tableEdit");
    const kit = keyKit("- 项\n\n  | a | b |\n  | - | - |\n  | 1‸ | 2 |");
    applyTableOp(kit.view, "colRight");
    expect(kit.state.doc.toString()).toBe("- 项\n\n  | a |  | b |\n  | --- | --- | --- |\n  | 1 |  | 2 |");
  });

  it("引用里的表格：工具条「↓行」不把表格拖出引用", async () => {
    const { applyTableOp } = await import("./tableEdit");
    const kit = keyKit("> | a | b |\n> | - | - |\n> | 1‸ | 2 |");
    applyTableOp(kit.view, "rowBelow");
    expect(kit.state.doc.toString()).toBe("> | a | b |\n> | --- | --- |\n> | 1 | 2 |\n> |  |  |");
  });

  it("工具条不丢掉超出列数的格子", async () => {
    const { applyTableOp } = await import("./tableEdit");
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 | 3 |");
    applyTableOp(kit.view, "center");
    expect(kit.state.doc.line(3).text).toBe("| 1 | 2 | 3 |");
  });

  it("只读时：工具条不出现、命令不改文档", async () => {
    const { applyTableOp, tableEdit } = await import("./tableEdit");
    void tableEdit;
    const { readOnlyCompartment } = await import("./setup");
    const { EditorState } = await import("@codemirror/state");
    const kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |\n| 3 | 4 |");
    kit.view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)) });
    expect(applyTableOp(kit.view, "rowDelete")).toBe(false);
    kit.press("Enter");
    kit.press("Backspace");
    expect(kit.state.doc.toString()).toBe("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");
  });

  it("按词 / 按行删除收在格子里，不删竖线", () => {
    let kit = keyKit("| a | b |\n| - | - |\n| 1 | ‸2 |");
    kit.press("Ctrl-Backspace");
    expect(kit.state.doc.toString()).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
    kit = keyKit("| a | b |\n| - | - |\n| 1 | 二三‸ |");
    kit.press("Ctrl-Backspace");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1 | ‸ |");
    kit = keyKit("| a | b |\n| - | - |\n| 1‸ | 2 |");
    kit.press("Ctrl-Delete");
    expect(kit.state.doc.toString()).toBe("| a | b |\n| - | - |\n| 1 | 2 |");
  });

  it("行尾竖线后面有空格：最后一格按 Tab 新起一行，不跑到竖线外", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| 1 | 2‸ | ");
    kit.press("Tab");
    expect(kit.show()).toBe("| a | b |\n| - | - |\n| 1 | 2 | \n| ‸ |  |");
  });

  it("光标前已经有 `\\` 时打 `|` ⇒ 只补 `|`（不会写成 `\\\\|`）", () => {
    const kit = keyKit("| a | b |\n| - | - |\n| x\\‸ | 2 |");
    kit.press("|");
    expect(kit.state.doc.line(3).text).toBe("| x\\| | 2 |");
  });
});
