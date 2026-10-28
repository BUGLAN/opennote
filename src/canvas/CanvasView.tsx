import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DragEvent as ReactDragEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  applyEdgeChanges,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type EdgeMarker,
  type NodeChange,
  type Viewport,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "../styles/canvas.css";
import { getCanvasViewport, setCanvasViewport } from "../data/library";
import { askText } from "../lib/dialogs";
import { extractHeadings } from "../lib/outline";
import { notify } from "../lib/toast";
import { desktopBridge } from "../desktop/bridge";
import { registerActiveCanvas, unregisterActiveCanvas } from "./controller";
import { newCanvasEdgeId, newCanvasNodeId } from "./ids";
import { createUndoHistory } from "./history";
import {
  clipboardBounds,
  collectSelection,
  getClipboard,
  materializeClipboard,
  setClipboard,
  type CanvasClipboard,
} from "./clipboard";
import { searchCanvas, type CanvasSearchMatch } from "./search";
import { CanvasCardEdgeView, type CanvasCardEdge } from "./edges";
import { FileCard, GroupCard, HtmlCard, LinkCard, TextCard, UnknownCard, type CanvasCardCallbacks, type CanvasCardNode } from "./nodes";
import { NotePicker } from "./notePicker";
import {
  CANVAS_COLOR_PRESETS,
  CANVAS_NOTE_DRAG_MIME,
  effectiveEdgeEnds,
  isCanvasColorPreset,
  isCanvasGroupNode,
  parseCanvas,
  serializeCanvas,
  withEdgeEnd,
} from "./types";
import type {
  CanvasDocument,
  CanvasEdge,
  CanvasFileNode,
  CanvasGroupNode,
  CanvasHtmlNode,
  CanvasLinkNode,
  CanvasNode,
  CanvasNodeSide,
  CanvasTextNode,
} from "./types";

/**
 * 视图契约 props —— 后续集成工位按此消费。核心五项一字不改；
 * `getNoteContent` 是画布编辑增强（任务 D）新增的**可选**项，宿主不接时
 * 「指向标题」退化为手输，其余功能不受影响。
 */
export interface CanvasViewProps {
  canvasId: string;
  content: string;
  onContentChange(next: string): void;
  onOpenNote(id: string): void;
  getNoteInfo(id: string): { title: string; exists: boolean } | null;
  /**
   * 目标笔记的正文（「指向标题」要用 outline 提取标题列表）。可选：宿主没接时
   * 该入口退化为手输 subpath，其余功能不受影响。
   */
  getNoteContent?(id: string): string | null;
}

const nodeTypes = { text: TextCard, file: FileCard, group: GroupCard, link: LinkCard, html: HtmlCard, canvasUnknown: UnknownCard };
const edgeTypes = { canvasCard: CanvasCardEdgeView };

/** 新卡默认尺寸（JSON Canvas 的宽高是节点数据的一部分，落盘可见）。 */
const NEW_TEXT_CARD_SIZE = { width: 260, height: 160 };
const NEW_FILE_CARD_SIZE = { width: 260, height: 110 };
const NEW_LINK_CARD_SIZE = { width: 300, height: 110 };
const NEW_GROUP_SIZE = { width: 400, height: 300 };
/** HTML 卡默认给一个「预览有意义」的尺寸（选中即挂 iframe，太小看不清）。 */
const NEW_HTML_CARD_SIZE = { width: 360, height: 240 };
const DELETE_KEYS = ["Backspace", "Delete"];
const VIEWPORT_SAVE_DELAY = 500;
/** 粘贴/副本的整体偏移：贴出来的东西不与原物完全重叠。 */
const PASTE_OFFSET = 24;

type FlowUpdate = (
  nodes: CanvasCardNode[],
  edges: CanvasCardEdge[],
) => [CanvasCardNode[], CanvasCardEdge[]];

interface CanvasMenuState {
  x: number;
  y: number;
  /** 右键命中的节点（file 卡才有「打开笔记」项）；面板右键为 null。 */
  nodeId: string | null;
  /** 右键命中的边（箭头/颜色项只在边菜单出现）。 */
  edgeId: string | null;
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
function nodeKindOf(node: CanvasNode): "text" | "file" | "group" | "link" | "html" | "canvasUnknown" {
  if (node.type === "text") return "text";
  if (node.type === "file") return "file";
  if (node.type === "group") return "group";
  if (node.type === "link") return "link";
  if (node.type === "html") return "html";
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
 * 边的箭头端 → React Flow marker 描述（渲染语义：fromEnd 缺省 none、toEnd 缺省
 * arrow，见 effectiveEdgeEnds）。marker 颜色吃 CSS 变量字符串：预设色引用
 * canvas.css 的令牌，非预设色原样传值 —— marker 定义渲染在流 DOM 内部的 <defs>
 * 里，:root 级令牌照样级联得到。
 */
function edgeMarkers(edge: CanvasEdge): { markerStart?: EdgeMarker; markerEnd?: EdgeMarker } {
  const ends = effectiveEdgeEnds(edge);
  const color =
    typeof edge.color === "string"
      ? isCanvasColorPreset(edge.color)
        ? `var(--canvas-c-${edge.color})`
        : edge.color
      : "var(--ink-3)";
  const out: { markerStart?: EdgeMarker; markerEnd?: EdgeMarker } = {};
  if (ends.fromEnd === "arrow") out.markerStart = { type: MarkerType.ArrowClosed, color, orient: "auto" };
  if (ends.toEnd === "arrow") out.markerEnd = { type: MarkerType.ArrowClosed, color, orient: "auto" };
  return out;
}

function toFlowEdge(edge: CanvasEdge, selected: boolean, onLabelChange: (id: string, label: string) => void): CanvasCardEdge {
  return {
    id: edge.id,
    source: edge.fromNode,
    target: edge.toNode,
    sourceHandle: edge.fromSide ?? null,
    targetHandle: edge.toSide ?? null,
    type: "canvasCard",
    selected: selected || undefined,
    ...edgeMarkers(edge),
    data: { source: edge, onLabelChange },
  };
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
    .map((edge) => toFlowEdge(edge, selected.has(edge.id), onLabelChange));
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
      else delete next.fromSide;
      if (edge.targetHandle) next.toSide = edge.targetHandle as CanvasNodeSide;
      else delete next.toSide;
      return next;
    }),
  };
}

/** 键盘快捷键守卫：焦点在输入控件里时不拦截（编辑中的 textarea 不归画布管）。 */
function isEditableTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)
  );
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
  /** 上一次「历史-worthy」状态的序列化：emit 时与现状比对，不同才入撤销栈。 */
  const stableTextRef = useRef<string>("");
  /** 撤销/重做应用后的那一次 emit 不入栈（回退本身不是新变更）。 */
  const suppressRecordRef = useRef(false);
  /** 本实例独立的撤销/重做栈（换画布 = 卸载重建 = 天然分栈）。 */
  const historyRef = useRef(createUndoHistory());

  const emit = useCallback(() => {
    const text = serializeCanvas(docFromFlow(nodesRef.current, edgesRef.current));
    // 与上一稳定态不同才入撤销栈（同一次拖动的中间帧根本不会走到 emit；
    // 落定时若实际没变，这里也不产生空记录）。
    if (stableTextRef.current !== text && !suppressRecordRef.current) {
      historyRef.current.record(stableTextRef.current);
    }
    suppressRecordRef.current = false;
    stableTextRef.current = text;
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

  /** 契约对象字段的通用改写（color/subpath/label……）：以 source 为底只动一个键。 */
  const patchNodeField = useCallback(
    (id: string, patch: (source: CanvasNode) => CanvasNode) => {
      applyAndEmit((nodes) => [
        nodes.map((node) => {
          if (node.id !== id || !node.data) return node;
          return { ...node, data: { ...node.data, source: patch(node.data.source) } };
        }),
        edgesRef.current,
      ]);
    },
    [applyAndEmit],
  );

  const patchEdgeField = useCallback(
    (id: string, patch: (source: CanvasEdge) => CanvasEdge) => {
      applyAndEmit((nodes, edges) => [
        nodes,
        edges.map((edge) => {
          if (edge.id !== id || !edge.data) return edge;
          return { ...edge, data: { ...edge.data, source: patch(edge.data.source) } };
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
      openLink: (url) => {
        // 桌面交给主进程（用户默认浏览器，仅 http/https）；纯浏览器退回 window.open。
        // 主进程没有 setWindowOpenHandler，直接 window.open 会开出一个 Electron 窗口。
        const external = desktopBridge()?.shell?.openExternal;
        if (typeof external === "function") {
          void external(url).catch(() => notify("没有打开浏览器。", { kind: "danger" }));
          return;
        }
        window.open(url, "_blank", "noopener,noreferrer");
      },
      editGroupLabel: (id, label) =>
        patchNodeField(id, (source) => {
          const next = { ...source } as CanvasGroupNode & Record<string, unknown>;
          if (label) next.label = label;
          else delete next.label;
          return next;
        }),
      editHtml: (id, html) =>
        applyAndEmit((nodes) => [
          nodes.map((node) =>
            node.id === id && node.data.source.type === "html"
              ? {
                  ...node,
                  data: {
                    ...node.data,
                    // 已按 type 收窄，cast 只是绕开联合展开的保守推断
                    source: { ...(node.data.source as CanvasHtmlNode), html },
                  },
                }
              : node,
          ),
          edgesRef.current,
        ]),
    }),
    [applyAndEmit, patchNodeField],
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
  if (stableTextRef.current === "") {
    stableTextRef.current = serializeCanvas(parseCanvas(props.content).doc);
  }
  const [menu, setMenu] = useState<CanvasMenuState | null>(null);
  const [colorMenuOpen, setColorMenuOpen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [subpathTarget, setSubpathTarget] = useState<{ nodeId: string; file: string } | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchIndex, setSearchIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  /** 以一份文本重建流状态（外部内容到达 / 撤销 / 重做共用），返回范式化后的文本。 */
  const adoptText = useCallback(
    (text: string): string => {
      const next = parseCanvas(text);
      const selected = new Set<string>(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
      for (const edge of edgesRef.current) if (edge.selected) selected.add(edge.id);
      const nodes = toFlowNodes(next.doc, selected, cardCallbacks);
      const edges = toFlowEdges(next.doc, selected, onLabelChange);
      nodesRef.current = nodes;
      edgesRef.current = edges;
      setRfNodes(nodes);
      setRfEdges(edges);
      return serializeCanvas(next.doc);
    },
    [cardCallbacks, onLabelChange],
  );

  /* 外部 content 变化（历史恢复 / 外部改名跟随 / 磁盘赢）：重新解析并尽量保留选区。
     自己 emit 的回声按队列识别后跳过 —— 上层防抖可能合并送达，最新的回声等价于当前状态。 */
  useEffect(() => {
    const text = props.content;
    const queue = pendingEchoRef.current;
    if (queue.length > 0 && queue[0] === text) {
      queue.shift();
      return;
    }
    if (text === stableTextRef.current) {
      queue.length = 0;
      return;
    }
    queue.length = 0;
    // 外部替换只移动历史基线，不入栈：撤销栈里的快照全部有效，用户仍能退回自己的编辑。
    // 基线取**流形态**的序列化（与 emit 的产出同一形态），后续比对才稳。
    adoptText(text);
    stableTextRef.current = serializeCanvas(docFromFlow(nodesRef.current, edgesRef.current));
  }, [props.content, adoptText]);

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

  /* ---- 撤销 / 重做（应用后照常走 emit 链路，由上层防抖落盘） ---- */
  const applyHistoryText = useCallback(
    (text: string | null) => {
      if (text == null) return;
      // 回退不是新变更：抑制这一次 emit 的入栈（基线由 emit 统一落到流形态的
      // 序列化，外部文件里的超精度坐标不会造成「回退 → 又被记一笔」的循环）。
      suppressRecordRef.current = true;
      adoptText(text);
      emit();
    },
    [adoptText, emit],
  );
  const undo = useCallback(() => applyHistoryText(historyRef.current.undo(stableTextRef.current)), [applyHistoryText]);
  const redo = useCallback(() => applyHistoryText(historyRef.current.redo(stableTextRef.current)), [applyHistoryText]);

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
      const resizeSettled = changes.some((change) => change.type === "dimensions" && change.resizing === false);
      const removed = changes.some((change) => change.type === "remove");
      if (dragSettled || resizeSettled || removed) emit();
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
      applyAndEmit((nodes, edges) => [nodes, [...edges, toFlowEdge(source, true, onLabelChange)]]);
    },
    [applyAndEmit, onLabelChange],
  );

  /* ---- 边重连：更新端点与吸附侧（handle 方位），其余字段原样 ---- */
  const onReconnect = useCallback(
    (oldEdge: CanvasCardEdge, connection: Connection) => {
      if (!connection.source || !connection.target) return;
      applyAndEmit((nodes, edges) => [
        nodes,
        edges.map((edge): CanvasCardEdge => {
          if (edge.id !== oldEdge.id || !edge.data) return edge;
          const source: CanvasEdge = { ...edge.data.source, fromNode: connection.source, toNode: connection.target };
          if (connection.sourceHandle) source.fromSide = connection.sourceHandle as CanvasNodeSide;
          else delete source.fromSide;
          if (connection.targetHandle) source.toSide = connection.targetHandle as CanvasNodeSide;
          else delete source.toSide;
          return {
            ...edge,
            source: connection.source,
            target: connection.target,
            sourceHandle: connection.sourceHandle,
            targetHandle: connection.targetHandle,
            data: { ...edge.data, source },
          };
        }),
      ]);
    },
    [applyAndEmit],
  );

  /* ---- 视口中心（新建/粘贴的落点） ---- */
  const flowCenter = useCallback((): { x: number; y: number } => {
    const rect = hostRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return instance.screenToFlowPosition({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
  }, [instance]);

  /* ---- 复制 / 粘贴 / 副本（模块级剪贴板，跨画布可用） ---- */
  const selectionPayload = useCallback((): CanvasClipboard | null => {
    const nodeIds = new Set(nodesRef.current.filter((node) => node.selected).map((node) => node.id));
    const edgeIds = new Set(edgesRef.current.filter((edge) => edge.selected).map((edge) => edge.id));
    if (nodeIds.size === 0 && edgeIds.size === 0) return null;
    return collectSelection(docFromFlow(nodesRef.current, edgesRef.current), nodeIds, edgeIds);
  }, []);

  const insertPayload = useCallback(
    (payload: CanvasClipboard, mode: "center" | "in-place") => {
      const taken = [
        ...nodesRef.current.map((node) => node.id),
        ...edgesRef.current.map((edge) => edge.id),
      ];
      const gen = {
        newNodeId: (used: ReadonlySet<string>) => newCanvasNodeId(used),
        newEdgeId: (used: ReadonlySet<string>) => newCanvasEdgeId(used),
      };
      let offset = { x: PASTE_OFFSET, y: PASTE_OFFSET };
      if (mode === "center") {
        const bounds = clipboardBounds(payload);
        const center = flowCenter();
        if (bounds) {
          offset = {
            x: center.x - (bounds.maxX - bounds.minX) / 2 - bounds.minX + PASTE_OFFSET,
            y: center.y - (bounds.maxY - bounds.minY) / 2 - bounds.minY + PASTE_OFFSET,
          };
        }
      }
      const materialized = materializeClipboard(payload, taken, gen, offset);
      if (materialized.nodes.length === 0 && materialized.edges.length === 0) return;
      applyAndEmit((nodes, edges) => {
        const fresh = materialized.nodes.map((node) => toFlowNode(node, cardCallbacks, true));
        // 分组永远垫底：数组序 = z 序，新分组插到最前，其余节点追加到末尾。
        const groups = fresh.filter((node) => isCanvasGroupNode(node.data.source));
        const rest = fresh.filter((node) => !isCanvasGroupNode(node.data.source));
        const freshEdges = materialized.edges.map((edge) => toFlowEdge(edge, true, onLabelChange));
        return [[...groups, ...nodes, ...rest], [...edges, ...freshEdges]];
      });
    },
    [applyAndEmit, cardCallbacks, flowCenter, onLabelChange],
  );

  const copySelection = useCallback(() => {
    const payload = selectionPayload();
    if (payload) setClipboard(payload);
  }, [selectionPayload]);

  const pasteClipboard = useCallback(() => {
    const payload = getClipboard();
    if (payload) insertPayload(payload, "center");
  }, [insertPayload]);

  const duplicateSelection = useCallback(() => {
    const payload = selectionPayload();
    if (payload) insertPayload(payload, "in-place");
  }, [insertPayload, selectionPayload]);

  /* ---- z 序：数组序 = z 序（JSON Canvas 规范） ---- */
  const restackSelection = useCallback(
    (where: "front" | "back") => {
      applyAndEmit((nodes, edges) => {
        const picked = nodes.filter((node) => node.selected);
        if (picked.length === 0) return [nodes, edges];
        const rest = nodes.filter((node) => !node.selected);
        // 分组始终垫底（容器语义）：置顶把所选追加到末尾，置底让所选紧随分组。
        const groups = rest.filter((node) => isCanvasGroupNode(node.data.source));
        const others = rest.filter((node) => !isCanvasGroupNode(node.data.source));
        const next = where === "front" ? [...groups, ...others, ...picked] : [...groups, ...picked, ...others];
        return [next, edges];
      });
    },
    [applyAndEmit],
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
      setColorMenuOpen(false);
      setMenu({ x: event.clientX, y: event.clientY, nodeId: node.id, edgeId: null, count: selectionCount() || 1 });
    },
    [selectOnlyNode, selectionCount],
  );

  const onPaneContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent) => {
      event.preventDefault();
      setColorMenuOpen(false);
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null, edgeId: null, count: selectionCount() });
    },
    [selectionCount],
  );

  const onSelectionContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent, nodes: CanvasCardNode[]) => {
      event.preventDefault();
      setColorMenuOpen(false);
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null, edgeId: null, count: selectionCount() || nodes.length });
    },
    [selectionCount],
  );

  const onEdgeContextMenu = useCallback(
    (event: MouseEvent | ReactMouseEvent, edge: CanvasCardEdge) => {
      event.preventDefault();
      const edges = edgesRef.current.map((item) => ({ ...item, selected: item.id === edge.id || undefined }));
      edgesRef.current = edges;
      setRfEdges(edges);
      setColorMenuOpen(false);
      setMenu({ x: event.clientX, y: event.clientY, nodeId: null, edgeId: edge.id, count: 1 });
    },
    [],
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
  const addNodeAtCenter = useCallback(
    (node: CanvasNode, at?: { x: number; y: number }) => {
      const center = at ?? flowCenter();
      const raw = node as Record<string, unknown>;
      const width = fieldNumber(raw.width) ?? 260;
      const height = fieldNumber(raw.height) ?? 160;
      const placed = {
        ...node,
        x: Math.round(center.x - width / 2),
        y: Math.round(center.y - height / 2),
      };
      applyAndEmit((nodes, edges) => {
        // 分组垫底（数组序 = z 序），其余追加。
        const flow = toFlowNode(placed, cardCallbacks, true);
        return [isCanvasGroupNode(placed) ? [flow, ...nodes] : [...nodes, flow], edges];
      });
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
    (noteId: string, at?: { x: number; y: number }) => {
      const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
      addNodeAtCenter(
        {
          id,
          type: "file",
          x: 0,
          y: 0,
          ...NEW_FILE_CARD_SIZE,
          file: noteId,
        } satisfies CanvasFileNode,
        at,
      );
    },
    [addNodeAtCenter],
  );

  const addGroupCard = useCallback(() => {
    const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
    addNodeAtCenter({
      id,
      type: "group",
      x: 0,
      y: 0,
      ...NEW_GROUP_SIZE,
    } satisfies CanvasGroupNode);
  }, [addNodeAtCenter]);

  /** 新建 HTML 卡：空内容落位（选中态），卡上提示「双击粘贴或编写 HTML」。 */
  const addHtmlCard = useCallback(() => {
    const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
    addNodeAtCenter({
      id,
      type: "html",
      x: 0,
      y: 0,
      ...NEW_HTML_CARD_SIZE,
      html: "",
    } satisfies CanvasHtmlNode);
  }, [addNodeAtCenter]);

  const addLinkCard = useCallback(() => {
    void (async () => {
      const answer = await askText({
        title: "新建网页卡",
        label: "网址",
        value: "https://",
        placeholder: "https://example.com",
      });
      if (answer == null) return;
      const url = answer.trim();
      if (!/^https:\/\//i.test(url)) {
        notify("网址需要以 http:// 或 https:// 开头");
        return;
      }
      const id = newCanvasNodeId(nodesRef.current.map((node) => node.id));
      addNodeAtCenter({
        id,
        type: "link",
        x: 0,
        y: 0,
        ...NEW_LINK_CARD_SIZE,
        url,
      } satisfies CanvasLinkNode);
    })();
  }, [addNodeAtCenter]);

  /* ---- 侧栏笔记拖入（拖拽契约见 CANVAS_NOTE_DRAG_MIME） ---- */
  const onHostDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    const types = Array.from(event.dataTransfer.types);
    if (types.includes(CANVAS_NOTE_DRAG_MIME) || types.includes("Files")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }, []);

  const onHostDrop = useCallback(
    (event: ReactDragEvent<HTMLDivElement>) => {
      const noteId = event.dataTransfer.getData(CANVAS_NOTE_DRAG_MIME);
      if (!noteId) return;
      event.preventDefault();
      const info = propsRef.current.getNoteInfo(noteId);
      if (!info || !info.exists) {
        notify("拖入的笔记在当前工作区里不存在");
        return;
      }
      const position = instance.screenToFlowPosition({ x: event.clientX, y: event.clientY });
      addFileCard(noteId, position);
    },
    [addFileCard, instance],
  );

  /* ---- 画布内搜索 ---- */
  const noteTitleForSearch = useCallback(
    (noteId: string): string | null => propsRef.current.getNoteInfo(noteId)?.title ?? null,
    [],
  );
  const searchMatches = searchOpen
    ? searchCanvas(docFromFlow(nodesRef.current, edgesRef.current), searchQuery, noteTitleForSearch)
    : [];

  const jumpToMatch = useCallback(
    (match: CanvasSearchMatch) => {
      if (match.kind === "node") {
        const node = nodesRef.current.find((candidate) => candidate.id === match.id);
        if (!node) return;
        const width = node.measured?.width ?? node.width ?? 260;
        const height = node.measured?.height ?? node.height ?? 160;
        const nodes = nodesRef.current.map((item) => ({ ...item, selected: item.id === match.id || undefined }));
        nodesRef.current = nodes;
        setRfNodes(nodes);
        const edges = edgesRef.current.map((edge) => ({ ...edge, selected: undefined }));
        edgesRef.current = edges;
        setRfEdges(edges);
        void instance.setCenter(node.position.x + width / 2, node.position.y + height / 2, {
          zoom: Math.max(instance.getZoom(), 1),
          duration: 300,
        });
        return;
      }
      const edge = edgesRef.current.find((candidate) => candidate.id === match.id);
      if (!edge) return;
      const source = nodesRef.current.find((node) => node.id === edge.source);
      const target = nodesRef.current.find((node) => node.id === edge.target);
      if (!source || !target) return;
      const edges = edgesRef.current.map((item) => ({ ...item, selected: item.id === match.id || undefined }));
      edgesRef.current = edges;
      setRfEdges(edges);
      const nodes = nodesRef.current.map((node) => ({ ...node, selected: undefined }));
      nodesRef.current = nodes;
      setRfNodes(nodes);
      void instance.setCenter(
        (source.position.x + target.position.x) / 2,
        (source.position.y + target.position.y) / 2,
        { zoom: Math.max(instance.getZoom(), 1), duration: 300 },
      );
    },
    [instance],
  );

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchIndex(0);
    // 等 input 挂载后聚焦（ autoFocus 在反复打开时不可靠）
    window.setTimeout(() => searchInputRef.current?.focus(), 0);
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchQuery("");
    setSearchIndex(0);
  }, []);

  /* ---- 画布级快捷键（挂画布容器；输入控件里的按键不拦截） ---- */
  const onCanvasKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isEditableTarget(event.target)) return;
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "z" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        undo();
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        event.preventDefault();
        event.stopPropagation();
        redo();
      } else if (key === "c") {
        event.preventDefault();
        event.stopPropagation();
        copySelection();
      } else if (key === "v") {
        event.preventDefault();
        event.stopPropagation();
        pasteClipboard();
      } else if (key === "d") {
        event.preventDefault();
        event.stopPropagation();
        duplicateSelection();
      } else if (key === "f") {
        event.preventDefault();
        event.stopPropagation();
        openSearch();
      }
    },
    [copySelection, duplicateSelection, openSearch, pasteClipboard, redo, undo],
  );

  /* ---- 菜单目标与动作 ---- */
  const menuTargetId = menu?.nodeId ?? null;
  const menuTargetNode =
    menuTargetId != null ? nodesRef.current.find((node) => node.id === menuTargetId) : undefined;
  const menuFile =
    menuTargetNode && menuTargetNode.data.source.type === "file"
      ? (menuTargetNode.data.source as CanvasFileNode).file
      : null;
  const menuFileSubpath =
    menuTargetNode && menuTargetNode.data.source.type === "file"
      ? (menuTargetNode.data.source as CanvasFileNode).subpath ?? null
      : null;
  const menuTargetEdge =
    menu?.edgeId != null ? edgesRef.current.find((edge) => edge.id === menu.edgeId) : undefined;
  const menuColor = (() => {
    const raw =
      menuTargetEdge?.data?.source.color ?? (menuTargetNode ? (menuTargetNode.data.source.color as unknown) : undefined);
    return typeof raw === "string" ? raw : null;
  })();
  const menuEdgeEnds = menuTargetEdge?.data ? effectiveEdgeEnds(menuTargetEdge.data.source) : null;

  const applyMenuColor = useCallback(
    (color: string | null) => {
      if (menu?.edgeId != null) {
        patchEdgeField(menu.edgeId, (source) => {
          const next = { ...source } as CanvasEdge & Record<string, unknown>;
          if (color) next.color = color;
          else delete next.color;
          return next;
        });
      } else if (menu?.nodeId != null) {
        patchNodeField(menu.nodeId, (source) => {
          const next = { ...source } as CanvasNode & Record<string, unknown>;
          if (color) next.color = color;
          else delete next.color;
          return next;
        });
      }
      setColorMenuOpen(false);
      setMenu(null);
    },
    [menu, patchEdgeField, patchNodeField],
  );

  const toggleMenuEdgeEnd = useCallback(
    (end: "fromEnd" | "toEnd") => {
      if (menu?.edgeId == null || !menuEdgeEnds) return;
      const current = menuEdgeEnds[end];
      const id = menu.edgeId;
      patchEdgeField(id, (source) => withEdgeEnd(source, end, current === "arrow" ? "none" : "arrow"));
      setMenu(null);
    },
    [menu, menuEdgeEnds, patchEdgeField],
  );

  /** 某文件卡当前 subpath（选择器里「清除」按钮的可用性与手输初值用）。 */
  const subpathOf = useCallback((nodeId: string): string | null => {
    const node = nodesRef.current.find((candidate) => candidate.id === nodeId);
    return node && node.data.source.type === "file"
      ? (node.data.source as CanvasFileNode).subpath ?? null
      : null;
  }, []);

  /** subpath 落盘统一以 # 开头；空 = 清除。 */
  const setSubpath = useCallback(
    (nodeId: string, subpath: string | null) => {
      patchNodeField(nodeId, (source) => {
        const next = { ...source } as CanvasFileNode & Record<string, unknown>;
        if (subpath) next.subpath = subpath.startsWith("#") ? subpath : `#${subpath}`;
        else delete next.subpath;
        return next;
      });
    },
    [patchNodeField],
  );

  const openSubpathManual = useCallback(
    async (nodeId: string, current: string | null) => {
      const answer = await askText({
        title: "指向标题",
        label: "标题（以 # 开头，留空清除）",
        value: current ?? "",
        placeholder: "#标题",
        allowEmpty: true,
      });
      if (answer == null) return;
      setSubpath(nodeId, answer.trim() ? answer.trim() : null);
    },
    [setSubpath],
  );

  const subpathHeadings = useMemo(() => {
    if (!subpathTarget) return [];
    const content = propsRef.current.getNoteContent?.(subpathTarget.file);
    return content ? extractHeadings(content) : [];
  }, [subpathTarget]);

  const isEmpty = rfNodes.length === 0 && rfEdges.length === 0;

  return (
    <div className="canvas-root" onKeyDown={onCanvasKeyDown}>
      <div className="canvas-host" ref={hostRef} onDragOver={onHostDragOver} onDrop={onHostDrop}>
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
          onEdgeContextMenu={onEdgeContextMenu}
          onReconnect={onReconnect}
          onReconnectStart={() => setMenu(null)}
          defaultViewport={initial.viewport ?? { x: 0, y: 0, zoom: 1 }}
          fitView={initial.viewport == null && initial.hadNodes}
          connectionMode={ConnectionMode.Loose}
          deleteKeyCode={DELETE_KEYS}
          /* 双击是卡片编辑 / 打开笔记的手势，双击缩放必须让位 */
          zoomOnDoubleClick={false}
          minZoom={0.2}
          onlyRenderVisibleElements
          className="canvas-flow"
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1.6} />
          <Controls showInteractive={false} />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>

      {searchOpen && (
        <div className="canvas-search" role="search">
          <input
            ref={searchInputRef}
            className="canvas-search__input"
            type="text"
            value={searchQuery}
            placeholder="搜索画布内容…"
            spellCheck={false}
            onChange={(event) => {
              setSearchQuery(event.target.value);
              setSearchIndex(0);
            }}
            onKeyDown={(event) => {
              // 搜索框的按键不许漏给画布快捷键；Enter 跳下一处，Esc 关闭
              event.stopPropagation();
              if (event.key === "Escape") closeSearch();
              if (event.key === "Enter" && searchMatches.length > 0) {
                const next = (searchIndex + 1) % searchMatches.length;
                setSearchIndex(next);
                jumpToMatch(searchMatches[next]!);
              }
            }}
          />
          <span className="canvas-search__count">
            {searchMatches.length > 0 ? `${Math.min(searchIndex + 1, searchMatches.length)}/${searchMatches.length}` : "0"}
          </span>
          <button type="button" className="canvas-search__close" aria-label="关闭搜索" onClick={closeSearch}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
      )}

      {/* 常驻建卡条：空画布有大引导，有内容后靠这条轻量工具条保持入口可达。 */}
      {!isEmpty && (
        <div className="canvas-tools" role="toolbar" aria-label="新建">
          <button type="button" className="canvas-tools__btn" title="新建卡片" onClick={addTextCard}>
            新建卡片
          </button>
          <button type="button" className="canvas-tools__btn" title="引用笔记" onClick={() => setPickerOpen(true)}>
            引用笔记
          </button>
        </div>
      )}

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

      {subpathTarget && (
        <div
          className="canvas-picker"
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) setSubpathTarget(null);
          }}
        >
          <div className="canvas-picker__panel">
            <div className="canvas-picker__head">
              <div className="canvas-picker__title">指向标题</div>
              <button
                className="canvas-picker__close"
                type="button"
                aria-label="关闭"
                onClick={() => setSubpathTarget(null)}
              >
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </button>
            </div>
            <div className="canvas-picker__list" role="listbox" aria-label="标题列表">
              {subpathHeadings.map((heading) => (
                <button
                  key={`${heading.line}:${heading.pos}`}
                  type="button"
                  role="option"
                  className="canvas-picker__item"
                  onClick={() => {
                    setSubpath(subpathTarget.nodeId, `#${heading.text}`);
                    setSubpathTarget(null);
                  }}
                >
                  <span className="canvas-picker__name" data-level={heading.level}>
                    {heading.text}
                  </span>
                  <span className="canvas-picker__path">H{heading.level} · 第 {heading.line} 行</span>
                </button>
              ))}
              {subpathHeadings.length === 0 && (
                <div className="canvas-picker__empty">这篇笔记没有标题（或正文暂不可读）</div>
              )}
            </div>
            <div className="canvas-picker__foot">
              <button
                type="button"
                className="canvas-btn"
                onClick={() => {
                  const target = subpathTarget;
                  setSubpathTarget(null);
                  void openSubpathManual(target.nodeId, subpathOf(target.nodeId));
                }}
              >
                手动输入…
              </button>
              <button
                type="button"
                className="canvas-btn"
                disabled={!subpathOf(subpathTarget.nodeId)}
                onClick={() => {
                  setSubpath(subpathTarget.nodeId, null);
                  setSubpathTarget(null);
                }}
              >
                清除指向
              </button>
            </div>
          </div>
        </div>
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
          {menuFile != null && (
            <button
              type="button"
              role="menuitem"
              className="canvas-menu__item"
              onClick={() => {
                const nodeId = menu.nodeId!;
                setMenu(null);
                if (propsRef.current.getNoteContent) setSubpathTarget({ nodeId, file: menuFile });
                else void openSubpathManual(nodeId, menuFileSubpath);
              }}
            >
              {menuFileSubpath ? `指向标题（${menuFileSubpath}）…` : "指向标题…"}
            </button>
          )}
          {menu.edgeId != null && menuEdgeEnds && (
            <>
              <button
                type="button"
                role="menuitem"
                className="canvas-menu__item"
                onClick={() => toggleMenuEdgeEnd("fromEnd")}
              >
                起点箭头：{menuEdgeEnds.fromEnd === "arrow" ? "开" : "关"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="canvas-menu__item"
                onClick={() => toggleMenuEdgeEnd("toEnd")}
              >
                终点箭头：{menuEdgeEnds.toEnd === "arrow" ? "开" : "关"}
              </button>
            </>
          )}
          {(menu.nodeId != null || menu.edgeId != null) && (
            <>
              <button
                type="button"
                role="menuitem"
                aria-expanded={colorMenuOpen}
                className="canvas-menu__item"
                onClick={() => setColorMenuOpen((open) => !open)}
              >
                颜色
              </button>
              {colorMenuOpen && (
                <div className="canvas-menu__swatches" role="group" aria-label="颜色">
                  {CANVAS_COLOR_PRESETS.map((preset) => (
                    <button
                      key={preset}
                      type="button"
                      className={`canvas-menu__swatch is-color-${preset}${menuColor === preset ? " is-active" : ""}`}
                      aria-label={`颜色 ${preset}`}
                      onClick={() => applyMenuColor(preset)}
                    />
                  ))}
                  <button
                    type="button"
                    className={`canvas-menu__swatch canvas-menu__swatch--none${menuColor == null ? " is-active" : ""}`}
                    aria-label="无色"
                    onClick={() => applyMenuColor(null)}
                  >
                    无
                  </button>
                </div>
              )}
            </>
          )}
          {menu.nodeId == null && menu.edgeId == null && (
            <>
              {/* 空白处右键：最常用的两种卡片放在最前，其次才是分组/网页卡。 */}
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); addTextCard(); }}>
                新建卡片
              </button>
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); setPickerOpen(true); }}>
                引用笔记
              </button>
              <div className="canvas-menu__sep" />
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); addGroupCard(); }}>
                新建分组
              </button>
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); addLinkCard(); }}>
                新建网页卡
              </button>
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); addHtmlCard(); }}>
                新建 HTML 卡
              </button>
              <div className="canvas-menu__sep" />
            </>
          )}
          {rfNodes.some((node) => node.selected) && (
            <>
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); restackSelection("front"); }}>
                移到最前
              </button>
              <button type="button" role="menuitem" className="canvas-menu__item" onClick={() => { setMenu(null); restackSelection("back"); }}>
                移到最后
              </button>
              <div className="canvas-menu__sep" />
            </>
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
