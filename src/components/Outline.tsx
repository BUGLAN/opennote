import type { ReactNode } from "react";
import type { Heading } from "../lib/outline";
import { cn } from "../lib/utils";
import { Icon } from "./Icons";

interface OutlineProps {
  headings: Heading[];
  currentIndex: number;
  open: boolean;
  onJump(pos: number): void;
  onClose(): void;
}

export function Outline({ headings, currentIndex, open, onJump, onClose }: OutlineProps): ReactNode {
  return (
    <aside className={cn("outline", !open && "is-collapsed")} aria-hidden={!open}>
      <div className="outline__head">
        <span>大纲</span>
        <button type="button" className="icon-btn" style={{ width: 22, height: 22 }} title="隐藏大纲" onClick={onClose}>
          <Icon name="close" size={13} />
        </button>
      </div>
      <div className="outline__body">
        {headings.length ? (
          headings.map((heading, index) => (
            <button
              key={`${heading.line}-${index}`}
              type="button"
              className={cn("outline__item", index === currentIndex && "is-current")}
              style={{ paddingLeft: 8 + (heading.level - 1) * 11, fontSize: heading.level <= 2 ? 13 : 12.5 }}
              title={heading.text}
              onClick={() => onJump(heading.pos)}
            >
              {heading.text}
            </button>
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
}
