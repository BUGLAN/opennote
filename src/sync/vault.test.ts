/**
 * 加密口令与配对的密码学（`vault.ts`）。
 */

import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createPairingKeys, createPkce, createVault, openFromPeer, openVault, pairingSecrets, rewrapVault, sealForPeer } from "./vault";

const ACCOUNT = "0123456789abcdef0123456789abcdef";

describe("加密口令", () => {
  it("包好的 encRoot 只有正确口令解得开；改口令后 encRoot 不变", async () => {
    const vault = await createVault("correct horse", ACCOUNT);
    const opened = await openVault("correct horse", vault.wrappedEncRoot, vault.kdf, ACCOUNT);
    expect(opened).toEqual(vault.encRoot);
    await expect(openVault("wrong horse", vault.wrappedEncRoot, vault.kdf, ACCOUNT)).rejects.toThrow("加密口令不对");
    // 绑了账号：换个账号 id 解不开。
    await expect(openVault("correct horse", vault.wrappedEncRoot, vault.kdf, "f".repeat(32))).rejects.toThrow("加密口令不对");
    const rewrapped = await rewrapVault("new passphrase!", vault.encRoot, ACCOUNT);
    expect(rewrapped.kdf.salt).not.toBe(vault.kdf.salt);
    expect(await openVault("new passphrase!", rewrapped.wrappedEncRoot, rewrapped.kdf, ACCOUNT)).toEqual(vault.encRoot);
  });
});

describe("配对", () => {
  it("两边算出同一把钥匙和同一个校验码；B 拆得开 A 封的 encRoot", async () => {
    const a = await createPairingKeys();
    const b = await createPairingKeys();
    const fromA = await pairingSecrets({ own: a, peerPublicKey: b.publicKey, initiatorPublicKey: a.publicKey, claimantPublicKey: b.publicKey });
    const fromB = await pairingSecrets({ own: b, peerPublicKey: a.publicKey, initiatorPublicKey: a.publicKey, claimantPublicKey: b.publicKey });
    expect(fromA.key).toEqual(fromB.key);
    expect(fromA.check).toMatch(/^\d{6}$/);
    expect(fromA.check).toBe(fromB.check);

    const encRoot = new Uint8Array(32).fill(7);
    expect(openFromPeer(fromB.key, sealForPeer(fromA.key, encRoot, ACCOUNT), ACCOUNT)).toEqual(encRoot);
  });

  it("中间人换掉公钥：校验码对不上，密文也拆不开", async () => {
    const a = await createPairingKeys();
    const b = await createPairingKeys();
    const m = await createPairingKeys();
    // 服务器把 B 的公钥换成 M 的给 A，把 A 的换成 M 的给 B。
    const seenByA = await pairingSecrets({ own: a, peerPublicKey: m.publicKey, initiatorPublicKey: a.publicKey, claimantPublicKey: m.publicKey });
    const seenByB = await pairingSecrets({ own: b, peerPublicKey: m.publicKey, initiatorPublicKey: m.publicKey, claimantPublicKey: b.publicKey });
    expect(seenByA.check).not.toBe(seenByB.check);
    expect(() => openFromPeer(seenByB.key, sealForPeer(seenByA.key, new Uint8Array(32), ACCOUNT), ACCOUNT)).toThrow("没能解开");
  });
});

describe("PKCE", () => {
  it("challenge = base64url(sha256(verifier))，与服务端同一算法", () => {
    const { verifier, challenge } = createPkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });
});
