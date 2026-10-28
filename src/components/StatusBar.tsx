import type { ReactNode } from "react";
import type { UiSettings } from "../data/types";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";
import type { CursorInfo } from "./EditorPane";

interface StatusBarProps {
  counts: { chars: number; words: number; minutes: number };
  /**
   * 画布活跃时的卡片/连线统计（普通笔记为 `null`）。非空时字数槽位换成
   * 「N 张卡片 · M 条连线」（仍受 `showWordCount` 开关管），光标行列不渲染
   * （画布没有行列概念，残留上一次编辑器的值只会误导）。
   */
  canvas: { cards: number; edges: number } | null;
  /**
   * 活跃标签是 HTML 页面：度量槽位只写「HTML 页面 · 只读」—— 字数是标记的字数、
   * 行列是上一个编辑器的残值，两个都只会误导。
   */
  htmlPage: boolean;
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
  /**
   * 远端同步的一位。
   *
   * `tone === null` = **一切正常**：只留一颗看不出状态的图标当入口，
   * 既不写字也不变色 —— 「同步 · 已同步」这种永远为真的播报没有信息量。
   *
   * `tone === "busy"` = **正在同步 / 正在接上**：同一个 13px 槽位换成旋转的小环，**不写字**。
   * 底栏顶边**不再**画那条横穿整幅宽度的进度线 —— 它在写作时一直拽余光，
   * 而且写字会让按钮组变宽、底栏重排。进度数字在 `title` 里，悬停可见。
   *
   * ★ 但**不能整颗藏掉**：底栏这一位是同步设置对话框**唯一**的入口。
   * 藏了它就等于「同步正常的时候，用户找不到同步设置了」。
   */
  sync: {
    tone: "busy" | "warn" | "error" | null;
    label: string | null;
    title: string;
    onOpen(): void;
  } | null;
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

        {/* 两颗度量（字数 / 行列）挂在 spacer 右侧：底栏变窄时先丢掉它们，
            左侧那三段（存放位置 / 文件数 / 文件夹）留得更久。 */}
        <span className="statusbar__spacer" />

        {props.htmlPage ? (
          <span className="statusbar__item statusbar__item--compact" title="HTML 页面在应用内只读渲染">
            <Icon name="lock" size={12} />
            HTML 页面 · 只读
          </span>
        ) : settings.showWordCount ? (
          props.canvas ? (
            <span className="statusbar__item statusbar__item--compact" title="画布统计">
              {props.canvas.cards.toLocaleString("zh-CN")} 张卡片 · {props.canvas.edges.toLocaleString("zh-CN")} 条连线
            </span>
          ) : (
            <span className="statusbar__item statusbar__item--compact" title="字数统计">
              {props.counts.words.toLocaleString("zh-CN")} 字 · {props.counts.chars.toLocaleString("zh-CN")} 字符 · 约{" "}
              {props.counts.minutes} 分钟
            </span>
          )
        ) : null}

        {props.canvas || props.htmlPage ? null : (
          <span className="statusbar__item statusbar__item--cursor" title="光标位置">
            行 {props.cursor.line} · 列 {props.cursor.column}
            {props.cursor.selected ? ` · 选中 ${props.cursor.selected}` : ""}
          </span>
        )}
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
        {props.sync ? (
          <button
            type="button"
            className={cn(
              "statusbar__item",
              "statusbar__item--button",
              "statusbar__sync",
              props.sync.tone === null ? "is-quiet" : `is-${props.sync.tone}`,
            )}
            aria-label={props.sync.label === null ? props.sync.title : `同步：${props.sync.label}`}
            title={props.sync.title}
            onClick={props.sync.onOpen}
          >
            {/*
              三种状态共用同一个 13px 的槽位，宽度不变 —— 同步开始/结束底栏不会跳：
              · 安静态：同步图标（入口本身）；
              · 正在跑：小型环形指示器（旋转；停转时也是一个带缺口的圆，静态可辨）；
              · 要你动手 / 出问题：圆点 + 文字。
            */}
            {props.sync.tone === "busy" ? (
              <span className="statusbar__sync-spinner" aria-hidden="true" />
            ) : props.sync.tone === null ? (
              <Icon name="rotate" size={13} className="statusbar__sync-icon" />
            ) : (
              <span className="statusbar__sync-dot" aria-hidden="true" />
            )}
            {props.sync.label === null ? null : <span className="statusbar__label">{props.sync.label}</span>}
          </button>
        ) : null}
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
