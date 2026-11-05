/**
 * 公开分享：侧栏右键「分享此链接」/「分享此文件」背后的那一点逻辑。
 *
 * 流程：确认（说清楚「这是快照、不同步、任何人可看、明文」）→ 把文件**此刻**的内容传给同步服务器
 * （`POST /v1/shares`）→ 拿回公开链接 → 自动复制、给出「打开 / 撤销」。
 *
 * - 「分享此链接」给的是只读网页（`/s/<id>`）：排版与应用里一致；
 * - 「分享此文件」给的是原文件本身（`/s/<id>/raw`）：浏览器直接打开或下载。
 *
 * 两者上传的是同一份快照，区别只在交出去的是哪个地址。
 *
 * ★ 一次性快照：之后再改这篇笔记，链接里的内容**不会**变；它不在任何笔记本里，不参与同步。
 * 要新内容就再分享一次（得到一个新链接）。
 */

import type { ShareCreated } from "../../shared/contract";
import { getLibrary } from "../data/library";
import { noteKind, type Note } from "../data/types";
import { createPublicShare, revokePublicShare } from "../sync/account";
import { SyncApiError } from "../sync/syncApi";
import { noteToPortableMarkdown } from "./export";
import { createStore, useStore } from "./store";
import { uid } from "./utils";

export type ShareMode = "page" | "file";

/** 文件名：工作区相对路径的最后一段（含扩展名，就是磁盘上的文件名）。 */
export function shareFileName(note: Pick<Note, "id">): string {
  return note.id.split("/").pop() || note.id;
}

/**
 * 这一刻要上传的字节。
 *
 * Markdown 笔记把引用的本地图片**内联成 data URL** 再传：快照要自给自足 —— 读者那边没有
 * 你的 `assets/` 目录，不内联就是一页裂图。画布、HTML 页面原样上传（HTML 入库时资源已内联）。
 * 用的是编辑器里的当前内容（包括还没落盘的那几秒），所见即所分享。
 */
export async function snapshotBytes(note: Note): Promise<Uint8Array> {
  const text = noteKind(note) === "note" ? await noteToPortableMarkdown(note, { inlineAssets: true }) : note.content;
  return new TextEncoder().encode(text);
}

/* ------------------------------------------------------------ 对话框状态 */

export type SharePhase =
  | { kind: "confirm" }
  | { kind: "working" }
  | { kind: "done"; share: ShareCreated; copied: boolean; revoked: boolean; revokeError: string | null }
  | { kind: "error"; message: string };

export interface ShareRequest {
  id: string;
  mode: ShareMode;
  note: Note;
  /** 同步服务器（只用来在确认框里说「传到哪」）。 */
  server: string;
  /** 账号开着端到端加密：要额外说一句「快照是明文」。 */
  encrypted: boolean;
  phase: SharePhase;
}

export const shareDialogStore = createStore<ShareRequest | null>(null);

export function useShareRequest(): ShareRequest | null {
  return useStore(shareDialogStore);
}

export function openShareDialog(input: { mode: ShareMode; note: Note; server: string; encrypted: boolean }): void {
  shareDialogStore.set({ id: uid(), ...input, phase: { kind: "confirm" } });
}

export function closeShareDialog(): void {
  shareDialogStore.set(null);
}

function setPhase(id: string, phase: SharePhase): void {
  shareDialogStore.set((current) => (current && current.id === id ? { ...current, phase } : current));
}

/** 分享出去的那个地址：网页还是原文件。 */
export function shareLink(share: ShareCreated, mode: ShareMode): string {
  return mode === "page" ? share.url : share.rawUrl;
}

function describeError(error: unknown, action: "create" | "revoke"): string {
  if (error instanceof SyncApiError) {
    if (error.status === 401) return "这台设备在同步服务器上的登录已失效，请到「设置 · 同步」重新登录后再试。";
    // 创建时 404 = 服务器上根本没有这个接口（旧版本）；撤销时 404 = 这个分享已经不在了。
    if (error.status === 404 && action === "create") return "同步服务器还不支持公开分享，请先升级服务器。";
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

/**
 * 确认之后：上传快照、拿链接、自动复制。失败停在对话框里如实说原因（可以重试）。
 * `copy` 由调用方注入（剪贴板实现在 UI 层）。
 */
export async function confirmShare(request: ShareRequest, copy: (text: string) => Promise<boolean>): Promise<void> {
  setPhase(request.id, { kind: "working" });
  try {
    // 点「生成」这一刻的内容（菜单是早一步构建的，那时拿到的 note 对象可能已经旧了）。
    const bytes = await snapshotBytes(getLibrary().notes[request.note.id] ?? request.note);
    const share = await createPublicShare({ name: shareFileName(request.note), bytes });
    const copied = await copy(shareLink(share, request.mode)).catch(() => false);
    setPhase(request.id, { kind: "done", share, copied, revoked: false, revokeError: null });
  } catch (error) {
    setPhase(request.id, { kind: "error", message: describeError(error, "create") });
  }
}

/** 撤销刚生成的链接（对话框里的「撤销链接」）。 */
export async function revokeShare(request: ShareRequest): Promise<void> {
  if (request.phase.kind !== "done") return;
  const { share, copied } = request.phase;
  try {
    await revokePublicShare(share.id);
    setPhase(request.id, { kind: "done", share, copied, revoked: true, revokeError: null });
  } catch (error) {
    // 留在「已生成」这一页：链接还在、还能复制，只是多一句没撤掉的原因。
    setPhase(request.id, { kind: "done", share, copied, revoked: false, revokeError: `没能撤销：${describeError(error, "revoke")}` });
  }
}
