import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import {
  allTags,
  closeTab,
  createFolder,
  createNote,
  cycleTab,
  flushAll,
  folderPathLabel,
  foldersArray,
  initLibrary,
  listSnapshots,
  notesArray,
  openNote,
  reconcileTabs,
  setStarred,
  trashNote,
  updateNoteContent,
  useLibrary,
} from "./data/library";
import { clearAll, estimateUsage } from "./data/db";
import { patchUi, setTheme as applyTheme, toggleAppearance, useUi } from "./data/ui";
import type { Id, Snapshot, ThemeId, UiSettings } from "./data/types";
import { buildAppCommands, isEditableTarget, matchesShortcut } from "./lib/appCommands";
import { askConfirm, askText } from "./lib/dialogs";
import { buildLibraryJson, exportLibraryZip, exportNoteHtml, exportNoteMarkdown } from "./lib/export";
import { importPaths } from "./lib/import";
import { extractHeadings, findCurrentHeading } from "./lib/outline";
import { notify } from "./lib/toast";
import { cn, download, excerpt, formatRelativeTime } from "./lib/utils";
import { CommandPalette, type PaletteEntry } from "./components/CommandPalette";
import { EditorPane, type CursorInfo } from "./components/EditorPane";
import { HistoryDialog, SettingsDialog, ShortcutsDialog } from "./components/AppDialogs";
import { Icon } from "./components/Icons";
import { DialogHost, MenuHost, Toasts, openMenu } from "./components/Overlays";
import { Outline } from "./components/Outline";
import { Sidebar, currentFolderId, type Scope, type SidebarTab } from "./components/Sidebar";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { setBridge } from "./editor/bridge";

export default function App(): ReactNode {
  const library = useLibrary();
  const ui = useUi();

  const viewRef = useRef<EditorView | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  const [tab, setTab] = useState<SidebarTab>("files");
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 });
  const [palette, setPalette] = useState<null | "all" | "commands">(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [dropping, setDropping] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const dirInputRef = useRef<HTMLInputElement | null>(null);

  const activeId = ui.activeId && library.notes[ui.activeId] && !library.notes[ui.activeId].trashed ? ui.activeId : null;
  const activeNote = activeId ? library.notes[activeId] : null;
  const deferredContent = useDeferredValue(activeNote?.content ?? "");

  const headings = useMemo(() => extractHeadings(deferredContent), [deferredContent]);
  const currentHeading = useMemo(
    () => findCurrentHeading(headings, positionOfLine(deferredContent, cursor.line)),
    [headings, cursor.line, deferredContent],
  );
  const tags = useMemo(() => allTags(library), [library]);

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    void initLibrary();
  }, []);

  useEffect(() => {
    if (!library.ready) return;
    reconcileTabs();
    void estimateUsage().then(setStorage);
    const boot = document.getElementById("boot");
    if (boot) {
      boot.classList.add("is-gone");
      setTimeout(() => boot.remove(), 400);
    }
  }, [library.ready]);

  useEffect(() => {
    const timer = setInterval(() => flushAll(), 20_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = activeNote ? `${activeNote.title} · Opennote` : "Opennote · 开源笔记";
  }, [activeNote?.title, activeNote]);

  useEffect(() => {
    if (!activeId) {
      setSnapshots([]);
      return;
    }
    let cancelled = false;
    void listSnapshots(activeId).then((list) => {
      if (!cancelled) setSnapshots(list);
    });
    return () => {
      cancelled = true;
    };
  }, [activeId, historyOpen]);

  /* the editor talks back to the app through a small bridge */
  useEffect(() => {
    return setBridge({
      openWikiLink: (title) => {
        const match = Object.values(library.notes).find((note) => !note.trashed && note.title === title);
        if (match) {
          openNote(match.id);
          return;
        }
        createNote({ folderId: currentFolderId(scope), content: `# ${title}\n\n`, title });
        notify(`已创建《${title}》`);
      },
      notify: (message) => notify(message),
      hasNote: (title) => Object.values(library.notes).some((note) => !note.trashed && note.title === title),
      imageMode: () => ui.imageMode,
    });
  }, [library.notes, scope, ui.imageMode]);

  /* --------------------------------------------------------------- actions */

  const importFiles = async (files: FileList | File[]) => {
    try {
      const result = await importPaths(files, { folderId: currentFolderId(scope), mode: "merge" });
      const parts = [`${result.notes} 条笔记`, `${result.folders} 个文件夹`];
      if (result.assets) parts.push(`${result.assets} 个附件`);
      notify(`导入完成：${parts.join("、")}${result.skipped ? `，跳过 ${result.skipped} 项` : ""}`);
      void estimateUsage().then(setStorage);
      if (result.notes) setTab("files");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败", { kind: "danger" });
    }
  };

  const newNote = (folderId?: Id | null) => {
    const note = createNote({ folderId: folderId === undefined ? currentFolderId(scope) : folderId, content: "" });
    notify("已新建笔记", { action: { label: "撤销", run: () => trashNote(note.id) } });
    requestAnimationFrame(() => viewRef.current?.focus());
  };

  const newFolder = async (parentId?: Id | null) => {
    const name = await askText({
      title: "新建文件夹",
      label: "文件夹名称",
      placeholder: "例如：读书笔记",
      confirmLabel: "创建",
    });
    if (!name) return;
    const folder = createFolder(name, parentId === undefined ? currentFolderId(scope) : parentId);
    setScope({ kind: "folder", id: folder.id });
  };

  const wipe = async () => {
    const ok = await askConfirm({
      title: "清空全部本地数据？",
      message: "所有笔记、文件夹、图片与历史快照都会从这台设备上永久删除。",
      note: "建议先导出一次 zip 备份。",
      confirmLabel: "我确定，清空",
      danger: true,
    });
    if (!ok) return;
    await clearAll();
    window.location.reload();
  };

  const jumpToHeading = (pos: number) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  };

  const exportNote = async (kind: "md" | "md-inline" | "html") => {
    if (!activeNote) return;
    if (kind === "html") await exportNoteHtml(activeNote);
    else await exportNoteMarkdown(activeNote, { inlineAssets: kind === "md-inline" });
    notify("导出完成");
  };

  const exportLibrary = async (kind: "zip" | "json") => {
    const notes = notesArray();
    const folders = foldersArray();
    if (kind === "json") {
      const blob = await buildLibraryJson(notes, folders);
      download(blob, "opennote-backup.json");
    } else {
      await exportLibraryZip(notes, folders);
    }
    notify("备份已导出");
  };

  /* ------------------------------------------------------------- commands */

  const commands = useMemo(
    () =>
      buildAppCommands({
        view: () => viewRef.current,
        newNote,
        newFolder: () => void newFolder(),
        openPalette: (mode) => setPalette(mode),
        openSearch: () => {
          patchUi({ sidebarOpen: true });
          setTab("search");
        },
        saveNow: () => {
          flushAll();
          notify("已保存");
        },
        closeTab: () => {
          if (activeId) closeTab(activeId);
        },
        cycleTab,
        toggleSidebar: () => patchUi({ sidebarOpen: !ui.sidebarOpen }),
        toggleOutline: () => patchUi({ outlineOpen: !ui.outlineOpen }),
        toggleAppearance,
        toggleTypewriter: () => patchUi({ typewriter: !ui.typewriter }),
        toggleFocus: () => patchUi({ focus: !ui.focus }),
        toggleWordCount: () => patchUi({ showWordCount: !ui.showWordCount }),
        openSettings: () => setSettingsOpen(true),
        openHistory: () => setHistoryOpen(true),
        openShortcuts: () => setShortcutsOpen(true),
        exportNote: (kind) => void exportNote(kind),
        exportLibrary: (kind) => void exportLibrary(kind),
        importFiles: (directory) => (directory ? dirInputRef.current : fileInputRef.current)?.click(),
        toggleStar: () => {
          if (!activeNote) return;
          setStarred(activeNote.id, !activeNote.starred);
          notify(activeNote.starred ? "已取消星标" : "已加星标");
        },
        duplicateNote: () => {
          if (!activeNote) return;
          createNote({ folderId: activeNote.folderId, content: activeNote.content, title: `${activeNote.title} 副本` });
        },
        trashNote: () => {
          if (!activeNote) return;
          trashNote(activeNote.id);
          notify(`「${activeNote.title}」已移入回收站`);
        },
        copyMarkdown: async () => {
          if (!activeNote) return;
          try {
            await navigator.clipboard.writeText(activeNote.content);
            notify("Markdown 已复制到剪贴板");
          } catch {
            notify("浏览器拒绝了剪贴板访问", { kind: "danger" });
          }
        },
        printNote: () => window.print(),
        setTheme: (theme: ThemeId) => applyTheme(theme),
        notify: (message) => notify(message),
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }),
    [activeId, activeNote, scope, ui.sidebarOpen, ui.outlineOpen, ui.typewriter, ui.focus, ui.showWordCount],
  );

  const commandsRef = useRef(commands);
  commandsRef.current = commands;

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const editable = isEditableTarget(event.target);
      for (const command of commandsRef.current) {
        if (!command.keys?.length) continue;
        const hasPlatformModifier = command.keys.some((spec) => spec.includes("mod") || spec.includes("ctrl"));
        if (editable && !hasPlatformModifier) continue;
        if (!command.keys.some((spec) => matchesShortcut(event, spec))) continue;
        if (command.enabled && !command.enabled()) continue;
        event.preventDefault();
        command.run();
        return;
      }
      if (event.key === "Escape") {
        setPalette(null);
        setSettingsOpen(false);
        setShortcutsOpen(false);
        setHistoryOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /* drag a markdown file anywhere onto the window to import it */
  useEffect(() => {
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!event.dataTransfer?.types.includes("Files")) return;
      depth += 1;
      setDropping(true);
    };
    const onOver = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDropping(false);
      if (event.defaultPrevented) return; // the editor already handled it
      const files = event.dataTransfer?.files;
      if (!files?.length) return;
      event.preventDefault();
      void importFiles(files);
    };
    window.addEventListener("dragenter", onEnter);
    window.addEventListener("dragover", onOver);
    window.addEventListener("dragleave", onLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onEnter);
      window.removeEventListener("dragover", onOver);
      window.removeEventListener("dragleave", onLeave);
      window.removeEventListener("drop", onDrop);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scope]);

  /* --------------------------------------------------------------- palette */

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const noteEntries: PaletteEntry[] = Object.values(library.notes)
      .filter((note) => !note.trashed)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500)
      .map((note) => ({
        id: `note:${note.id}`,
        kind: "note",
        title: note.title,
        sub: [folderPathLabel(note.folderId, library.folders), excerpt(note.content, 56)].filter(Boolean).join(" · "),
        icon: "note",
        keywords: `${note.tags.join(" ")} ${folderPathLabel(note.folderId, library.folders)}`,
        run: () => openNote(note.id),
      }));

    const commandEntries: PaletteEntry[] = commands
      .filter((command) => !command.enabled || command.enabled())
      .map((command) => ({
        id: `cmd:${command.id}`,
        kind: "command",
        title: command.label,
        sub: command.group,
        icon: command.icon,
        shortcut: command.shortcut,
        keywords: `${command.group} ${command.id}`,
        run: () => command.run(),
      }));

    const headingEntries: PaletteEntry[] = headings.map((heading, index) => ({
      id: `heading:${index}`,
      kind: "heading",
      title: heading.text,
      sub: `本页 · H${heading.level}`,
      icon: "outline",
      run: () => jumpToHeading(heading.pos),
    }));

    const tagEntries: PaletteEntry[] = tags.map(({ tag, count }) => ({
      id: `tag:${tag}`,
      kind: "tag",
      title: `#${tag}`,
      sub: `${count} 条笔记`,
      icon: "hash",
      run: () => {
        patchUi({ sidebarOpen: true });
        setTab("tags");
        setScope({ kind: "tag", tag });
      },
    }));

    return [...commandEntries, ...headingEntries, ...noteEntries, ...tagEntries];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [library.notes, library.folders, commands, headings, tags]);

  /* ---------------------------------------------------------------- render */

  const locationLabel = activeNote ? folderPathLabel(activeNote.folderId, library.folders) : "—";
  const counts = activeNote
    ? { chars: activeNote.chars, words: activeNote.words, minutes: Math.max(1, Math.round(activeNote.words / 300)) }
    : { chars: 0, words: 0, minutes: 0 };

  return (
    <div className={cn("app", dropping && "is-dropping", ui.sidebarOpen && "is-sidebar-open")}>
      <Sidebar
        library={library}
        ui={ui}
        scope={scope}
        tab={tab}
        activeId={activeId}
        storage={storage}
        onScope={setScope}
        onTab={setTab}
        onOpenNote={(id) => openNote(id)}
        onNewNote={(folderId) => newNote(folderId)}
        onNewFolder={(parentId) => void newFolder(parentId)}
        onOpenSettings={() => setSettingsOpen(true)}
        onCollapse={() => patchUi({ sidebarOpen: false })}
      />

      <button type="button" className="scrim--menu" aria-label="收起侧栏" onClick={() => patchUi({ sidebarOpen: false })} />

      <div className="main">
        <TabBar
          tabs={ui.tabs}
          notes={library.notes}
          activeId={activeId}
          dirty={library.dirty}
          onSelect={(id) => openNote(id)}
          onClose={closeTab}
          onNew={() => newNote()}
          onPalette={() => setPalette("all")}
          onContextMenu={(event, id) => {
            event.preventDefault();
            const note = library.notes[id];
            openMenu(event.clientX, event.clientY, [
              { id: "close", label: "关闭", icon: "close", run: () => closeTab(id) },
              {
                id: "close-others",
                label: "关闭其他标签",
                run: () => ui.tabs.filter((tabId) => tabId !== id).forEach((tabId) => closeTab(tabId)),
              },
              { id: "star", label: note?.starred ? "取消星标" : "加星标", icon: "star", run: () => note && setStarred(id, !note.starred) },
              {
                id: "export",
                label: "导出这篇笔记",
                icon: "download",
                separatorBefore: true,
                run: () => note && void exportNoteMarkdown(note),
              },
            ]);
          }}
        />

        {activeNote ? null : (
          <div className="empty">
            <div className="empty__inner">
              <div className="empty__seal">記</div>
              <h1 className="empty__title">Opennote</h1>
              <p className="empty__lede">
                纯前端的开源笔记：Markdown 存在你自己的浏览器里，
                <br />
                所见即所得地写，随时能整库带走。
              </p>
              <div className="empty__actions">
                <button type="button" className="btn btn--primary" onClick={() => newNote()}>
                  <Icon name="plus" size={14} />
                  新建笔记
                </button>
                <button type="button" className="btn" onClick={() => setPalette("all")}>
                  <Icon name="command" size={14} />
                  命令面板
                </button>
                <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
                  <Icon name="upload" size={14} />
                  导入 Markdown
                </button>
              </div>
              {Object.keys(library.notes).length ? (
                <div className="empty__recent">
                  <h4>最近编辑</h4>
                  {Object.values(library.notes)
                    .filter((note) => !note.trashed)
                    .sort((a, b) => b.updatedAt - a.updatedAt)
                    .slice(0, 5)
                    .map((note) => (
                      <button key={note.id} type="button" className="empty__recent-item" onClick={() => openNote(note.id)}>
                        <Icon name="note" size={13} />
                        <span className="truncate">{note.title}</span>
                        <time>{formatRelativeTime(note.updatedAt)}</time>
                      </button>
                    ))}
                </div>
              ) : null}
            </div>
          </div>
        )}

        <EditorPane
          noteId={activeId}
          content={activeNote?.content ?? ""}
          hidden={!activeNote}
          settings={ui}
          getTitles={() => Object.values(library.notes).filter((note) => !note.trashed).map((note) => note.title)}
          getTags={() => tags.map((entry) => entry.tag)}
          onDocChange={(doc) => {
            if (!activeId) return;
            updateNoteContent(activeId, doc);
          }}
          onCursor={setCursor}
          onSave={() => flushAll()}
          onReady={(view) => {
            viewRef.current = view;
          }}
        />

        <StatusBar
          counts={counts}
          dirty={activeId ? Boolean(library.dirty[activeId]) : false}
          savedLabel={library.lastSavedAt ? `已保存 · ${formatRelativeTime(library.lastSavedAt)}` : "已保存"}
          cursor={cursor}
          settings={ui}
          locationLabel={locationLabel}
          snapshotCount={snapshots.length}
          onToggle={(key) => patchUi({ [key]: !ui[key] } as Partial<UiSettings>)}
          onToggleAppearance={toggleAppearance}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
        />
      </div>

      <Outline
        headings={headings}
        currentIndex={currentHeading}
        open={ui.outlineOpen}
        onJump={jumpToHeading}
        onClose={() => patchUi({ outlineOpen: false })}
      />

      {palette ? <CommandPalette mode={palette} entries={paletteEntries} onClose={() => setPalette(null)} /> : null}
      {settingsOpen ? (
        <SettingsDialog
          settings={ui}
          storage={storage}
          onClose={() => setSettingsOpen(false)}
          onImport={(directory) => (directory ? dirInputRef.current : fileInputRef.current)?.click()}
          onExport={(kind) => void exportLibrary(kind)}
          onWipe={() => void wipe()}
          onShortcuts={() => setShortcutsOpen(true)}
        />
      ) : null}
      {historyOpen && activeId ? (
        <HistoryDialog
          noteId={activeId}
          onClose={() => {
            setHistoryOpen(false);
            void listSnapshots(activeId).then(setSnapshots);
          }}
        />
      ) : null}
      {shortcutsOpen ? <ShortcutsDialog onClose={() => setShortcutsOpen(false)} /> : null}

      <MenuHost />
      <DialogHost />
      <Toasts />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept=".md,.markdown,.txt,.text,.zip,.json,image/*"
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) void importFiles(files);
          event.target.value = "";
        }}
      />
      <input
        ref={dirInputRef}
        type="file"
        multiple
        hidden
        // @ts-expect-error — non-standard but supported by Chromium/WebKit
        webkitdirectory=""
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) void importFiles(files);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

function positionOfLine(markdown: string, line: number): number {
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line) {
    const next = markdown.indexOf("\n", offset);
    if (next < 0) return markdown.length;
    offset = next + 1;
    current += 1;
  }
  return offset;
}
