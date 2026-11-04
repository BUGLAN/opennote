import { useEffect, useMemo, useRef, useState, type ReactNode, type Ref } from "react";
import { Handle, NodeResizer, Position, useStore, type Node, type NodeProps, type ReactFlowState } from "@xyflow/react";
import {
  isCanvasColorPreset,
  isCanvasFileNode,
  isCanvasGroupNode,
  isCanvasHtmlNode,
  isCanvasLinkNode,
  isCanvasTextNode,
  type CanvasNode,
} from "./types";
import { normalizeFileRef } from "./refs";
import { ensureImageUrl, imageUrl, resolveImageSrc } from "../data/assets";
import { isImagePath } from "../fs/paths";
import { resolveWorkspacePath } from "../fs/workspaceRef";
import { decodeMarkdownHref } from "../lib/markdown";
import { notePreviewSource, renderNoteCard, renderTextCard } from "./cardMarkdown";
import { HtmlFrame } from "../html/HtmlFrame";
import { htmlPlainText } from "../html/bundle";
import { cn } from "../lib/utils";

/** 缩放最小尺寸（任务口径 140×80；Resizer 与 CSS 各自引用，不重复定义数值语义）。 */
export const NODE_MIN_WIDTH = 140;
export const NODE_MIN_HEIGHT = 80;

/**
 * 五类卡片共用的节点数据：`source` 是**契约原节点**（含全部未知字段）——序列化时
 * 以它为底回写，保证往返不丢数据；`cb` 是视图层的稳定回调包。
 */
export interface CanvasCardCallbacks {
  editText(id: string, text: string): void;
  /** 这张卡是不是刚建出来、应当挂载即进入编辑（领走一次，之后恒为 false）。 */
  takeAutoEdit(id: string): boolean;
  openNote(id: string): void;
  /** 跟随卡内的 `[[双链]]`（按标题或路径找笔记；没有就新建，与编辑器里一致）。 */
  openWikiLink(target: string): void;
  getNoteInfo(id: string): { title: string; exists: boolean } | null;
  /** 目标笔记的正文（文件卡显示内容用）；宿主没接或不是笔记时为 null。 */
  getNoteContent(id: string): string | null;
  /** 画布文件所在目录：文本卡里相对路径的图片 / 链接以它为基准。 */
  canvasDir(): string;
  /** 网页卡打开外链（桌面走主进程 openExternal，浏览器 window.open）。 */
  openLink(url: string): void;
  /** 分组框 label 提交（空串 = 清除字段）。 */
  editGroupLabel(id: string, label: string): void;
  /** HTML 卡内容提交（源码就地编辑，与 editText 同一链路）。 */
  editHtml(id: string, html: string): void;
}

export interface CanvasCardData {
  source: CanvasNode;
  cb: CanvasCardCallbacks;
  /** React Flow 约束：节点 data 必须可作 Record<string, unknown>。 */
  [key: string]: unknown;
}

export type CanvasCardNode = Node<CanvasCardData>;

/**
 * 四边连线桩。全部声明为 source + `ConnectionMode.Loose`：松散模式下连线桩
 * 不分起点 / 终点，任意两边、任意类型节点之间都能拖出连线 —— 这正是任务要求的
 * 「任意节点类型间可连」。id 用方位名，序列化时直接映射回 fromSide / toSide。
 */
function SideHandles(): ReactNode {
  return (
    <>
      <Handle id="top" type="source" position={Position.Top} className="canvas-handle" />
      <Handle id="right" type="source" position={Position.Right} className="canvas-handle" />
      <Handle id="bottom" type="source" position={Position.Bottom} className="canvas-handle" />
      <Handle id="left" type="source" position={Position.Left} className="canvas-handle" />
    </>
  );
}

/**
 * 缩放柄只给「独选」的卡：一次选中一片卡片时，每张都挂四个角柄满屏都是，
 * 而多选状态下也没有「一起缩放」这回事。
 */
function CardResizer({ selected }: { selected: boolean }): ReactNode {
  const sole = useStore(selectedCountUpTo2) === 1;
  return <NodeResizer isVisible={selected && sole} minWidth={NODE_MIN_WIDTH} minHeight={NODE_MIN_HEIGHT} />;
}

/** 预设色 → 卡片上的修饰类（色值由 canvas.css 的令牌给出，这里只有编号）。 */
function colorClass(color: string | undefined): string | null {
  if (!color) return null;
  // is-colored 是「有强调色」的统一钩子（描边/标题条），is-color-N 给出具体令牌；
  // 非预设色（hex）只有 is-colored + CSS 变量下发的 --card-accent。
  return isCanvasColorPreset(color) ? `is-colored is-color-${color}` : "is-colored";
}

/**
 * 非预设色（别的工具写入的 hex 等）经 CSS 变量下发：与右键菜单定位同一先例 ——
 * 值是数据，视觉全在样式表。预设色走 class（canvas.css 里 is-color-N 定义令牌）。
 */
function useAccentVar(color: string | undefined): Ref<HTMLDivElement | null> {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (color && !isCanvasColorPreset(color)) el.style.setProperty("--card-accent", color);
    else el.style.removeProperty("--card-accent");
  }, [color]);
  return ref;
}

/** 路径的目录部分（`a/b/c.md` → `a/b`；根目录下 → `""`）。 */
function dirOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/**
 * 卡内渲染好的 Markdown。负责三件 HTML 字符串做不了的事：
 *
 * - **图片**：相对路径按 `baseDir` 解析成 blob URL（与阅读视图同一套，先解百分号编码）；
 * - **点击链接**：`[[双链]]` 交给宿主跟随，网址走外部浏览器，相对的 `.md` 打开那篇笔记；
 *   一律拦下默认行为 —— 卡片里的 `<a>` 真跳走会把整个应用导航掉；
 * - **滚轮**：内容溢出时在滚轮事件冒泡到画布之前挂上 `nowheel`，于是卡内滚动、
 *   而不是缩放画布；没溢出时不挂，滚轮照常缩放 / 平移画布。
 */
function CardMarkdown({
  html,
  baseDir,
  cb,
  className,
  onDoubleClick,
}: {
  html: string;
  baseDir: string;
  cb: CanvasCardCallbacks;
  className?: string;
  onDoubleClick?: (event: React.MouseEvent) => void;
}): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    let cancelled = false;
    for (const img of Array.from(host.querySelectorAll("img"))) {
      img.draggable = false;
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
  }, [html, baseDir]);

  useEffect(() => {
    const host = ref.current;
    if (!host) return;
    // 原生监听：React 的事件委托挂在根节点上，晚于画布自己的滚轮处理，来不及挂类。
    const onWheel = () => host.classList.toggle("nowheel", host.scrollHeight > host.clientHeight + 1);
    host.addEventListener("wheel", onWheel);
    return () => host.removeEventListener("wheel", onWheel);
  }, []);

  const onClick = (event: React.MouseEvent) => {
    const anchor = (event.target as HTMLElement).closest("a");
    if (!anchor || !ref.current?.contains(anchor)) return;
    event.preventDefault();
    event.stopPropagation();
    const wiki = anchor.getAttribute("data-wiki");
    if (wiki) {
      cb.openWikiLink(wiki);
      return;
    }
    const href = anchor.getAttribute("href") || "";
    if (/^https?:/i.test(href)) {
      cb.openLink(href);
      return;
    }
    if (href === "" || href.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(href)) return;
    const target = resolveWorkspacePath(decodeMarkdownHref(href), baseDir);
    if (target) cb.openNote(target);
  };

  return (
    <div
      ref={ref}
      className={cn("canvas-md", "prose", className)}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

/** 就地编辑的小输入框共用行为：按键不许漏给画布（Backspace 会删节点）。 */
function stopCanvasKeys(event: React.KeyboardEvent): void {
  event.stopPropagation();
}

/** 文本卡片：双击进入 textarea 就地编辑，blur / Esc 提交。 */
export function TextCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const text = isCanvasTextNode(node) ? node.text : "";
  const color = typeof node.color === "string" ? node.color : undefined;
  const accentRef = useAccentVar(color);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);
  const html = useMemo(() => renderTextCard(text), [text]);

  // 双击空白 / 拖线建出的新卡：挂载即进编辑（effect 而非 useState 初值 —— StrictMode 下初值会算两次）
  useEffect(() => {
    if (data.cb.takeAutoEdit(node.id)) setEditing(true);
  }, [data.cb, node.id]);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) data.cb.editText(node.id, draft);
  };
  const startEditing = (event: React.MouseEvent) => {
    event.stopPropagation();
    setDraft(text);
    setEditing(true);
  };

  return (
    <div ref={accentRef} className={cn("canvas-card", "canvas-card--text", colorClass(color), selected && "is-selected")}>
      <CardResizer selected={selected} />
      <SideHandles />
      {editing ? (
        <textarea
          ref={areaRef}
          className="canvas-card__edit"
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // 编辑中不让画布拿到按键：Backspace 会删节点，Esc 会被视作收起菜单
            event.stopPropagation();
            if (event.key === "Escape") commit();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : (
        text.trim() ? (
          <CardMarkdown html={html} baseDir={data.cb.canvasDir()} cb={data.cb} className="canvas-card__body" onDoubleClick={startEditing} />
        ) : (
          <div className="canvas-card__body" onDoubleClick={startEditing}>
            <span className="canvas-card__placeholder">双击输入文字</span>
          </div>
        )
      )}
    </div>
  );
}

function FileGlyph(): ReactNode {
  return (
    <svg className="canvas-card__glyph" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.3" />
      <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  );
}

/**
 * 文件卡片：标题 + 路径，下面是笔记正文（带 `#标题` 时只显示那一节）；
 * 目标笔记不存在时置灰提示「文件已删除」；双击打开笔记。
 * 图片卡只显示图：文件名是内容哈希（`saveImageAsset` 的命名规则），选中时才露出路径。
 */
export function FileCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const color = typeof node.color === "string" ? node.color : undefined;
  const accentRef = useAccentVar(color);
  // 展示与打开都走规范化引用（反斜杠 / ./ 前缀等容错形态统一成笔记 id 方言）
  const file = isCanvasFileNode(node) ? normalizeFileRef(node.file) : "";
  const subpath = isCanvasFileNode(node) ? node.subpath : undefined;
  const isImage = isImagePath(file);
  const info = data.cb.getNoteInfo(file);
  const missing = info != null && !info.exists;
  const title = info?.title || file.split("/").pop() || "未知笔记";
  // 图片卡：blob URL 加载成功即视为有效（图片不是笔记，getNoteInfo 对它只有路径回退）
  const [thumbUrl, setThumbUrl] = useState<string | null>(() => imageUrl(file) ?? null);
  useEffect(() => {
    if (!isImage) return;
    let alive = true;
    setThumbUrl(imageUrl(file) ?? null);
    void ensureImageUrl(file).then((url) => {
      if (alive && url) setThumbUrl(url);
    });
    return () => {
      alive = false;
    };
  }, [file, isImage]);
  const imageReady = isImage && thumbUrl != null;
  // 笔记正文：图片 / 已删除 / 宿主没给内容时为 null（退回只有标题与路径的样子）。
  const content = !isImage && !missing ? data.cb.getNoteContent(file) : null;
  const preview = useMemo(() => {
    if (content === null) return null;
    const { text, truncated } = notePreviewSource(content, subpath);
    return { html: text.trim() ? renderNoteCard(text) : null, truncated };
  }, [content, subpath]);

  return (
    <div
      ref={accentRef}
      className={cn(
        "canvas-card",
        "canvas-card--file",
        imageReady && "canvas-card--image",
        preview !== null && "canvas-card--note",
        colorClass(color),
        selected && "is-selected",
        missing && !imageReady && "is-missing",
      )}
      onDoubleClick={(event) => {
        event.stopPropagation();
        data.cb.openNote(file);
      }}
    >
      <CardResizer selected={selected} />
      <SideHandles />
      {imageReady ? (
        <>
          <img className="canvas-card__thumb" src={thumbUrl} alt={file.split("/").pop() ?? ""} draggable={false} />
          {selected ? (
            <div className="canvas-card__caption">
              <div className="canvas-card__path" title={file + (subpath ?? "")}>
                {file}
                {subpath ? <span className="canvas-card__subpath">{subpath}</span> : null}
              </div>
            </div>
          ) : null}
        </>
      ) : preview !== null ? (
        <>
          <div className="canvas-card__head">
            <FileGlyph />
            <div className="canvas-card__main">
              <div className="canvas-card__title">{title}</div>
              <div className="canvas-card__path" title={file + (subpath ?? "")}>
                {file}
                {subpath ? <span className="canvas-card__subpath">{subpath}</span> : null}
              </div>
            </div>
          </div>
          {preview.html === null ? (
            <div className="canvas-card__note canvas-card__placeholder">{subpath ? "这一节没有内容" : "空笔记"}</div>
          ) : (
            <CardMarkdown html={preview.html} baseDir={dirOf(file)} cb={data.cb} className="canvas-card__note" />
          )}
          {preview.truncated ? <div className="canvas-card__more">内容太长，只显示开头 · 双击打开全文</div> : null}
        </>
      ) : (
        <>
          <FileGlyph />
          <div className="canvas-card__main">
            <div className="canvas-card__title">{title}</div>
            {missing ? (
              <div className="canvas-card__missing">文件已删除</div>
            ) : (
              <div className="canvas-card__path" title={file + (subpath ?? "")}>
                {file}
                {subpath ? <span className="canvas-card__subpath">{subpath}</span> : null}
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/** 网页卡片：hostname + 完整 url；双击打开（打开通道由视图层决定）。 */
export function LinkCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const color = typeof node.color === "string" ? node.color : undefined;
  const accentRef = useAccentVar(color);
  const url = isCanvasLinkNode(node) ? node.url : "";
  let hostname = url;
  try {
    hostname = new URL(url).hostname;
  } catch {
    /* 外部文件里的 url 形态不可控：解析不了就原样展示 */
  }
  return (
    <div
      ref={accentRef}
      className={cn("canvas-card", "canvas-card--link", colorClass(color), selected && "is-selected")}
      onDoubleClick={(event) => {
        event.stopPropagation();
        if (url) data.cb.openLink(url);
      }}
    >
      <CardResizer selected={selected} />
      <SideHandles />
      <svg className="canvas-card__glyph" viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M1.8 8h12.4M8 1.8c-3.4 3.6-3.4 8.8 0 12.4M8 1.8c3.4 3.6 3.4 8.8 0 12.4" fill="none" stroke="currentColor" strokeWidth="1.1" />
      </svg>
      <div className="canvas-card__main">
        <div className="canvas-card__title">{hostname || "网页"}</div>
        <div className="canvas-card__path" title={url}>
          {url}
        </div>
      </div>
    </div>
  );
}

/**
 * 分组框：虚线描边圆角容器；左上 label 双击就地编辑。容器语义：拖动分组时，
 * 完整框在里面的卡片跟着走（判定见 `geometry.ts` 的 `groupChildren`，由视图层执行）。
 */
export function GroupCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const color = typeof node.color === "string" ? node.color : undefined;
  const accentRef = useAccentVar(color);
  const label = isCanvasGroupNode(node) ? node.label ?? "" : "";
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft.trim() !== label) data.cb.editGroupLabel(node.id, draft.trim());
  };

  return (
    <div ref={accentRef} className={cn("canvas-card", "canvas-card--group", colorClass(color), selected && "is-selected")}>
      <CardResizer selected={selected} />
      <SideHandles />
      {editing ? (
        <input
          ref={inputRef}
          className="canvas-card__group-edit"
          value={draft}
          spellCheck={false}
          placeholder="分组名称"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            stopCanvasKeys(event);
            if (event.key === "Enter") commit();
            if (event.key === "Escape") setEditing(false);
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : (
        <div
          className="canvas-card__group-label"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setDraft(label);
            setEditing(true);
          }}
        >
          {label || <span className="canvas-card__placeholder">未命名分组</span>}
        </div>
      )}
    </div>
  );
}

/** 选中节点数，数到 2 即停（HtmlCard 只关心「是不是独选」，不必每次扫完整个画布）。 */
function selectedCountUpTo2(state: ReactFlowState): number {
  let count = 0;
  for (const node of state.nodes) {
    if (node.selected && ++count === 2) break;
  }
  return count;
}

/** HTML 卡标题：`<title>` > 首个 `<h1>` 的文字 > 「HTML」（内容变了标题跟着变）。 */
function htmlCardTitle(html: string): string {
  const source = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(html)?.[1] ?? "";
  const text = source.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text || "HTML";
}

/**
 * HTML 卡片（本库私有扩展，见 `CanvasHtmlNode`）：画布内嵌的 HTML 内容。
 *
 * 展示分三层（设计口径：按需激活，同一画布最多一个活跃预览）：
 * - 默认 = 轻量卡：`</>` 字形 + 标题 + 纯文本摘要（`htmlPlainText`，认文字不认标记）；
 * - 选中 = 卡内**实时沙箱预览**（复用 `HtmlFrame`，与 HTML 页面标签同一套隔离；
 *   iframe 的 pointer-events 由 CSS 关掉 —— 缩放≠100% 时 iframe 会劫持滚轮/错位点击，
 *   预览态只看不滚，失焦即卸载）；
 * - 双击 = 编辑源码（与文本卡同一就地编辑惯例，等宽字体）。
 * 卡片尺寸就是视口：拉大卡片，预览跟着变大。
 */
export function HtmlCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const html = isCanvasHtmlNode(node) ? node.html : "";
  const color = typeof node.color === "string" ? node.color : undefined;
  const accentRef = useAccentVar(color);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(html);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== html) data.cb.editHtml(node.id, draft);
  };

  const title = htmlCardTitle(html);
  const excerpt = useMemo(() => {
    const text = htmlPlainText(html);
    return text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }, [html]);
  // 只在「独选」时挂预览：框选一片 HTML 卡不该同时起一排 iframe（最多一个活跃预览）
  const soleSelection = useStore(selectedCountUpTo2) === 1;
  const live = selected && soleSelection && !editing && html.trim() !== "";

  return (
    <div
      ref={accentRef}
      className={cn("canvas-card", "canvas-card--html", colorClass(color), selected && "is-selected", live && "is-live")}
      onDoubleClick={(event) => {
        event.stopPropagation();
        setDraft(html);
        setEditing(true);
      }}
    >
      <CardResizer selected={selected} />
      <SideHandles />
      {editing ? (
        <textarea
          ref={areaRef}
          className="canvas-card__html-edit"
          value={draft}
          spellCheck={false}
          placeholder="<p>粘贴或编写 HTML…</p>"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            // 编辑中不让画布拿到按键（Backspace 会删节点，Esc 会被视作收起菜单）
            event.stopPropagation();
            if (event.key === "Escape") commit();
          }}
          onPointerDown={(event) => event.stopPropagation()}
          onDoubleClick={(event) => event.stopPropagation()}
        />
      ) : live ? (
        <>
          <HtmlFrame html={html} title={title} className="canvas-card__html-frame" />
          <div className="canvas-card__caption">
            <div className="canvas-card__title">{title}</div>
            <div className="canvas-card__hint-line">HTML · 选中预览，双击编辑</div>
          </div>
        </>
      ) : (
        <>
          <svg className="canvas-card__glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M6 3.5 2.5 8 6 12.5M10 3.5 13.5 8 10 12.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
          <div className="canvas-card__main">
            <div className="canvas-card__title">{title}</div>
            <div className="canvas-card__excerpt">{excerpt || "双击粘贴或编写 HTML"}</div>
          </div>
        </>
      )}
    </div>
  );
}

/** 未知类型节点：占位展示 type 名，可拖动 / 删除 / 连线，内容不可编辑，序列化原样保留。 */
export function UnknownCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const typeLabel = String(data.source.type ?? "");
  return (
    <div className={cn("canvas-card", "canvas-card--unknown", selected && "is-selected")}>
      <SideHandles />
      <div className="canvas-card__main">
        <div className="canvas-card__tag">{typeLabel}</div>
        <div className="canvas-card__hint">未知节点</div>
      </div>
    </div>
  );
}
