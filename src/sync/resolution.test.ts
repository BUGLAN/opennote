/**
 * 冲突裁决（L3 收尾）的用例。
 *
 * 引擎（L2）只报不猜；这里的两个动作是用户**点过头**的覆盖/让步。
 * 钉住四件事：
 * 1. 「采用远端」后账本基线与磁盘一致，下一轮同步是**空转**；
 * 2. 「保留本地」用 CAS 覆盖远端 —— 即使账本里的基准已过期（以服务端返回的
 *    当前值重试一次，因为用户的意图就是覆盖）；
 * 3. 裁决只改**这一端**的事实：另一端仍处于冲突，要它自己裁决后才收敛；
 * 4. 远端已经没有那一条 ⇒ 如实失败，不猜。
 */
import { describe, expect, it } from "vitest";
import { createSyncLedger } from "./state";
import { createMemoryProvider } from "./providers/memory";
import { createSyncSession } from "./session";
import { resolveConflictWithLocal, resolveConflictWithRemote } from "./resolution";
import type { SyncSession } from "./session";
import type { LocalEntry, SyncFileBackend } from "./workspaceFiles";

const NOTEBOOK = "11111111-2222-4333-8444-555555555555";

function memoryBackend(files: Record<string, string> = {}): SyncFileBackend & { snapshot(): Record<string, string> } {
  const store = new Map(Object.entries(files));
  const encoder = new TextEncoder();
  return {
    snapshot: () => Object.fromEntries(store),
    async list(): Promise<LocalEntry[]> {
      const out: LocalEntry[] = [];
      for (const path of store.keys()) {
        const parts = path.split("/");
        for (let index = 1; index < parts.length; index += 1) out.push({ path: parts.slice(0, index).join("/"), isDir: true });
        out.push({ path, isDir: false });
      }
      return out;
    },
    async read(path) {
      const value = store.get(path);
      if (value === undefined) throw new Error(`没有这个文件：${path}`);
      return encoder.encode(value);
    },
    async write(path, bytes) {
      store.set(path, new TextDecoder().decode(bytes));
    },
    async remove(path) {
      store.delete(path);
    },
  };
}

function sessionFor(backend: SyncFileBackend, provider: ReturnType<typeof createMemoryProvider>): SyncSession {
  return createSyncSession({
    config: { enabled: true, baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", accountRef: "a" },
    ledger: createSyncLedger({ baseUrl: "memory://", notebookId: NOTEBOOK, cryptoMode: "none", protocolVersion: 1 }),
    provider,
    backend,
    notebookId: NOTEBOOK,
  });
}

/**
 * 造一个**真实的**两端冲突：base → 两边各改 → A 推成功、B 撞 409/三方冲突。
 * 返回 B（冲突方）与 A（对侧）。
 */
async function conflictedPair(): Promise<{ a: SyncSession; b: SyncSession; backendA: SyncFileBackend }> {
  const provider = createMemoryProvider();
  const backendA = memoryBackend({ "notes/x.md": "base" });
  const a = sessionFor(backendA, provider);
  await a.syncNow();

  const b = sessionFor(memoryBackend({}), provider);
  await b.syncNow();

  await backendA.write("notes/x.md", new TextEncoder().encode("A 的版本"));
  await b.deps.writeLocal("notes/x.md", new TextEncoder().encode("B 的最终版"));
  await a.syncNow();
  const conflicted = await b.syncNow();
  expect(conflicted!.conflicts.length + conflicted!.pushConflicts.length).toBeGreaterThan(0);
  return { a, b, backendA };
}

describe("采用远端", () => {
  it("把远端那份写回本地，基线对齐，下一轮同步空转", async () => {
    const { b } = await conflictedPair();

    const outcome = await resolveConflictWithRemote(b, "notes/x.md");
    expect(outcome.ok).toBe(true);
    expect(new TextDecoder().decode(await b.deps.readLocal("notes/x.md"))).toBe("A 的版本");

    // ★ 关键：裁决之后下一轮是**空转**（基线对了，不再来回震荡）。
    const again = await b.syncNow();
    expect(again!.pushed).toBe(0);
    expect(again!.pulled).toBe(0);
    expect(again!.conflicts).toHaveLength(0);
  });

  it("远端已经没有那一条 ⇒ 如实失败", async () => {
    const provider = createMemoryProvider();
    const a = sessionFor(memoryBackend({ "notes/x.md": "A" }), provider);
    await a.syncNow();
    await provider.delete({ did: a.deps.didOf("notes/x.md"), baseHash: null });
    const outcome = await resolveConflictWithRemote(a, "notes/x.md");
    expect(outcome.ok).toBe(false);
    expect(outcome.error).toContain("远端");
  });
});

describe("保留本地（显式覆盖远端）", () => {
  it("覆盖时账本基准过期 ⇒ 以服务端当前值重试；另一台设备裁决「采用远端」后两端收敛", async () => {
    const { a, b } = await conflictedPair();

    // B 裁决「保留我的版本」。账本里的 CAS 基准是 base（旧了），
    // 实现要以服务端返回的当前值（A 的版本）重试一次 —— 用户的意图就是覆盖。
    const outcomeB = await resolveConflictWithLocal(b, "notes/x.md");
    expect(outcomeB.ok).toBe(true);
    expect(await providerReadText(b, "notes/x.md")).toBe("B 的最终版");

    // A 那边自己没再改过 ⇒ 这不是冲突，就是一次普通拉取（拉到 B 的版本）。
    const roundTrip = await a.syncNow();
    expect(roundTrip!.pulled).toBe(1);
    expect(new TextDecoder().decode(await a.deps.readLocal("notes/x.md"))).toBe("B 的最终版");
    expect(new TextDecoder().decode(await a.deps.readLocal("notes/x.md"))).toBe("B 的最终版");

    // 两端收敛：下一轮各自空转。
    const settledA = await a.syncNow();
    const settledB = await b.syncNow();
    expect(settledA!.conflicts).toHaveLength(0);
    expect(settledB!.conflicts).toHaveLength(0);
    expect(settledA!.pushed).toBe(0);
    expect(settledB!.pushed).toBe(0);
  });
});

async function providerReadText(session: SyncSession, path: string): Promise<string> {
  const remote = await session.provider.read(session.deps.didOf(path));
  expect(remote).not.toBeNull();
  return new TextDecoder().decode(remote!.bytes);
}
