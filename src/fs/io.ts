/**
 * Two backends share this plumbing: `handleBackend.ts` (File System Access API
 * and OPFS) and `opfs.ts`. Both talk to the browser's `FileSystemHandle` types,
 * which report failures as English `DOMException`s (`NotFoundError: file x not
 * found`). `notify(error.message)` puts those straight into the Chinese UI, so
 * every DOM error that can reach the user is translated here (D33).
 */

const DOM_ERROR_NAMES = new Set([
  "NotFoundError",
  "NotAllowedError",
  "SecurityError",
  "TypeMismatchError",
  "InvalidModificationError",
  "InvalidStateError",
  "NoModificationAllowedError",
  "QuotaExceededError",
  "AbortError",
  "NotReadableError",
  "UnknownError",
]);

function domErrorName(error: unknown): string | null {
  const name = (error as { name?: unknown } | null | undefined)?.name;
  return typeof name === "string" && DOM_ERROR_NAMES.has(name) ? name : null;
}

export function isDomError(error: unknown, name: string): boolean {
  return domErrorName(error) === name;
}

export function notFoundError(relPath: string): Error {
  return new Error(`找不到：${relPath}`);
}

/**
 * Translate a DOM exception into the wording shared with the Node backend.
 * Errors that are not DOM exceptions (our own Chinese messages, programmer
 * errors) are passed through untouched.
 */
export function toUserError(error: unknown, relPath: string, expected?: "file" | "directory"): Error {
  const name = domErrorName(error);
  if (name === null) return error instanceof Error ? error : new Error(`操作失败：${relPath}`);
  switch (name) {
    case "NotFoundError":
      return notFoundError(relPath);
    case "TypeMismatchError":
      if (expected === "file") return new Error(`不是文件：${relPath}`);
      if (expected === "directory") return new Error(`不是文件夹：${relPath}`);
      return new Error(`路径类型不匹配：${relPath}`);
    case "NotAllowedError":
    case "SecurityError":
      return new Error(`没有权限访问：${relPath}`);
    case "QuotaExceededError":
      return new Error(`存储空间不足，无法写入：${relPath}`);
    case "InvalidModificationError":
      return new Error(`文件夹不是空的：${relPath}`);
    case "InvalidStateError":
    case "NoModificationAllowedError":
      return new Error(`文件正在被占用，无法写入：${relPath}`);
    default:
      return new Error(`操作失败：${relPath}`);
  }
}

/**
 * D37: an opened writable must always be released. `abort()` in the `catch`
 * discards a half-written file, `close()` in the `finally` releases the stream
 * (a `close()` after `abort()` rejects, which is expected and swallowed).
 * Before the fix a quota / disk-full failure skipped both, leaking the swap file.
 */
export async function writeInto(handle: FileSystemFileHandle, data: BlobPart, relPath: string): Promise<void> {
  let writer: FileSystemWritableFileStream;
  try {
    writer = await handle.createWritable();
  } catch (error) {
    throw toUserError(error, relPath);
  }
  let failure: unknown = null;
  try {
    await writer.write(data);
  } catch (error) {
    failure = error;
    try {
      await writer.abort();
    } catch {
      /* abort 不可用 / 已经释放：忽略，保留原始写入错误 */
    }
  } finally {
    try {
      await writer.close();
    } catch (error) {
      // 已经 abort() 过时 close() 必然失败，这不是新问题；成功路径上的 close 失败必须冒泡（提交失败 = 没写入）
      if (failure === null) throw toUserError(error, relPath);
    }
  }
  if (failure !== null) throw toUserError(failure, relPath);
}
