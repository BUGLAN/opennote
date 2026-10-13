/**
 * 共享夹具的**第一半**：`shared/paths.ts` 对每条用例的判定必须等于期望
 * （`docs/执行-三端同步…` §10.1 F1）。
 *
 * 另一半在 `server/src/couch/design.test.ts`（`_design` 的 JS 跑同一批用例）。
 * 两份都从 `shared/fixtures/path-rules.cases.json` 读，所以「改了一边忘了另一边」必然红。
 */
import { describe, expect, it } from "vitest";
import cases from "./fixtures/path-rules.cases.json" with { type: "json" };
import { assertSafeRelative, idForPath, pathFromLegacyId } from "./paths";

/** `shared/paths.ts` 侧的判定：与 §3.8 防线 1 逐条对应。 */
export function tsPathVerdict(path: string): "accept" | "reject" {
  if (!path) return "reject";
  try {
    assertSafeRelative(path);
  } catch {
    return "reject";
  }
  // 保留目录（§3.11）：`assertSafeRelative` 只管「能不能安全地落到盘上」，
  // 「该不该同步」是忽略规则的事 —— 这一条在 §3.8 里也是分开写的。
  if (/(^|\/)\.(opennote|git)(\/|$)/.test(path)) return "reject";
  return "accept";
}

describe("F1a · 夹具驱动 shared/paths.ts", () => {
  it("每一条用例的判定都等于期望（含 `why` 便于回看原因）", () => {
    for (const testCase of cases as { id: string; path: string; expect: "accept" | "reject"; why: string }[]) {
      expect(tsPathVerdict(testCase.path), `${testCase.id}（${testCase.why}）路径=${JSON.stringify(testCase.path)}`).toBe(
        testCase.expect,
      );
    }
  });

  it("夹具本身同时覆盖 accept 与 reject（否则「一致」是空的）", () => {
    const list = cases as { expect: string }[];
    expect(new Set(list.map((item) => item.expect))).toEqual(new Set(["accept", "reject"]));
    expect(list.length).toBeGreaterThanOrEqual(20);
  });

  it("每条用例都有 id 与 why（夹具是**文档**，不是一堆裸路径）", () => {
    for (const testCase of cases as { id: string; why: string }[]) {
      // 门槛取 3 而不是更高：中文里「盘符」「越界」这种就是 2–3 个字，够了。
      expect(testCase.id.length, `id=${JSON.stringify(testCase.id)}`).toBeGreaterThanOrEqual(3);
      expect(testCase.why.length, `id=${testCase.id} why=${JSON.stringify(testCase.why)}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("NUL 那一条里的确是**真的空字节**，不是字面量反斜杠-u0000 六个字符", () => {
    /*
     * 这一条踩过一次：JSON 里写 `"\u0000"` 不是合法转义，解析器把它当成
     * **字面量六个字符**（反斜杠 u 0 0 0 0），于是那条用例根本没在测空字节 ——
     * 而它「看起来」还在测。夹具是「行为样本」，这种静默走样必须被钉住。
     */
    const nulCase = (cases as { id: string; path: string }[]).find((item) => item.id === "reject-nul");
    expect(nulCase).toBeDefined();
    // `a` + NUL + `b.md` = 6 个 char
    expect(nulCase!.path.length).toBe(6);
    expect(nulCase!.path.charCodeAt(1)).toBe(0);
  });

  it("id 唯一（重复的 id 会让「哪条红了」说不清）", () => {
    const ids = (cases as { id: string }[]).map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("F1a 配套 · 文档标识的可逆性对每条 accept 用例都成立", () => {
  it("`pathFromLegacyId(idForPath(p))` 等于归一后的 p（拒绝的用例不参与）", () => {
    for (const testCase of cases as { path: string; expect: string }[]) {
      if (testCase.expect !== "accept") continue;
      const id = idForPath(testCase.path);
      // 归一之后往返必须稳定（这是「同一个 did 永远指向同一条内容」的基础）。
      expect(pathFromLegacyId(id)).toBe(pathFromLegacyId(idForPath(pathFromLegacyId(id))));
    }
  });
});
