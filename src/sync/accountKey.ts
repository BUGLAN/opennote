/**
 * 账号密钥的生成 / 派生 / 编解码（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.5、§3.9）。
 *
 * ## 密钥层级（**必须这样分叉，否则 E2EE 是假的**）
 *
 * ```
 * accountId   16B 随机，公开（当 HKDF salt 与 AEAD AAD）
 * accountKey  32B CSPRNG，★ 秘密，★ 永不发给服务端
 *    │ HKDF-SHA256(salt = accountId, info = "opennote/v1/auth") → authToken → 唯一发给服务端的东西
 *    │ HKDF-SHA256(salt = accountId, info = "opennote/v1/wrap") → wrapKey   → ★ 永不外发
 *    ▼
 * encRoot     32B CSPRNG，秘密
 *    │ AEAD(wrapKey, encRoot, aad = accountId) = wrappedEncRoot → 存服务端（服务端解不开）
 *    │ HKDF-SHA256(info = "opennote/v1/notebook/" + notebookId) → notebookKey
 *    ▼
 * notebookKey
 *    ├── HKDF(info="enc") → 内容与附件（AEAD）
 *    ├── HKDF(info="mac") → ehash（HMAC-SHA256）
 *    └── HKDF(info="id")  → 路径 HMAC（did）
 * ```
 *
 * **为什么 `auth` / `wrap` 必须分叉**：两者都由 `accountKey` 经 HKDF 导出，但**互相推不出来**
 * （HKDF 的输出在计算上独立）。所以服务端 —— 以及终结 TLS 的云边缘 —— 拿到 `authToken`
 * 也拿不到 `wrapKey`，解不开 `wrappedEncRoot`，拿不到 `encRoot`。**E2EE 成立。**
 *
 * 反例（一定要避免）：直接把 `accountKey` 当令牌发出去 ⇒ 服务端拿到了加密根 ⇒
 * **服务端能解开全部笔记**，E2EE 名存实亡。
 *
 * ## 三个刻意的实现决定
 *
 * ### ① 用 `@noble/hashes` 而不是 WebCrypto
 *
 * §3.9 / §4.9 明确选了 noble，理由不是体积而是**一条代码路径**：WebCrypto 是异步的，
 * 且四个宿主（Electron 渲染层 / 主进程 / Capacitor WebView / 浏览器）在 HKDF 与 HMAC 的
 * 细节上有差异。noble 是纯 JS，四端跑同一份字节码，测试也只需要一套。
 *
 * ⚠️ 但**控制台**（`server/src/panel/app.js`）是「无构建步骤」的静态页，没法 import noble，
 * 只能用 WebCrypto。所以那里必须**逐参数对齐**（salt / info / 长度），并且
 * `accountKey.test.ts` 里有一条用例**把两种实现算出来的字节直接比对** ——
 * 光靠「它们应该一致」是不够的，HKDF 的参数差一个字就是完全不同的密钥，
 * 而症状会是「密钥输错了」（一个会把人引到错方向的报错）。
 *
 * ### ② `accountId` 当 salt 用的是**那 16 个字节**，不是十六进制字符串的 ASCII
 *
 * 这一点文档没有明写到字节级，而它是最容易在两个实现之间分叉的地方：
 * `accountId` 的**传输**编码是 32 位小写十六进制（见 `shared/contract.ts`），
 * 但它**本身**是「16B 随机」（§1.5 流程①第 1 步、§3.9 层级表）。所以：
 * salt = 十六进制解码后的 16 字节，AAD 同理。
 *
 * 选它的理由：文档两次都说「16B 随机」，而十六进制只是它的**表示**。
 * 用 ASCII 也能工作，但那样「accountId 是 16 字节」这句话在每个实现里都要重新解释一遍。
 * 有一条用例把这个决定钉住（改掉它会让 `deriveAuthToken` 的输出变掉）。
 *
 * ### ③ 密钥导出格式是**紧凑二进制**，不是 JSON
 *
 * §5.2 要求它支持**二维码**。JSON 会把 49 字节膨胀到 150+ 字符，
 * 而紧凑二进制 base64url 后是 66 字符 —— 二维码能小一大圈（也更不容易扫错）。
 *
 * 格式：`opennote-key-v1.` + base64url( version(1B) || accountId(16B) || accountKey(32B) )
 *
 * `accountId` **必须**在里面：`authToken` 的派生 salt 是它，少了它新设备就算拿到
 * `accountKey` 也派不出令牌（而它本来就是公开值，放进去不泄露任何东西）。
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

/** → `authToken`（唯一发给服务端的东西）。 */
export const HKDF_INFO_AUTH = `${HKDF_INFO_PREFIX}auth`;

/** → `wrapKey`（永不外发）。 */
export const HKDF_INFO_WRAP = `${HKDF_INFO_PREFIX}wrap`;

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

/** 账号密钥导出的文本前缀。 */
export const ACCOUNT_KEY_PREFIX = "opennote-key-v1.";

/** 二进制 blob 的版本号（将来换格式时靠它区分）。 */
const BLOB_VERSION = 1;

/** 各材料的字节长度。 */
export const ACCOUNT_ID_BYTES = 16;
export const ACCOUNT_KEY_BYTES = 32;
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

/** 生成 `accountId`：16B 随机 → 32 位小写十六进制（**公开**值）。 */
export function generateAccountId(): string {
  return toHex(random(ACCOUNT_ID_BYTES));
}

/** 生成 `accountKey`：32B CSPRNG（**用户保存的唯一秘密**）。 */
export function generateAccountKey(): Uint8Array {
  return random(ACCOUNT_KEY_BYTES);
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
 * `authToken = HKDF-SHA256(accountKey, salt = accountId, info = "opennote/v1/auth")` → 64 位小写十六进制。
 *
 * 这是**唯一**发给服务端的东西（服务端只存它的 `sha256`）。
 */
export function deriveAuthToken(accountKey: Uint8Array, accountId: string): string {
  return toHex(hkdf(sha256, accountKey, accountIdBytes(accountId), new TextEncoder().encode(HKDF_INFO_AUTH), 32));
}

/** `wrapKey = HKDF-SHA256(accountKey, salt = accountId, info = "opennote/v1/wrap")`。**永不外发。** */
export function deriveWrapKey(accountKey: Uint8Array, accountId: string): Uint8Array {
  return hkdf(sha256, accountKey, accountIdBytes(accountId), new TextEncoder().encode(HKDF_INFO_WRAP), 32);
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
   账号密钥的导出 / 导入（紧凑二进制 + base64url，为二维码优化）
   ============================================================================ */

export interface AccountKeyMaterial {
  /** 32 位小写十六进制。 */
  accountId: string;
  accountKey: Uint8Array;
}

/**
 * 编码成可复制 / 可扫的文本。
 *
 * 格式：`opennote-key-v1.` + base64url( version(1B) || accountId(16B) || accountKey(32B) )
 * —— 49 字节 → 66 个 base64url 字符，二维码能小一大圈（§5.2 要求支持二维码）。
 */
export function encodeAccountKey(material: AccountKeyMaterial): string {
  const accountId = accountIdBytes(material.accountId);
  if (material.accountKey.length !== ACCOUNT_KEY_BYTES) {
    throw new Error(`accountKey 必须是 ${ACCOUNT_KEY_BYTES} 字节，实得 ${material.accountKey.length}`);
  }
  const blob = new Uint8Array(1 + ACCOUNT_ID_BYTES + ACCOUNT_KEY_BYTES);
  blob[0] = BLOB_VERSION;
  blob.set(accountId, 1);
  blob.set(material.accountKey, 1 + ACCOUNT_ID_BYTES);
  return ACCOUNT_KEY_PREFIX + toBase64Url(blob);
}

/**
 * 解码用户粘进来 / 扫进来的文本。
 *
 * 容忍：前后空白、没有前缀（用户可能只复制了 base64 部分）。
 * **不容忍**：版本不对、长度不对 —— 那两种都会导致「派生出错误的密钥」，
 * 而症状是「密钥不对」，会让人去怀疑密钥本身而不是粘贴格式。
 */
export function decodeAccountKey(text: string): AccountKeyMaterial {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) throw new Error("密钥是空的");
  const body = trimmed.startsWith(ACCOUNT_KEY_PREFIX) ? trimmed.slice(ACCOUNT_KEY_PREFIX.length) : trimmed;

  let blob: Uint8Array;
  try {
    blob = fromBase64Url(body);
  } catch {
    throw new Error("密钥不是合法的 base64url");
  }
  const expected = 1 + ACCOUNT_ID_BYTES + ACCOUNT_KEY_BYTES;
  if (blob.length !== expected) {
    throw new Error(`密钥长度不对：期待 ${expected} 字节，实得 ${blob.length} 字节`);
  }
  if (blob[0] !== BLOB_VERSION) {
    throw new Error(`不认识的密钥版本：${blob[0]}（本版只认 ${BLOB_VERSION}）`);
  }
  return {
    accountId: toHex(blob.slice(1, 1 + ACCOUNT_ID_BYTES)),
    accountKey: blob.slice(1 + ACCOUNT_ID_BYTES),
  };
}

/* ============================================================================
   组合：注册与解锁（§1.5 的三个流程）
   ============================================================================ */

export interface RegistrationMaterial {
  accountId: string;
  accountKey: Uint8Array;
  encRoot: Uint8Array;
  /** 发给服务端的令牌。 */
  authToken: string;
  /** 发给服务端的包裹（服务端解不开）。 */
  wrappedEncRoot: string;
}

/**
 * 流程①：注册时客户端生成**一切**密钥材料（§1.5）。
 *
 * ⚠️ 这个函数**只在客户端存在**。服务端生成任何一样东西都等于 E2EE 不成立（红线 3）。
 */
export function createRegistrationMaterial(): RegistrationMaterial {
  const accountId = generateAccountId();
  const accountKey = generateAccountKey();
  const encRoot = generateEncRoot();
  return {
    accountId,
    accountKey,
    encRoot,
    authToken: deriveAuthToken(accountKey, accountId),
    wrappedEncRoot: wrapEncRoot(deriveWrapKey(accountKey, accountId), encRoot, accountId),
  };
}

/** 流程②：新设备导入 `accountKey` 之后能立刻派生的东西（还差服务端给 `wrappedEncRoot`）。 */
export function deriveFromAccountKey(material: AccountKeyMaterial): { authToken: string; wrapKey: Uint8Array } {
  return {
    authToken: deriveAuthToken(material.accountKey, material.accountId),
    wrapKey: deriveWrapKey(material.accountKey, material.accountId),
  };
}

/** 流程②的后半：拿到服务端的 `wrappedEncRoot` 之后解开（**一个秘密搞定**）。 */
export function unlockEncRoot(material: AccountKeyMaterial, wrappedEncRoot: string): Uint8Array {
  return unwrapEncRoot(deriveWrapKey(material.accountKey, material.accountId), wrappedEncRoot, material.accountId);
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
