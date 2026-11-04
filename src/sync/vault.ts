/**
 * 加密口令与设备配对的客户端密码学（`docs/执行-同步重写-2026-11-02.md` 阶段 ④）。
 *
 * ## 加密口令
 *
 * ```
 * 口令 ──scrypt(salt, N=2¹⁵, r=8, p=1)──▶ wrapKey ──解开──▶ encRoot ──HKDF(notebookId)──▶ 笔记本密钥
 * ```
 *
 * - encRoot 是账号级的随机 32 字节，所有端到端加密的笔记本都从它派生（`accountKey.deriveNotebookKey`）。
 * - 服务端只存「包好的 encRoot」与 KDF 参数（`GET/PUT /v1/me/encryption`），没有口令就解不开。
 * - 改口令 = 用新口令重新包同一个 encRoot；已加密的笔记本一个字节都不用动。
 * - 加密口令与登录凭据无关：管理员重置登录密码、用 GitHub 登录，都碰不到它。
 *
 * ## 配对（「添加设备」）
 *
 * 两台设备各生成一对 X25519 密钥，经服务器交换公钥（服务器只看到公钥）：
 *
 * ```
 * shared = X25519(自己的私钥, 对方的公钥)
 * key    = HKDF-SHA256(shared, salt = A公钥 ‖ B公钥, info = "opennote/v1/pairing")
 * sealed = nonce ‖ XChaCha20-Poly1305(key, encRoot, aad = accountId)
 * 校验码 = HKDF(shared, 同一个 salt, info = "opennote/v1/pairing-check") 取 6 位数字
 * ```
 *
 * 两边界面显示同一个校验码，用户核对后在 A 上点确认。服务器要当中间人，就得同时冒充两边的公钥，
 * 校验码就对不上了。
 *
 * X25519 用浏览器 / Electron / Node 自带的 WebCrypto（不引新依赖）。
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { scryptAsync } from "@noble/hashes/scrypt.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import type { KdfParams } from "../../shared/contract";
import { ENC_ROOT_BYTES, accountIdBytes, fromBase64Url, toBase64Url, unwrapEncRoot, wrapEncRoot } from "./accountKey";

/** 与 `shared/contract.ts` 的 `kdfParamsSchema` 同形状。默认参数：约 32 MiB、桌面上 0.2–1 秒。 */
export const DEFAULT_KDF = { alg: "scrypt", N: 2 ** 15, r: 8, p: 1 } as const;

/** 口令最短长度。它保护的是服务器上的密文，丢了无法找回 —— 所以宁可长一点。 */
export const PASSPHRASE_MIN_LENGTH = 8;

const encoder = new TextEncoder();

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < PASSPHRASE_MIN_LENGTH) return `加密口令至少 ${PASSPHRASE_MIN_LENGTH} 位`;
  if (passphrase.length > 512) return "加密口令太长了";
  return null;
}

export async function deriveWrapKeyFromPassphrase(passphrase: string, kdf: KdfParams): Promise<Uint8Array> {
  return scryptAsync(encoder.encode(passphrase.normalize("NFKC")), fromBase64Url(kdf.salt), { N: kdf.N, r: kdf.r, p: kdf.p, dkLen: 32 });
}

/** 第一次设加密口令：生成 encRoot，用口令包好。返回要上传的东西和明文 encRoot（只留在本机内存 / 钥匙串）。 */
export async function createVault(passphrase: string, accountId: string): Promise<{ encRoot: Uint8Array; wrappedEncRoot: string; kdf: KdfParams }> {
  const kdf: KdfParams = { ...DEFAULT_KDF, salt: toBase64Url(randomBytes(16)) };
  const encRoot = randomBytes(ENC_ROOT_BYTES);
  const wrapKey = await deriveWrapKeyFromPassphrase(passphrase, kdf);
  return { encRoot, wrappedEncRoot: wrapEncRoot(wrapKey, encRoot, accountId), kdf };
}

/** 用新口令重新包同一个 encRoot（改口令）。 */
export async function rewrapVault(passphrase: string, encRoot: Uint8Array, accountId: string): Promise<{ wrappedEncRoot: string; kdf: KdfParams }> {
  const kdf: KdfParams = { ...DEFAULT_KDF, salt: toBase64Url(randomBytes(16)) };
  const wrapKey = await deriveWrapKeyFromPassphrase(passphrase, kdf);
  return { wrappedEncRoot: wrapEncRoot(wrapKey, encRoot, accountId), kdf };
}

/** 用口令解开。口令不对抛一句给人看的话。 */
export async function openVault(passphrase: string, wrappedEncRoot: string, kdf: KdfParams, accountId: string): Promise<Uint8Array> {
  const wrapKey = await deriveWrapKeyFromPassphrase(passphrase, kdf);
  try {
    return unwrapEncRoot(wrapKey, wrappedEncRoot, accountId);
  } catch {
    throw new Error("加密口令不对");
  }
}

/* ============================================================================
   配对
   ============================================================================ */

export interface PairingKeyPair {
  privateKey: CryptoKey;
  /** 原始 32 字节公钥的 base64url（发给服务器的就是它）。 */
  publicKey: string;
}

function subtle(): SubtleCrypto {
  const value = globalThis.crypto?.subtle;
  if (!value) throw new Error("这个环境没有 WebCrypto，没法配对");
  return value;
}

export async function createPairingKeys(): Promise<PairingKeyPair> {
  const pair = (await subtle().generateKey({ name: "X25519" }, false, ["deriveBits"])) as CryptoKeyPair;
  const raw = new Uint8Array(await subtle().exportKey("raw", pair.publicKey));
  return { privateKey: pair.privateKey, publicKey: toBase64Url(raw) };
}

/** 双方都算得出来的那组钥匙：封 encRoot 的 key 与给人核对的 6 位校验码。 */
export async function pairingSecrets(input: {
  own: PairingKeyPair;
  peerPublicKey: string;
  /** 发起方（A，显示 6 位码的那台）的公钥。两边要按同一个顺序拼 salt。 */
  initiatorPublicKey: string;
  claimantPublicKey: string;
}): Promise<{ key: Uint8Array; check: string }> {
  const peer = await subtle().importKey("raw", fromBase64Url(input.peerPublicKey) as BufferSource, { name: "X25519" }, false, []);
  const shared = new Uint8Array(await subtle().deriveBits({ name: "X25519", public: peer }, input.own.privateKey, 256));
  const a = fromBase64Url(input.initiatorPublicKey);
  const b = fromBase64Url(input.claimantPublicKey);
  const salt = new Uint8Array(a.length + b.length);
  salt.set(a, 0);
  salt.set(b, a.length);
  const key = hkdf(sha256, shared, salt, encoder.encode("opennote/v1/pairing"), 32);
  const checkBytes = hkdf(sha256, shared, salt, encoder.encode("opennote/v1/pairing-check"), 4);
  const check = String(new DataView(checkBytes.buffer, checkBytes.byteOffset, 4).getUint32(0) % 1_000_000).padStart(6, "0");
  return { key, check };
}

/** A 端：把 encRoot 封给 B。 */
export function sealForPeer(key: Uint8Array, encRoot: Uint8Array, accountId: string): string {
  const nonce = randomBytes(24);
  const sealed = xchacha20poly1305(key, nonce, accountIdBytes(accountId)).encrypt(encRoot);
  const combined = new Uint8Array(nonce.length + sealed.length);
  combined.set(nonce, 0);
  combined.set(sealed, nonce.length);
  return toBase64Url(combined);
}

/** B 端：拆开 A 封来的 encRoot。 */
export function openFromPeer(key: Uint8Array, sealed: string, accountId: string): Uint8Array {
  const combined = fromBase64Url(sealed);
  try {
    return xchacha20poly1305(key, combined.slice(0, 24), accountIdBytes(accountId)).decrypt(combined.slice(24));
  } catch {
    throw new Error("没能解开另一台设备发来的加密口令（配对过程被改动过？请重新配对）");
  }
}

/** PKCE（GitHub 登录）：verifier 与 challenge。和服务端 `auth/github.ts` 的 `pkceChallenge` 是同一个算法。 */
export function createPkce(): { verifier: string; challenge: string } {
  const verifier = toBase64Url(randomBytes(32));
  return { verifier, challenge: toBase64Url(sha256(encoder.encode(verifier))) };
}
