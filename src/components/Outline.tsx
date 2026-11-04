import { memo, useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import type { Heading } from "../lib/outline";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";

interface OutlineProps {
  headings: Heading[];
  currentIndex: number;
  open: boolean;
  /** 跳到标题所在的**行**（不是字符偏移：App 会沿用结构没变的旧标题数组，见 `sameOutline`）。 */
  onJump(line: number): void;
  onClose(): void;
}

/** 收起动画（`--dur`）走完之后才清空条目，滑出去的那一段里内容还在。 */
const COLLAPSE_SETTLE_MS = 260;

/**
 * memo 两层：
 * - 外层：`CursorOutline` 跟着光标行号重渲染时，「当前标题」没变就整块跳过；
 * - 条目：App 每次重渲染都会递来新的 `onJump` / `onClose`，外层拦不住，但条目只收
 *   原始值 + 一个稳定的跳转回调，上千个标题里只有真正变了的那几行会重画。
 * 收起后不渲染条目：大纲藏着的时候打字（加一行会让下面所有标题的行号都变）不该付这份钱。
 */
export const Outline = memo(function Outline({ headings, currentIndex, open, onJump, onClose }: OutlineProps): ReactNode {
  const jumpRef = useRef(onJump);
  jumpRef.current = onJump;
  const jump = useCallback((line: number) => jumpRef.current(line), []);

  const [showItems, setShowItems] = useState(open);
  useEffect(() => {
    if (open) {
      setShowItems(true);
      return;
    }
    const timer = window.setTimeout(() => setShowItems(false), COLLAPSE_SETTLE_MS);
    return () => window.clearTimeout(timer);
  }, [open]);

  return (
    // 收起后它还在 DOM 里（只是滑到屏幕外）：inert 让里面的按钮退出 Tab 顺序与读屏，
    // 光有 aria-hidden 时按钮仍能被聚焦。
    <aside className={cn("outline", !open && "is-collapsed")} inert={!open}>
      <div className="outline__head">
        <span>大纲</span>
        <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="隐藏大纲" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="outline__body">
        {!showItems ? null : headings.length ? (
          headings.map((heading, index) => (
            // key 用下标：回车会让下面所有标题的行号 +1，按行号做 key 就是整列卸载重建。
            <OutlineItem
              key={index}
              level={heading.level}
              text={heading.text}
              line={heading.line}
              current={index === currentIndex}
              onJump={jump}
            />
          ))
        ) : (
          <p className="tree__empty" style={{ textAlign: "left" }}>
            这条笔记还没有标题。
            <br />
            用 <code>#</code> 加空格开始一节，它就会出现在这里。
          </p>
        )}
      </div>
    </aside>
  );
});

const OutlineItem = memo(function OutlineItem({
  level,
  text,
  line,
  current,
  onJump,
}: {
  level: number;
  text: string;
  line: number;
  current: boolean;
  onJump(line: number): void;
}): ReactNode {
  return (
    <button
      type="button"
      className={cn("outline__item", current && "is-current")}
      style={{ paddingLeft: 8 + (level - 1) * 11, fontSize: level <= 2 ? 13 : 12.5 }}
      title={text}
      onClick={() => onJump(line)}
    >
      {text}
    </button>
  );
});
