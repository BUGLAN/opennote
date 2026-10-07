import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { EditorView } from "@codemirror/view";
import {
  allTags,
  closeTab,
  createFolder,
  createNote,
  cycleTab,
  flushAll,
  flushForClose,
  flushMeta,
  folderPathLabel,
  initLibrary,
  listSnapshots,
  libraryStore,
  openNote,
  openWorkspace,
  reconcileTabs,
  rescanWorkspace,
  seedWelcome,
  setSidebarTab,
  setStarred,
  trashNote,
  updateNoteContent,
  useLibrary,
  watchLibraryErrors,
} from "./data/library";
import { WELCOME_CONTENT } from "./data/welcome";
import {
  WorkspacePermissionError,
  addLocalFolder,
  createBrowserWorkspace,
  forgetWorkspace,
  listWorkspaces,
  useWorkspaces,
  type WorkspaceRecord,
} from "./data/workspaces";
import { hasLegacyData } from "./data/legacy";
import {
  commitInboxResult,
  discardInbox,
  inboxCount,
  refreshInbox,
  startInboxWatch,
  stopInboxWatch,
  listInbox,
} from "./data/inbox";
import { findImportLogEntry, readImportIndex, readImportLog } from "./data/importLog";
import {
  receiveEnvelopeOutcome,
  setImportChannelContext,
  setImportLandingPreference,
  setImportNotifications,
  undoImport,
  type ImportUndoResult,
  type ImportReceipt,
} from "./lib/clip";
import { importFilesIntoOpfs, pickFiles, supportsFileSystemAccess, supportsOpfs } from "./fs";
import { desktopBridge, type ImportOutcome } from "./desktop/bridge";
import { patchUi, setTheme as applyTheme, toggleAppearance, useUi } from "./data/ui";
import type { Id, Snapshot, ThemeId, UiSettings } from "./data/types";
import { buildAppCommands, isEditableTarget, matchesShortcut } from "./lib/appCommands";
import { askConfirm, askText } from "./lib/dialogs";
import { exportNoteHtml, exportNoteMarkdown, exportWorkspaceZip } from "./lib/export";
import { importIntoWorkspace, migrateLegacyData } from "./lib/import";
import { copyImage } from "./lib/imageClipboard";
import { extractHeadings, findCurrentHeading } from "./lib/outline";
import { copyPathToClipboard, noteAbsolutePath } from "./lib/notePath";
import { notify } from "./lib/toast";
import { cn, formatRelativeTime } from "./lib/utils";
import { CommandPalette, type PaletteEntry } from "./components/CommandPalette";
import { EditorPane, type CursorInfo } from "./components/EditorPane";
import { HistoryDialog, SettingsDialog, ShortcutsDialog, type SettingsSectionId } from "./components/AppDialogs";
import { Icon } from "./components/Icons";
import { InboxPanel } from "./components/InboxPanel";
import { ConflictDialogHost, installImportConflictDialog, uninstallImportConflictDialog } from "./components/ConflictDialog";
import { DialogHost, MenuHost, Toasts, openMenu } from "./components/Overlays";
import { Outline } from "./components/Outline";
import { Sidebar, currentFolderId, type Scope } from "./components/Sidebar";
import { SidebarResizer } from "./components/SidebarResizer";
import { StatusBar } from "./components/StatusBar";
import { TabBar } from "./components/TabBar";
import { setBridge } from "./editor/bridge";

export default function App(): ReactNode {
  const library = useLibrary();
  const ui = useUi();
  const registry = useWorkspaces();

  const viewRef = useRef<EditorView | null>(null);
  const [scope, setScope] = useState<Scope>({ kind: "all" });
  // D27: the sidebar tab is real state — it lives in the UI settings and in the
  // notebook's state.json, so it survives a reload (see `setSidebarTab`).
  const tab = ui.sidebarTab;
  const setTab = setSidebarTab;
  const [cursor, setCursor] = useState<CursorInfo>({ line: 1, column: 1, selected: 0 });
  const [palette, setPalette] = useState<null | "all" | "commands">(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  /** 从命令面板 / `opennote://settings/import` 直接落到「导入与接口」。 */
  const [settingsSection, setSettingsSection] = useState<SettingsSectionId | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [dropping, setDropping] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [needsPermission, setNeedsPermission] = useState<WorkspaceRecord | null>(null);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [inboxPending, setInboxPending] = useState(0);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // 回收站里的笔记也可以正常打开、就地编辑（它住在 `library.trash`，路径仍是
  // `.opennote/trash/…`）—— active 所以要能在两个桶里都找得到。
  const activeId = ui.activeId && (library.notes[ui.activeId] || library.trash[ui.activeId]) ? ui.activeId : null;
  const activeNote = activeId ? library.notes[activeId] ?? library.trash[activeId] : null;
  const deferredContent = useDeferredValue(activeNote?.content ?? "");
  const hasWorkspace = Boolean(library.workspace);
  const bridge = useMemo(() => desktopBridge(), []);

  const headings = useMemo(() => extractHeadings(deferredContent), [deferredContent]);
  const currentHeading = useMemo(
    () => findCurrentHeading(headings, positionOfLine(deferredContent, cursor.line)),
    [headings, cursor.line, deferredContent],
  );
  const tags = useMemo(() => allTags(library), [library]);
  const workspaces = useMemo(() => listWorkspaces(), [registry]);

  /* ------------------------------------------------------------- lifecycle */

  useEffect(() => {
    void initLibrary();
  }, []);

  // D11: the desktop shell asks before it closes the window, so the last ≤450ms
  // of typing still reach the disk (flushAll, then the metadata). `flushForClose`
  // never rejects, and the main process gives up waiting after ~1.5s — the window
  // can never hang on this. Packaged preloads older than this hook simply have no
  // `onFlushRequest`, and browsers never see the event at all.
  useEffect(() => {
    const app = bridge?.app;
    if (typeof app?.onFlushRequest !== "function") return;
    return app.onFlushRequest(() => {
      void flushForClose().finally(() => app.flushDone());
    });
  }, [bridge]);

  useEffect(() => {
    if (!library.ready) return;
    reconcileTabs();
    const boot = document.getElementById("boot");
    if (boot) {
      boot.classList.add("is-gone");
      setTimeout(() => boot.remove(), 400);
    }
  }, [library.ready]);

  useEffect(() => watchLibraryErrors((message) => notify(message, { kind: "danger" })), []);

  /* ------------------------------------------------------- 导入与收件箱接线 */
  //
  // 三条不变式（见 electron/main.cjs 的同名注释）：
  //   1) 落盘只发生在渲染层。桥把信封转交上来，这里算完把结构化回执交回去——
  //      主进程不写正文，否则会被 rescanWorkspace() 起始的 flushAll() 覆盖。
  //   2) 回执**永不抛异常**：ipcMain.handle 会把异常退化成字符串，code/http 会丢，
  //      桥就没法把 IMP-4008 映射成 422。所以这里用 receiveEnvelopeOutcome()。
  //   3) 窗口不在场/渲染层不回，由主进程侧超时报 IMP-4006，绝不假成功。

  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.onImportReceipt !== "function") return;
    return api.onImportReceipt(({ reqId, envelope }) => {
      void (async () => {
        let outcome: ImportOutcome;
        try {
          /**
           * **必须先声明通道**（00 号 §6.13⑧ 原话：「本地桥转交前设 `local-bridge`」）。
           * 这里是全仓**唯一**消费 `onImportReceipt` 的地方；不声明的话通道会停在模块
           * 默认的 `"in-app"`，于是两件事同时静默失效：
           *   1. 0.3.0 默认的「外部导入先进收件箱」（㉕）—— `isExternalDeliveryChannel("in-app")`
           *      为 false，强制 `pending` 分支被跳过，外部剪藏会**直接写进笔记本**；
           *   2. `overwrite` 的通道闸门（`receive.ts` 要求 `channel === "local-bridge"`）
           *      永不成立 —— 设置里那个开关变成假开关。
           * 同一个根因、两个假开关，而两侧单测都是绿的（测试自己会声明通道）。
           */
          setImportChannelContext({ channel: "local-bridge" });
          outcome = await receiveEnvelopeOutcome(envelope);
        } catch (error) {
          // receiveEnvelopeOutcome 理论上不抛；真抛了也只能如实报 500，不能假装成功。
          outcome = {
            ok: false,
            error: {
              code: "IMP-5001",
              message: error instanceof Error ? error.message : String(error),
              userMessage: "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
              http: 500,
              retryable: true,
            },
          };
        }
        api.import.replyToImport(reqId, outcome);
      })();
    });
  }, [bridge]);

  /**
   * 主进程转交的其余导入/收件箱操作。只有一份实现（就是这里的 data/*），
   * 主进程只是转发——两处各写一份读写逻辑必然漂移。
   */
  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.onImportRequest !== "function") return;
    return api.onImportRequest(({ reqId, op, args }) => {
      void (async () => {
        try {
          let result: unknown = null;
          if (op === "recent") {
            // 标题/客户端只在幂等索引里（导入日志按契约只有落点与错误码）。
            const index = await readImportIndex();
            const limit = typeof args?.limit === "number" ? args.limit : 20;
            result = index.slice(0, limit).map((entry) => ({
              importId: entry.importId,
              path: entry.path,
              title: entry.title,
              client: entry.client,
              action: entry.action,
              at: entry.at,
            }));
          } else if (op === "log") {
            const entries = await readImportLog();
            result = typeof args?.limit === "number" ? entries.slice(0, args.limit) : entries;
          } else if (op === "undo") {
            result = await undoImportById(String(args?.importId ?? ""));
          } else if (op === "inboxList") {
            result = await listInbox();
          } else if (op === "inboxCommit") {
            // 契约要求回 `ImportResult`；Entry 已入库时 `null`（幂等），不算失败。
            // 落点覆盖（00 §6.14㉜）：**「缺 folder 键」与「folder: null」必须区分** ——
            // 前者沿用信封的 target.folder（0.2.0 行为），后者明确要求存到工作区根。
            const id = String(args?.id ?? "");
            const hasFolder = Boolean(args) && Object.prototype.hasOwnProperty.call(args, "folder");
            result = await commitInboxResult(
              id,
              hasFolder ? { folder: (args as { folder?: string | null } | undefined)?.folder ?? null } : undefined,
            );
          } else if (op === "inboxDiscard") {
            await discardInbox(String(args?.id ?? ""));
            result = null;
          } else {
            throw Object.assign(new Error(`未知的导入操作：${String(op)}`), { code: "IMP-4014" });
          }
          api.import.replyToImport(reqId, { ok: true, result });
        } catch (error) {
          const shaped = error as { code?: unknown; userMessage?: unknown };
          const code = typeof shaped?.code === "string" ? shaped.code : "IMP-5001";
          const userMessage =
            typeof shaped?.userMessage === "string"
              ? shaped.userMessage
              : "导入时出现了内部错误，已记录日志。请重试一次。";
          api.import.replyToImport(reqId, {
            ok: false,
            error: {
              code,
              message: error instanceof Error ? error.message : String(error),
              userMessage,
              http: code.startsWith("IMP-4") ? 422 : 500,
              retryable: true,
            },
          });
        }
      })();
    });
  }, [bridge]);

  // R2「入库后提示」：关掉后只是不打扰，导入日志照写。
  useEffect(() => {
    setImportNotifications(ui.importNotify);
  }, [ui.importNotify]);

  // R8「记录本地接口日志」：真实行为在主进程（决定是否往 bridge.log 落行）。
  // 启动时也要推一次，否则用户上次关掉的开关会在重启后悄悄失效。
  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.bridge?.setLogEnabled !== "function") return;
    void api.bridge.setLogEnabled({ enabled: ui.bridgeLog }).catch(() => undefined);
  }, [bridge, ui.bridgeLog]);

  // 交付模式（00 号 §6.14㉕）：`ui.importConflict` 是**应用侧用户的显式意愿**，
  // 必须同时到达两个地方——接收端（决定这次导入进不进收件箱）与本地桥
  // （`/v1/health` 的 `inboxMode`，让客户端知道会发生什么，而不是猜）。
  useEffect(() => {
    setImportLandingPreference(ui.importConflict);
  }, [ui.importConflict]);

  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.bridge?.setInboxMode !== "function") return;
    const mode = ui.importConflict === "inbox" ? "inbox" : "direct";
    void api.bridge.setInboxMode({ mode }).catch(() => undefined);
  }, [bridge, ui.importConflict]);

  // UI-06 冲突对话框：L2 接收端遇到第 5 步 pending 冲突时回调这里。
  // 卸载时立刻 settle，避免接收端永远等一个已经不在的对话框。
  useEffect(() => {
    installImportConflictDialog();
    return () => uninstallImportConflictDialog();
  }, []);

  // 收件箱变更检测：桌面端用主进程的独立 watcher（`.opennote/**` 被工作区
  // watcher 跳过，所以必须是另一条链路）；浏览器后端退化为轮询。
  //
  // 保留期清理（打开扫一遍 + 每 6 小时一次）已包含在 `startInboxWatch()` 里，
  // 这里不再重复挂定时器。`stopInboxWatch()` 同时清空视图，换笔记本不会留旧计数。
  useEffect(() => {
    if (!library.workspace) return;
    startInboxWatch();
    return () => stopInboxWatch();
  }, [library.workspace]);

  // `opennote://` 深链（00 号 §6.14㉛）：未实现/非法的链接由主进程弹系统对话框
  // 如实告知，**不会走到这里**，所以这里只处理两条已实现的路由。
  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.onDeepLink !== "function") return;
    return api.onDeepLink((link) => {
      if (!link || link.ok !== true) return;
      if (link.kind === "settings") {
        // API-11：打开「设置 · 文件 · 导入与接口」（02 号定为 P0）。
        setSettingsSection("文件");
        setSettingsOpen(true);
        return;
      }
      if (link.kind === "open") {
        // API-12：打开一篇笔记。路径的合法性已在主进程判过（含越权拒绝），
        // 这里仍走正常打开路径，路径不存在时由 openNote 自己如实失败。
        openNote(link.path);
      }
    });
  }, [bridge, openNote]);

  /*
   * 入库完成后的刷新：**不订阅 `opennote:import:notice`** —— 主进程从来没有发过它的发送方，
   * 而它想做的三件事都已经各有产地（判读见 `docs/import/00-项目简报与范围锁定.md`）：
   *   ① 文件变化后重扫 → `opennote:fs:workspace-changed`（`library.ts:startWatching`，去抖重扫）
   *   ② 收件箱徽标与列表 → 下面的 `opennote:inbox:changed`（`.opennote/**` 被工作区 watcher
   *      跳过，所以那是一条独立链路，main.cjs 确实在发）
   *   ③ 成功提示与撤销入口 → L2 的 `announce()`（`src/lib/clip/receive.ts`，唯一一份实现）
   * 唯一没有产地的是「自动打开刚入库的那条笔记」——那是个没人要求的功能，**不为了让门禁
   * 变绿把它补上**（而且默认落点是收件箱，条目还没有 `path`，补了也只会是一条不发的分支）。
   */

  // 收件箱目录变化（主进程独立 watcher，去抖 450ms）。
  useEffect(() => {
    const api = bridge;
    if (!api || typeof api.onInboxChanged !== "function") return;
    return api.onInboxChanged((changed) => {
      if (!changed || typeof changed.pending !== "number") return;
      setInboxPending(changed.pending);
      void refreshInbox().catch(() => undefined);
    });
  }, [bridge]);

  // 打开工作区后把收件箱计数拉起来（徽标不能等到第一次变动才出现）。
  useEffect(() => {
    if (!library.workspace) {
      setInboxPending(0);
      return;
    }
    void refreshInbox()
      .then(() => setInboxPending(inboxCount()))
      .catch(() => undefined);
  }, [library.workspace]);

  useEffect(() => {
    const timer = setInterval(() => { void flushAll().catch(() => undefined); }, 20_000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    document.title = activeNote ? `${activeNote.title} · Opennote` : "Opennote · 开源笔记";
  }, [activeNote]);

  // 无边框标题栏：窗口按钮的底色跟随当前主题，避免亮色按钮压在暗色界面上。
  useEffect(() => {
    if (!bridge) return;
    const frame = requestAnimationFrame(() => {
      const style = getComputedStyle(document.documentElement);
      const color = style.getPropertyValue("--paper-2").trim() || "#fbf8f3";
      const symbolColor = style.getPropertyValue("--ink-3").trim() || "#97897a";
      void bridge.window.setTitleBarOverlay({ color, symbolColor }).catch(() => undefined);
    });
    return () => cancelAnimationFrame(frame);
  }, [bridge, ui.appearance, ui.theme, ui.accent]);

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

  /* offer a one-time migration of notes written by the IndexedDB version */
  const migrationOffered = useRef(false);
  useEffect(() => {
    if (!hasWorkspace || migrationOffered.current) return;
    migrationOffered.current = true;
    void hasLegacyData().then((found) => {
      if (!found) return;
      notify("检测到旧版本存在浏览器里的笔记", {
        duration: 12_000,
        action: {
          label: "导入笔记本",
          run: () => {
            void migrateLegacyData()
              .then((result) => notify(`已导入 ${result.notes} 条旧笔记`))
              .catch((error) => notify(error instanceof Error ? error.message : "导入失败", { kind: "danger" }));
          },
        },
      });
    });
  }, [hasWorkspace]);

  /* the editor talks back to the app through a small bridge */
  useEffect(() => {
    return setBridge({
      openWikiLink: (title) => {
        const match = Object.values(library.notes).find((note) => note.title === title);
        if (match) {
          openNote(match.id);
          return;
        }
        createNote({ folderId: currentFolderId(scope), content: `# ${title}\n\n`, title });
        notify(`已创建《${title}》`);
      },
      notify: (message) => notify(message),
      hasNote: (title) => Object.values(library.notes).some((note) => note.title === title),
      imageMode: () => ui.imageMode,
      // 右键图片：编辑器把「哪张图、属于哪篇笔记」交出来，菜单与剪贴板都留在这一层。
      // 只有一项，但它是唯一入口 —— 不给图片挂上原生菜单的桌面壳里，右键原本什么都不发生。
      openImageMenu: (x, y, target) => {
        openMenu(x, y, [
          {
            id: "copy-image",
            label: "复制图片",
            icon: "copy",
            run: () => {
              void copyImage(target).then((result) => {
                if (result.ok) notify("图片已复制到剪贴板");
                else notify(result.message, { kind: "danger" });
              });
            },
          },
        ]);
      },
    });
  }, [library.notes, scope, ui.imageMode]);

  /* --------------------------------------------------------- workspace flow */

  const openRecord = async (record: WorkspaceRecord, requestPermission = false) => {
    setBusy(`正在打开「${record.name}」…`);
    try {
      await openWorkspace(record, { requestPermission });
      setScope({ kind: "all" });
      setTab("files");
      // a brand-new notebook gets the welcome note so the first screen is not blank
      if (Object.keys(libraryStore.get().notes).length === 0) {
        await seedWelcome(WELCOME_CONTENT);
        await rescanWorkspace();
      }
      notify(`已打开「${record.name}」`);
    } catch (error) {
      if (error instanceof WorkspacePermissionError) {
        setNeedsPermission(record);
        return;
      }
      notify(error instanceof Error ? error.message : "打开笔记本失败", { kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const openLocalFolder = async () => {
    try {
      const record = await addLocalFolder();
      if (record) await openRecord(record);
    } catch (error) {
      notify(error instanceof Error ? error.message : "选择文件夹失败", { kind: "danger" });
    }
  };

  const newBrowserWorkspace = async () => {
    const name = await askText({
      title: "新建浏览器笔记本",
      label: "笔记本名称",
      value: "我的笔记",
      note: supportsFileSystemAccess()
        ? "笔记会存在浏览器自己的文件系统里（OPFS），随时可以导出成 zip 带走。"
        : "当前浏览器不支持直接读写磁盘，笔记会存在浏览器文件系统里，随时可以导出成 zip。",
      confirmLabel: "创建",
    });
    if (!name) return;
    const record = await createBrowserWorkspace(name);
    await openRecord(record);
  };

  const uploadFolderToBrowser = async () => {
    const files = await pickFiles({ directory: true });
    if (!files?.length) return;
    const first = (files[0] as File & { webkitRelativePath?: string }).webkitRelativePath || "";
    const rootName = first.split("/")[0] || "导入的笔记本";
    setBusy(`正在导入「${rootName}」…`);
    try {
      const record = await createBrowserWorkspace(rootName);
      const result = await importFilesIntoOpfs(files, record.location);
      await openRecord(record);
      notify(`已导入 ${result.files} 个文件到浏览器本地${result.skipped ? `，跳过 ${result.skipped} 个` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入文件夹失败", { kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const closeCurrentWorkspace = async () => {
    const ok = await askConfirm({
      title: `关闭「${library.workspace?.name}」？`,
      message: "笔记不会被删除，只是从 Opennote 里移除这个位置。",
      note: "文件仍然在原来的文件夹里，随时可以重新打开。",
      confirmLabel: "关闭",
    });
    if (!ok || !library.workspace) return;
    try {
      await flushAll();
      await flushMeta();
    } catch {
      notify("笔记还没有写入磁盘，已取消关闭笔记本", { kind: "danger" });
      return;
    }
    await forgetWorkspace(library.workspace.id);
    const next = listWorkspaces()[0];
    if (next) await openRecord(next);
    else window.location.reload();
  };

  /* --------------------------------------------------------------- actions */

  const importFiles = async (files: FileList | File[]) => {
    setBusy("正在导入…");
    try {
      const result = await importIntoWorkspace(files, currentFolderId(scope));
      const parts = [`${result.notes} 篇笔记`, `${result.folders} 个文件夹`, `${result.attachments} 个附件`];
      notify(`导入完成：${parts.filter((part) => !part.startsWith("0 ")).join("、")}${result.skipped ? `，跳过 ${result.skipped} 项` : ""}`);
    } catch (error) {
      notify(error instanceof Error ? error.message : "导入失败", { kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  const newNote = (folderId?: Id | null) => {
    if (!hasWorkspace) return;
    const note = createNote({ folderId: folderId === undefined ? currentFolderId(scope) : folderId, content: "" });
    notify("已新建笔记", { action: { label: "移到回收站", run: () => trashNote(note.id) } });
    requestAnimationFrame(() => viewRef.current?.focus());
  };

  const newFolder = async (parentId?: Id | null) => {
    if (!hasWorkspace) return;
    const name = await askText({ title: "新建文件夹", label: "文件夹名称", placeholder: "例如：读书笔记", confirmLabel: "创建" });
    if (!name) return;
    const folder = createFolder(name, parentId === undefined ? currentFolderId(scope) : parentId);
    setScope({ kind: "folder", id: folder.id });
  };

  const jumpToHeading = (pos: number) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: "center" }) });
    view.focus();
  };

  const exportNote = async (kind: "md" | "md-inline" | "html") => {
    if (!activeNote) return;
    try {
      if (kind === "html") await exportNoteHtml(activeNote);
      else await exportNoteMarkdown(activeNote, { inlineAssets: kind === "md-inline" });
      notify("导出完成");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败", { kind: "danger" });
    }
  };

  const exportLibrary = async () => {
    setBusy("正在打包…");
    try {
      await exportWorkspaceZip();
      notify("备份已导出");
    } catch (error) {
      notify(error instanceof Error ? error.message : "导出失败", { kind: "danger" });
    } finally {
      setBusy(null);
    }
  };

  /* ------------------------------------------------------------- commands */

  const commands = useMemo(
    () =>
      buildAppCommands({
        view: () => viewRef.current,
        hasWorkspace: () => hasWorkspace,
        newNote,
        newFolder: () => void newFolder(),
        openPalette: (mode) => setPalette(mode),
        openSearch: () => {
          patchUi({ sidebarOpen: true });
          setTab("search");
        },
        saveNow: () => {
          void rescanWorkspace()
            .then(() => notify("已与磁盘同步"))
            .catch(() => notify("磁盘写入失败，笔记未同步", { kind: "danger" }));
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
        openInbox: () => setInboxOpen(true),
        openImportSettings: () => {
          // 设计稿把「导入与接口」放在「文件」分类里，所以落到「文件」栏。
          setSettingsSection("文件");
          setSettingsOpen(true);
        },
        exportNote: (kind) => void exportNote(kind),
        exportLibrary: () => void exportLibrary(),
        importFiles: () => fileInputRef.current?.click(),
        openWorkspace: () => setSwitcherOpen(true),
        openLocalFolder: () => void openLocalFolder(),
        newBrowserWorkspace: () => void newBrowserWorkspace(),
        uploadFolder: () => void uploadFolderToBrowser(),
        closeWorkspace: () => void closeCurrentWorkspace(),
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
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [activeId, activeNote, scope, hasWorkspace, ui.sidebarOpen, ui.outlineOpen, ui.typewriter, ui.focus, ui.showWordCount],
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
        setSwitcherOpen(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /*
   * 原生菜单：**这里是将来恢复菜单时的接入点**，现在刻意不接。
   *
   * `main.cjs` 的 `installApplicationMenu()` 在非 darwin 上 `Menu.setApplicationMenu(null)`，
   * darwin 上只装纯 role 的最小菜单（注释写明「不额外增加自定义项」）⇒ 菜单栏是被**故意
   * 移除**的，主进程从不下发 `opennote:menu`。原先这里挂着一个 `bridge.onMenu(...)`
   * 的订阅映射（13 个命令），**听了没人发** —— `verify-contract.cjs` 的 C-12c 死订阅判据
   * 咬的就是它。补一个发送方等于把「被移除的菜单栏」偷偷加回来，不是我们想要的。
   * 若将来恢复：主进程 `webContents.send('opennote:menu', command)` + preload
   * `subscribe('opennote:menu', cb)` + 这里重建映射表，**三处一起**。
   */

  /* dropping files anywhere imports them into the open workspace */
  useEffect(() => {
    let depth = 0;
    const onEnter = (event: DragEvent) => {
      if (!hasWorkspace || !event.dataTransfer?.types.includes("Files")) return;
      depth += 1;
      setDropping(true);
    };
    const onOver = (event: DragEvent) => {
      if (event.defaultPrevented) return;
      if (hasWorkspace && event.dataTransfer?.types.includes("Files")) event.preventDefault();
    };
    const onLeave = () => {
      depth = Math.max(0, depth - 1);
      if (!depth) setDropping(false);
    };
    const onDrop = (event: DragEvent) => {
      depth = 0;
      setDropping(false);
      if (event.defaultPrevented || !hasWorkspace) return;
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
  }, [scope, hasWorkspace]);

  /* --------------------------------------------------------------- palette */

  const paletteEntries = useMemo<PaletteEntry[]>(() => {
    const noteEntries: PaletteEntry[] = Object.values(library.notes)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 500)
      .map((note) => ({
        id: `note:${note.id}`,
        kind: "note",
        title: note.title,
        sub: [folderPathLabel(note.folderId, library.folders), note.tags.join(" ")].filter(Boolean).join(" · "),
        icon: "note",
        keywords: `${note.tags.join(" ")} ${note.id}`,
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
      sub: `${count} 篇笔记`,
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
  const workspaceName = library.workspace?.name ?? "";

  return (
    <div className={cn("app", bridge && "app--desktop", dropping && "is-dropping", ui.sidebarOpen && "is-sidebar-open")}>
      <Sidebar
        library={library}
        ui={ui}
        scope={scope}
        tab={tab}
        activeId={activeId}
        workspace={library.workspace}
        workspaces={workspaces}
        switcherOpen={switcherOpen}
        onSwitcherOpen={setSwitcherOpen}
        onScope={setScope}
        onTab={setTab}
        onOpenNote={(id) => openNote(id)}
        onNewNote={(folderId) => newNote(folderId)}
        onNewFolder={(parentId) => void newFolder(parentId)}
        onOpenSettings={() => setSettingsOpen(true)}
        onToggleSidebar={() => patchUi({ sidebarOpen: !ui.sidebarOpen })}
        onOpenWorkspace={(record) => void openRecord(record)}
        onAddLocalFolder={() => void openLocalFolder()}
        onNewBrowserWorkspace={() => void newBrowserWorkspace()}
        onUploadFolder={() => void uploadFolderToBrowser()}
        onCloseWorkspace={() => void closeCurrentWorkspace()}
        supportsLocalFolder={Boolean(bridge) || supportsFileSystemAccess()}
        supportsBrowserWorkspace={supportsOpfs()}
        inboxPending={inboxPending}
        onOpenInbox={() => setInboxOpen(true)}
      />

      {/* 移动端抽屉的遮罩：`scrim--drawer` 让它让开顶行（头部一直可用）。
          桌面端这条按钮被 `display: none` 关着，只有 ≤820px 打开抽屉时才显形。 */}
      <button
        type="button"
        className="scrim--menu scrim--drawer"
        aria-label="收起侧栏"
        onClick={() => patchUi({ sidebarOpen: false })}
      />

      {/* 侧栏宽度的拖拽把手。它是 `.app` 栅格里的**独立一列**（0 宽，骑在侧栏右边框上），
          不是 `.sidebar` 的子元素：侧栏有 `overflow: hidden`，把把手放进去会盖住树自己的
          滚动条，滚动条就抓不住了。 */}
      <SidebarResizer
        width={ui.sidebarWidth}
        disabled={!ui.sidebarOpen}
        onCommit={(sidebarWidth) => patchUi({ sidebarWidth })}
      />

      {/* 标签栏是**顶行**的一项（和侧栏头部同一行）：这样收起左栏时，编辑器与状态栏
          能在它下面绕到最左边占满整宽，而标签栏本身不移动（见 app.css 的栅格分区）。 */}
      {hasWorkspace ? (
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
              // 回收站里打开的笔记没有 `library.notes[id]`：加星标只对普通笔记有意义
              //（`starredNotes()` 只看 notes），所以那一项只在普通笔记上出现，
              // 不给一颗点了没反应的死菜单项。
              const note = library.notes[id] ?? library.trash[id];
              openMenu(event.clientX, event.clientY, [
                { id: "close", label: "关闭", icon: "close", run: () => closeTab(id) },
                {
                  id: "close-others",
                  label: "关闭其他标签",
                  // 与「关闭」同一族的 × ：动作一样是关标签，靠文案区分（VS Code 的 Close / Close Others
                  // 也是同一颗 ×）。不给新图标 —— `DESIGN.md` 明写「缺图标先讨论，不要引入新图标集」。
                  icon: "close",
                  run: () => ui.tabs.filter((tabId) => tabId !== id).forEach((tabId) => closeTab(tabId)),
                },
                ...(library.notes[id]
                  ? [
                      {
                        id: "star",
                        label: note?.starred ? "取消星标" : "加星标",
                        icon: "star" as const,
                        run: () => note && setStarred(id, !note.starred),
                      },
                    ]
                  : []),
                {
                  id: "copy-path",
                  label: "复制地址",
                  icon: "link",
                  separatorBefore: true,
                  // 浏览器 / OPFS 笔记本没有本机绝对路径（见 `lib/notePath.ts`）：
                  // 禁用，而不是给一个点了没反应的死菜单项。
                  disabled: noteAbsolutePath(library.workspace, id) === null,
                  run: () => void copyPathToClipboard(library.workspace, id),
                },
                {
                  id: "reveal",
                  label: "在文件夹中显示",
                  icon: "external",
                  disabled: !bridge || library.workspace?.kind !== "node",
                  run: () => {
                    const absolute = noteAbsolutePath(library.workspace, id);
                    if (bridge && absolute) void bridge.shell.showItemInFolder(absolute);
                  },
                },
                {
                  id: "export",
                  label: "导出这篇笔记",
                  icon: "download",
                  run: () => note && void exportNoteMarkdown(note),
                },
              ]);
            }}
          />
        ) : null}

      <div className="main">
        {hasWorkspace && activeNote ? null : hasWorkspace ? (
          <div className="empty">
            <div className="empty__inner">
              <div className="empty__seal">記</div>
              <h1 className="empty__title">{workspaceName}</h1>
              <p className="empty__lede">
                这个文件夹里还没有打开的笔记。
                <br />
                按 Ctrl/⌘ + N 新建一篇，或者从左侧文件树里挑一条。
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
            </div>
          </div>
        ) : (
          <WelcomeScreen
            workspaces={workspaces}
            busy={busy}
            supportsLocalFolder={Boolean(bridge) || supportsFileSystemAccess()}
            supportsBrowserWorkspace={supportsOpfs()}
            onOpen={(record) => void openRecord(record)}
            onAddLocal={() => void openLocalFolder()}
            onNewBrowser={() => void newBrowserWorkspace()}
            onUpload={() => void uploadFolderToBrowser()}
          />
        )}

        <EditorPane
          noteId={activeId}
          content={activeNote?.content ?? ""}
          hidden={!activeNote}
          /*
           * 这里**不再**传 `baseDir`：`noteId` 本身就是笔记的工作区相对路径，而
           * 附件目录、图片相对引用的基准都能从它派生（`EditorPane` 内部派生）。
           * 再传一个同样由 `activeNote.id` 算出来的 `baseDir`，就是**同一个事实的第二个产地** ——
           * 两边一旦漂移（例如附件目录改成 `<笔记名>.assets/`），就会出现「写图的目录」
           * 与「读图的基准」不是一个东西，而类型都是 `string`，编译期一个字都不报。
           */
          settings={ui}
          getTitles={() => Object.values(library.notes).map((note) => note.title)}
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
          savedLabel={library.lastSavedAt ? `已写入磁盘 · ${formatRelativeTime(library.lastSavedAt)}` : "已写入磁盘"}
          cursor={cursor}
          settings={ui}
          locationLabel={locationLabel}
          snapshotCount={snapshots.length}
          storageLabel={library.workspace ? storageLabel(library.workspace) : "未打开笔记本"}
          stats={library.stats}
          onToggle={(key) => patchUi({ [key]: !ui[key] } as Partial<UiSettings>)}
          onToggleAppearance={toggleAppearance}
          onOpenHistory={() => setHistoryOpen(true)}
          onOpenSettings={() => setSettingsOpen(true)}
          inboxPending={inboxPending}
          onOpenInbox={() => setInboxOpen(true)}
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
          workspace={library.workspace}
          stats={library.stats}
          commands={commands}
          onRunCommand={(id) => commandsRef.current.find((command) => command.id === id)?.run()}
          onClose={() => {
            setSettingsOpen(false);
            setSettingsSection(null);
          }}
          onImport={() => fileInputRef.current?.click()}
          onExport={() => void exportLibrary()}
          onOpenLocalFolder={() => void openLocalFolder()}
          onCloseWorkspace={() => void closeCurrentWorkspace()}
          onMigrateLegacy={() => {
            void migrateLegacyData()
              .then((result) => notify(`已导入 ${result.notes} 条旧笔记`))
              .catch((error) => notify(error instanceof Error ? error.message : "导入失败", { kind: "danger" }));
          }}
          onShortcuts={() => setShortcutsOpen(true)}
          initialSection={settingsSection ?? undefined}
          isDesktop={Boolean(bridge)}
          onOpenInbox={() => {
            setSettingsOpen(false);
            setInboxOpen(true);
          }}
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
      {/* UI-03：外部导入的待确认内容。入库走 L2 接收端，落盘始终在渲染层。 */}
      <InboxPanel
        open={inboxOpen}
        onClose={() => {
          setInboxOpen(false);
          setInboxPending(inboxCount());
        }}
        onOpenNote={(path) => openNote(path)}
      />
      {needsPermission ? (
        <PermissionDialog
          record={needsPermission}
          onClose={() => setNeedsPermission(null)}
          onGrant={async () => {
            const record = needsPermission;
            setNeedsPermission(null);
            await openRecord(record, true);
          }}
        />
      ) : null}
      {busy ? (
        <div className="busy" role="status">
          <span className="busy__spinner" />
          {busy}
        </div>
      ) : null}

      <MenuHost />
      <DialogHost />
      <ConflictDialogHost />
      <Toasts />

      <input
        ref={fileInputRef}
        type="file"
        multiple
        hidden
        accept=".md,.markdown,.txt,.text,.zip,image/*"
        onChange={(event) => {
          const files = event.target.files;
          if (files?.length) void importFiles(files);
          event.target.value = "";
        }}
      />
    </div>
  );
}

/* ------------------------------------------------------------- sub-screens */

function WelcomeScreen({
  workspaces,
  busy,
  supportsLocalFolder,
  supportsBrowserWorkspace,
  onOpen,
  onAddLocal,
  onNewBrowser,
  onUpload,
}: {
  workspaces: WorkspaceRecord[];
  busy: string | null;
  supportsLocalFolder: boolean;
  supportsBrowserWorkspace: boolean;
  onOpen: (record: WorkspaceRecord) => void;
  onAddLocal: () => void;
  onNewBrowser: () => void;
  onUpload: () => void;
}): ReactNode {
  return (
    <div className="empty">
      <div className="empty__inner" style={{ maxWidth: 520 }}>
        <div className="empty__seal">記</div>
        <h1 className="empty__title">Opennote</h1>
        <p className="empty__lede">
          Markdown 笔记就是磁盘上的文件。
          <br />
          选一个文件夹当作笔记本，Opennote 直接读写它 —— 没有数据库，没有账户。
        </p>

        <div className="workspace-choices">
          <button type="button" className="choice" onClick={onAddLocal} disabled={!supportsLocalFolder}>
            <Icon name="folder" size={18} />
            <strong>打开本机文件夹</strong>
            <small>
              {supportsLocalFolder
                ? "选一个目录，笔记就是里面的 .md 文件"
                : "当前浏览器不支持直接读写磁盘，请用下面的方式"}
            </small>
          </button>
          <button type="button" className="choice" onClick={onNewBrowser} disabled={!supportsBrowserWorkspace}>
            <Icon name="note" size={18} />
            <strong>新建浏览器笔记本</strong>
            <small>存在浏览器自己的文件系统（OPFS）里，随时能导出带走</small>
          </button>
          <button type="button" className="choice" onClick={onUpload}>
            <Icon name="upload" size={18} />
            <strong>导入文件夹</strong>
            <small>把本地文件夹拷进浏览器本地存储，之后照常编辑</small>
          </button>
        </div>

        {workspaces.length ? (
          <div className="empty__recent">
            <h4>最近的笔记本</h4>
            {workspaces.slice(0, 5).map((record) => (
              <button key={record.id} type="button" className="empty__recent-item" onClick={() => onOpen(record)}>
                <Icon name={record.kind === "node" ? "folder" : "layers"} size={13} />
                <span className="truncate">{record.name}</span>
                <time>{storageLabel(record)}</time>
              </button>
            ))}
          </div>
        ) : null}
        {busy ? <p className="dialog__note">{busy}</p> : null}
      </div>
    </div>
  );
}

function PermissionDialog({
  record,
  onGrant,
  onClose,
}: {
  record: WorkspaceRecord;
  onGrant: () => void;
  onClose: () => void;
}): ReactNode {
  return (
    <div className="overlay-root">
      <div className="scrim" onMouseDown={onClose} />
      <div className="dialog" role="dialog" aria-modal="true">
        <header className="dialog__head">
          <h2 className="dialog__title">需要重新授权</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog__body">
          <p className="dialog__message">
            浏览器要求你再次确认对「{record.name}」的访问权限（刷新页面后都会这样）。
          </p>
          <p className="dialog__note">授权后 Opennote 才能继续读写这个文件夹里的 Markdown 文件。</p>
        </div>
        <footer className="dialog__foot">
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            以后再说
          </button>
          <button type="button" className="btn btn--primary" onClick={onGrant}>
            授权访问
          </button>
        </footer>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------- helpers */

/**
 * 按 `importId` 撤销一次导入（`opennote:import:undo` 的渲染层实现）。
 *
 * 用导入日志还原出前像凭据：有前像 → 逐字节覆盖回导入前的版本；没有 → 只能
 * 降级为「移入回收站」，且 `mode` 如实返回（UI 不得在不可回退时承诺「恢复原样」）。
 */
async function undoImportById(importId: string): Promise<ImportUndoResult> {
  if (!importId) return { ok: false, mode: "none", message: "没有指定要撤销的导入。" };
  const entry = await findImportLogEntry(importId);
  if (!entry) return { ok: false, mode: "none", message: "没有找到这条导入记录。" };
  const receipt = {
    importId: entry.importId,
    path: entry.path,
    preimage:
      entry.revertible && entry.preimagePath
        ? { path: entry.preimagePath, bytes: entry.preimageBytes ?? 0, sha256: entry.preimageSha256 ?? "" }
        : null,
  } as unknown as ImportReceipt;
  return undoImport(receipt);
}

function storageLabel(record: WorkspaceRecord): string {
  if (record.kind === "node") return `本机磁盘 · ${record.location}`;
  if (record.kind === "fsa") return `浏览器文件夹 · ${record.name}`;
  return `浏览器本地 · ${record.name}`;
}

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
