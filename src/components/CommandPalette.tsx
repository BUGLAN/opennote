import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { fuzzyRank, highlightRanges } from "../lib/fuzzy";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icons";

export interface PaletteEntry {
  id: string;
  kind: "note" | "command" | "heading" | "tag";
  title: string;
  sub?: string;
  icon: IconName;
  shortcut?: string;
  keywords?: string;
  /** Filled in by the palette when a query matches. */
  ranges?: [number, number][];
  run(): void;
}

interface CommandPaletteProps {
  mode: "all" | "commands";
  entries: PaletteEntry[];
  onClose(): void;
}

const KIND_LABEL: Record<PaletteEntry["kind"], string> = {
  note: "笔记",
  command: "命令",
  heading: "本页",
  tag: "标签",
};

export function CommandPalette({ mode, entries, onClose }: CommandPaletteProps): ReactNode {
  const [query, setQuery] = useState(mode === "commands" ? ">" : "");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.setSelectionRange(1, 1);
  }, []);

  const results = useMemo<PaletteEntry[]>(() => {
    const raw = query.trim();
    let scoped = entries;
    let text = raw;
    if (raw.startsWith(">")) {
      scoped = entries.filter((entry) => entry.kind === "command" || entry.kind === "heading");
      text = raw.slice(1).trim();
    } else if (raw.startsWith("#")) {
      scoped = entries.filter((entry) => entry.kind === "tag");
      text = raw.slice(1).trim();
    }
    if (!text) return scoped.slice(0, 60);
    return fuzzyRank(
      text,
      scoped,
      (entry) => [
        { text: entry.title, weight: 1 },
        { text: entry.keywords ?? "", weight: 0.5 },
        { text: entry.sub ?? "", weight: 0.35 },
      ],
      60,
    ).map((ranked) => ({ ...ranked.item, ranges: ranked.ranges }));
  }, [entries, query]);

  useEffect(() => {
    setActive(0);
  }, [query]);

  useEffect(() => {
    const node = listRef.current?.querySelector<HTMLElement>(".palette__item.is-active");
    node?.scrollIntoView({ block: "nearest" });
  }, [active, results]);

  const run = (entry: PaletteEntry | undefined) => {
    if (!entry) return;
    onClose();
    // let the overlay unmount before the action moves focus around
    requestAnimationFrame(() => entry.run());
  };

  return (
    <div className="overlay-root overlay-root--palette">
      <div className="scrim" onMouseDown={onClose} />
      <div className="palette" role="dialog" aria-modal="true" aria-label="命令面板">
        <input
          ref={inputRef}
          className="palette__input"
          value={query}
          placeholder="搜索笔记，或输入 > 执行命令、# 找标签"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault();
              setActive((current) => Math.min(current + 1, results.length - 1));
            } else if (event.key === "ArrowUp") {
              event.preventDefault();
              setActive((current) => Math.max(current - 1, 0));
            } else if (event.key === "Enter") {
              event.preventDefault();
              run(results[active]);
            } else if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
          }}
        />
        <div className="palette__list" ref={listRef}>
          {results.length ? (
            results.map((entry, index) => (
              <button
                key={entry.id}
                type="button"
                className={cn("palette__item", index === active && "is-active")}
                onMouseMove={() => setActive(index)}
                onClick={() => run(entry)}
              >
                <span className="palette__item-icon">
                  <Icon name={entry.icon} size={15} />
                </span>
                <span className="palette__item-main">
                  <span className="palette__item-title">
                    {(entry.ranges?.length ? highlightRanges(entry.title, entry.ranges) : [{ text: entry.title, hit: false }]).map(
                      (part, partIndex) =>
                        part.hit ? (
                          <mark className="hit" key={partIndex}>
                            {part.text}
                          </mark>
                        ) : (
                          <span key={partIndex}>{part.text}</span>
                        ),
                    )}
                  </span>
                  {entry.sub ? <span className="palette__item-sub">{entry.sub}</span> : null}
                </span>
                {entry.shortcut ? <kbd>{entry.shortcut}</kbd> : <span className="palette__kind">{KIND_LABEL[entry.kind]}</span>}
              </button>
            ))
          ) : (
            <p className="tree__empty" style={{ padding: "28px 16px" }}>
              没有匹配的结果。
            </p>
          )}
        </div>
        <footer className="palette__foot">
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> 选择
          </span>
          <span>
            <kbd>Enter</kbd> 执行
          </span>
          <span>
            <kbd>Esc</kbd> 关闭
          </span>
          <span style={{ marginLeft: "auto" }}>{results.length} 项</span>
        </footer>
      </div>
    </div>
  );
}
