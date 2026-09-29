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
