/**
 * E2EE 的密码学原语（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.9、§5.2）。
 *
 * ## 这里的三样东西，每一样都对应一条「做错了会静默失效」的规则
 *
 * ### ① 内容加密：XChaCha20-Poly1305，AAD **必须**绑 `did` 与 `notebookId`
 *
 * §3.9 第 1 条：nonce 每次写入重新随机（192 位，`iv || ct` 存在密文里），
 * 且 **AAD 必须绑定 `did` 与 `notebookId`** ——
 * 「否则攻击者可以把 A 文档的密文搬到 B 文档上（**密文重排攻击**）」。
 *
 * 注意这条攻击的性质：它**不破坏任何加密**，密文仍然能正常解开。
 * 所以只靠「能解密」是测不出来的 —— 必须有**反证用例**（把密文换到另一个 did 上，
 * 断言解不开）。本文件有两条。
 *
 * ### ② `ehash` 必须 **HMAC**，不能是 `sha256(plaintext)`
 *
 * §3.9 第 2 条：「否则服务端能判断『两篇内容是否相同』」。
 * 这是**元数据**泄露：服务端看不到正文，但能靠哈希相等推断出两个文件内容一样。
 * 有一条用例直接断言 `ehashOf(...) !== sha256(plaintext)` ——
 * 因为「用了 HMAC」这件事在**能解密**的前提下是看不出来的。
 *
 * ### ③ `did` 在模式 B 下**不可逆**（HMAC），在模式 A 下可逆（base64url）
 *
 * 模式 A 的 `did` 让服务端看到明文路径（§3.3 表：这是刻意的取舍，换来列树时能拿到可读路径）；
 * 模式 B 用 HMAC 让服务端**看不到路径**。两种模式共存，所以这里的 API 必须把
 * 「这个 did 属于哪种模式」变成调用方要显式说明的东西，而不是猜。
 */

import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { idForPath, normalizeNfc, normalizePath } from "../../shared/paths";
import { deriveNotebookSubkey, toHex } from "./accountKey";
import { hkdf } from "@noble/hashes/hkdf.js";

/** XChaCha20-Poly1305 的 nonce（192 位）。 */
export const NONCE_BYTES = 24;
/** Poly1305 认证标签。 */
const TAG_BYTES = 16;

const encoder = new TextEncoder();

/**
 * 构造内容的 AAD。
 *
 * ## 为什么要带域分隔前缀与换行分隔
 *
 * 拼接必须**无歧义**：`did + notebookId` 直接相接时，
 * `("a", "bc")` 与 `("ab", "c")` 会得到同一串字节 —— 于是 AAD 就绑不住「谁是谁」。
 * 用换行分隔是安全的，因为 `notebookId`（UUID）与 `did`（`[fh]:[A-Za-z0-9_-]+`）
 * 都不可能含换行。前缀 `opennote/v1/content` 做域分隔，让这串 AAD
 * 与别处（例如包裹 `encRoot` 用的那个）在结构上不可能撞。
 */
export function contentAad(did: string, notebookId: string): Uint8Array {
  return encoder.encode(`opennote/v1/content\n${notebookId}\n${did}`);
}

/** 加解密要用的三把子密钥（`enc` / `mac` / `id`）。 */
export interface NotebookKeys {
  /** 内容与附件（AEAD）。 */
  enc: Uint8Array;
  /** `ehash`（内容等价类）。 */
  mac: Uint8Array;
  /** 路径 HMAC（`did`）。 */
  id: Uint8Array;
}

/** 从 `notebookKey` 派生三把子密钥（§3.9 的三个分叉）。 */
export function notebookKeysFrom(notebookKey: Uint8Array): NotebookKeys {
  return {
    enc: deriveNotebookSubkey(notebookKey, "enc"),
    mac: deriveNotebookSubkey(notebookKey, "mac"),
    id: deriveNotebookSubkey(notebookKey, "id"),
  };
}

/* ============================================================================
   内容加解密
   ============================================================================ */

/**
 * 加密一条内容 → `nonce(24B) || ciphertext || tag(16B)`。
 *
 * nonce **每次调用重新随机**（§3.9 第 1 条）。192 位随机 nonce 的碰撞概率在 2⁹⁶ 量级，
 * 笔记场景永远达不到 —— 所以**不需要写入次数预算与计数器**（这是选 XChaCha20 的主要收益）。
 */
export function encryptContent(keys: NotebookKeys, did: string, notebookId: string, plaintext: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const sealed = xchacha20poly1305(keys.enc, nonce, contentAad(did, notebookId)).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return out;
}

/**
 * 解密。**AAD 或密钥不匹配时抛错**（不返回垃圾字节）。
 *
 * 失败时抛**可读**的错误 —— 这条错误会一路走到 UI。`invalid tag` 对用户没有意义，
 * 而「这条内容是在别的笔记本/别的路径下加密的」能直接指出问题。
 */
export function decryptContent(keys: NotebookKeys, did: string, notebookId: string, blob: Uint8Array): Uint8Array {
  if (blob.length < NONCE_BYTES + TAG_BYTES) {
    throw new Error(`密文太短（${blob.length} 字节），不可能是有效内容`);
  }
  const nonce = blob.slice(0, NONCE_BYTES);
  const sealed = blob.slice(NONCE_BYTES);
  try {
    return xchacha20poly1305(keys.enc, nonce, contentAad(did, notebookId)).decrypt(sealed);
  } catch {
    throw new Error("解不开这条内容：密钥不对，或者它是在别的笔记本 / 别的路径下加密的");
  }
}

/* ============================================================================
   内容等价类（`ehash`）
   ============================================================================ */

/**
 * `ehash = HMAC-SHA256(macKey, sha256(plaintext))` → 64 位小写十六进制。
 *
 * ## 为什么先 `sha256` 再 `HMAC`，而不是直接 `HMAC(plaintext)`
 *
 * 两者都能藏住内容，但「先哈希」有一个实际好处：**HMAC 的输入长度固定**。
 * 大附件的 HMAC 只需要对 32 字节做一次，而不是对整份内容 —— 而 `sha256` 那一遍
 * 本来就要算（它是内容标识）。所以这个顺序省一遍大输入的 HMAC。
 *
 * ## ★ 为什么**不能**直接用 `sha256(plaintext)`
 *
 * §3.9 第 2 条：那样**服务端能判断「两篇内容是否相同」**。
 * 服务端看不到正文，但看到两个文件的 `ehash` 相等就知道内容一样 ——
 * 那是一条真实的元数据泄露（「这两个笔记本里有同一份文件」）。
 *
 * ⚠️ 这条错误**在「能解密」的前提下完全看不出来**（内容照样来回），
 * 所以有一条用例直接断言 `ehashOf(...) !== sha256(plaintext)`。
 */
export function ehashOf(keys: NotebookKeys, plaintext: Uint8Array): string {
  return toHex(hmac(sha256, keys.mac, sha256(plaintext)));
}

/** `sha256` 的十六进制（**只给测试做反证用**，生产代码不该拿它当内容标识）。 */
export function sha256HexForTests(bytes: Uint8Array): string {
  return toHex(sha256(bytes));
}

/* ============================================================================
   `did`（路径标识）
   ============================================================================ */

/**
 * 模式 B 的 `did`：`"h:" + HMAC-SHA256(idKey, NFC(path))` 的十六进制。
 *
 * **不可逆** —— 服务端拿到它推不出路径（§3.3、§4.7 设计点 2）。
 * 客户端靠**本地**的 `did ↔ path` 映射反查（§2.2：新设备只能靠全树解密重建）。
 *
 * ⚠️ 用**完整** 32 字节 HMAC（64 位十六进制），不截断：
 * 截断省下的几十字节没有意义，而「截断到多少位才安全」是一个需要论证的决定。
 *
 * ⚠️ 路径必须先 `normalizePath`（去段内空白）再 `normalizeNfc` —— 与模式 A 的
 * `idForPath` 用**同一套**规范化。否则同一份文件在两种模式下会算出两个 did，
 * 而症状是「切了加密模式之后所有文件都变成新增」。
 */
export function didForPath(keys: NotebookKeys, path: string): string {
  const normalized = normalizeNfc(normalizePath(path));
  return `h:${toHex(hmac(sha256, keys.id, encoder.encode(normalized)))}`;
}

/**
 * 模式 A 的 `did`：`"f:" + base64url(NFC(normalized path))`（**可逆**）。
 *
 * 直接复用 `shared/paths.ts` 的实现 —— 模式 A 的 did 规则**只有一份**，
 * 在这里重写一遍迟早会与服务端的校验、夹具、`_design` 的 JS 漂移。
 */
export function didForPlainPath(path: string): string {
  return idForPath(path);
}

/** 模式 A 的 `did` 是不是形状合法（服务端也用同一个判定）。 */
export { isValidPathDocId as isValidPlainDid } from "../../shared/paths";

/* ============================================================================
   组合：一条内容的一次完整处理
   ============================================================================ */

export interface SealedContent {
  did: string;
  /** 交给远端的密文字节（`nonce || ct`）。 */
  bytes: Uint8Array;
  /** 内容等价类（远端用它比「是否相同」，看不出内容）。 */
  ehash: string;
  /** 密文长度（服务端在 E2EE 下**能看到大小**，如实记录，§3.4）。 */
  esize: number;
}

/**
 * 把一份明文封成「可以发给服务端的形状」。
 *
 * 这个函数是**唯一的**封口处：调用方拿不到「只加密不算 ehash」这种半成品，
 * 于是「忘了算 ehash」或「用了错的 did」这类错误没有发生的地方。
 */
export function sealContent(keys: NotebookKeys, notebookId: string, path: string, plaintext: Uint8Array): SealedContent {
  const did = didForPath(keys, path);
  const bytes = encryptContent(keys, did, notebookId, plaintext);
  return { did, bytes, ehash: ehashOf(keys, plaintext), esize: bytes.length };
}

/**
 * 打开远端来的密文。
 *
 * `path` 由调用方从**本地**的 `did ↔ path` 映射里取（§2.2）——
 * 引擎不会、也不能从 did 反推路径（那是 HMAC）。
 */
export function openContent(keys: NotebookKeys, notebookId: string, did: string, path: string, bytes: Uint8Array): Uint8Array {
  // 先校验「did 与 path 对得上」：对不上说明本地的映射已经过期，
  // 这时解密会失败，而**先检查**能给出一个指向根因的错误。
  const expected = didForPath(keys, path);
  if (expected !== did) {
    throw new Error("did 与本地路径对不上（本地的 did↔path 映射可能已经过期）");
  }
  return decryptContent(keys, did, notebookId, bytes);
}

/* ============================================================================
   路径映射表（★ 全新设备的 did↔path 重建，P4-b 的缺口）
   ============================================================================ */

/**
 * 派生「路径映射表」的密钥。
 *
 * ## 这张表为什么必须存在
 *
 * 模式 B 的 `did = HMAC(idKey, path)` **不可逆**，而 `did↔path` 映射按设计
 * 只存在**本地**（`.opennote/sync.json`，§3.11 要求它**绝不能跨端**）。
 *
 * 于是有一台设备上的死路：**全新设备**（本地空、账本空）看到远端树时
 * 没有任何办法把 did 翻回文件名 —— 它拿不到「这个密文该写到哪个文件名」，
 * 一个文件都拉不下来。（`engine` 的处理是对的：如实报进 `unknownDids`，
 * 绝不猜路径、绝不写盘。但那条路走不通。）
 *
 * ## 解法：把这张表**加密后**当成一条普通记录同步
 *
 * 它不能明文上云（那就等于把路径泄露了，模式 B 白做），
 * 但可以用 `encRoot` 派生的密钥加密 —— 于是：
 *
 * - **新设备**：导入账号密钥 → 解锁 `encRoot` → 解密这张表 → 有了路径，能拉文件了；
 * - **服务端**：没有 `encRoot`，看到的只是一条密文记录，**学不到任何路径**。
 *
 * 这正是「密钥即身份」的应有之义：**只要有密钥，换台设备就能重建一切**。
 *
 * ⚠️ 与 `notebookKey` 的区别：这张表是**账号级**的（`encRoot` 派生），
 * 但它记的内容是**每个笔记本各自**的映射 —— 所以 `notebookId` 进 AAD，
 * 防止把 A 笔记本的表塞给 B（那样会把文件写到错误的位置）。
 */
export const PATHMAP_INFO = "opennote/v1/pathmap";

export function derivePathMapKey(encRoot: Uint8Array): Uint8Array {
  // 与 `deriveNotebookKey` 同款：§3.9 的层级表里这条派生**没有 salt**。
  return hkdf(sha256, encRoot, undefined, encoder.encode(PATHMAP_INFO), 32);
}

/** 一条映射：`did ↔ 工作区相对路径`。 */
export interface PathMapEntry {
  did: string;
  path: string;
}

/**
 * 把映射表编码成可上传的密文（`nonce || ct || tag`）。
 *
 * 明文用 JSON：这张表**不受二维码尺寸约束**（不像账号密钥），
 * 而可读的格式在排查「某个文件为什么没同步」时价值很大。
 */
export function encodePathMap(pathMapKey: Uint8Array, notebookId: string, entries: PathMapEntry[]): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  const plaintext = encoder.encode(JSON.stringify(entries));
  // AAD 绑 `notebookId`：防止把 A 笔记本的表塞给 B（会把文件写到错误的位置）。
  const sealed = xchacha20poly1305(pathMapKey, nonce, encoder.encode(`opennote/v1/pathmap
${notebookId}`)).encrypt(plaintext);
  const out = new Uint8Array(NONCE_BYTES + sealed.length);
  out.set(nonce, 0);
  out.set(sealed, NONCE_BYTES);
  return out;
}

/**
 * 解开映射表。
 *
 * 形状不对的条目**丢掉**而不是整张表作废：一条坏记录不该让整台新设备
 * 一个文件都拉不下来（与 `/v1/tree` 逐条判定、坏的丢掉同一个道理）。
 */
export function decodePathMap(pathMapKey: Uint8Array, notebookId: string, blob: Uint8Array): PathMapEntry[] {
  if (blob.length < NONCE_BYTES + TAG_BYTES) throw new Error("路径映射表太短，不可能是有效内容");
  const nonce = blob.slice(0, NONCE_BYTES);
  const sealed = blob.slice(NONCE_BYTES);
  let plaintext: Uint8Array;
  try {
    plaintext = xchacha20poly1305(pathMapKey, nonce, encoder.encode(`opennote/v1/pathmap
${notebookId}`)).decrypt(sealed);
  } catch {
    throw new Error("解不开路径映射表：密钥不对，或者它属于别的笔记本");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new Error("路径映射表的内容不是合法 JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("路径映射表的内容不是数组");
  const out: PathMapEntry[] = [];
  for (const item of parsed) {
    const entry = item as { did?: unknown; path?: unknown };
    // 形状不对的条目丢掉（见函数说明）。
    if (typeof entry?.did === "string" && typeof entry?.path === "string" && entry.did !== "" && entry.path !== "") {
      out.push({ did: entry.did, path: entry.path });
    }
  }
  return out;
}
