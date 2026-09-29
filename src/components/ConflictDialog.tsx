/**
 * UI-06 · 冲突与去重决策对话框。
 *
 * 只有「同名」「同 URL」「正在编辑同一篇」这三种情况才需要它，而且**默认不弹**：
 * 00 号 §6.3 已经给了默认策略（同名 → `new` 加序号；同 URL → `append`；正在编辑 → 先保存再追加）。
 * 这个界面服务于「用户想在这一次改动默认行为」。
 *
 * 与 L2 接收端的接线（C3 只需两步）：
 * ```tsx
 * // 1. 挂一次（应用根部，常驻）
 * useEffect(() => { installImportConflictDialog(); return uninstallImportConflictDialog; }, []);
 * // 2. 渲染宿主
 * <ConflictDialogHost />
 * ```
 * 装好之后，`receiveEnvelope()` 在「目标笔记正在编辑」时会通过 `setImportConflictResolver()`
 * 问到这里；没有装（CLI / 本地桥 / 收件箱入库）时走确定性默认策略（先 `flushAll()` 再追加）。
 *
 * 文案与交互严格按 03 号 UI-06（标题/正文/选项/按钮/禁用说明逐字），并且**永不出现「覆盖」选项**
 * （FR-18：正在编辑的笔记不自动覆盖）。
 */

import { type KeyboardEvent, type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "./Icons";
import { Modal } from "./Overlays";
import { createStore, useStore } from "../lib/store";
import { cn, formatRelativeTime } from "../lib/utils";
import { setImportConflictResolver, type ImportConflictChoice } from "../lib/clip/receive";

export type ConflictKind = "same-name" | "same-url" | "editing";

/** 与接收端的 `ImportConflictChoice` 同一个类型，避免两套枚举漂移。 */
export type ConflictChoice = ImportConflictChoice;

export interface ConflictDialogRequest {
  kind: ConflictKind;
  /** 既有笔记的标题（不含 `.md`），用于 `《{标题}》` 各处。 */
  title: string;
  /** 新建时的实际文件名（含序号），用于选项 1 的说明行；缺省 = `{title} 2`。 */
  renamedTitle?: string | null;
  /** 上次剪藏时间（ISO 8601 字符串或毫秒时间戳），S2 的副行用。 */
  lastCapturedAt?: string | number | null;
  /** 「追加到已有笔记」是否可选（S5：回收站里的笔记不能追加）。 */
  appendable?: boolean;
  /** S5 的禁用说明（逐字默认值：`这篇笔记在回收站里，不能追加。`）。 */
  appendDisabledReason?: string;
  /** 默认策略。**「取消」不是「什么都不做」**，而是按它处理（UI-06 交互流程第 3 条）。 */
  fallback?: ConflictChoice;
  /** 推荐项（S1：URL 相同 → `append`；URL 不同 → `new`）。缺省 `append`。 */
  recommended?: "new" | "append";
}

export interface ConflictDialogProps extends ConflictDialogRequest {
  /**
   * 用户点「继续」→ 拿到选择；点「取消」/`Esc`/点遮罩 → 拿到 `fallback`。
   * 返回 Promise 时对话框保持 S6 的「正在写入…」状态直到它 settle。
   */
  onResolve: (choice: ConflictChoice) => void | Promise<void>;
  /** 由外部控制的写入中状态（与 `onResolve` 返回 Promise 二者取并集）。 */
  busy?: boolean;
}

const OPTION_COPY = {
  new: { label: "新建一篇", icon: "plus" as const },
  append: { label: "追加到已有笔记", icon: "layers" as const },
  skip: { label: "跳过这次", icon: "close" as const },
};

const DEFAULT_APPEND_DISABLED = "这篇笔记在回收站里，不能追加。";

function toMs(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

/** UI-06 的正文文案（逐字）。 */
function bodyText(request: ConflictDialogRequest): string {
  const title = request.title;
  if (request.kind === "editing") {
    return `《${title}》有未写入的改动。追加会在你保存后又写入一段，建议先保存。`;
  }
  if (request.kind === "same-url") {
    const at = toMs(request.lastCapturedAt);
    const when = at === null ? "刚刚" : formatRelativeTime(at);
    return `上次剪藏是 ${when}。默认追加到那篇笔记的末尾，也可以新建一篇。`;
  }
  return `《${title}》已经存在。选一种处理方式：`;
}

function titleText(kind: ConflictKind): string {
  if (kind === "editing") return "这篇笔记正在编辑";
  if (kind === "same-url") return "这个网址之前剪藏过";
  return "这个落点已经有同名笔记";
}

export function ConflictDialog({
  onResolve,
  busy = false,
  appendable = true,
  appendDisabledReason = DEFAULT_APPEND_DISABLED,
  fallback = "append",
  recommended,
  ...request
}: ConflictDialogProps): ReactNode {
  const appendRecommended = (recommended ?? "append") === "append" && appendable;
  const initial: ConflictChoice = appendRecommended ? "append" : "new";
  const [choice, setChoice] = useState<ConflictChoice>(initial);
  const [writing, setWriting] = useState(false);
  const optionRefs = useRef<Partial<Record<ConflictChoice, HTMLButtonElement | null>>>({});

  // 打开时焦点落在**推荐项**（不是第一项）：回车即得最常见结果（UI-06 键盘可达性）。
  useEffect(() => {
    optionRefs.current[initial]?.focus();
  }, [initial]);

  const disabled = writing || busy;
  const settle = useCallback(
    (value: ConflictChoice) => {
      if (disabled) return;
      const result = onResolve(value);
      if (result && typeof (result as Promise<void>).then === "function") {
        setWriting(true);
        void (result as Promise<void>).finally(() => setWriting(false));
      }
    },
    [disabled, onResolve],
  );

  const onOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const usable: ConflictChoice[] = appendable ? ["new", "append", "skip"] : ["new", "skip"];
      const index = usable.indexOf(choice);
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const step = event.key === "ArrowDown" ? 1 : usable.length - 1;
        const next = usable[(index + step) % usable.length] ?? usable[0];
        setChoice(next);
        optionRefs.current[next]?.focus();
      }
      // Enter / Space 交给原生 <button> 的 click，不在这里重复处理（避免一次按键结算两次）。
    },
    [appendable, choice],
  );

  const renamed = request.renamedTitle || `${request.title} 2`;
  const rows: { value: "new" | "append" | "skip"; description: string; disabled?: boolean; disabledNote?: string }[] = [
    {
      value: "new",
      description: `自动改名为《${renamed}》，原文件不动。`,
    },
    {
      value: "append",
      description: `在《${request.title}》末尾加一个分割线再写入。`,
      disabled: !appendable,
      disabledNote: appendDisabledReason,
    },
    { value: "skip", description: "不写入任何文件。" },
  ];

  return (
    <Modal
      title={titleText(request.kind)}
      onClose={() => settle(fallback)}
      footer={
        <>
          <button type="button" className="btn" disabled={disabled} onClick={() => settle(fallback)}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={disabled} onClick={() => settle(choice)}>
            {disabled ? "正在写入…" : "继续"}
          </button>
        </>
      }
    >
      <p className="dialog__message">{bodyText(request)}</p>
      <div
        className="workspace-choices"
        role="radiogroup"
        aria-label="处理方式"
        style={disabled ? { pointerEvents: "none", opacity: 0.6 } : undefined}
        onKeyDown={onOptionKeyDown}
      >
        {rows.map((row) => {
          const copy = OPTION_COPY[row.value];
          const selected = choice === row.value;
          // 「（推荐）」跟的是推荐项本身（S1：URL 相同 → 追加；URL 不同 → 新建），与选中态无关。
          const label = row.value === (appendRecommended ? "append" : "new") ? `${copy.label}（推荐）` : copy.label;
          return (
            <button
              key={row.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-describedby={`conflict-${row.value}-note`}
              aria-disabled={row.disabled ? true : undefined}
              disabled={row.disabled}
              className={cn("choice", selected && "is-active")}
              ref={(node) => {
                optionRefs.current[row.value] = node;
              }}
              tabIndex={selected ? 0 : -1}
              onClick={() => (selected ? settle(row.value) : setChoice(row.value))}
            >
              <Icon name={copy.icon} size={18} />
              <strong>{label}</strong>
              <small id={`conflict-${row.value}-note`}>{row.disabled ? row.disabledNote : row.description}</small>
            </button>
          );
        })}
      </div>
    </Modal>
  );
}

/* ============================ 与接收端接线 ============================ */

interface PendingConflict {
  request: ConflictDialogRequest;
  resolve: (choice: ConflictChoice) => void;
}

const conflictStore = createStore<PendingConflict | null>(null);

/** 问用户一次；对话框由 `ConflictDialogHost` 渲染。没有宿主时这个 Promise 永远不会 settle。 */
export function askConflict(request: ConflictDialogRequest): Promise<ConflictChoice> {
  return new Promise<ConflictChoice>((resolve) => {
    const previous = conflictStore.get();
    // 同一时刻只可能有一份冲突请求；旧的按默认策略结算，避免 Promise 泄漏。
    if (previous) previous.resolve(previous.request.fallback ?? "append");
    conflictStore.set({ request, resolve });
  });
}

function settleConflict(choice: ConflictChoice): void {
  const pending = conflictStore.get();
  conflictStore.set(null);
  pending?.resolve(choice);
}

/** 挂在应用根部的宿主组件：没有冲突请求时渲染 `null`。 */
export function ConflictDialogHost(): ReactNode {
  const pending = useStore(conflictStore);
  if (!pending) return null;
  // key 用请求身份，保证换一条请求时内部选中态重新按推荐项初始化。
  return <ConflictDialog key={String(pending.request.title) + pending.request.kind} {...pending.request} onResolve={settleConflict} />;
}

/** 把 `receiveEnvelope()` 的「正在编辑」询问接到这个对话框上（C3 在根部调用一次）。 */
export function installImportConflictDialog(): void {
  setImportConflictResolver((prompt) =>
    askConflict({
      kind: prompt.kind,
      title: prompt.title,
      lastCapturedAt: prompt.lastCapturedAt,
      recommended: prompt.recommended === "new" ? "new" : "append",
      fallback: "append",
    }),
  );
}

export function uninstallImportConflictDialog(): void {
  setImportConflictResolver(null);
  settleConflict("append");
}
