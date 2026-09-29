/** Small, dependency-free helpers shared across the app. */

export function uid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function cn(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function debounce<A extends unknown[]>(fn: (...args: A) => void, wait: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const wrapped = (...args: A) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      fn(...args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  wrapped.flush = (...args: A) => {
    wrapped.cancel();
    fn(...args);
  };
  return wrapped;
}

export function normalizeEol(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ------------------------------------------------------------------ titles */

const TITLE_LIMIT = 90;

/** Front matter is metadata, never a title. */
export function splitFrontMatter(md: string): { front: string; body: string } {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(md);
  if (!match) return { front: "", body: md };
  return { front: match[1], body: md.slice(match[0].length) };
}

/** Typora-style title: the first heading, else the first non-empty line. */
export function deriveTitle(md: string, fallback = "无标题"): string {
  const { body } = splitFrontMatter(md);
  let fence: string | null = null;
  for (const rawLine of body.split("\n")) {
    const line = rawLine.trim();
    const fenceMatch = /^(```+|~~~+)/.exec(line);
    if (fenceMatch) {
      const marker = fenceMatch[1][0];
      if (fence === null) fence = marker;
      else if (fence === marker) fence = null;
      continue;
    }
    if (fence !== null) continue;
    if (!line) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const text = cleanInline(heading[2]);
      if (text) return text.slice(0, TITLE_LIMIT);
      continue;
    }
    if (/^(>|\||-{3,}|\*{3,}|_{3,})/.test(line)) continue;
    const text = cleanInline(line);
    if (text) return text.slice(0, TITLE_LIMIT);
  }
  return fallback;
}

/** Strip inline markdown syntax so a line reads as plain text. */
export function cleanInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/==(.*?)==/g, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Markdown → plain text, used for excerpts, search hits and word counts. */
export function stripMarkdown(md: string): string {
  const { body } = splitFrontMatter(md);
  return body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/~~~[\s\S]*?~~~/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(#{1,6})\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s{0,3}([-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/gm, " ")
    .replace(/[*_~`]/g, "")
    .replace(/\|/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

export function excerpt(md: string, limit = 120): string {
  const text = stripMarkdown(splitFrontMatter(md).body).replace(/\n+/g, " ");
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/* -------------------------------------------------------------------- tags */

/** Tags come from front matter `tags:` and from inline `#tag` tokens. */
export function deriveTags(md: string): string[] {
  const tags = new Set<string>();
  const { front, body } = splitFrontMatter(md);
  if (front) {
    const inline = /^tags:\s*\[(.*)\]\s*$/im.exec(front);
    if (inline) {
      for (const part of inline[1].split(",")) {
        const tag = normalizeTag(part);
        if (tag) tags.add(tag);
      }
    } else {
      const block = /^tags:\s*$\n((?:[ \t]*-[ \t]*.+\n?)+)/im.exec(front);
      if (block) {
        for (const line of block[1].split("\n")) {
          const tag = normalizeTag(line.replace(/^[ \t]*-[ \t]*/, ""));
          if (tag) tags.add(tag);
        }
      }
    }
  }
  // Inline tags: `#tag` must not be a heading (`# `) nor a URL fragment.
  const re = /(^|[\s(（[【>])#([\p{L}\p{N}][\p{L}\p{N}_\-/]{0,31})/gu;
  let match: RegExpExecArray | null;
  const scan = stripFencedCode(body);
  while ((match = re.exec(scan))) {
    const tag = normalizeTag(match[2]);
    if (tag) tags.add(tag);
  }
  return [...tags].sort((a, b) => a.localeCompare(b, "zh-Hans-CN"));
}

function normalizeTag(raw: string): string {
  const tag = raw.trim().replace(/^#/, "").replace(/["']/g, "").trim();
  if (!tag || /^\d+$/.test(tag)) return "";
  return tag.slice(0, 32);
}

export function stripFencedCode(md: string): string {
  return md.replace(/^([ \t]*)(```|~~~)[\s\S]*?^\1?\2[^\n]*$/gm, "");
}

/* --------------------------------------------------------------- counting */

export interface Counts {
  chars: number;
  words: number;
  cjk: number;
  minutes: number;
}

/** Mixed CJK/latin counting — what a Chinese writer expects from a word count. */
export function countText(md: string): Counts {
  const text = stripMarkdown(md).replace(/\s+/g, " ").trim();
  const cjk = (text.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g) ?? [])
    .length;
  const latin = (text.replace(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/g, " ").match(/[A-Za-z0-9'’\-]+/g) ?? [])
    .length;
  const words = latin + cjk;
  return { chars: text.replace(/\s/g, "").length, words, cjk, minutes: Math.max(1, Math.round(words / 300)) };
}

/* -------------------------------------------------------------- formatting */

export function formatRelativeTime(ts: number, now = Date.now()): string {
  const diff = now - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "刚刚";
  if (diff < hour) return `${Math.floor(diff / min)} 分钟前`;
  if (diff < day) return `${Math.floor(diff / hour)} 小时前`;
  const date = new Date(ts);
  const today = new Date(now);
  const yesterday = new Date(now - day);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (sameDay(date, today)) return `今天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (sameDay(date, yesterday)) return `昨天 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  if (date.getFullYear() === today.getFullYear()) return `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function formatDateTime(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Filesystem-safe name that keeps CJK characters readable. */
export function safeFileName(name: string, fallback = "untitled"): string {
  const cleaned = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^[.\s]+|[.\s]+$/g, "")
    .trim();
  return (cleaned || fallback).slice(0, 80);
}

export function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  let i = 2;
  while (taken.has(`${base} ${i}${ext}`)) i += 1;
  return `${base} ${i}${ext}`;
}

/* ------------------------------------------------------------------- misc */

export const isMac =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);

/** ⌘ on Apple platforms, Ctrl elsewhere. */
export function modKey(): string {
  return isMac ? "⌘" : "Ctrl";
}

export function isApple(): boolean {
  return isMac;
}

export function download(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsText(file);
  });
}

export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(reader.error ?? new Error("读取文件失败"));
    reader.readAsDataURL(blob);
  });
}

export async function dataUrlToBlob(dataUrl: string): Promise<Blob> {
  const response = await fetch(dataUrl);
  return response.blob();
}

export function nextTick(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
