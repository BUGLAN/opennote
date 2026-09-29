import { describe, expect, it } from "vitest";
import {
  assertSafeRelative,
  baseName,
  extName,
  isHiddenPath,
  isImagePath,
  isMarkdownPath,
  joinPath,
  normalizePath,
  parentPath,
  sanitizeName,
  stripExtension,
  uniquePath,
  ASSETS_DIR,
  META_DIR,
  STATE_FILE,
  TRASH_DIR,
} from "./paths";
import { describeBackend } from "./types";

describe("normalizePath", () => {
  it("collapses separators, dots and backslashes", () => {
    expect(normalizePath("./日记//2025-05.md")).toBe("日记/2025-05.md");
    expect(normalizePath("a\\b\\c.md")).toBe("a/b/c.md");
    expect(normalizePath("/leading/slash/")).toBe("leading/slash");
    expect(normalizePath("")).toBe("");
  });

  it("resolves parent segments", () => {
    expect(normalizePath("a/b/../c.md")).toBe("a/c.md");
    expect(normalizePath("../outside.md")).toBe("outside.md");
  });
});

describe("assertSafeRelative", () => {
  it("accepts workspace-relative paths", () => {
    expect(assertSafeRelative("日记/九月.md")).toBe("日记/九月.md");
    expect(assertSafeRelative("")).toBe("");
  });

  it("rejects absolute paths and drive letters", () => {
    expect(() => assertSafeRelative("C:/Windows/system32")).toThrow();
    expect(() => assertSafeRelative("/etc/passwd")).toThrow();
    expect(() => assertSafeRelative("\\\\server\\share")).toThrow();
  });

  it("rejects NUL bytes and parent traversal", () => {
    expect(() => assertSafeRelative("a\0b.md")).toThrow();
    expect(() => assertSafeRelative("../private.md")).toThrow("路径越界");
    expect(() => assertSafeRelative("a\\..\\private.md")).toThrow("路径越界");
  });

  it("rejects ':' inside a segment (D36: NTFS alternate data streams)", () => {
    expect(() => assertSafeRelative("a.md:secret")).toThrow("路径不能包含冒号");
    expect(() => assertSafeRelative("日记/九月.md:ads")).toThrow("路径不能包含冒号");
    expect(() => assertSafeRelative("notes/a:b/c.md")).toThrow("路径不能包含冒号");
    expect(() => assertSafeRelative("C:/Windows/system32")).toThrow();
    // 正常笔记名不受影响（sanitizeName 本来就会剥掉 ':'）
    expect(assertSafeRelative("日记/九月.md")).toBe("日记/九月.md");
    expect(assertSafeRelative("a-1_2.txt")).toBe("a-1_2.txt");
  });
});

describe("path helpers", () => {
  it("splits folders and names", () => {
    expect(parentPath("日记/九月.md")).toBe("日记");
    expect(parentPath("九月.md")).toBe("");
    expect(baseName("日记/九月.md")).toBe("九月.md");
    expect(extName("日记/九月.MD")).toBe(".md");
    expect(stripExtension("日记/九月.md")).toBe("日记/九月");
  });

  it("joins without introducing double slashes", () => {
    expect(joinPath("日记", "九月.md")).toBe("日记/九月.md");
    expect(joinPath("", "九月.md")).toBe("九月.md");
    expect(joinPath(null, "assets", "a.png")).toBe("assets/a.png");
  });

  it("recognises the file kinds the app cares about", () => {
    expect(isMarkdownPath("a.md")).toBe(true);
    expect(isMarkdownPath("a.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("a.png")).toBe(false);
    expect(isImagePath("照片.JPG")).toBe(true);
    expect(isHiddenPath(".opennote/state.json")).toBe(true);
    expect(isHiddenPath("日记/a.md")).toBe(false);
    expect(isHiddenPath("日记/.hidden/a.md")).toBe(true);
  });

  it("knows the metadata layout", () => {
    expect(META_DIR).toBe(".opennote");
    expect(STATE_FILE).toBe(".opennote/state.json");
    expect(ASSETS_DIR).toBe("assets");
    expect(TRASH_DIR).toBe(".opennote/trash");
  });
});

describe("sanitizeName / uniquePath", () => {
  it("keeps CJK and removes characters a filesystem would reject", () => {
    expect(sanitizeName("九月/日记: 第一周?")).toBe("九月 日记 第一周");
    expect(sanitizeName("///")).toBe("未命名");
  });

  it("deduplicates names the way a file manager does", () => {
    const taken = new Set(["笔记.md", "笔记 2.md"]);
    expect(uniquePath("其他.md", taken)).toBe("其他.md");
    expect(uniquePath("笔记.md", taken)).toBe("笔记 3.md");
  });

  it("deduplicates inside a folder", () => {
    const taken = new Set(["日记/九月.md"]);
    expect(uniquePath("日记/九月.md", taken)).toBe("日记/九月 2.md");
  });

  it("keeps case-sensitive behaviour by default (browser OPFS is case-sensitive)", () => {
    expect(uniquePath("readme.md", new Set(["README.md"]))).toBe("readme.md");
  });

  it("folds case only when the caller asks for it (D30, Windows/macOS disks)", () => {
    expect(uniquePath("README.md", new Set(["readme.md"]), { foldCase: true })).toBe("README 2.md");
    expect(uniquePath("笔记.md", new Set(["笔记.md"]), { foldCase: true })).toBe("笔记 2.md");
    expect(uniquePath("readme.md", new Set(["README.md", "ReAdMe 2.MD"]), { foldCase: true })).toBe("readme 3.md");
    expect(uniquePath("其他.md", new Set(["readme.md"]), { foldCase: true })).toBe("其他.md");
  });
});

describe("describeBackend", () => {
  it("labels the three backends for the UI", () => {
    expect(describeBackend("node")).toBe("本机磁盘");
    expect(describeBackend("fsa")).toBe("浏览器文件夹");
    expect(describeBackend("opfs")).toBe("浏览器本地");
  });
});
