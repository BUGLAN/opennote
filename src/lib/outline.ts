import { cleanInline } from "./utils";

export interface Heading {
  level: number;
  text: string;
  /** 1-based line number in the document. */
  line: number;
  /** Character offset of the line start. */
  pos: number;
}

/** Pull the document outline out of the raw markdown, ignoring fenced code. */
export function extractHeadings(markdown: string): Heading[] {
  const headings: Heading[] = [];
  const lines = markdown.split("\n");
  let fenced: string | null = null;
  let pos = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index];
    const fence = /^\s{0,3}(```+|~~~+)/.exec(raw);
    if (fence) {
      const marker = fence[1][0];
      if (fenced === null) fenced = marker;
      else if (fenced === marker) fenced = null;
      pos += raw.length + 1;
      continue;
    }
    if (fenced === null) {
      const match = /^(#{1,6})[ \t]+(.*)$/.exec(raw);
      if (match) {
        const text = cleanInline(match[2]);
        if (text) headings.push({ level: match[1].length, text, line: index + 1, pos });
      }
    }
    pos += raw.length + 1;
  }
  return headings;
}

export function findCurrentHeading(headings: Heading[], cursorPos: number): number {
  let current = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].pos <= cursorPos) current = index;
    else break;
  }
  return current;
}

/** 光标所在行（含）往上最近的那个标题的下标；按行号算，不需要先把行号换成字符偏移。 */
export function findHeadingAtLine(headings: Heading[], line: number): number {
  let current = -1;
  for (let index = 0; index < headings.length; index += 1) {
    if (headings[index].line <= line) current = index;
    else break;
  }
  return current;
}

/**
 * 两份标题列表画成大纲是否一模一样：级别、文字、行号逐项相同。**不比 `pos`** ——
 * 标题上方每敲一个字，下面所有标题的字符偏移都会变，但大纲一个像素都不用动。
 * App 据此沿用上一份数组，大纲（上千个标题时）就不会每键整列重渲染。
 */
export function sameOutline(a: Heading[], b: Heading[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    const x = a[index];
    const y = b[index];
    if (x.line !== y.line || x.level !== y.level || x.text !== y.text) return false;
  }
  return true;
}
