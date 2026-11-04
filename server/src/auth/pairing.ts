/**
 * 设备配对（「添加设备」→ 6 位码）的服务端状态（`docs/执行-同步重写-2026-11-02.md` 阶段 ④）。
 *
 * ```
 * A（已登录）  POST /v1/pairing { publicKey: A公钥 }            → { id, code: "472915" }
 * B（新设备）  POST /v1/pairing/claim { code, publicKey: B公钥, device } → { id, claimToken, publicKey: A公钥 }
 * A           GET  /v1/pairing/:id                               → { status: "claimed", device, publicKey: B公钥 }
 * A（用户确认）POST /v1/pairing/:id/approve { sealed }             → sealed = 用 X25519(A, B) 派生的钥匙封好的 encRoot
 * B           POST /v1/pairing/:id/result { claimToken }         → { status: "done", token, me, sealed }（只给一次）
 * ```
 *
 * ## 服务器看不到什么
 *
 * `sealed` 是两台设备用 X25519 协商出的钥匙加密的，服务器只转交密文。两边界面都显示一个由
 * 双方公钥算出的校验码，用户核对一致再点确认 —— 服务器要冒充中间人就得让两边的校验码碰巧相同。
 *
 * ## 6 位码怎么防猜
 *
 * 码 10 分钟过期、只能被认领一次；认领失败按来源计数（每个来源 10 分钟 10 次，全站 10 分钟 200 次），
 * 一百万种组合在有效期里猜中的概率可以忽略。
 *
 * 状态只在**内存**：配对是一两分钟内完成的事，服务重启让人重新点一次「添加设备」即可。
 */

import { randomBytes, randomInt } from "node:crypto";
import { hashCode } from "./accounts";

export const PAIRING_TTL_MS = 10 * 60_000;
const CLAIM_FAILURE_WINDOW_MS = 10 * 60_000;
const CLAIM_FAILURES_PER_SOURCE = 10;
const CLAIM_FAILURES_GLOBAL = 200;
/** 一个账号同时进行中的配对上限（防止有人用一个账号把码空间占满）。 */
export const PAIRINGS_PER_ACCOUNT = 3;

export type PairingStatus = "waiting" | "claimed" | "approved" | "done" | "rejected";

export interface PairingDevice {
  deviceId: string;
  name: string;
  platform: string;
  os?: string | null | undefined;
  clientVersion?: string | null | undefined;
}

export interface Pairing {
  id: string;
  accountId: string;
  /** 发起这次配对的设备（展示「由 xx 确认」用）。 */
  initiatorDeviceId: string | null;
  codeHash: string;
  initiatorKey: string;
  status: PairingStatus;
  createdAt: number;
  expiresAt: number;
  claimHash: string | null;
  device: PairingDevice | null;
  claimantKey: string | null;
  sealed: string | null;
}

export class PairingError extends Error {
  constructor(
    readonly reason: "not-found" | "too-many" | "state" | "throttled",
    message: string,
  ) {
    super(message);
    this.name = "PairingError";
  }
}

export class PairingStore {
  private readonly byId = new Map<string, Pairing>();
  private readonly failures = new Map<string, number[]>();

  private sweep(now: number): void {
    for (const [id, pairing] of this.byId) {
      // 过期的删掉；已完成 / 已拒绝的也删（结果已经交出去了）。
      if (pairing.expiresAt <= now) this.byId.delete(id);
    }
  }

  private active(accountId: string): Pairing[] {
    return [...this.byId.values()].filter((pairing) => pairing.accountId === accountId && (pairing.status === "waiting" || pairing.status === "claimed" || pairing.status === "approved"));
  }

  create(input: { accountId: string; initiatorDeviceId: string | null; publicKey: string; now?: number }): { id: string; code: string; expiresAt: number } {
    const now = input.now ?? Date.now();
    this.sweep(now);
    if (this.active(input.accountId).length >= PAIRINGS_PER_ACCOUNT) {
      throw new PairingError("too-many", "同时进行中的配对太多了，先关掉其它「添加设备」窗口");
    }
    const taken = new Set([...this.byId.values()].map((pairing) => pairing.codeHash));
    let code = "";
    do code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    while (taken.has(hashCode(code)));
    const id = randomBytes(12).toString("base64url");
    const expiresAt = now + PAIRING_TTL_MS;
    this.byId.set(id, {
      id,
      accountId: input.accountId,
      initiatorDeviceId: input.initiatorDeviceId,
      codeHash: hashCode(code),
      initiatorKey: input.publicKey,
      status: "waiting",
      createdAt: now,
      expiresAt,
      claimHash: null,
      device: null,
      claimantKey: null,
      sealed: null,
    });
    return { id, code, expiresAt };
  }

  /** A 端读自己账号的配对（别的账号的一律当不存在）。 */
  get(id: string, accountId: string, now = Date.now()): Pairing {
    this.sweep(now);
    const pairing = this.byId.get(id);
    if (!pairing || pairing.accountId !== accountId) throw new PairingError("not-found", "这个配对已经过期了，请重新点「添加设备」");
    return pairing;
  }

  private recentFailures(key: string, now: number): number[] {
    const kept = (this.failures.get(key) ?? []).filter((at) => now - at < CLAIM_FAILURE_WINDOW_MS);
    if (kept.length === 0) this.failures.delete(key);
    else this.failures.set(key, kept);
    return kept;
  }

  /** B 端认领：码对上一个「等待中」的配对 → 记下 B 的设备与公钥，返回认领票。 */
  claim(input: { code: string; publicKey: string; device: PairingDevice; source: string; now?: number }): { pairing: Pairing; claimToken: string } {
    const now = input.now ?? Date.now();
    this.sweep(now);
    if (this.recentFailures(`source:${input.source}`, now).length >= CLAIM_FAILURES_PER_SOURCE || this.recentFailures("global", now).length >= CLAIM_FAILURES_GLOBAL) {
      throw new PairingError("throttled", "输错的次数太多了，请过 10 分钟再试");
    }
    const codeHash = hashCode(input.code.trim());
    const pairing = [...this.byId.values()].find((item) => item.codeHash === codeHash && item.status === "waiting");
    if (!pairing) {
      for (const key of [`source:${input.source}`, "global"]) this.failures.set(key, [...this.recentFailures(key, now), now]);
      throw new PairingError("not-found", "配对码不对或已经过期，请看一眼另一台设备上的码");
    }
    const claimToken = randomBytes(24).toString("base64url");
    pairing.status = "claimed";
    pairing.claimHash = hashCode(claimToken);
    pairing.device = input.device;
    pairing.claimantKey = input.publicKey;
    return { pairing, claimToken };
  }

  approve(id: string, accountId: string, sealed: string | null, now = Date.now()): void {
    const pairing = this.get(id, accountId, now);
    if (pairing.status !== "claimed") throw new PairingError("state", "还没有设备输入这个码");
    pairing.status = "approved";
    pairing.sealed = sealed;
  }

  reject(id: string, accountId: string, now = Date.now()): void {
    const pairing = this.get(id, accountId, now);
    if (pairing.status === "done") throw new PairingError("state", "这台设备已经加入了");
    pairing.status = "rejected";
    pairing.sealed = null;
  }

  /** B 端凭认领票查结果。`approved` 只交出一次（之后变成 `done`，封好的密钥随即丢掉）。 */
  result(id: string, claimToken: string, now = Date.now()): Pairing {
    this.sweep(now);
    const pairing = this.byId.get(id);
    if (!pairing || pairing.claimHash === null || pairing.claimHash !== hashCode(claimToken)) {
      throw new PairingError("not-found", "这个配对已经过期了，请重新输入配对码");
    }
    return pairing;
  }

  /** 交付完成：标记 done、丢掉密文（返回交付前的快照）。 */
  deliver(pairing: Pairing): { sealed: string | null } {
    const sealed = pairing.sealed;
    pairing.status = "done";
    pairing.sealed = null;
    return { sealed };
  }
}
