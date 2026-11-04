import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  type Edge,
  type EdgeProps,
} from "@xyflow/react";
import { isCanvasColorPreset, type CanvasEdge as CanvasEdgeDoc } from "./types";

/**
 * 边数据：source 是契约原边（含未知字段与 label），label / 颜色 / 箭头端的增删改
 * 都写回它，序列化时整条边以它为底回写。
 */
export interface CanvasCardEdgeData {
  source: CanvasEdgeDoc;
  onLabelChange(id: string, label: string): void;
  /** React Flow 约束：边 data 必须可作 Record<string, unknown>。 */
  [key: string]: unknown;
}

export type CanvasCardEdge = Edge<CanvasCardEdgeData>;

/**
 * 标签 / 输入框跟随边的几何位置：React Flow 每次渲染给出 (labelX, labelY)，
 * 静态 CSS 拿不到这个坐标。与仓库 applyUi() 写 :root 自定义属性同一手法 ——
 * 几何量经 CSS 变量下发，视觉样式全部留在 canvas.css。
 */
function useEdgeLabelPosition(labelX: number, labelY: number, active: boolean) {
  const ref = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const el = ref.current;
    if (el) {
      el.style.setProperty("--edge-x", String(labelX) + "px");
      el.style.setProperty("--edge-y", String(labelY) + "px");
    }
  });
  return ref;
}

/**
 * 边的颜色也走 CSS 变量：预设色存的是编号（"1"-"6"），这里下发对应的令牌引用；
 * 非预设色（别的工具写的 hex）原样下发。stroke 的实际取值在 canvas.css
 * （var(--edge-accent, var(--ink-3))，选中态另有覆盖）。
 */
function useEdgeAccentVar(color: string | undefined): React.RefObject<SVGGElement | null> {
  const ref = useRef<SVGGElement | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (color) el.style.setProperty("--edge-accent", isCanvasColorPreset(color) ? `var(--canvas-c-${color})` : color);
    else el.style.removeProperty("--edge-accent");
  }, [color]);
  return ref;
}

/** 可编辑标签的边：双击边（或标签）出现小输入框，Enter / blur 提交，Esc 取消。 */
export function CanvasCardEdgeView(props: EdgeProps<CanvasCardEdge>): ReactNode {
  const { id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data, selected, markerStart, markerEnd } = props;
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });
  const label = data?.source.label ?? "";
  const color = typeof data?.source.color === "string" ? data.source.color : undefined;
  const accentRef = useEdgeAccentVar(color);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(label);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const labelHostRef = useEdgeLabelPosition(labelX, labelY, !editing);
  const editHostRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      const host = editHostRef.current;
      if (host) {
        host.style.setProperty("--edge-x", String(labelX) + "px");
        host.style.setProperty("--edge-y", String(labelY) + "px");
      }
    }
  }, [editing, labelX, labelY]);

  const startEdit = () => {
    setDraft(label);
    setEditing(true);
  };
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next !== label) data?.onLabelChange(id, next);
  };

  return (
    <>
      <g
        ref={accentRef}
        onDoubleClick={(event) => {
          event.stopPropagation();
          startEdit();
        }}
      >
        <BaseEdge
          id={id}
          path={path}
          markerStart={markerStart}
          markerEnd={markerEnd}
          className={selected ? "canvas-edge is-selected" : "canvas-edge"}
        />
      </g>
      <EdgeLabelRenderer>
        {editing ? (
          <span ref={editHostRef} className="canvas-edge-edit-host">
            <input
              ref={inputRef}
              className="canvas-edge-edit"
              value={draft}
              spellCheck={false}
              placeholder="标签"
              onChange={(event) => setDraft(event.target.value)}
              onBlur={commit}
              onKeyDown={(event) => {
                event.stopPropagation();
                if (event.key === "Enter") commit();
                if (event.key === "Escape") setEditing(false);
              }}
              onPointerDown={(event) => event.stopPropagation()}
            />
          </span>
        ) : (
          label && (
            <div
              ref={labelHostRef}
              className={selected ? "canvas-edge-label is-selected" : "canvas-edge-label"}
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEdit();
              }}
            >
              {label}
            </div>
          )
        )}
      </EdgeLabelRenderer>
    </>
  );
}
