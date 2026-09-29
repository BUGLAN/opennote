import { useMemo, useRef, useState, type ReactNode } from "react";
import {
  allTags,
  childFolders,
  collapseFolder,
  deleteFolder,
  descendantFolderIds,
  emptyTrash,
  expandFolder,
  folderStats,
  moveFolder,
  moveNote,
  notesInFolder,
  purgeNote,
  renameFolder,
  renameNote,
  restoreNote,
  searchNotes,
  setStarred,
  starredNotes,
  trashNote,
  type LibraryState,
} from "../data/library";
import type { Folder, Id, Note, UiSettings } from "../data/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { askConfirm, askText } from "../lib/dialogs";
import { notify } from "../lib/toast";
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
  onCloseWorkspace(): void;
  onScope(scope: Scope): void;
  onTab(tab: SidebarTab): void;
  onOpenNote(id: Id): void;
  onNewNote(folderId?: Id | null): void;
  onNewFolder(parentId?: Id | null): void;
  onOpenSettings(): void;
  onCollapse(): void;
  /** 待确认的收件箱条目数（0 时不显示计数）。 */
  inboxPending: number;
  onOpenInbox(): void;
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

  const handleDrop = (folderId: Id | null) => {
    const payload = dragPayload;
    dragPayload = null;
    setDropTarget(null);
    if (!payload) return;
    if (payload.kind === "note") {
      moveNote(payload.id, folderId);
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
    <aside className={cn("sidebar", !ui.sidebarOpen && "is-collapsed")}>
      <div className="sidebar__head">
        <div className="sidebar__brand">
          <span className="seal" aria-hidden="true">
            記
          </span>
          <span className="sidebar__name">
            Opennote
            <small>开源笔记</small>
          </span>
        </div>
        <div className="sidebar__actions">
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
          <button className="icon-btn" title="收起侧栏 (Ctrl/⌘ + \)" onClick={props.onCollapse}>
            <Icon name="sidebar" />
          </button>
        </div>
      </div>

      <div className="sidebar__workspace">
        <button
          type="button"
          className="workspace__button"
          onClick={() => props.onSwitcherOpen(!props.switcherOpen)}
          title={props.workspace ? workspaceLocation(props.workspace) : "还没有打开笔记本"}
        >
          <Icon name={props.workspace?.kind === "node" ? "folder" : props.workspace ? "layers" : "info"} size={13} />
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
                <Icon name={record.kind === "node" ? "folder" : "layers"} size={14} />
                <span className="truncate">{record.name}</span>
              </button>
            ))}
            {props.workspaces.length ? <div className="menu__sep" /> : null}
            <button type="button" className="menu__item" disabled={!props.supportsLocalFolder} onClick={props.onAddLocalFolder}>
              <Icon name="folder" size={14} />
              <span>{props.supportsLocalFolder ? "打开本机文件夹…" : "本机文件夹（需 Chrome/Edge 或桌面版）"}</span>
            </button>
            <button type="button" className="menu__item" disabled={!props.supportsBrowserWorkspace} onClick={props.onNewBrowserWorkspace}>
              <Icon name="plus" size={14} />
              <span>新建浏览器笔记本…</span>
            </button>
            <button type="button" className="menu__item" onClick={props.onUploadFolder}>
              <Icon name="upload" size={14} />
              <span>导入文件夹到浏览器…</span>
            </button>
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
            {filter.trim() ? (
              <FilteredNotes library={library} filter={filter.trim()} activeId={activeId} onOpen={props.onOpenNote} />
            ) : (
              <TreeBody {...props} counts={counts} dropTarget={dropTarget} setDropTarget={setDropTarget} onDropOn={handleDrop} />
            )}
          </>
        ) : null}

        {tab === "search" ? (
          <SearchBody inputRef={searchInputRef} query={query} onQuery={setQuery} activeId={activeId} onOpen={props.onOpenNote} />
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
        <span style={{ marginLeft: "auto" }}>
          <button className="icon-btn" title="设置" onClick={props.onOpenSettings} style={{ width: 22, height: 22 }}>
            <Icon name="settings" size={14} />
          </button>
        </span>
      </footer>
    </aside>
  );
}

function workspaceLocation(record: WorkspaceRecord): string {
  if (record.kind === "node") return `本机磁盘 · ${record.location}`;
  if (record.kind === "fsa") return `浏览器文件夹 · ${record.name}`;
  return `浏览器本地存储 · ${record.name}`;
}

/* =============================== tree body ============================== */

interface TreeProps extends SidebarProps {
  counts: { all: number; starred: number; trash: number };
  dropTarget: string | null;
  setDropTarget: (key: string | null) => void;
  onDropOn: (folderId: Id | null) => void;
}

function TreeBody(props: TreeProps): ReactNode {
  const { library, ui, scope, activeId, counts } = props;
  const roots = childFolders(library, null);
  const loose = notesInFolder(library, null, { sort: ui.sort });

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
      <ScopeRow
        icon="note"
        label="全部笔记"
        count={counts.all}
        active={scope.kind === "all"}
        onClick={() => props.onScope({ kind: "all" })}
      />

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

      {!roots.length && !loose.length ? (
        <p className="tree__empty">
          这个文件夹里还没有 Markdown 文件。
          <br />
          按 Ctrl/⌘ + N 写下第一篇。
        </p>
      ) : null}

      <div className="tree__group">其他</div>
      <ScopeRow
        icon="star"
        label="星标笔记"
        count={counts.starred}
        active={scope.kind === "starred"}
        onClick={() => props.onScope({ kind: "starred" })}
      />
      <ScopeRow
        icon="trash"
        label="回收站"
        count={counts.trash}
        active={scope.kind === "trash"}
        onClick={() => props.onScope({ kind: "trash" })}
      />
      {/* 外部导入的待确认内容在这里，不属于文件树，所以不参与 scope 高亮。 */}
      <ScopeRow
        icon="download"
        label="导入收件箱"
        count={props.inboxPending}
        active={false}
        onClick={() => props.onOpenInbox()}
      />

      {scope.kind === "trash" ? <TrashList library={library} /> : null}
    </div>
  );
}

function ScopeRow({
  icon,
  label,
  count,
  active,
  onClick,
}: {
  icon: IconName;
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button type="button" className={cn("tree__row", active && "is-active")} onClick={onClick}>
      <span className="tree__icon">
        <Icon name={icon} size={14} />
      </span>
      <span className="tree__label">{label}</span>
      {count ? <span className="tree__meta">{count}</span> : null}
    </button>
  );
}

interface BranchProps extends TreeProps {
  folder: Folder;
  depth: number;
  dropZoneProps: (key: string, folderId: Id | null) => Record<string, unknown>;
}

function FolderBranch({ folder, depth, dropZoneProps, ...props }: BranchProps): ReactNode {
  const { library, ui, scope, activeId } = props;
  const children = childFolders(library, folder.id);
  const notes = notesInFolder(library, folder.id, { sort: ui.sort });
  const hasChildren = children.length > 0 || notes.length > 0;
  const open = ui.expanded.includes(folder.id);
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
            note: "重命名只改显示名；正文里的一级标题不会被改写。",
            confirmLabel: "重命名",
          });
          if (name) renameNote(note.id, name);
        },
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
        if (dragPayload?.kind === "note" && dragPayload.id !== note.id) moveNote(dragPayload.id, note.folderId);
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

function TrashList({ library }: { library: LibraryState }): ReactNode {
  const notes = Object.values(library.trash).sort((a, b) => (b.trashedAt ?? 0) - (a.trashedAt ?? 0));
  if (!notes.length) return <p className="tree__empty">回收站是空的。</p>;
  return (
    <div className="tree" style={{ marginTop: 6 }}>
      {notes.map((note) => (
        <div key={note.id} className="tree__row" style={{ paddingLeft: 12 }} title={note.title}>
          <span className="tree__label truncate">{note.title}</span>
          <span className="tree__extra">
            <button
              type="button"
              className="icon-btn"
              style={{ width: 20, height: 20 }}
              title="恢复"
              onClick={() => {
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
              onClick={async () => {
                const ok = await askConfirm({
                  title: `彻底删除「${note.title}」？`,
                  message: "此操作不可撤销：笔记、它的历史快照，以及同目录 assets/ 里的附件都会被删除。",
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
      <div className="tree__hint">
        <span>回收站里的文件在 .opennote/trash 里</span>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ height: 22, fontSize: 12 }}
          onClick={async () => {
            const ok = await askConfirm({
              title: "清空回收站？",
              message: `${notes.length} 条笔记将被永久删除，连同各自的历史快照与同目录 assets/ 里的附件。`,
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
    </div>
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
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  query: string;
  onQuery: (value: string) => void;
  activeId: Id | null;
  onOpen: (id: Id) => void;
}): ReactNode {
  const hits = useMemo(() => (query.trim().length >= 1 ? searchNotes(query, { limit: 60 }) : []), [query]);

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
      {!query.trim() ? (
        <p className="tree__empty">
          输入关键词，搜索所有笔记的标题、标签与正文。
          <br />
          多个关键词用空格分隔。
        </p>
      ) : null}
      {query.trim() && !hits.length ? <p className="tree__empty">没有找到包含「{query}」的笔记。</p> : null}
      <div className="tree">
        {hits.map((hit) => (
          <button
            key={hit.note.id}
            type="button"
            className={cn("tree__row", "tree__row--stacked", activeId === hit.note.id && "is-active")}
            onClick={() => onOpen(hit.note.id)}
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
