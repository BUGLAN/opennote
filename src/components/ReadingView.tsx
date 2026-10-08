import { useEffect, useMemo, useRef, type ReactNode } from "react";
import { resolveImageSrc } from "../data/assets";
import { splitFrontMatter } from "../lib/utils";
import { decodeMarkdownHref, renderMarkdown } from "../lib/markdown";
import type { Note } from "../data/types";

/**
 * 只读锁的**阅读视图**（0.4.0 用户反馈）：锁定的笔记不该停在 Typora 式的编辑器里 ——
 * 那样的「活着的光标 + 行内标记符号」没法心流地读。锁上 = 整篇渲染成干净的文章排版
 * （`renderMarkdown` + `prose`，与剪藏预览同一套渲染与样式），正文照常选中、复制、搜索。
 *
 * 图片：正文里的**相对引用**（`<笔记名>.assets/x.png`）经 `resolveImageSrc` 解析成
 * 可显示的 blob URL（data/assets 的同一份缓存）；远程 http(s) 引用桌面 CSP 不放行，
 * 本来就该在导入时落盘 —— 这里不替历史数据兜底。
 */
export function ReadingView({ note }: { note: Note }): ReactNode {
  const ref = useRef<HTMLElement | null>(null);
  const html = useMemo(() => renderMarkdown(splitFrontMatter(note.content).body), [note.content]);

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

  return <article ref={ref} className="reading prose" dangerouslySetInnerHTML={{ __html: html }} />;
}
