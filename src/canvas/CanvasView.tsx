import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/canvas.css";
import { getCanvasViewport, setCanvasViewport } from "../data/library";
import { notify } from "../lib/toast";
import { registerActiveCanvas, unregisterActiveCanvas } from "./controller";
import { newCanvasEdgeId, newCanvasNodeId } from "./ids";
import { CanvasCardEdgeView, type CanvasCardEdge } from "./edges";
import { FileCard, TextCard, UnknownCard, type CanvasCardCallbacks, type CanvasCardNode } from "./nodes";
import { NotePicker } from "./notePicker";
import { isCanvasFileNode, isCanvasTextNode, parseCanvas, serializeCanvas } from "./types";
import type { CanvasDocument, CanvasEdge, CanvasFileNode, CanvasNode, CanvasNodeSide, CanvasTextNode } from "./types";

/** 视图契约 props —— 后续集成工位按此消费，一字不改。 */
export interface CanvasViewProps {
  canvasId: string;
  content: string;
  onContentChange(next: string): void;
  onOpenNote(id: string): void;
  getNoteInfo(id: string): { title: string; exists: boolean } | null;
}

const nodeTypes = { text: TextCard, file: FileCard, canvasUnknown: UnknownCard };
const edgeTypes = { canvasCard: CanvasCardEdgeView };

/** 新卡默认尺寸（JSON Canvas 的宽高是节点数据的一部分，落盘可见）。 */
const NEW_TEXT_CARD_SIZE = { width: 260, height: 160 };
const NEW_FILE_CARD_SIZE = { width: 260, height: 110 };
const DELETE_KEYS = ["Backspace", "Delete"];
const VIEWPORT_SAVE_DELAY = 500;

type FlowUpdate = (
  nodes: CanvasCardNode[],
  edges: CanvasCardEdge[],
) => [CanvasCardNode[], CanvasCardEdge[]];

interface CanvasMenuState {
  x: number;
  y: number;
  /** 右键命中的节点（file 卡才有「打开笔记」项）；面板右键为 null。 */
  nodeId: string | null;
  /** 打开菜单那一刻的选中数（节点 + 边），决定「删除所选」是否可用。 */
  count: number;
}

/** 坐标取两位小数：拖动落定的浮点误差不再无限累进，往返序列化保持稳定。 */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * 未知类型节点不继承 CanvasNodeBase：几何字段躺在索引签名里、形态未知，
 * 读取一律经这里防御（非有限数字 → undefined）。
 */
function fieldNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** 契约节点类型 → 本视图的渲染组件 key。未知类型一律走占位卡片。 */
function nodeKindOf(node: CanvasNode): "text" | "file" | "canvasUnknown" {
  if (isCanvasTextNode(node)) return "text";
  if (isCanvasFileNode(node)) return "file";
  return "canvasUnknown";
}

function toFlowNode(node: CanvasNode, cb: CanvasCardCallbacks, selected: boolean): CanvasCardNode {
  const raw = node as Record<string, unknown>;
  return {
    id: node.id,
    type: nodeKindOf(node),
    position: { x: fieldNumber(raw.x) ?? 0, y: fieldNumber(raw.y) ?? 0 },
    width: fieldNumber(raw.width),
    height: fieldNumber(raw.height),
    selected: selected || undefined,
    data: { source: node, cb },
  };
}

function toFlowNodes(doc: CanvasDocument, selected: Set<string>, cb: CanvasCardCallbacks): CanvasCardNode[] {
  return doc.nodes.map((node) => toFlowNode(node, cb, selected.has(node.id)));
}

/**
 * 契约边 → React Flow 边。端点不存在的边直接滤掉：解析器可能因坏节点丢弃它，
 * 而 React Flow 遇到引用缺失的边会直接报错。
 */
function toFlowEdges(
  doc: CanvasDocument,
  selected: Set<string>,
  onLabelChange: (id: string, label: string) => void,
): CanvasCardEdge[] {
  const nodeIds = new Set(doc.nodes.map((node) => node.id));
  return doc.edges
    .filter((edge) => nodeIds.has(edge.fromNode) && nodeIds.has(edge.toNode))
    .map((edge) => ({
      id: edge.id,
      source: edge.fromNode,
      target: edge.toNode,
      sourceHandle: edge.fromSide ?? null,
      targetHandle: edge.toSide ?? null,
      type: "canvasCard",
      selected: selected.has(edge.id) || undefined,
      data: { source: edge, onLabelChange },
    }));
}

/**
 * React Flow 状态 → 契约文档：以节点/边数据里的契约原对象为底，只覆写几何与
 * 被编辑的字段 —— 未知节点类型与未知字段由此原样保留（往返不丢数据）。
 */
function docFromFlow(nodes: CanvasCardNode[], edges: CanvasCardEdge[]): CanvasDocument {
  return {
    nodes: nodes.map((node) => {
      const next = {
        ...node.data.source,
        x: round2(node.position.x),
        y: round2(node.position.y),
      } as CanvasNode & Record<string, unknown>;
      const width = node.measured?.width ?? node.width;
      const height = node.measured?.height ?? node.height;
      if (width != null) next.width = round2(width);
      if (height != null) next.height = round2(height);
      return next;
    }),
    edges: edges.map((edge) => {
      // 边 data 由本视图创建时始终携带；这里只防御类型层面可能的 undefined
      const source = edge.data?.source ?? { id: edge.id, fromNode: edge.source, toNode: edge.target };
      const next: CanvasEdge = { ...source, fromNode: edge.source, toNode: edge.target };
      if (edge.sourceHandle) next.fromSide = edge.sourceHandle as CanvasNodeSide;
      if (edge.targetHandle) next.toSide = edge.targetHandle as CanvasNodeSide;
      return next;
    }),
  };
}

/**
 * 画布主体。挂载行为要求父层用 key=canvasId 渲染（与 EditorPane 的 EditorHost 同一
 * 约定）：换画布 = 卸载重建，视口恢复与 controller 注册都只认挂载那一刻的 id。
 */
function CanvasSurface(props: CanvasViewProps): ReactNode {
  const propsRef = useRef(props);
  propsRef.current = props;

  const nodesRef = useRef<CanvasCardNode[]>([]);
  const edgesRef = useRef<CanvasCardEdge[]>([]);
  /** 自己 emit 出去、还没回到 props.content 的文本（上层 450ms 防抖可能合并送达）。 */
  const pendingEchoRef = useRef<string[]>([]);

  const emit = useCallback(() => {
    const text = serializeCanvas(docFromFlow(nodesRef.current, edgesRef.current));
    pendingEchoRef.current.push(text);
    if (pendingEchoRef.current.length > 8) pendingEchoRef.current.splice(0, pendingEchoRef.current.length - 8);
    propsRef.current.onContentChange(text);
  }, []);

  const applyAndEmit = useCallback(
    (update: FlowUpdate) => {
      const [nodes, edges] = update(nodesRef.current, edgesRef.current);
      nodesRef.current = nodes;
      edgesRef.current = edges;
      setRfNodes(nodes);
      setRfEdges(edges);
      emit();
    },
    [emit],
  );

  const onLabelChange = useCallback(
    (id: string, label: string) => {
      applyAndEmit((nodes, edges) => [
        nodes,
        edges.map((edge): CanvasCardEdge => {
          if (edge.id !== id || !edge.data) return edge;
          const source: CanvasEdge = { ...edge.data.source };
          if (label) source.label = label;
          else delete source.label;
          return { ...edge, data: { ...edge.data, source } };
        }),
      ]);
    },
    [applyAndEmit],
  );

  const cardCallbacks = useMemo<CanvasCardCallbacks>(
    () => ({
      editText: (id, text) =>
        applyAndEmit((nodes) => [
          nodes.map((node) =>
            node.id === id && node.data.source.type === "text"
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    // 已按 type 收窄，cast 只是绕开联合展开的保守推断
                    source: { ...(node.data.source as CanvasTextNode), text },
                  },
                }
              : node,
          ),
          edgesRef.current,
        ]),
      openNote: (id) => propsRef.current.onOpenNote(id),
      getNoteInfo: (id) => propsRef.current.getNoteInfo(id),
    }),
    [applyAndEmit],
  );

  const [rfNodes, setRfNodes] = useState<CanvasCardNode[]>(() => {
    const nodes = toFlowNodes(parseCanvas(props.content).doc, new Set<string>(), cardCallbacks);
    nodesRef.current = nodes;
    return nodes;
  });
  const [rfEdges, setRfEdges] = useState<CanvasCardEdge[]>(() => {
    const edges = toFlowEdges(parseCanvas(props.content).doc, new Set<string>(), onLabelChange);
    edgesRef.current = edges;
    return edges;
  });
  const [initial] = useState(() => {
    const doc = parseCanvas(props.content).doc;
    return { viewport: getCanvasViewport(props.canvasId), hadNodes: doc.nodes.length > 0 };
  });
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);

  /* 外部 content 变化（历史恢复 / 外部改名跟随 / 磁盘赢）：重新解析并尽量保留选区。
     自己 emit 的回声按队列识别后跳过 —— 上层防抖可能合并送达，最新的回声等价于当前状态。 */
  useEffect(() => {
    const text = props.content;
    const queue = pendingEchoRef.current;
    if (queue.length > 0 && queue[0] === text) {
      queue.shift();
      return;
    }
    if (text === serializeCanvas(docFromFlow(nodesRef.current, edgesRef.current))) {
      queue.length = 0;
      return;
    }
    queue.length = 0;
    const next = parseCanvas(text);
    const selected = new Set<string>(
      nodesRef.current.filter((node) => node.selected).map((node) => node.id),
    );
    for (const edge of edgesRef.current) if (edge.selected) selected.add(edge.id);
    const nodes = toFlowNodes(next.doc, selected, cardCallbacks);
    const edges = toFlowEdges(next.doc, selected, onLabelChange);
    nodesRef.current = nodes;
    edgesRef.current = edges;
    setRfNodes(nodes);
    setRfEdges(edges);
  }, [props.content, cardCallbacks, onLabelChange]);

  /* 解析失败不阻塞渲染；同一份内容只提示一次。 */
  const parsed = useMemo(() => parseCanvas(props.content), [props.content]);
  const toastedForRef = useRef<string | null>(null);
  useEffect(() => {
    if (parsed.errors.length === 0) {
      toastedForRef.current = null;
      return;
    }
    if (toastedForRef.current === props.content) return;
    toastedForRef.current = props.content;
    notify("画布部分内容无法解析，已忽略 " + parsed.errors.length + " 处");
  }, [parsed, props.content]);

  /* ---- 视口：挂载恢复 + onMoveEnd 节流落库（约 500ms 尾随） ---- */
  const instance = useReactFlow();
  const lastViewportRef = useRef<Viewport | null>(null);
  const viewportTimerRef = useRef<number | null>(null);

  const onMoveEnd = useCallback((_event: MouseEvent | TouchEvent | null, viewport: Viewport) => {
    lastViewportRef.current = viewport;
    if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
    viewportTimerRef.current = window.setTimeout(() => {
      viewportTimerRef.current = null;
      setCanvasViewport(propsRef.current.canvasId, lastViewportRef.current ?? viewport);
    }, VIEWPORT_SAVE_DELAY);
  }, []);

  useEffect(() => {
    const id = props.canvasId;
    return () => {
      // 卸载时把还没落库的最后一次视口补写（含被节流吞掉的那次）
      if (viewportTimerRef.current != null) window.clearTimeout(viewportTimerRef.current);
      if (lastViewportRef.current) setCanvasViewport(id, lastViewportRef.current);
    };
  }, [props.canvasId]);

  /* ---- controller：命令面板 / 菜单经它调 fitView / resetZoom / focusNode ---- */
  useEffect(() => {
    const id = props.canvasId;
    registerActiveCanvas(id, {
      fitView: () => {
        void instance.fitView({ padding: 0.2, duration: 300 });
      },
      resetZoom: () => {
        void instance.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 });
      },
      focusNode: (nodeId) => {
        const node = instance.getNodes().find((candidate) => candidate.id === nodeId);
        if (!node) return;
        const width = node.measured?.width ?? node.width ?? 260;
        const height = node.measured?.height ?? node.height ?? 160;
        void instance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
          zoom: Math.max(instance.getZoom(), 1),
          duration: 300,
        });
      },
    });
    return () => unregisterActiveCanvas(id);
  }, [instance, props.canvasId]);

  /* ---- 增删改：一切结构性变更都走 applyAndEmit → serializeCanvas → onContentChange ---- */
  const onNodesChange = useCallback(
    (changes: NodeChange<CanvasCardNode>[]) => {
      const nodes = applyNodeChanges(changes, nodesRef.current);
      nodesRef.current = nodes;
      setRfNodes(nodes);
      const dragSettled = changes.some((change) => change.type === "position" && change.dragging === false);
      const removed = changes.some((change) => change.type === "remove");
      if (dragSettled || removed) emit();
    },
    [emit],
  );

  const onEdgesChange = useCallback(
    (changes: EdgeChange<CanvasCardEdge>[]) => {
      const edges = applyEdgeChanges(changes, edgesRef.current);
      edgesRef.current = edges;
      setRfEdges(edges);
      if (changes.some((change) => change.type === "remove")) emit();
    },
    [emit],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (!connection.source || !connection.target || connection.source === connection.target) return;
      const id = newCanvasEdgeId(edgesRef.current.map((edge) => edge.id));
      const source: CanvasEdge = { id, fromNode: connection.source, toNode: connection.target };
      if (connection.sourceHandle) source.fromSide = connection.sourceHandle as CanvasNodeSide;
      if (connection.targetHandle) source.toSide = connection.targetHandle as CanvasNodeSide;
      applyAndEmit((nodes, edges) => [
        nodes,
        [
          ...edges,
          {
            id,
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle,
            targetHandle: connection.targetHandle,
            type: "canvasCard",
            selected: true,
            data: { source, onLabelChange },
          },
        ],
      ]);
    },
    [applyAndEmit, onLabelChange],
  );

  const selectOnlyNode = useCallback((id: string) => {
    const nodes = nodesRef.current.map((node) => ({ ...node, selected: node.id === id }));
    nodesRef.current = nodes;
    setRfNodes(nodes);
  }, []);

  const selectionCount = useCallback(
    () =>
      nodesRef.current.filter((node) => node.selected).length +
      edgesRef.current.filter((edge) => edge.selected).length,
    [],
  );

  const deleteSelection = useCallback(() => {
    applyAndEmit((nodes, edges) => {
      const removed = new Set(nodes.filter((node) => node.selected).map((node) => node.id));
      return [
        nodes.filter((node) => !node.selected),
        edges.filter((edge) => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)),
      ];
    });
    setMenu(null);
  }, [applyAndEmit]);

  const onNodeContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent, node: CanvasCardNode) => {
      event.preventDefault();
      // 命中的节点已在多选里就保留整个选区，否则单独选中它
      if (!node.selected) selectOnlyNode(node.id);
      setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, count: selectionCount() || 1 });
    },
    [selectOnlyNode, selectionCount],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null, count: selectionCount() });
    },
    [selectionCount],
  );

  const onSelectionContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent, nodes: CanvasCardNode[]) => {
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null, count: selectionCount() || nodes.length });
    },
    [selectionCount],
  );

  /* 右键菜单定位：几何坐标经 CSS 变量下发（与 applyUi() 同手法），样式留在 canvas.css */
  useEffect(() => {
    const el = menuRef.current;
    if (el && menu) {
      el.style.setProperty("--menu-x", String(menu.x) + "px");
      el.style.setProperty("--menu-y", String(menu.y) + "px");
    }
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (menuRef.current && event.target instanceof Node && !menuRef.current.contains(event.target)) setMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenu(null);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
    };
  }, [menu]);

  /* ---- 新建节点：落在当前视口中心 ---- */
  const flowCenter = useCallback((): { x: number; y: number } => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return instance.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [instance]);

  const addNodeAtCenter = useCallback(
    (node: CanvasNode) => {
      const center = flowCenter();
      const raw = node as Record<string, unknown>;
      const width = fieldNumber(raw.width) ?? 260;
      const height = fieldNumber(raw.height) ?? 160;
      const placed = {
        ...node,
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
      };
      applyAndEmit((nodes, edges) => [[...nodes, toFlowNode(placed, cardCallbacks, true)], edges]);
    },
    [applyAndEmit, cardCallbacks, flowCenter],
  );

  const addTextCard = useCallback(() => {
    const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
    addNodeAtCenter({
      id,
      type: "text",
      x: 0,
      y: 0,
      ...NEW_TEXT_CARD_SIZE,
      text: "",
    } satisfies CanvasTextNode);
  }, [addNodeAtCenter]);

  const addFileCard = useCallback(
    (noteId: string) => {
      const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
      addNodeAtCenter({
        id,
        type: "file",
        x: 0,
        y: 0,
        ...NEW_FILE_CARD_SIZE,
        file: noteId,
      } satisfies CanvasFileNode);
    },
    [addNodeAtCenter],
  );

  const menuTargetId = menu?.nodeId ?? null;
  const menuTargetNode =
    menuTargetId != null ? nodesRef.current.find((node) => node.id === menuTargetId) : undefined;
  const menuFile =
    menuTargetNode && menuTargetNode.data.source.type === "file"
      ? (menuTargetNode.data.source as CanvasFileNode).file
      : null;

  const isEmpty = rfNodes.length === 0 && rfEdges.length === 0;

  return (
    <div className="canvas-root">
      <div className="canvas-host" ref={hostRef}>
        <ReactFlow
          nodes={rfNodes}
          edges={rfEdges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onMoveEnd={onMoveEnd}
          onNodeContextMenu={onNodeContextMenu}
          onPaneContextMenu={onPaneContextMenu}
          onSelectionContextMenu={onSelectionContextMenu}
          defaultViewport={initial.viewport ?? { x: 0, y: 0, zoom: 1 }}
          fitView={initial.viewport == null && initial.hadNodes}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={DELETE_KEYS}
          /* 双击是卡片编辑 / 打开笔记的手势，双击缩放必须让位 */
          zoomOnDoubleClick={false}
          minZoom={0.2}
          className="canvas-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} />
        </ReactFlow>
      </div>

      {isEmpty && (
        <div className="canvas-empty">
          <div className="canvas-empty__card">
            <p className="canvas-empty__title">这块画布还是空的</p>
            <p className="canvas-empty__hint">建一张卡片，或把一篇已有笔记引用进来</p>
            <div className="canvas-empty__actions">
              <button type="button" className="canvas-btn canvas-btn--primary" onClick={addTextCard}>
                新建卡片
              </button>
              <button type="button" className="canvas-btn" onClick={() => setPickerOpen(true)}>
                引用笔记
              </button>
            </div>
          </div>
        </div>
      )}

      {pickerOpen && (
        <NotePicker
          onClose={() => setPickerOpen(false)}
          onPick={(noteId) => {
            setPickerOpen(false);
            addFileCard(noteId);
          }}
        />
      )}

      {menu && (
        <div ref={menuRef} className="canvas-menu" role="menu">
          {menuFile != null && (
            <button
              type="button"
              role="menuitem"
              className="canvas-menu__item"
              onClick={() => {
                setMenu(null);
                propsRef.current.onOpenNote(menuFile);
              }}
            >
              打开笔记
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            className="canvas-menu__item"
            disabled={menu.count === 0}
            onClick={deleteSelection}
          >
            删除所选
          </button>
          <div className="canvas-menu__sep" />
          <button
            type="button"
            role="menuitem"
            className="canvas-menu__item"
            onClick={() => {
              setMenu(null);
              void instance.fitView({ padding: 0.2, duration: 300 });
            }}
          >
            适应视图
          </button>
          <button
            type="button"
            role="menuitem"
            className="canvas-menu__item"
            onClick={() => {
              setMenu(null);
              void instance.setViewport({ x: 0, y: 0, zoom: 1 }, { duration: 300 });
            }}
          >
            重置缩放
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * 画布视图入口（default export）。外层容器需给出确定高度（.canvas-root 撑满它）。
 * 本模块（含子模块与样式）只应经 React.lazy 动态 import 进入应用 —— 它连着
 * @xyflow/react，静态引用会破坏 D28 的懒加载分包。
 */
export default function CanvasView(props: CanvasViewProps): ReactNode {
  return (
    <ReactFlowProvider>
      <CanvasSurface {...props} />
    </ReactFlowProvider>
  );
}
