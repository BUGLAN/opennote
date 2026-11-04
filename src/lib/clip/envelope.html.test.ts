/**
 * 信封扩展 `format` / `resources[]`（HTML 页面）的校验口径。
 * Markdown 信封必须与扩展之前逐字节一致：不写 `format` / `resources`，也不受它们影响。
 */
import { describe, expect, it } from "vitest";
import { serializeEnvelope, validateImportEnvelope } from "./envelope";

const base = (overrides: Record<string, unknown> = {}) => ({
  spec: "opennote.import/v1",
  importId: "html-check-0001",
  title: "页面",
  body: "<p>x</p>",
  source: { url: null, capturedAt: "2026-10-28T12:00:00Z" },
  ...overrides,
});
const b64 = (text: string) => Buffer.from(text).toString("base64");

function problemOf(value: unknown) {
  const result = validateImportEnvelope(value);
  if (result.ok) throw new Error("预期校验失败");
  return result.problem;
}

describe("format", () => {
  it("缺省 = markdown；resources 恒为空；序列化不出现扩展字段", () => {
    const result = validateImportEnvelope(base());
    expect(result.ok && result.envelope.format).toBe("markdown");
    expect(result.ok && result.envelope.resources).toEqual([]);
    const out = result.ok ? serializeEnvelope(result.envelope) : {};
    expect("format" in out || "resources" in out).toBe(false);
  });

  it("未知 format → IMP-4003", () => {
    expect(problemOf(base({ format: "pdf" })).code).toBe("IMP-4003");
  });

  it("html + resources：路径归一、MIME 按扩展名定；序列化带回 format 与 dataBase64", () => {
    const result = validateImportEnvelope(base({ format: "html", resources: [{ path: "./css/a.css", mime: "x/y", dataBase64: b64("p{}") }] }));
    if (!result.ok) throw new Error(result.problem.code);
    expect(result.envelope.resources[0]).toMatchObject({ path: "css/a.css", mime: "text/css" });
    const out = serializeEnvelope(result.envelope) as { format?: string; resources?: Array<{ path: string; dataBase64?: string }> };
    expect(out.format).toBe("html");
    expect(out.resources?.[0]).toMatchObject({ path: "css/a.css", dataBase64: b64("p{}") });
  });

  it("html 里的 assets 被忽略并警告；markdown 里的 resources 被忽略并警告", () => {
    const html = validateImportEnvelope(base({ format: "html", assets: [{ name: "a.png", mime: "image/png", dataBase64: b64("A") }] }));
    expect(html.ok && html.envelope.assets).toEqual([]);
    expect(html.ok && html.envelope.warnings.join("")).toContain("HTML 页面不使用 assets");
    const md = validateImportEnvelope(base({ resources: [{ path: "a.css", dataBase64: b64("x") }] }));
    expect(md.ok && md.envelope.resources).toEqual([]);
    expect(md.ok && md.envelope.warnings.join("")).toContain("resources 只对 HTML 页面");
  });
});

describe("resources 的拒绝项（IMP-4012 / IMP-4013）", () => {
  const rejects = (resources: unknown, code = "IMP-4012") => expect(problemOf(base({ format: "html", resources })).code).toBe(code);

  it("越界、绝对、隐藏路径一律拒绝", () => {
    rejects([{ path: "../x.css", dataBase64: b64("x") }]);
    rejects([{ path: "/etc/x.css", dataBase64: b64("x") }]);
    rejects([{ path: ".opennote/x.css", dataBase64: b64("x") }]);
  });

  it("不在内联白名单的格式、重复路径、没有载荷、坏 base64 都拒绝", () => {
    rejects([{ path: "note.md", dataBase64: b64("x") }]);
    rejects([
      { path: "a.css", dataBase64: b64("x") },
      { path: "./a.css", dataBase64: b64("y") },
    ]);
    rejects([{ path: "a.css" }]);
    rejects([{ path: "a.css", dataBase64: "!!!" }]);
  });

  it("超过合计上限 → IMP-4013", () => {
    const big = Buffer.alloc(5 * 1024 * 1024, 1).toString("base64");
    rejects(
      [
        { path: "a.png", dataBase64: big },
        { path: "b.png", dataBase64: big },
      ],
      "IMP-4013",
    );
  });
});
