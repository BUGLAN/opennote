/**
 * 行级差异 + 「仅格式不同」判定（冲突界面与自动跳过共用一份）。
 *
 * ## 为什么单独成文件
 *
 * 两件事都只跟**文本**有关，跟网络、磁盘、账本无关，所以它们必须是纯函数 ——
 * 冲突判定错了会毁数据，而纯函数是唯一能用用例钉死的东西。
 *
 * ## 「仅格式不同」到底包含什么
 *
 * 只包含**看不见、也不改变语义**的差异：
 * - BOM（`\uFEFF`）：Windows 记事本会加，编辑器不会；
 * - 换行符 CRLF / CR / LF；
 * - 文件末尾多一个或少一个换行。
 *
 * **不包含**行尾空格（Markdown 里两个空格是硬换行，有语义）、不包含缩进、
 * 不包含任何空白折叠 —— 那些是内容，不是格式。
 */

/**
 * 严格解码 UTF-8：不是合法文本（图片、压缩包）就返回 `null`。
 *
 * 冲突界面靠它区分「两份文本」与「两个二进制」—— 后者不该拿去画 diff。
 */
export function decodeText(bytes: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** 去掉 UTF-8 BOM。 */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 换行符归一（CRLF / CR → LF）。 */
export function normalizeNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** 只做「格式归一」：BOM + 换行符 + 末尾空行。 */
export function normalizeFormatting(text: string): string {
  return normalizeNewlines(stripBom(text)).replace(/\n+$/, "");
}

/**
 * 两份文本是否**仅格式不同**（内容逐字相同）。
 *
 * 命中就按「已经同步好了」处理：静默跳过、不进冲突列表。
 * 前提是**下游会把两边收敛成同一份字节** —— 否则下一轮又会撞成冲突，
 * 变成永远消不掉的噪音。
 */
export function isSameUpToFormatting(a: string, b: string): boolean {
  if (a === b) return true;
  return normalizeFormatting(a) === normalizeFormatting(b);
}

/** 一行差异（`same` 两边都有；`del` 只在本地；`add` 只在远端）。 */
export interface DiffRow {
  kind: "same" | "add" | "del";
  text: string;
}

/** 超过这个行数就不做 LCS（O(n·m) 会卡住界面），退化成「整篇替换」。 */
export const DIFF_MAX_LINES = 2000;

/**
 * 行级 diff（LCS）。
 *
 * 参数顺序有意义：`local` 是**本机**那一份，`remote` 是**远端**那一份，
 * 于是 `del` = 本机有、远端没有；`add` = 远端有、本机没有。
 * 界面上的「用我的 / 用远端」就是照这个方向念的。
 */
export function diffLines(local: string, remote: string): DiffRow[] {
  const left = normalizeNewlines(stripBom(local)).split("\n");
  const right = normalizeNewlines(stripBom(remote)).split("\n");

  if (left.length > DIFF_MAX_LINES || right.length > DIFF_MAX_LINES) {
    // 太大：不做逐行对齐，直接「我的全部删掉、远端全部加上」。
    return [
      ...left.map((text) => ({ kind: "del" as const, text })),
      ...right.map((text) => ({ kind: "add" as const, text })),
    ];
  }

  const n = left.length;
  const m = right.length;
  // lcs[i][j] = left[i..] 与 right[j..] 的最长公共子序列长度。
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      lcs[i]![j] = left[i] === right[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }

  const rows: DiffRow[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (left[i] === right[j]) {
      rows.push({ kind: "same", text: left[i]! });
      i += 1;
      j += 1;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      rows.push({ kind: "del", text: left[i]! });
      i += 1;
    } else {
      rows.push({ kind: "add", text: right[j]! });
      j += 1;
    }
  }
  while (i < n) { rows.push({ kind: "del", text: left[i]! }); i += 1; }
  while (j < m) { rows.push({ kind: "add", text: right[j]! }); j += 1; }
  return rows;
}

/** 改动行数（界面上的「差 3 行」就是 `added + removed`）。 */
export function diffStats(rows: DiffRow[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.kind === "add") added += 1;
    else if (row.kind === "del") removed += 1;
  }
  return { added, removed };
}
