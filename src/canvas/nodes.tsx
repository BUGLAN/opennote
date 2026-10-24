import { useEffect, useRef, useState, type ReactNode } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import { isCanvasFileNode, isCanvasTextNode, type CanvasNode } from "./types";
import { normalizeFileRef } from "./refs";
import { cn } from "../lib/utils";

/**
 * 三类卡片共用的节点数据：`source` 是**契约原节点**（含全部未知字段）——序列化时
 * 以它为底回写，保证往返不丢数据；`cb` 是视图层的稳定回调包。
 */
export interface CanvasCardCallbacks {
  editText(id: string, text: string): void;
  openNote(id: string): void;
  getNoteInfo(id: string): { title: string; exists: boolean } | null;
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

/** 文本卡片：双击进入 textarea 就地编辑，blur / Esc 提交。 */
export function TextCard({ data, selected }: NodeProps<CanvasCardNode>): ReactNode {
  const node = data.source;
  const text = isCanvasTextNode(node) ? node.text : "";
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
    <div className={cn("canvas-card", "canvas-card--text", selected && "is-selected")}>
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
  // 展示与打开都走规范化引用（反斜杠 / ./ 前缀等容错形态统一成笔记 id 方言）
  const file = isCanvasFileNode(node) ? normalizeFileRef(node.file) : "";
  const info = data.cb.getNoteInfo(file);
  const missing = info != null && !info.exists;
  const title = info?.title || file.split("/").pop() || "未知笔记";
  return (
    <div
      className={cn("canvas-card", "canvas-card--file", selected && "is-selected", missing && "is-missing")}
      onDoubleClick={(event) => {
        event.stopPropagation();
        data.cb.openNote(file);
      }}
    >
      <SideHandles />
      <svg className="canvas-card__glyph" viewBox="0 0 16 16" aria-hidden="true">
        <path d="M3.5 1.5h6l3 3v10h-9z" fill="none" stroke="currentColor" strokeWidth="1.3" />
        <path d="M9.5 1.5v3h3" fill="none" stroke="currentColor" strokeWidth="1.3" />
      </svg>
      <div className="canvas-card__main">
        <div className="canvas-card__title">{title}</div>
        {missing ? (
          <div className="canvas-card__missing">文件已删除</div>
        ) : (
          <div className="canvas-card__path" title={file}>
            {file}
          </div>
        )}
      </div>
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
