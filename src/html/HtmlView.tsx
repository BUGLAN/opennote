import { useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "../components/Icons";
import type { Note } from "../data/types";
import { cn } from "../lib/utils";
import { HtmlFrame } from "./HtmlFrame";
import { inlineWorkspaceHtml } from "./workspace";

/**
 * HTML 页面标签的内容区：直接渲染页面（不是源码、不是编辑器），右上角一颗悬浮的全屏按钮。
 *
 * - **只读**：这里没有任何写回路径；标签栏的锁固定显示「锁定」且不可解锁（`App.tsx`），
 *   数据层的 `updateNoteContent()` 也拒收 HTML 页面（双保险）。
 * - **全屏**：优先用 Fullscreen API 把整个面板（含 iframe）放大 —— iframe 不换父节点、
 *   不重新加载，退出后页面里的滚动位置与交互状态原样还在。拿不到 API 的环境
 *   （iPhone Safari、部分 WebView）退回「铺满窗口」的伪全屏，Esc 或再点一次按钮退出。
 */

type FullscreenMode = "off" | "native" | "pseudo";

interface FullscreenCapable {
  requestFullscreen?: () => Promise<void>;
  webkitRequestFullscreen?: () => void;
}

interface FullscreenDocument {
  fullscreenElement?: Element | null;
  webkitFullscreenElement?: Element | null;
  exitFullscreen?: () => Promise<void>;
  webkitExitFullscreen?: () => void;
}

function currentFullscreenElement(): Element | null {
  const doc = document as unknown as FullscreenDocument;
  return doc.fullscreenElement ?? doc.webkitFullscreenElement ?? null;
}

function exitNativeFullscreen(): void {
  const doc = document as unknown as FullscreenDocument;
  if (!currentFullscreenElement()) return;
  if (typeof doc.exitFullscreen === "function") void doc.exitFullscreen().catch(() => undefined);
  else doc.webkitExitFullscreen?.();
}

export function HtmlView({ note }: { note: Note }): ReactNode {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [prepared, setPrepared] = useState<{ id: string; html: string } | null>(null);
  const [mode, setMode] = useState<FullscreenMode>("off");

  useEffect(() => {
    let alive = true;
    void inlineWorkspaceHtml(note.id, note.content)
      .catch(() => note.content)
      .then((html) => {
        if (alive) setPrepared({ id: note.id, html });
      });
    return () => {
      alive = false;
    };
  }, [note.id, note.content]);

  // 浏览器自己退出全屏（Esc、系统手势）时同步状态：回到原来的页面，什么都不用重建。
  useEffect(() => {
    const onChange = () => {
      if (currentFullscreenElement() !== hostRef.current) setMode((current) => (current === "native" ? "off" : current));
    };
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
    };
  }, []);

  useEffect(() => {
    if (mode !== "pseudo") return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMode("off");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode]);

  // 全屏中切走标签（快捷键、命令面板）：别把一个已经卸载的面板留在全屏里。
  useEffect(
    () => () => {
      if (currentFullscreenElement() === hostRef.current) exitNativeFullscreen();
    },
    [],
  );

  const enter = async () => {
    const host = hostRef.current as (HTMLDivElement & FullscreenCapable) | null;
    if (!host) return;
    const enabled = (document as Document & { fullscreenEnabled?: boolean }).fullscreenEnabled !== false;
    try {
      if (enabled && typeof host.requestFullscreen === "function") {
        await host.requestFullscreen();
        setMode("native");
        return;
      }
      if (typeof host.webkitRequestFullscreen === "function") {
        host.webkitRequestFullscreen();
        setMode("native");
        return;
      }
    } catch {
      /* 被拒（策略 / 不支持）：退回伪全屏 */
    }
    setMode("pseudo");
  };

  const exit = () => {
    if (mode === "native") exitNativeFullscreen();
    setMode("off");
  };

  const full = mode !== "off";
  const html = prepared && prepared.id === note.id ? prepared.html : null;

  return (
    <div ref={hostRef} className={cn("html-pane", mode === "pseudo" && "is-pseudo-fullscreen")}>
      {html !== null ? (
        <HtmlFrame html={html} title={note.title} className="html-pane__frame" />
      ) : (
        <div className="html-pane__loading" role="status">
          <span className="busy__spinner" aria-hidden="true" />
          正在载入页面…
        </div>
      )}
      <button
        type="button"
        className="icon-btn html-pane__fullscreen"
        title={full ? "退出全屏（Esc）" : "全屏查看"}
        aria-label={full ? "退出全屏" : "全屏查看"}
        aria-pressed={full}
        onClick={() => (full ? exit() : void enter())}
      >
        <Icon name={full ? "shrink" : "expand"} />
      </button>
    </div>
  );
}
