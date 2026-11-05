/**
 * 按键行为的**无头**测试夹具。
 *
 * 为什么不直接调某个命令：一次按键真正走的是「所有 keymap 按优先级排好、依次尝试，
 * 第一个返回 true 的赢」。单测一个命令测不出**谁先抢到这次按键**——排查报告里好几条
 * 缺陷（标题开头按退格、表格里回车）恰恰出在顺序上：markdown 自带的键位是 `Prec.high`，
 * 会排在我们自己的 unwrap 键位前面。
 *
 * 所以这里用 `buildEditorExtensions()` 建出**和真实编辑器同一套扩展**，再从
 * `state.facet(keymap)` 里按真实优先级顺序取绑定、依次执行。没有 DOM：命令拿到的是一个
 * 只有 `state` / `dispatch` / `focus` 的假视图，依赖排版的命令（方向键）不在这里测，
 * 那一类放在 `pnpm verify:geometry` 的真实浏览器探针里。
 */
import { ensureSyntaxTree } from "@codemirror/language";
import { EditorSelection, EditorState, Transaction, type TransactionSpec } from "@codemirror/state";
import { keymap, type EditorView, type KeyBinding } from "@codemirror/view";
import { buildEditorExtensions, type EditorHooks } from "../setup";
import { setEditorSettings, type EditorSettings } from "../settings";

export interface KeyKit {
  readonly state: EditorState;
  readonly view: EditorView;
  /** 按一次键（CodeMirror 的键名写法：`Enter`、`Mod-b`、`Shift-Tab`）。返回是否有绑定处理了它。 */
  press(key: string): boolean;
  /** 像输入法/键盘那样在光标处打字（userEvent `input.type`）。 */
  type(text: string): void;
  /** 文档 + 光标，`‸` 表示光标，`[`…`]` 表示选区。 */
  show(): string;
}

function hooks(settings: Partial<EditorSettings>): EditorHooks {
  return {
    settings,
    getTitles: () => ["笔记"],
    getTags: () => [],
    readOnly: () => false,
    onChange: () => {},
    onCursor: () => {},
    onSave: () => {},
    notify: () => {},
    imageMode: () => "asset",
  };
}

/** 光标记号。不用 `|`：表格源码里到处是竖线。 */
export const CARET = "‸";

const MODS = ["Alt", "Ctrl", "Meta", "Shift"] as const;

/** `Shift-Mod-k` / `Mod-Shift-k` → `Ctrl-Shift-k`（node 里不是 mac，Mod = Ctrl）。 */
function normalize(name: string): string {
  const parts = name.split(/-(?!$)/);
  const key = parts.pop() ?? "";
  const mods = new Set(parts.map((part) => (part === "Mod" || part === "Cmd" ? "Ctrl" : part)));
  return [...MODS.filter((mod) => mods.has(mod)), key].join("-");
}

function bindingKey(binding: KeyBinding): string | undefined {
  return binding.linux ?? binding.key;
}

/**
 * 用 `‸` / `[[[…]]]` 标出光标或选区写文档：`"## ‸标题"` 就是光标停在「标题」前面。
 */
export function parseMarked(marked: string): { doc: string; selection: EditorSelection } {
  const caret = marked.indexOf(CARET);
  if (caret >= 0) {
    return { doc: marked.slice(0, caret) + marked.slice(caret + CARET.length), selection: EditorSelection.single(caret) };
  }
  const open = marked.indexOf("[[[");
  if (open >= 0) {
    const close = marked.indexOf("]]]", open);
    const doc = marked.slice(0, open) + marked.slice(open + 3, close) + marked.slice(close + 3);
    return { doc, selection: EditorSelection.single(open, close - 3) };
  }
  return { doc: marked, selection: EditorSelection.single(marked.length) };
}

/**
 * 建一个夹具。光标位置用 `‸` 标在文档里；选区用 `[[[` … `]]]` 包起来
 * （不用单个方括号，因为 markdown 正文里到处都是 `[`）。
 */
export function keyKit(marked: string, settings: Partial<EditorSettings> = {}): KeyKit {
  const { doc, selection } = parseMarked(marked);
  let state = EditorState.create({ doc, selection, extensions: buildEditorExtensions(hooks(settings)) });
  if (Object.keys(settings).length) state = state.update({ effects: setEditorSettings.of(settings) }).state;

  const settle = () => {
    ensureSyntaxTree(state, state.doc.length, 5000);
    // 一个「只改选区」的事务让装饰字段按完整的树重算（见 livePreview.test.ts 的 settled）
    state = state.update({ selection: state.selection }).state;
  };
  settle();

  const view = {
    get state() {
      return state;
    },
    dispatch(...specs: (TransactionSpec | Transaction)[]) {
      const first = specs[0];
      state = first instanceof Transaction ? first.state : state.update(...(specs as TransactionSpec[])).state;
      settle();
    },
    focus() {},
    composing: false,
    hasFocus: true,
  } as unknown as EditorView;

  return {
    get state() {
      return state;
    },
    view,
    press(key: string) {
      const wanted = normalize(key);
      const withoutShift = wanted.replace(/(^|-)Shift-/, "$1");
      for (const bindings of state.facet(keymap)) {
        for (const binding of bindings) {
          const name = bindingKey(binding);
          if (!name || binding.scope && !binding.scope.split(" ").includes("editor")) continue;
          const normalized = normalize(name);
          let run = normalized === wanted ? binding.run : undefined;
          if (!run && binding.shift && wanted !== withoutShift && normalized === withoutShift) run = binding.shift;
          if (run && run(view)) return true;
        }
      }
      return false;
    },
    type(text: string) {
      view.dispatch(state.replaceSelection(text), { userEvent: "input.type", scrollIntoView: true });
    },
    show() {
      const range = state.selection.main;
      const text = state.doc.toString();
      if (range.empty) return text.slice(0, range.head) + CARET + text.slice(range.head);
      return text.slice(0, range.from) + "[[[" + text.slice(range.from, range.to) + "]]]" + text.slice(range.to);
    },
  };
}
