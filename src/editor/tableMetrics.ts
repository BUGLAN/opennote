/**
 * 渲染态表格的**列宽**，以及表格行/单元格的解析。
 *
 * 表格在编辑时的观感要跟渲染态**一模一样**——列宽、边框、表头底色、对齐，
 * 一处都不能变。列宽只有一个可靠来源：已经渲染出来的真 `<table>`
 * （`widgets.ts` 的 `TableWidget` 量一次 `th/td` 的 `getBoundingClientRect().width`）。
 *
 * ## 为什么键不是整张表的原文
 *
 * 键用**表头行 + 分隔行**（`tableMetricKey`），不是整张表。
 *
 * 用户正在单元格里打字时，整张表的原文**每一帧都在变**；若按原文做键，
 * 每敲一个字都会「查不到列宽 → 退回估算 → 列宽跳一下」。而表头行与分隔行
 * 在改正文时不变化，于是整个编辑过程列宽稳定（这也正是 Typora 的手感）。
 * 改表头时的一次重新测量是可以接受的，改正文时的抖动不可接受。
 */
const WIDTHS_CAP = 512;

/** 一列的两条实测数据，单位 px。 */
export interface TableColumn {
  /** 列的**边界间距**：相邻两格左边线之差（最后一列到表格右边线）。直接拿它当 grid 轨道宽度。 */
  track: number;
  /** 渲染态里这一格**内容盒**的宽度。编辑态必须和它逐像素相同，断行才会一致。 */
  content: number;
}

const widths = new Map<string, readonly TableColumn[]>();

/**
 * 按**列数**存的最近一份列宽，兜底用。
 *
 * 场景：正在改表头/分隔行 ⇒ `tableMetricKey` 变了、精确键查不到。若此时退回
 * 「按内容长度给 fr 权重」，表格会**在打字过程中突然拉满整行宽**（实测 51px 列
 * 变成 179px 列）。改成「沿用上一次量到的、列数相同的列宽」，编辑期间列宽就冻结了
 * —— 这正是 Typora 的手感：改字不会重排整张表。列数相同的另一张表被借用了列宽时，
 * 只影响尚未测量过的那一瞬间，等它下次以渲染态出现就会重新量。
 */
const byColumns = new Map<number, readonly TableColumn[]>();

/** 行内一段范围（相对行首的偏移）。 */
export interface TableCellRange {
  from: number;
  to: number;
}

/** 一行表格源码切出来的竖线位置与单元格范围（都相对行首）。 */
export interface TableRowSplit {
  /** 每个 `|` 的偏移。 */
  pipes: number[];
  /** 每个单元格的**内容**范围（不含竖线，含两端空白，调用方自己裁）。 */
  cells: TableCellRange[];
  /**
   * 覆盖整行的**分段**：从「行首或竖线」到「下一根竖线或行尾」，首尾相接、没有缝。
   *
   * 编辑态用这个而不是 `cells`：每段（含行首竖线与两侧空白）整体包成一个
   * `md-tcell`，竖线就落在格子**内部**，不会变成额外的 grid 项。
   */ 
  segments: TableCellRange[];
}

export type TableAlign = "left" | "center" | "right";

/**
 * 表格的「身份」：表头行 + 分隔行。
 *
 * 正文单元格改字不影响它，所以编辑期间不会换键；两张表头与分隔行都相同的表
 * 会共用一份列宽——同宽的两张表本来就没有区别，可以接受。
 */
export function tableMetricKey(source: string): string {
  const nl = source.indexOf("\n");
  if (nl < 0) return source;
  const nl2 = source.indexOf("\n", nl + 1);
  return nl2 < 0 ? source : source.slice(0, nl2);
}

/** 记住一份实测列宽（单位 px，含单元格的内边距与边框）。 */
export function rememberTableWidths(key: string, next: readonly TableColumn[]): void {
  if (!key || next.length === 0) return;
  if (!next.every((col) => Number.isFinite(col.track) && col.track > 0 && Number.isFinite(col.content) && col.content > 0)) return;
  widths.set(key, next);
  byColumns.set(next.length, next);
  if (widths.size > WIDTHS_CAP) {
    const oldest = widths.keys().next();
    if (!oldest.done) widths.delete(oldest.value);
  }
}

/** 这一列宽量过吗。没量过时调用方退回按内容长度估算。 */
export function tableWidthsFor(key: string): readonly TableColumn[] | null {
  return widths.get(key) ?? null;
}

/** 最近一次量到的、同样列数的列宽（精确键失配时的兜底，见 `byColumns`）。 */
export function lastTableWidths(columns: number): readonly TableColumn[] | null {
  return byColumns.get(columns) ?? null;
}

/**
 * 把一行表格源码切成单元格。
 *
 * 刻意**不用语法树**：`| a |  | c |` 里的空格子不产生 `TableCell` 节点、
 * 行尾的 `|` 又可以省略——按字符切才对得上每个人的写法。`\|` 是单元格里的
 * 转义竖线，跳过。
 */
export function splitTableRow(text: string): TableRowSplit {
  const pipes: number[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] === "|") pipes.push(i);
  }
  const bounds = [-1, ...pipes, text.length];
  const cells: TableCellRange[] = [];
  for (let i = 0; i < bounds.length - 1; i += 1) {
    const left = bounds[i];
    const right = bounds[i + 1];
    const from = left + 1;
    const to = right;
    if (to < from) continue;
    if (to === from) {
      // 零宽段只在「两个竖线之间」才算一个空单元格；
      // 行首 `|` 之前、行尾 `|` 之后都没有格子。
      if (left === -1 || right === text.length) continue;
    }
    cells.push({ from, to });
  }
  // 行首那个竖线之前如果只有空白（表格行被缩进了），那点空白不是一格 ——
  // 算进去会让这一行比表头多出一列，整张表的网格列数对不上渲染态。
  const starts = pipes.length > 0 && text.slice(0, pipes[0]).trim() === "" ? pipes.slice() : [0, ...pipes];
  const segments: TableCellRange[] = starts.map((start, i) => ({
    from: start,
    to: starts[i + 1] ?? text.length,
  }));
  // 行尾「只剩一根竖线」的那一段并进前一格：那是收尾的竖线，不是新的一格。
  while (segments.length > 1) {
    const last = segments[segments.length - 1];
    if (text.slice(last.from, last.to).replace(/\|/g, "").trim().length > 0) break;
    segments[segments.length - 2].to = last.to;
    segments.pop();
  }
  return { pipes, cells, segments };
}

/** 分隔行（`| --- | :---: |`）→ 每列的对齐方式。 */
export function parseTableAlignments(delimiterRow: string): TableAlign[] {
  return splitTableRow(delimiterRow).cells.map(({ from, to }) => {
    const token = delimiterRow.slice(from, to).trim();
    if (token.startsWith(":") && token.endsWith(":")) return "center";
    if (token.endsWith(":")) return "right";
    return "left";
  });
}

/** @internal 单测用：清空记忆表（模块级单例，用例之间需要干净起点）。 */
export function clearTableWidths(): void {
  widths.clear();
  byColumns.clear();
}
