/**
 * 「attach 真的把 `deviceId` 交给了 provider」的用例（M9）。
 *
 * 为什么单独一个文件：这里要用 `vi.mock` 把 `createOpenNoteProvider` 换掉，
 * 才能**看见** attach 传了什么参数。放进 `attach.test.ts` 会把这个 mock 泄漏给
 * 其它用例（它们注入的是自己的 provider）。
 */
import { describe, expect, it, vi } from "vitest";
import { attachWorkspaceSync } from "./attach";
import { createSyncLedger } from "./state";
import { createRegistrationMaterial, encodeAccountKey } from "./accountKey";
import type { FileSystemBackend } from "../fs/types";
import type { WorkspaceRecord } from "../data/workspaces";

const { created } = vi.hoisted(() => ({ created: [] as Record<string, unknown>[] }));

vi.mock("./providers/opennote", () => ({
  createOpenNoteProvider: (options: Record<string, unknown>) => {
    created.push(options);
    return {
      name: "stub",
      cryptoMode: "none",
      tree: async () => ({ entries: [], truncated: false, cursor: null }),
      changes: async () => ({ changes: [], cursor: null, resync: false }),
      read: async () => null,
      put: async () => ({ conflict: null }),
      delete: async () => ({ gone: true }),
      checkpoint: async () => undefined,
    };
  },
}));

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";

function backend(): FileSystemBackend {
  return {
    kind: "node",
    label: "假",
    canWrite: true,
    list: async () => [],
    readText: async () => "",
    readBytes: async () => new Uint8Array(),
    writeText: async () => undefined,
    writeBytes: async () => undefined,
    mkdir: async () => undefined,
    remove: async () => undefined,
    move: async () => undefined,
    exists: async () => true,
    stat: async () => null,
  } as unknown as FileSystemBackend;
}

function record(): WorkspaceRecord {
  return {
    id: "w1",
    name: "笔记",
    kind: "node",
    location: "/tmp/x",
    addedAt: 0,
    lastOpenedAt: 0,
    sync: { enabled: true, baseUrl: "https://notes.example.com", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
  };
}

function keyText(): string {
  const material = createRegistrationMaterial();
  return encodeAccountKey({ accountId: material.accountId, accountKey: material.accountKey });
}

describe("★ M9 · attach 必须把 deviceId 交给 provider", () => {
  it("传了 deviceId ⇒ 原样交给 createOpenNoteProvider", async () => {
    created.length = 0;
    const result = await attachWorkspaceSync({
      record: record(),
      backend: backend(),
      ledger: createSyncLedger({ baseUrl: "https://notes.example.com", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 }),
      accountKeyText: keyText(),
      deviceId: "a".repeat(32),
      realtime: false,
    });

    expect(result.ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]!.deviceId).toBe("a".repeat(32));
  });

  it("没传 deviceId ⇒ 退回 getDeviceId()（形状必须是 32 位十六进制）", async () => {
    created.length = 0;
    const result = await attachWorkspaceSync({
      record: record(),
      backend: backend(),
      ledger: createSyncLedger({ baseUrl: "https://notes.example.com", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 }),
      accountKeyText: keyText(),
      realtime: false,
    });

    expect(result.ok).toBe(true);
    expect(created[0]!.deviceId).toMatch(/^[0-9a-f]{32}$/);
  });
});
