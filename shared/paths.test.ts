/**
 * `shared/paths.ts` 的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §3.3、§3.8、§10.1 C9/C10）。
 *
 * 这里钉住的是**两侧行为必须逐字节一致**的那部分：NFC 归一、base64url 文档标识、
 * 路径安全校验、大小写折叠检测。服务端与客户端 import 的是同一个文件，
 * 所以这些断言同时就是「两端一致」的证明（单仓的直接好处，§1.6）。
 */
import { describe, expect, it } from "vitest";
import {
  assertSafeRelative,
  base64urlDecode,
  base64urlEncode,
  findCaseFoldCollisions,
  foldCaseKey,
  idForPath,
  isCanvasPath,
  isHiddenPath,
  isMaterializable,
  isValidPathDocId,
  normalizeNfc,
  normalizePath,
  pathFromLegacyId,
  utf8Decode,
  utf8Encode,
} from "./paths";

describe("normalizePath", () => {
  it("统一分隔符、丢掉空段与 `.`、解析 `..`", () => {
    expect(normalizePath("notes\\a.md")).toBe("notes/a.md");
    expect(normalizePath("./notes//a.md")).toBe("notes/a.md");
    expect(normalizePath("notes/sub/../a.md")).toBe("notes/a.md");
    expect(normalizePath("")).toBe("");
    expect(normalizePath("/")).toBe("");
  });

  it("段首尾空白被丢掉，段内部的空格保留（既有行为，代价如实记下）", () => {
    // 段内部：保留（"my notes" 是一个目录名）。
    expect(normalizePath("my notes/a.md")).toBe("my notes/a.md");
    // 段首尾：丢掉。代价是 `" a.md"` 与 `"a.md"` 会被当成同一篇 —— 这是刻意的
    // （用户输入与粘贴来的路径常带空白；Windows 与 HFS+ 本来也会静默剥掉）。
    expect(normalizePath(" a.md")).toBe("a.md");
    expect(normalizePath("notes /a.md ")).toBe("notes/a.md");
  });
});

describe("assertSafeRelative（模式 A 的第一道防线）", () => {
  it("C9 · 拒绝绝对路径 / 越界 / 冒号 / 空字节", () => {
    expect(() => assertSafeRelative("/abs/x.md")).toThrow(/绝对路径/);
    expect(() => assertSafeRelative("C:/abs/x.md")).toThrow(/绝对路径/);
    expect(() => assertSafeRelative("../x.md")).toThrow(/越界/);
    expect(() => assertSafeRelative("a/../../x.md")).toThrow(/越界/);
    expect(() => assertSafeRelative("a.md:secret")).toThrow(/冒号/);
    expect(() => assertSafeRelative("a\0b.md")).toThrow(/非法字符/);
  });

  it("C9 · 放行合法相对路径，并归一成 POSIX 形态", () => {
    expect(assertSafeRelative("notes/a.md")).toBe("notes/a.md");
    expect(assertSafeRelative("notes\\sub\\a.md")).toBe("notes/sub/a.md");
    expect(assertSafeRelative("./a.md")).toBe("a.md");
  });

  it("`a..b.md` 放行（不能用 indexOf('..') 这类粗暴判断）", () => {
    expect(assertSafeRelative("a..b.md")).toBe("a..b.md");
    expect(assertSafeRelative("notes/a..b.md")).toBe("notes/a..b.md");
    expect(assertSafeRelative("..md")).toBe("..md");
  });
});

describe("utf8 与 base64url（自己实现，四端逐字节一致）", () => {
  it("往返：ASCII / CJK / emoji / 组合字符", () => {
    for (const text of ["", "a", "notes/a.md", "notes/读书笔记.md", "📓/笔记.md", "é", "e\u0301", "𝔘𝔫𝔦"]) {
      expect(utf8Decode(utf8Encode(text))).toBe(text);
      expect(base64urlDecode(base64urlEncode(utf8Encode(text)))).toEqual(utf8Encode(text));
    }
  });

  it("UTF-8 结果与已知字节一致（不是「能往返」就算数）", () => {
    // 「读」= E8 AF BB；用来防止自实现把码点算错却仍然自洽。
    expect([...utf8Encode("读")]).toEqual([0xe8, 0xaf, 0xbb]);
    expect([...utf8Encode("📓")]).toEqual([0xf0, 0x9f, 0x93, 0x93]);
    expect(utf8Decode(Uint8Array.from([0xe8, 0xaf, 0xbb]))).toBe("读");
  });

  it("base64url 不含 `+` `/` `=`（要进 URL 与文档 id）", () => {
    // 造一段会产出 `+` 与 `/` 的标准 base64 字节。
    const bytes = Uint8Array.from([0xfb, 0xff, 0xbf, 0x00, 0xff]);
    const encoded = base64urlEncode(bytes);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(base64urlDecode(encoded)).toEqual(bytes);
  });

  it("非法输入明确报错，不静默产出垃圾", () => {
    expect(() => base64urlDecode("a*b")).toThrow(/base64url/);
    expect(() => utf8Decode(Uint8Array.from([0xff]))).toThrow(/UTF-8/);
    expect(() => utf8Decode(Uint8Array.from([0xc3]))).toThrow(/截断/);
  });
});

describe("文档标识 idForPath / pathFromLegacyId", () => {
  it("C10 · NFC 与 NFD 写法得到**同一个**文档（这是这条的全部意义）", () => {
    const nfc = "notes/\u00e9.md"; // é
    const nfd = "notes/e\u0301.md"; // e + 组合尖音符
    expect(nfc).not.toBe(nfd); // 字节不同……
    expect(idForPath(nfc)).toBe(idForPath(nfd)); // ……文档标识相同
    expect(normalizeNfc(nfd)).toBe(nfc);
  });

  it("内部先归一，所以 `notes\\a.md` 与 `notes/a.md` 是同一篇", () => {
    expect(idForPath("notes\\a.md")).toBe(idForPath("notes/a.md"));
  });

  it("前缀是 `f:`（模式 A），且逆运算能解回归一后的路径", () => {
    const id = idForPath("notes/读书笔记.md");
    expect(id.startsWith("f:")).toBe(true);
    expect(pathFromLegacyId(id)).toBe("notes/读书笔记.md");
    expect(isValidPathDocId(id)).toBe(true);
  });

  it("逆运算返回的是**归一后**的路径（非规范写法会被规范化，这是有意的）", () => {
    // 输入带 `.` 与反斜杠；存进去的那一份就是规范形态。
    expect(pathFromLegacyId(idForPath("./notes\\a.md"))).toBe("notes/a.md");
  });

  it("形状校验挡住前缀不对 / 字符集不对 / 解回来不安全的 id", () => {
    expect(isValidPathDocId("h:abc")).toBe(false);
    expect(isValidPathDocId("f:")).toBe(false);
    expect(isValidPathDocId("f:not base64url!")).toBe(false);
    expect(isValidPathDocId(idForPath("a.md"))).toBe(true);
  });

  it("pathFromLegacyId 对非 `f:` 前缀抛错（不要静默返回空串）", () => {
    expect(() => pathFromLegacyId("h:deadbeef")).toThrow(/模式 A/);
  });
});

describe("大小写折叠（只检测，不改名）", () => {
  it("找出折叠后相同的路径", () => {
    const collisions = findCaseFoldCollisions(["README.md", "readme.md", "notes/a.md"]);
    expect(collisions).toHaveLength(1);
    expect(collisions[0]!.key).toBe("readme.md");
    expect([collisions[0]!.a, collisions[0]!.b].sort()).toEqual(["README.md", "readme.md"]);
  });

  it("同一条路径重复出现不算冲突", () => {
    expect(findCaseFoldCollisions(["a.md", "a.md"])).toHaveLength(0);
  });

  it("foldCaseKey 只做小写与归一，不做别的", () => {
    expect(foldCaseKey("Notes\\A.MD")).toBe("notes/a.md");
  });
});

describe("isCanvasPath / isMaterializable（画布进物化判据，同步与导入共用）", () => {
  it("`.canvas` 是画布：大小写不敏感，别的扩展名不是", () => {
    expect(isCanvasPath("看板.canvas")).toBe(true);
    expect(isCanvasPath("读书/看板.canvas")).toBe(true);
    expect(isCanvasPath("看板.CANVAS")).toBe(true); // 与 md/图片判据同款大小写不敏感
    expect(isCanvasPath("看板.canvasx")).toBe(false);
    expect(isCanvasPath("看板.md")).toBe(false);
    expect(isCanvasPath(".canvas")).toBe(true); // 扩展名判据只看结尾，与 isMarkdownPath(".md") 同款
  });

  it("isMaterializable 认笔记、图片与画布；源码/配置仍不落地", () => {
    expect(isMaterializable("notes/a.md")).toBe(true);
    expect(isMaterializable("assets/pic.png")).toBe(true);
    expect(isMaterializable("notes/看板.canvas")).toBe(true);
    // 曾经的缺口（docs/canvas/00 §7.2）：画布推得上去、拉不下来，就是因为这里不认它
    expect(isMaterializable("src/main.ts")).toBe(false);
    expect(isMaterializable("package.json")).toBe(false);
    expect(isMaterializable("看布.canvasbak")).toBe(false);
  });
});

describe("isHiddenPath（`.opennote/` 一族的判据来源）", () => {
  it("任何一段以 `.` 开头就算隐藏", () => {
    expect(isHiddenPath(".opennote/state.json")).toBe(true);
    expect(isHiddenPath("notes/.hidden.md")).toBe(true);
    expect(isHiddenPath(".gitignore")).toBe(true);
    expect(isHiddenPath("notes/a.md")).toBe(false);
    expect(isHiddenPath(".opennote.md")).toBe(true); // 以 . 开头的文件名也是隐藏
  });
});
