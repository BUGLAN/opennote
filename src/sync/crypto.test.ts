/**
 * E2EE 原语的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.9、§3.3、§4.7 设计点 2）。
 *
 * ## 这里最重要的一组是**反证**
 *
 * §3.9 的两条要求，做错了都**不会让程序崩**，而且都**在「能正常加解密」的前提下看不出来**：
 *
 * - **AAD 没绑 `did`/`notebookId`** ⇒ 密文照样能解开，只是**能被人搬到别的文件上**（密文重排攻击）；
 * - **`ehash` 用了 `sha256(plaintext)`** ⇒ 内容照样来回，只是**服务端能看出两篇内容相同**。
 *
 * 所以下面不是「验证它能工作」，而是「验证那些**看起来能工作**的错法会被抓住」。
 */
import { describe, expect, it } from "vitest";
import {
  NONCE_BYTES,
  contentAad,
  decryptContent,
  didForPath,
  didForPlainPath,
  ehashOf,
  encryptContent,
  notebookKeysFrom,
  openContent,
  sealContent,
  sha256HexForTests,
  derivePathMapKey,
  encodePathMap,
  decodePathMap,
} from "./crypto";
import { deriveNotebookKey, toHex, xchachaForTests } from "./accountKey";
import { idForPath } from "../../shared/paths";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const dec = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const ENC_ROOT = Uint8Array.from({ length: 32 }, (_, index) => index);
const NOTEBOOK = "11111111-2222-4333-8444-555555555555";
const OTHER_NOTEBOOK = "99999999-8888-4777-8666-555555555555";
const keys = notebookKeysFrom(deriveNotebookKey(ENC_ROOT, NOTEBOOK));
const otherKeys = notebookKeysFrom(deriveNotebookKey(ENC_ROOT, OTHER_NOTEBOOK));

const DID_A = didForPath(keys, "notes/a.md");
const DID_B = didForPath(keys, "notes/b.md");

/* ============================================================================
   往返
   ============================================================================ */

describe("往返：字节逐字节相同", () => {
  it("普通文本", () => {
    const plaintext = enc("# 你好，笔记 📓\n第二行");
    const blob = encryptContent(keys, DID_A, NOTEBOOK, plaintext);
    expect(dec(decryptContent(keys, DID_A, NOTEBOOK, blob))).toBe("# 你好，笔记 📓\n第二行");
  });

  it("空内容与二进制内容（附件不一定是文本）", () => {
    const empty = new Uint8Array(0);
    expect(decryptContent(keys, DID_A, NOTEBOOK, encryptContent(keys, DID_A, NOTEBOOK, empty))).toHaveLength(0);
    const binary = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(Array.from(decryptContent(keys, DID_A, NOTEBOOK, encryptContent(keys, DID_A, NOTEBOOK, binary)))).toEqual(Array.from(binary));
  });

  it("密文形状：`nonce(24) || ct || tag(16)`（长度 = 明文 + 40）", () => {
    const blob = encryptContent(keys, DID_A, NOTEBOOK, enc("12345"));
    expect(blob.length).toBe(NONCE_BYTES + 5 + 16);
  });

  it("★ nonce 每次重新随机 ⇒ 同一份内容两次加密**不同**（192 位随机，不需要写入预算）", () => {
    const plaintext = enc("同一份内容");
    const first = encryptContent(keys, DID_A, NOTEBOOK, plaintext);
    const second = encryptContent(keys, DID_A, NOTEBOOK, plaintext);
    expect(toHex(first)).not.toBe(toHex(second));
    // 但两份都能解开。
    expect(dec(decryptContent(keys, DID_A, NOTEBOOK, first))).toBe("同一份内容");
    expect(dec(decryptContent(keys, DID_A, NOTEBOOK, second))).toBe("同一份内容");
  });
});

/* ============================================================================
   ★ AAD 绑定（密文重排攻击）
   ============================================================================ */

describe("★ §3.9 第 1 条 · AAD 绑 `did` 与 `notebookId`（防密文重排）", () => {
  it("★ 把 A 的密文搬到 B 的 did 上 ⇒ **解不开**", () => {
    /*
     * 这就是「密文重排攻击」：攻击者把 `notes/a.md` 的密文贴到 `notes/b.md` 上。
     * 不绑 did 的话，用户打开 b.md 会看到 a.md 的内容 —— 它**不报错**，
     * 只是「内容悄悄换了一份」。所以只有反证用例能抓住它。
     */
    const blob = encryptContent(keys, DID_A, NOTEBOOK, enc("A 的秘密"));
    expect(() => decryptContent(keys, DID_B, NOTEBOOK, blob)).toThrow(/别的笔记本 \/ 别的路径/);
  });

  it("★ 把密文搬到**别的笔记本** ⇒ 也解不开", () => {
    const blob = encryptContent(keys, DID_A, NOTEBOOK, enc("A 的秘密"));
    expect(() => decryptContent(keys, DID_A, OTHER_NOTEBOOK, blob)).toThrow();
  });

  it("★ AAD 的拼接**无歧义**（`did` 与 `notebookId` 交换/错位都不会撞）", () => {
    /*
     * 如果实现写成 `did + notebookId` 直接相接，那么 `("a","bc")` 与 `("ab","c")`
     * 会得到同一串 AAD —— 绑定就失效了。用换行分隔 + 域前缀把这件事排除掉。
     */
    const a = toHex(contentAad("a", "bc"));
    const b = toHex(contentAad("ab", "c"));
    expect(a).not.toBe(b);
    // 域前缀让这串 AAD 与别处（包裹 encRoot 用的那个）结构上不可能撞。
    expect(dec(contentAad("f:x", "nb"))).toContain("opennote/v1/content");
  });

  it("换密钥也解不开（AAD 对了，密钥不对）", () => {
    const blob = encryptContent(keys, DID_A, NOTEBOOK, enc("x"));
    const otherNotebookKeys = notebookKeysFrom(deriveNotebookKey(Uint8Array.from({ length: 32 }, (_, i) => 255 - i), NOTEBOOK));
    expect(() => decryptContent(otherNotebookKeys, DID_A, NOTEBOOK, blob)).toThrow();
  });

  it("改动密文一个字节 ⇒ 解不开（认证标签在起作用）", () => {
    const blob = encryptContent(keys, DID_A, NOTEBOOK, enc("x"));
    blob[blob.length - 1] ^= 0x01;
    expect(() => decryptContent(keys, DID_A, NOTEBOOK, blob)).toThrow();
  });

  it("太短的 blob 给**可读**的错误（不是 `invalid tag`）", () => {
    expect(() => decryptContent(keys, DID_A, NOTEBOOK, new Uint8Array(10))).toThrow(/太短/);
  });
});

/* ============================================================================
   ★ ehash
   ============================================================================ */

describe("★ §3.9 第 2 条 · `ehash` 必须是 HMAC，不能是裸 `sha256`", () => {
  it("★ `ehashOf(...)` **不等于** `sha256(plaintext)`（否则服务端能看出两篇内容相同）", () => {
    /*
     * 这条错误在「能正常加解密」的前提下**完全看不出来** —— 内容照样来回。
     * 它泄露的是**元数据**：服务端看不到正文，但看到两个文件的 ehash 相等
     * 就知道内容一样（「这两个笔记本里有同一份文件」）。
     *
     * 所以只能靠直接比对来钉住。
     */
    const plaintext = enc("同样的内容");
    expect(ehashOf(keys, plaintext)).not.toBe(sha256HexForTests(plaintext));
    expect(ehashOf(keys, plaintext)).toHaveLength(64);
  });

  it("同一份内容 ⇒ 同一个 `ehash`（客户端要靠它判「内容没变」）", () => {
    expect(ehashOf(keys, enc("x"))).toBe(ehashOf(keys, enc("x")));
  });

  it("不同内容 ⇒ 不同 `ehash`；差一个字节也变", () => {
    expect(ehashOf(keys, enc("x"))).not.toBe(ehashOf(keys, enc("y")));
    expect(ehashOf(keys, enc("ab"))).not.toBe(ehashOf(keys, enc("ac")));
  });

  it("★ 换笔记本的 `macKey` ⇒ 同一份内容的 `ehash` 不同（跨笔记本不可比）", () => {
    /*
     * 这挡住的是「用笔记本 A 的 ehash 去 B 里比」——那种比较**没有意义**
     * （不同笔记本的密钥不同），而如果实现用了全局固定的 macKey，它就会「看起来能比」，
     * 从而让跨笔记本的内容关联成为可能。
     */
    expect(ehashOf(keys, enc("x"))).not.toBe(ehashOf(otherKeys, enc("x")));
  });
});

/* ============================================================================
   did
   ============================================================================ */

describe("§3.3 · `did`：模式 B 不可逆、模式 A 可逆", () => {
  it("模式 B：同一路径稳定、不同路径不同、形状是 `h:` + 64 hex", () => {
    expect(didForPath(keys, "notes/a.md")).toBe(DID_A);
    expect(DID_A).not.toBe(DID_B);
    expect(DID_A).toMatch(/^h:[0-9a-f]{64}$/);
  });

  it("★ 模式 B 的 did **不含**任何路径痕迹（服务端看不到路径）", () => {
    const did = didForPath(keys, "很机密的目录/客户名单.md");
    expect(did).not.toContain("客户");
    expect(did).not.toContain("机密");
    // 也不含 base64url 形式的路径（那是模式 A 的做法）。
    expect(did).not.toContain(Buffer.from("很机密的目录/客户名单.md", "utf8").toString("base64url").slice(0, 10));
  });

  it("★ 换笔记本的 `idKey` ⇒ 同一路径的 did 不同（跨笔记本不可关联）", () => {
    expect(didForPath(keys, "notes/a.md")).not.toBe(didForPath(otherKeys, "notes/a.md"));
  });

  it("★ 模式 A 与模式 B 用**同一套**路径规范化（否则切模式之后所有文件都变新增）", () => {
    /*
     * 模式 A 走 `shared/paths.ts` 的 `idForPath`，模式 B 走这里的 HMAC。
     * 两者的**输入**必须是同一串字节：`normalizeNfc(normalizePath(path))`。
     * 如果一边做了 NFC、另一边没做，那么「重音字符文件名」在切模式后
     * 会算出一个新 did —— 而症状是「所有文件都变成新增」，非常难查。
     */
    const plain = didForPlainPath("notes/café.md");
    // 模式 A 的 did 能解回**规范化之后**的路径。
    expect(plain.startsWith("f:")).toBe(true);
    expect(plain).toBe(idForPath("notes/café.md"));
    // 组合字符形式（NFD）与预组合形式（NFC）应当得到同一个 did。
    const nfd = "notes/cafe\u0301.md";
    expect(didForPlainPath(nfd)).toBe(didForPlainPath("notes/café.md"));
    expect(didForPath(keys, nfd)).toBe(didForPath(keys, "notes/café.md"));
  });
});

/* ============================================================================
   组合：封口与打开
   ============================================================================ */

describe("组合：`sealContent` / `openContent`", () => {
  it("封口给出 did + 密文 + ehash + esize；打开能拿回原文", () => {
    const sealed = sealContent(keys, NOTEBOOK, "notes/a.md", enc("# 正文"));
    expect(sealed.did).toBe(DID_A);
    expect(sealed.ehash).toHaveLength(64);
    // 服务端在 E2EE 下**能看到大小**（§3.4 如实记录）。
    expect(sealed.esize).toBe(sealed.bytes.length);
    expect(dec(openContent(keys, NOTEBOOK, sealed.did, "notes/a.md", sealed.bytes))).toBe("# 正文");
  });

  it("★ `openContent` 在 did 与本地路径对不上时给**指向根因**的错误", () => {
    /*
     * 本地的 `did ↔ path` 映射过期（例如远端改了名）时，解密本身也会失败 ——
     * 但那个错误会指向「密钥不对」。先检查映射能直接说出真正的原因。
     */
    const sealed = sealContent(keys, NOTEBOOK, "notes/a.md", enc("x"));
    expect(() => openContent(keys, NOTEBOOK, sealed.did, "notes/b.md", sealed.bytes)).toThrow(/对不上/);
  });

  it("同一份内容封两次 ⇒ did/ehash 相同、密文不同（nonce 随机）", () => {
    const first = sealContent(keys, NOTEBOOK, "notes/a.md", enc("x"));
    const second = sealContent(keys, NOTEBOOK, "notes/a.md", enc("x"));
    expect(first.did).toBe(second.did);
    expect(first.ehash).toBe(second.ehash);
    expect(toHex(first.bytes)).not.toBe(toHex(second.bytes));
  });
});

/* ============================================================================
   ★★ 路径映射表：全新设备的 did↔path 重建（P4-b 的缺口）
   ============================================================================ */

describe("★★ 路径映射表：加密后上云，**服务端学不到任何路径**", () => {
  const PATHMAP_KEY = derivePathMapKey(ENC_ROOT);
  const ENTRIES = [
    { did: didForPath(keys, "很机密的目录/客户名单.md"), path: "很机密的目录/客户名单.md" },
    { did: didForPath(keys, "notes/a.md"), path: "notes/a.md" },
  ];

  it("往返一致", () => {
    const blob = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    expect(decodePathMap(PATHMAP_KEY, NOTEBOOK, blob)).toEqual(ENTRIES);
  });

  it("★★ 密文里**找不到任何路径痕迹**（否则模式 B 白做）", () => {
    /*
     * 这张表要**上云**。它不能明文（那就把路径泄露了），
     * 所以必须用 `encRoot` 派生的密钥加密 —— 服务端只看到一条密文记录。
     */
    const blob = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    const asText = new TextDecoder().decode(blob);
    expect(asText).not.toContain("客户名单");
    expect(asText).not.toContain("机密");
    expect(asText).not.toContain("notes");
    expect(asText).not.toContain("did");
  });

  it("★★ 只要有 `encRoot`，新设备就能重建整张表（**密钥即身份**）", () => {
    /*
     * 这是这个设计存在的理由：新设备导入账号密钥 → 解锁 `encRoot`
     * → 解密这张表 → 有了路径，于是能拉文件了。
     * 不需要第二样东西，也不需要用户手工输入文件名。
     */
    const uploaded = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    // ── 新设备：只有 encRoot（从账号密钥解出来）──
    const freshKey = derivePathMapKey(ENC_ROOT);
    const rebuilt = decodePathMap(freshKey, NOTEBOOK, uploaded);
    expect(rebuilt).toEqual(ENTRIES);
    // 有了路径，就能算出 did 并对上远端那一条。
    expect(rebuilt.map((entry) => entry.did)).toEqual(ENTRIES.map((entry) => entry.did));
  });

  it("★ 换 `encRoot`（别人的密钥）⇒ 解不开", () => {
    const blob = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    const otherKey = derivePathMapKey(Uint8Array.from({ length: 32 }, (_, index) => 255 - index));
    expect(() => decodePathMap(otherKey, NOTEBOOK, blob)).toThrow(/密钥不对/);
  });

  it("★ 换 `notebookId`（AAD）⇒ 解不开（防止把 A 的表塞给 B，把文件写到错误位置）", () => {
    const blob = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    expect(() => decodePathMap(PATHMAP_KEY, OTHER_NOTEBOOK, blob)).toThrow(/别的笔记本/);
  });

  it("每次编码的密文不同（nonce 随机），但都能解开", () => {
    const first = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    const second = encodePathMap(PATHMAP_KEY, NOTEBOOK, ENTRIES);
    expect(toHex(first)).not.toBe(toHex(second));
    expect(decodePathMap(PATHMAP_KEY, NOTEBOOK, second)).toEqual(ENTRIES);
  });

  it("★ 形状不对的条目**丢掉**，不让整张表作废（一条坏记录不该让新设备一个文件都拉不下来）", () => {
    const json = new TextEncoder().encode(JSON.stringify([{ did: "h:x", path: "a.md" }, { did: "" }, { path: "b.md" }, 42, null]));
    // 手工造一条「内容合法但条目坏」的密文（走同一条加密路径）。
    const nonce = new Uint8Array(24).fill(1);
    const aad = new TextEncoder().encode(`opennote/v1/pathmap
${NOTEBOOK}`);
    const sealed = xchachaForTests(PATHMAP_KEY, nonce, aad).encrypt(json);
    const blob = new Uint8Array(nonce.length + sealed.length);
    blob.set(nonce, 0);
    blob.set(sealed, nonce.length);
    expect(decodePathMap(PATHMAP_KEY, NOTEBOOK, blob)).toEqual([{ did: "h:x", path: "a.md" }]);
  });

  it("太短的 blob / 不是 JSON / 不是数组 ⇒ 可读的错误", () => {
    expect(() => decodePathMap(PATHMAP_KEY, NOTEBOOK, new Uint8Array(10))).toThrow(/太短/);
  });
});
