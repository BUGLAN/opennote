/**
 * 公开分享的客户端一侧（`src/lib/share.ts`、`SyncApi.createShare`）。钉住：
 * - 上传的是原始字节（不是 JSON 包 base64），文件名走查询参数；
 * - 什么类型的笔记都能分享（不按类型拦），文件名就是磁盘上的文件名；
 * - 「分享此链接」交出网页地址，「分享此文件」交出原文件地址；
 * - 生成后自动复制；失败如实停在对话框里；撤销失败不丢掉已生成的链接。
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ShareCreated } from "../../shared/contract";
import type { Note } from "../data/types";
import { openSyncApi, SyncApiError } from "../sync/syncApi";
import type { HttpRequest } from "../sync/http";

const created: ShareCreated = {
  id: "AbCdEfGhIjKlMnOpQrStUv",
  url: "https://notes.example.com/s/AbCdEfGhIjKlMnOpQrStUv",
  rawUrl: "https://notes.example.com/s/AbCdEfGhIjKlMnOpQrStUv/raw",
  name: "读书笔记.md",
  size: 6,
  createdAt: 1_760_000_000_000,
};

const account = vi.hoisted(() => ({
  createPublicShare: vi.fn(),
  revokePublicShare: vi.fn(),
}));
vi.mock("../sync/account", () => account);

const { closeShareDialog, confirmShare, openShareDialog, revokeShare, shareDialogStore, shareFileName, shareLink, snapshotBytes } = await import("./share");

function note(partial: Partial<Note> = {}): Note {
  return {
    id: "书/读书笔记.md",
    folderId: null,
    title: "读书笔记",
    content: "# 你好",
    createdAt: 0,
    updatedAt: 0,
    openedAt: 0,
    starred: false,
    tags: [],
    chars: 0,
    words: 0,
    trashed: false,
    trashedAt: null,
    ...partial,
  };
}

beforeEach(() => {
  account.createPublicShare.mockReset();
  account.revokePublicShare.mockReset();
  closeShareDialog();
});

describe("SyncApi.createShare", () => {
  it("POST /v1/shares?name=<文件名>，请求体是原始字节；响应按契约解析", async () => {
    const seen: HttpRequest[] = [];
    const api = await openSyncApi({
      server: "https://notes.example.com/",
      token: "tok",
      send: async (request) => {
        seen.push(request);
        return { status: 201, headers: {}, bytes: new TextEncoder().encode(JSON.stringify(created)) };
      },
    });
    const bytes = new Uint8Array([1, 2, 3]);
    expect(await api.createShare({ name: "读书笔记.md", bytes })).toEqual(created);
    expect(seen[0]).toMatchObject({
      method: "POST",
      url: `https://notes.example.com/v1/shares?name=${encodeURIComponent("读书笔记.md")}`,
      headers: { authorization: "Bearer tok", "content-type": "application/octet-stream" },
    });
    expect(seen[0]!.body).toBe(bytes);
  });

  it("旧服务器没有这个接口：404 原样抛出（由对话框翻成人话）", async () => {
    const api = await openSyncApi({
      server: "https://notes.example.com",
      token: "tok",
      send: async () => ({ status: 404, headers: {}, bytes: new TextEncoder().encode(JSON.stringify({ error: "没有这个接口", code: "not-found" })) }),
    });
    await expect(api.createShare({ name: "a.md", bytes: new Uint8Array() })).rejects.toBeInstanceOf(SyncApiError);
  });
});

describe("快照与链接", () => {
  it("文件名是路径最后一段；画布 / HTML 原样上传，不按类型拦", async () => {
    expect(shareFileName(note())).toBe("读书笔记.md");
    const canvas = note({ id: "白板.canvas", kind: "canvas", content: '{"nodes":[]}' });
    expect(new TextDecoder().decode(await snapshotBytes(canvas))).toBe('{"nodes":[]}');
    const page = note({ id: "p.html", kind: "html", content: "<p>x</p>" });
    expect(new TextDecoder().decode(await snapshotBytes(page))).toBe("<p>x</p>");
  });

  it("「分享此链接」给网页地址，「分享此文件」给原文件地址", () => {
    expect(shareLink(created, "page")).toBe(created.url);
    expect(shareLink(created, "file")).toBe(created.rawUrl);
  });
});

describe("对话框流程", () => {
  it("确认 → 上传 → 自动复制对应的地址", async () => {
    account.createPublicShare.mockResolvedValue(created);
    const copy = vi.fn(async () => true);
    openShareDialog({ mode: "file", note: note({ id: "白板.canvas", kind: "canvas", content: "{}" }), server: "https://notes.example.com", encrypted: false });
    await confirmShare(shareDialogStore.get()!, copy);
    expect(account.createPublicShare).toHaveBeenCalledWith({ name: "白板.canvas", bytes: new TextEncoder().encode("{}") });
    expect(copy).toHaveBeenCalledWith(created.rawUrl);
    expect(shareDialogStore.get()!.phase).toEqual({ kind: "done", share: created, copied: true, revoked: false, revokeError: null });
  });

  it("上传失败停在对话框里；旧服务器的 404 说成「请先升级服务器」", async () => {
    account.createPublicShare.mockRejectedValue(new SyncApiError(404, "没有这个接口", "not-found"));
    openShareDialog({ mode: "page", note: note(), server: "https://notes.example.com", encrypted: true });
    await confirmShare(shareDialogStore.get()!, async () => true);
    expect(shareDialogStore.get()!.phase).toEqual({ kind: "error", message: "同步服务器还不支持公开分享，请先升级服务器。" });
  });

  it("撤销成功标成已撤销；失败保留链接并说明原因", async () => {
    account.createPublicShare.mockResolvedValue(created);
    openShareDialog({ mode: "page", note: note(), server: "https://notes.example.com", encrypted: false });
    await confirmShare(shareDialogStore.get()!, async () => false);

    account.revokePublicShare.mockRejectedValueOnce(new SyncApiError(0, "连不上", "network"));
    await revokeShare(shareDialogStore.get()!);
    expect(shareDialogStore.get()!.phase).toMatchObject({ kind: "done", revoked: false, revokeError: "没能撤销：连不上" });

    account.revokePublicShare.mockResolvedValueOnce(undefined);
    await revokeShare(shareDialogStore.get()!);
    expect(account.revokePublicShare).toHaveBeenLastCalledWith(created.id);
    expect(shareDialogStore.get()!.phase).toMatchObject({ kind: "done", revoked: true, revokeError: null });
  });
});
