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
 * 三条硬约束：**没有「恢复」入口**（`discarded` 不进回收站、不可恢复）；错误句与状态文字
 * 一律 `--fs-sm` + `--ink`（`--ink-3` 对比度不足）；成功 toast 由 C1 的 `announce()` 负责
 * （避免 UI-05 出现两份实现），面板只弹**失败** toast。
 */
import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "./Icons";
import { desktopBridge } from "../desktop/bridge";
import { useLibrary } from "../data/library";
import {
  INBOX_FAILED_TTL_MS,
  INBOX_FULL_MESSAGE,
  INBOX_LIMIT,
  commitInbox,
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

const FILTERS = [
  { id: "all", label: "全部" },
  { id: "pending", label: "待确认" },
  { id: "failed", label: "失败" },
] as const;

type FilterId = (typeof FILTERS)[number]["id"];

const FILTER_LABELS: Record<FilterId, string> = { all: "全部", pending: "待确认", failed: "失败" };

const NO_URL = "（没有网址）";

export interface InboxPanelProps {
  open: boolean;
  onClose: () => void;
  /** 打开一条已入库的笔记（`committed` 条目的「查看」）。 */
  onOpenNote?: (path: string) => void;
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

/** 一条外部剪藏笔记的前像：正文 front-matter 里的 `source` / `captured_at`。 */
interface PreviousCapture {
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

export function InboxPanel({ open, onClose, onOpenNote }: InboxPanelProps): ReactNode {
  const details = useInboxDetails();
  const loaded = useInboxLoaded();
  const library = useLibrary();
  const [filter, setFilter] = useState<FilterId>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ id: string; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  // 有缓存条目就直接显示；否则等第一次读盘完成，避免闪一下「正在读取收件箱…」。
  const loading = !loaded && details.length === 0;

  const dialogRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const restoreRef = useRef<HTMLElement | null>(null);

  const counts = useMemo(() => {
    let pending = 0;
    let failed = 0;
    for (const detail of details) {
      if (detail.entry.status === "pending" || detail.entry.status === "committing") pending += 1;
      else if (detail.entry.status === "failed") failed += 1;
    }
    return { all: details.length, pending, failed } as Record<FilterId, number>;
  }, [details]);

  const visible = useMemo(() => {
    if (filter === "pending") {
      return details.filter((detail) => detail.entry.status === "pending" || detail.entry.status === "committing");
    }
    if (filter === "failed") return details.filter((detail) => detail.entry.status === "failed");
    return details;
  }, [details, filter]);

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

  const landing = useMemo(() => {
    if (!entry) return null;
    const path = requestedNotePath(entry.targetFolder, entry.title || "无标题");
    const folderMissing = entry.targetFolder !== null && !(entry.targetFolder in library.folders);
    const sameName = path in library.notes;
    const editing = Object.values(library.notes).some((note) => note.id === path && library.dirty[note.id]);
    return { path, folderMissing, sameName, editing };
  }, [entry?.id, entry?.targetFolder, entry?.title, library.folders, library.notes, library.dirty]);

  const previous = useMemo(() => {
    if (!entry || !entry.sourceUrl) return null;
    return findPreviousCapture(library.notes, entry.sourceUrl);
  }, [entry?.id, entry?.sourceUrl, library.notes]);

  /** 落点唯一说明句（优先级：目录不存在 → 正在编辑 → 同网址剪藏过 → 同名另存）。 */
  const hint = useMemo(() => {
    if (!entry || !landing) return null;
    if (entry.status === "failed") return null;
    if (landing.folderMissing) return `目标目录「${entry.targetFolder}」不存在，入库时会存到根目录。`;
    if (landing.editing) return "这篇笔记正在编辑，不能覆盖；可以追加或另存为新笔记。";
    if (previous) {
      const when = previous.capturedAt ? formatRelativeTime(previous.capturedAt, now) : "之前";
      return `这个网址之前剪藏过（${when}），入库时会追加到《${previous.title}》。`;
    }
    if (landing.sameName) return `同名文件已存在，入库时会另存为《${entry.title} 2》。`;
    return null;
  }, [entry?.id, entry?.status, entry?.targetFolder, entry?.title, landing, previous, now]);

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

  // 选中项变化 → 读正文预览（正文外置在 body.md，列表阶段不读）。
  useEffect(() => {
    if (!open || !selected) return;
    const id = selected.entry.id;
    if (selected.bodyPreview) {
      setPreview({ id, text: selected.bodyPreview });
      return;
    }
    let alive = true;
    void readInboxDetail(id).then((detail) => {
      if (alive && detail) setPreview({ id, text: detail.bodyPreview });
    });
    return () => {
      alive = false;
    };
  }, [open, selected?.entry.id]);

  // 打开时焦点落在左列表第一个条目上（mockup 520 行）。
  useEffect(() => {
    if (!open || loading || !selected) return;
    const node =
      listRef.current?.querySelector<HTMLElement>(".inbox__item.is-active") ?? dialogRef.current;
    node?.focus();
  }, [open, loading, selected?.entry.id]);

  /* -------------------------------- 动作 --------------------------------- */

  const runCommit = useCallback(async (target: InboxEntry) => {
    setBusy(true);
    try {
      // 成功 toast 由接收端 `announce()` 弹（UI-05 只有一份实现），这里只处理失败。
      await commitInbox(target.id);
    } catch (error) {
      notify(errorMessage(error) || "入库失败，请重试。", { kind: "danger" });
    } finally {
      setBusy(false);
    }
  }, []);

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

  const onFilterKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = FILTERS.findIndex((item) => item.id === filter);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = FILTERS[(index + step + FILTERS.length) % FILTERS.length];
    setFilter(next.id);
    setSelectedId(null);
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

  const previewText = preview && entry && preview.id === entry.id ? preview.text : "";
  // 正文是否为空只在正文读出来后判定（读盘期间不误禁用主按钮）。
  const previewLoaded = Boolean(entry && preview && preview.id === entry.id);
  const bodyEmpty = Boolean(entry) && !entry!.title.trim() && previewLoaded && !previewText.trim();
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
        className={cn("dialog", showList && "dialog--wide")}
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
                  onClick={() => {
                    setFilter(item.id);
                    setSelectedId(null);
                  }}
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

              <div className="inbox__detail">
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
                <dl className="inbox__dl">
                  <div>
                    <dt>目录</dt>
                    <dd>{entry?.targetFolder ?? "笔记本根目录"}</dd>
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
                          <dd>
                            {asset.name} · {formatBytes(asset.size)}
                          </dd>
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
            {isCommitted ? null : (
              <button type="button" className="btn" disabled={committing} onClick={onClose}>
                {isFailed ? "稍后处理" : "跳过这次"}
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
