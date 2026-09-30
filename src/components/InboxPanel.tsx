/**
 * UI-03 导入收件箱面板（`docs/import/03-UI设计规范-剪藏与导入.md` §4 UI-03，
 * 视觉与逐字文案基准 `docs/import/mockups/02-import-inbox.html` 260–437 行）。
 *
 * 结构逐字照 mockup：`.dialog > .dialog__head + .inbox__bar + .dialog__body + .dialog__foot`。
 * 这里没有复用 `Modal`，因为 `Modal` 的固定结构里没有 `.inbox__bar` 的位置（它只有 head /
 * body / foot 三段），而这一行筛选条必须紧贴 head 下方、通栏、且夹在 body 之外。
 * head / scrim / role / aria 的写法与 `Overlays.tsx` 的 `Modal` 保持一致，另外补齐了
 * mockup 第 526 行要求而 `Modal` 没有的：**焦点陷阱**与**关闭后焦点归还**。
 *
 * 文案全部逐字取自冻结清单（`03` UI-03 + `01`/`02` 的 code→中文文案表）：
 * `笔记本根目录` / `目标目录「{目录}」不存在，入库时会存到根目录。` /
 * `这篇笔记正在编辑，不能覆盖；可以追加或另存为新笔记。` /
 * `同名文件已存在，入库时会另存为《{标题} 2》。` /
 * `这个网址之前剪藏过（{时间}），入库时会追加到《{标题}》。` /
 * `收件箱是空的。` / `外部导入若选择「先进入收件箱」，会先出现在这里。` /
 * `没有「{筛选名}」的条目。` / `正在读取收件箱…` / `丢弃这条导入？` /
 * `「{标题}」还没入库，丢弃后不会进入回收站。` / `丢弃` / `留下`。
 *
 * 0.3.0（`00` §6.14㉜）新增「保存到」选择器：入库前可以改落点，改完仍按同一套优先级
 * 显示最终落点说明句（非法 → 目录不存在 → 正在编辑 → 同网址剪藏过 → 同名另存 → 落点）。
 *
 * 三条硬约束：**没有「恢复」入口**（`discarded` 不进回收站、不可恢复）；错误句与状态文字
 * 一律 `--fs-sm` + `--ink`（`--ink-3` 对比度不足）；成功 toast 由 C1 的 `announce()` 负责
 * （避免 UI-05 出现两份实现），面板只弹**失败** toast。
 *
 * 0.3.3（用户真机验收轮，`00` §6.16（55））四条界面意见落在这里：
 * ① 筛选只剩 `全部` / `待确认`，默认停在 `待确认`（`failed` 条目仍能在「全部」里重试或丢弃）；
 * ② 「目录」单行截断 + `title` 悬浮给全值；
 * ③ `跳过这次` = 确认后丢弃这一条（面板不关闭），不再是「关掉面板、条目留在收件箱」；
 * ④ 面板高度固定（`.dialog--tall`，与设置面板同高），切筛选/切条目不再改尺寸、不再闪。
 */
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";
import { desktopBridge } from "../desktop/bridge";
import { folderPathLabel, useLibrary } from "../data/library";
import {
  INBOX_FAILED_TTL_MS,
  INBOX_FULL_MESSAGE,
  INBOX_LIMIT,
  INBOX_ROOT_LABEL,
  INBOX_ROOT_VALUE,
  commitInboxResult,
  discardInbox,
  inboxFailureMessage,
  readInboxDetail,
  refreshInbox,
  startInboxWatch,
  useInboxDetails,
  useInboxLoaded,
  type InboxDetail,
  type InboxEntry,
} from "../data/inbox";
import { askConfirm } from "../lib/dialogs";
import { requestedNotePath } from "../lib/clip/landing";
import { notify } from "../lib/toast";
import { cn, formatBytes, formatDateTime, formatRelativeTime } from "../lib/utils";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 筛选只有两栏（0.3.3 用户要求 #1）：`失败` 那一栏删掉，默认停在 `待确认`。
 * `failed` 条目不是不见了 —— 它们仍留在「全部」里，带原因、`还有 n 天` 与「丢弃」按钮
 * （`03` UI-03/S5：失败条目必须能在原地重试或丢弃）。
 */
const FILTERS = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待确认" },
] as const;

export type FilterId = (typeof FILTERS)[number]["id"];

const FILTER_LABELS: Record<FilterId, string> = { all: "全部", pending: "待确认" };

/** 「待确认」= 还没入库的条目（`pending` / `committing`）；`committed` / `failed` 不在这一栏。 */
function needsReview(status: InboxEntry["status"]): boolean {
  return status === "pending" || status === "committing";
}

const NO_URL = "（没有网址）";

export interface InboxPanelProps {
  open: boolean;
  onClose: () => void;
  /** 打开一条已入库的笔记（`committed` 条目的「查看」）。 */
  onOpenNote?: (path: string) => void;
  /**
   * 初始筛选，默认 `pending`（「待确认」）。打开后怎么切仍是用户的事，这个入参不接管。
   *
   * 它存在的原因只有一个：**首屏文案护栏要能进「全部」视图**。`src/data/inbox.test.ts`
   * 用 `react-dom/server` 渲染面板（effect 不跑、点击模拟不了），失败条目与已入库条目的
   * 逐字文案（`修复方式` / `丢弃` / `稍后处理` / `查看`）只有在「全部」里才看得到。
   */
  initialFilter?: FilterId;
}

/** 列表标题：空标题显示占位符（mockup 297 行）。 */
function displayTitle(entry: InboxEntry): string {
  const title = entry.title.trim();
  return title || "（没有标题）";
}

function capturedAt(detail: InboxDetail): number {
  return detail.capturedAt ?? detail.entry.createdAt;
}

/** `failed` 条目的剩余保留时间：`还有 {n} 天`（`03` UI-03 状态表）。 */
function daysLeft(entry: InboxEntry, now: number): number {
  const expires = Date.parse(entry.updatedAt) + INBOX_FAILED_TTL_MS;
  return Math.max(1, Math.ceil((expires - now) / DAY_MS));
}

/** 条目次级文字（`03` UI-03 状态表的逐字文案）。 */
function subLine(detail: InboxDetail, now: number): string {
  const { entry } = detail;
  if (entry.status === "failed") return entry.message ?? inboxFailureMessage(entry.lastError ?? "IMP-4014");
  if (entry.status === "committed") return `已入库 · ${formatRelativeTime(Date.parse(entry.updatedAt), now)}`;
  if (entry.status === "discarded") return "已丢弃";
  return `${detail.site || NO_URL} · ${formatRelativeTime(capturedAt(detail), now)}`;
}

/** 领域错误的用户文案（`InboxError.userMessage` / 普通 `Error.message`）。 */
function errorMessage(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  if ("userMessage" in error) return String((error as { userMessage?: unknown }).userMessage ?? "");
  if (error instanceof Error) return error.message;
  return "";
}

/**
 * 落点文件名 + 合法性。`requestedNotePath()` 内部会跑 `normalizeFolder()`
 * （`assertSafeRelative` + 逐段 `sanitizeName`），**手工写坏的 `entry.json`（比如
 * `target.folder = "../逃逸"`）会让它抛错**——这里必须接住，否则整块面板会渲染崩掉。
 * 非法时按根目录算一个只用于显示的文件名，并如实标记 `illegal`。
 */
function safeRequestedPath(folder: string | null, title: string): { path: string; illegal: boolean } {
  try {
    return { path: requestedNotePath(folder, title), illegal: false };
  } catch {
    return { path: requestedNotePath(null, title), illegal: true };
  }
}

/** 一条外部剪藏笔记的前像：正文 front-matter 里的 `source` / `captured_at`。 */interface PreviousCapture {
  path: string;
  title: string;
  capturedAt: number | null;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length > 1) {
    return trimmed.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
  }
  return trimmed;
}

function findPreviousCapture(
  notes: Record<string, { id: string; title: string; content: string; trashed: boolean }>,
  url: string,
): PreviousCapture | null {
  if (!url) return null;
  for (const note of Object.values(notes)) {
    if (note.trashed) continue;
    const front = /^---\r?\n([\s\S]*?)\r?\n---/.exec(note.content);
    if (!front) continue;
    const source = /^source:[ \t]*(.+)$/m.exec(front[1]);
    if (!source || unquote(source[1]) !== url) continue;
    const captured = /^captured_at:[ \t]*(.+)$/m.exec(front[1]);
    const parsed = captured ? Date.parse(unquote(captured[1])) : NaN;
    return { path: note.id, title: note.title, capturedAt: Number.isFinite(parsed) ? parsed : null };
  }
  return null;
}

export function InboxPanel({ open, onClose, onOpenNote, initialFilter }: InboxPanelProps): ReactNode {
  const details = useInboxDetails();
  const loaded = useInboxLoaded();
  const library = useLibrary();
  const [filter, setFilter] = useState<FilterId>(initialFilter ?? "pending");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  /**
   * 正文预览按**条目 id** 缓存（不是单个 `{id, text}`）。
   *
   * 单槽位那版每换一次条目都会先把预览清空、等 `readInboxDetail()` 回来再填上：
   * 一帧没有「正文预览」这一块 → 详情栏高度跳一下，看起来就是「点一下闪一下」。
   * 外置正文（`body.md`）是收件箱的常态（`entry.json` 里的 `body` 被置空），所以这不是
   * 罕见路径，而是每次点条目都会走。缓存之后：看过的条目瞬时出预览，没看过的只影响
   * 详情栏内部（面板本身固定高度，见 `app.css` 的 `.dialog--tall`）。
   */
  const [previews, setPreviews] = useState<ReadonlyMap<string, string>>(() => new Map());
  const [busy, setBusy] = useState(false);
  /** 「保存到」的选择（`00` §6.14㉜）：只对当前条目生效，`folder: null` = 工作区根。 */
  const [folderPick, setFolderPick] = useState<{ id: string; folder: string | null } | null>(null);

  // 有缓存条目就直接显示；否则等第一次读盘完成，避免闪一下「正在读取收件箱…」。
  const loading = !loaded && details.length === 0;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const counts = useMemo(() => {
    let pending = 0;
    for (const detail of details) {
      if (needsReview(detail.entry.status)) pending += 1;
    }
    return { all: details.length, pending } as Record<FilterId, number>;
  }, [details]);

  const visible = useMemo(
    () => (filter === "pending" ? details.filter((detail) => needsReview(detail.entry.status)) : details),
    [details, filter],
  );

  const selected = useMemo(() => {
    if (!visible.length) return null;
    return visible.find((detail) => detail.entry.id === selectedId) ?? visible[0];
  }, [visible, selectedId]);

  const entry = selected?.entry ?? null;
  const now = Date.now();
  const status = entry?.status ?? "pending";
  const committing = busy || status === "committing";
  const url = entry?.sourceUrl ?? "";

  /* ---------------------------- 落点与说明句 ---------------------------- */

  /**
   * 最终落点目录：用户在这次会话里选过的以选中值为准，否则沿用信封的 `target.folder`。
   * `null` = 工作区根目录（和信封 `target.folder: null` 同义）。
   */
  const effectiveFolder = useMemo(() => {
    if (!entry) return null;
    if (folderPick && folderPick.id === entry.id) return folderPick.folder;
    return entry.targetFolder;
  }, [entry?.id, entry?.targetFolder, folderPick]);

  /** 「保存到」下拉的候选项：根目录 + 既有文件夹树（值 = 文件夹的工作区相对路径）。 */
  const folderOptions = useMemo(() => {
    return Object.values(library.folders)
      .map((folder) => ({ path: folder.id, label: folderPathLabel(folder.id, library.folders) }))
      .sort((left, right) => left.path.localeCompare(right.path, "zh-Hans-CN"));
  }, [library.folders]);

  const landing = useMemo(() => {
    if (!entry) return null;
    const requested = safeRequestedPath(effectiveFolder, entry.title || "无标题");
    const folderMissing = !requested.illegal && effectiveFolder !== null && !(effectiveFolder in library.folders);
    const sameName = requested.path in library.notes;
    const editing = Object.values(library.notes).some((note) => note.id === requested.path && library.dirty[note.id]);
    return { path: requested.path, illegal: requested.illegal, folderMissing, sameName, editing };
  }, [entry?.id, effectiveFolder, entry?.title, library.folders, library.notes, library.dirty]);

  const previous = useMemo(() => {
    if (!entry || !entry.sourceUrl) return null;
    return findPreviousCapture(library.notes, entry.sourceUrl);
  }, [entry?.id, entry?.sourceUrl, library.notes]);

  /** 落点说明句（优先级：非法 → 目录不存在 → 正在编辑 → 同网址剪藏过 → 同名另存 → 最终落点）。 */
  const hint = useMemo(() => {
    if (!entry || !landing) return null;
    if (entry.status === "failed") return null;
    if (landing.illegal) return inboxFailureMessage("IMP-4008");
    if (landing.folderMissing) return `目标目录「${effectiveFolder}」不存在，入库时会存到根目录。`;
    if (landing.editing) return "这篇笔记正在编辑，不能覆盖；可以追加或另存为新笔记。";
    if (previous) {
      const when = previous.capturedAt ? formatRelativeTime(previous.capturedAt, now) : "之前";
      return `这个网址之前剪藏过（${when}），入库时会追加到《${previous.title}》。`;
    }
    if (landing.sameName) return `同名文件已存在，入库时会另存为《${entry.title} 2》。`;
    // 最终落点说明句：入库前明确「会存到哪」。
    return effectiveFolder ? `入库到「${effectiveFolder}」。` : `入库到${INBOX_ROOT_LABEL}。`;
  }, [entry?.id, entry?.status, entry?.title, effectiveFolder, landing, previous, now]);

  /* -------------------------------- 副作用 ------------------------------- */

  // 打开：起消费端（幂等）+ 读一次盘。面板关闭后**不停止**消费端——侧栏徽标还在用它。
  useEffect(() => {
    if (!open) return;
    startInboxWatch();
    void refreshInbox().catch(() => undefined);
  }, [open]);

  // 关闭后把焦点还给打开面板的那个元素（mockup 526 行）。
  useEffect(() => {
    if (!open) return;
    restoreRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      restoreRef.current?.focus?.();
      restoreRef.current = null;
    };
  }, [open]);

  // 选中项变化 → 读正文预览（正文外置在 body.md，列表阶段不读）。读到的按条目 id 留下。
  useEffect(() => {
    if (!open || !selected) return;
    const id = selected.entry.id;
    // 已经有预览（缓存里，哪怕缓存的是空串）或详情自带预览 → 不再读盘。
    if (previews.has(id) || selected.bodyPreview) return;
    let alive = true;
    void readInboxDetail(id).then((detail) => {
      if (!alive || !detail) return;
      const text = detail.bodyPreview;
      setPreviews((current) => {
        if (current.get(id) === text) return current;
        const next = new Map(current);
        next.set(id, text);
        return next;
      });
    });
    return () => {
      alive = false;
    };
  }, [open, selected?.entry.id, selected?.bodyPreview, previews]);

  // 打开时焦点落在左列表第一个条目上（mockup 520 行）。
  useEffect(() => {
    if (!open || loading || !selected) return;
    const node =
      listRef.current?.querySelector<HTMLElement>(".inbox__item.is-active") ?? dialogRef.current;
    node?.focus();
  }, [open, loading, selected?.entry.id]);

  /* -------------------------------- 动作 --------------------------------- */

  const runCommit = useCallback(
    async (target: InboxEntry) => {
      setBusy(true);
      try {
        // 选了别的目录才传覆盖参数；没动过就走信封原值 —— 0.2.0 那条路径一字未改。
        const chosen = folderPick && folderPick.id === target.id ? folderPick.folder : target.targetFolder;
        const options = chosen === target.targetFolder ? undefined : { folder: chosen };
        // 成功 toast 由接收端 `announce()` 弹（UI-05 只有一份实现），这里只处理失败。
        await commitInboxResult(target.id, options);
      } catch (error) {
        notify(errorMessage(error) || "入库失败，请重试。", { kind: "danger" });
      } finally {
        setBusy(false);
      }
    },
    [folderPick],
  );

  /**
   * 丢弃（`丢弃` 与 0.3.3 之后的 `跳过这次` 共用）：问一句确认 → `rm -r` 条目目录
   * （`00` §6.12②：不进回收站、不可恢复）→ **面板留在原地**，选中落到下一条。
   *
   * 「跳过这次」以前只是 `onClose()`：点一下面板就关了，条目还躺在收件箱里，
   * 下次打开又从头看见它。用户的预期是「点它 = 这条我不要了，从收件箱删掉」。
   */
  const runDiscard = useCallback(async (target: InboxEntry) => {
    const ok = await askConfirm({
      title: "丢弃这条导入？",
      message: `「${displayTitle(target)}」还没入库，丢弃后不会进入回收站。`,
      confirmLabel: "丢弃",
      cancelLabel: "留下",
      danger: true,
    });
    if (!ok) return;
    try {
      await discardInbox(target.id);
      // 清掉选中：`selected` 会回落到新列表的第一条（一条不剩时进空态）。
      setSelectedId(null);
    } catch (error) {
      notify(errorMessage(error) || "丢弃失败，请重试。", { kind: "danger" });
    }
  }, []);

  const openExternal = useCallback(() => {
    if (!url) return;
    // 桌面版交给主进程（用户默认浏览器）；纯浏览器里退回 window.open。
    const external = desktopBridge()?.shell?.openExternal;
    if (typeof external === "function") {
      void external(url).catch(() => notify("没有打开浏览器。", { kind: "danger" }));
      return;
    }
    if (typeof window !== "undefined") window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const select = useCallback((id: string) => setSelectedId(id), []);

  /**
   * 切筛选。**当前条目能留下来就不动选中**（mockup 522 行只说「被筛掉则落到第一条」）：
   * 原来无条件 `setSelectedId(null)`，于是「全部 → 待确认」时哪怕第一条是同一个条目，
   * 详情栏也要重排一次 —— 那正是用户看到的「闪」。
   */
  const switchFilter = useCallback(
    (next: FilterId) => {
      setFilter(next);
      const nextVisible = next === "pending" ? details.filter((detail) => needsReview(detail.entry.status)) : details;
      setSelectedId((current) =>
        current && nextVisible.some((detail) => detail.entry.id === current) ? current : null,
      );
    },
    [details],
  );

  const onFilterKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = FILTERS.findIndex((item) => item.id === filter);
    const step = event.key === "ArrowRight" ? 1 : -1;
    switchFilter(FILTERS[(index + step + FILTERS.length) % FILTERS.length].id);
  };

  const onListKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!visible.length) return;
    const index = selected ? visible.findIndex((detail) => detail.entry.id === selected.entry.id) : 0;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedId(visible[Math.min(index + 1, visible.length - 1)].entry.id);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedId(visible[Math.max(index - 1, 0)].entry.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      setSelectedId(visible[0].entry.id);
    } else if (event.key === "End") {
      event.preventDefault();
      setSelectedId(visible[visible.length - 1].entry.id);
    } else if (event.key === "Enter" && selected && !committing && !primaryDisabled) {
      event.preventDefault();
      void runCommit(selected.entry);
    }
  };

  /** 焦点陷阱：Tab 循环在对话框内（mockup 526 行；`Modal` 没有实现这一条）。 */
  const onDialogKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== "Tab") return;
    const root = dialogRef.current;
    if (!root) return;
    const nodes = [...root.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
    )].filter((node) => node.getClientRects().length > 0);
    if (!nodes.length) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    const active = document.activeElement;
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
    } else if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
    }
  };

  /* ------------------------------- 渲染 ---------------------------------- */

  if (!open) return null;

  // 正文预览：缓存优先（切回来瞬时出），其次详情自带的（内联正文的条目）。
  const previewText = entry ? previews.get(entry.id) ?? selected?.bodyPreview ?? "" : "";
  // 正文是否为空只在正文读出来后判定（读盘期间不误禁用主按钮）。
  const previewLoaded = Boolean(entry) && (previews.has(entry!.id) || Boolean(selected?.bodyPreview));
  const bodyEmpty = Boolean(entry) && !entry!.title.trim() && previewLoaded && !previewText.trim();
  /** 「目录」一栏的完整值（值可能很深，界面上截断显示，`title` 里给全）。 */
  const folderLabel = effectiveFolder ?? INBOX_ROOT_LABEL;
  const isFailed = status === "failed";
  const isCommitted = status === "committed";
  const canViewNote = isCommitted && Boolean(entry?.notePath) && typeof onOpenNote === "function";
  const primaryLabel = committing
    ? "正在入库…"
    : isCommitted
      ? "查看"
      : landing?.folderMissing
        ? "入库到根目录"
        : landing?.editing
          ? "追加到正在编辑的笔记"
          : "入库";
  const primaryDisabled = !entry || committing || isFailed || (isCommitted ? !canViewNote : false) || bodyEmpty;
  const showList = !loading && details.length > 0;
  const atLimit = details.length >= INBOX_LIMIT;

  const onPrimary = () => {
    if (!entry) return;
    if (isCommitted) {
      if (entry.notePath && onOpenNote) onOpenNote(entry.notePath);
      return;
    }
    void runCommit(entry);
  };

  return (
    <div className="overlay-root">
      <div className="scrim" onMouseDown={onClose} />
      <div
        ref={dialogRef}
        // 宽度仍随「有没有列表」走；高度固定（`.dialog--tall`，与设置面板同高）——
        // 切筛选、切条目、筛选后无结果都不再改面板尺寸（0.3.3 用户要求 #4）。
        className={cn("dialog", "dialog--tall", showList && "dialog--wide")}
        role="dialog"
        aria-modal="true"
        aria-label="导入收件箱"
        onKeyDown={onDialogKeyDown}
      >
        <header className="dialog__head">
          <h2 className="dialog__title">导入收件箱</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>

        {showList ? (
          <div className="inbox__bar">
            <div className="segmented" role="radiogroup" aria-label="筛选" onKeyDown={onFilterKeyDown}>
              {FILTERS.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="radio"
                  aria-checked={filter === item.id}
                  className={cn(filter === item.id && "is-active")}
                  onClick={() => switchFilter(item.id)}
                >
                  {item.label} {counts[item.id]}
                </button>
              ))}
            </div>
            <div className="spacer" />
            <span className="inbox__kind">收件箱在 .opennote/inbox/</span>
          </div>
        ) : null}

        <div className="dialog__body">
          {loading ? (
            <p className="tree__empty">正在读取收件箱…</p>
          ) : details.length === 0 ? (
            <div className="inbox__empty">
              <span className="empty__seal" aria-hidden="true">
                記
              </span>
              <h3>收件箱是空的。</h3>
              <p>外部导入若选择「先进入收件箱」，会先出现在这里。</p>
              <button type="button" className="btn" style={{ marginTop: "var(--s4)" }} onClick={onClose}>
                知道了
              </button>
            </div>
          ) : visible.length === 0 ? (
            <p className="tree__empty">没有「{FILTER_LABELS[filter]}」的条目。</p>
          ) : (
            <div className="inbox">
              <div
                ref={listRef}
                className="inbox__list"
                role="list"
                aria-label={`收件箱条目，共 ${visible.length} 条`}
                onKeyDown={onListKeyDown}
              >
                {atLimit ? <p className="inbox__field-err">{INBOX_FULL_MESSAGE}</p> : null}
                {visible.map((detail) => {
                  const item = detail.entry;
                  const active = entry?.id === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      role="listitem"
                      aria-current={active ? "true" : undefined}
                      aria-label={`${displayTitle(item)}，来自 ${detail.site || NO_URL}，${formatDateTime(capturedAt(detail))}，${detail.clientLabel}`}
                      className={cn("inbox__item", active && "is-active", item.status === "failed" && "is-error")}
                      onClick={() => select(item.id)}
                    >
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="inbox__row">
                          <span className="inbox__title">{displayTitle(item)}</span>
                          {detail.external ? <span className="inbox__kind">外部</span> : null}
                          <span className="inbox__kind">{detail.clientLabel}</span>
                        </div>
                        <span className="inbox__sub">{subLine(detail, now)}</span>
                      </div>
                      {item.status === "committing" ? (
                        // 旋转环必须是 `.inbox__item`（flex 容器）的直接子元素，行内元素上的
                        // width/height 不会生效——这是不加新令牌又能画出 12px 环的唯一写法。
                        <span className="busy__spinner" />
                      ) : null}
                      {item.status === "committing" ? <span className="inbox__kind">正在写入…</span> : null}
                      {item.status === "failed" ? (
                        <span className="inbox__kind">还有 {daysLeft(item, now)} 天</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>

              {/*
                `key` 绑条目 id：详情栏是**自己的滚动容器**（固定高度面板），换条目要连带把
                滚动位置归零，否则从上一条的滚动位置看新条目——那是「闪」的第二个来源。
              */}
              <div className="inbox__detail" key={entry?.id ?? "none"}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <h3 style={{ flex: 1, fontFamily: "var(--font-serif)", fontSize: "var(--fs-lg)", fontWeight: 600 }}>
                    {entry ? displayTitle(entry) : ""}
                  </h3>
                  {entry?.tags.slice(0, 1).map((tag) => (
                    <span key={tag} className="tag">
                      {tag}
                    </span>
                  ))}
                </div>

                {isFailed && entry?.message ? <div className="inbox__field-err">{entry.message}</div> : null}

                <div className="inbox__group">落点</div>
                {isCommitted ? null : (
                  <div className="inbox__save-to">
                    <span>保存到</span>
                    <select
                      className="field"
                      aria-label="保存到"
                      value={effectiveFolder ?? INBOX_ROOT_VALUE}
                      disabled={committing}
                      onChange={(event) =>
                        entry ? setFolderPick({ id: entry.id, folder: event.target.value || null }) : undefined
                      }
                    >
                      <option value={INBOX_ROOT_VALUE}>{INBOX_ROOT_LABEL}</option>
                      {folderOptions.map((option) => (
                        <option key={option.path} value={option.path}>
                          {option.label}
                        </option>
                      ))}
                      {/* 信封里的目录可能已经不在树上了：原样留着，别把用户的选择悄悄吞掉。 */}
                      {effectiveFolder && !folderOptions.some((option) => option.path === effectiveFolder) ? (
                        <option value={effectiveFolder}>{effectiveFolder}</option>
                      ) : null}
                    </select>
                  </div>
                )}
                <dl className="inbox__dl">
                  <div>
                    <dt>目录</dt>
                    {/* 落点可能是很深的路径：`.inbox__trunc` 单行截断（`max-width`）+ 悬浮用
                        `title` 给完整值，免得一条长目录把详情栏撑成两三行。 */}
                    <dd className="inbox__trunc" title={folderLabel}>
                      {folderLabel}
                    </dd>
                  </div>
                  <div>
                    <dt>文件名</dt>
                    <dd className="inbox__mono">{landing ? landing.path.split("/").pop() : ""}</dd>
                  </div>
                </dl>
                {hint ? <p className="inbox__hint">{hint}</p> : null}

                <div className="inbox__group">来源信息</div>
                <dl className="inbox__dl">
                  <div>
                    <dt>来源</dt>
                    <dd className="inbox__mono">{entry?.sourceUrl || NO_URL}</dd>
                  </div>
                  {selected?.pageTitle ? (
                    <div>
                      <dt>网页标题</dt>
                      <dd>{selected.pageTitle}</dd>
                    </div>
                  ) : null}
                  {selected?.author ? (
                    <div>
                      <dt>作者</dt>
                      <dd>{selected.author}</dd>
                    </div>
                  ) : null}
                  {selected?.publishedAt ? (
                    <div>
                      <dt>发布时间</dt>
                      <dd>{selected.publishedAt}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>剪藏时间</dt>
                    <dd>{entry ? formatDateTime(capturedAt(selected!)) : ""}</dd>
                  </div>
                  <div>
                    <dt>客户端</dt>
                    <dd>
                      {selected ? `${selected.clientLabel}${selected.clientVersion ? ` ${selected.clientVersion}` : ""}` : ""}
                    </dd>
                  </div>
                </dl>

                {isFailed ? (
                  <>
                    <div className="inbox__group">修复方式</div>
                    <p className="inbox__hint">在来源工具里补上正文后重新投递；也可以直接丢弃这一条。</p>
                  </>
                ) : null}

                {entry && entry.tags.length ? (
                  <>
                    <div className="inbox__group">标签</div>
                    <div className="inbox__tags">
                      {entry.tags.map((tag) => (
                        <span key={tag} className="tag">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </>
                ) : null}

                {previewText ? (
                  <>
                    <div className="inbox__group">正文预览</div>
                    <div className="inbox__preview">{previewText}</div>
                  </>
                ) : null}

                {selected && selected.assets.length ? (
                  <>
                    <div className="inbox__group">附件 · {selected.assets.length}</div>
                    <dl className="inbox__dl">
                      {selected.assets.map((asset) => (
                        <div key={asset.file || asset.name}>
                          <dt />
                          {/* 已入库的条目里暂存副本已被清掉（`size` 读不到 = 0）：只报名字，
                              不报一个会误导人的 `0 B`。 */}
                          <dd>{asset.size > 0 ? `${asset.name} · ${formatBytes(asset.size)}` : asset.name}</dd>
                        </div>
                      ))}
                    </dl>
                  </>
                ) : null}

                <div className="inbox__group">详情</div>
                <dl className="inbox__dl">
                  <div>
                    <dt>幂等键</dt>
                    <dd className="inbox__mono">{entry?.id ?? ""}</dd>
                  </div>
                  <div>
                    <dt>信封</dt>
                    <dd className="inbox__mono">{selected?.spec || "opennote.import/v1"}</dd>
                  </div>
                  <div>
                    <dt>尝试</dt>
                    <dd>{entry?.attempts ?? 0}</dd>
                  </div>
                  <div>
                    <dt>更新</dt>
                    <dd>{entry ? formatDateTime(Date.parse(entry.updatedAt)) : ""}</dd>
                  </div>
                </dl>
              </div>
            </div>
          )}
        </div>

        {showList && visible.length && entry ? (
          <footer className="dialog__foot">
            {isFailed ? (
              <button type="button" className="btn" disabled={committing} onClick={() => void runDiscard(entry)}>
                丢弃
              </button>
            ) : url ? (
              <button type="button" className="btn btn--ghost" onClick={openExternal}>
                <Icon name="external" />
                在浏览器中打开来源
              </button>
            ) : null}
            <div className="spacer" />
            {isCommitted ? null : isFailed ? (
              // 失败条目：`稍后处理` 仍然是「先关掉面板」，条目留在收件箱里等 7 天保留期。
              <button type="button" className="btn" disabled={committing} onClick={onClose}>
                稍后处理
              </button>
            ) : (
              // 未入库的条目（0.3.3 用户要求 #3）：`跳过这次` = 丢弃这一条（确认后删除、
              // 面板不关闭），不再只是把面板关掉、条目原封不动留在收件箱里。
              <button type="button" className="btn" disabled={committing} onClick={() => void runDiscard(entry)}>
                跳过这次
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary"
              disabled={primaryDisabled}
              title={bodyEmpty ? "正文为空，无法入库" : isFailed ? (entry.message ?? undefined) : undefined}
              onClick={onPrimary}
            >
              {committing ? <span className="busy__spinner" /> : null}
              {primaryLabel}
            </button>
          </footer>
        ) : null}
      </div>
    </div>
  );
}
