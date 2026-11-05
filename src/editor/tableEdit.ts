import { syntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Prec, StateField, type Extension, type Transaction } from "@codemirror/state";
import { EditorView, keymap, showTooltip, type Command, type Tooltip } from "@codemirror/view";
import type { SyntaxNode } from "@lezer/common";
import { livePreviewField } from "./livePreview";
import { editorSettingsField } from "./settings";
import { parseTableAlignments, splitTableRow, type TableAlign } from "./tableMetrics";
import { unwrapSource } from "./unwrapEffect";

/**
 * 表格「就地编辑态」的结构保护与编辑工具。
 *
 * 就地编辑态（`livePreview.ts` 的 `renderTableInPlace`）把源码行排成一张真表格，竖线和
 * 两侧空白都藏起来了 —— 于是 CodeMirror 的默认按键全都在**看不见的地方**动手：回车把一行
 * 拆成两行、单元格开头按退格先删掉隐藏的空格再删掉竖线（两格当场合并）、Tab 插空格、
 * ←→ 在隐藏的 `| ` 里空走（排查报告问题 4）；表格最后一行回车之后打的字，会被 GFM 当成
 * 新的一行吞进表格（问题 5）。这里把这些按键换成 Typora 式的表格语义：
 *
 * | 按键 | 行为 |
 * |---|---|
 * | Tab / Shift-Tab | 跳到下一格 / 上一格（跳过分隔行），最后一格再 Tab 新起一行 |
 * | 回车 | 在下面插一行、光标进同一列；在**空的最后一行**回车 ⇒ 删掉它、跳出表格 |
 * | ⌘回车 | 直接跳出表格（下面隔一个空行） |
 * | 退格 / Delete | 只删格子里的字；碰到格子边界就停（不删竖线） |
 * | ← / → | 到格子边界时跳到相邻格子，不在隐藏的竖线里空走 |
 * | `\|` | 写成 `\|`（转义），不会凭空多出一列 |
 *
 * 只在**就地编辑态**生效：用户主动拆开表格（`unwrapSource`）或打开「显示标记」时，看到的
 * 是原始 markdown，按键回到普通文本语义。
 */

/* ------------------------------------------------------------ 几何 */

interface Cell {
  /** 两根竖线之间（不含竖线），文档坐标。 */
  from: number;
  to: number;
  /** 去掉两侧空白之后的文字范围；空格子是一个落在格子里的点。 */
  contentFrom: number;
  contentTo: number;
  blank: boolean;
}

interface Row {
  line: number;
  from: number;
  to: number;
  cells: Cell[];
  header: boolean;
  delimiter: boolean;
}

interface TableInfo {
  node: SyntaxNode;
  rows: Row[];
  columns: number;
  aligns: TableAlign[];
}

function cellsOf(lineFrom: number, text: string): Cell[] {
  return splitTableRow(text).cells.map(({ from, to }) => {
    const raw = text.slice(from, to);
    const lead = raw.length - raw.trimStart().length;
    const trail = raw.length - raw.trimEnd().length;
    const blank = raw.trim().length === 0;
    const point = lineFrom + Math.min(from + 1, to);
    return {
      from: lineFrom + from,
      to: lineFrom + to,
      contentFrom: blank ? point : lineFrom + from + lead,
      contentTo: blank ? point : lineFrom + to - trail,
      blank,
    };
  });
}

function tableNodeAt(state: EditorState, pos: number): SyntaxNode | null {
  for (const side of [1, -1] as const) {
    for (let node: SyntaxNode | null = syntaxTree(state).resolveInner(pos, side); node; node = node.parent) {
      if (node.name === "Table") return node;
    }
  }
  return null;
}

/** 这张表此刻是不是就地编辑态（没被拆开、没开「显示标记」）。 */
function inPlace(state: EditorState, node: SyntaxNode): boolean {
  if (state.field(editorSettingsField, false)?.showMarks) return false;
  const unwrapped = state.field(livePreviewField, false)?.unwrapped;
  return !(unwrapped && unwrapped.from <= node.to && unwrapped.to >= node.from);
}

function tableAt(state: EditorState, pos: number): TableInfo | null {
  const node = tableNodeAt(state, pos);
  if (!node || !inPlace(state, node)) return null;
  const doc = state.doc;
  const first = doc.lineAt(node.from).number;
  const last = doc.lineAt(node.to).number;
  const rows: Row[] = [];
  let delimiterText = "";
  for (let n = first; n <= last; n += 1) {
    const line = doc.line(n);
    const index = n - first;
    if (index === 1) delimiterText = line.text;
    rows.push({ line: n, from: line.from, to: line.to, cells: cellsOf(line.from, line.text), header: index === 0, delimiter: index === 1 });
  }
  const aligns = parseTableAlignments(delimiterText);
  const columns = aligns.length || rows[0]?.cells.length || 0;
  return columns > 0 ? { node, rows, columns, aligns } : null;
}

interface CellAt {
  table: TableInfo;
  row: number;
  col: number;
  cell: Cell;
}

/** 光标所在的格子。落在竖线 / 行首行尾（隐藏区）时归到最近的那一格。 */
function cellAt(state: EditorState, pos: number): CellAt | null {
  const table = tableAt(state, pos);
  if (!table) return null;
  const row = table.rows.findIndex((r) => pos >= r.from && pos <= r.to);
  if (row < 0 || table.rows[row].delimiter) return null;
  const cells = table.rows[row].cells;
  if (!cells.length) return null;
  let col = cells.findIndex((cell) => pos >= cell.from && pos <= cell.to);
  if (col < 0) col = pos < cells[0].from ? 0 : cells.length - 1;
  return { table, row, col, cell: cells[col] };
}

function bodyRows(table: TableInfo): number[] {
  return table.rows.map((_, i) => i).filter((i) => !table.rows[i].delimiter);
}

function emptyRow(columns: number): string {
  return `|${"  |".repeat(columns)}`;
}

/** 新行里第 `col` 格的光标位置（`|  |  |` 里两个空格中间）。 */
function emptyRowCaret(rowFrom: number, col: number): number {
  return rowFrom + 3 * col + 2;
}

/* ------------------------------------------------------------ 按键 */

function single(state: EditorState): number | null {
  const range = state.selection.main;
  return range.empty && state.selection.ranges.length === 1 ? range.head : null;
}

function moveTo(view: EditorView, pos: number): true {
  view.dispatch({ selection: { anchor: pos }, scrollIntoView: true, userEvent: "select" });
  return true;
}

function cellAfter(table: TableInfo, row: number, col: number, step: 1 | -1): Cell | null {
  const order = bodyRows(table);
  let r = order.indexOf(row);
  let c = col + step;
  while (r >= 0 && r < order.length) {
    const cells = table.rows[order[r]].cells;
    if (c >= 0 && c < cells.length) return cells[c];
    r += step;
    if (r < 0 || r >= order.length) break;
    c = step > 0 ? 0 : table.rows[order[r]].cells.length - 1;
  }
  return null;
}

const tableTab: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const next = cellAfter(at.table, at.row, at.col, 1);
  if (next) return moveTo(view, next.contentTo);
  // 最后一格：新起一行
  const end = at.table.rows[at.table.rows.length - 1].to;
  view.dispatch({
    changes: { from: end, insert: `\n${emptyRow(at.table.columns)}` },
    selection: { anchor: emptyRowCaret(end + 1, 0) },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
};

const tableShiftTab: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const prev = cellAfter(at.table, at.row, at.col, -1);
  return prev ? moveTo(view, prev.contentTo) : true;
};

/** 跳出表格：在表格后面隔一个空行，光标落到新的一行。 */
function exitTable(view: EditorView, table: TableInfo, removeLastRow: boolean): true {
  const last = table.rows[table.rows.length - 1];
  if (removeLastRow) {
    // 空行换成一个换行：`last.from` 前面那个换行留着，于是表格与新段落之间正好一个空行
    view.dispatch({
      changes: { from: last.from, to: last.to, insert: "\n" },
      selection: { anchor: last.from + 1 },
      userEvent: "input",
      scrollIntoView: true,
    });
    return true;
  }
  view.dispatch({
    changes: { from: last.to, insert: "\n\n" },
    selection: { anchor: last.to + 2 },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
}

const tableEnter: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const { table } = at;
  const row = table.rows[at.row];
  const isLast = at.row === table.rows.length - 1;
  if (isLast && !row.header && row.cells.every((cell) => cell.blank)) return exitTable(view, table, true);
  // 表头下面插行 ⇒ 插在分隔行之后（成为第一行正文）
  const after = row.header && table.rows[1]?.delimiter ? table.rows[1] : row;
  view.dispatch({
    changes: { from: after.to, insert: `\n${emptyRow(table.columns)}` },
    selection: { anchor: emptyRowCaret(after.to + 1, Math.min(at.col, table.columns - 1)) },
    userEvent: "input",
    scrollIntoView: true,
  });
  return true;
};

const tableExit: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  return at ? exitTable(view, at.table, false) : false;
};

const tableBackspace: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const { cell } = at;
  if (pos! > cell.contentFrom && !cell.blank) {
    if (pos! <= cell.contentTo) return false; // 格子里面：普通的删一个字
    // 停在格子末尾的隐藏空白里：删的是最后一个字，不是看不见的空格
    view.dispatch({
      changes: { from: cell.contentTo - 1, to: cell.contentTo },
      selection: { anchor: cell.contentTo - 1 },
      userEvent: "delete.backward",
    });
    return true;
  }
  // 格子开头：空的最后一行在第一格按退格 ⇒ 删掉这一行，回到上一行末尾
  const row = at.table.rows[at.row];
  const isLast = at.row === at.table.rows.length - 1;
  if (at.col === 0 && isLast && !row.header && at.table.rows.length > 3 && row.cells.every((c) => c.blank)) {
    const prev = at.table.rows[at.row - 1];
    const target = prev.cells[prev.cells.length - 1]?.contentTo ?? prev.to;
    view.dispatch({ changes: { from: prev.to, to: row.to }, selection: { anchor: target }, userEvent: "delete.backward" });
    return true;
  }
  return true;
};

const tableDelete: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const { cell, table } = at;
  if (pos! < cell.contentTo && !cell.blank) {
    if (pos! >= cell.contentFrom) return false;
    view.dispatch({ changes: { from: cell.contentFrom, to: cell.contentFrom + 1 }, selection: { anchor: cell.contentFrom }, userEvent: "delete.forward" });
    return true;
  }
  // 整张表的最后一格末尾按 Delete ⇒ 先拆成源码（与「表格末尾先拆开」的既有约定一致）
  const lastRow = at.row === table.rows.length - 1;
  if (lastRow && at.col === table.rows[at.row].cells.length - 1) {
    view.dispatch({ effects: unwrapSource.of({ from: table.node.from, to: table.node.to }) });
  }
  return true;
};

const tableLeft: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at || pos! > at.cell.contentFrom) return false;
  const prev = cellAfter(at.table, at.row, at.col, -1);
  if (prev) return moveTo(view, prev.contentTo);
  const first = at.table.rows[0];
  return first.from > 0 ? moveTo(view, first.from - 1) : true;
};

const tableRight: Command = (view) => {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at || pos! < at.cell.contentTo) return false;
  const next = cellAfter(at.table, at.row, at.col, 1);
  if (next) return moveTo(view, next.contentFrom);
  const last = at.table.rows[at.table.rows.length - 1];
  return last.to < view.state.doc.length ? moveTo(view, last.to + 1) : true;
};

const tablePipe: Command = (view) => {
  const pos = single(view.state);
  if (pos == null || !cellAt(view.state, pos)) return false;
  view.dispatch(view.state.replaceSelection("\\|"), { userEvent: "input.type" });
  return true;
};

const tableKeymap = Prec.highest(
  keymap.of([
    { key: "Tab", run: tableTab, shift: tableShiftTab },
    { key: "Enter", run: tableEnter },
    { key: "Mod-Enter", run: tableExit },
    { key: "Backspace", run: tableBackspace },
    { key: "Delete", run: tableDelete },
    { key: "ArrowLeft", run: tableLeft },
    { key: "ArrowRight", run: tableRight },
    { key: "|", run: tablePipe },
  ]),
);

/* ------------------------------------------------------------ 光标吸附 */

/**
 * 光标落在隐藏的竖线 / 行首行尾 / 分隔行上 ⇒ 吸到最近的格子文字边上。
 * 点击格子的内边距、上下键穿过表格都会落到这些看不见的位置，在那里打字会改坏结构。
 */
function snapIntoCell(tr: Transaction): Transaction | readonly [Transaction, { selection: EditorSelection; sequential: true }] {
  if (!tr.selection && !tr.docChanged) return tr;
  const sel = tr.newSelection;
  if (sel.ranges.length !== 1 || !sel.main.empty) return tr;
  const head = sel.main.head;
  // 便宜的预检：这一行看起来像表格行才往下算
  if (!tr.newDoc.lineAt(head).text.includes("|")) return tr;
  const state = tr.state;
  const table = tableAt(state, head);
  if (!table) return tr;
  const rowIndex = table.rows.findIndex((r) => head >= r.from && head <= r.to);
  if (rowIndex < 0) return tr;
  let target = head;
  const row = table.rows[rowIndex];
  if (row.delimiter) {
    const before = tr.startState.selection.main.head;
    const fromBelow = before > row.to;
    const other = fromBelow ? table.rows[0] : (table.rows[2] ?? table.rows[0]);
    const col = Math.max(0, row.cells.findIndex((cell) => head >= cell.from && head <= cell.to));
    const cell = other.cells[Math.min(col, other.cells.length - 1)];
    target = cell ? cell.contentTo : other.to;
  } else if (row.cells.length) {
    const cells = row.cells;
    const inside = cells.find((cell) => head >= cell.contentFrom && head <= cell.contentTo);
    if (!inside) {
      const owner = cells.find((cell) => head >= cell.from && head <= cell.to)
        ?? (head < cells[0].from ? cells[0] : cells[cells.length - 1]);
      target = head <= owner.contentFrom ? owner.contentFrom : owner.contentTo;
    }
  }
  if (target === head) return tr;
  return [tr, { selection: EditorSelection.single(target), sequential: true }] as const;
}

const cellSnap = EditorState.transactionFilter.of(snapIntoCell);

/** 粘贴进格子：换行压成空格、`|` 转义 —— 否则一次粘贴就把一行拆成好几行 / 好几列。 */
const pasteIntoCell = EditorView.clipboardInputFilter.of((text, state) => {
  const pos = single(state);
  if (pos == null || !cellAt(state, pos)) return text;
  return text.replace(/\r?\n+/g, " ").replace(/(?<!\\)\|/g, "\\|");
});

/* ------------------------------------------------------------ 工具条 */

type TableOp = "rowAbove" | "rowBelow" | "rowDelete" | "colLeft" | "colRight" | "colDelete" | TableAlign;

function cellTexts(state: EditorState, row: Row): string[] {
  return row.cells.map((cell) => state.sliceDoc(cell.from, cell.to).trim());
}

function delimiterFor(align: TableAlign): string {
  return align === "center" ? ":---:" : align === "right" ? "---:" : "---";
}

/**
 * 对整张表做一次结构改动，整张表按规范格式重写一遍（`| a | b |`）。一次事务 ⇒ 一步撤销。
 */
export function applyTableOp(view: EditorView, op: TableOp): boolean {
  const pos = single(view.state);
  const at = pos == null ? null : cellAt(view.state, pos);
  if (!at) return false;
  const { table } = at;
  const state = view.state;
  const grid = table.rows.map((row) => {
    const texts = cellTexts(state, row);
    while (texts.length < table.columns) texts.push("");
    return texts.slice(0, table.columns);
  });
  let aligns = [...table.aligns];
  while (aligns.length < table.columns) aligns.push("left");
  let row = at.row;
  let col = Math.min(at.col, table.columns - 1);
  const blankRow = () => new Array<string>(grid[0].length).fill("");

  switch (op) {
    case "rowAbove":
      if (row <= 1) return true; // 表头上面不能插正文行
      grid.splice(row, 0, blankRow());
      break;
    case "rowBelow":
      row = row === 0 ? 2 : row + 1;
      grid.splice(row, 0, blankRow());
      break;
    case "rowDelete":
      if (row <= 1 || table.rows.length <= 3) return true; // 表头与唯一的正文行留着
      grid.splice(row, 1);
      row = Math.min(row, grid.length - 1);
      break;
    case "colLeft":
    case "colRight": {
      const at2 = op === "colLeft" ? col : col + 1;
      for (const cells of grid) cells.splice(at2, 0, "");
      aligns.splice(at2, 0, "left");
      col = at2;
      break;
    }
    case "colDelete":
      if (grid[0].length <= 1) return true;
      for (const cells of grid) cells.splice(col, 1);
      aligns.splice(col, 1);
      col = Math.min(col, grid[0].length - 1);
      break;
    default:
      aligns[col] = op;
      break;
  }

  const lines = grid.map((cells, i) =>
    i === 1 ? `| ${aligns.map(delimiterFor).join(" | ")} |` : `| ${cells.join(" | ")} |`,
  );
  const text = lines.join("\n");
  const from = table.rows[0].from;
  const to = table.rows[table.rows.length - 1].to;
  // 光标回到同一行同一列的文字末尾
  let offset = 0;
  for (let i = 0; i < row; i += 1) offset += lines[i].length + 1;
  const cells = cellsOf(0, lines[row]);
  const caret = from + offset + (cells[col]?.contentTo ?? 0);
  view.dispatch({ changes: { from, to, insert: text }, selection: { anchor: caret }, userEvent: "input.table" });
  view.focus();
  return true;
}

const TOOLBAR: { op: TableOp; label: string; title: string }[] = [
  { op: "rowAbove", label: "↑行", title: "在上方插入一行" },
  { op: "rowBelow", label: "↓行", title: "在下方插入一行" },
  { op: "rowDelete", label: "删行", title: "删除这一行" },
  { op: "colLeft", label: "←列", title: "在左侧插入一列" },
  { op: "colRight", label: "→列", title: "在右侧插入一列" },
  { op: "colDelete", label: "删列", title: "删除这一列" },
  { op: "left", label: "左", title: "这一列左对齐" },
  { op: "center", label: "中", title: "这一列居中" },
  { op: "right", label: "右", title: "这一列右对齐" },
];

function toolbarFor(state: EditorState): Tooltip | null {
  const pos = single(state);
  const at = pos == null ? null : cellAt(state, pos);
  if (!at) return null;
  return {
    pos: at.table.node.from,
    above: true,
    strictSide: false,
    arrow: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "md-table-tools";
      dom.setAttribute("role", "toolbar");
      dom.setAttribute("aria-label", "表格");
      for (const item of TOOLBAR) {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "md-table-tools__btn";
        button.textContent = item.label;
        button.title = item.title;
        button.addEventListener("mousedown", (event) => event.preventDefault());
        button.addEventListener("click", (event) => {
          event.preventDefault();
          applyTableOp(view, item.op);
        });
        dom.appendChild(button);
      }
      return { dom };
    },
  };
}

const tableToolbar = StateField.define<Tooltip | null>({
  create: toolbarFor,
  update(value, tr) {
    if (!tr.docChanged && !tr.selection && !tr.effects.length) return value;
    const next = toolbarFor(tr.state);
    if (value && next && value.pos === next.pos) return value;
    return next;
  },
  provide: (field) => showTooltip.from(field),
});

export const tableEdit: Extension = [tableKeymap, cellSnap, pasteIntoCell, tableToolbar];
