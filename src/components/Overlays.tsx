// React 的 `KeyboardEvent` 会**遮蔽** DOM 的同名全局类型，而本文件下面还有几处
// `window.addEventListener("keydown", …)` 用的是全局那个。所以这里起别名，
// 两个类型各归各位（改名而不是改用法：window 上的监听器确实该用 DOM 事件类型）。
import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { createStore, useStore } from "../lib/store";
import { closeDialog, dialogStore, useDialogRequest, type FolderChoice } from "../lib/dialogs";
import { folderChoiceTrail, folderChoiceTree, type FolderChoiceNode } from "../data/library";
import { getUi } from "../data/ui";
import type { Id } from "../data/types";
import { dismissToast, useToasts } from "../lib/toast";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icons";

/* ============================== context menu ============================ */

export interface MenuItem {
  id: string;
  label: string;
  /**
   * 图标**必填**。原来是 `icon?: IconName`，渲染层对「没给图标」的情形**静默**补一个 14px 空位 ——
   * 于是漏写一个图标只表现为「那一行左边空着」（0.5.0 用户实测：标签右键菜单的「关闭其他标签」），
   * 类型系统与测试都看不见。改成必填后，漏写会在 `pnpm typecheck`（= `pnpm build` 的一环）就红。
   *
   * 只能用 `Icon` 既有的名字：`DESIGN.md` 明写「不要引入新图标集，缺图标先讨论」。
   */
  icon: IconName;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  separatorBefore?: boolean;
  run: () => void;
}

interface MenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

export const menuStore = createStore<MenuState | null>(null);

export function openMenu(clientX: number, clientY: number, items: MenuItem[]): void {
  if (!items.length) return;
  menuStore.set({ x: clientX, y: clientY, items });
}

export function closeMenu(): void {
  menuStore.set(null);
}

export function MenuHost(): ReactNode {
  const menu = useStore(menuStore);
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const x = Math.min(menu.x, window.innerWidth - rect.width - 8);
    const y = Math.min(menu.y, window.innerHeight - rect.height - 8);
    ref.current.style.left = `${Math.max(8, x)}px`;
    ref.current.style.top = `${Math.max(8, y)}px`;
  }, [menu]);

  useEffect(() => {
    if (!menu) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", closeMenu);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", closeMenu);
    };
  }, [menu]);

  if (!menu) return null;

  return (
    <>
      <div className="scrim--menu" style={{ display: "block" }} onMouseDown={closeMenu} onContextMenu={(e) => e.preventDefault()} />
      <div className="menu" ref={ref} role="menu" style={{ left: menu.x, top: menu.y }}>
        {menu.items.map((item) => (
          <div key={item.id}>
            {item.separatorBefore ? <div className="menu__sep" /> : null}
            <button
              type="button"
              className={cn("menu__item", item.danger && "is-danger")}
              disabled={item.disabled}
              onClick={() => {
                closeMenu();
                item.run();
              }}
            >
              <Icon name={item.icon} size={14} />
              <span>{item.label}</span>
              {item.shortcut ? <kbd>{item.shortcut}</kbd> : null}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

/* ================================== modal =============================== */

export function Modal({
  title,
  children,
  footer,
  onClose,
  wide = false,
  settings = false,
  tall = false,
}: {
  title: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  onClose: () => void;
  wide?: boolean;
  settings?: boolean;
  /**
   * 固定高度（`app.css` 的 `.dialog--tall`）：设置面板与 UI-03 收件箱用同一个高度，
   * 切换分类/筛选或内容长短变化时面板不再伸缩。
   */
  tall?: boolean;
}): ReactNode {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);

  return (
    <div className="overlay-root">
      <div className="scrim" onMouseDown={onClose} />
      <div
        className={cn("dialog", settings ? "dialog--settings" : wide && "dialog--wide", tall && "dialog--tall")}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === "string" ? title : undefined}
      >
        <header className="dialog__head">
          <h2 className="dialog__title">{title}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" />
          </button>
        </header>
        <div className="dialog__body">{children}</div>
        {footer ? <footer className="dialog__foot">{footer}</footer> : null}
      </div>
    </div>
  );
}

/* ============================ prompt / confirm ========================== */

export function DialogHost(): ReactNode {
  const request = useDialogRequest();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (request?.kind === "prompt") {
      setValue(request.value);
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [request?.id, request?.kind, request?.kind === "prompt" ? request.value : ""]);

  if (!request) return null;

  // 文件夹选择器自带键盘导航状态，交给它自己的组件（`key` 绑请求 id，
  // 换一次请求就重新按初始高亮项初始化 —— 与 `ConflictDialogHost` 同一写法）。
  if (request.kind === "folder") {
    return (
      <FolderDialog
        key={request.id}
        title={request.title}
        message={request.message}
        note={request.note}
        choices={request.choices}
        value={request.value}
        confirmLabel={request.confirmLabel}
        onResolve={(choice) => {
          request.resolve(choice);
          dialogStore.set(null);
        }}
        onClose={closeDialog}
      />
    );
  }

  const submit = () => {
    if (request.kind === "prompt") {
      const next = value.trim();
      if (!next && !request.allowEmpty) return;
      request.resolve(next);
    } else {
      request.resolve(true);
    }
    dialogStore.set(null);
  };

  return (
    <Modal
      title={request.title}
      onClose={closeDialog}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={closeDialog}>
            {request.cancelLabel ?? "取消"}
          </button>
          <button
            type="button"
            className={cn("btn", "btn--primary", request.danger && "btn--danger")}
            onClick={submit}
          >
            {request.confirmLabel ?? "确定"}
          </button>
        </>
      }
    >
      {request.message ? <p className="dialog__message">{request.message}</p> : null}
      {request.kind === "prompt" ? (
        <div style={{ marginTop: request.message ? 14 : 0 }}>
          {request.label ? (
            <label className="muted" style={{ display: "block", fontSize: 12.5, marginBottom: 6 }} htmlFor="dialog-input">
              {request.label}
            </label>
          ) : null}
          <input
            id="dialog-input"
            ref={inputRef}
            className="field"
            value={value}
            placeholder={request.placeholder}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
      ) : null}
      {request.note ? <p className="dialog__note">{request.note}</p> : null}
    </Modal>
  );
}

/**
 * 「移动到…」目标文件夹选择器（UI 原语，`askFolder()` 的宿主）。
 *
 * 五条设计决定：
 * 1. **与左栏同一棵树**（0.3.4 用户：「样式我期望能和首页文件夹样式相同」）：
 *    行、caret、图标、高亮全部复用 `.tree__*`，交互也和左栏一致 ——
 *    点行 = 选中并翻转折叠，点 caret = 只折叠。文件夹多了能收起来，不再是拍平的一大列。
 * 2. **展开状态是选择器自己的**：从左栏的 `ui.expanded` **起步**但不**写回** ——
 *    用户在弹窗里翻目录，不该顺手改掉主页的布局。
 * 3. **打开时先把选中项的祖先全部展开**（`folderChoiceTrail`）：目标藏在收起的
 *    分支里，用户就看不见「我现在选的是哪」。
 * 4. **搜索**（0.3.4 用户：「最好能支持搜索」）：按名字或完整路径过滤；命中项
 *    拍平成一行两段（名字 + 完整路径）—— 不同父目录下的同名目录，只有完整路径能区分。
 * 5. **置灰当前目录**（选中它是空操作），理由写在行内（「当前」两个字），
 *    不让用户白点一次再由数据层静默 return；`↑/↓` 只在**可见**行里走。
 */
function FolderDialog({
  title,
  message,
  note,
  choices,
  value,
  confirmLabel,
  onResolve,
  onClose,
}: {
  title: string;
  message?: string;
  note?: string;
  choices: FolderChoice[];
  value: Id | null;
  confirmLabel?: string;
  onResolve: (choice: FolderChoice | null) => void;
  onClose: () => void;
}): ReactNode {
  // 拍平候选 → 树形（根 = 「笔记本根目录」，顶层文件夹是它的孩子）。
  const tree = useMemo(() => folderChoiceTree(choices), [choices]);

  // 搜索：名字或完整路径命中都算（按路径搜，能找到「知道有这么个目录、忘了叫什么」）。
  const [query, setQuery] = useState("");
  const searching = query.trim().length > 0;
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return choices.filter(
      (choice) => choice.label.toLowerCase().includes(q) || choice.path.toLowerCase().includes(q),
    );
  }, [choices, query]);

  // 展开状态：从左栏的 `ui.expanded` **起步**，再把选中项的祖先补上；只在选择器内部用、
  // **不写回** —— 用户在弹窗里翻目录，不该顺手改掉主页的布局。
  // 根目录项的 id 是 `null`，它也在可折叠之列，所以集合的元素是 `Id | null`。
  const [openIds, setOpenIds] = useState<(Id | null)[]>(() => {
    const seeded = new Set<Id | null>(getUi().expanded);
    for (const step of folderChoiceTrail(choices, value)) seeded.add(step.id);
    return [...seeded];
  });
  const isOpen = (id: Id | null) => openIds.includes(id);
  const toggle = (id: Id | null) =>
    setOpenIds((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));

  /** 眼下画得出来的那些行：树模式跟着折叠状态走，搜索模式是拍平的命中项。 */
  const rows = useMemo<{ choice: FolderChoice; hasChildren: boolean; open: boolean }[]>(() => {
    if (searching) return matches.map((choice) => ({ choice, hasChildren: false, open: false }));
    const out: { choice: FolderChoice; hasChildren: boolean; open: boolean }[] = [];
    const walk = (nodes: FolderChoiceNode[]) => {
      for (const node of nodes) {
        const open = isOpen(node.choice.id);
        out.push({ choice: node.choice, hasChildren: node.children.length > 0, open });
        if (open) walk(node.children);
      }
    };
    walk(tree);
    return out;
    // `isOpen` 读的是同一渲染的 `openIds`，把它列进依赖就够了。
  }, [tree, openIds, searching, matches]);

  // 可选项（跳过置灰的）——键盘导航与「当前高亮」都只看这一组。
  const usable = useMemo(() => rows.filter((row) => !row.choice.disabled), [rows]);
  const initial = useMemo(() => {
    const hit = usable.find((row) => row.choice.id === value);
    return hit?.choice.id ?? usable[0]?.choice.id ?? null;
  }, [usable, value]);
  const [selected, setSelected] = useState<Id | null>(initial);
  const listRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // 焦点落在搜索框：打开就能直接打字过滤；`↑/↓` 从这里接管高亮（见 `navigate`）。
  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  const settle = () => {
    const hit = usable.find((row) => row.choice.id === selected);
    onResolve(hit?.choice ?? null);
  };

  /**
   * `↑/↓` 在**可见**行里移动（收起的分支不可达），`Home/End` 跳到首尾，`Enter` 结算。
   * 搜索框与列表共用这一份 —— 焦点在哪儿，键盘语义都一样。
   */
  const navigate = (event: ReactKeyboardEvent<HTMLInputElement | HTMLDivElement>) => {
    if (!usable.length) return;
    const index = usable.findIndex((row) => row.choice.id === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : usable.length - 1;
      setSelected(usable[(Math.max(index, 0) + step) % usable.length].choice.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      setSelected(usable[0].choice.id);
    } else if (event.key === "End") {
      event.preventDefault();
      setSelected(usable[usable.length - 1].choice.id);
    } else if (event.key === "Enter") {
      event.preventDefault();
      settle();
    }
  };

  /**
   * 画一行。树模式与搜索模式共用这一份：
   * - 树模式带 caret（有孩子才画）与开/合文件夹图标，缩进与左栏**同一个公式**（`6 + depth*13`）；
   * - 搜索模式没有层级可画，第二段给完整路径（不同父目录下的同名目录，只有它能区分）。
   */
  const renderRow = (row: { choice: FolderChoice; hasChildren: boolean; open: boolean }, stacked: boolean) => {
    const { choice, hasChildren, open } = row;
    // 高亮只画在**可选**项上：全部候选都被置灰时（笔记已在根目录、而笔记本里
    // 一个文件夹都没有），`selected` 会留在 `null`，那时根项会「看起来选中了」
    // 却点不动 —— 一条自相矛盾的界面。
    const active = !choice.disabled && choice.id === selected;
    return (
      <div
        key={choice.id ?? "\u0000root"}
        role="option"
        aria-selected={active}
        aria-disabled={choice.disabled ? true : undefined}
        aria-expanded={!stacked && hasChildren ? open : undefined}
        className={cn("tree__row", active && "is-active", choice.disabled && "is-dim", stacked && "tree__row--stacked")}
        style={{ paddingLeft: 6 + choice.depth * 13 }}
        // 完整路径挂在 `title` 上：单段名在深层目录里会重名，缩进看不出谁是谁。
        title={choice.path || "笔记本根目录"}
        onClick={() => {
          if (!choice.disabled) setSelected(choice.id);
          // 点行 = 选中 + 翻转折叠（与左栏一致）；搜索结果没有层级可翻。
          if (!stacked && hasChildren) toggle(choice.id);
        }}
        onDoubleClick={() => {
          if (!choice.disabled) settle();
        }}
      >
        <span
          className={cn("tree__caret", open && "is-open")}
          onClick={(event) => {
            // caret 只管折叠，不许把「选中」也带上 —— 与左栏同一个分工。
            event.stopPropagation();
            if (!stacked && hasChildren) toggle(choice.id);
          }}
        >
          {!stacked && hasChildren ? <Icon name="chevronRight" size={13} /> : null}
        </span>
        <span className="tree__icon">
          <Icon name={choice.id === null ? "layers" : open && hasChildren ? "folderOpen" : "folder"} size={14} />
        </span>
        <span className="tree__label">
          {choice.label}
          {stacked ? <span className="tree__note-snippet">{choice.path || "笔记本根目录"}</span> : null}
        </span>
        {choice.disabled ? <span className="tree__meta">当前</span> : null}
      </div>
    );
  };

  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <div className="spacer" />
          <button type="button" className="btn" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={!usable.length} onClick={settle}>
            {confirmLabel ?? "移动"}
          </button>
        </>
      }
    >
      {message ? <p className="dialog__message">{message}</p> : null}
      {/* 搜索框与左栏的是同一个类（`.field--search`）：同样的放大镜、同样的高度。
          焦点默认落在这里 —— 打开就能直接打字过滤，`↑/↓` 从这里接管高亮。 */}
      <input
        ref={searchRef}
        className="field field--search"
        type="text"
        aria-label="搜索文件夹"
        placeholder="搜索文件夹…"
        value={query}
        style={{ margin: "10px 0" }}
        onChange={(event) => setQuery(event.target.value)}
        onKeyDown={navigate}
      />
      {rows.length ? (
        <div
          ref={listRef}
          className="folder-picker tree"
          role="listbox"
          aria-label="目标文件夹"
          tabIndex={0}
          onKeyDown={navigate}
        >
          {rows.map((row) => renderRow(row, searching))}
        </div>
      ) : (
        // 一个可选目标都没有：与其给一个点了什么都不发生的「移动」，不如直说为什么。
        // 「搜索没命中」与「根本没有别的文件夹」是两件事，各说各的。
        <p className="tree__empty">
          {searching ? `没有找到「${query.trim()}」。` : "还没有别的文件夹可以放。先在左侧新建一个文件夹，再回来移动。"}
        </p>
      )}
      {note ? <p className="dialog__note">{note}</p> : null}
    </Modal>
  );
}

/* ================================= toasts =============================== */

export function Toasts(): ReactNode {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toast-root">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("toast", toast.kind === "danger" && "toast--danger")} role="status">
          {/*
           * 消息恒单行（.toast__msg 省略三件套），动作按钮恒宽（.toast__action 的 flex:none）——
           * 长标题不会再把药丸撑成两行板砖，也不会把「撤销」挤成竖排两个字。
           * detail 存在时包一层 .toast__body，主文案 + 次级说明小字两段（仅撤销降级场景）。
           */}
          {toast.detail ? (
            <span className="toast__body">
              <span className="toast__msg">{toast.message}</span>
              <span className="toast__sub">{toast.detail}</span>
            </span>
          ) : (
            <span className="toast__msg">{toast.message}</span>
          )}
          {toast.action ? (
            <button
              type="button"
              className="toast__action"
              onClick={() => {
                dismissToast(toast.id);
                toast.action?.run();
              }}
            >
              {toast.action.label}
            </button>
          ) : null}
        </div>
      ))}
    </div>
  );
}
