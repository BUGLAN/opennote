import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createStore, useStore } from "../lib/store";
import { closeDialog, dialogStore, useDialogRequest } from "../lib/dialogs";
import { dismissToast, useToasts } from "../lib/toast";
import { cn } from "../lib/utils";
import { Icon, type IconName } from "./Icons";

/* ============================== context menu ============================ */

export interface MenuItem {
  id: string;
  label: string;
  icon?: IconName;
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
              {item.icon ? <Icon name={item.icon} size={14} /> : <span style={{ width: 14 }} />}
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

/* ================================= toasts =============================== */

export function Toasts(): ReactNode {
  const toasts = useToasts();
  if (!toasts.length) return null;
  return (
    <div className="toast-root">
      {toasts.map((toast) => (
        <div key={toast.id} className={cn("toast", toast.kind === "danger" && "toast--danger")} role="status">
          <span>{toast.message}</span>
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
