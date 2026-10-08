/**
 * `renderMarkdown()` 的**目标编码**契约（0.4.0 用户实测缺陷的护栏）。
 *
 * markdown-it 的 `normalizeLink` 会把非 ASCII 目标百分号编码：
 * `![x](assets/计算机启动过程/a.png)` → `src="assets/%E8%AE%A1.../a.png"`。
 * 谁拿渲染后的 `<img src>` 去读磁盘，谁就必须先 `decodeMarkdownHref()` ——
 * 否则「编辑器里能显示的图，换成渲染视图就是裂图」。
 */
import { describe, expect, it } from "vitest";
import { resolveWorkspacePath } from "../data/assets";
import { decodeMarkdownHref, renderMarkdown } from "./markdown";

describe("markdown 渲染后的目标编码", () => {
  it("渲染会把中文路径百分号编码（这就是必须解码的原因）", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    expect(html).toContain("assets/%E8%AE%A1%E7%AE%97%E6%9C%BA");
    expect(html).not.toContain("assets/计算机启动过程/image-1.png");
  });

  it("decodeMarkdownHref 能把编码还原成磁盘上的真实相对路径", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    const src = /src="([^"]+)"/.exec(html)?.[1] ?? "";
    expect(decodeMarkdownHref(src)).toBe("assets/计算机启动过程/image-1.png");
  });

  it("没有 % 的原样返回；解不动的也原样返回（不许抛）", () => {
    expect(decodeMarkdownHref("assets/plain/a.png")).toBe("assets/plain/a.png");
    expect(decodeMarkdownHref("assets/100%/a.png")).toBe("assets/100%/a.png");
    expect(decodeMarkdownHref("")).toBe("");
  });

  it("ReadingView 的读图链：编码的 src 直接拿去读盘必然读不到（缺陷现场），解码后才对", () => {
    const html = renderMarkdown("![x](assets/计算机启动过程/image-1.png)");
    const src = /src="([^"]+)"/.exec(html)?.[1] ?? "";
    // 缺陷现场：拿渲染出来的 src 当磁盘路径 → 读不到那个文件（磁盘上是中文目录名）
    expect(resolveWorkspacePath(src, "操作系统")).toBe(
      "操作系统/assets/%E8%AE%A1%E7%AE%97%E6%9C%BA%E5%90%AF%E5%8A%A8%E8%BF%87%E7%A8%8B/image-1.png",
    );
    // 修好之后：解码 → 命中磁盘上的真实路径
    expect(resolveWorkspacePath(decodeMarkdownHref(src), "操作系统")).toBe(
      "操作系统/assets/计算机启动过程/image-1.png",
    );
  });
});
