/**
 * 测试夹具：直接在库里种一个账号 + 一条设备会话，同步返回 `{ id, token }`。
 *
 * 正式建号要跑 scrypt（异步、几十毫秒），而大部分用例只关心「有个已登录的账号」，
 * 所以这里绕过密码直接写行 —— 与 `AccountStore.create` 写的是同样的列。
 * 要测登录本身的用例请走 `AccountStore.login` / `POST /v1/auth/login`。
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AccountStore, newAccountId } from "./accounts";
import { FAST_PARAMS_FOR_TESTS } from "./passwords";

let counter = 0;

/** 测试用的 AccountStore：scrypt 用低成本参数。 */
export function testAccountStore(db: DatabaseSync): AccountStore {
  return new AccountStore(db, { passwordParams: FAST_PARAMS_FOR_TESTS });
}

export function seedAccount(
  accounts: AccountStore,
  options: { isAdmin?: boolean; email?: string; displayName?: string | null; now?: number } = {},
): { id: string; token: string; email: string; deviceId: string } {
  const db = accounts.db;
  counter += 1;
  const id = newAccountId();
  const email = options.email ?? `user${counter}-${id.slice(0, 6)}@example.test`;
  const now = options.now ?? Date.now();
  db.prepare(
    `INSERT INTO accounts (id, email, display_name, password_hash, is_admin, status, quota_bytes, created_at, last_seen_at)
     VALUES (?, ?, ?, NULL, ?, 'active', NULL, ?, NULL)`,
  ).run(id, email, options.displayName ?? null, options.isAdmin ? 1 : 0, now);
  db.prepare("INSERT INTO quota_usage (account_id, bytes_used, notebooks, updated_at) VALUES (?, 0, 0, ?)").run(id, now);
  const deviceId = randomBytes(16).toString("hex");
  const { token } = accounts.createSession({ accountId: id, kind: "device", deviceId, now });
  return { id, token, email, deviceId };
}
