import { useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import { folderPathLabel, notesArray, useLibrary } from "../data/library";
import { noteKind } from "../data/types";
import { fuzzyRank } from "../lib/fuzzy";

interface NotePickerProps {
  onClose(): void;
  onPick(noteId: string): void;
}

/**
 * 引用笔记选择器：列表 + 标题过滤。数据来自 library 的 notesArray（排除画布本身），
 * 过滤用仓库既有的 fuzzyRank；选中后由调用方在该画布视口中心生成文件卡片。
 */
export function NotePicker(props: NotePickerProps): ReactNode {
  const state = useLibrary();
  const [query, setQuery] = useState("");

  const notes = useMemo(
    // kind 是可选字段：读取一律经 noteKind() 归一化（缺省与坏值落回 "note"）
    () => notesArray(state).filter((note) => noteKind(note) !== "canvas").sort((a, b) => b.updatedAt - a.updatedAt),
    [state],
  );
  const ranked = useMemo(
    () => fuzzyRank(query, notes, (note) => [{ text: note.title, weight: 1 }, { text: note.id, weight: 0.5 }], 30),
    [query, notes],
  );

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    // 输入框里的按键不许漏给画布：Backspace / Delete 会删掉选中的节点
    event.stopPropagation();
    if (event.key === "Escape") props.onClose();
    if (event.key === "Enter" && ranked.length > 0) props.onPick(ranked[0].item.id);
  };

  return (
    <div
      className="canvas-picker"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) props.onClose();
      }}
    >
      <div className="canvas-picker__panel">
        <div className="canvas-picker__head">
          <div className="canvas-picker__title">引用笔记</div>
          <button className="canvas-picker__close" type="button" aria-label="关闭" onClick={() => props.onClose()}>
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" fill="none" stroke="currentColor" strokeWidth="1.5" />
            </svg>
          </button>
        </div>
        <input
          className="canvas-picker__filter"
          type="text"
          value={query}
          placeholder="按标题过滤…"
          spellCheck={false}
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
        <div className="canvas-picker__list" role="listbox" aria-label="笔记列表">
          {ranked.map((entry) => (
            <button
              key={entry.item.id}
              type="button"
              role="option"
              aria-selected="false"
              className="canvas-picker__item"
              onClick={() => props.onPick(entry.item.id)}
            >
              <span className="canvas-picker__name">{entry.item.title || "无标题"}</span>
              <span className="canvas-picker__path">{folderPathLabel(entry.item.folderId)}</span>
            </button>
          ))}
          {ranked.length === 0 && <div className="canvas-picker__empty">没有匹配的笔记</div>}
        </div>
      </div>
    </div>
  );
}
