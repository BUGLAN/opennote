/**
 * 测试用内存后端：`FileSystemBackend` 的最小可用实现。
 *
 * 与 `src/data/library.files.test.ts` 里的同名类保持同一套语义，另外补三件本模块测试
 * 需要的事：①按字节存（前像必须逐字节相等）；②`move` 覆盖目标（真实后端的行为是
 * 「不覆盖」，但 `trashNote` 这类既有路径依赖 move 到新路径，测试里不必复刻这个边界）；
 * ③`denyWrite` 前缀，用来模拟 `.opennote/` 只读 / 磁盘满（`IMP-W008` 的降级路径）。
 */

import { baseName, parentPath } from "../../../fs/paths";
import type { EntryInfo, FileSystemBackend } from "../../../fs/types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class MemoryBackend implements FileSystemBackend {
  readonly kind = "node";
  readonly label = "本机磁盘";
  readonly canWrite = true;
  readonly dirs = new Set<string>([""]);
  readonly files = new Map<string, Uint8Array>();
  /** 调用轨迹，测试用它断言「走没走磁盘探测」。 */
  readonly calls: string[] = [];
  /** 命中这些前缀的写入一律失败（模拟只读 / ENOSPC）。 */
  readonly denyWrite = new Set<string>();
  private clock = 1_700_000_000_000;
  /** 每个文件自己的 mtime：库层的「外部改动」判定会比对 stat，不能共用一个全局时钟。 */
  private readonly stamps = new Map<string, number>();

  seed(path: string, text: string): void {
    this.seedBytes(path, encoder.encode(text));
  }

  seedBytes(path: string, bytes: Uint8Array): void {
    this.mkdirSync(parentPath(path));
    this.files.set(path, bytes);
    this.clock += 1000;
    this.stamps.set(path, this.clock);
  }

  text(path: string): string | null {
    const bytes = this.files.get(path);
    return bytes ? decoder.decode(bytes) : null;
  }

  bytes(path: string): Uint8Array | null {
    return this.files.get(path) ?? null;
  }

  private mkdirSync(path: string): void {
    if (!path || this.dirs.has(path)) return;
    this.mkdirSync(parentPath(path));
    this.dirs.add(path);
  }

  private assertWritable(path: string): void {
    for (const prefix of this.denyWrite) {
      if (path === prefix || path.startsWith(`${prefix}/`)) throw new Error(`EACCES ${path}`);
    }
  }

  async mkdir(path: string): Promise<void> {
    this.assertWritable(path);
    this.calls.push(`mkdir:${path}`);
    this.mkdirSync(path);
  }

  async list(path: string): Promise<EntryInfo[]> {
    this.calls.push(`list:${path}`);
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const dirs = [...this.dirs]
      .filter((candidate) => candidate && parentPath(candidate) === path)
      .map((candidate) => ({ name: baseName(candidate), kind: "directory" as const, size: 0, mtimeMs: this.clock }));
    const files = [...this.files]
      .filter(([candidate]) => parentPath(candidate) === path)
      .map(([candidate, value]) => ({
        name: baseName(candidate),
        kind: "file" as const,
        size: value.byteLength,
        mtimeMs: this.stamps.get(candidate) ?? this.clock,
      }));
    return [...dirs, ...files];
  }

  async readText(path: string): Promise<string> {
    this.calls.push(`readText:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return decoder.decode(value);
  }

  async readBytes(path: string): Promise<Uint8Array> {
    this.calls.push(`readBytes:${path}`);
    const value = this.files.get(path);
    if (value === undefined) throw new Error(`ENOENT ${path}`);
    return value;
  }

  async writeText(path: string, text: string): Promise<void> {
    this.calls.push(`writeText:${path}`);
    this.assertWritable(path);
    this.mkdirSync(parentPath(path));
    this.files.set(path, encoder.encode(text));
    this.clock += 1000;
    this.stamps.set(path, this.clock);
  }

  async writeBytes(path: string, data: Uint8Array | Blob): Promise<void> {
    this.calls.push(`writeBytes:${path}`);
    this.assertWritable(path);
    this.mkdirSync(parentPath(path));
    this.files.set(path, data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data);
    this.clock += 1000;
    this.stamps.set(path, this.clock);
  }

  async exists(path: string): Promise<boolean> {
    this.calls.push(`exists:${path}`);
    return this.dirs.has(path) || this.files.has(path);
  }

  async stat(path: string): Promise<{ size: number; mtimeMs: number } | null> {
    const value = this.files.get(path);
    return value === undefined ? null : { size: value.byteLength, mtimeMs: this.stamps.get(path) ?? this.clock };
  }

  async move(from: string, to: string): Promise<void> {
    this.calls.push(`move:${from}->${to}`);
    this.assertWritable(to);
    this.mkdirSync(parentPath(to));
    const file = this.files.get(from);
    if (file !== undefined) {
      this.files.delete(from);
      this.files.set(to, file);
      const stamp = this.stamps.get(from);
      this.stamps.delete(from);
      if (stamp !== undefined) this.stamps.set(to, stamp);
      return;
    }
    if (!this.dirs.has(from)) throw new Error(`ENOENT ${from}`);
    for (const [path, value] of [...this.files]) {
      if (path.startsWith(`${from}/`)) {
        this.files.delete(path);
        this.files.set(`${to}${path.slice(from.length)}`, value);
      }
    }
    for (const path of [...this.dirs].filter((dir) => dir === from || dir.startsWith(`${from}/`))) {
      this.dirs.delete(path);
      this.dirs.add(`${to}${path.slice(from.length)}`);
    }
  }

  async remove(path: string, options?: { recursive?: boolean }): Promise<void> {
    this.calls.push(`remove:${path}`);
    if (this.files.delete(path)) {
      this.stamps.delete(path);
      return;
    }
    if (!this.dirs.has(path)) throw new Error(`ENOENT ${path}`);
    const hasChildren = [...this.files.keys(), ...this.dirs].some((entry) => entry.startsWith(`${path}/`));
    if (hasChildren && !options?.recursive) throw new Error(`ENOTEMPTY ${path}`);
    for (const entry of [...this.files.keys()]) {
      if (entry.startsWith(`${path}/`)) {
        this.files.delete(entry);
        this.stamps.delete(entry);
      }
    }
    for (const entry of [...this.dirs]) if (entry === path || entry.startsWith(`${path}/`)) this.dirs.delete(entry);
  }

  /** 工作区里所有笔记路径（按字典序），断言「没有多写文件」用。 */
  paths(): string[] {
    return [...this.files.keys()].sort();
  }
}
