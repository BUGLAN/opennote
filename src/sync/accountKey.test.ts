/**
 * 端到端加密密钥层级的用例（§3.9、§4.9、§10 U23）。
 *
 * ## 这个文件里最值钱的一组断言
 *
 * ### ① **测试向量**（U23 明确要求）
 *
 * - **HKDF-SHA256 用 [RFC 5869](https://www.rfc-editor.org/rfc/rfc5869) 的 TC1/TC2/TC3**；
 * - **XChaCha20-Poly1305 用 [draft-irtf-cfrg-xchacha](https://datatracker.ietf.org/doc/html/draft-irtf-cfrg-xchacha)
 *   的 A.3 向量**。
 *
 * 为什么必须有它们：自研密钥派生的 bug **不会让程序崩**，只会让密钥不一样 ——
 * 而症状是「密钥不对」。一组官方向量是唯一能把「算法用对了」与「恰好自己自洽」分开的东西。
 * （RFC 的期望值我用 Node 内置的 `hkdfSync` 独立复算过一遍才写进来，不是抄的。）
 *
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_ID_BYTES,
  accountIdBytes,
  deriveNotebookKey,
  deriveNotebookSubkey,
  fromBase64Url,
  fromHex,
  generateEncRoot,
  hkdfInfoNotebook,
  hkdfSha256ForTests,
  toBase64Url,
  toHex,
  unwrapEncRoot,
  wrapEncRoot,
  xchachaForTests,
} from "./accountKey";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): string => toHex(bytes);
const bytesOf = (value: string): Uint8Array => fromHex(value);

/** 固定的一组测试材料（不用随机，断言才能稳定）。 */
const ACCOUNT_ID = "00112233445566778899aabbccddeeff";
/** 一把固定的 wrapKey（生产里由加密口令 scrypt 出来，见 `vault.ts`）。 */
const WRAP_KEY = bytesOf("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
const ENC_ROOT = bytesOf("202122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f");

/* ============================================================================
   U23 · 测试向量
   ============================================================================ */

describe("U23 · HKDF-SHA256 对上 RFC 5869", () => {
  /*
   * 三个向量的期望值我用 Node 内置的 `crypto.hkdfSync` **独立复算**过，
   * 与 RFC 里印的值逐字节相同 —— 所以下面这些字符串是可信的基准，
   * 不是「跑一遍看输出是什么就抄下来」（那样写出来的用例只能证明自洽）。
   */
  it("TC1：基本情形（salt 与 info 都非空）", () => {
    const okm = hkdfSha256ForTests(bytesOf("0b".repeat(22)), bytesOf("000102030405060708090a0b0c"), bytesOf("f0f1f2f3f4f5f6f7f8f9"), 42);
    expect(okm).toHaveLength(42);
    expect(hex(okm)).toBe("3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865");
  });

  it("TC2：长输入（IKM / salt / info 各 80 字节，输出 82 字节）", () => {
    const ramp = (base: number, count: number): Uint8Array =>
      Uint8Array.from({ length: count }, (_, index) => (base + index) & 0xff);
    const okm = hkdfSha256ForTests(ramp(0x00, 80), ramp(0x60, 80), ramp(0xb0, 80), 82);
    expect(okm).toHaveLength(82);
    expect(hex(okm)).toBe(
      "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c" +
        "59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71" +
        "cc30c58179ec3e87c14c01d5c1f3434f1d87",
    );
  });

  it("TC3：salt 与 info 都为空", () => {
    const okm = hkdfSha256ForTests(bytesOf("0b".repeat(22)), new Uint8Array(0), new Uint8Array(0), 42);
    expect(hex(okm)).toBe("8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8");
  });

  it("★ 「不传 salt」与「传空 salt」必须等价（`deriveNotebookKey` 依赖这一条）", () => {
    /*
     * `deriveNotebookKey` 按 §3.9 的层级表**不传 salt**（那一行没写 salt）。
     * 而 HKDF 在 salt 缺省时按 RFC 5869 §2.2 用 `HashLen` 个零；传空数组时 HMAC 会把
     * 空 key 补成全零的块 —— 两者应当相同。
     *
     * 钉住它是因为将来有人「顺手加个 salt」时，症状会是「笔记本密钥对不上」，
     * 而那条线索离「有人改了 salt」很远。
     */
    const ikm = bytesOf("0b".repeat(22));
    const info = enc("opennote/v1/notebook/x");
    expect(hex(hkdfSha256ForTests(ikm, undefined, info, 32))).toBe(hex(hkdfSha256ForTests(ikm, new Uint8Array(0), info, 32)));
  });
});

describe("U23 · XChaCha20-Poly1305 对上 draft-irtf-cfrg-xchacha A.3", () => {
  it("加解密与官方向量逐字节相同", () => {
    const key = Uint8Array.from({ length: 32 }, (_, index) => 0x80 + index);
    const nonce = Uint8Array.from({ length: 24 }, (_, index) => 0x40 + index);
    const aad = bytesOf("50515253c0c1c2c3c4c5c6c7");
    const plaintext = enc("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.");

    const cipher = xchachaForTests(key, nonce, aad);
    const ciphertext = cipher.encrypt(plaintext);
    // 期望值 = draft 的密文 ‖ Poly1305 tag。
    expect(hex(ciphertext)).toBe(
      "bd6d179d3e83d43b9576579493c0e939572a1700252bfaccbed2902c21396cbb" +
        "731c7f1b0b4aa6440bf3a82f4eda7e39ae64c6708c54c216cb96b72e1213b452" +
        "2f8c9ba40db5d945b11b69b982c1bb9e3f3fac2bc369488f76b2383565d3fff9" +
        "21f9664c97637da9768812f615c68b13b52e" +
        "c0875924c1c7987947deafd8780acf49",
    );
    // 解回来必须一模一样。
    expect(hex(cipher.decrypt(ciphertext))).toBe(hex(plaintext));
  });

  it("AAD 被改动 ⇒ 解不开（`did` / `notebookId` 绑定靠它）", () => {
    const key = new Uint8Array(32).fill(7);
    const nonce = new Uint8Array(24).fill(9);
    const sealed = xchachaForTests(key, nonce, enc("did-A")).encrypt(enc("正文"));
    expect(() => xchachaForTests(key, nonce, enc("did-B")).decrypt(sealed)).toThrow();
  });
});

/* ============================================================================
   ★ @noble ↔ WebCrypto：控制台只能用后者，两者必须逐字节相同
   ============================================================================ */


/* ============================================================================
   密钥层级的不变量
   ============================================================================ */

describe("§1.5 · 密钥层级：分叉必须真的分叉", () => {
  it("info 字符串按版本前缀分开（改一个字就是另一把钥匙）", () => {
    expect(hkdfInfoNotebook("nb-1")).toBe("opennote/v1/notebook/nb-1");
  });

  it("每笔记本一把钥匙：`notebookId` 不同 ⇒ `notebookKey` 不同", () => {
    expect(hex(deriveNotebookKey(ENC_ROOT, "nb-1"))).not.toBe(hex(deriveNotebookKey(ENC_ROOT, "nb-2")));
  });

  it("`notebookKey` 的三个分叉互不相同（enc / mac / id）", () => {
    const notebookKey = deriveNotebookKey(ENC_ROOT, "nb-1");
    const subkeys = (["enc", "mac", "id"] as const).map((usage) => hex(deriveNotebookSubkey(notebookKey, usage)));
    expect(new Set(subkeys).size).toBe(3);
  });

  it("生成的是 CSPRNG（两次调用不相同，长度正确）", () => {
    expect(generateEncRoot()).toHaveLength(32);
    expect(hex(generateEncRoot())).not.toBe(hex(generateEncRoot()));
  });

  it("`accountIdBytes` 严格校验（长度不对就抛，**不**静默截断）", () => {
    expect(accountIdBytes(ACCOUNT_ID)).toHaveLength(ACCOUNT_ID_BYTES);
    expect(() => accountIdBytes("abcd")).toThrow(/16 字节/);
    expect(() => accountIdBytes(`${ACCOUNT_ID}00`)).toThrow(/16 字节/);
  });
});

describe("十六进制 / base64url 编解码", () => {
  it("往返一致；`toHex` 只出小写", () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255]);
    expect(toHex(bytes)).toBe("00010f107f80ff");
    expect(hex(fromHex("00010f107f80ff"))).toBe("00010f107f80ff");
    expect(toBase64Url(bytes)).toBe("AAEPEH-A_w");
    expect(hex(fromBase64Url("AAEPEH-A_w"))).toBe("00010f107f80ff");
  });

  it("`fromHex` **拒绝大写**（同一个 id 两种写法 ⇒ 两把密钥 ⇒ 极难查的「对不上」）", () => {
    expect(() => fromHex("ABCD")).toThrow(/小写十六进制/);
    expect(() => fromHex("abc")).toThrow(/小写十六进制/);
    expect(() => fromHex("zz")).toThrow(/小写十六进制/);
  });
});

/* ============================================================================
   `encRoot` 的包裹与解开
   ============================================================================ */

describe("§3.9 · `wrappedEncRoot`：AAD 绑 `accountId`（防跨账号替换）", () => {
  it("往返一致", () => {
    const wrapKey = WRAP_KEY;
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    expect(hex(unwrapEncRoot(wrapKey, wrapped, ACCOUNT_ID))).toBe(hex(ENC_ROOT));
  });

  it("每次包裹的密文**都不同**（nonce 随机），但都能解开", () => {
    const wrapKey = WRAP_KEY;
    const first = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    const second = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    expect(first).not.toBe(second);
    expect(hex(unwrapEncRoot(wrapKey, second, ACCOUNT_ID))).toBe(hex(ENC_ROOT));
  });

  it("★ 换一个 `accountId` 当 AAD ⇒ 解不开（这就是「防跨账号替换」）", () => {
    /*
     * 攻击场景：把 B 的 `wrappedEncRoot` 塞给 A 的账号记录。
     * 不绑 AAD 的话，A 会解出 **B 的 encRoot** —— 它不会报错，只会「打开别人的笔记本」
     * （或者更糟：把自己以后写的内容加密成 B 能读的）。绑了 AAD 之后直接解不开。
     */
    const wrapKey = WRAP_KEY;
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    const otherId = "ffffffffffffffffffffffffffffffff";
    expect(() => unwrapEncRoot(wrapKey, wrapped, otherId)).toThrow(/解不开/);
  });

  it("换一把 `wrapKey` ⇒ 解不开", () => {
    const wrapped = wrapEncRoot(WRAP_KEY, ENC_ROOT, ACCOUNT_ID);
    const otherKey = generateEncRoot();
    expect(() => unwrapEncRoot(otherKey, wrapped, ACCOUNT_ID)).toThrow(/解不开/);
  });

  it("包裹被改动一个字节 ⇒ 解不开（认证标签在起作用）", () => {
    const wrapKey = WRAP_KEY;
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    const bytes = fromBase64Url(wrapped);
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => unwrapEncRoot(wrapKey, toBase64Url(bytes), ACCOUNT_ID)).toThrow(/解不开/);
  });

  it("形状不对的包裹给**可读**的错误（不是 `invalid tag`）", () => {
    const wrapKey = WRAP_KEY;
    expect(() => unwrapEncRoot(wrapKey, "!!not-base64!!", ACCOUNT_ID)).toThrow(/base64url/);
    expect(() => unwrapEncRoot(wrapKey, toBase64Url(new Uint8Array(10)), ACCOUNT_ID)).toThrow(/太短/);
  });
});

/* ============================================================================
   密钥导出 / 导入（为二维码优化）
   ============================================================================ */


/* ============================================================================
   组合流程
   ============================================================================ */

