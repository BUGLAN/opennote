import type { ReactNode } from "react";
import type { UiSettings } from "../data/types";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";
import type { CursorInfo } from "./EditorPane";

interface StatusBarProps {
  counts: { chars: number; words: number; minutes: number };
  dirty: boolean;
  savedLabel: string;
  /**
   * 「· 7 分钟前」那一段；没落过盘时为 `null`。单独给一段、不拼进 `savedLabel`：
   * 底栏窄到一定程度时先丢时间、保留「已写入磁盘」这句（分档见 `app.css` 的
   * `@container statusbar`），拼成一个字符串就没法只丢一半。
   */
  savedAgo: string | null;
  cursor: CursorInfo;
  settings: UiSettings;
  locationLabel: string;
  snapshotCount: number;
  storageLabel: string;
  stats: { files: number; bytes: number };
  onToggle(key: "outlineOpen" | "typewriter" | "focus" | "showWordCount"): void;
  onToggleAppearance(): void;
  onOpenHistory(): void;
  onOpenSettings(): void;
  /** 待确认的收件箱条目数（0 时只显示「收件箱」）。 */
  inboxPending: number;
  onOpenInbox(): void;
  /**
   * 当前笔记本的 GitHub 远端（不是镜像笔记本时 `null`，那一项整个不渲染）。
   * `label` 是逐字显示的那一行，`title` 说明同步状态（悬浮可见），点击打开同步对话框。
   */
  github: { label: string; title: string; onOpen(): void; onForgetToken(): void } | null;
}

/**
 * 底栏（脚注）。两条硬性约束，改之前先读：
 *
 * 1. **高度写死 `--statusbar-h`**：跟侧栏脚注 `.sidebar__foot` 同高，屏幕底部两条边线才连成
 *    一条（护栏在 `src/data/shellLayout.test.ts`）。
 * 2. **按钮永远完整可见**：按钮组 `.statusbar__actions` 是 `flex: none`，信息组
 *    `.statusbar__info` 才是唯一会被压缩的一段（`min-width: 0` + `overflow: hidden`）。
 *    于是无论窗口多窄，被牺牲的只会是信息（先按底栏自身宽度整项隐藏，最后才轮到省略号），
 *    按钮一颗都不会被裁 —— 2026-10-10 用户截图里「历史 / 夜读 / 设置」整颗消失、点不到，
 *    根因是降级规则判的是**视口**宽度，而底栏住在 `.main` 里（视口 − 侧栏 − 大纲）。
 *
 * 所有带文字的按钮都把文字包进 `.statusbar__label`：窄窗只丢这段文字、留图标 + `title`，
 * 所以每个按钮都必须同时给 `aria-label`（`Icon` 是 `aria-hidden`，文字一没按钮就没有可访问名）。
 */
export function StatusBar(props: StatusBarProps): ReactNode {
  const { settings } = props;
  const saveText = props.dirty ? "保存中…" : props.savedLabel;
  const saveTitle = props.dirty
    ? "保存状态：正在写入磁盘…"
    : `保存状态：${saveText}${props.savedAgo ? ` · ${props.savedAgo}` : ""}`;
  const inboxText = props.inboxPending ? `收件箱 ${props.inboxPending}` : "收件箱";
  const historyText = props.snapshotCount ? `历史 ${props.snapshotCount}` : "历史";
  const appearanceText = settings.appearance === "dark" ? "夜读" : "素笺";

  return (
    <footer className="statusbar">
      <div className="statusbar__info">
        <span className="statusbar__item statusbar__item--path" title={`笔记存放位置：${props.storageLabel}`}>
          <Icon name="layers" size={12} />
          <span className="statusbar__ellipsis">{props.storageLabel}</span>
        </span>

        <span className="statusbar__item statusbar__item--compact" title={`${props.stats.files} 个文件`}>
          {props.stats.files} 个文件
        </span>

        <span className="statusbar__item statusbar__item--folder" title="当前笔记所在文件夹">
          <Icon name="folder" size={12} />
          <span className="statusbar__ellipsis">{props.locationLabel}</span>
        </span>

        <span className="statusbar__item statusbar__item--save" title={saveTitle}>
          <span className={cn("statusbar__dot", props.dirty && "is-dirty")} />
          <span className="statusbar__save-text">{saveText}</span>
          {!props.dirty && props.savedAgo ? <span className="statusbar__save-ago"> · {props.savedAgo}</span> : null}
        </span>

        {/* 两颗度量（字数 / 行列）挂在 spacer 右侧：底栏变窄时先丢掉它们，
            左侧那四段（存放位置 / 文件数 / 文件夹 / 保存状态）留得更久。 */}
        <span className="statusbar__spacer" />

        {settings.showWordCount ? (
          <span className="statusbar__item statusbar__item--compact" title="字数统计">
            {props.counts.words.toLocaleString("zh-CN")} 字 · {props.counts.chars.toLocaleString("zh-CN")} 字符 · 约{" "}
            {props.counts.minutes} 分钟
          </span>
        ) : null}

        <span className="statusbar__item statusbar__item--cursor" title="光标位置">
          行 {props.cursor.line} · 列 {props.cursor.column}
          {props.cursor.selected ? ` · 选中 ${props.cursor.selected}` : ""}
        </span>
      </div>

      <div className="statusbar__actions">
        <button
          type="button"
          className={cn("statusbar__item", "statusbar__item--button", settings.outlineOpen && "is-on")}
          aria-label="大纲"
          title="大纲 (Ctrl/⌘ + Shift + O)"
          onClick={() => props.onToggle("outlineOpen")}
        >
          <Icon name="outline" size={13} />
        </button>
        <button
          type="button"
          className={cn("statusbar__item", "statusbar__item--button", settings.typewriter && "is-on")}
          aria-label="打字机模式"
          title="打字机模式 (Ctrl/⌘ + Shift + Y)"
          onClick={() => props.onToggle("typewriter")}
        >
          <Icon name="typewriter" size={13} />
        </button>
        <button
          type="button"
          className={cn("statusbar__item", "statusbar__item--button", settings.focus && "is-on")}
          aria-label="专注模式"
          title="专注模式 (Ctrl/⌘ + Shift + D)"
          onClick={() => props.onToggle("focus")}
        >
          <Icon name="focus" size={13} />
        </button>
        <button
          type="button"
          className="statusbar__item statusbar__item--button"
          aria-label={inboxText}
          title="打开导入收件箱"
          onClick={props.onOpenInbox}
        >
          <Icon name="layers" size={13} />
          <span className="statusbar__label">{inboxText}</span>
        </button>
        {props.github ? (
          <>
            <button
              type="button"
              className="statusbar__item statusbar__item--button"
              aria-label={props.github.label}
              title={props.github.title}
              onClick={props.github.onOpen}
            >
              <Icon name="download" size={13} />
              <span className="statusbar__label">{props.github.label}</span>
            </button>
            <button
              type="button"
              className="statusbar__item statusbar__item--button"
              aria-label="清除令牌"
              title="清除这个仓库保存在浏览器里的访问令牌"
              onClick={props.github.onForgetToken}
            >
              <Icon name="trash" size={13} />
              <span className="statusbar__label">清除令牌</span>
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="statusbar__item statusbar__item--button"
          aria-label={historyText}
          title="查看历史快照"
          onClick={props.onOpenHistory}
        >
          <Icon name="clock" size={13} />
          <span className="statusbar__label">{historyText}</span>
        </button>
        <button
          type="button"
          className="statusbar__item statusbar__item--button"
          aria-label={appearanceText}
          title="切换亮色 / 暗色 (Ctrl/⌘ + Alt + T)"
          onClick={props.onToggleAppearance}
        >
          <Icon name={settings.appearance === "dark" ? "sun" : "moon"} size={13} />
          <span className="statusbar__label">{appearanceText}</span>
        </button>
        <button
          type="button"
          className="statusbar__item statusbar__item--button"
          aria-label="设置"
          title="设置"
          onClick={props.onOpenSettings}
        >
          <Icon name="settings" size={13} />
        </button>
      </div>
    </footer>
  );
}
