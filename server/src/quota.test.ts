/**
 * 账号级空间配额账本（`quota.ts`）。
 *
 * 这里钉的是这次修复的核心承诺：笔记本写入与公开分享**共用**一份用量与预占，
 * 两边都能看见对方在途的写入；结算后预占变成真实资源，不会凭空多算或少算。
 */

import { describe, expect, it } from "vitest";
import { openDatabase } from "./db";
import { NotebookStore } from "./notebooks";
import { QuotaLedger } from "./quota";
import { ShareStore } from "./shares";
import { seedAccount, testAccountStore } from "./auth/testAccounts.test-helper";

const SHARE = { name: "a.txt", contentType: "text/plain", sha256: "x" };

function makeWorld() {
  const db = openDatabase({ path: ":memory:" });
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const shares = new ShareStore(db);
  const ledger = new QuotaLedger(db);
  return { db, accounts, notebooks, shares, ledger };
}

describe("账号级空间配额账本", () => {
  it("用量 = 笔记本 + 活跃分享 + 未结算预占；撤销与释放后各自减掉", () => {
    const world = makeWorld();
    const alice = seedAccount(world.accounts);
    const notebook = world.notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });
    world.notebooks.addNotebookBytes(notebook.id, 8);
    const share = world.shares.create({ accountId: alice.id, ...SHARE, size: 5, now: 1_000 });
    const reserved = world.ledger.reserve({ accountId: alice.id, bytes: 3, limit: 100, now: 1_001 });
    expect("reservation" in reserved).toBe(true);

    expect(world.ledger.usageOf(alice.id, 1_001)).toEqual({
      bytesUsed: 16,
      notebookBytes: 8,
      shareBytes: 5,
      reservedBytes: 3,
    });

    world.shares.revoke(share.id, 1_100);
    expect(world.ledger.usageOf(alice.id, 1_100)).toMatchObject({ bytesUsed: 11, shareBytes: 0, reservedBytes: 3 });

    if (!("reservation" in reserved)) throw new Error("unreachable");
    world.ledger.release(reserved.reservation.id);
    expect(world.ledger.usageOf(alice.id, 1_100)).toMatchObject({ bytesUsed: 8, reservedBytes: 0 });

    world.notebooks.markDeleted(notebook.id);
    expect(world.ledger.usageOf(alice.id, 1_100).bytesUsed).toBe(0);
  });

  it("分享预占对笔记本写可见；笔记本预占对分享创建可见", () => {
    const world = makeWorld();
    const alice = seedAccount(world.accounts);

    const share = world.shares.createWithinQuota({ accountId: alice.id, ...SHARE, size: 8, now: 1_000 }, { limit: 10 });
    expect("reservationId" in share).toBe(true);
    // 分享还在写 CouchDB：行没落库，但预占已经让笔记本写看见这 8 字节。
    expect(world.notebooks.reserveQuota({ accountId: alice.id, bytes: 3, limit: 10, now: 1_001 })).toEqual({
      quotaExceeded: true,
      bytesUsed: 8,
    });
    if (!("reservationId" in share)) throw new Error("unreachable");
    world.shares.releaseQuotaReservation(share.reservationId);
    expect(world.notebooks.reservedBytesOf(alice.id, 1_002)).toBe(0);

    const notebook = world.notebooks.reserveQuota({ accountId: alice.id, bytes: 8, limit: 10, now: 2_000 });
    expect("reservation" in notebook).toBe(true);
    expect(world.shares.createWithinQuota({ accountId: alice.id, ...SHARE, size: 3, now: 2_001 }, { limit: 10 })).toEqual({
      quotaExceeded: true,
      bytesUsed: 8,
    });
    if (!("reservation" in notebook)) throw new Error("unreachable");
    world.notebooks.releaseQuotaReservation(notebook.reservation.id);
    expect(world.notebooks.reservedBytesOf(alice.id, 2_002)).toBe(0);
  });

  it("结算把预占换成真实资源：用量不变、预占归零，下一笔按剩余额度判定", () => {
    const world = makeWorld();
    const alice = seedAccount(world.accounts);
    const notebook = world.notebooks.create({ ownerId: alice.id, name: "a", cryptoMode: "none" });

    const share = world.shares.createWithinQuota({ accountId: alice.id, ...SHARE, size: 5, now: 1_000 }, { limit: 100 });
    if (!("reservationId" in share)) throw new Error("unreachable");
    world.shares.settleCreation(share);
    expect(world.shares.findActive(share.share.id)).not.toBeNull();
    expect(world.ledger.usageOf(alice.id, 1_000)).toMatchObject({ bytesUsed: 5, shareBytes: 5, reservedBytes: 0 });

    const write = world.notebooks.reserveQuota({ accountId: alice.id, bytes: 4, limit: 10, now: 2_000 });
    if (!("reservation" in write)) throw new Error("unreachable");
    world.notebooks.settleQuotaReservation(write.reservation.id, notebook.id, 4, 2_001);
    expect(world.ledger.usageOf(alice.id, 2_001)).toEqual({
      bytesUsed: 9,
      notebookBytes: 4,
      shareBytes: 5,
      reservedBytes: 0,
    });

    // 剩余 1 字节：再预占 2 字节被拒，报告的是同一份合并用量。
    expect(world.notebooks.reserveQuota({ accountId: alice.id, bytes: 2, limit: 10, now: 2_002 })).toEqual({
      quotaExceeded: true,
      bytesUsed: 9,
    });
  });

  it("0 字节分享不需要预占，结算后仍能落行", () => {
    const world = makeWorld();
    const alice = seedAccount(world.accounts);
    const share = world.shares.createWithinQuota({ accountId: alice.id, ...SHARE, size: 0, now: 1_000 }, { limit: 10 });
    if (!("reservationId" in share)) throw new Error("unreachable");
    expect(share.reservationId).toBeNull();
    world.shares.settleCreation(share);
    expect(world.shares.findActive(share.share.id)).not.toBeNull();
    expect(world.ledger.usageOf(alice.id, 1_000).bytesUsed).toBe(0);
  });
});
