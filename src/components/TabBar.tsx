import { useRef, type ReactNode } from "react";
import type { Id, Note } from "../data/types";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";

interface TabBarProps {
  tabs: Id[];
  notes: Record<Id, Note>;
  activeId: Id | null;
  dirty: Record<Id, true>;
  /** 当前活动笔记是否处于只读锁定（`ui.lockedNotes`，或 HTML 页面的强制只读）。 */
  locked: boolean;
  /**
   * 「这个锁**不是用户上的**，也解不开」。
   *
   * 目前只有一种来源：HTML 页面（只读页面类型）。按钮会 disabled 并换一句 title ——
   * 用户点了没反应又不知道为什么，比按钮不存在更糟。
   */
  lockForced?: boolean;
  onSelect(id: Id): void;
  onClose(id: Id): void;
  /** 切换当前笔记的只读锁定。0.4.0 起新建笔记走命令面板（⌘）与 Ctrl/⌘ + N，这颗位置让给锁。 */
  onToggleLock(): void;
  onPalette(): void;
  onContextMenu(event: React.MouseEvent, id: Id): void;
}

export function TabBar({
  tabs,
  notes,
  activeId,
  dirty,
  locked,
  lockForced = false,
  onSelect,
  onClose,
  onToggleLock,
  onPalette,
  onContextMenu,
}: TabBarProps): ReactNode {
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
          title={
            lockForced
              ? "HTML 页面是只读的 — 这是页面类型决定的，不能解锁"
              : locked
                ? "只读中 — 点击解锁编辑"
                : "只读模式（锁定编辑）"
          }
          aria-pressed={locked}
          // HTML 页面：disabled，且**不给** onToggleLock 留任何幻觉（回调里也挡了一道）。
          disabled={!activeId || lockForced}
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
