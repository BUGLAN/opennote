import { createStore, useStore } from "./store";
import type { FolderChoice, Id } from "../data/types";
import { uid } from "./utils";

/** 选择器的候选项形状由数据层定义（`FolderChoice`），这里只转发，避免两处各写一份。 */
export type { FolderChoice };

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

/**
 * 「选一个文件夹」请求（侧栏「移动到…」用）。
 *
 * 与 `prompt` 的区别不是外观而是**可选集合**：文件夹是树，用户必须从一个**封闭**的
 * 候选集里选。用 `prompt` 让他手敲路径，就等于把「路径合法性」交给用户负责 ——
 * 敲错一个字符就是一次失败的移动。所以这里给一个列表，选中即结算。
 *
 * `resolve` 交出的是**整个选中的候选项**（而不是 `Id`）：因为 `null` 既是「工作区根目录」
 * 的合法取值、又是「取消」的惯用返回值，两者撞在同一个值上，用户点「取消」就会被当成
 * 「移到根目录」——一次静默的文件搬家。交出候选项对象之后，`null` 只剩「取消」一种含义。
 */
export interface FolderRequest extends BaseRequest {
  kind: "folder";
  /** 候选项（已按树的顺序拍平，含缩进信息）。 */
  choices: FolderChoice[];
  /** 初始高亮项（通常是笔记当前所在目录）。 */
  value: Id | null;
  resolve: (choice: FolderChoice | null) => void;
}

export type DialogRequest = PromptRequest | ConfirmRequest | FolderRequest;

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
  else if (request.kind === "folder") request.resolve(null);
  else request.resolve(false);
  dialogStore.set(null);
}

/**
 * 让用户从一个**封闭的文件夹集合**里选一个落点。取消返回 `null`，否则返回选中的候选项。
 *
 * 调用方拿到的 `choice.id` 才是目标目录（`null` = 工作区根目录）：
 * ```ts
 * const choice = await askFolder({ ... });
 * if (choice) await moveNote(note.id, choice.id);
 * ```
 */
export function askFolder(options: {
  title: string;
  message?: string;
  note?: string;
  choices: FolderChoice[];
  value?: Id | null;
  confirmLabel?: string;
}): Promise<FolderChoice | null> {
  return new Promise((resolve) => {
    dialogStore.set({
      kind: "folder",
      id: uid(),
      title: options.title,
      message: options.message,
      note: options.note,
      choices: options.choices,
      value: options.value ?? null,
      confirmLabel: options.confirmLabel ?? "移动",
      resolve,
    });
  });
}
