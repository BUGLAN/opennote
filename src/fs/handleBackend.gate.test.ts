/**
 * A 线门禁 · D29（浏览器后端等价面）+ D31（已知限制的静态取证）。
 *
 * D29 的原始复现发生在桌面端 IPC（`fs:remove(root, ".")` 递归删除整个工作区）。
 * 浏览器后端（FSA / OPFS）走的是 `handleBackend.remove()`，它靠
 * `assertSafeRelative(relPath) === ''` 判定「这是根目录」——本文件把这层等价面
 * 用真实的 `MemoryFileSystem` 钉住，防止「桌面端修好了、浏览器端漏了」。
 *
 * D31 在浏览器端**修不了**：`FileSystemDirectoryHandle` 没有 `realpath` 等价物，
 * `resolve()` 在 Chromium 里也不可用于 OPFS/FSA 条目。这里只做静态取证，
 * 证明「没有 realpath」，不声称浏览器端与桌面端等价。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createHandleBackend } from "./handleBackend";
import { assertSafeRelative, baseName, normalizePath, parentPath } from "./paths";
import { MemoryFileSystem } from "./testing/memoryHandles";
import type { FileSystemBackend } from "./types";

const ROOT_SPELLINGS = [".", "./", ".//", "././", ".\\", ".//./", "  .  ", ""];

function build(options: { caseInsensitive?: boolean } = {}): { fs: MemoryFileSystem; backend: FileSystemBackend } {
  const fs = new MemoryFileSystem(options);
  return { fs, backend: createHandleBackend(fs.root, "fsa") };
}

describe("D29 浏览器后端等价面：根目录写法一律不能删 / 不能动", () => {
  it("'.' / './' / './/' / '././' / '.\\' / './/./' / '' 全部被拒，笔记一字节不动", async () => {
    const { fs, backend } = build();
    fs.seedFile("日记/九月.md", "# 九月");
    fs.seedFile("assets/封面.png", "pixels");
    fs.seedDirectory("空目录");
    for (const spelling of ROOT_SPELLINGS) {
      await expect(backend.remove(spelling, { recursive: true }), JSON.stringify(spelling)).rejects.toThrow(
        "不能删除笔记本根目录",
      );
    }
    expect(fs.readText("日记/九月.md")).toBe("# 九月");
    expect(fs.readText("assets/封面.png")).toBe("pixels");
    expect(fs.has("空目录")).toBe(true);
    expect(fs.paths("file")).toHaveLength(2);
  });

  it("null / undefined 同样被当成根目录拒绝", async () => {
    const { fs, backend } = build();
    fs.seedFile("a.md", "A");
    await expect(backend.remove(null as unknown as string, { recursive: true })).rejects.toThrow(
      "不能删除笔记本根目录",
    );
    await expect(backend.remove(undefined as unknown as string, { recursive: true })).rejects.toThrow(
      "不能删除笔记本根目录",
    );
    expect(fs.readText("a.md")).toBe("A");
  });

  it("含 '..' 段的写法走词法校验被拒，不会归一化后退化成根目录", async () => {
    const { fs, backend } = build();
    fs.seedFile("a.md", "A");
    await expect(backend.remove("sub/..", { recursive: true })).rejects.toThrow(/路径越界/);
    await expect(backend.remove("日记/../..", { recursive: true })).rejects.toThrow(/路径越界/);
    await expect(backend.remove("..\\", { recursive: true })).rejects.toThrow(/路径越界/);
    expect(fs.readText("a.md")).toBe("A");
  });

  it("根因：'.' 的归一化结果与 '' 完全一致，字面量守卫抓不到它", () => {
    // D29 修复前 main.cjs 的守卫是 `if (relPath === '' || relPath === undefined …)`，
    // 比较的是**字面量**：'.' 不等于 ''，于是被放行，随后 path.resolve(root, '.') === root
    // 交给 rm(root, {recursive:true})，整个工作区被删除。
    // 浏览器后端从未走过这条路（它一直在比归一化后的 safe），这里把「字面量 vs 归一化」
    // 这个根因钉住：只要守卫看的是归一化结果，'.' 与 '' 就不可能被区别对待。
    expect(".").not.toBe("");
    expect("").toBe("");
    for (const spelling of [".", "./", ".//", "././", ".\\", ".//./", "  .  "]) {
      expect(assertSafeRelative(spelling), JSON.stringify(spelling)).toBe("");
    }
    expect(normalizePath(".")).toBe("");
    expect(baseName(".")).toBe("");
    expect(parentPath(".")).toBe("");
  });

  it("move 的两个端点同样不能是根目录写法", async () => {
    const { fs, backend } = build();
    fs.seedFile("a.md", "A");
    await expect(backend.move(".", "备份")).rejects.toThrow("不能移动笔记本根目录");
    await expect(backend.move("a.md", "./")).rejects.toThrow("不能移动笔记本根目录");
    expect(fs.readText("a.md")).toBe("A");
    expect(fs.has("备份")).toBe(false);
  });
});

describe("D31 已知限制取证：浏览器后端里不存在 realpath 等价调用", () => {
  /** 从本测试文件所在目录读兄弟模块源码（vitest 里 `import.meta.url` 即本文件 URL）。 */
  const sourceOf = (name: string): string => readFileSync(new URL(name, import.meta.url), "utf8");

  it("handleBackend.ts / opfs.ts 全文没有 realpath（也没有 resolve 等价物）", () => {
    for (const name of ["./handleBackend.ts", "./opfs.ts"]) {
      const text = sourceOf(name);
      expect(/realpath/i.test(text), `${name} 不应出现 realpath`).toBe(false);
      expect(/\.resolve\s*\(/.test(text), `${name} 不应靠 FileSystemHandle.resolve() 判越界`).toBe(false);
    }
  });

  it("桌面端对照：electron/main.cjs 才是做 realpath 越界校验的那一侧", () => {
    const main = readFileSync(new URL("../../electron/main.cjs", import.meta.url), "utf8");
    expect(/realpath/.test(main)).toBe(true);
    expect(/assertRealPathInsideRoot/.test(main)).toBe(true);
    expect(/realpathForCheck/.test(main)).toBe(true);
  });
});
