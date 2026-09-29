import { createStore, useStore } from "./store";
import { uid } from "./utils";

interface BaseRequest {
  id: string;
  title: string;
  message?: string;
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}

export interface PromptRequest extends BaseRequest {
  kind: "prompt";
  label?: string;
  value: string;
  placeholder?: string;
  allowEmpty?: boolean;
  resolve: (value: string | null) => void;
}

export interface ConfirmRequest extends BaseRequest {
  kind: "confirm";
  resolve: (value: boolean) => void;
}

export type DialogRequest = PromptRequest | ConfirmRequest;

export const dialogStore = createStore<DialogRequest | null>(null);

export function useDialogRequest(): DialogRequest | null {
  return useStore(dialogStore);
}

/** Imperative, promise-based prompt — keeps rename/delete flows readable. */
export function askText(options: {
  title: string;
  label?: string;
  value?: string;
  placeholder?: string;
  message?: string;
  note?: string;
  confirmLabel?: string;
  allowEmpty?: boolean;
}): Promise<string | null> {
  return new Promise((resolve) => {
    dialogStore.set({
      kind: "prompt",
      id: uid(),
      title: options.title,
      label: options.label,
      value: options.value ?? "",
      placeholder: options.placeholder,
      message: options.message,
      note: options.note,
      confirmLabel: options.confirmLabel ?? "确定",
      allowEmpty: options.allowEmpty,
      resolve,
    });
  });
}

export function askConfirm(options: {
  title: string;
  message?: string;
  note?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
}): Promise<boolean> {
  return new Promise((resolve) => {
    dialogStore.set({
      kind: "confirm",
      id: uid(),
      title: options.title,
      message: options.message,
      note: options.note,
      confirmLabel: options.confirmLabel ?? "确定",
      cancelLabel: options.cancelLabel ?? "取消",
      danger: options.danger,
      resolve,
    });
  });
}

export function closeDialog(): void {
  const request = dialogStore.get();
  if (!request) return;
  if (request.kind === "prompt") request.resolve(null);
  else request.resolve(false);
  dialogStore.set(null);
}
