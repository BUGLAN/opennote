/** Domain types for the Opennote library. */

export type Id = string;

export interface Folder {
  id: Id;
  name: string;
  parentId: Id | null;
  createdAt: number;
  updatedAt: number;
}

/**
 * 文件夹树拍平后的一项，给「移动到…」这类**选择器**用。
 *
 * 放在 `data/` 而不是组件里：它是**领域形状**（一棵树的线性化），不是某个控件的私有
 * 类型。这样数据层可以产出它（`folderChoiceList()`），界面层只负责画 —— 反过来的话，
 * 数据层就得认识一个界面模块，依赖方向会倒过来。
 */
export interface FolderChoice {
  /** 工作区相对路径；`null` = 工作区根目录。 */
  id: Id | null;
  /** 单段名字；根项是「笔记本根目录」。 */
  label: string;
  /** 工作区相对路径（根项为空串）。悬浮预览给的是它。 */
  path: string;
  /** 层级，用于缩进。 */
  depth: number;
  /** `true` = 笔记当前所在目录：选中它是空操作，置灰而不是让用户白点一次。 */
  disabled?: boolean;
}

export interface Note {
  id: Id;
  folderId: Id | null;
  /** Denormalised title, kept in sync with the content (or with `titleOverride`). */
  title: string;
  /** Set when the user renames a note from the tree; wins over the derived title. */
  titleOverride: string | null;
  content: string;
  createdAt: number;
  updatedAt: number;
  /** Last time the note was opened in a tab — drives "recent" ordering. */
  openedAt: number;
  starred: boolean;
  tags: string[];
  chars: number;
  words: number;
  trashed: boolean;
  trashedAt: number | null;
}

export type SnapshotReason = "auto" | "manual" | "restore";

export interface Snapshot {
  id: Id;
  noteId: Id;
  title: string;
  content: string;
  createdAt: number;
  reason: SnapshotReason;
}

export interface Asset {
  id: Id;
  name: string;
  mime: string;
  size: number;
  createdAt: number;
  blob: Blob;
}

export type ThemeId = "paper" | "celadon" | "sepia" | "night" | "ink";
export type ThemeKind = "light" | "dark";
export type AccentId = "seal" | "indigo" | "pine" | "gamboge";
export type FontId = "serif" | "sans" | "wenkai" | "mono";
export type WidthId = "narrow" | "normal" | "wide" | "full";
export type SortKey = "updated" | "created" | "title";
export type SidebarTab = "files" | "search" | "tags" | "starred";

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  latin: string;
  kind: ThemeKind;
  hint: string;
}

export const THEMES: ThemeMeta[] = [
  { id: "paper", name: "素笺", latin: "Paper", kind: "light", hint: "暖白纸面，默认" },
  { id: "celadon", name: "青瓷", latin: "Celadon", kind: "light", hint: "冷调青灰" },
  { id: "sepia", name: "琥珀", latin: "Amber", kind: "light", hint: "旧书暖黄" },
  { id: "night", name: "夜读", latin: "Night", kind: "dark", hint: "暖黑，夜里写字" },
  { id: "ink", name: "砚池", latin: "Inkstone", kind: "dark", hint: "冷黑，高对比" },
];

export const ACCENTS: { id: AccentId; name: string; latin: string; swatch: string }[] = [
  { id: "seal", name: "朱砂", latin: "Seal", swatch: "#b23a2e" },
  { id: "indigo", name: "靛青", latin: "Indigo", swatch: "#34558b" },
  { id: "pine", name: "松绿", latin: "Pine", swatch: "#2f6f5e" },
  { id: "gamboge", name: "藤黄", latin: "Gamboge", swatch: "#9a6b12" },
];

export const FONTS: { id: FontId; name: string; hint: string }[] = [
  { id: "serif", name: "衬线", hint: "Newsreader / 宋体，适合阅读" },
  { id: "sans", name: "黑体", hint: "系统无衬线，界面感" },
  { id: "wenkai", name: "文楷", hint: "霞鹜文楷（联网加载，回退楷体）" },
  { id: "mono", name: "等宽", hint: "JetBrains Mono，代码与草稿" },
];

export const WIDTHS: { id: WidthId; name: string }[] = [
  { id: "narrow", name: "窄" },
  { id: "normal", name: "标准" },
  { id: "wide", name: "宽" },
  { id: "full", name: "满幅" },
];

export interface UiSettings {
  /** Active theme id. */
  theme: ThemeId;
  /** Remembered light/dark pair, so the toggle round-trips. */
  appearance: ThemeKind;
  lightTheme: ThemeId;
  darkTheme: ThemeId;
  accent: AccentId;
  font: FontId;
  width: WidthId;
  fontSize: number;
  lineHeight: number;
  typewriter: boolean;
  focus: boolean;
  spellcheck: boolean;
  showWordCount: boolean;
  snapshots: boolean;
  imageMode: "asset" | "inline";
  sidebarOpen: boolean;
  outlineOpen: boolean;
  sidebarTab: SidebarTab;
  sort: SortKey;
  /** Open tabs (note ids, in order) and the active one. */
  tabs: Id[];
  activeId: Id | null;
  /** Folders the user expanded in the tree. */
  expanded: Id[];
  /** Folders the user collapsed while in "expand all" mode — keeps siblings open. */
  collapsed: Id[];
  lastNoteId: Id | null;
  /**
   * 「设置 · 文件 · 导入与接口」里的三项（设计稿 R1/R2/R8）。
   * 只影响本机应用的行为，绝不上传、绝不随笔记同步。
   * `overwrite` **刻意不在枚举里**：常规选项只允许 new/append/skip 与「先进入收件箱」。
   */
  importConflict: ImportConflictPreference;
  /** 入库成功后是否弹提示（关掉后仍写导入日志，只是不打扰）。 */
  importNotify: boolean;
  /** 是否记录 `userData/bridge.log`（关掉后桥照样工作，只是不留痕）。 */
  bridgeLog: boolean;
}

/** R1「导入方式」：外部导入的默认落法。`overwrite` 不在其中，这是有意的。 */
export type ImportConflictPreference = "new" | "append" | "skip" | "inbox";

export const DEFAULT_UI: UiSettings = {
  theme: "paper",
  appearance: "light",
  lightTheme: "paper",
  darkTheme: "night",
  accent: "seal",
  font: "serif",
  width: "normal",
  fontSize: 16.5,
  lineHeight: 1.78,
  typewriter: false,
  focus: false,
  spellcheck: true,
  showWordCount: true,
  snapshots: true,
  imageMode: "asset",
  sidebarOpen: true,
  outlineOpen: false,
  sidebarTab: "files",
  sort: "updated",
  tabs: [],
  activeId: null,
  expanded: [],
  collapsed: [],
  lastNoteId: null,
  // 0.3.0（00 号 §6.14㉕）默认「先进入收件箱」：外部导入先落 `.opennote/inbox/`，
  // 由用户在收件箱里确认落点后再入库。这样任何外部客户端都不可能静默写进笔记库。
  // 改成直接入库仍可（设置 · 文件 · 导入与接口 → R1）。
  importConflict: "inbox",
  importNotify: true,
  bridgeLog: true,
};
