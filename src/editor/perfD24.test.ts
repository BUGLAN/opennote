/**
 * D24 benchmark harness (skipped unless D24_BENCH=1).
 *
 *   $env:D24_BENCH=1; npx vitest run src/editor/perfD24.test.ts
 *
 * It drives real EditorState transactions (the same code path the browser runs
 * inside `view.dispatch`) over a 135.8k character / 13.5k line document and
 * reports:
 *   - the full rebuild cost at several document sizes (the justification for
 *     FULL_REBUILD_LENGTH)
 *   - "insert one character" and "move the selection only" latency on the big
 *     document, 10 measured rounds after 3 warm-up rounds
 *   - the reference cost of a full rebuild on the same big document
 *
 * The browser numbers (real Chromium, real view) are produced by
 * %TEMP%\opennote-d24\browser-perf-d24.mjs — see the task report.
 */
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { FULL_REBUILD_LENGTH, livePreviewDecorations, livePreviewField } from "./livePreview";
import { markdownSupport } from "./markdown";
import { editorSettings } from "./settings";

const enabled = process.env.D24_BENCH === "1";
const RUNS = 10;

/** Same generator the browser harness uses: ≈88 characters per block, 9 lines. */
function benchDoc(blocks: number): string {
  const parts: string[] = [];
  for (let i = 0; i < blocks; i += 1) {
    parts.push(`## 标题 ${i}`, "", `一段包含 **粗体**、*斜体*、==高亮==、\`代码\`、$a+b$ 与 [[链接${i}]] 的正文。`, "");
    parts.push("- 列表项一", "- [ ] 任务项", "", "> 引用一行", "");
  }
  return parts.join("\n");
}

function stateFor(doc: string, anchor = 0): EditorState {
  return EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdownSupport, editorSettings({}), livePreviewField],
  });
}

/**
 * A state with no view parses lazily (a few hundred characters at a time), so a
 * headless measurement on a fresh state would only exercise a small prefix of
 * the document. Force the whole document through the parser first: the language
 * field picks the finished tree up on the next transaction.
 */
function fullyParsed(state: EditorState): EditorState {
  ensureSyntaxTree(state, state.doc.length, 60_000);
  return state
    .update({ changes: { from: 0, insert: " " } })
    .state.update({ changes: { from: 0, to: 1, insert: "" } }).state;
}

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const round = (x: number) => Math.round(x * 1000) / 1000;
  return {
    runs: values.map(round),
    min: round(sorted[0]),
    median: round(sorted[Math.floor(sorted.length / 2)]),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    max: round(sorted[sorted.length - 1]),
  };
}

function bench(action: () => void, runs = RUNS): number[] {
  for (let i = 0; i < 3; i += 1) action();
  const out: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const start = performance.now();
    action();
    out.push(performance.now() - start);
  }
  return out;
}

describe.skipIf(!enabled)("D24 性能（D24_BENCH=1 时运行）", () => {
  it("reports full rebuild cost by document size", () => {
    const rows: unknown[] = [];
    for (const blocks of [50, 100, 200, 400, 1500]) {
      const doc = benchDoc(blocks);
      let state = fullyParsed(stateFor(doc));
      const replace = bench(() => {
        state = state.update({ changes: { from: 0, to: state.doc.length, insert: doc } }).state;
      }, 3);
      // decoration pass only — no parsing, no view: this is what the threshold buys
      const decorate = bench(() => {
        livePreviewDecorations(state);
      }, 3);
      rows.push({
        blocks,
        chars: doc.length,
        lines: state.doc.lines,
        decorations: state.field(livePreviewField).set.size,
        replaceWholeDocMs: stats(replace),
        decorateOnlyMs: stats(decorate),
        msPerKChar: Math.round((decorate[Math.floor(decorate.length / 2)] / doc.length) * 1000 * 1000) / 1000,
      });
    }
    console.log("全量重建成本（按文档大小）:", JSON.stringify(rows, null, 1));
    expect(FULL_REBUILD_LENGTH).toBeGreaterThan(0);
  });

  it("reports insert / selection latency on the 135.8k document", () => {
    const doc = benchDoc(1500);
    const lines = stateFor(doc).doc.lines;
    let state = fullyParsed(stateFor(doc, Math.floor(doc.length / 2)));
    const middle = Math.floor(doc.length / 2);
    const decorations = state.field(livePreviewField).set.size;

    const insert = bench(() => {
      state = state.update({ changes: { from: middle, insert: "x" } }).state;
      state = state.update({ changes: { from: middle, to: middle + 1, insert: "" } }).state;
    });

    const move = bench(() => {
      state = state.update({ selection: { anchor: Math.floor(state.doc.length / 3) } }).state;
    });

    // reference: what a full rebuild of the same document costs
    const full = bench(() => {
      livePreviewDecorations(state);
    }, 3);

    console.log(
      "D24 135.8k 文档:",
      JSON.stringify(
        {
          chars: state.doc.length,
          lines,
          decorations,
          insert1CharMs: stats(insert),
          moveSelectionMs: stats(move),
          fullRebuildReferenceMs: stats(full),
        },
        null,
        1,
      ),
    );
    expect(state.doc.length).toBeGreaterThan(130_000);
  });
});
