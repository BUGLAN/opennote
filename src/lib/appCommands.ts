import type { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import type { IconName } from "../components/Icons";
import { THEMES, type Id, type ThemeId } from "../data/types";
import { markdownCommands, setHeading, toggleLinePrefix } from "../editor/commands";
import { isApple } from "./utils";

export interface CommandContext {
  view(): EditorView | null;
  hasWorkspace(): boolean;
  newNote(folderId?: Id | null): void;
  newFolder(): void;
  openPalette(mode: "all" | "commands"): void;
  openSearch(): void;
  saveNow(): void;
  closeTab(): void;
  cycleTab(direction: 1 | -1): void;
  toggleSidebar(): void;
  toggleOutline(): void;
  toggleAppearance(): void;
  toggleTypewriter(): void;
  toggleFocus(): void;
  toggleWordCount(): void;
  openSettings(): void;
  openHistory(): void;
  openShortcuts(): void;
  exportNote(kind: "md" | "md-inline" | "html"): void;
  exportLibrary(): void;
  importFiles(): void;
  openWorkspace(): void;
  openLocalFolder(): void;
  newBrowserWorkspace(): void;
  uploadFolder(): void;
  closeWorkspace(): void;
  toggleStar(): void;
  duplicateNote(): void;
  trashNote(): void;
  copyMarkdown(): void;
  printNote(): void;
  setTheme(theme: ThemeId): void;
  notify(message: string): void;
  /** 打开导入收件箱（外部导入的待确认内容）。 */
  openInbox(): void;
  /** 打开「设置 · 导入与接口」，剪藏通道与本地接口都在那一栏。 */
  openImportSettings(): void;
}

export type CommandGroup =
  | "笔记"
  | "笔记本"
  | "导航"
  | "视图"
  | "编辑"
  | "格式"
  | "数据"
  | "外观"
  | "帮助";

export interface AppCommand {
  id: string;
  label: string;
  group: CommandGroup;
  icon: IconName;
  /** Display only — the editor keymap owns these. */
  shortcut?: string;
  /** Global shortcuts handled by the app shell. */
  keys?: string[];
  enabled?(): boolean;
  run(): void;
}

/** `⌘ + K` on Apple platforms, `Ctrl + K` elsewhere. */
export function accel(key: string): string {
  return `${isApple() ? "⌘" : "Ctrl"} + ${key}`;
}

export function buildAppCommands(ctx: CommandContext): AppCommand[] {
  const editorCommand = (
    id: string,
    label: string,
    icon: IconName,
    shortcut: string,
    run: (view: EditorView) => void,
    group: CommandGroup = "格式",
  ): AppCommand => ({
    id,
    label,
    group,
    icon,
    shortcut,
    enabled: () => ctx.view() !== null,
    run: () => {
      const view = ctx.view();
      if (!view) return;
      run(view);
      view.focus();
    },
  });

  return [
    {
      id: "open-workspace",
      label: "切换 / 打开笔记本…",
      group: "笔记本",
      icon: "layers",
      run: () => ctx.openWorkspace(),
    },
    {
      id: "open-local-folder",
      label: "打开本机文件夹…",
      group: "笔记本",
      icon: "folder",
      run: () => ctx.openLocalFolder(),
    },
    {
      id: "new-browser-workspace",
      label: "新建浏览器笔记本…",
      group: "笔记本",
      icon: "plus",
      run: () => ctx.newBrowserWorkspace(),
    },
    {
      id: "upload-folder",
      label: "导入本地文件夹到浏览器…",
      group: "笔记本",
      icon: "upload",
      run: () => ctx.uploadFolder(),
    },
    {
      id: "close-workspace",
      label: "关闭当前笔记本",
      group: "笔记本",
      icon: "close",
      enabled: () => ctx.hasWorkspace(),
      run: () => ctx.closeWorkspace(),
    },
    {
      id: "new-note",
      label: "新建笔记",
      group: "笔记",
      icon: "plus",
      shortcut: accel("N"),
      keys: ["mod+n"],
      enabled: () => ctx.hasWorkspace(),
      run: () => ctx.newNote(),
    },
    {
      id: "new-folder",
      label: "新建文件夹",
      group: "笔记",
      icon: "folder",
      shortcut: `${accel("Shift")} + N`,
      keys: ["mod+shift+n"],
      run: () => ctx.newFolder(),
    },
    { id: "duplicate", label: "创建副本", group: "笔记", icon: "copy", run: () => ctx.duplicateNote() },
    { id: "star", label: "加星标 / 取消星标", group: "笔记", icon: "star", run: () => ctx.toggleStar() },
    {
      id: "trash",
      label: "移到回收站",
      group: "笔记",
      icon: "trash",
      run: () => ctx.trashNote(),
    },

    {
      id: "palette",
      label: "命令面板",
      group: "导航",
      icon: "command",
      shortcut: accel("K"),
      keys: ["mod+k", "alt+k"],
      run: () => ctx.openPalette("all"),
    },
    {
      id: "palette-commands",
      label: "命令面板：只看命令",
      group: "导航",
      icon: "command",
      shortcut: `${accel("Shift")} + P`,
      keys: ["mod+shift+p"],
      run: () => ctx.openPalette("commands"),
    },
    {
      id: "search",
      label: "搜索全部笔记",
      group: "导航",
      icon: "search",
      shortcut: `${accel("Shift")} + F`,
      keys: ["mod+shift+f"],
      run: () => ctx.openSearch(),
    },
    {
      id: "next-tab",
      label: "下一个标签",
      group: "导航",
      icon: "chevronRight",
      shortcut: "Alt + →",
      keys: ["alt+arrowright", "mod+alt+arrowright"],
      run: () => ctx.cycleTab(1),
    },
    {
      id: "prev-tab",
      label: "上一个标签",
      group: "导航",
      icon: "chevronLeft",
      shortcut: "Alt + ←",
      keys: ["alt+arrowleft", "mod+alt+arrowleft"],
      run: () => ctx.cycleTab(-1),
    },
    {
      id: "close-tab",
      label: "关闭当前标签",
      group: "导航",
      icon: "close",
      shortcut: "Alt + W",
      keys: ["alt+w", "mod+w", "mod+alt+w"],
      run: () => ctx.closeTab(),
    },

    {
      id: "toggle-sidebar",
      label: "折叠 / 展开侧栏",
      group: "视图",
      icon: "sidebar",
      shortcut: `${accel("\\")}`,
      keys: ["mod+\\"],
      run: () => ctx.toggleSidebar(),
    },
    {
      id: "toggle-outline",
      label: "显示 / 隐藏大纲",
      group: "视图",
      icon: "outline",
      shortcut: `${accel("Shift")} + O`,
      keys: ["mod+shift+o", "alt+o"],
      run: () => ctx.toggleOutline(),
    },
    {
      id: "typewriter",
      label: "打字机模式",
      group: "视图",
      icon: "typewriter",
      shortcut: `${accel("Shift")} + Y`,
      keys: ["mod+shift+y", "alt+y"],
      run: () => ctx.toggleTypewriter(),
    },
    {
      id: "focus",
      label: "专注模式",
      group: "视图",
      icon: "focus",
      shortcut: `${accel("Shift")} + D`,
      keys: ["mod+shift+d", "alt+d"],
      run: () => ctx.toggleFocus(),
    },
    {
      id: "word-count",
      label: "显示 / 隐藏字数统计",
      group: "视图",
      icon: "hash",
      run: () => ctx.toggleWordCount(),
    },

    {
      id: "open-inbox",
      label: "打开导入收件箱",
      group: "数据",
      icon: "download",
      run: () => ctx.openInbox(),
    },
    {
      id: "open-import-settings",
      label: "导入与接口设置",
      group: "数据",
      icon: "layers",
      run: () => ctx.openImportSettings(),
    },

    editorCommand("undo", "撤销", "rotate", accel("Z"), (view) => void undo(view), "编辑"),
    editorCommand("redo", "重做", "rotate", `${accel("Shift")} + Z`, (view) => void redo(view), "编辑"),
    editorCommand(
      "select-all",
      "全选当前笔记",
      "check",
      accel("A"),
      (view) => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
      },
      "编辑",
    ),
    editorCommand("bold", "加粗", "edit", accel("B"), markdownCommands.bold),
    editorCommand("italic", "斜体", "edit", accel("I"), markdownCommands.italic),
    editorCommand("inline-code", "行内代码", "edit", accel("E"), markdownCommands.inlineCode),
    editorCommand("link", "插入链接", "link", `${accel("Shift")} + K`, markdownCommands.link),
    editorCommand("strike", "删除线", "edit", `${accel("Shift")} + X`, markdownCommands.strike),
    editorCommand("highlight", "高亮", "edit", `${accel("Shift")} + H`, markdownCommands.highlight),
    editorCommand("h1", "一级标题", "outline", `${accel("1")}`, setHeading(1)),
    editorCommand("h2", "二级标题", "outline", `${accel("2")}`, setHeading(2)),
    editorCommand("h3", "三级标题", "outline", `${accel("3")}`, setHeading(3)),
    editorCommand("bullet", "无序列表", "outline", `${accel("Shift")} + 8`, toggleLinePrefix("bullet")),
    editorCommand("ordered", "有序列表", "outline", `${accel("Shift")} + 7`, toggleLinePrefix("ordered")),
    editorCommand("task", "任务列表", "outline", `${accel("Shift")} + 9`, toggleLinePrefix("task")),
    editorCommand("quote", "引用", "outline", `${accel("Shift")} + Q`, toggleLinePrefix("quote")),
    editorCommand("code-block", "代码块", "edit", `${accel("Shift")} + C`, markdownCommands.codeBlock),
    editorCommand("table", "表格", "edit", `${accel("Shift")} + T`, markdownCommands.table),
    editorCommand("math", "公式块", "edit", `${accel("Shift")} + M`, markdownCommands.mathBlock),
    editorCommand("mermaid", "图表", "edit", `${accel("Shift")} + G`, markdownCommands.mermaid),
    editorCommand("hr", "分割线", "edit", "", markdownCommands.hr),
    editorCommand("wiki-link", "笔记链接", "link", "", markdownCommands.wikiLink),
    editorCommand("clear-format", "清除格式", "edit", "", markdownCommands.clearFormatting),
    {
      id: "copy-markdown",
      label: "复制为 Markdown",
      group: "格式",
      icon: "copy",
      run: () => ctx.copyMarkdown(),
    },

    {
      id: "save",
      label: "立即保存",
      group: "数据",
      icon: "download",
      shortcut: accel("S"),
      keys: ["mod+s"],
      run: () => ctx.saveNow(),
    },
    {
      id: "export-md",
      label: "导出当前笔记为 Markdown",
      group: "数据",
      icon: "download",
      shortcut: `${accel("Shift")} + E`,
      keys: ["mod+shift+e"],
      run: () => ctx.exportNote("md"),
    },
    {
      id: "export-md-inline",
      label: "导出当前笔记（图片内嵌，单文件）",
      group: "数据",
      icon: "image",
      run: () => ctx.exportNote("md-inline"),
    },
    { id: "export-html", label: "导出当前笔记为独立 HTML", group: "数据", icon: "external", run: () => ctx.exportNote("html") },
    {
      id: "print",
      label: "打印 / 导出 PDF",
      group: "数据",
      icon: "print",
      shortcut: accel("P"),
      // `mod+alt+p` is the escape hatch for browsers that keep Ctrl/⌘+P for
      // themselves (D19) — both run the app's own print styles.
      keys: ["mod+p", "mod+alt+p"],
      run: () => ctx.printNote(),
    },
    {
      id: "export-zip",
      label: "导出整库备份（zip）",
      group: "数据",
      icon: "layers",
      enabled: () => ctx.hasWorkspace(),
      run: () => ctx.exportLibrary(),
    },
    {
      id: "import",
      label: "导入文件到当前文件夹…",
      group: "数据",
      icon: "upload",
      enabled: () => ctx.hasWorkspace(),
      run: () => ctx.importFiles(),
    },
    { id: "history", label: "查看历史版本", group: "数据", icon: "clock", run: () => ctx.openHistory() },

    {
      id: "appearance",
      label: "切换亮色 / 暗色",
      group: "外观",
      icon: "moon",
      shortcut: `${accel("Alt")} + T`,
      keys: ["mod+alt+t", "alt+t"],
      run: () => ctx.toggleAppearance(),
    },
    ...THEMES.map<AppCommand>((theme) => ({
      id: `theme-${theme.id}`,
      label: `主题：${theme.name} ${theme.latin}`,
      group: "外观",
      icon: theme.kind === "dark" ? "moon" : "sun",
      run: () => ctx.setTheme(theme.id),
    })),
    { id: "settings", label: "设置", group: "外观", icon: "settings", shortcut: accel(","), keys: ["mod+,"], run: () => ctx.openSettings() },

    {
      id: "shortcuts",
      label: "键盘快捷键",
      group: "帮助",
      icon: "keyboard",
      shortcut: accel("/"),
      keys: ["mod+/"],
      run: () => ctx.openShortcuts(),
    },
  ];
}

/* --------------------------------------------------------------- matching */

const SHIFTED_SYMBOLS: Record<string, string> = {
  "&": "7",
  "*": "8",
  "(": "9",
  ")": "0",
  "!": "1",
  "@": "2",
  "#": "3",
  $: "4",
  "%": "5",
  "^": "6",
  _: "-",
  "+": "=",
  "{": "[",
  "}": "]",
  "|": "\\",
  ":": ";",
  '"': "'",
  "<": ",",
  ">": ".",
  "?": "/",
};

function eventKeyName(event: KeyboardEvent): string {
  const raw = event.key;
  if (raw === " ") return "space";
  if (raw.length === 1) {
    if (event.shiftKey && SHIFTED_SYMBOLS[raw]) return SHIFTED_SYMBOLS[raw];
    return raw.toLowerCase();
  }
  return raw.toLowerCase();
}

export function matchesShortcut(event: KeyboardEvent, spec: string): boolean {
  const parts = spec.toLowerCase().split("+").map((part) => part.trim());
  const key = parts[parts.length - 1];
  const wantsMod = parts.includes("mod");
  const wantsCtrl = parts.includes("ctrl");
  const wantsShift = parts.includes("shift");
  const wantsAlt = parts.includes("alt");
  const mod = isApple() ? event.metaKey : event.ctrlKey;
  if (wantsMod !== mod) return false;
  if (wantsCtrl && !event.ctrlKey) return false;
  if (wantsShift !== event.shiftKey) return false;
  if (wantsAlt !== event.altKey) return false;
  // a bare `alt+w` must not fire while the platform modifier is held for something else
  if (!wantsMod && !wantsCtrl && (isApple() ? event.metaKey : event.ctrlKey) && !wantsAlt) return false;
  return eventKeyName(event) === key;
}

export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
}
