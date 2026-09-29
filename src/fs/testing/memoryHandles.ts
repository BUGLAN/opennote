/**
 * 仅测试使用的内存版 `FileSystemDirectoryHandle` 树（不会被应用代码导入）。
 *
 * 行为刻意贴近真实 File System Access API，否则测试就证明不了什么：
 * - 缺失条目 → `NotFoundError`；文件/目录类型不符 → `TypeMismatchError`；
 *   非空目录且未加 `recursive` → `InvalidModificationError`。
 * - `createWritable()` 打开即截断目标（审计 D21 采用的悲观语义），
 *   因此「写失败是否毁掉原文件」是可观测的。
 * - `abort()` 之后 `close()` 抛 `InvalidStateError`（真实引擎同样如此）。
 * - `caseInsensitive: true` 模拟 Windows / macOS 的磁盘（D30 / D34）。
 */
import { baseName, joinPath, normalizePath, parentPath } from "../paths";

type StoredContent = string | Uint8Array;

interface FileNode {
  kind: "file";
  content: StoredContent;
  lastModified: number;
}

interface DirectoryNode {
  kind: "directory";
}

type Node = FileNode | DirectoryNode;

export interface MemoryFileSystemOptions {
  /** 模拟 Windows / macOS 的大小写不敏感磁盘。 */
  caseInsensitive?: boolean;
}

async function toStoredContent(data: unknown): Promise<StoredContent> {
  if (typeof data === "string") return data;
  if (data instanceof Blob) return new Uint8Array(await data.arrayBuffer());
  if (data instanceof Uint8Array) return data.slice();
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer as ArrayBuffer, data.byteOffset, data.byteLength).slice();
  }
  return String(data);
}

function bytesOf(content: StoredContent): Uint8Array {
  return typeof content === "string" ? new TextEncoder().encode(content) : content;
}

export class MemoryFileSystem {
  readonly caseInsensitive: boolean;
  /** 关键调用的轨迹：`open:` / `write:` / `close:` / `abort:` + 路径。 */
  readonly events: string[] = [];
  private readonly nodes = new Map<string, Node>();
  private pendingWriteFailures: { count: number; name: string } | null = null;

  constructor(options: MemoryFileSystemOptions = {}) {
    this.caseInsensitive = options.caseInsensitive ?? false;
    this.nodes.set("", { kind: "directory" });
  }

  get root(): FileSystemDirectoryHandle {
    return new MemoryDirectoryHandle(this, "", "") as unknown as FileSystemDirectoryHandle;
  }

  /** 模拟「配额 / 磁盘满」：接下来 count 次 `write()` 直接抛错。 */
  failWrites(count = 1, name = "QuotaExceededError"): void {
    this.pendingWriteFailures = { count, name };
  }

  seedFile(path: string, content: StoredContent): void {
    const normalized = normalizePath(path);
    this.seedDirectory(parentPath(normalized));
    this.nodes.set(normalized, { kind: "file", content, lastModified: Date.now() });
  }

  seedDirectory(path: string): void {
    const normalized = normalizePath(path);
    if (!normalized || this.nodes.has(normalized)) return;
    this.seedDirectory(parentPath(normalized));
    this.nodes.set(normalized, { kind: "directory" });
  }

  readFile(path: string): StoredContent | undefined {
    const key = this.resolve(path);
    if (key === null) return undefined;
    const node = this.nodes.get(key);
    return node?.kind === "file" ? node.content : undefined;
  }

  readText(path: string): string | undefined {
    const content = this.readFile(path);
    if (content === undefined) return undefined;
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  }

  /** 按当前大小写策略解析到真实存储路径；缺失返回 null。 */
  resolve(path: string): string | null {
    const normalized = normalizePath(path);
    if (normalized === "") return "";
    if (!this.caseInsensitive) return this.nodes.has(normalized) ? normalized : null;
    const folded = normalized.toLowerCase();
    for (const key of this.nodes.keys()) {
      if (key.toLowerCase() === folded) return key;
    }
    return null;
  }

  paths(kind?: "file" | "directory"): string[] {
    return [...this.nodes.entries()]
      .filter(([path, node]) => path !== "" && (!kind || node.kind === kind))
      .map(([path]) => path)
      .sort();
  }

  has(path: string): boolean {
    return this.resolve(path) !== null;
  }

  node(path: string): Node | null {
    const key = this.resolve(path);
    if (key === null) return null;
    return this.nodes.get(key) ?? null;
  }

  /** 目录里真实存储的名字（大小写不敏感时可能与请求的名字不同）。 */
  actualName(dirPath: string, name: string): string | null {
    const resolved = this.resolve(joinPath(dirPath, name));
    if (resolved === null) return null;
    return resolved === "" ? "" : baseName(resolved);
  }

  children(dirPath: string): string[] {
    const actual = this.resolve(dirPath);
    if (actual === null) return [];
    return [...this.nodes.keys()]
      .filter((path) => path !== "" && parentPath(path) === actual)
      .sort();
  }

  createDirectory(dirPath: string, name: string): string {
    const path = joinPath(dirPath, name);
    const existing = this.resolve(path);
    if (existing !== null) return existing;
    this.nodes.set(path, { kind: "directory" });
    return path;
  }

  createFile(dirPath: string, name: string): string {
    const path = joinPath(dirPath, name);
    const existing = this.resolve(path);
    if (existing !== null) return existing;
    this.nodes.set(path, { kind: "file", content: "", lastModified: Date.now() });
    return path;
  }

  removeTree(path: string): void {
    const actual = this.resolve(path);
    if (actual === null) return;
    for (const key of [...this.nodes.keys()]) {
      if (key === actual || key.startsWith(`${actual}/`)) this.nodes.delete(key);
    }
  }

  setContent(path: string, content: StoredContent): void {
    const key = this.resolve(path);
    if (key === null || this.nodes.get(key)?.kind !== "file") return;
    this.nodes.set(key, { kind: "file", content, lastModified: Date.now() });
  }

  truncate(path: string): void {
    this.setContent(path, "");
  }

  /** @internal 供 MemoryWritable 使用。 */
  takeWriteFailure(): string | null {
    const pending = this.pendingWriteFailures;
    if (!pending || pending.count <= 0) return null;
    pending.count -= 1;
    if (pending.count <= 0) this.pendingWriteFailures = null;
    return pending.name;
  }
}

class MemoryDirectoryHandle {
  readonly kind = "directory" as const;

  constructor(
    readonly fs: MemoryFileSystem,
    readonly name: string,
    readonly path: string,
  ) {}

  async queryPermission(): Promise<"granted"> {
    return "granted";
  }

  async requestPermission(): Promise<"granted"> {
    return "granted";
  }

  /** 同一棵树的同一路径才算同一个条目（不同 MemoryFileSystem 的根路径都是 ""）。 */
  async isSameEntry(other: { path?: string; fs?: MemoryFileSystem }): Promise<boolean> {
    return other?.path === this.path && other.fs === this.fs;
  }

  async getDirectoryHandle(name: string, options?: { create?: boolean }): Promise<MemoryDirectoryHandle> {
    const node = this.fs.node(joinPath(this.path, name));
    if (node) {
      if (node.kind !== "directory") throw new DOMException(`dir ${name} is a file`, "TypeMismatchError");
      const actual = this.fs.actualName(this.path, name) ?? name;
      return new MemoryDirectoryHandle(this.fs, actual, joinPath(this.path, actual));
    }
    if (!options?.create) throw new DOMException(`dir ${name} not found`, "NotFoundError");
    const created = this.fs.createDirectory(this.path, name);
    return new MemoryDirectoryHandle(this.fs, baseName(created), created);
  }

  async getFileHandle(name: string, options?: { create?: boolean }): Promise<MemoryFileHandle> {
    const node = this.fs.node(joinPath(this.path, name));
    if (node) {
      if (node.kind !== "file") throw new DOMException(`file ${name} is a directory`, "TypeMismatchError");
      const actual = this.fs.actualName(this.path, name) ?? name;
      return new MemoryFileHandle(this.fs, actual, joinPath(this.path, actual));
    }
    if (!options?.create) throw new DOMException(`file ${name} not found`, "NotFoundError");
    const created = this.fs.createFile(this.path, name);
    return new MemoryFileHandle(this.fs, baseName(created), created);
  }

  async removeEntry(name: string, options?: { recursive?: boolean }): Promise<void> {
    const actual = this.fs.actualName(this.path, name);
    if (actual === null) throw new DOMException(`entry ${name} not found`, "NotFoundError");
    const full = joinPath(this.path, actual);
    if (this.fs.node(full)?.kind === "directory" && this.fs.children(full).length > 0 && !options?.recursive) {
      throw new DOMException(`dir ${name} not empty`, "InvalidModificationError");
    }
    this.fs.removeTree(full);
  }

  async *entries(): AsyncGenerator<[string, FileSystemHandle]> {
    for (const path of this.fs.children(this.path)) {
      const name = baseName(path);
      const node = this.fs.node(path);
      const handle =
        node?.kind === "directory"
          ? (new MemoryDirectoryHandle(this.fs, name, path) as unknown as FileSystemHandle)
          : (new MemoryFileHandle(this.fs, name, path) as unknown as FileSystemHandle);
      yield [name, handle];
    }
  }

  async *keys(): AsyncGenerator<string> {
    for (const path of this.fs.children(this.path)) yield baseName(path);
  }
}

class MemoryFileHandle {
  readonly kind = "file" as const;

  constructor(
    readonly fs: MemoryFileSystem,
    readonly name: string,
    readonly path: string,
  ) {}

  async isSameEntry(other: { path?: string; fs?: MemoryFileSystem }): Promise<boolean> {
    return other?.path === this.path && other.fs === this.fs;
  }

  async getFile(): Promise<File> {
    const node = this.fs.node(this.path);
    if (node?.kind !== "file") throw new DOMException(`file ${this.name} not found`, "NotFoundError");
    const { content, lastModified } = node;
    const bytes = bytesOf(content);
    return {
      name: this.name,
      size: bytes.byteLength,
      lastModified,
      type: "",
      text: async () => (typeof content === "string" ? content : new TextDecoder().decode(content)),
      arrayBuffer: async () => bytes.slice().buffer,
    } as unknown as File;
  }

  async createWritable(): Promise<FileSystemWritableFileStream> {
    this.fs.events.push(`open:${this.path}`);
    this.fs.truncate(this.path);
    return new MemoryWritable(this.fs, this.path) as unknown as FileSystemWritableFileStream;
  }
}

class MemoryWritable {
  private aborted = false;

  constructor(
    private readonly fs: MemoryFileSystem,
    private readonly path: string,
  ) {}

  async write(data: unknown): Promise<void> {
    this.fs.events.push(`write:${this.path}`);
    const failure = this.fs.takeWriteFailure();
    if (failure) throw new DOMException(`simulated write failure (${failure})`, failure);
    this.fs.setContent(this.path, await toStoredContent(data));
  }

  async close(): Promise<void> {
    this.fs.events.push(`close:${this.path}`);
    if (this.aborted) throw new DOMException("The file writer has been aborted", "InvalidStateError");
  }

  async abort(): Promise<void> {
    this.fs.events.push(`abort:${this.path}`);
    this.aborted = true;
  }

  async seek(): Promise<void> {
    /* 全部写入都是一次性整文件写入，无需实现游标 */
  }

  async truncate(): Promise<void> {
    this.fs.truncate(this.path);
  }
}
