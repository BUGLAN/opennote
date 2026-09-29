import { describe, expect, it } from "vitest";
import { createHandleBackend } from "./handleBackend";
import { isHiddenPath } from "./paths";
import { MemoryFileSystem } from "./testing/memoryHandles";
import type { FileSystemBackend } from "./types";

function build(options: { caseInsensitive?: boolean } = {}): { fs: MemoryFileSystem; backend: FileSystemBackend } {
  const fs = new MemoryFileSystem(options);
  return { fs, backend: createHandleBackend(fs.root, "fsa") };
}

describe("handleBackend 错误语义（D33：与 Node 后端一致的中文语义）", () => {
  it("remove('') 拒绝删除根目录，且不动任何文件", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "X");
    await expect(backend.remove("")).rejects.toThrow("不能删除笔记本根目录");
    await expect(backend.remove(".")).rejects.toThrow("不能删除笔记本根目录");
    expect(fs.readText("笔记.md")).toBe("X");
  });

  it("缺失的文件 / 目录统一抛「找不到：<path>」，不冒英文 DOMException", async () => {
    const { backend } = build();
    await expect(backend.readText("缺失.md")).rejects.toThrow(/^找不到：缺失\.md$/);
    await expect(backend.readBytes("缺失.md")).rejects.toThrow(/^找不到：缺失\.md$/);
    await expect(backend.list("缺失目录")).rejects.toThrow(/^找不到：缺失目录$/);
    await expect(backend.move("缺失.md", "新.md")).rejects.toThrow(/^找不到：缺失\.md$/);

    const message = await backend.readText("缺失.md").then(
      () => "",
      (error: Error) => error.message,
    );
    expect(message).not.toMatch(/NotFound|not found|DOMException|ENOENT/i);
  });

  it("remove 缺失路径与桌面端 rm(force:true) 一样幂等成功", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "X");
    await expect(backend.remove("缺失.md")).resolves.toBeUndefined();
    await expect(backend.remove("缺失目录", { recursive: true })).resolves.toBeUndefined();
    expect(fs.readText("笔记.md")).toBe("X");
  });

  it("exists('') 为 true；stat 对目录与缺失路径都返回 null", async () => {
    const { fs, backend } = build();
    fs.seedFile("日记/九月.md", "# 九月");
    expect(await backend.exists("")).toBe(true);
    expect(await backend.exists("日记")).toBe(true);
    expect(await backend.exists("日记/缺失.md")).toBe(false);
    expect(await backend.stat("日记")).toBeNull();
    expect(await backend.stat("日记/缺失.md")).toBeNull();
    expect(await backend.stat("日记/九月.md")).toEqual({
      size: new TextEncoder().encode("# 九月").byteLength,
      mtimeMs: expect.any(Number),
    });
  });

  it("文件与目录类型不符时给出中文错误，而非 TypeMismatchError 原文", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "X");
    fs.seedDirectory("日记");
    await expect(backend.list("笔记.md")).rejects.toThrow(/^不是文件夹：笔记\.md$/);
    await expect(backend.readText("日记")).rejects.toThrow(/^不是文件：日记$/);
    await expect(backend.writeText("日记", "X")).rejects.toThrow(/^不是文件：日记$/);
  });

  it("写入会自动建出父目录，list 能按名称排序读回", async () => {
    const { backend } = build();
    await backend.writeText("故事/子目录/第二章.md", "# 第二章");
    expect(await backend.list("")).toEqual([{ name: "故事", kind: "directory", size: 0, mtimeMs: 0 }]);
    expect((await backend.list("故事/子目录")).map((entry) => entry.name)).toEqual(["第二章.md"]);
  });

  it("任何失败路径都不会把英文 DOMException 原文交给 UI", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "X");
    const attempts: Promise<unknown>[] = [
      backend.readText("缺失.md"),
      backend.readBytes("缺失/深层.md"),
      backend.list("缺失"),
      backend.writeText("笔记.md/x.md", "X"),
      backend.remove("笔记.md/x.md"),
      backend.move("缺失.md", "新.md"),
      backend.move("笔记.md", "笔记.md/子"),
    ];
    const messages = await Promise.all(
      attempts.map((attempt) =>
        attempt.then(
          () => "（没有失败）",
          (error: Error) => error.message,
        ),
      ),
    );
    for (const message of messages) {
      expect(message).toMatch(/[\u3400-\u9fff]/);
      expect(message).not.toMatch(/NotFound|TypeMismatch|InvalidModification|QuotaExceeded|not found|DOMException|ENOENT/);
    }
  });
});

describe("handleBackend.move（D34：大小写折叠与「失败即删目标」）", () => {
  it("大小写不敏感磁盘上只改大小写 → 直接返回，绝不删除文件", async () => {
    const { fs, backend } = build({ caseInsensitive: true });
    fs.seedFile("note.md", "CONTENT");
    await backend.move("note.md", "NOTE.md");
    expect(fs.readText("note.md")).toBe("CONTENT");
    expect(fs.paths("file")).toEqual(["note.md"]);
    // 早退发生在任何读写之前：旧代码会先写目标再删源，把文件删得一个不剩
    expect(fs.events).toEqual([]);
  });

  it("大小写不敏感磁盘上目录只改大小写 → 内容原样保留", async () => {
    const { fs, backend } = build({ caseInsensitive: true });
    fs.seedFile("Docs/a.md", "A");
    await backend.move("Docs", "docs");
    expect(fs.readText("Docs/a.md")).toBe("A");
    expect(fs.paths()).toEqual(["Docs", "Docs/a.md"]);
  });

  it("大小写敏感磁盘（OPFS）同样按契约直接返回，不做破坏性重命名", async () => {
    const { fs, backend } = build();
    fs.seedFile("note.md", "CONTENT");
    await backend.move("note.md", "NOTE.md");
    expect(fs.readText("note.md")).toBe("CONTENT");
    expect(fs.readText("NOTE.md")).toBeUndefined();
  });

  it("目标存在性按折叠后的名字判断，且不碰既有文件", async () => {
    const { fs, backend } = build({ caseInsensitive: true });
    fs.seedFile("a.md", "源");
    fs.seedFile("b/a.md", "别人的文件");
    await expect(backend.move("a.md", "b/A.md")).rejects.toThrow("目标路径已存在：b/A.md");
    expect(fs.readText("a.md")).toBe("源");
    expect(fs.readText("b/a.md")).toBe("别人的文件");
  });

  it("「移动到自身内部」按折叠后的路径判断", async () => {
    const { fs, backend } = build({ caseInsensitive: true });
    fs.seedFile("a.md", "CONTENT");
    // 大小写不敏感磁盘上 A.MD/x 就在 a.md 里面：旧代码会先按大小写敏感比较放过去，
    // 再把文件当成目录去写（真实场景里目录自包含会递归拷贝到爆栈）。
    await expect(backend.move("a.md", "A.MD/x")).rejects.toThrow("不能将文件夹移动到自身内部");
    expect(fs.readText("a.md")).toBe("CONTENT");
  });

  it("大小写一致的「自身内部」仍然被拒绝（回归）", async () => {
    const { fs, backend } = build();
    fs.seedDirectory("Docs");
    await expect(backend.move("Docs", "Docs/子")).rejects.toThrow("不能将文件夹移动到自身内部");
    expect(fs.has("Docs/子")).toBe(false);
  });

  it("移动失败只回滚本次创建的目标，源与其它文件都不受影响", async () => {
    const { fs, backend } = build({ caseInsensitive: true });
    fs.seedFile("a.md", "源内容");
    fs.seedFile("b/已有的.md", "别人的文件");
    fs.failWrites(1);
    await expect(backend.move("a.md", "b/新.md")).rejects.toThrow("存储空间不足");
    expect(fs.readText("a.md")).toBe("源内容");
    expect(fs.readText("b/已有的.md")).toBe("别人的文件");
    expect(fs.paths("file").filter((path) => path.startsWith("b/新"))).toEqual([]);
  });

  it("移动不存在的源文件时报中文找不到，且不创建目标", async () => {
    const { fs, backend } = build();
    fs.seedFile("b/已有的.md", "别人的文件");
    await expect(backend.move("缺失.md", "b/新.md")).rejects.toThrow(/^找不到：缺失\.md$/);
    expect(fs.paths("file")).toEqual(["b/已有的.md"]);
  });

  it("正常移动文件与目录都保留内容", async () => {
    const { fs, backend } = build();
    fs.seedFile("故事/第一章.md", "# 第一章");
    fs.seedFile("故事/assets/封面.png", "pixels");
    await backend.move("故事", "归档/故事");
    expect(fs.readText("归档/故事/第一章.md")).toBe("# 第一章");
    expect(fs.readText("归档/故事/assets/封面.png")).toBe("pixels");
    expect(fs.paths("file").some((path) => path.startsWith("故事/"))).toBe(false);
  });
});

describe("写入路径的原子性与流释放（D21 / D37）", () => {
  it("覆盖已有文件时写入失败 → 原内容保留、无临时文件残留", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "ORIGINAL");
    fs.failWrites(1);
    const failure = await backend.writeText("笔记.md", "NEW").then(
      () => null,
      (error: Error) => error,
    );
    // 修复前 createWritable() 直接截断目标文件，这里会读到 ""
    expect(fs.readText("笔记.md")).toBe("ORIGINAL");
    expect(failure?.message).toMatch(/^存储空间不足，无法写入：笔记\.md$/);
    expect(fs.paths()).toEqual(["笔记.md"]);
  });

  it("writeBytes 同样先写临时文件，失败时不破坏原文件", async () => {
    const { fs, backend } = build();
    fs.seedFile("assets/a.png", "PIXELS");
    fs.failWrites(1);
    const failure = await backend.writeBytes("assets/a.png", new Uint8Array([1, 2, 3])).then(
      () => null,
      (error: Error) => error,
    );
    expect(fs.readText("assets/a.png")).toBe("PIXELS");
    expect(failure?.message).toMatch(/^存储空间不足/);
    expect(fs.paths("file")).toEqual(["assets/a.png"]);
  });

  it("成功覆盖走「临时文件 + 替换」，最终内容正确且不留临时文件", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "ORIGINAL");
    await backend.writeText("笔记.md", "NEW");
    expect(fs.readText("笔记.md")).toBe("NEW");
    expect(fs.paths()).toEqual(["笔记.md"]);
    expect(fs.events.some((event) => event.includes(".opennote-"))).toBe(true);
  });

  it("写入失败时 abort() 放弃半成品并 close() 释放流", async () => {
    const { fs, backend } = build();
    fs.failWrites(1);
    const failure = await backend.writeText("笔记.md", "NEW").then(
      () => null,
      (error: Error) => error,
    );
    expect(failure?.message).toMatch(/^存储空间不足/);
    // 修复前失败路径既不 abort 也不 close
    expect(fs.events.some((event) => event.startsWith("abort:") && event.includes("笔记.md"))).toBe(true);
    expect(fs.events.some((event) => event.startsWith("close:") && event.includes("笔记.md"))).toBe(true);
    expect(fs.paths()).toEqual([]);
  });

  it("成功写入同样会 close() 提交", async () => {
    const { fs, backend } = build();
    await backend.writeText("笔记.md", "NEW");
    expect(fs.events).toContain("close:笔记.md");
    expect(fs.events).not.toContain("abort:笔记.md");
    expect(fs.readText("笔记.md")).toBe("NEW");
  });

  it("临时文件以 . 开头（对 library 是隐藏文件），且不动磁盘上的同名残骸", async () => {
    const { fs, backend } = build();
    fs.seedFile("笔记.md", "ORIGINAL");
    fs.seedFile(".笔记.md.opennote-上次留下的.tmp", "someone else");
    await backend.writeText("笔记.md", "NEW");
    expect(fs.readText("笔记.md")).toBe("NEW");
    expect(fs.readText(".笔记.md.opennote-上次留下的.tmp")).toBe("someone else");
    expect(fs.events.some((event) => /^open:\.笔记\.md\.opennote-.+\.tmp$/.test(event))).toBe(true);
    expect(isHiddenPath(".笔记.md.opennote-x1y2.tmp")).toBe(true);
  });
});
