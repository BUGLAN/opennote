/**
 * 配对与加密口令接口（阶段 ④）。密码学在 `src/sync/vault.test.ts`；这里只钉协议：
 * 谁能看到什么、每一步只能走一次、6 位码猜不动。
 */

import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createApp } from "../app";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { seedAccount } from "../auth/testAccounts.test-helper";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};
const key = (): string => randomBytes(32).toString("base64url");
const NEW_DEVICE = { deviceId: "e".repeat(32), name: "Pixel 8", platform: "android", os: "android", clientVersion: "0.17.0" } as const;

function makeWorld() {
  const fake = new FakeCouch();
  const { app, accounts } = createApp({ config: loadConfig(ENV), db: openDatabase({ path: ":memory:" }), couch: couchClient(fake), couchAdmin: couchClient(fake) });
  const call = async (path: string, init: { method?: string; body?: unknown; token?: string; ip?: string } = {}) => {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (init.token) headers.authorization = `Bearer ${init.token}`;
    const response = await app.request(`http://localhost${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers,
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    const text = await response.text();
    return { status: response.status, body: text ? (JSON.parse(text) as Record<string, any>) : null };
  };
  return { accounts, call };
}

describe("配对", () => {
  it("完整走一遍：A 发码 → B 认领 → A 看到 B 的设备与公钥 → 确认 → B 拿到自己的会话与密文（只一次）", async () => {
    const world = makeWorld();
    const lan = seedAccount(world.accounts, { email: "lan@example.com" });
    const aKey = key();
    const bKey = key();

    const created = await world.call("/v1/pairing", { token: lan.token, body: { publicKey: aKey } });
    expect(created.status).toBe(201);
    expect(created.body!.code).toMatch(/^\d{6}$/);

    const claimed = await world.call("/v1/pairing/claim", { body: { code: created.body!.code, publicKey: bKey, device: NEW_DEVICE } });
    expect(claimed.status).toBe(200);
    expect(claimed.body).toMatchObject({ id: created.body!.id, publicKey: aKey, email: "lan@example.com" });
    // 码只能被认领一次。
    expect((await world.call("/v1/pairing/claim", { body: { code: created.body!.code, publicKey: key(), device: NEW_DEVICE } })).status).toBe(404);

    const id = created.body!.id as string;
    const claimToken = claimed.body!.claimToken as string;
    expect((await world.call(`/v1/pairing/${id}/result`, { body: { claimToken } })).body).toEqual({ status: "waiting" });

    const seen = await world.call(`/v1/pairing/${id}`, { token: lan.token });
    expect(seen.body).toMatchObject({ status: "claimed", device: { name: "Pixel 8", os: "android" }, publicKey: bKey });

    expect((await world.call(`/v1/pairing/${id}/approve`, { token: lan.token, body: { sealed: "s".repeat(40) } })).status).toBe(204);
    const result = await world.call(`/v1/pairing/${id}/result`, { body: { claimToken } });
    expect(result.body).toMatchObject({ status: "done", sealed: "s".repeat(40), me: { email: "lan@example.com", deviceId: NEW_DEVICE.deviceId } });
    const bToken = result.body!.token as string;
    expect(bToken).not.toBe(lan.token);
    expect((await world.call("/v1/me", { token: bToken })).status).toBe(200);
    // 结果只交一次。
    expect((await world.call(`/v1/pairing/${id}/result`, { body: { claimToken } })).status).toBe(409);
  });

  it("别的账号看不到、确认不了；认领票不对拿不到结果；拒绝之后 B 得到 rejected", async () => {
    const world = makeWorld();
    const lan = seedAccount(world.accounts);
    const eve = seedAccount(world.accounts);
    const created = (await world.call("/v1/pairing", { token: lan.token, body: { publicKey: key() } })).body!;
    const claimed = (await world.call("/v1/pairing/claim", { body: { code: created.code, publicKey: key(), device: NEW_DEVICE } })).body!;
    expect((await world.call(`/v1/pairing/${created.id}`, { token: eve.token })).status).toBe(404);
    expect((await world.call(`/v1/pairing/${created.id}/approve`, { token: eve.token, body: { sealed: null } })).status).toBe(404);
    expect((await world.call(`/v1/pairing/${created.id}/result`, { body: { claimToken: "x".repeat(32) } })).status).toBe(404);
    expect((await world.call(`/v1/pairing/${created.id}/reject`, { token: lan.token, body: {} })).status).toBe(204);
    expect((await world.call(`/v1/pairing/${created.id}/result`, { body: { claimToken: claimed.claimToken } })).body).toEqual({ status: "rejected" });
  });

  it("还没人认领时不能确认；一个账号同时最多 3 个；输错 10 次之后暂停", async () => {
    const world = makeWorld();
    const lan = seedAccount(world.accounts);
    const first = (await world.call("/v1/pairing", { token: lan.token, body: { publicKey: key() } })).body!;
    expect((await world.call(`/v1/pairing/${first.id}/approve`, { token: lan.token, body: { sealed: null } })).status).toBe(409);
    await world.call("/v1/pairing", { token: lan.token, body: { publicKey: key() } });
    await world.call("/v1/pairing", { token: lan.token, body: { publicKey: key() } });
    expect((await world.call("/v1/pairing", { token: lan.token, body: { publicKey: key() } })).status).toBe(429);

    const wrong = first.code === "000000" ? "000001" : "000000";
    for (let i = 0; i < 10; i += 1) {
      expect((await world.call("/v1/pairing/claim", { body: { code: wrong, publicKey: key(), device: NEW_DEVICE } })).status).toBe(404);
    }
    // 第 11 次连对的码也不收了。
    const throttled = await world.call("/v1/pairing/claim", { body: { code: first.code, publicKey: key(), device: NEW_DEVICE } });
    expect(throttled.status).toBe(429);
  });
});

describe("加密口令", () => {
  it("没设过 → configured:false；第一次 expected=null；之后要带上当前那一份（比较并交换）", async () => {
    const world = makeWorld();
    const lan = seedAccount(world.accounts);
    const kdf = { alg: "scrypt", N: 32768, r: 8, p: 1, salt: key() };
    expect((await world.call("/v1/me/encryption", { token: lan.token })).body).toEqual({ configured: false });

    const first = await world.call("/v1/me/encryption", { method: "PUT", token: lan.token, body: { wrappedEncRoot: "w1".repeat(20), kdf, expected: null } });
    expect(first.status).toBe(200);
    // 另一台设备也以为没设过：409，而不是覆盖。
    const race = await world.call("/v1/me/encryption", { method: "PUT", token: lan.token, body: { wrappedEncRoot: "w2".repeat(20), kdf, expected: null } });
    expect(race.status).toBe(409);
    const change = await world.call("/v1/me/encryption", { method: "PUT", token: lan.token, body: { wrappedEncRoot: "w3".repeat(20), kdf, expected: "w1".repeat(20) } });
    expect(change.status).toBe(200);
    expect((await world.call("/v1/me/encryption", { token: lan.token })).body).toEqual({ configured: true, wrappedEncRoot: "w3".repeat(20), kdf });
  });
});
