/**
 * 端到端加密的密钥层级与编码工具（`docs/执行-同步重写-2026-11-02.md` 阶段 ④ 起）。
 *
 * ## 密钥层级（**必须这样分叉，否则 E2EE 是假的**）
 *
 * ```
 * 加密口令 ──scrypt──▶ wrapKey（`vault.ts`，★ 只在客户端）
 *    ▼
 * encRoot     32B CSPRNG，账号级秘密
 *    │ AEAD(wrapKey, encRoot, aad = accountId) = wrappedEncRoot → 存服务端（服务端解不开）
 *    │ HKDF-SHA256(info = "opennote/v1/notebook/" + notebookId) → notebookKey
 *    ▼
 * notebookKey
 *    ├── HKDF(info="enc") → 内容与附件（AEAD）
 *    ├── HKDF(info="mac") → ehash（HMAC-SHA256）
 *    └── HKDF(info="id")  → 路径 HMAC（did）
 * ```
 *
 * 登录凭据（邮箱密码 / GitHub / 设备会话令牌）与这条链**完全无关**：管理员重置登录密码、
 * 服务端泄露会话令牌，都碰不到 encRoot。旧的「账号密钥即身份」（`accountKey` 派生 `authToken`）
 * 已随同步重写删除。
 *
 * ## 两个刻意的实现决定
 *
 * ### ① 用 `@noble/hashes` 而不是 WebCrypto
 *
 * noble 是纯 JS，四个宿主（Electron 渲染层 / 主进程 / Capacitor WebView / 浏览器）跑同一份字节码，
 * 测试也只需要一套。（配对的 X25519 是例外，见 `vault.ts`。）
 *
 * ### ② `accountId` 当 AAD 用的是**那 16 个字节**，不是十六进制字符串的 ASCII
 *
 * `accountId` 的传输编码是 32 位小写十六进制，但它本身是「16B 随机」。所以 AAD = 解码后的 16 字节。
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/* ============================================================================
   常量：**这些字符串是协议的一部分**，改一个字就是另一套密钥
   ============================================================================ */

/** HKDF `info` 的统一前缀（§3.9：`"opennote/v1/…"`）。 */
export const HKDF_INFO_PREFIX = "opennote/v1/";



/** 每笔记本一把钥匙（§3.9）。 */
export function hkdfInfoNotebook(notebookId: string): string {
  return `${HKDF_INFO_PREFIX}notebook/${notebookId}`;
}

/** `notebookKey` 的三个分叉（§3.9）。 */
export const NOTEBOOK_SUBKEY_INFO = {
  /** 内容与附件（AEAD）。 */
  enc: "enc",
  /** `ehash`（内容等价类，HMAC-SHA256）。 */
  mac: "mac",
  /** 路径 HMAC（`did`）。 */
  id: "id",
} as const;

export type NotebookSubkeyUsage = keyof typeof NOTEBOOK_SUBKEY_INFO;


/** 各材料的字节长度。 */
export const ACCOUNT_ID_BYTES = 16;

export const ENC_ROOT_BYTES = 32;
/** XChaCha20-Poly1305 的 nonce（192 位 —— 随机 nonce 天然安全，§4.9）。 */
const XCHACHA_NONCE_BYTES = 24;
/** Poly1305 认证标签长度。 */
const AEAD_TAG_BYTES = 16;

/* ============================================================================
   编解码工具（十六进制 / base64url）
   ============================================================================ */

const HEX = "0123456789abcdef";

/** 字节 → 小写十六进制。 */
export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += HEX[byte >> 4]! + HEX[byte & 15]!;
  return out;
}

/**
 * 小写十六进制 → 字节。
 *
 * ⚠️ **只接受小写**（与 `shared/contract.ts` 的 `accountIdSchema` 一致）。
 * 接受大写会让「同一个 accountId 有两种写法」，而它同时是 HKDF salt ——
 * 两种写法 ⇒ 两把不同的密钥 ⇒ 一个极难查的「密钥对不上」。
 */
export function fromHex(text: string): Uint8Array {
  if (typeof text !== "string" || text.length % 2 !== 0 || !/^[0-9a-f]*$/.test(text)) {
    throw new Error(`不是合法的小写十六进制：${String(text).slice(0, 16)}…`);
  }
  const out = new Uint8Array(text.length / 2);
  for (let index = 0; index < out.length; index += 1) {
    out[index] = Number.parseInt(text.slice(index * 2, index * 2 + 2), 16);
  }
  return out;
}

/** 字节 → base64url（无填充）。 */
export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** base64url（可有可无填充）→ 字节。 */
export function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const withPadding = padded + "=".repeat((4 - (padded.length % 4)) % 4);
  const binary = atob(withPadding);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) out[index] = binary.charCodeAt(index);
  return out;
}

/* ============================================================================
   生成
   ============================================================================ */

/** 系统 CSPRNG。**绝不**用 `Math.random`（§4.9 的硬约束）。 */
function random(length: number): Uint8Array {
  return randomBytes(length);
}

/** 生成 `encRoot`：32B CSPRNG（注册时生成一次，永不外发）。 */
export function generateEncRoot(): Uint8Array {
  return random(ENC_ROOT_BYTES);
}

/* ============================================================================
   派生
   ============================================================================ */

/**
 * `accountId` → HKDF salt / AEAD AAD 用的**那 16 个字节**。
 *
 * 见模块头 ②：文档说 `accountId` 是「16B 随机」，十六进制只是它的传输表示。
 */
export function accountIdBytes(accountId: string): Uint8Array {
  const bytes = fromHex(accountId);
  if (bytes.length !== ACCOUNT_ID_BYTES) {
    throw new Error(`accountId 必须是 ${ACCOUNT_ID_BYTES} 字节（${ACCOUNT_ID_BYTES * 2} 位十六进制），实得 ${bytes.length} 字节`);
  }
  return bytes;
}

/**
 * `notebookKey = HKDF-SHA256(encRoot, info = "opennote/v1/notebook/" + notebookId)`。
 *
 * ⚠️ **没有 salt**（§3.9 的层级表里这一行没写 salt）。HKDF 在没给 salt 时按 RFC 5869 §2.2
 * 用 `HashLen` 个零 —— 传 `undefined` 与传空数组在这里**等价**（HMAC 会把两者都补成
 * 全零的块），有一条用例把这个等价性钉住，免得将来有人「顺手加个 salt」。
 */
export function deriveNotebookKey(encRoot: Uint8Array, notebookId: string): Uint8Array {
  return hkdf(sha256, encRoot, undefined, new TextEncoder().encode(hkdfInfoNotebook(notebookId)), 32);
}

/**
 * `notebookKey` 的三个分叉：`enc`（内容）/ `mac`（`ehash`）/ `id`（路径 HMAC）。
 *
 * 分成三把的意义：`ehash` 用的密钥泄露不会顺带泄露内容密钥；
 * 而 `id` 那一把让「路径 HMAC」与「内容等价类」互相独立。
 */
export function deriveNotebookSubkey(notebookKey: Uint8Array, usage: NotebookSubkeyUsage): Uint8Array {
  return hkdf(sha256, notebookKey, undefined, new TextEncoder().encode(NOTEBOOK_SUBKEY_INFO[usage]), 32);
}

/* ============================================================================
   `encRoot` 的包裹与解开
   ============================================================================ */

/**
 * `wrappedEncRoot = base64url(nonce(24B) || AEAD(wrapKey, encRoot, aad = accountId))`。
 *
 * AAD 绑 `accountId` 的理由（§3.9）：防**跨账号替换** —— 攻击者把 B 的 `wrappedEncRoot`
 * 塞给 A 的账号，A 解出来的会是 B 的 `encRoot`（而不是报错）。绑了 AAD 之后解不开。
 */
export function wrapEncRoot(wrapKey: Uint8Array, encRoot: Uint8Array, accountId: string): string {
  const nonce = random(XCHACHA_NONCE_BYTES);
  const sealed = xchacha20poly1305(wrapKey, nonce, accountIdBytes(accountId)).encrypt(encRoot);
  const combined = new Uint8Array(nonce.length + sealed.length);
  combined.set(nonce, 0);
  combined.set(sealed, nonce.length);
  return toBase64Url(combined);
}

/**
 * 解开 `wrappedEncRoot`。
 *
 * 解不开时抛一个**可读**的错误 —— 这条错误会一路走到 UI（「密钥不对」/「包裹已损坏」），
 * 而一个 `Error: invalid tag` 对用户毫无意义。
 */
export function unwrapEncRoot(wrapKey: Uint8Array, wrapped: string, accountId: string): Uint8Array {
  let combined: Uint8Array;
  try {
    combined = fromBase64Url(wrapped);
  } catch {
    throw new Error("wrappedEncRoot 不是合法的 base64url");
  }
  if (combined.length < XCHACHA_NONCE_BYTES + AEAD_TAG_BYTES) {
    throw new Error(`wrappedEncRoot 太短（${combined.length} 字节）`);
  }
  const nonce = combined.slice(0, XCHACHA_NONCE_BYTES);
  const sealed = combined.slice(XCHACHA_NONCE_BYTES);
  try {
    return xchacha20poly1305(wrapKey, nonce, accountIdBytes(accountId)).decrypt(sealed);
  } catch {
    // 两种可能，对用户是同一件事：密钥不对，或者包裹被人动过。
    throw new Error("解不开 wrappedEncRoot：账号密钥不对，或者包裹已损坏");
  }
}

/* ============================================================================
   测试向量用的低层入口（`accountKey.test.ts` 拿它跑 RFC 5869）
   ============================================================================ */

/**
 * 直接暴露 HKDF-SHA256 —— **只给测试向量用**。
 *
 * 有一条用例拿它跑 [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) 的七个测试向量
 * （§10 的 U23 明确要求「HKDF 用 RFC 5869 测试向量」）。
 * 生产代码**不该**调它：任何派生都应该走上面那些带语义的函数，
 * 否则「info 字符串写错了」这种事就没有地方拦。
 */
export function hkdfSha256ForTests(ikm: Uint8Array, salt: Uint8Array | undefined, info: Uint8Array, length: number): Uint8Array {
  return hkdf(sha256, ikm, salt, info, length);
}

/** 直接暴露 HMAC-SHA256（测试向量用）。 */
export function hmacSha256ForTests(key: Uint8Array, message: Uint8Array): Uint8Array {
  return hmac(sha256, key, message);
}

/** 直接暴露 XChaCha20-Poly1305（测试向量用）。 */
export function xchachaForTests(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array): { encrypt: (plaintext: Uint8Array) => Uint8Array; decrypt: (ciphertext: Uint8Array) => Uint8Array } {
  const cipher = xchacha20poly1305(key, nonce, aad);
  return { encrypt: (plaintext) => cipher.encrypt(plaintext), decrypt: (ciphertext) => cipher.decrypt(ciphertext) };
}
