import { beforeEach, describe, expect, it } from "vitest";
import { clearBlockHeights, rememberBlockHeight } from "./blockHeight";
import { HrWidget, ImageWidget, MathWidget, MermaidWidget, TableWidget } from "./widgets";

/**
 * 块级 widget 的**估算高度**。
 *
 * 这不是「锦上添花的数字」：`WidgetType.estimatedHeight` 的默认值是 `-1`，而 CM 的
 * `hasHeight()` 正是用 `estimatedHeight > -1` 判断「这个 widget 有没有已知高度」。
 * 返回 `-1` 等于告诉 CM「这块高度未知」—— 视口外只能按字符数比例猜行高，
 * 猜偏了就会在滚动时改写 `scrollTop`（归档实测一次远距离跳转被改写 **−708.63px**）。
 */
describe("块级 widget 的估算高度（estimatedHeight）", () => {
  beforeEach(() => {
    // 高度记忆是模块级单例：用例之间要干净的起点。
    clearBlockHeights();
  });

  it("量过之后一律以实测为准 —— 实测比任何估算都准", () => {
    rememberBlockHeight("| a |\n| - |\n| 1 |", 248.5);
    expect(new TableWidget("<table></table>", 3, "| a |\n| - |\n| 1 |").estimatedHeight).toBe(248.5);

    rememberBlockHeight("```mermaid\ngraph TD\n```", 273.25);
    expect(new MermaidWidget("graph TD", "paper", "light", "```mermaid\ngraph TD\n```").estimatedHeight).toBe(273.25);

    rememberBlockHeight("$$E=mc^2$$", 91.14);
    expect(new MathWidget("E=mc^2", true, "$$E=mc^2$$").estimatedHeight).toBe(91.14);

    rememberBlockHeight("---", 35.75);
    expect(new HrWidget("---").estimatedHeight).toBe(35.75);
  });

  it("没量过时给一个按内容的粗估，**绝不能是 -1**（-1 = 告诉 CM「我不知道」）", () => {
    expect(new TableWidget("<table></table>", 3, "k").estimatedHeight).toBe(130); // 3 行 × 30 + 40
    expect(new MermaidWidget("graph TD", "paper", "light", "k").estimatedHeight).toBe(200);
    expect(new HrWidget("k").estimatedHeight).toBe(50);
    expect(new MathWidget("E=mc^2", true, "k").estimatedHeight).toBe(60);
    expect(new ImageWidget("./a.png", "图", true, "note.md", "k").estimatedHeight).toBe(200);
  });

  it("行内 widget 返回 -1：它们不是块级装饰，不该参与块级高度估算", () => {
    expect(new MathWidget("a+b", false, "").estimatedHeight).toBe(-1);
    expect(new ImageWidget("./a.png", "图", false, "note.md", "").estimatedHeight).toBe(-1);
  });
});
