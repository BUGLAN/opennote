/** File System Access API helpers (Chromium): a real folder on the user's disk. */

export function supportsFileSystemAccess(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export async function pickDirectory(): Promise<FileSystemDirectoryHandle | null> {
  if (!supportsFileSystemAccess()) return null;
  try {
    const picker = (window as unknown as {
      showDirectoryPicker(options?: { mode?: "read" | "readwrite"; id?: string }): Promise<FileSystemDirectoryHandle>;
    }).showDirectoryPicker;
    return await picker({ mode: "readwrite", id: "opennote-workspace" });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return null;
    throw error;
  }
}

type PermissionState = "granted" | "denied" | "prompt";

interface PermissionCapable {
  queryPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
  requestPermission?(options: { mode: "read" | "readwrite" }): Promise<PermissionState>;
}

export async function hasPermission(handle: FileSystemDirectoryHandle, request = false): Promise<boolean> {
  const capable = handle as unknown as PermissionCapable;
  const options = { mode: "readwrite" as const };
  try {
    if (capable.queryPermission && (await capable.queryPermission(options)) === "granted") return true;
    if (!request) return false;
    if (capable.requestPermission && (await capable.requestPermission(options)) === "granted") return true;
    return false;
  } catch {
    return false;
  }
}

/** Pick a folder anywhere on disk (download fallback when the picker is absent). */
export function pickFiles(options: { directory?: boolean; accept?: string } = {}): Promise<FileList | null> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.multiple = true;
    if (options.accept) input.accept = options.accept;
    if (options.directory) {
      input.setAttribute("webkitdirectory", "");
      input.setAttribute("directory", "");
    }
    input.style.display = "none";
    document.body.appendChild(input);
    input.addEventListener("change", () => {
      const files = input.files;
      input.remove();
      resolve(files);
    });
    input.addEventListener("cancel", () => {
      input.remove();
      resolve(null);
    });
    input.click();
  });
}

export function downloadBytes(bytes: Uint8Array | string, filename: string, mime = "application/octet-stream"): void {
  const blob = typeof bytes === "string" ? new Blob([bytes], { type: "text/plain;charset=utf-8" }) : new Blob([bytes as BlobPart], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}
