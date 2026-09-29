import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `opennote://` 深链解析的单测（00 号 §6.14㉛）。
 *
 * 被测模块是 `electron/deeplink.cjs`（零 Electron 依赖的纯函数）—— 这样
 * 「路由与拒绝规则」能被真单测钉住，而不是只靠真机手点。
 */
const require_ = createRequire(import.meta.url);
const deeplink = require_("../../electron/deeplink.cjs") as {
  PROTOCOL: string;
  DEEPLINK_MESSAGES: Record<string, string>;
  deeplinkMessage(result: unknown): string;
  findDeeplinkInArgv(argv: unknown): string | null;
  isSafeRelativePath(value: unknown): boolean;
  parseOpennoteUrl(raw: unknown):
    | { ok: true; kind: "settings"; section: "import" }
    | { ok: true; kind: "open"; path: string }
    | { ok: false; reason: "unsupported"; route: string }
    | { ok: false; reason: "invalid"; detail: string; route: string };
};

describe("opennote:// 深链解析", () => {
  it("协议名是 opennote", () => {
    expect(deeplink.PROTOCOL).toBe("opennote");
  });

  describe("API-11 打开设置（P0）", () => {
    it("opennote://settings/import → 定位到导入与接口", () => {
      expect(deeplink.parseOpennoteUrl("opennote://settings/import")).toEqual({
        ok: true,
        kind: "settings",
        section: "import",
      });
    });

    it("opennote://settings 也认（不带子路由）", () => {
      expect(deeplink.parseOpennoteUrl("opennote://settings")).toEqual({
        ok: true,
        kind: "settings",
        section: "import",
      });
    });

    it("大小写与尾斜杠都要归一，不能靠拼写绕过匹配", () => {
      expect(deeplink.parseOpennoteUrl("OpenNote://SETTINGS/Import/")).toEqual({
        ok: true,
        kind: "settings",
        section: "import",
      });
    });
  });

  describe("API-12 打开笔记", () => {
    it("合法相对路径", () => {
      expect(deeplink.parseOpennoteUrl("opennote://open?path=%E5%89%AA%E8%97%8F/a.md")).toEqual({
        ok: true,
        kind: "open",
        path: "剪藏/a.md",
      });
    });

    it("反斜杠归一成 POSIX 分隔符", () => {
      expect(deeplink.parseOpennoteUrl("opennote://open?path=a%5Cb%5Cc.md")).toEqual({
        ok: true,
        kind: "open",
        path: "a/b/c.md",
      });
    });

    it("缺 path 参数 → invalid", () => {
      const result = deeplink.parseOpennoteUrl("opennote://open");
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: "invalid", route: "open" });
    });

    // 越权与奇葩路径必须一律拒绝 —— 这条是「信封不能指定绝对路径」红线在深链上的延伸。
    // 注意：这里的取值都是**原始**路径，由 `encodeURIComponent` 负责编码。
    it.each([
      ["绝对路径", "/etc/passwd"],
      ["盘符", "C:/Windows/System32"],
      ["父目录逃逸", "../外部.md"],
      ["父目录逃逸（中段）", "a/../../外部.md"],
      ["当前目录段", "a/./b.md"],
      ["空段", "a//b.md"],
      ["Windows 保留字符", "a/b:c.md"],
      ["NUL 字节", "a\0b.md"],
      ["尾随点", "a/b."],
      ["尾随空格", "a/b "],
      ["前导空格", " a/b.md"],
      ["整体带空白", " a/b.md "],
    ])("拒绝 %s", (_label, path) => {
      const result = deeplink.parseOpennoteUrl(
        `opennote://open?path=${encodeURIComponent(path)}`,
      );
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: "invalid", route: "open" });
    });

    // 反例的反例：`%2F` 出现在**解码后**的段里只是普通字符，不构成越权。
    // 显式钉住这条，免得有人为了「更安全」把 `%` 也一起拒掉，反而挡住正常文件名。
    it("双重编码的 %2F 只是普通字符，不构成越权（应当接受为字面文件名）", () => {
      expect(deeplink.parseOpennoteUrl("opennote://open?path=%252Fetc%252Fpasswd")).toEqual({
        ok: true,
        kind: "open",
        path: "%2Fetc%2Fpasswd",
      });
    });
  });

  describe("未实现路由必须显式报「暂不支持」，不得静默", () => {
    it("API-09 clip 本次不实现", () => {
      expect(deeplink.parseOpennoteUrl("opennote://clip?d=abc")).toEqual({
        ok: false,
        reason: "unsupported",
        route: "clip",
      });
    });

    it("未知路由同样报 unsupported", () => {
      const result = deeplink.parseOpennoteUrl("opennote://whatever/x");
      expect(result).toMatchObject({ ok: false, reason: "unsupported" });
    });

    it("unsupported 与 invalid 的文案不同，且都非空", () => {
      const unsupported = deeplink.deeplinkMessage({
        ok: false,
        reason: "unsupported",
        route: "clip",
      });
      const invalid = deeplink.deeplinkMessage({ ok: false, reason: "invalid", detail: "x", route: "" });
      expect(unsupported).not.toBe("");
      expect(invalid).not.toBe("");
      expect(unsupported).not.toBe(invalid);
    });
  });

  describe("非法输入", () => {
    it.each([
      ["空串", ""],
      ["只有空白", "   "],
      ["非字符串", 42],
      ["null", null],
      ["undefined", undefined],
      ["别的协议", "https://example.com"],
      ["http", "http://opennote/settings/import"],
    ])("拒绝 %s", (_label, value) => {
      const result = deeplink.parseOpennoteUrl(value);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("invalid");
    });

    it("opennote:// 后面什么都没有 → 不是合法路由", () => {
      const result = deeplink.parseOpennoteUrl("opennote://");
      expect(result.ok).toBe(false);
    });
  });

  describe("从 argv 里挑深链（Windows/Linux 的 second-instance 路径）", () => {
    it("挑出第一个 opennote:// 参数，忽略其它", () => {
      expect(
        deeplink.findDeeplinkInArgv(["electron.exe", "main.cjs", "--flag", "opennote://settings/import"]),
      ).toBe("opennote://settings/import");
    });

    it("没有就返回 null（不能返回空串，否则会被当成一条深链）", () => {
      expect(deeplink.findDeeplinkInArgv(["electron.exe", "main.cjs"])).toBeNull();
      expect(deeplink.findDeeplinkInArgv(null)).toBeNull();
      expect(deeplink.findDeeplinkInArgv("opennote://settings")).toBeNull();
    });
  });

  describe("isSafeRelativePath 与解析器口径一致", () => {
    it.each(["a.md", "剪藏/a.md", "a/b/c.md", "a b/c.md"])("允许 %s", (value) => {
      expect(deeplink.isSafeRelativePath(value)).toBe(true);
    });

    it.each(["", " ", "/a.md", "../a.md", "a/../b.md", "C:/a.md", "a/b:c.md", "a//b.md", "a/b.", "a/b ", " a/b.md"])(
      "拒绝 %s",
      (value) => {
        expect(deeplink.isSafeRelativePath(value)).toBe(false);
      },
    );
  });
});
