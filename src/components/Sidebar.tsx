import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  childFolders,
  collapseFolder,
  deleteFolder,
  descendantFolderIds,
  emptyTrash,
  expandFolder,
  folderChoiceList,
  folderPathLabel,
  folderStats,
  getLibrary,
  moveFolder,
  moveNote,
  notesInFolder,
  purgeNote,
  renameFolder,
  renameNote,
  restoreNote,
  revealNoteInTree,
  searchNotes,
  treeFilterFor,
  setStarred,
  starredNotes,
  tagTree,
  trashNote,
  type LibraryState,
  type TagTreeNode,
} from "../data/library";
import type { EntryOptions } from "../data/entryOptions";
import { noteKind, type Folder, type Id, type Note, type SidebarSections, type UiSettings } from "../data/types";
import { getUi, patchUi, themeKind } from "../data/ui";
import type { WorkspaceRecord } from "../data/workspaces";
import { isCapacitorNative } from "../fs";
import { askConfirm, askFolder, askText } from "../lib/dialogs";
import { copyPathToClipboard, noteAbsolutePath } from "../lib/notePath";
import { sealIconUrl } from "../lib/sealIcon";
import { notify } from "../lib/toast";
import type { UpdateAction, UpdateView } from "../lib/updateView";
import { cn, excerpt, formatRelativeTime } from "../lib/utils";
import { Icon, type IconName } from "./Icons";
import { openMenu, type MenuItem } from "./Overlays";

export type SidebarTab = "files" | "search" | "tags" | "starred" | "trash";

/**
 * 侧栏实际画哪一页：文件树（星标 / 文件夹 / 标签三个分区都在这一页里）或回收站。
 * 旧的 `"search"` / `"tags"` / `"starred"` 页签已经并进分区列表，读到它们按「文件」画。
 */
type SidebarView = "files" | "trash";
function viewOf(tab: SidebarTab): SidebarView {
  return tab === "trash" ? "trash" : "files";
}

/*
 * 常驻搜索框的句柄（模块级）：「搜索全部笔记」（Ctrl/⌘ + Shift + F）从 App 那边要把焦点
 * 落进这个框，而它不再藏在某个页签后面 —— 侧栏只有一个，挂一份引用就够了。
 */
let searchInputHandle: HTMLInputElement | null = null;

/** 把焦点放进侧栏顶部的搜索框（侧栏刚展开时等一帧，等它可见）。 */
export function focusSidebarSearch(): void {
  requestAnimationFrame(() => {
    searchInputHandle?.focus();
    searchInputHandle?.select();
  });
}

export type Scope =
  | { kind: "all" }
  | { kind: "folder"; id: Id }
  | { kind: "starred" }
  | { kind: "trash" }
  | { kind: "tag"; tag: string };

export interface SidebarProps {
  library: LibraryState;
  ui: UiSettings;
  scope: Scope;
  tab: SidebarTab;
  activeId: Id | null;
  workspace: WorkspaceRecord | null;
  workspaces: WorkspaceRecord[];
  switcherOpen: boolean;
  /**
   * 这个形态能提供哪些笔记本入口：桌面版有磁盘可写，浏览器那两项整条不出现
   * （判断在 `data/entryOptions.ts`，与欢迎页、命令面板共用）。
   */
  entries: EntryOptions;
  onSwitcherOpen(open: boolean): void;
  onOpenWorkspace(record: WorkspaceRecord): void;
  onAddLocalFolder(): void;
  onNewBrowserWorkspace(): void;
  onUploadFolder(): void;
  /** 从 GitHub 仓库导入（网页版专属）。`null` = 这个形态不支持，菜单项整个不渲染。 */
  onImportGithub: (() => void) | null;
  onCloseWorkspace(): void;
  onScope(scope: Scope): void;
  onTab(tab: SidebarTab): void;
  onOpenNote(id: Id): void;
  onNewNote(folderId?: Id | null): void;
  onNewCanvas(folderId?: Id | null): void;
  onNewFolder(parentId?: Id | null): void;
  /**
   * 头部那个「收起 / 展开」按钮。**必须是切换**：收起后头部仍然留在原地
   * （这正是它存在的意义），按钮得能把侧栏再叫回来。
   */
  onToggleSidebar(): void;
  /** 待确认的收件箱条目数（0 时不显示计数）。 */
  inboxPending: number;
  onOpenInbox(): void;
  /**
   * 桌面端自更新的图标状态（由 `src/lib/updateView.ts` 从主进程状态推出）。
   * `visible:false` 时这里**一个像素都不占** —— 「有更新才出现」是这个功能的原话。
   */
  updateView: UpdateView;
  onUpdateAction(action: UpdateAction): void;
}

/**
 * 每深一层缩进多少。行首不再有单独的展开箭头（文件夹 / `#` 图标自己就是开合记号），
 * 所以比以前的 13px 多给 3px，层级仍然一眼看得出。
 */
const TREE_INDENT = 16;

/** Drag state lives outside React: it only matters between two native events. */
let dragPayload: { kind: "note" | "folder"; id: Id } | null = null;

export function currentFolderId(scope: Scope): Id | null {
  return scope.kind === "folder" ? scope.id : null;
}

export function Sidebar(rawProps: SidebarProps): ReactNode {
  /*
   * `onOpenNote` 换成一个**引用稳定**、内部总是调最新回调的版本：App 每次渲染都递来新的
   * 箭头函数，而 App 每敲一个字都会渲染一次 —— 不稳定的话 memo 过的 `NoteRow` 全部失效，
   * 1000 篇笔记的展开树每键白重渲染 ~8ms（生产构建实测）。
   */
  const onOpenNoteRef = useRef(rawProps.onOpenNote);
  onOpenNoteRef.current = rawProps.onOpenNote;
  const openNote = useCallback((id: Id) => onOpenNoteRef.current(id), []);
  const props: SidebarProps = { ...rawProps, onOpenNote: openNote };
  const { library, ui, scope, tab, activeId } = props;
  const view = viewOf(tab);
  const [query, setQuery] = useState("");
  const searching = query.trim() !== "";
  const sections = ui.sidebarSections;
  const toggleSection = (key: keyof SidebarSections): void => {
    patchUi({ sidebarSections: { ...getUi().sidebarSections, [key]: !getUi().sidebarSections[key] } });
  };
  /*
   * 旧页签的兼容：命令面板跳到某个标签时仍然 `setTab("tags")`，旧的 state.json 里也可能存着
   * `"tags"` / `"starred"` / `"search"`。现在它们都不是单独一页了 —— 展开对应分区、回到文件页。
   */
  useEffect(() => {
    if (tab !== "tags" && tab !== "starred" && tab !== "search") return;
    const key = tab === "tags" ? "tags" : tab === "starred" ? "starred" : null;
    if (key && !getUi().sidebarSections[key]) patchUi({ sidebarSections: { ...getUi().sidebarSections, [key]: true } });
    props.onTab("files");
  }, [tab]);
  const openTrash = (): void => {
    props.onTab("trash");
    props.onScope({ kind: "trash" });
  };
  const closeTrash = (): void => {
    props.onTab("files");
    if (scope.kind === "trash") props.onScope({ kind: "all" });
  };
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const counts = useMemo(() => {
    const notes = Object.values(library.notes);
    return {
      all: notes.length,
      starred: notes.filter((note) => note.starred).length,
      trash: Object.keys(library.trash).length,
    };
  }, [library.notes, library.trash]);

  /*
   * 「新建到哪儿」= 文件夹行那枚 `is-current` 记号的**唯一**含义。那枚记号是故意做弱的
   * （没有底色，因为它不是选中态 —— 见 `app.css` 的 `.tree__row.is-current`），
   * 所以同一件事在这里再写一遍：鼠标停在「新建」上就能读到落点的完整路径。
   */
  const createTarget = currentFolderId(scope);
  const createWhere = folderPathLabel(createTarget, library.folders);

  /*
   * 搜索走**同一棵树 + 一个可见集合**（用户原话「直接使用原来的那一份加个筛选就行了」）：
   * 集合由 `treeFilterFor()` 算（命中笔记 + 祖先目录 + 文件夹名命中），
   * 树本身（`TreeBody`/`FolderBranch`）一行都没改样式 —— 目录行照旧能展开能收缩。
   * 设置里关掉「搜索时显示文件夹」时走平铺的结果列表（`SearchBody`）。
   */
  const searchFilter = useMemo(
    () => (query.trim() && ui.searchFolders ? treeFilterFor(query) : null),
    [library, query, ui.searchFolders],
  );

  const handleDrop = (folderId: Id | null) => {
    const payload = dragPayload;
    dragPayload = null;
    setDropTarget(null);
    if (!payload) return;
    if (payload.kind === "note") {
      void moveNoteWithFeedback(payload.id, folderId);
      return;
    }
    if (folderId === payload.id) return;
    if (folderId && descendantFolderIds(payload.id, library.folders).includes(folderId)) {
      notify("不能把文件夹移动到它自己的子目录里", { kind: "danger" });
      return;
    }
    moveFolder(payload.id, folderId);
  };

  return (
    /*
     * 头部与身体是**两个并排的栅格项**（`.app` 里分别是第 1 行与第 2 行的第 1 列），
     * 所以这里返回 fragment 而不是一个 `<aside>` 包住两者：
     * 收起时只有身体消失，头部留在顶行（和标签栏同一行），左上角那个「展开」按钮
     * 才不会被一起收走。见 `app.css` 的 `.sidebar__head` / `.sidebar.is-collapsed`。
     */
    <>
      <div className="sidebar__head">
        <div className="sidebar__brand">
          <img
            className="sidebar__logo"
            src={sealIconUrl(ui.accent, themeKind(ui.theme))}
            alt=""
            width={22}
            height={22}
            aria-hidden="true"
          />
          {/*
            笔记本名就是头部的标题，点它切换笔记本。以前它在身体最上面单独占一整行（一个带边框的
            下拉框），而笔记本打开之后几乎不换 —— 那一行的位置让给了常驻的搜索框。
          */}
          <button
            type="button"
            className="sidebar__notebook"
            aria-haspopup="menu"
            aria-expanded={props.switcherOpen}
            onClick={() => props.onSwitcherOpen(!props.switcherOpen)}
            title={props.workspace ? `${workspaceLocation(props.workspace)} · 点击切换笔记本` : "打开或新建笔记本"}
          >
            <span className="sidebar__name">{props.workspace?.name ?? "Opennote"}</span>
            <Icon name="chevronDown" size={12} className="sidebar__notebook-caret" />
          </button>
        </div>
        <div className="sidebar__actions">
          {/*
            自更新入口：位置就是需求图里那个红框（`.sidebar__brand` 与「新建」之间）。
            - 只在「有更新 / 正在下载 / 待重启 / 用户主动检查后失败」时出现（`visible`）；
            - 颜色用 `--accent`，与旁边 `--ink-2` 的普通图标一眼可分；
            - 文案、图标、可点行为全部来自 `updateViewFor()`，这里不自己判断状态。
          */}
          {props.updateView.visible ? (
            <button
              type="button"
              className={cn("icon-btn", "icon-btn--update", props.updateView.tone === "accent" && "is-accent")}
              title={props.updateView.title}
              aria-label={props.updateView.title}
              disabled={props.updateView.action === null}
              onClick={() => {
                if (props.updateView.action) props.onUpdateAction(props.updateView.action);
              }}
            >
              <Icon name={props.updateView.icon} />
              {props.updateView.ring !== null ? (
                <span className="icon-btn__ring" aria-hidden="true">
                  <svg viewBox="0 0 26 26" width={26} height={26}>
                    {/* 进度弧：周长 2πr ≈ 56.5（r=9），dashoffset 按百分比推进 */}
                    <circle className="icon-btn__ring-track" cx="13" cy="13" r="9" />
                    <circle
                      className="icon-btn__ring-value"
                      cx="13"
                      cy="13"
                      r="9"
                      strokeDasharray="56.5"
                      strokeDashoffset={56.5 * (1 - props.updateView.ring / 100)}
                    />
                  </svg>
                </span>
              ) : null}
            </button>
          ) : null}
          <button
            className="icon-btn"
            title={`新建笔记 (Ctrl/⌘ + N) · 将建在「${createWhere}」`}
            onClick={() => props.onNewNote(createTarget)}
          >
            <Icon name="plus" />
          </button>
          <button
            className="icon-btn"
            title={`新建文件夹 (Ctrl/⌘ + Shift + N) · 将建在「${createWhere}」`}
            onClick={() => props.onNewFolder(createTarget)}
          >
            <Icon name="folder" />
          </button>
          <button
            className="icon-btn"
            title={ui.sidebarOpen ? "收起侧栏 (Ctrl/⌘ + \\)" : "展开侧栏 (Ctrl/⌘ + \\)"}
            aria-expanded={ui.sidebarOpen}
            onClick={props.onToggleSidebar}
          >
            <Icon name="sidebar" />
          </button>
        </div>
        {props.switcherOpen ? (
          <div className="workspace__menu" role="menu">
            {props.workspaces.length ? <div className="tree__group">笔记本</div> : null}
            {props.workspaces.map((record) => (
              <button
                key={record.id}
                type="button"
                className={cn("menu__item", record.id === props.workspace?.id && "is-active")}
                onClick={() => {
                  props.onSwitcherOpen(false);
                  props.onOpenWorkspace(record);
                }}
              >
                <Icon name={record.kind === "node" || record.kind === "capacitor" ? "folder" : "layers"} size={14} />
                <span className="truncate">{record.name}</span>
              </button>
            ))}
            {props.workspaces.length ? <div className="menu__sep" /> : null}
            <button type="button" className="menu__item" disabled={!props.entries.localFolder} onClick={props.onAddLocalFolder}>
              <Icon name="folder" size={14} />
              <span>
                {isCapacitorNative()
                  ? "新建手机笔记本…"
                  : props.entries.localFolder
                    ? "打开本机文件夹…"
                    : "本机文件夹（需 Chrome/Edge 或桌面版）"}
              </span>
            </button>
            {/* 浏览器专属的两条：桌面版整条不渲染 —— 那里有磁盘可写（见 `data/entryOptions.ts`）。 */}
            {props.entries.browserWorkspace ? (
              <button type="button" className="menu__item" onClick={props.onNewBrowserWorkspace}>
                <Icon name="plus" size={14} />
                <span>新建浏览器笔记本…</span>
              </button>
            ) : null}
            {props.entries.uploadFolder ? (
              <button type="button" className="menu__item" onClick={props.onUploadFolder}>
                <Icon name="upload" size={14} />
                <span>导入文件夹到浏览器…</span>
              </button>
            ) : null}
            {/*
              从 GitHub 仓库导入（0.4.0）：**只有网页版**能看见这一项 —— 桌面版的 CSP 里没有
              api.github.com（`electron/main.cjs` 的 `cspPolicy()` 是 `connect-src 'self' file:`），
              而镜像落在 OPFS 里。传 null 就是不支持，按钮整个不渲染（不留死元素）。
            */}
            {props.onImportGithub ? (
              <button type="button" className="menu__item" onClick={props.onImportGithub}>
                <Icon name="download" size={14} />
                <span>从 GitHub 仓库导入…</span>
              </button>
            ) : null}
            {props.workspace ? (
              <>
                <div className="menu__sep" />
                <button type="button" className="menu__item is-danger" onClick={props.onCloseWorkspace}>
                  <Icon name="close" size={14} />
                  <span>关闭「{props.workspace.name}」</span>
                </button>
              </>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 收起时 inert：窄屏抽屉只是平移到屏幕外，不加的话 Tab 仍会走进看不见的树里。 */}
      <aside className={cn("sidebar", !ui.sidebarOpen && "is-collapsed")} inert={!ui.sidebarOpen}>
        {/*
          ★ 常驻搜索框：在滚动区**外面**，文件树滑到多深它都在原地。
          搜的是笔记（标题 / 标签 / 正文 / 文件夹名），同时筛标签；有词时下面只显示结果。
        */}
        <div className="sidebar__search">
          <input
            ref={(element) => {
              searchInputRef.current = element;
              searchInputHandle = element;
            }}
            className="field field--search"
            type="search"
            value={query}
            placeholder="搜索笔记…"
            aria-label="搜索笔记"
            onChange={(event) => {
              setQuery(event.target.value);
              if (view !== "files" && event.target.value.trim()) props.onTab("files");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>

        <div className="sidebar__body">
          {view === "trash" ? (
            <>
              <button type="button" className="sidebar__back" onClick={closeTrash}>
                <Icon name="chevronLeft" size={13} />
                <span>回收站</span>
                {counts.trash > 0 ? <span className="tree__meta">{counts.trash}</span> : null}
              </button>
              <div className="tree">
                <TrashList library={library} onOpen={props.onOpenNote} />
              </div>
            </>
          ) : searching ? (
            <>
              {props.ui.searchFolders ? (
                searchFilter && searchFilter.notes.size === 0 && searchFilter.folders.size === 0 ? (
                  <p className="tree__empty">没有找到包含「{query.trim()}」的笔记或文件夹。</p>
                ) : (
                  <TreeBody
                    {...props}
                    dropTarget={dropTarget}
                    setDropTarget={setDropTarget}
                    onDropOn={handleDrop}
                    filter={searchFilter}
                  />
                )
              ) : (
                <SearchBody query={query} activeId={activeId} onOpen={props.onOpenNote} showFolders={false} />
              )}
              <TagsBody
                library={library}
                ui={ui}
                scope={scope}
                activeId={activeId}
                filter={query}
                onScope={props.onScope}
                onOpen={props.onOpenNote}
                asSearchResult
              />
            </>
          ) : (
            <>
              {/*
                ★ 「分区列表」（照 Notion / Bear 的做法）：没有页签，整条侧栏只有「图标 + 名字 + 数量」
                这一种行，加几行灰色小字的分区标题。星标与收件箱放在最上面（不用滑到树底下找），
                文件夹与标签是两个可折叠分区，回收站钉在底部。
              */}
              <NavRow
                icon="star"
                label="星标"
                count={counts.starred}
                open={sections.starred}
                onClick={() => toggleSection("starred")}
              />
              {sections.starred ? (
                <div className="tree">
                  {starredNotes(library).length ? (
                    starredNotes(library).map((note) => (
                      <NoteRow
                        key={note.id}
                        note={note}
                        depth={1}
                        dirty={Boolean(library.dirty[note.id])}
                        active={activeId === note.id}
                        onOpen={props.onOpenNote}
                        dnd={false}
                      />
                    ))
                  ) : (
                    <p className="sidebar__hint">还没有星标笔记。右键笔记即可加星标。</p>
                  )}
                </div>
              ) : null}
              <NavRow icon="download" label="收件箱" count={props.inboxPending} onClick={() => props.onOpenInbox()} />

              <SectionHeader
                label="文件夹"
                open={sections.folders}
                onToggle={() => toggleSection("folders")}
                action={{ title: `新建文件夹 · 将建在「${createWhere}」`, onClick: () => props.onNewFolder(createTarget) }}
              />
              {sections.folders ? (
                <TreeBody
                  {...props}
                  dropTarget={dropTarget}
                  setDropTarget={setDropTarget}
                  onDropOn={handleDrop}
                  filter={null}
                />
              ) : null}

              <SectionHeader label="标签" open={sections.tags} onToggle={() => toggleSection("tags")} />
              {sections.tags ? (
                <TagsBody
                  library={library}
                  ui={ui}
                  scope={scope}
                  activeId={activeId}
                  filter=""
                  onScope={props.onScope}
                  onOpen={props.onOpenNote}
                />
              ) : null}
            </>
          )}
        </div>

        {/* 回收站钉在底部：低频、但要随时找得到（与 Notion 同一个位置）。 */}
        <div className="sidebar__pinned">
          <NavRow icon="trash" label="回收站" count={counts.trash} active={view === "trash"} onClick={() => (view === "trash" ? closeTrash() : openTrash())} />
        </div>

        {/* 脚注不再放「设置」按钮：状态栏最右那颗是同一个图标、同一个动作
            （2026-10-10 用户反馈「这里的设置图标就不用了，右边有相同的图标」）。
            随之退场的还有动作位 `.sidebar__foot-actions` 与它那条「22px 行盒」的护栏。 */}
        <footer className="sidebar__foot">
          <Icon name="shield" size={13} />
          <span title={props.workspace ? workspaceLocation(props.workspace) : undefined}>
            {counts.all} 篇笔记
          </span>
        </footer>
      </aside>
    </>
  );
}

/**
 * 侧栏里的一条入口（星标 / 收件箱 / 回收站）：和文件树的行同一套样子 —— 图标 + 名字 + 数量。
 * 传了 `open` 就是可展开的（星标），图标和文件夹一样兼作开合记号。
 */
function NavRow({
  icon,
  label,
  count,
  open,
  active = false,
  onClick,
}: {
  icon: IconName;
  label: string;
  count: number;
  open?: boolean;
  active?: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      className={cn("tree__row", "sidebar__nav", active && "is-current")}
      aria-expanded={open}
      aria-current={active ? "true" : undefined}
      style={{ paddingLeft: 6 }}
      onClick={onClick}
    >
      <span className={cn("tree__icon", open !== undefined && "tree__icon--toggle", open && "is-open")}>
        <Icon name={icon} size={14} filled={icon === "star" && open === true} />
      </span>
      <span className="tree__label">{label}</span>
      {count > 0 ? <span className="tree__meta">{count}</span> : null}
    </button>
  );
}

/**
 * 分区标题（文件夹 / 标签）：一行灰色小字，点它整块折叠。
 * 右侧的动作按钮（「新建文件夹」）平时淡出，悬停分区标题时才出现 —— 与 Notion 的分区一样。
 */
function SectionHeader({
  label,
  open,
  onToggle,
  action,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  action?: { title: string; onClick: () => void };
}): ReactNode {
  return (
    <div className="sidebar__section">
      <button type="button" className="sidebar__section-toggle" aria-expanded={open} onClick={onToggle}>
        <span>{label}</span>
        <Icon name="chevronRight" size={11} className={cn("sidebar__section-caret", open && "is-open")} />
      </button>
      {action ? (
        <button type="button" className="icon-btn sidebar__section-action" title={action.title} aria-label={action.title} onClick={action.onClick}>
          <Icon name="plus" size={13} />
        </button>
      ) : null}
    </div>
  );
}

/**
 * 文件行的图标按**种类**分：Markdown 笔记、HTML 页面、画布各一张，扫一眼就知道点开是什么
 * （以前三种都是同一张「笔记」图）。种类判据与编辑器同一份（`noteKind`）。
 */
function noteIcon(note: Pick<Note, "kind">): IconName {
  const kind = noteKind(note);
  if (kind === "html") return "code";
  if (kind === "canvas") return "canvas";
  return "note";
}

function workspaceLocation(record: WorkspaceRecord): string {
  if (record.kind === "node") return `本机磁盘 · ${record.location}`;
  if (record.kind === "fsa") return `浏览器文件夹 · ${record.name}`;
  if (record.kind === "capacitor") return `手机文件夹 · Documents/OpenNote/${record.name}`;
  return `浏览器本地存储 · ${record.name}`;
}

/* =============================== tree body ============================== */

/**
 * 过滤（搜索 / 筛选）时树里可见的东西：命中的笔记 + 要显示的目录（含祖先）。
 * `null` = 不过滤（渲染整棵树）。集合由 `treeFilterFor()` 算，组件只负责「照它渲染」。
 */
export interface TreeFilter {
  notes: Set<Id>;
  folders: Set<Id>;
}

interface TreeProps extends SidebarProps {
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
  onDropOn: (folderId: Id | null) => void;
  /** 有值时只渲染可见集合里的笔记与目录（搜索 / 筛选）；目录行仍是树上那一行（可展开可收缩）。 */
  filter?: TreeFilter | null;
}

function TreeBody(props: TreeProps): ReactNode {
  const { library, ui, activeId } = props;
  const filter = props.filter ?? null;
  const roots = childFolders(library, null).filter((folder) => !filter || filter.folders.has(folder.id));
  const loose = notesInFolder(library, null, { sort: ui.sort }).filter((note) => !filter || filter.notes.has(note.id));

  const dropZoneProps = (key: string, folderId: Id | null) => ({
    onDragOver: (event: React.DragEvent) => {
      if (!dragPayload) return;
      event.preventDefault();
      event.stopPropagation();
      props.setDropTarget(key);
    },
    onDrop: (event: React.DragEvent) => {
      event.preventDefault();
      event.stopPropagation();
      void folderId;
      props.onDropOn(folderId);
    },
  });

  return (
    <div className={cn("tree", props.dropTarget === "root" && "is-drop")} {...dropZoneProps("root", null)}>
      {/*
       * 这里原本有一行 `全部笔记 {counts.all}`。删掉它：它不是筛选项，而是一个**什么也不筛**的
       * 高亮行 —— 文件树本身就把所有笔记都摊在这里了，点它只是把 scope 设回 `all`，
       * 让「当前文件夹」变回空。真正需要「新建到哪里」的行为由文件夹行承担：那行挂
       * `is-current` 记号（左侧强调条 + 强调色图标，**没有底色**，见 `app.css`），
       * 而不是选中态 —— 整棵树里的选中底色只属于编辑器里打开的那篇笔记。
       * 整棵树的空白处依旧是拖到根目录的投放区（见上面的 `dropZoneProps("root", null)`）。
       */}
      {/* 「文件夹」这几个字由分区标题说（`SectionHeader`）；树里只在有散放笔记时标一行「未归档」。 */}
      {roots.map((folder) => (
        <FolderBranch key={folder.id} folder={folder} depth={0} {...props} dropZoneProps={dropZoneProps} />
      ))}

      {loose.length ? (
        <>
          {roots.length ? <div className="tree__group">未归档</div> : null}
          {loose.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              depth={0}
              dirty={Boolean(library.dirty[note.id])}
              active={activeId === note.id}
              onOpen={props.onOpenNote}
              dropTarget={props.dropTarget}
              setDropTarget={props.setDropTarget}
            />
          ))}
        </>
      ) : null}

      {!filter && !roots.length && !loose.length ? (
        <p className="tree__empty">
          这个文件夹里还没有 Markdown 文件。
          <br />
          按 Ctrl/⌘ + N 写下第一篇。
        </p>
      ) : null}

    </div>
  );
}

interface BranchProps extends TreeProps {
  folder: Folder;
  depth: number;
  dropZoneProps: (key: string, folderId: Id | null) => Record<string, unknown>;
}

function FolderBranch({ folder, depth, dropZoneProps, ...props }: BranchProps): ReactNode {
  const { library, ui, scope, activeId } = props;
  const filter = props.filter ?? null;
  // 过滤时：只留可见集合里的子目录与笔记（祖先目录由 `treeFilterFor` 一并放进集合）。
  const children = childFolders(library, folder.id).filter((child) => !filter || filter.folders.has(child.id));
  const notes = notesInFolder(library, folder.id, { sort: ui.sort }).filter((note) => !filter || filter.notes.has(note.id));
  const hasChildren = children.length > 0 || notes.length > 0;
  /*
   * 过滤时**默认展开**：命中路径要一眼看得见（否则用户还得一层层点开才知道结果在哪）。
   * 但**仍然可以手动收起** —— 复用现成的 `ui.collapsed` 列表：`expandFolder/collapseFolder`
   * 两个动作原样生效，目录行的 caret 也是树上那一枚（这是上一版手写行样式缺的东西）。
   */
  const open = filter ? !ui.collapsed.includes(folder.id) : ui.expanded.includes(folder.id);
  const stats = folderStats(library, folder.id);
  /*
   * 文件夹行不是「选中」那一行 —— 它承载的是「新建笔记的落点」（`scope`），
   * 所以走 `is-current`（左侧强调条 + 强调色图标，**没有底色**），
   * 把整棵树里唯一的选中底色（`is-active`）留给编辑器里打开的那篇笔记。
   * 两件事以前共用 `is-active`，看起来就是「文件夹和笔记被同时选中了」。
   */
  const current = scope.kind === "folder" && scope.id === folder.id;

  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={false}
        aria-current={current ? "true" : undefined}
        draggable
        className={cn("tree__row", current && "is-current", props.dropTarget === `folder:${folder.id}` && "is-drop")}
        style={{ paddingLeft: 6 + depth * TREE_INDENT }}
        onClick={() => {
          props.onScope({ kind: "folder", id: folder.id });
          if (open) collapseFolder(folder.id);
          else expandFolder(folder.id);
        }}
        onKeyDown={(event) => {
          // The row itself is the tree item; the inner "more" button owns its own keys.
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          props.onScope({ kind: "folder", id: folder.id });
          if (open) collapseFolder(folder.id);
          else expandFolder(folder.id);
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          openMenu(event.clientX, event.clientY, folderMenu(folder, props));
        }}
        onDragStart={() => {
          dragPayload = { kind: "folder", id: folder.id };
        }}
        onDragEnd={() => {
          dragPayload = null;
          props.setDropTarget(null);
        }}
        {...dropZoneProps(`folder:${folder.id}`, folder.id)}
      >
        {/*
          没有单独的展开箭头：文件夹图标本身就是开合的记号（合上 / 打开两张图，切换时轻轻一弹），
          以前「箭头 + 文件夹图标」两样东西说的是同一件事。
        */}
        <span className={cn("tree__icon", "tree__icon--toggle", open && "is-open")}>
          <Icon name={open ? "folderOpen" : "folder"} size={14} />
        </span>
        <span className="tree__label">{folder.name}</span>
        <span className="tree__extra">
          <button
            type="button"
            className="icon-btn"
            style={{ width: 20, height: 20 }}
            title="更多"
            onClick={(event) => {
              event.stopPropagation();
              const rect = (event.target as HTMLElement).getBoundingClientRect();
              openMenu(rect.left, rect.bottom, folderMenu(folder, props));
            }}
          >
            <Icon name="more" size={13} />
          </button>
        </span>
        {!open && stats.notes ? <span className="tree__meta">{stats.notes}</span> : null}
      </div>

      {open ? (
        <>
          {children.map((child) => (
            <FolderBranch key={child.id} folder={child} depth={depth + 1} dropZoneProps={dropZoneProps} {...props} />
          ))}
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              depth={depth + 1}
              dirty={Boolean(library.dirty[note.id])}
              active={activeId === note.id}
              onOpen={props.onOpenNote}
              dropTarget={props.dropTarget}
              setDropTarget={props.setDropTarget}
            />
          ))}
        </>
      ) : null}
    </>
  );
}

function folderMenu(folder: Folder, props: SidebarProps): MenuItem[] {
  return [
    { id: "new-note", label: "在此新建笔记", icon: "plus", run: () => props.onNewNote(folder.id) },
    { id: "new-canvas", label: "在此新建画布", icon: "plus", run: () => props.onNewCanvas(folder.id) },
    { id: "new-folder", label: "新建子文件夹", icon: "folder", run: () => props.onNewFolder(folder.id) },
    {
      id: "rename",
      label: "重命名",
      icon: "edit",
      run: async () => {
        const name = await askText({ title: "重命名文件夹", value: folder.name, label: "文件夹名称" });
        if (name) renameFolder(folder.id, name);
      },
    },
    {
      id: "copy-path",
      label: "复制地址",
      icon: "link",
      separatorBefore: true,
      // 浏览器 / OPFS 笔记本没有本机绝对路径（见 `lib/notePath.ts`）：禁用而不是
      // 给一个点了没反应的死菜单项。文件夹的 id 也是工作区相对路径，所以同一份推导。
      disabled: noteAbsolutePath(props.workspace, folder.id) === null,
      run: () => void copyPathToClipboard(props.workspace, folder.id),
    },
    {
      id: "delete",
      label: "删除文件夹",
      icon: "trash",
      danger: true,
      separatorBefore: true,
      run: async () => {
        const mode = await askConfirm({
          title: `删除「${folder.name}」？`,
          message: "文件夹里的笔记可以一起放进回收站，也可以移到上一层保留。",
          confirmLabel: "连同笔记一起删除",
          cancelLabel: "只删文件夹",
          danger: true,
        });
        await deleteFolder(folder.id, mode ? "trash" : "promote");
        notify(mode ? "文件夹与笔记已移入回收站" : "文件夹已删除，笔记已上移");
      },
    },
  ];
}

/* =============================== note row =============================== */

/**
 * 移动一篇笔记并**如实报告结果** —— 右键菜单与拖放共用这一份。
 *
 * 图片是这条流程里**唯一可能悄悄出错**的部分：`moveNote()` 会连带把按笔记名派生的
 * `<笔记名>.assets/` 搬过去（用户原话「从收件箱移动到其他位置时，图片位置也应改变」），
 * 但目标目录里已经有一个同名 `.assets/` 时它**不覆盖**、把图留在原地。笔记这时候
 * 已经在新位置了，所以不能只说「移动失败」——那会让用户以为笔记没动。
 *
 * `announce` 区分两条调用路径的**既有**行为，而不是让它们变得一样：
 * - 右键「移动到…」→ `true`：用户是在一个可能有重名单段名的列表里选的，必须回一句
 *   「移到了完整路径的哪个目录」才算确认，顺便给撤销；
 * - 拖放 → `false`：笔记在树里当场挪了位置，用户**看得见**结果，再来一条 toast 只是噪音
 *   （拖放从来不发成功提示，这里不改它）。
 *
 * 但**图片告警两条路径都必须发**：那件事在界面上看不见（正文引用已经指空、且不报错），
 * 只从菜单发就等于「拖放丢图是静默的」。
 */
async function moveNoteWithFeedback(
  id: Id,
  target: Id | null,
  options: { announce?: boolean } = {},
): Promise<void> {
  // 标题与来源目录都从**数据层现取**，不由调用方传：拖放那条路径（`NoteRow.onDrop`）
  // 手上只有被拖的 id，让它自己去查一遍等于把「查什么」抄成第二份。
  const note = getLibrary().notes[id];
  if (!note) return;
  const from = note.folderId ?? null;
  if (from === target) return;
  const where = target === null ? "笔记本根目录" : folderPathLabel(target);
  const result = await moveNote(id, target);
  if (result.assetsWarning) {
    notify(`「${note.title}」已移动到「${where}」，但图片没跟上：${result.assetsWarning}`, { kind: "danger" });
    return;
  }
  if (!result.path || !options.announce) return;
  const moved = result.path;
  notify(`「${note.title}」已移动到「${where}」`, {
    // 撤销走**同一个**入口（`announce: false`）：搬回去的时候图同样可能搬不动
    // （目标位置的 `.assets/` 被别人占了），那条告警不能因为「这是撤销」就不报。
    action: { label: "撤销", run: () => void moveNoteWithFeedback(moved, from) },
  });
}

/**
 * 「移动到…」：选一个目标目录 → 移动 → 如实报告。
 *
 * 选择器里只有单段名，深层目录会重名（`读书笔记/技术` 与 `工作/技术` 都叫「技术」），
 * 所以提示语由 `moveNoteWithFeedback` 给**完整路径**，用户才能确认自己移到了哪。
 */
async function pickMoveTarget(note: Note): Promise<void> {
  const from = note.folderId ?? null;
  const choice = await askFolder({
    title: "移动到…",
    message: `把「${note.title}」移到哪个文件夹？`,
    choices: folderChoiceList(from),
    value: from,
    confirmLabel: "移动",
    note: "笔记里的图片会跟着一起移动。",
  });
  // `null` = 取消（不是「移到根目录」——根目录是候选项里那个 `id: null` 的项）。
  if (!choice) return;
  await moveNoteWithFeedback(note.id, choice.id, { announce: true });
}

interface NoteRowProps {
  note: Note;
  depth: number;
  active: boolean;
  dirty?: boolean;
  variant?: "tree" | "list";
  /**
   * 关掉拖放（默认开）。标签树里的行会跨标签重复出现，「拖到另一篇笔记上 =
   * 移到它所在的文件夹」在那个语境里说不通，所以那里传 `false`。
   */
  dnd?: boolean;
  onOpen: (id: Id) => void;
  dropTarget?: string | null;
  setDropTarget?: (key: string | null) => void;
}

/**
 * memo：打字时只有正在编辑的那篇笔记对象会变（以及它第一次变脏时的 `dirty`），
 * 其余行的 props 全部原样 —— 回调都是稳定引用（见 `Sidebar` 顶部的 `openNote`）。
 */
const NoteRow = memo(function NoteRow({
  note,
  depth,
  active,
  dirty = false,
  variant = "tree",
  dnd = true,
  onOpen,
  dropTarget,
  setDropTarget,
}: NoteRowProps): ReactNode {
  const key = `note:${note.id}`;
  const menu = (x: number, y: number) =>
    openMenu(x, y, [
      { id: "open", label: "打开", icon: "note", run: () => onOpen(note.id) },
      { id: "star", label: note.starred ? "取消星标" : "加星标", icon: "star", run: () => setStarred(note.id, !note.starred) },
      {
        id: "rename",
        label: "重命名",
        icon: "edit",
        run: async () => {
          const name = await askText({
            title: "重命名笔记",
            value: note.title,
            label: "标题",
            note:
              "标题就是文件名：重命名改的是文件名，正文里的标题不会被改写。" +
              "（还叫「无标题」「未命名」的笔记，写完第一个标题 5 秒后会自动改一次名；可在「设置 · 文件」里关掉。）",
            confirmLabel: "重命名",
          });
          if (name) renameNote(note.id, name);
        },
      },
      {
        id: "move",
        label: "移动到…",
        icon: "move",
        run: () => void pickMoveTarget(note),
      },
      {
        id: "copy-path",
        label: "复制地址",
        icon: "link",
        separatorBefore: true,
        // 笔记本记录从数据层现取（和 `moveNoteWithFeedback` 同一条约定）：菜单是
        // 点击那一刻才构建的，不需要把 workspace 顺着六个 `NoteRow` 调用点传下来。
        disabled: noteAbsolutePath(getLibrary().workspace, note.id) === null,
        run: () => void copyPathToClipboard(getLibrary().workspace, note.id),
      },
      {
        id: "trash",
        label: "移到回收站",
        icon: "trash",
        danger: true,
        separatorBefore: true,
        run: () => {
          trashNote(note.id);
          notify(`「${note.title}」已移入回收站`, { action: { label: "撤销", run: () => restoreNote(note.id) } });
        },
      },
    ]);

  return (
    <div
      role="treeitem"
      tabIndex={0}
      aria-selected={active}
      className={cn("tree__row", active && "is-active", dropTarget === key && "is-drop", variant === "list" && "tree__row--stacked")}
      style={{ paddingLeft: 6 + depth * TREE_INDENT }}
      onClick={() => onOpen(note.id)}
      onKeyDown={(event) => {
        // The row itself is the tree item; the inner "more" button owns its own keys.
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpen(note.id);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        menu(event.clientX, event.clientY);
      }}
      {...(dnd
        ? {
            draggable: true,
            onDragStart: (event: React.DragEvent) => {
              dragPayload = { kind: "note", id: note.id };
              /*
               * 画布侧拖拽契约（与并行队友共享，一字不改）：额外带
               * `application/x-opennote-note` = 笔记 id 纯字符串，`effectAllowed` 为 copy。
               * 树内拖放仍只认模块级 dragPayload，这条 setData 不参与树内判定。
               */
              event.dataTransfer.setData("application/x-opennote-note", note.id);
              event.dataTransfer.effectAllowed = "copy";
            },
            onDragEnd: () => {
              dragPayload = null;
              setDropTarget?.(null);
            },
            onDragOver: (event: React.DragEvent) => {
              if (!dragPayload) return;
              event.preventDefault();
            },
            onDrop: (event: React.DragEvent) => {
              event.preventDefault();
              event.stopPropagation();
              // 拖到另一篇笔记上 = 拖进它所在的那个目录。走**同一个**带反馈的入口，
              // 否则同一次移动从菜单走会报「图没跟上」、从拖放走就静默丢图。
              if (dragPayload?.kind === "note" && dragPayload.id !== note.id) {
                void moveNoteWithFeedback(dragPayload.id, note.folderId);
              }
              dragPayload = null;
              setDropTarget?.(null);
            },
          }
        : {})}
    >
      <span className="tree__icon">
        <Icon name={noteIcon(note)} size={14} />
      </span>
      <span className="tree__label">
        {/* 标题包一层 `.tree__label-main`：`tree__row--stacked` 里它是**第一行**，
            裸文本节点在块级摘要旁边会被折成匿名块，省略号对它不生效（见 app.css）。 */}
        <span className="tree__label-main">{note.title}</span>
        {variant === "list" ? <span className="tree__note-snippet">{excerpt(note.content, 80)}</span> : null}
      </span>
      <span className="tree__extra">
        {note.starred ? <Icon name="star" size={13} filled className="tree__star" /> : null}
        <button
          type="button"
          className="icon-btn"
          style={{ width: 20, height: 20 }}
          title="更多"
          onClick={(event) => {
            event.stopPropagation();
            const rect = (event.target as HTMLElement).getBoundingClientRect();
            menu(rect.left, rect.bottom);
          }}
        >
          <Icon name="more" size={13} />
        </button>
      </span>
      {variant === "list" ? <span className="tree__meta">{formatRelativeTime(note.updatedAt)}</span> : null}
      {dirty ? <span className="tree__meta" title="有未写入的改动">●</span> : null}
    </div>
  );
});

function TrashList({ library, onOpen }: { library: LibraryState; onOpen: (id: Id) => void }): ReactNode {
  const notes = Object.values(library.trash).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  if (!notes.length) {
    return (
      <p className="tree__empty">回收站是空的。删除的笔记会先放在这里，可以恢复。</p>
    );
  }
  return (
    <>
      {notes.map((note) => (
        <div
          key={note.id}
          role="button"
          tabIndex={0}
          className="tree__row"
          style={{ paddingLeft: 6 }}
          title={note.title}
          onClick={() => onOpen(note.id)}
          onKeyDown={(event) => {
            // The row itself owns Enter/Space; the inner buttons own their own keys.
            if (event.target !== event.currentTarget) return;
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            onOpen(note.id);
          }}
        >
          <span className="tree__icon">
            <Icon name={noteIcon(note)} size={14} />
          </span>
          <span className="tree__label truncate">{note.title}</span>
          <span className="tree__extra">
            <button
              type="button"
              className="icon-btn"
              style={{ width: 20, height: 20 }}
              title="恢复"
              onClick={(event) => {
                // 行本身可点（在编辑器里打开），动作按钮不许把这一下也带上。
                event.stopPropagation();
                restoreNote(note.id);
                notify("已恢复");
              }}
            >
              <Icon name="rotate" size={13} />
            </button>
            <button
              type="button"
              className="icon-btn"
              style={{ width: 20, height: 20 }}
              title="彻底删除"
              onClick={async (event) => {
                event.stopPropagation();
                const ok = await askConfirm({
                  title: `彻底删除「${note.title}」？`,
                  message:
                    "此操作不可撤销：笔记、它的历史快照，以及跟笔记走的附件目录（<笔记名>.assets/）都会被删除。",
                  confirmLabel: "彻底删除",
                  danger: true,
                });
                if (ok) await purgeNote(note.id);
              }}
            >
              <Icon name="close" size={13} />
            </button>
          </span>
        </div>
      ))}
      <div className="tree__hint" style={{ paddingLeft: 6 }}>
        <span className="truncate">文件在 .opennote/trash 里</span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 22, fontSize: 12, flex: "none" }}
          onClick={async () => {
            const ok = await askConfirm({
              title: "清空回收站？",
              message: `${notes.length} 条笔记将被永久删除，连同各自的历史快照与跟笔记走的附件目录（<笔记名>.assets/）。`,
              confirmLabel: "清空",
              danger: true,
            });
            if (!ok) return;
            const removed = await emptyTrash();
            notify(
              removed
                ? `已清空回收站：${removed} 条笔记及其历史快照、附件都已删除`
                : "回收站里没有可清除的笔记",
            );
          }}
        >
          清空
        </button>
      </div>
    </>
  );
}

/* ============================= filter / search =========================== */

function SearchBody({
  query,
  activeId,
  onOpen,
}: {
  query: string;
  activeId: Id | null;
  onOpen: (id: Id) => void;
  /** 只在设置里关掉「搜索时显示文件夹」时用：平铺的结果列表（开着时走文件树本体 + 过滤）。 */
  showFolders: false;
}): ReactNode {
  const trimmed = query.trim();
  const hits = useMemo(() => (trimmed ? searchNotes(trimmed, { limit: 60 }) : []), [trimmed]);

  if (!hits.length) return <p className="tree__empty">没有找到包含「{trimmed}」的笔记。</p>;
  return (
    <div className="tree">
      {hits.map((hit) => (
        <button
          key={hit.note.id}
          type="button"
          className={cn("tree__row", "tree__row--stacked", activeId === hit.note.id && "is-active")}
          onClick={() => {
            revealNoteInTree(hit.note.id);
            onOpen(hit.note.id);
          }}
        >
          <span className="tree__icon">
            <Icon name={noteIcon(hit.note)} size={14} />
          </span>
          <span className="tree__label">
            <span className="tree__label-main">{hit.note.title}</span>
            <span className="tree__note-snippet">{hit.snippet}</span>
          </span>
        </button>
      ))}
    </div>
  );
}

/* ================================ tags body =============================== */

/*
 * 「标签」页与「文件」页用同一套树的语言：分支 = 标签（`/` 切层级，见 `tagTree()`），
 * 叶子 = 笔记。展开/收起、过滤时命中分支默认展开、点行改 scope（`is-current` 记号）——
 * 行为与 `FolderBranch` 一一对应；标签不是文件，所以不挂拖放与右键菜单。
 */

/** 展开一个标签分支：同时从「过滤时的收起名单」里摘掉 —— 两个名单不能同时记它。 */
function expandTag(path: string): void {
  const ui = getUi();
  patchUi({
    expandedTags: ui.expandedTags.includes(path) ? ui.expandedTags : [...ui.expandedTags, path],
    collapsedTags: ui.collapsedTags.filter((entry) => entry !== path),
  });
}

/** 收起一个标签分支（`expandTag` 的另一半，与 `collapseFolder` 同构）。 */
function collapseTag(path: string): void {
  const ui = getUi();
  patchUi({
    expandedTags: ui.expandedTags.filter((entry) => entry !== path),
    collapsedTags: ui.collapsedTags.includes(path) ? ui.collapsedTags : [...ui.collapsedTags, path],
  });
}

/**
 * 把一个标签的祖先链（含自身）全部展开 —— 命令面板跳进「标签」页时调用，与文件树的
 * `revealNoteInTree()` 同一职责：scope 记号不能落在一个收着的分支里。
 *
 * 只在**跳转入口**调用；树上的点击不经过它 —— 点行本身就在切换展开态，再补一次
 * 展开会把「点一下收起」原样弹回去（尤其 scope 原本不在这一行上时）。
 */
export function revealTag(path: string): void {
  const current = getUi().expandedTags;
  const missing: string[] = [];
  let rest = path;
  while (rest) {
    if (!current.includes(rest)) missing.push(rest);
    rest = rest.includes("/") ? rest.slice(0, rest.lastIndexOf("/")) : "";
  }
  if (!missing.length) return;
  patchUi({ expandedTags: [...current, ...missing] });
}

/** 过滤后的可见子树：只保留「标签路径命中」或「子树里有命中」的节点。 */
interface VisibleTagNode {
  node: TagTreeNode;
  /** 这个节点下要画的笔记：标签自身命中时是全部（文件夹名命中的同款语义），否则只剩标题命中的。 */
  notes: Note[];
  children: VisibleTagNode[];
}

/** 多关键词 AND（与 `treeFilterFor()` 同一口径）：标签按完整路径、笔记按标题参与匹配。 */
function filterTagTree(nodes: TagTreeNode[], terms: string[]): VisibleTagNode[] {
  const result: VisibleTagNode[] = [];
  for (const node of nodes) {
    const children = filterTagTree(node.children, terms);
    const pathHit = terms.length > 0 && terms.every((term) => node.path.toLowerCase().includes(term));
    const notes = pathHit
      ? node.notes
      : node.notes.filter((note) => terms.every((term) => note.title.toLowerCase().includes(term)));
    if (!pathHit && !notes.length && !children.length) continue;
    result.push({ node, notes, children });
  }
  return result;
}

function TagsBody({
  library,
  ui,
  scope,
  activeId,
  filter,
  onScope,
  onOpen,
  asSearchResult = false,
}: {
  library: LibraryState;
  ui: UiSettings;
  scope: Scope;
  activeId: Id | null;
  filter: string;
  onScope: (scope: Scope) => void;
  onOpen: (id: Id) => void;
  /** 搜索结果里的那一块：没有命中就整块不出现；有命中时自带一行「标签」小标题。 */
  asSearchResult?: boolean;
}): ReactNode {
  const roots = useMemo(() => tagTree(library, { sort: ui.sort }), [library, ui.sort]);
  const terms = useMemo(() => filter.trim().toLowerCase().split(/\s+/).filter(Boolean), [filter]);
  const visible = useMemo(() => filterTagTree(roots, terms), [roots, terms]);

  if (asSearchResult) {
    if (!visible.length) return null;
    return (
      <div className="tree">
        <div className="tree__group">标签</div>
        {visible.map((entry) => (
          <TagBranch
            key={entry.node.path}
            entry={entry}
            depth={0}
            filtered
            library={library}
            ui={ui}
            scope={scope}
            activeId={activeId}
            onScope={onScope}
            onOpen={onOpen}
          />
        ))}
      </div>
    );
  }

  if (!roots.length) {
    return (
      <p className="tree__empty">
        还没有标签。
        <br />
        在正文里写 #想法，或在开头加 YAML front matter 的 tags 字段。
      </p>
    );
  }

  return (
    <div className="tree">
      {/* 「标签」这几个字由分区标题说（`SectionHeader`），这里不再重复一行「全部标签」。 */}
      {visible.length ? (
        visible.map((entry) => (
          <TagBranch
            key={entry.node.path}
            entry={entry}
            depth={0}
            filtered={terms.length > 0}
            library={library}
            ui={ui}
            scope={scope}
            activeId={activeId}
            onScope={onScope}
            onOpen={onOpen}
          />
        ))
      ) : (
        <p className="tree__empty">没有匹配「{filter.trim()}」的标签或笔记。</p>
      )}
    </div>
  );
}

interface TagBranchProps {
  entry: VisibleTagNode;
  depth: number;
  /** 过滤中（筛选框有词）：命中路径默认全展开，`collapsedTags` 是用户手动收下的例外。 */
  filtered: boolean;
  library: LibraryState;
  ui: UiSettings;
  scope: Scope;
  activeId: Id | null;
  onScope: (scope: Scope) => void;
  onOpen: (id: Id) => void;
}

function TagBranch({ entry, depth, filtered, library, ui, scope, activeId, onScope, onOpen }: TagBranchProps): ReactNode {
  const { node, notes, children } = entry;
  const hasChildren = children.length > 0 || notes.length > 0;
  // 与 `FolderBranch` 同一条规则：平时看 `expandedTags`；过滤时默认全展开（命中要一眼看得见）。
  const open = filtered ? !ui.collapsedTags.includes(node.path) : ui.expandedTags.includes(node.path);
  const current = scope.kind === "tag" && scope.tag === node.path;

  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={false}
        aria-current={current ? "true" : undefined}
        className={cn("tree__row", current && "is-current")}
        style={{ paddingLeft: 6 + depth * TREE_INDENT }}
        onClick={() => {
          onScope({ kind: "tag", tag: node.path });
          if (open) collapseTag(node.path);
          else expandTag(node.path);
        }}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onScope({ kind: "tag", tag: node.path });
          if (open) collapseTag(node.path);
          else expandTag(node.path);
        }}
      >
        {/* 同文件夹：`#` 本身就是开合记号（展开时转一个角度、上强调色），不再另挂箭头。 */}
        <span className={cn("tree__icon", "tree__icon--toggle", "tree__icon--hash", open && "is-open", !hasChildren && "is-leaf")}>
          <Icon name="hash" size={13} />
        </span>
        {/* 子标签只显示最后一段；完整路径放悬浮提示里，重名时靠它分辨。 */}
        <span className="tree__label truncate" title={node.path === node.name ? undefined : `#${node.path}`}>
          {node.name}
        </span>
        {/* 收起时才显示计数：展开后子项自己会说话（与文件夹行的写法一致）。 */}
        {!open && node.total ? <span className="tree__meta">{node.total}</span> : null}
      </div>

      {open ? (
        <>
          {children.map((child) => (
            <TagBranch
              key={child.node.path}
              entry={child}
              depth={depth + 1}
              filtered={filtered}
              library={library}
              ui={ui}
              scope={scope}
              activeId={activeId}
              onScope={onScope}
              onOpen={onOpen}
            />
          ))}
          {notes.map((note) => (
            <NoteRow
              key={note.id}
              note={note}
              depth={depth + 1}
              dirty={Boolean(library.dirty[note.id])}
              active={activeId === note.id}
              onOpen={onOpen}
              dnd={false}
            />
          ))}
        </>
      ) : null}
    </>
  );
}
