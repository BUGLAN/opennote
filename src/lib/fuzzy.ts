/** Fuzzy subsequence matching with a bias for word starts and short targets. */

export interface FuzzyMatch {
  score: number;
  ranges: [number, number][];
}

const BOUNDARY = /[\s\-_/.,:;()[\]{}<>·—|"'`~!@#$%^&*+=?\\]/;

export function fuzzyMatch(query: string, target: string): FuzzyMatch | null {
  const q = query.trim().toLowerCase();
  if (!q) return { score: 0, ranges: [] };
  const t = target.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  const ranges: [number, number][] = [];

  for (let qi = 0; qi < q.length; qi += 1) {
    const ch = q[qi];
    if (ch === " ") {
      streak = 0;
      continue;
    }
    let found = -1;
    let bestGap = Infinity;
    for (let i = ti; i < t.length; i += 1) {
      if (t[i] === ch) {
        found = i;
        break;
      }
      // allow a bounded scan so long titles still match quickly
      if (i - ti > 400) break;
      bestGap = Math.min(bestGap, i - ti);
    }
    if (found === -1) return null;
    const isStart = found === 0;
    const isBoundary = found > 0 && BOUNDARY.test(t[found - 1]);
    const isCamel = target[found] !== t[found] && found > 0 && target[found - 1] === target[found - 1]?.toLowerCase();

    score += 10;
    if (isStart) score += 18;
    else if (isBoundary) score += 12;
    else if (isCamel) score += 6;
    if (found === ti) {
      streak += 1;
      score += 6 + streak * 3;
    } else {
      streak = 0;
      score -= Math.min(8, found - ti);
    }

    const previous = ranges[ranges.length - 1];
    if (previous && previous[1] === found) previous[1] = found + 1;
    else ranges.push([found, found + 1]);
    ti = found + 1;
  }

  // Prefer shorter targets and early matches.
  score -= Math.max(0, t.length - q.length) * 0.15;
  return { score: Math.round(score * 100) / 100, ranges };
}

export interface Ranked<T> {
  item: T;
  score: number;
  ranges: [number, number][];
}

/** Rank a list by the best of several candidate strings per item. */
export function fuzzyRank<T>(
  query: string,
  items: T[],
  toCandidates: (item: T) => { text: string; weight: number }[],
  limit = 50,
): Ranked<T>[] {
  const q = query.trim();
  if (!q) return items.slice(0, limit).map((item) => ({ item, score: 0, ranges: [] }));
  const out: Ranked<T>[] = [];
  for (const item of items) {
    let best: Ranked<T> | null = null;
    for (const { text, weight } of toCandidates(item)) {
      const match = fuzzyMatch(q, text);
      if (!match) continue;
      const score = match.score * weight;
      if (!best || score > best.score) best = { item, score, ranges: match.ranges };
    }
    if (best) out.push(best);
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

/** Highlight helper: merge ranges into `[start, end]` pairs safe for slicing. */
export function highlightRanges(text: string, ranges: [number, number][]): { text: string; hit: boolean }[] {
  if (!ranges.length) return [{ text, hit: false }];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const parts: { text: string; hit: boolean }[] = [];
  let cursor = 0;
  for (const [start, end] of sorted) {
    const s = Math.max(cursor, Math.min(start, text.length));
    const e = Math.max(s, Math.min(end, text.length));
    if (s > cursor) parts.push({ text: text.slice(cursor, s), hit: false });
    if (e > s) parts.push({ text: text.slice(s, e), hit: true });
    cursor = e;
  }
  if (cursor < text.length) parts.push({ text: text.slice(cursor), hit: false });
  return parts.length ? parts : [{ text, hit: false }];
}
