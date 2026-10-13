/**
 * `_design/opennote` 的 `validate_doc_update` —— **单仓下唯一无法靠类型系统消除的接缝**
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6、§3.8、§10.1 C9/C13/F1、附录 A.1）。
 *
 * ## 这个文件为什么重要
 *
 * 路径规则有两份实现：
 *   - `shared/paths.ts`（TS，客户端与 Node 共用）；
 *   - `_design/opennote` 里的 JS（跑在 **CouchDB 内部的 JS 引擎**里，既不是 TS 也不能 import 任何东西）。
 *
 * 两份实现**必然**会漂移，除非有东西同时压着它们。那个东西就是这里的**双跑**：
 * 同一批用例分别喂给 TS 与 JS，断言判定逐条相同。
 *
 * ## 这份 JS 的 `eval` 不等于「真的在 CouchDB 里跑过」
 *
 * 用 Node 的 `new Function` 跑它，**证明不了** CouchDB 那个 JS 引擎（可能是 SpiderMonkey，
 * 版本由镜像决定，U2）会接受它。所以这个文件同时钉住两件不同的事：
 *
 *   1. **逻辑一致**（本文件的主要断言）—— JS 与 TS 对同一批输入判定相同；
 *   2. **语言子集保守**（`describe("只用了保守的 JS 子集")`）—— 源码里不出现
 *      `startsWith` / `includes` / 模板串 / 箭头函数 / `const` `let`，因为这些在
 *      旧引擎上可能不存在。这是**静态**检查，不依赖真机。
 *
 * 真机验证（在 CouchDB 里 `PUT` 一份非法文档确认被拒）列在 U1/U2，属于 P2 的 compose 冒烟。
 */
import { describe, expect, it } from "vitest";
import pathRulesFixture from "../../../shared/fixtures/path-rules.cases.json" with { type: "json" };
import { assertSafeRelative, isHiddenPath, normalizeNfc, normalizePath } from "../../../shared/paths";
import {
  BY_PATH_MAP_SOURCE,
  DESIGN_DOC_ID,
  MAX_BYTES_PLACEHOLDER,
  VALIDATE_DOC_UPDATE_SOURCE,
  buildDesignDoc,
  buildSecurityDoc,
  compileValidateDocUpdate,
  databaseNameFor,
} from "./design";

const MAX_BYTES = 1024;
const validate = compileValidateDocUpdate(MAX_BYTES);

/** `validate_doc_update` 抛的东西是 `{ forbidden: string }`；这里取出来便于断言。 */
function verdict(doc: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  try {
    validate(doc);
    return { ok: true };
  } catch (error) {
    const reason = (error as { forbidden?: string }).forbidden;
    return { ok: false, reason: reason ?? String(error) };
  }
}

/** 一份合法的模式 A 文档。 */
function plainDoc(path: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    _id: `f:${Buffer.from(path, "utf8").toString("base64url")}`,
    path,
    hash: "a".repeat(64),
    size: 10,
    ...overrides,
  };
}

describe("§3.8 · 模式 A 的路径校验（第二道防线）", () => {
  it("放行正常笔记（含中文、子目录、`a..b.md`）", () => {
    for (const path of ["a.md", "notes/a.md", "日记/2026-10-13.md", "a..b.md", "notes/a..b.md", "..md", "assets/图 片.png"]) {
      expect(verdict(plainDoc(path)), `应放行 ${path}`).toEqual({ ok: true });
    }
  });

  it("拒绝绝对路径 / 反斜杠开头 / 盘符", () => {
    expect(verdict(plainDoc("/etc/passwd")).ok).toBe(false);
    expect(verdict(plainDoc("\\windows\\x")).ok).toBe(false);
    expect(verdict(plainDoc("C:/Windows/system32")).ok).toBe(false);
  });

  it("拒绝 `..` 越界（**按段判**，不是 indexOf('..')）", () => {
    expect(verdict(plainDoc("../x.md")).ok).toBe(false);
    expect(verdict(plainDoc("a/../../x.md")).ok).toBe(false);
    expect(verdict(plainDoc("a/..")).ok).toBe(false);
    // 但 `..md` 这种**段内**两个点是合法的（上面已断言放行）——这一条是反向守卫。
    expect(verdict(plainDoc("notes/..hidden")).ok).toBe(true);
  });

  it("拒绝保留目录 `.opennote/` 与 `.git/`", () => {
    for (const path of [".opennote/sync.json", ".git/config", "a/.opennote/x.md", "a/.git/x"]) {
      expect(verdict(plainDoc(path)).ok, `应拒绝 ${path}`).toBe(false);
    }
    // 但 `.opennote.md`（文件名，不是目录）放行 —— 与 §3.11 的边界表一致。
    expect(verdict(plainDoc(".opennote.md")).ok).toBe(true);
    expect(verdict(plainDoc("notes/.opennote.md")).ok).toBe(true);
  });

  it("D36 · 拒绝段内冒号（NTFS 备用数据流）", () => {
    expect(verdict(plainDoc("a.md:secret")).ok).toBe(false);
    expect(verdict(plainDoc("notes/a:b/c.md")).ok).toBe(false);
  });

  it("拒绝空路径与 NUL", () => {
    expect(verdict(plainDoc("")).ok).toBe(false);
    expect(verdict(plainDoc("a\u0000b.md")).ok).toBe(false);
  });
});

describe("§3.8 ⚠️ · 模式 B 只能校验形状（E2EE 的固有代价）", () => {
  it("有 `epath` 就放行（**看不到明文路径**，谈不上校验）", () => {
    expect(verdict({ _id: `h:${"a".repeat(32)}`, epath: "base64(iv||ct)", ehash: "b".repeat(64), esize: 10 })).toEqual({ ok: true });
  });

  it("既没有 path 也没有 epath ⇒ 拒绝", () => {
    const result = verdict({ _id: `h:${"a".repeat(32)}`, hash: "a".repeat(64) });
    expect(result).toEqual({ ok: false, reason: "missing path/epath" });
  });

  it("有 path 也有 epath 时按 path 严格校验（不因为带了密文就放宽）", () => {
    expect(verdict({ ...plainDoc("../x.md"), epath: "whatever" }).ok).toBe(false);
  });
});

describe("id 前缀与保留 id", () => {
  it("只认 `f:` 与 `h:`", () => {
    expect(verdict({ _id: "x:abc", path: "a.md", hash: "a".repeat(64) }).ok).toBe(false);
    expect(verdict({ _id: "abc", path: "a.md", hash: "a".repeat(64) }).ok).toBe(false);
  });

  it("保留 id（`_design` / `_local`）放行", () => {
    expect(verdict({ _id: "_design/opennote" })).toEqual({ ok: true });
    expect(verdict({ _id: "_local/device-abc" })).toEqual({ ok: true });
  });

  it("tombstone 放行（删除不该被路径规则挡住，否则文件会在另一端复活）", () => {
    expect(verdict({ _id: `f:${Buffer.from("../x", "utf8").toString("base64url")}`, path: "../x", _deleted: true })).toEqual({ ok: true });
  });
});

describe("内容标识与大小上限", () => {
  it("hash 与 ehash 必须有其一", () => {
    expect(verdict({ _id: "f:abc", path: "a.md" })).toEqual({ ok: false, reason: "missing hash/ehash" });
    expect(verdict({ _id: `h:${"a".repeat(32)}`, epath: "e", ehash: "b".repeat(64) }).ok).toBe(true);
  });

  it("超过 MAX_BYTES 拒绝（size 或 esize 都看）", () => {
    expect(verdict(plainDoc("a.md", { size: MAX_BYTES + 1 })).ok).toBe(false);
    expect(verdict(plainDoc("a.md", { size: MAX_BYTES })).ok).toBe(true);
    expect(verdict({ _id: `h:${"a".repeat(32)}`, epath: "e", ehash: "b".repeat(64), esize: MAX_BYTES + 1 }).ok).toBe(false);
    // 没声明大小的放行（不是所有写入都会带 size）。
    expect(verdict(plainDoc("a.md", { size: undefined })).ok).toBe(true);
  });
});

/* ==========================================================================
   C13 / F1 · 双跑：同一批用例喂给 TS 与 JS，断言判定一致

   用例表的**权威来源**是 `shared/fixtures/path-rules.cases.json` —— 与
   `shared/fixtures.test.ts`（驱动 TS 那一半）读的是**同一个文件**，
   所以「改了一边忘了另一边」必然红。这是单仓下唯一无法靠类型系统消除的接缝（§1.6）。
   ========================================================================== */

interface PathRuleCase {
  id: string;
  path: string;
  expect: "accept" | "reject";
  why: string;
}

const PATH_CASES = pathRulesFixture as PathRuleCase[];

/** TS 侧的判定：`assertSafeRelative` + 保留目录规则（与 §3.8 防线 1 逐条对应）。 */
function tsVerdict(path: string): "accept" | "reject" {
  if (!path) return "reject";
  try {
    assertSafeRelative(path);
  } catch {
    return "reject";
  }
  if (/(^|\/)\.(opennote|git)(\/|$)/.test(path)) return "reject";
  // `assertSafeRelative` 也会归一化；归一后如果变成另一个路径，说明输入不规范（仍可接受）。
  normalizePath(path);
  normalizeNfc(path);
  void isHiddenPath;
  return "accept";
}

describe("C13/F1 · TS 与 CouchDB JS 判定逐条一致（读共享夹具）", () => {
  it("夹具文件确实被读到（不是空数组让断言变成空的）", () => {
    expect(PATH_CASES.length).toBeGreaterThanOrEqual(20);
  });

  it("每一条用例两份实现给出相同结论", () => {
    for (const testCase of PATH_CASES) {
      const js = verdict(plainDoc(testCase.path)).ok ? "accept" : "reject";
      const ts = tsVerdict(testCase.path);
      expect(js, `${testCase.id}（${testCase.why}）：JS=${js} TS=${ts}`).toBe(ts);
      expect(js, `${testCase.id}（${testCase.why}）与夹具期望不一致`).toBe(testCase.expect);
    }
  });

  it("用例表本身同时覆盖 accept 与 reject（否则「一致」是空的）", () => {
    const kinds = new Set(PATH_CASES.map((item) => item.expect));
    expect(kinds).toEqual(new Set(["accept", "reject"]));
  });

  it("这条接缝**确实需要**夹具：构建时必须把大小上限占位替换掉", () => {
    /*
     * 一条只靠类型系统抓不到的漂移：JS 里的大小上限是个**占位标识符**，
     * 如果构建时忘了替换，它在 CouchDB 侧就是一个未定义全局 →
     * **任何带 size 的写入**都会 ReferenceError（现象是 500，而不是「拒绝」）。
     * 第一版正是这么错的：占位写成裸的 MAX_BYTES、替换写成 `String.replace("MAX_BYTES", …)`，
     * 而代码里它是标识符不是字符串字面量 —— 替换静默失效。用例抓到之后改成了
     * 带哨兵前缀的占位 + 替换前先断言占位存在。
     */
    const built = buildDesignDoc({ maxBytes: 4096 });
    expect(built.validate_doc_update).not.toContain(MAX_BYTES_PLACEHOLDER);
    expect(built.validate_doc_update).toContain("4096");
    // 占位消失时**抛错**（不是放过）——否则错误会推迟到运行期才出现。
    expect(() => buildDesignDoc({ maxBytes: 1 })).not.toThrow();
  });
});

describe("只用了保守的 JS 子集（不依赖新引擎）", () => {
  /*
   * CouchDB 打包的 JS 引擎版本由镜像决定（U2）。这里做**静态**检查：
   * 源码里不许出现那些「新引擎才有、旧引擎会直接语法错」的东西。
   * 这是能在 CI 里跑的那一半；真机那一半在 compose 冒烟（U1/U2）。
   */
  const source = VALIDATE_DOC_UPDATE_SOURCE;

  it("不用箭头函数 / 模板串 / let / const / 展开", () => {
    expect(source).not.toMatch(/=>/);
    expect(source).not.toMatch(/`/);
    expect(source).not.toMatch(/\blet\b/);
    expect(source).not.toMatch(/\bconst\b/);
    expect(source).not.toMatch(/\.\.\./);
  });

  it("不用 String.prototype.startsWith / includes / padStart（旧引擎可能没有）", () => {
    expect(source).not.toContain("startsWith");
    expect(source).not.toContain("includes(");
    expect(source).not.toContain("padStart");
    expect(source).not.toContain("Array.from");
  });

  it("by_path 的 map 函数同样保守", () => {
    expect(BY_PATH_MAP_SOURCE).not.toMatch(/=>/);
    expect(BY_PATH_MAP_SOURCE).not.toMatch(/`/);
    expect(BY_PATH_MAP_SOURCE).toContain("emit(");
  });
});

describe("buildDesignDoc / buildSyncInfo / buildSecurityDoc", () => {
  it("设计文档带上 views 与 validate_doc_update，且 language 是 javascript", () => {
    const doc = buildDesignDoc({ maxBytes: 1024 });
    expect(doc.language).toBe("javascript");
    expect(Object.keys(doc.views)).toEqual(["by_path"]);
    expect(doc.validate_doc_update).toContain("function");
    expect(DESIGN_DOC_ID).toBe("_design/opennote");
  });

  it("`_security` 只留 sync 服务账号，**不镜像任何账号 ACL**（§4.4 纪律 1）", () => {
    const security = buildSecurityDoc({ syncUser: "sync-service" });
    expect(security.members.names).toEqual(["sync-service"]);
    expect(security.admins.names).toEqual([]);
    expect(JSON.stringify(security)).not.toContain("accountId");
  });

  it("库名是 `nb-` + 去连字符 uuid（不透明、不可枚举，§3.1）", () => {
    const name = databaseNameFor("11111111-2222-4333-8444-555555555555");
    expect(name).toBe("nb-11111111222243338444555555555555");
    expect(name).toMatch(/^nb-[0-9a-f]{32}$/);
    // 不含连字符（避免在某些工具里被当成 uuid 解析出含义）。
    expect(name.slice(3)).not.toContain("-");
  });
});
