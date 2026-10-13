/**
 * 账号密钥的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.5、§3.9、§4.9、§10 U23）。
 *
 * ## 这个文件里最值钱的两组断言
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
 * ### ② **@noble 与 WebCrypto 必须算出同一串字节**
 *
 * 控制台（`server/src/panel/app.js`）是「无构建步骤」的静态页，**没法 import noble**，
 * 只能用 WebCrypto。而 §3.9/§4.9 选 noble 的理由是「四端同一条代码路径」——
 * 控制台是那条路上的例外，所以**必须逐参数对齐**并在这里直接比对字节。
 *
 * 光靠「它们应该一致」是不够的：HKDF 的 salt / info 差一个字就是完全不同的密钥，
 * 而症状会是「密钥输错了」—— 一个会把人引到错方向（去怀疑用户）的报错。
 */
import { describe, expect, it } from "vitest";
import {
  ACCOUNT_KEY_BYTES,
  ACCOUNT_KEY_PREFIX,
  ACCOUNT_ID_BYTES,
  HKDF_INFO_AUTH,
  HKDF_INFO_WRAP,
  accountIdBytes,
  createRegistrationMaterial,
  decodeAccountKey,
  deriveAuthToken,
  deriveFromAccountKey,
  deriveNotebookKey,
  deriveNotebookSubkey,
  deriveWrapKey,
  encodeAccountKey,
  fromBase64Url,
  fromHex,
  generateAccountId,
  generateAccountKey,
  generateEncRoot,
  hkdfInfoNotebook,
  hkdfSha256ForTests,
  toBase64Url,
  toHex,
  unlockEncRoot,
  unwrapEncRoot,
  wrapEncRoot,
  xchachaForTests,
} from "./accountKey";

const enc = (text: string): Uint8Array => new TextEncoder().encode(text);
const hex = (bytes: Uint8Array): string => toHex(bytes);
const bytesOf = (value: string): Uint8Array => fromHex(value);

/** 固定的一组测试材料（不用随机，断言才能稳定）。 */
const ACCOUNT_ID = "00112233445566778899aabbccddeeff";
const ACCOUNT_KEY = bytesOf("000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f");
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

describe("★ @noble 与 WebCrypto 算出同一串字节（控制台依赖这一条）", () => {
  /** WebCrypto 版的 HKDF-SHA256（与 `server/src/panel/app.js` 里那段等价）。 */
  async function webcryptoHkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
    const base = await crypto.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, ["deriveBits"]);
    const bits = await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: salt as BufferSource, info: info as BufferSource },
      base,
      length * 8,
    );
    return new Uint8Array(bits);
  }

  it("`authToken` 的派生：noble 与 WebCrypto 结果相同", async () => {
    const noble = deriveAuthToken(ACCOUNT_KEY, ACCOUNT_ID);
    const viaWeb = toHex(await webcryptoHkdf(ACCOUNT_KEY, accountIdBytes(ACCOUNT_ID), enc(HKDF_INFO_AUTH), 32));
    expect(viaWeb).toBe(noble);
  });

  it("`wrapKey` 的派生：noble 与 WebCrypto 结果相同", async () => {
    const noble = hex(deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID));
    const viaWeb = hex(await webcryptoHkdf(ACCOUNT_KEY, accountIdBytes(ACCOUNT_ID), enc(HKDF_INFO_WRAP), 32));
    expect(viaWeb).toBe(noble);
  });

  it("`notebookKey`（**无 salt**）在 WebCrypto 里也要用空 salt 才一致", async () => {
    const noble = hex(deriveNotebookKey(ENC_ROOT, "nb-1"));
    const viaWeb = hex(await webcryptoHkdf(ENC_ROOT, new Uint8Array(0), enc(hkdfInfoNotebook("nb-1")), 32));
    expect(viaWeb).toBe(noble);
  });

  it("★ 反证：salt 用错（拿十六进制字符串的 ASCII 当 salt）会得到**完全不同**的令牌", async () => {
    /*
     * 这条是给未来的人看的：`accountId` 是「16B 随机」，十六进制只是它的**传输**表示。
     * 如果哪个实现把 ASCII 的 `"00112233…"` 当 salt，它算出来的令牌与别人**完全不同**，
     * 而症状是「密钥不对」。所以这个坑值得有一条用例明确地画出来。
     */
    const correct = deriveAuthToken(ACCOUNT_KEY, ACCOUNT_ID);
    const wrong = toHex(await webcryptoHkdf(ACCOUNT_KEY, enc(ACCOUNT_ID), enc(HKDF_INFO_AUTH), 32));
    expect(wrong).not.toBe(correct);
  });
});

/* ============================================================================
   密钥层级的不变量
   ============================================================================ */

describe("§1.5 · 密钥层级：分叉必须真的分叉", () => {
  it("`authToken` 与 `wrapKey` 是**两把不同的东西**（E2EE 成立的前提）", () => {
    const authToken = deriveAuthToken(ACCOUNT_KEY, ACCOUNT_ID);
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
    // 一个是 hex 字符串、一个是 32 字节；把 wrapKey 也写成 hex 来比「值」。
    expect(hex(wrapKey)).not.toBe(authToken);
    expect(authToken).toHaveLength(64);
    expect(wrapKey).toHaveLength(32);
  });

  it("info 字符串不同 ⇒ 输出不同（改一个字就是另一把钥匙）", () => {
    expect(HKDF_INFO_AUTH).not.toBe(HKDF_INFO_WRAP);
    expect(HKDF_INFO_AUTH.startsWith("opennote/v1/")).toBe(true);
    expect(HKDF_INFO_WRAP.startsWith("opennote/v1/")).toBe(true);
    expect(hkdfInfoNotebook("nb-1")).toBe("opennote/v1/notebook/nb-1");
  });

  it("**salt 参与派生**：换一个 `accountId`，同一把 `accountKey` 得到不同令牌", () => {
    const other = "ffffffffffffffffffffffffffffffff";
    expect(deriveAuthToken(ACCOUNT_KEY, other)).not.toBe(deriveAuthToken(ACCOUNT_KEY, ACCOUNT_ID));
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
    expect(generateAccountId()).toMatch(/^[0-9a-f]{32}$/);
    expect(generateAccountId()).not.toBe(generateAccountId());
    expect(generateAccountKey()).toHaveLength(ACCOUNT_KEY_BYTES);
    expect(generateEncRoot()).toHaveLength(32);
    expect(hex(generateAccountKey())).not.toBe(hex(generateAccountKey()));
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
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    expect(hex(unwrapEncRoot(wrapKey, wrapped, ACCOUNT_ID))).toBe(hex(ENC_ROOT));
  });

  it("每次包裹的密文**都不同**（nonce 随机），但都能解开", () => {
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
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
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    const otherId = "ffffffffffffffffffffffffffffffff";
    expect(() => unwrapEncRoot(wrapKey, wrapped, otherId)).toThrow(/解不开/);
  });

  it("换一把 `wrapKey` ⇒ 解不开", () => {
    const wrapped = wrapEncRoot(deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID), ENC_ROOT, ACCOUNT_ID);
    const otherKey = deriveWrapKey(generateAccountKey(), ACCOUNT_ID);
    expect(() => unwrapEncRoot(otherKey, wrapped, ACCOUNT_ID)).toThrow(/解不开/);
  });

  it("包裹被改动一个字节 ⇒ 解不开（认证标签在起作用）", () => {
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
    const wrapped = wrapEncRoot(wrapKey, ENC_ROOT, ACCOUNT_ID);
    const bytes = fromBase64Url(wrapped);
    bytes[bytes.length - 1] ^= 0x01;
    expect(() => unwrapEncRoot(wrapKey, toBase64Url(bytes), ACCOUNT_ID)).toThrow(/解不开/);
  });

  it("形状不对的包裹给**可读**的错误（不是 `invalid tag`）", () => {
    const wrapKey = deriveWrapKey(ACCOUNT_KEY, ACCOUNT_ID);
    expect(() => unwrapEncRoot(wrapKey, "!!not-base64!!", ACCOUNT_ID)).toThrow(/base64url/);
    expect(() => unwrapEncRoot(wrapKey, toBase64Url(new Uint8Array(10)), ACCOUNT_ID)).toThrow(/太短/);
  });
});

/* ============================================================================
   密钥导出 / 导入（为二维码优化）
   ============================================================================ */

describe("§5.2 · 账号密钥的编解码（紧凑二进制，为二维码优化）", () => {
  it("往返一致", () => {
    const text = encodeAccountKey({ accountId: ACCOUNT_ID, accountKey: ACCOUNT_KEY });
    const back = decodeAccountKey(text);
    expect(back.accountId).toBe(ACCOUNT_ID);
    expect(hex(back.accountKey)).toBe(hex(ACCOUNT_KEY));
  });

  it("★ 紧凑到能塞进二维码：49 字节 → 66 个 base64url 字符", () => {
    /*
     * §5.2 要求支持二维码。JSON 会把 49 字节膨胀到 150+ 字符；
     * 紧凑二进制 base64url 后是 66 字符 —— 二维码能小一大圈，也更不容易扫错。
     */
    const text = encodeAccountKey({ accountId: ACCOUNT_ID, accountKey: ACCOUNT_KEY });
    const body = text.slice(ACCOUNT_KEY_PREFIX.length);
    expect(fromBase64Url(body)).toHaveLength(49);
    expect(body).toHaveLength(66);
    expect(text.startsWith(ACCOUNT_KEY_PREFIX)).toBe(true);
  });

  it("容忍前后空白与**没有前缀**（用户常常只复制了后半截）", () => {
    const text = encodeAccountKey({ accountId: ACCOUNT_ID, accountKey: ACCOUNT_KEY });
    const body = text.slice(ACCOUNT_KEY_PREFIX.length);
    expect(decodeAccountKey(`  ${text}\n`).accountId).toBe(ACCOUNT_ID);
    expect(decodeAccountKey(body).accountId).toBe(ACCOUNT_ID);
  });

  it("**不容忍**版本不对 / 长度不对（那会导致「派生出错误的密钥」）", () => {
    const text = encodeAccountKey({ accountId: ACCOUNT_ID, accountKey: ACCOUNT_KEY });
    const blob = fromBase64Url(text.slice(ACCOUNT_KEY_PREFIX.length));

    const wrongVersion = new Uint8Array(blob);
    wrongVersion[0] = 9;
    expect(() => decodeAccountKey(ACCOUNT_KEY_PREFIX + toBase64Url(wrongVersion))).toThrow(/版本/);

    expect(() => decodeAccountKey(ACCOUNT_KEY_PREFIX + toBase64Url(blob.slice(0, 40)))).toThrow(/长度不对/);
    expect(() => decodeAccountKey("")).toThrow(/空的/);
    expect(() => decodeAccountKey("!!!!")).toThrow(/base64url/);
  });

  it("`accountKey` 长度不对时**编码**就拒绝（不要产出坏 blob）", () => {
    expect(() => encodeAccountKey({ accountId: ACCOUNT_ID, accountKey: new Uint8Array(16) })).toThrow(/32 字节/);
  });
});

/* ============================================================================
   组合流程
   ============================================================================ */

describe("§1.5 · 注册与解锁的组合流程", () => {
  it("注册材料**自洽**：令牌能派出来、包裹能解开", () => {
    const material = createRegistrationMaterial();
    expect(material.accountId).toMatch(/^[0-9a-f]{32}$/);
    expect(material.authToken).toHaveLength(64);

    // 用同一份 accountKey 重新派生，必须得到同一个令牌（否则「新设备」永远进不去）。
    const derived = deriveFromAccountKey({ accountId: material.accountId, accountKey: material.accountKey });
    expect(derived.authToken).toBe(material.authToken);
    // 用 wrapKey 解开包裹，必须拿回同一个 encRoot。
    expect(hex(unlockEncRoot({ accountId: material.accountId, accountKey: material.accountKey }, material.wrappedEncRoot))).toBe(hex(material.encRoot));
  });

  it("两次注册得到完全不同的材料（CSPRNG）", () => {
    const a = createRegistrationMaterial();
    const b = createRegistrationMaterial();
    expect(a.accountId).not.toBe(b.accountId);
    expect(a.authToken).not.toBe(b.authToken);
    expect(a.wrappedEncRoot).not.toBe(b.wrappedEncRoot);
  });

  it("★ 密钥导出 → 导入 → 解锁：**一个秘密搞定**（§1.5 流程②）", () => {
    /*
     * 这条把「新设备」的整条路走一遍：只有那串导出的文本，没有别的东西。
     * `accountId` 必须在导出的 blob 里 —— 它是 `authToken` 的派生 salt，
     * 少了它新设备就算拿到 `accountKey` 也派不出令牌。
     */
    const registered = createRegistrationMaterial();
    const exported = encodeAccountKey({ accountId: registered.accountId, accountKey: registered.accountKey });

    // ── 新设备：只有这串文本 ──
    const imported = decodeAccountKey(exported);
    const { authToken } = deriveFromAccountKey(imported);
    expect(authToken).toBe(registered.authToken);
    // 服务端凭这个令牌返回 wrappedEncRoot，客户端解开：
    expect(hex(unlockEncRoot(imported, registered.wrappedEncRoot))).toBe(hex(registered.encRoot));
  });

  it("错的密钥解不开别人的包裹（给出可读的错，而不是静默拿到错的 encRoot）", () => {
    const alice = createRegistrationMaterial();
    const bob = createRegistrationMaterial();
    expect(() => unlockEncRoot({ accountId: bob.accountId, accountKey: bob.accountKey }, alice.wrappedEncRoot)).toThrow();
  });
});
