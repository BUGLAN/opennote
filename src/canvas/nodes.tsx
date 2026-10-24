import { useEffect, useRef, useState, type ReactNode, type Ref } from "react";
import { Handle, NodeResizer, Position, type Node, type NodeProps } from "@xyflow/react";
import { isCanvasColorPreset, isCanvasFileNode, isCanvasGroupNode, isCanvasLinkNode, isCanvasTextNode, type CanvasNode } from "./types";
import { normalizeFileRef } from "./refs";
import { ensureImageUrl, imageUrl } from "../data/assets";
import { isImagePath } from "../fs/paths";
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
  openNote(id: string): void;
  getNoteInfo(id: string): { title: string; exists: boolean } | null;
  /** 网页卡打开外链（桌面走主进程 openExternal，浏览器 window.open）。 */
  openLink(url: string): void;
  /** 分组框 label 提交（空串 = 清除字段）。 */
  editGroupLabel(id: string, label: string): void;
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

  useEffect(() => {
    if (editing) areaRef.current?.focus();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    if (draft !== text) data.cb.editText(node.id, draft);
  };

  return (
    <div ref={accentRef} className={cn("canvas-card", "canvas-card--text", colorClass(color), selected && "is-selected")}>
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_WIDTH} minHeight={NODE_MIN_HEIGHT} />
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
        <div
          className="canvas-card__body"
          onDoubleClick={(event) => {
            event.stopPropagation();
            setDraft(text);
            setEditing(true);
          }}
        >
          {text.trim() ? text : <span className="canvas-card__placeholder">双击输入文字</span>}
        </div>
      )}
    </div>
  );
}

/** 文件卡片：标题 + 路径标识；目标笔记不存在时置灰提示「文件已删除」；双击打开笔记。 */
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

  return (
    <div
      ref={accentRef}
      className={cn(
        "canvas-card",
        "canvas-card--file",
        imageReady && "canvas-card--image",
        colorClass(color),
        selected && "is-selected",
        missing && !imageReady && "is-missing",
      )}
      onDoubleClick={(event) => {
        event.stopPropagation();
        data.cb.openNote(file);
      }}
    >
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_WIDTH} minHeight={NODE_MIN_HEIGHT} />
      <SideHandles />
      {imageReady ? (
        <>
          <img className="canvas-card__thumb" src={thumbUrl} alt={title} draggable={false} />
          <div className="canvas-card__caption">
            <div className="canvas-card__title">{title}</div>
            <div className="canvas-card__path" title={file + (subpath ?? "")}>
              {file}
              {subpath ? <span className="canvas-card__subpath">{subpath}</span> : null}
            </div>
          </div>
        </>
      ) : (
        <>
          <svg className="canvas-card__glyph" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.3" />
            <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
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

/** 分组框：虚线描边圆角容器；左上 label 双击就地编辑。MVP 容器语义（子节点不随动）。 */
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
      <NodeResizer isVisible={selected} minWidth={NODE_MIN_WIDTH} minHeight={NODE_MIN_HEIGHT} />
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
