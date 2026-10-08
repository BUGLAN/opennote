import { useRef, type ReactNode } from "react";
import type { Id, Note } from "../data/types";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";

interface TabBarProps {
  tabs: Id[];
  notes: Record<Id, Note>;
  activeId: Id | null;
  dirty: Record<Id, true>;
  /** 当前活动笔记是否处于只读锁定（`ui.lockedNotes`）。 */
  locked: boolean;
  onSelect(id: Id): void;
  onClose(id: Id): void;
  /** 切换当前笔记的只读锁定。0.4.0 起新建笔记走命令面板（⌘）与 Ctrl/⌘ + N，这颗位置让给锁。 */
  onToggleLock(): void;
  onPalette(): void;
  onContextMenu(event: React.MouseEvent, id: Id): void;
}

export function TabBar({ tabs, notes, activeId, dirty, locked, onSelect, onClose, onToggleLock, onPalette, onContextMenu }: TabBarProps): ReactNode {
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div className="tabbar" role="tablist">
      <div
        className="tabbar__scroll"
        ref={scrollRef}
        onWheel={(event) => {
          // vertical wheel scrolls the strip horizontally — no shift needed
          if (event.deltaY && scrollRef.current) scrollRef.current.scrollLeft += event.deltaY;
        }}
      >
        {tabs.map((id) => {
          const note = notes[id];
          if (!note) return null;
          const active = id === activeId;
          return (
            <div
              key={id}
              role="tab"
              aria-selected={active}
              tabIndex={0}
              className={cn("tab", active && "is-active")}
              title={note.title}
              onClick={() => onSelect(id)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  onSelect(id);
                }
              }}
              onAuxClick={(event) => {
                if (event.button === 1) {
                  event.preventDefault();
                  onClose(id);
                }
              }}
              onContextMenu={(event) => onContextMenu(event, id)}
            >
              <span className="tab__label">{note.title}</span>
              {dirty[id] ? <span className="tab__dirty" title="尚未写入本地库" /> : null}
              <button
                type="button"
                className="tab__close"
                title="关闭标签"
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(id);
                }}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
          );
        })}
      </div>
      <div className="tabbar__actions">
        <button
          type="button"
          className={cn("icon-btn", "tabbar__lock", locked && "is-locked")}
          title={locked ? "只读中 — 点击解锁编辑" : "只读模式（锁定编辑）"}
          aria-pressed={locked}
          disabled={!activeId}
          onClick={onToggleLock}
        >
          <Icon name={locked ? "lock" : "unlock"} />
        </button>
        <button type="button" className="icon-btn" title="命令面板 (Ctrl/⌘ + K)" onClick={onPalette}>
          <Icon name="command" />
        </button>
      </div>
    </div>
  );
}
