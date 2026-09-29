import type { ReactNode } from "react";
import type { UiSettings } from "../data/types";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";
import type { CursorInfo } from "./EditorPane";

interface StatusBarProps {
  counts: { chars: number; words: number; minutes: number };
  dirty: boolean;
  savedLabel: string;
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
}

export function StatusBar(props: StatusBarProps): ReactNode {
  const { settings } = props;
  return (
    <footer className="statusbar">
      <span className="statusbar__item statusbar__item--path" title={`笔记存放位置：${props.storageLabel}`}>
        <Icon name="layers" size={12} />
        {props.storageLabel}
      </span>
      <span className="statusbar__item statusbar__item--compact" title={`${props.stats.files} 个文件`}>
        {props.stats.files} 个文件
      </span>
      <span className="statusbar__item statusbar__item--compact" title="当前笔记所在文件夹">
        <Icon name="folder" size={12} />
        {props.locationLabel}
      </span>
      <span className="statusbar__item" title="保存状态">
        <span className={cn("statusbar__dot", props.dirty && "is-dirty")} />
        {props.dirty ? "保存中…" : props.savedLabel}
      </span>
      <span className="statusbar__spacer" />

      {settings.showWordCount ? (
        <span className="statusbar__item statusbar__item--compact" title="字数统计">
          {props.counts.words.toLocaleString("zh-CN")} 字 · {props.counts.chars.toLocaleString("zh-CN")} 字符 · 约{" "}
          {props.counts.minutes} 分钟
        </span>
      ) : null}

      <span className="statusbar__item" title="光标位置">
        行 {props.cursor.line} · 列 {props.cursor.column}
        {props.cursor.selected ? ` · 选中 ${props.cursor.selected}` : ""}
      </span>

      <button
        type="button"
        className={cn("statusbar__item", "statusbar__item--button", settings.outlineOpen && "is-on")}
        title="大纲 (Ctrl/⌘ + Shift + O)"
        onClick={() => props.onToggle("outlineOpen")}
      >
        <Icon name="outline" size={13} />
      </button>
      <button
        type="button"
        className={cn("statusbar__item", "statusbar__item--button", settings.typewriter && "is-on")}
        title="打字机模式 (Ctrl/⌘ + Shift + Y)"
        onClick={() => props.onToggle("typewriter")}
      >
        <Icon name="typewriter" size={13} />
      </button>
      <button
        type="button"
        className={cn("statusbar__item", "statusbar__item--button", settings.focus && "is-on")}
        title="专注模式 (Ctrl/⌘ + Shift + D)"
        onClick={() => props.onToggle("focus")}
      >
        <Icon name="focus" size={13} />
      </button>
      <button
        type="button"
        className="statusbar__item statusbar__item--button"
        title="查看历史快照"
        onClick={props.onOpenHistory}
      >
        <Icon name="clock" size={13} />
        {props.snapshotCount ? `历史 ${props.snapshotCount}` : "历史"}
      </button>
      <button
        type="button"
        className="statusbar__item statusbar__item--button"
        title="切换亮色 / 暗色 (Ctrl/⌘ + Alt + T)"
        onClick={props.onToggleAppearance}
      >
        <Icon name={settings.appearance === "dark" ? "sun" : "moon"} size={13} />
        {settings.appearance === "dark" ? "夜读" : "素笺"}
      </button>
      <button
        type="button"
        className="statusbar__item statusbar__item--button"
        title="设置"
        onClick={props.onOpenSettings}
      >
        <Icon name="settings" size={13} />
      </button>
    </footer>
  );
}
