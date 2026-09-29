import { createStore, useStore } from "./store";
import { uid } from "./utils";

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastItem {
  id: string;
  message: string;
  kind: "info" | "danger";
  action?: ToastAction;
}

export const toastStore = createStore<ToastItem[]>([]);

export function notify(message: string, options: { kind?: "info" | "danger"; action?: ToastAction; duration?: number } = {}): string {
  const id = uid();
  const item: ToastItem = {
    id,
    message,
    kind: options.kind ?? "info",
    action: options.action,
  };
  const next = [...toastStore.get(), item].slice(-4);
  toastStore.set(next);
  const duration = options.duration ?? (options.action ? 6000 : 2600);
  setTimeout(() => dismissToast(id), duration);
  return id;
}

export function dismissToast(id: string): void {
  toastStore.set(toastStore.get().filter((toast) => toast.id !== id));
}

export function useToasts(): ToastItem[] {
  return useStore(toastStore);
}
