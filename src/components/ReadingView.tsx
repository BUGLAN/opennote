import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { resolveImageSrc } from "../data/assets";
import { splitFrontMatter } from "../lib/utils";
import { decodeMarkdownHref } from "../lib/markdown";
import { renderReadingMarkdown } from "../lib/readingMarkdown";
import { useUi } from "../data/ui";
import { renderMath } from "../editor/math";
import { renderMermaid } from "../editor/mermaid";
import type { Note } from "../data/types";

/**
 * 只读锁的**阅读视图**（0.4.0 用户反馈）：锁定的笔记不该停在 Typora 式的编辑器里 ——
 * 那样的「活着的光标 + 行内标记符号」没法心流地读。锁上 = 整篇渲染成干净的文章排版
 * （`renderMarkdown` + `prose`，与剪藏预览同一套渲染与样式），正文照常选中、复制、搜索。
 *
 * 图片：正文里的**相对引用**（`<笔记名>.assets/x.png`）经 `resolveImageSrc` 解析成
 * 可显示的 blob URL（data/assets 的同一份缓存）；远程 http(s) 引用桌面 CSP 不放行，
 * 本来就该在导入时落盘 —— 这里不替历史数据兜底。
 *
 * 公式与图表：`renderReadingMarkdown` 只留占位（原文），挂载后交给编辑器同一套
 * `renderMath` / `renderMermaid`（同一份缓存、同一套主题），读写两边看到的版式一致。
 */
export function ReadingView({ note }: { note: Note }): ReactNode {
  const ref = useRef<HTMLElement | null>(null);
  const { theme, appearance } = useUi();
  const html = useMemo(() => renderReadingMarkdown(splitFrontMatter(note.content).body), [note.content]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    const baseDir = note.folderId ?? "";
    let cancelled = false;
    for (const img of Array.from(host.querySelectorAll("img"))) {
      // `renderMarkdown()` 会把目标百分号编码（中文目录名必然被编码），读盘前先解回来 ——
      // 不解就是「编辑器能显示、阅读视图是裂图」（用户实测的那个缺陷）。
      const src = decodeMarkdownHref(img.getAttribute("src") || "");
      if (!src || /^(https?:|data:|blob:)/i.test(src)) continue;
      void resolveImageSrc(src, baseDir).then((resolved) => {
        if (cancelled || !resolved) return;
        if (img.getAttribute("src") !== resolved) img.setAttribute("src", resolved);
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, note.folderId]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    for (const el of Array.from(host.querySelectorAll<HTMLElement>(".md-math[data-tex]"))) {
      const tex = el.dataset.tex ?? "";
      void renderMath(tex, el.classList.contains("math-block")).then((out) => {
        if (!cancelled) el.innerHTML = out;
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    for (const el of Array.from(host.querySelectorAll<HTMLElement>(".mermaid-block[data-mermaid]"))) {
      // 原文先存下来：主题切换时这个 effect 重跑，元素里已经是上一次的 SVG。
      const code = (el.dataset.mermaid ||= el.textContent ?? "");
      el.classList.add("is-loading");
      void renderMermaid(code, theme, appearance).then(({ html: out }) => {
        if (cancelled) return;
        el.innerHTML = out;
        el.classList.remove("is-loading");
      });
    }
    return () => {
      cancelled = true;
    };
  }, [html, theme, appearance]);

  /*
   * 滚动容器是**外层**，正文是内层 —— 与编辑器同一套结构（`.cm-scroller` 满宽负责滚动、
   * `.cm-content` 居中限宽）。原来的写法把 `overflow-y: auto` 直接放在居中的 `.reading`
   * 上，滚动条于是长在**正文栏**的右边缘：一按锁，它就从主栏右边缘横跳到正文栏右边缘，
   * 悬在空白里（2026-10-12 用户反馈「锁定后滚动条从右边移动到左边」）。
   */
  return (
    <div className="reading-scroll">
      <article ref={ref} className="reading prose" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}
