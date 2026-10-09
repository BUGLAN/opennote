import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  allTags,
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
  trashNote,
  type LibraryState,
} from "../data/library";
import type { Folder, Id, Note, UiSettings } from "../data/types";
import { themeKind } from "../data/ui";
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

export type SidebarTab = "files" | "search" | "tags" | "starred";

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
  supportsLocalFolder: boolean;
  supportsBrowserWorkspace: boolean;
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
  onNewFolder(parentId?: Id | null): void;
  onOpenSettings(): void;
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

/** Drag state lives outside React: it only matters between two native events. */
let dragPayload: { kind: "note" | "folder"; id: Id } | null = null;

export function currentFolderId(scope: Scope): Id | null {
  return scope.kind === "folder" ? scope.id : null;
}

export function Sidebar(props: SidebarProps): ReactNode {
  const { library, ui, scope, tab, activeId } = props;
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
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

  const tags = useMemo(() => allTags(library), [library]);

  /*
   * 两处过滤都走**同一棵树 + 一个可见集合**（用户原话「直接使用原来的那一份加个筛选就行了」）：
   * 集合由 `treeFilterFor()` 算（命中笔记 + 祖先目录 + 文件夹名命中），
   * 树本身（`TreeBody`/`FolderBranch`）一行都没改样式 —— 目录行的 caret 照旧能展开能收缩。
   */
  const nameFilter = useMemo(
    () => (filter.trim() && ui.searchFolders ? treeFilterFor(filter) : null),
    [library, filter, ui.searchFolders],
  );
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
          <span className="sidebar__name">Opennote</span>
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
          <button className="icon-btn" title="新建笔记 (Ctrl/⌘ + N)" onClick={() => props.onNewNote(currentFolderId(scope))}>
            <Icon name="plus" />
          </button>
          <button
            className="icon-btn"
            title="新建文件夹 (Ctrl/⌘ + Shift + N)"
            onClick={() => props.onNewFolder(currentFolderId(scope))}
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
      </div>

      <aside className={cn("sidebar", !ui.sidebarOpen && "is-collapsed")}>
        <div className="sidebar__workspace">
        <button
          type="button"
          className="workspace__button"
          onClick={() => props.onSwitcherOpen(!props.switcherOpen)}
          title={props.workspace ? workspaceLocation(props.workspace) : "还没有打开笔记本"}
        >
          <Icon
            name={
              props.workspace?.kind === "node" || props.workspace?.kind === "capacitor"
                ? "folder"
                : props.workspace
                  ? "layers"
                  : "info"
            }
            size={13}
          />
          <span className="truncate">{props.workspace?.name ?? "未打开笔记本"}</span>
          <Icon name="chevronDown" size={12} className="workspace__caret" />
        </button>
        {props.switcherOpen ? (
          <div className="workspace__menu">
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
            <button type="button" className="menu__item" disabled={!props.supportsLocalFolder} onClick={props.onAddLocalFolder}>
              <Icon name="folder" size={14} />
              <span>
                {isCapacitorNative()
                  ? "新建手机笔记本…"
                  : props.supportsLocalFolder
                    ? "打开本机文件夹…"
                    : "本机文件夹（需 Chrome/Edge 或桌面版）"}
              </span>
            </button>
            <button type="button" className="menu__item" disabled={!props.supportsBrowserWorkspace} onClick={props.onNewBrowserWorkspace}>
              <Icon name="plus" size={14} />
              <span>新建浏览器笔记本…</span>
            </button>
            <button type="button" className="menu__item" onClick={props.onUploadFolder}>
              <Icon name="upload" size={14} />
              <span>导入文件夹到浏览器…</span>
            </button>
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

      <nav className="sidebar__tabs">
        {(
          [
            ["files", "文件"],
            ["search", "搜索"],
            ["tags", "标签"],
            ["starred", "星标"],
          ] as [SidebarTab, string][]
        ).map(([id, label]) => (
          <button
            key={id}
            className={cn("sidebar__tab", tab === id && "is-active")}
            onClick={() => {
              props.onTab(id);
              if (id === "search") requestAnimationFrame(() => searchInputRef.current?.focus());
            }}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="sidebar__body">
        {tab === "files" ? (
          <>
            <div className="sidebar__filter">
              <input
                className="field field--search"
                value={filter}
                placeholder="筛选笔记…"
                onChange={(event) => setFilter(event.target.value)}
              />
            </div>
            {filter.trim() && !props.ui.searchFolders ? (
              <FilteredNotes
                library={library}
                filter={filter.trim()}
                activeId={activeId}
                onOpen={props.onOpenNote}
              />
            ) : (
              <TreeBody
                {...props}
                counts={counts}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
                onDropOn={handleDrop}
                filter={nameFilter}
              />
            )}
          </>
        ) : null}

        {tab === "search" ? (
          <SearchBody
            inputRef={searchInputRef}
            query={query}
            onQuery={setQuery}
            activeId={activeId}
            onOpen={props.onOpenNote}
            showFolders={props.ui.searchFolders}
            tree={
              <TreeBody
                {...props}
                counts={counts}
                dropTarget={dropTarget}
                setDropTarget={setDropTarget}
                onDropOn={handleDrop}
                filter={searchFilter}
              />
            }
          />
        ) : null}

        {tab === "tags" ? (
          <TagsBody library={library} tags={tags} scope={scope} activeId={activeId} onScope={props.onScope} onOpen={props.onOpenNote} />
        ) : null}

        {tab === "starred" ? (
          <NoteList
            library={library}
            notes={starredNotes(library)}
            activeId={activeId}
            onOpen={props.onOpenNote}
            emptyHint="还没有星标笔记。右键任意笔记即可加星标。"
          />
        ) : null}
      </div>

      <footer className="sidebar__foot">
        <Icon name="shield" size={13} />
        <span title={props.workspace ? workspaceLocation(props.workspace) : undefined}>
          {counts.all} 篇笔记
        </span>
        {/* 动作位的高度是「盒模型里量得到的 22px」（`.sidebar__foot-actions`），
            不再用行内 `<span>` 包按钮 —— 那会撑出 23.39px 的行盒，把 30px 的底栏顶高。 */}
        <span className="sidebar__foot-actions">
          <button className="icon-btn" title="设置" onClick={props.onOpenSettings} style={{ width: 22, height: 22 }}>
            <Icon name="settings" size={14} />
          </button>
        </span>
      </footer>
      </aside>
    </>
  );
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
  counts: { all: number; starred: number; trash: number };
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
  onDropOn: (folderId: Id | null) => void;
  /** 有值时只渲染可见集合里的笔记与目录（搜索 / 筛选）；目录行仍是树上那一行（可展开可收缩）。 */
  filter?: TreeFilter | null;
}

function TreeBody(props: TreeProps): ReactNode {
  const { library, ui, scope, activeId, counts } = props;
  // ㊷：「其他」是可折叠组，条目缩进为子项（与文件夹树同一套语言）。
  // 默认展开：收件箱的待确认条数是**要看的**，折叠起来等于把它藏了。
  const [othersOpen, setOthersOpen] = useState(true);
  // （56）：星标 / 回收站各自也是**可折叠分支**——它们此前与文件夹长得一样（图标 + 计数），
  // 点下去却只改 scope、什么都不展开（回收站的单子还长在整棵树的末尾），于是「折叠」这件事
  // 在同一个文件树里有两种说法。现在两者与 `FolderBranch` 同一套语言：caret + 子项缩进一级。
  // 默认收起，与文件夹树一致（`DEFAULT_UI.expanded` 是空数组）。
  const [starredOpen, setStarredOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
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
       * 让「当前文件夹」变回空。真正需要「新建到哪里」的行为由文件夹行的高亮承担，
       * 整棵树的空白处依旧是拖到根目录的投放区（见上面的 `dropZoneProps("root", null)`）。
       */}
      {roots.length ? <div className="tree__group">文件夹</div> : null}
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

      {/* 过滤时只画命中的那部分树：星标 / 回收站 / 收件箱是**另一条轴**的东西，
          混进搜索结果里只会把「我搜到的那几篇」淹掉。 */}
      {filter ? null : (
        <>
          {/* ㊷：「其他」像文件夹那样可展开/收起，条目缩进一级，父子关系看得见。 */}
          <button
            type="button"
            className="tree__group tree__group--toggle"
            aria-expanded={othersOpen}
            onClick={() => setOthersOpen((open) => !open)}
          >
            <span className={cn("tree__caret", othersOpen && "is-open")}>
              <Icon name="chevronRight" size={12} />
            </span>
            其他
          </button>
          {othersOpen ? (
            <>
              <ScopeRow
                depth={1}
                icon="star"
                label="星标笔记"
                count={counts.starred}
                active={scope.kind === "starred"}
                open={starredOpen}
                onClick={() => {
                  props.onScope({ kind: "starred" });
                  setStarredOpen((open) => !open);
                }}
              >
                <StarredNotes
                  library={library}
                  activeId={activeId}
                  onOpen={props.onOpenNote}
                  dropTarget={props.dropTarget}
                  setDropTarget={props.setDropTarget}
                />
              </ScopeRow>
              <ScopeRow
                depth={1}
                icon="trash"
                label="回收站"
                count={counts.trash}
                active={scope.kind === "trash"}
                open={trashOpen}
                onClick={() => {
                  props.onScope({ kind: "trash" });
                  setTrashOpen((open) => !open);
                }}
              >
                <TrashList library={library} onOpen={props.onOpenNote} />
              </ScopeRow>
              {/* 外部导入的待确认内容在这里，不属于文件树，所以不参与 scope 高亮。 */}
              <ScopeRow
                depth={1}
                icon="download"
                label="收件箱"
                count={props.inboxPending}
                active={false}
                onClick={() => props.onOpenInbox()}
              />
            </>
          ) : null}
        </>
      )}
    </div>
  );
}

function ScopeRow({
  icon,
  label,
  count,
  active,
  onClick,
  depth = 0,
  open,
  children,
}: {
  icon: IconName;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
  /** 缩进层级；与 FolderBranch 用同一公式，保证「其他」的子项和文件夹子项对齐。 */
  depth?: number;
  /** 传了 `children` 就是**可折叠分支**（星标 / 回收站）：caret、`aria-expanded`、子项缩进一级。 */
  open?: boolean;
  children?: ReactNode;
}): ReactNode {
  // 有子项的组：caret 与图标同列，展开时才渲染子项 —— 与 `FolderBranch` 完全同构。
  const hasChildren = children !== undefined;
  // 收起时才显示计数：展开后子项自己会说话（与文件夹行的写法一致）。
  const showCount = count > 0 && !(hasChildren && open);

  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        aria-selected={active}
        aria-expanded={hasChildren ? open : undefined}
        className={cn("tree__row", active && "is-active")}
        style={{ paddingLeft: 6 + depth * 13 }}
        onClick={onClick}
        onKeyDown={(event) => {
          // The row itself is the tree item; inner controls own their own keys.
          if (event.target !== event.currentTarget) return;
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          onClick();
        }}
      >
        <span className={cn("tree__caret", open && "is-open")}>
          {hasChildren ? <Icon name="chevronRight" size={13} /> : null}
        </span>
        <span className="tree__icon">
          <Icon name={icon} size={14} />
        </span>
        <span className="tree__label">{label}</span>
        {showCount ? <span className="tree__meta">{count}</span> : null}
      </div>
      {hasChildren && open ? children : null}
    </>
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
  const active = scope.kind === "folder" && scope.id === folder.id;

  return (
    <>
      <div
        role="treeitem"
        tabIndex={0}
        aria-expanded={hasChildren ? open : undefined}
        aria-selected={active}
        draggable
        className={cn("tree__row", active && "is-active", props.dropTarget === `folder:${folder.id}` && "is-drop")}
        style={{ paddingLeft: 6 + depth * 13 }}
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
        onDoubleClick={async () => {
          const name = await askText({ title: "重命名文件夹", value: folder.name, label: "文件夹名称" });
          if (name) renameFolder(folder.id, name);
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
        <span className={cn("tree__caret", open && "is-open")}>
          {hasChildren ? <Icon name="chevronRight" size={13} /> : null}
        </span>
        <span className="tree__icon">
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
  onOpen: (id: Id) => void;
  dropTarget?: string | null;
  setDropTarget?: (key: string | null) => void;
}

function NoteRow({
  note,
  depth,
  active,
  dirty = false,
  variant = "tree",
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
              "重命名会同时改文件名与侧栏显示名；正文里的一级标题不会被改写。改过名之后，这篇笔记不再跟随正文标题自动改名。" +
              "（只有还叫「无标题」「未命名」的笔记，才会在写完标题 5 秒后自动跟随正文标题；可在「设置 · 文件」里关掉。）",
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
      draggable
      className={cn("tree__row", active && "is-active", dropTarget === key && "is-drop", variant === "list" && "tree__row--stacked")}
      style={{ paddingLeft: 6 + depth * 13 }}
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
      onDragStart={() => {
        dragPayload = { kind: "note", id: note.id };
      }}
      onDragEnd={() => {
        dragPayload = null;
        setDropTarget?.(null);
      }}
      onDragOver={(event) => {
        if (!dragPayload) return;
        event.preventDefault();
      }}
      onDrop={(event) => {
        event.preventDefault();
        event.stopPropagation();
        // 拖到另一篇笔记上 = 拖进它所在的那个目录。走**同一个**带反馈的入口，
        // 否则同一次移动从菜单走会报「图没跟上」、从拖放走就静默丢图。
        if (dragPayload?.kind === "note" && dragPayload.id !== note.id) {
          void moveNoteWithFeedback(dragPayload.id, note.folderId);
        }
        dragPayload = null;
        setDropTarget?.(null);
      }}
    >
      <span className="tree__caret" />
      <span className="tree__icon">
        <Icon name="note" size={14} />
      </span>
      <span className="tree__label">
        {note.title}
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
}

function NoteList({
  library,
  notes,
  activeId,
  onOpen,
  emptyHint,
}: {
  library: LibraryState;
  notes: Note[];
  activeId: Id | null;
  onOpen: (id: Id) => void;
  emptyHint: string;
}): ReactNode {
  if (!notes.length) return <p className="tree__empty">{emptyHint}</p>;
  return (
    <div className="tree">
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          depth={0}
          variant="list"
          dirty={Boolean(library.dirty[note.id])}
          active={activeId === note.id}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

/** （56）嵌在「星标笔记 / 回收站」下面的子项层级：父行是 `depth = 1`，子项再进一级。
 *  缩进公式仍是 `6 + depth * 13`，所以子项和文件夹里的笔记行**用同一把尺子**。 */
const NESTED_DEPTH = 2;

function nestedIndent(): number {
  return 6 + NESTED_DEPTH * 13;
}

/** 「星标笔记」展开后的子项：与文件树里的笔记行同一写法（同一套右键菜单、同一套拖放）。 */
function StarredNotes({
  library,
  activeId,
  onOpen,
  dropTarget,
  setDropTarget,
}: {
  library: LibraryState;
  activeId: Id | null;
  onOpen: (id: Id) => void;
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
}): ReactNode {
  const notes = starredNotes(library);
  if (!notes.length) {
    return (
      <p className="tree__empty" style={{ paddingLeft: nestedIndent(), textAlign: "left" }}>
        还没有星标笔记。右键任意笔记即可加星标。
      </p>
    );
  }
  return (
    <>
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          depth={NESTED_DEPTH}
          dirty={Boolean(library.dirty[note.id])}
          active={activeId === note.id}
          onOpen={onOpen}
          dropTarget={dropTarget}
          setDropTarget={setDropTarget}
        />
      ))}
    </>
  );
}

function TrashList({ library, onOpen }: { library: LibraryState; onOpen: (id: Id) => void }): ReactNode {
  const notes = Object.values(library.trash).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  if (!notes.length) {
    return (
      <p className="tree__empty" style={{ paddingLeft: nestedIndent(), textAlign: "left" }}>
        回收站是空的。
      </p>
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
          style={{ paddingLeft: nestedIndent() }}
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
          <span className="tree__caret" />
          <span className="tree__icon">
            <Icon name="note" size={14} />
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
      <div className="tree__hint" style={{ paddingLeft: nestedIndent() }}>
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

function FilteredNotes({
  library,
  filter,
  activeId,
  onOpen,
}: {
  library: LibraryState;
  filter: string;
  activeId: Id | null;
  onOpen: (id: Id) => void;
}): ReactNode {
  const notes = useMemo(() => {
    const terms = filter.toLowerCase().split(/\s+/).filter(Boolean);
    return Object.values(library.notes)
      .filter((note) => !note.trashed)
      .filter((note) => {
        const haystack = `${note.title}\n${note.tags.join(" ")}\n${excerpt(note.content, 4000)}`.toLowerCase();
        return terms.every((term) => haystack.includes(term));
      })
      .slice(0, 200);
  }, [library.notes, filter]);

  if (!notes.length) return <p className="tree__empty">没有匹配「{filter}」的笔记。</p>;
  /*
   * **平铺列表**（设置里的「搜索时显示文件夹」关掉时用）：只有笔记行，没有目录行。
   * 「显示文件夹」打开时走的是 `TreeBody` + `treeFilterFor()` —— 那是**同一棵树**加过滤，
   * 目录行仍是树上那一行（真 caret、能展开能收缩），不再另写一套层级样式。
   */
  return (
    <div className="tree">
      {notes.map((note) => (
        <NoteRow
          key={note.id}
          note={note}
          depth={0}
          variant="list"
          dirty={Boolean(library.dirty[note.id])}
          active={activeId === note.id}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
}

function SearchBody({
  inputRef,
  query,
  onQuery,
  activeId,
  onOpen,
  showFolders,
  tree,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (value: string) => void;
  activeId: Id | null;
  onOpen: (id: Id) => void;
  /** 设置里的「搜索时显示文件夹」：开 = 树 + 过滤（同一棵树，可展开可收缩）；关 = 平铺列表。 */
  showFolders: boolean;
  /** 「显示文件夹」打开时由调用方传进来的**那一棵树**（带过滤集合），本组件不再自己画行。 */
  tree: ReactNode;
}): ReactNode {
  const trimmed = query.trim();
  const hits = useMemo(() => (trimmed ? searchNotes(trimmed, { limit: 60 }) : []), [trimmed]);

  return (
    <>
      <div className="sidebar__filter">
        <input
          ref={inputRef}
          className="field field--search"
          value={query}
          placeholder="搜索全文…"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      {!trimmed ? (
        <p className="tree__empty">
          输入关键词，搜索所有笔记的标题、标签与正文{showFolders ? "，以及文件夹名" : ""}。
          <br />
          多个关键词用空格分隔。
        </p>
      ) : null}
      {trimmed && !hits.length ? <p className="tree__empty">没有找到包含「{query}」的笔记或文件夹。</p> : null}
      {/*
       * 开 = 直接用文件树本体（调用方传进来的 `tree`）：命中笔记挂在**它们真实的目录层级**里，
       * 目录行是树上那一行（真 caret、能展开能收缩、右键菜单/拖放都在）。
       * 关 = 平铺列表（0.3.x 的行为）。
       */}
      {trimmed && showFolders ? tree : null}
      {trimmed && !showFolders && hits.length ? (
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
                <Icon name="note" size={14} />
              </span>
              <span className="tree__label">
                {hit.note.title}
                <span className="tree__note-snippet">{hit.snippet}</span>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </>
  );
}

function TagsBody({
  library,
  tags,
  scope,
  activeId,
  onScope,
  onOpen,
}: {
  library: LibraryState;
  tags: { tag: string; count: number }[];
  scope: Scope;
  activeId: Id | null;
  onScope: (scope: Scope) => void;
  onOpen: (id: Id) => void;
}): ReactNode {
  const activeTag = scope.kind === "tag" ? scope.tag : null;
  const notes = activeTag
    ? Object.values(library.notes)
        .filter((note) => !note.trashed && note.tags.includes(activeTag))
        .sort((a, b) => b.updatedAt - a.updatedAt)
    : [];

  if (!tags.length) {
    return (
      <p className="tree__empty">
        还没有标签。
        <br />
        在正文里写 #想法，或在开头加 YAML front matter 的 tags 字段。
      </p>
    );
  }

  return (
    <>
      <div className="tree">
        <div className="tree__group">全部标签</div>
        {tags.map(({ tag, count }) => (
          <button
            key={tag}
            type="button"
            className={cn("tree__row", activeTag === tag && "is-active")}
            onClick={() => onScope({ kind: "tag", tag })}
          >
            <span className="tree__icon">
              <Icon name="hash" size={13} />
            </span>
            <span className="tree__label">{tag}</span>
            <span className="tree__meta">{count}</span>
          </button>
        ))}
      </div>
      {activeTag ? (
        <div className="tree" style={{ marginTop: 10 }}>
          <div className="tree__group">#{activeTag}</div>
          {notes.length ? (
            notes.map((note) => (
              <NoteRow
                key={note.id}
                note={note}
                depth={0}
                variant="list"
                active={activeId === note.id}
                onOpen={onOpen}
              />
            ))
          ) : (
            <p className="tree__empty">没有笔记使用这个标签。</p>
          )}
        </div>
      ) : null}
    </>
  );
}
