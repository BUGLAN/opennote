import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

/**
 * `electron/zip.cjs` 的正反两测。
 *
 * 正向用 `jszip`（已是渲染层依赖，只在这里当夹具生成器）造真实 zip；
 * 反向（越界名、CRC 不符、截断、ZIP64、加密、未知压缩法）必须**手工拼字节**——
 * 这些正是「库自己会拒绝、所以库造不出来」的形态，也正是解压器唯一的攻击面。
 */
const requireCjs = createRequire(import.meta.url);
const { extract, safeEntryPath, crc32, ZipError } = requireCjs("../../electron/zip.cjs") as {
  extract: (
    zipPath: string,
    destinationDir: string,
    options?: { signal?: AbortSignal; onProgress?: (done: number, total: number) => void },
  ) => Promise<{ entries: number }>;
  safeEntryPath: (name: string) => string | null;
  crc32: (buffer: Buffer) => number;
  ZipError: new (code: string, message: string) => Error & { code: string };
};

const tempDirs: string[] = [];

/** `process.noAsar` 是 Electron 的私有开关，@types/node 里没有，读的时候要显式放宽。 */
function noAsar(): unknown {
  return (process as unknown as { noAsar?: boolean }).noAsar;
}

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opennote-zip-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function writeZip(label: string, build: (zip: JSZip) => void): Promise<string> {
  const zip = new JSZip();
  build(zip);
  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  const file = path.join(tempDir(label), "fixture.zip");
  fs.writeFileSync(file, buffer);
  return file;
}

interface RawEntry {
  name: string;
  data: Buffer;
  /** 覆盖 crc（造「CRC 不符」）；默认按数据真算。 */
  crc?: number;
  /** 覆盖压缩方式（造「未知压缩法」）；默认 0 = store。 */
  method?: number;
  /** 覆盖 flags（造「加密条目」）。 */
  flags?: number;
  /** 覆盖「未压缩大小」（造「大小不符」）。 */
  uncompressedSize?: number;
}

/**
 * 手工拼一个 store 模式的 zip。所有长度都按真实字节算，
 * 这样 `../evil.txt`、错 crc、加密位这些 jszip 不肯生成的形态才造得出来。
 */
function buildRawZip(entries: RawEntry[], overrides: { entryCount?: number } = {}): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const crc = entry.crc ?? crc32(entry.data);
    const method = entry.method ?? 0;
    const flags = entry.flags ?? 0;
    const uncompressedSize = entry.uncompressedSize ?? entry.data.length;

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(entry.data.length, 18);
    local.writeUInt32LE(uncompressedSize, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, entry.data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(entry.data.length, 20);
    central.writeUInt32LE(uncompressedSize, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + entry.data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(overrides.entryCount ?? entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

function writeRawZip(label: string, buffer: Buffer): string {
  const file = path.join(tempDir(label), "raw.zip");
  fs.writeFileSync(file, buffer);
  return file;
}

async function expectZipError(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toSatisfy((error: unknown) => {
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe(code);
    return true;
  });
}

describe("zip 解压 · 正常形态（jszip 造真包）", () => {
  it("store 与 deflate 混装、嵌套目录、空文件都能解出来", async () => {
    const file = await writeZip("mixed", (zip) => {
      zip.file("Opennote.exe", "EXE-BYTES");
      zip.file("locales/zh-CN.pak", "PAK-BYTES".repeat(100));
      zip.file("empty.txt", "");
      zip.folder("resources")?.file("app.asar", "ASAR");
    });
    const out = tempDir("mixed-out");
    const result = await extract(file, out);
    expect(result.entries).toBe(4);
    expect(fs.readFileSync(path.join(out, "Opennote.exe"), "utf8")).toBe("EXE-BYTES");
    expect(fs.readFileSync(path.join(out, "resources", "app.asar"), "utf8")).toBe("ASAR");
    expect(fs.readFileSync(path.join(out, "locales", "zh-CN.pak"), "utf8")).toBe("PAK-BYTES".repeat(100));
    expect(fs.readFileSync(path.join(out, "empty.txt"), "utf8")).toBe("");
  });

  it("中文条目名按 UTF-8 落盘，进度回调按条目数单调递增", async () => {
    const file = await writeZip("utf8", (zip) => {
      zip.file("说明.txt", "内容");
      zip.file("第二.md", "内容二");
    });
    const out = tempDir("utf8-out");
    const progress: number[] = [];
    const result = await extract(file, out, { onProgress: (done) => progress.push(done) });
    expect(result.entries).toBe(2);
    expect(progress).toEqual([1, 2]);
    expect(fs.readFileSync(path.join(out, "说明.txt"), "utf8")).toBe("内容");
  });

  it("safeEntryPath 把目录项判成 null，把越界名判成错误", () => {
    expect(safeEntryPath("locales/")).toBeNull();
    expect(safeEntryPath("./")).toBeNull();
    expect(safeEntryPath("a/b.txt")).toBe(path.join("a", "b.txt"));
    for (const bad of ["../evil.txt", "a/../../evil.txt", "/abs.txt", "C:/abs.txt"]) {
      expect(() => safeEntryPath(bad)).toThrow();
    }
  });

  it("解压期间临时打开 process.noAsar，结束后恢复原值", async () => {
    // 回归：端到端脚本第一次真跑抓到的真缺陷 —— Electron 的 fs 补丁会把
    // `resources/app.asar` 这个**文件名**当归档打开，写它时抛 `Invalid package`，
    // 于是「下载成功 → 解压必失败」。修法是解压期间 process.noAsar = true。
    // 纯 Node 里复现不了 Electron 的补丁行为，但可以咬住「开关确实被打开又恢复」。
    const file = await writeZip("noasar", (zip) => {
      zip.file("resources/app.asar", "ASAR");
    });
    const out = tempDir("noasar-out");
    const before = noAsar();
    let seenDuringExtract: unknown = "未观察";
    await extract(file, out, {
      onProgress: () => {
        seenDuringExtract = noAsar();
      },
    });
    expect(seenDuringExtract).toBe(true);
    expect(noAsar()).toBe(before);
    expect(fs.readFileSync(path.join(out, "resources", "app.asar"), "utf8")).toBe("ASAR");
  });

  it("解压抛错时也会把 process.noAsar 恢复回去", async () => {
    const file = writeRawZip("noasar-err", buildRawZip([{ name: "../evil.txt", data: Buffer.from("x") }]));
    const before = noAsar();
    await expectZipError(extract(file, tempDir("noasar-err-out")), "PATH_TRAVERSAL");
    expect(noAsar()).toBe(before);
  });
});

describe("zip 解压 · 必须拒绝的形态", () => {
  it("条目名带 .. 时拒绝，且目标目录外一个文件都不落", async () => {
    const file = writeRawZip("slip", buildRawZip([{ name: "../evil.txt", data: Buffer.from("PWNED") }]));
    const out = tempDir("slip-out");
    await expectZipError(extract(file, out), "PATH_TRAVERSAL");
    expect(fs.existsSync(path.join(out, "..", "evil.txt"))).toBe(false);
  });

  it("绝对路径条目被拒", async () => {
    const file = writeRawZip("abs", buildRawZip([{ name: "/etc/passwd", data: Buffer.from("x") }]));
    await expectZipError(extract(file, tempDir("abs-out")), "ABSOLUTE_PATH");
  });

  it("CRC 不符被拒（下载损坏必须走到明确错误，不许静默落半成品）", async () => {
    const file = writeRawZip(
      "crc",
      buildRawZip([{ name: "Opennote.exe", data: Buffer.from("REAL"), crc: 0x12345678 }]),
    );
    await expectZipError(extract(file, tempDir("crc-out")), "CRC_MISMATCH");
  });

  it("解压后大小不符被拒", async () => {
    const file = writeRawZip(
      "size",
      buildRawZip([{ name: "a.bin", data: Buffer.from("1234"), uncompressedSize: 999 }]),
    );
    await expectZipError(extract(file, tempDir("size-out")), "SIZE_MISMATCH");
  });

  it("加密条目被拒", async () => {
    const file = writeRawZip(
      "enc",
      buildRawZip([{ name: "a.txt", data: Buffer.from("x"), flags: 0x0001 }]),
    );
    await expectZipError(extract(file, tempDir("enc-out")), "ENCRYPTED");
  });

  it("未知压缩方式被拒", async () => {
    const file = writeRawZip(
      "method",
      buildRawZip([{ name: "a.txt", data: Buffer.from("x"), method: 12 }]),
    );
    await expectZipError(extract(file, tempDir("method-out")), "UNSUPPORTED_METHOD");
  });

  it("ZIP64 标记被拒（而不是错位解析出垃圾）", async () => {
    const file = writeRawZip(
      "zip64",
      buildRawZip([{ name: "a.txt", data: Buffer.from("x") }], { entryCount: 0xffff }),
    );
    await expectZipError(extract(file, tempDir("zip64-out")), "ZIP64");
  });

  it("尾部被截断（EOCD 都没了）被拒", async () => {
    const full = buildRawZip([{ name: "a.txt", data: Buffer.from("hello") }]);
    const file = writeRawZip("truncated", full.subarray(0, full.length - 30));
    await expectZipError(extract(file, tempDir("truncated-out")), "NOT_A_ZIP");
  });

  it("中央目录被截断（EOCD 声明的条目数多于实际）被拒", async () => {
    const file = writeRawZip(
      "cd-truncated",
      buildRawZip([{ name: "a.txt", data: Buffer.from("hello") }], { entryCount: 2 }),
    );
    await expectZipError(extract(file, tempDir("cd-truncated-out")), "TRUNCATED");
  });

  it("不是 zip 的字节被拒", async () => {
    const file = writeRawZip("notzip", Buffer.from("this is not a zip file at all........"));
    await expectZipError(extract(file, tempDir("notzip-out")), "NOT_A_ZIP");
  });

  it("空包被拒（0 条目不算「解压成功」）", async () => {
    const file = writeRawZip("empty", buildRawZip([]));
    await expectZipError(extract(file, tempDir("empty-out")), "EMPTY");
  });

  it("已取消的 signal 让解压以 ABORTED 结束", async () => {
    const file = await writeZip("abort", (zip) => {
      zip.file("big.bin", "x".repeat(1024));
    });
    const controller = new AbortController();
    controller.abort();
    await expectZipError(extract(file, tempDir("abort-out"), { signal: controller.signal }), "ABORTED");
  });

  it("ZipError 带 code，方便上层映射成中文文案", () => {
    const error = new ZipError("CRC_MISMATCH", "压缩包条目校验失败：a.txt");
    expect(error.code).toBe("CRC_MISMATCH");
    expect(error.message).toContain("a.txt");
  });
});
