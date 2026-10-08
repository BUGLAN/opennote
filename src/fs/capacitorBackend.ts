import { Capacitor } from "@capacitor/core";
import { Directory, Encoding, Filesystem } from "@capacitor/filesystem";
import { notFoundError } from "./io";
import { assertSafeRelative, baseName, joinPath, parentPath, sanitizeName } from "./paths";
import type { EntryInfo, FileSystemBackend } from "./types";

/**
 * 移动端后端（Capacitor 打包，路线 B）：WebView 里通过 `@capacitor/filesystem`
 * 读写原生文件系统。工作区是 `Documents/OpenNote/<笔记本名>`：
 *
 * - iOS 上 `Directory.Documents` 是 App 沙盒的 Documents 目录，配两个 plist 键
 *   （`UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace`）后可以直接在
 *   系统「文件」App 里看到每一篇笔记；
 * - Android 上是公共 Documents 下的 `OpenNote/` 文件夹（Android 11+ 只能访问
 *   自己创建的文件，这正是文档里「任意文件夹要打折」的那条限制，SAF 是后续工作）。
 *
 * 错误语义与 `handleBackend`（D33）一致：缺失路径抛中文「找不到：<path>」，
 * `remove('')` 拒绝删除工作区根目录，`remove` 缺失路径视为成功，
 * `exists('')` 恒真，`stat` 对目录 / 缺失路径返回 `null`。
 */

/** 所有手机笔记本共同的上层文件夹（Documents/OpenNote/<名字>）。 */
export const CAPACITOR_NOTES_ROOT = "OpenNote";

/** 是否运行在 Capacitor 原生壳里（Web / Electron / 测试环境都是 false）。 */
export function isCapacitorNative(): boolean {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/**
 * Android ≤10 需要运行时存储权限；11+ 对「App 自己创建的文件」不需要，
 * `requestPermissions()` 会直接返回已授权，不会弹窗。
 */
export async function ensureCapacitorPermissions(): Promise<void> {
  if (!isCapacitorNative()) return;
  await Filesystem.requestPermissions();
}

/** 工作区根目录（Documents/OpenNote/<name>），需要时逐级创建。 */
export async function capacitorWorkspaceDir(name: string, create = true): Promise<string> {
  const root = joinPath(CAPACITOR_NOTES_ROOT, sanitizeName(name, "笔记"));
  if (create) {
    await Filesystem.mkdir({ path: root, directory: Directory.Documents, recursive: true }).catch(() => undefined);
  }
  return root;
}

/**
 * Capacitor 的原生报错是英文普通 `Error`（"… does not exist." 等，见插件的
 * `FilesystemErrors.kt`），不是 DOMException，`toUserError` 认不出它们，这里按
 * 消息特征翻译成与桌面端一致的中文（D33）。
 */
function translate(error: unknown, relPath: string, expected?: "file" | "directory"): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/does not exist|no such file|not found|enoent/i.test(message)) return notFoundError(relPath);
  if (/not supported for director|is a directory/i.test(message)) {
    return new Error(expected === "file" ? `不是文件：${relPath}` : `路径类型不匹配：${relPath}`);
  }
  if (/not supported for files|not a directory/i.test(message)) {
    return new Error(expected === "directory" ? `不是文件夹：${relPath}` : `路径类型不匹配：${relPath}`);
  }
  if (/denied|permission|eacces/i.test(message)) return new Error(`没有权限访问：${relPath}`);
  if (/cannot delete directory with children|not empty/i.test(message)) {
    return new Error(`文件夹不是空的：${relPath}`);
  }
  if (/space|enospc|quota/i.test(message)) return new Error(`存储空间不足，无法写入：${relPath}`);
  return error instanceof Error ? error : new Error(`操作失败：${relPath}`);
}

/* ------------------------------------------------------------------ base64 */

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function bytesOf(relPath: string): Promise<Uint8Array> {
  const result = await Filesystem.readFile({ path: relPath, directory: Directory.Documents });
  const data = result.data;
  if (typeof data === "string") return base64ToBytes(data);
  return new Uint8Array(await data.arrayBuffer());
}

/** 移动端上的完整原生路径 = Documents + 根文件夹 + 工作区相对路径。 */
export function createCapacitorBackend(root: string): FileSystemBackend {
  const full = (relPath: string): string => joinPath(root, relPath);

  return {
    kind: "capacitor",
    label: "手机文件夹",
    canWrite: true,

    async list(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        const { files } = await Filesystem.readdir({ path: full(safe), directory: Directory.Documents });
        const infos: EntryInfo[] = files.map((file) => ({
          name: file.name,
          kind: file.type,
          size: file.size ?? 0,
          // 契约是毫秒时间戳；老版本插件在部分平台上给秒，统一拉到毫秒量级
          mtimeMs: file.mtime && file.mtime < 1e11 ? file.mtime * 1000 : (file.mtime ?? 0),
        }));
        return infos.sort(
          (a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name, "zh-Hans-CN") : a.kind === "directory" ? -1 : 1),
        );
      } catch (error) {
        throw translate(error, safe, "directory");
      }
    },

    async readText(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        const result = await Filesystem.readFile({
          path: full(safe),
          directory: Directory.Documents,
          encoding: Encoding.UTF8,
        });
        if (typeof result.data !== "string") throw new Error(`不是文件：${safe}`);
        return result.data;
      } catch (error) {
        throw translate(error, safe, "file");
      }
    },

    async readBytes(relPath) {
      const safe = assertSafeRelative(relPath);
      try {
        return await bytesOf(full(safe));
      } catch (error) {
        throw translate(error, safe, "file");
      }
    },

    async writeText(relPath, text) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("缺少文件名");
      try {
        await Filesystem.writeFile({
          path: full(safe),
          directory: Directory.Documents,
          data: text,
          encoding: Encoding.UTF8,
          recursive: true,
        });
      } catch (error) {
        throw translate(error, safe, "file");
      }
    },

    async writeBytes(relPath, data) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("缺少文件名");
      try {
        const payload = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : data;
        await Filesystem.writeFile({
          path: full(safe),
          directory: Directory.Documents,
          data: bytesToBase64(payload),
          recursive: true,
        });
      } catch (error) {
        throw translate(error, safe, "file");
      }
    },

    async mkdir(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return;
      try {
        await Filesystem.mkdir({ path: full(safe), directory: Directory.Documents, recursive: true });
      } catch (error) {
        // 已存在不算失败（与 handleBackend 的 getDirectoryHandle(create) 对齐）
        const message = error instanceof Error ? error.message : String(error);
        if (/exists/i.test(message)) return;
        throw translate(error, safe, "directory");
      }
    },

    async remove(relPath, options) {
      const safe = assertSafeRelative(relPath);
      if (!safe) throw new Error("不能删除笔记本根目录");
      try {
        const entry = await Filesystem.stat({ path: full(safe), directory: Directory.Documents });
        if (entry.type === "directory") {
          await Filesystem.rmdir({
            path: full(safe),
            directory: Directory.Documents,
            recursive: options?.recursive ?? false,
          });
        } else {
          await Filesystem.deleteFile({ path: full(safe), directory: Directory.Documents });
        }
      } catch (error) {
        // 与桌面端 rm(force:true) 一致：删除一个不存在的路径视为成功
        const message = error instanceof Error ? error.message : String(error);
        if (/does not exist|no such file|not found/i.test(message)) return;
        throw translate(error, safe, "directory");
      }
    },

    async move(from, to) {
      const source = assertSafeRelative(from);
      const target = assertSafeRelative(to);
      if (!source || !target) throw new Error("不能移动笔记本根目录");
      // 与 handleBackend 相同的折叠比较：只改大小写的重命名由数据层的两步 move 完成
      if (source.toLowerCase() === target.toLowerCase()) return;
      if (target.toLowerCase().startsWith(`${source.toLowerCase()}/`)) throw new Error("不能将文件夹移动到自身内部");
      try {
        const entry = await Filesystem.stat({ path: full(source), directory: Directory.Documents });
        if (!entry) throw notFoundError(source);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/does not exist|no such file|not found/i.test(message)) throw notFoundError(source);
        throw translate(error, source);
      }
      let existing: Awaited<ReturnType<typeof Filesystem.stat>> | null = null;
      try {
        existing = await Filesystem.stat({ path: full(target), directory: Directory.Documents });
      } catch {
        existing = null;
      }
      if (existing) throw new Error(`目标路径已存在：${target}`);
      try {
        await Filesystem.mkdir({
          path: full(parentPath(target)),
          directory: Directory.Documents,
          recursive: true,
        }).catch(() => undefined);
        await Filesystem.rename({
          from: full(source),
          to: full(target),
          directory: Directory.Documents,
          toDirectory: Directory.Documents,
        });
      } catch (error) {
        throw translate(error, source);
      }
    },

    async exists(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return true;
      try {
        await Filesystem.stat({ path: full(safe), directory: Directory.Documents });
        return true;
      } catch {
        return false;
      }
    },

    async stat(relPath) {
      const safe = assertSafeRelative(relPath);
      if (!safe) return null;
      try {
        const entry = await Filesystem.stat({ path: full(safe), directory: Directory.Documents });
        // 与 handleBackend 一致：目录元数据不做保证，判定存在请用 exists()
        if (entry.type !== "file") return null;
        const mtimeMs = entry.mtime && entry.mtime < 1e11 ? entry.mtime * 1000 : (entry.mtime ?? 0);
        return { size: entry.size ?? 0, mtimeMs };
      } catch {
        return null;
      }
    },
  } satisfies FileSystemBackend;
}

/** 供 UI 文案使用：移动端笔记本在文件管理器里的位置。 */
export function capacitorWorkspaceHint(name: string): string {
  return `${CAPACITOR_NOTES_ROOT}/${baseName(sanitizeName(name))}`;
}
