/**
 * A 线门禁 · D29 / D03 / D31 —— 渲染层 `src/fs` 侧所依赖的契约。
 *
 * 这三条缺陷的主体修复分别在 `electron/main.cjs`（D29 根目录保护、D31 realpath）
 * 与 `src/data/library.ts`（D03 落点预检）。本文件**不对那些文件下断言**，只钉住
 * 它们所依赖的 fs 层原语，缺了这些原语，上游的修复就是空的：
 *
 * - D29：`normalizePath` / `assertSafeRelative` 必须把所有「根目录写法」收敛成 `''`
 *   （`handleBackend.remove()` 的 `if (!safe)` 守卫完全建立在这一点上）。
 * - D03：落点必须用后端 `exists()` 复核磁盘真相，只看内存名字集合就会写空同名文件。
 * - D31：`assertSafeRelative` 只是**词法**校验，无法区分链接与普通目录。
 *   桌面端由 `main.cjs` 的 `assertRealPathInsideRoot` 兜住；浏览器后端没有可用的
 *   `realpath`，这是**已知限制**（见 `docs/verify/A0-缺陷门禁-作者证据.md`）。
 */
import { describe, expect, it } from "vitest";
import { createHandleBackend } from "./handleBackend";
import { assertSafeRelative, normalizePath, uniquePath } from "./paths";
import { MemoryFileSystem } from "./testing/memoryHandles";
import type { FileSystemBackend } from "./types";

/** D29 实测中被 `path.resolve` 归一化成 root 本身的全部写法。 */
const ROOT_SPELLINGS = [".", "./", ".//", "././", ".\\", ".//./", "  .  "];

describe("D29 路径归一化：根目录写法必须收敛成 ''", () => {
  it("'.' / './' / './/' / '././' / '.\\' / './/./' / '  .  ' 都归一化成空串", () => {
    for (const spelling of ROOT_SPELLINGS) {
      expect(normalizePath(spelling), `normalizePath(${JSON.stringify(spelling)})`).toBe("");
      expect(assertSafeRelative(spelling), `assertSafeRelative(${JSON.stringify(spelling)})`).toBe("");
    }
  });

  it("'' / undefined / null 与根目录写法等价（'' 是根目录的唯一表示）", () => {
    expect(assertSafeRelative("")).toBe("");
    expect(assertSafeRelative(undefined as unknown as string)).toBe("");
    expect(assertSafeRelative(null as unknown as string)).toBe("");
  });

  it("含 '..' 段的写法一律「路径越界」，绝不归一化后退化成根目录", () => {
    for (const unsafe of ["..", "../", "sub/..", "a/../..", "..\\", "日记/../.."]) {
      expect(() => assertSafeRelative(unsafe), unsafe).toThrow(/路径越界/);
    }
  });

  it("归一化不会把真实子目录吞掉，也不会改写路径语义", () => {
    expect(assertSafeRelative("./日记/./九月.md")).toBe("日记/九月.md");
    expect(assertSafeRelative("日记//九月.md")).toBe("日记/九月.md");
    expect(normalizePath("日记/九月.md")).toBe("日记/九月.md");
  });
});

/**
 * `resolveAvailablePath()`（`src/data/library.ts`）的算法在 fs 层的等价复刻：
 * 内存里的 `taken` 只是起点，落点必须再由后端 `exists()` 复核。
 * 端到端证据在 `src/data/library.regression.test.ts` 的 D03 组，由门禁脚本按名字强制要求。
 */
async function pickLandingPath(
  backend: FileSystemBackend,
  requested: string,
  memoryTaken: Set<string>,
): Promise<string> {
  const taken = new Set(memoryTaken);
  let candidate = requested;
  let guard = 0;
  while (await backend.exists(candidate)) {
    taken.add(candidate);
    candidate = uniquePath(requested, taken);
    guard += 1;
    if (guard > 500) break;
  }
  return candidate;
}

describe("D03 落点契约：内存去重之外必须再用后端 exists() 复核", () => {
  it("扫描之后才出现的同名文件：exists() 仍为 true，落点让开为「无标题 2.md」", async () => {
    const fs = new MemoryFileSystem();
    const backend = createHandleBackend(fs.root, "fsa");
    // 模拟「上次扫描之后外部程序写进来的文件」：内存名字集合完全不知道它
    fs.seedFile("无标题.md", "# 外部程序写的重要文件");
    const memoryTaken = new Set<string>();
    const landing = await pickLandingPath(backend, "无标题.md", memoryTaken);
    expect(landing).toBe("无标题 2.md");
    await backend.writeText(landing, "");
    expect(fs.readText("无标题.md")).toBe("# 外部程序写的重要文件");
    expect(fs.readText("无标题 2.md")).toBe("");
  });

  it("大小写不敏感磁盘（Windows / macOS）上 README 也必须让开 readme.md", async () => {
    const fs = new MemoryFileSystem({ caseInsensitive: true });
    const backend = createHandleBackend(fs.root, "fsa");
    fs.seedFile("readme.md", "# 已有内容");
    expect(await backend.exists("README.md")).toBe(true);
    const landing = await pickLandingPath(backend, "README.md", new Set(["readme.md"]));
    expect(landing).toBe("README 2.md");
    await backend.writeText(landing, "");
    expect(fs.readText("readme.md")).toBe("# 已有内容");
  });

  it("修复前 vs 修复后：只信内存 taken 会写空同名文件，exists() 复核才不会", async () => {
    // 修复前（D03 复现）：uniquePath 只吃内存里的名字集合，不做任何存在性复核。
    const before = new MemoryFileSystem();
    const beforeBackend = createHandleBackend(before.root, "fsa");
    before.seedFile("无标题.md", "# 外部程序写的重要文件");
    const oldLanding = uniquePath("无标题.md", new Set());
    expect(oldLanding).toBe("无标题.md");
    await beforeBackend.writeText(oldLanding, "");
    expect(before.readText("无标题.md")).toBe(""); // ← 修复前的失败形态：原内容被清空

    // 修复后：同一个落点问题先过后端 exists()，名字让开，原文件一个字节不动。
    const after = new MemoryFileSystem();
    const afterBackend = createHandleBackend(after.root, "fsa");
    after.seedFile("无标题.md", "# 外部程序写的重要文件");
    const newLanding = await pickLandingPath(afterBackend, "无标题.md", new Set());
    expect(newLanding).toBe("无标题 2.md");
    await afterBackend.writeText(newLanding, "");
    expect(after.readText("无标题.md")).toBe("# 外部程序写的重要文件"); // ← 修复后通过
    expect(after.readText("无标题 2.md")).toBe("");
  });

  it("落点循环必然终止，返回的路径一定未被占用", async () => {
    const fs = new MemoryFileSystem();
    const backend = createHandleBackend(fs.root, "fsa");
    for (let index = 0; index < 12; index += 1) fs.seedFile(index === 0 ? "a.md" : `a ${index}.md`, "on-disk");
    const landing = await pickLandingPath(backend, "a.md", new Set(["a.md"]));
    expect(landing).toBe("a 12.md");
    expect(await backend.exists(landing)).toBe(false);
  });
});

describe("D31 边界（characterization）：词法校验挡不住链接", () => {
  it("assertSafeRelative 原样放行链接名——越界判定只能由 realpath 承担", () => {
    // 这不是「安全校验通过了」，而是把边界钉死：本函数只看字符串，
    // 链接与普通目录在词法上完全一样。桌面端由 main.cjs 的 assertRealPathInsideRoot
    // 兜住；浏览器端没有 realpath，属已知限制。
    expect(assertSafeRelative("junction-out/secret.txt")).toBe("junction-out/secret.txt");
    expect(assertSafeRelative("link-out.md")).toBe("link-out.md");
  });
});
