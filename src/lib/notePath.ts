/**
 * 「这篇笔记 / 这个文件夹在本机磁盘上的绝对位置」——**全仓只有这一个产地**。
 *
 * 三个调用点必须算出逐字相同的字符串：标签右键菜单的「在文件夹中显示」、
 * 「复制地址」，以及文件树（笔记行 / 文件夹行）右键菜单的「复制地址」。
 * 一旦这里出现第二份实现，就会出现「复制出来的地址」和「在文件夹中显示打开的位置」
 * 不是同一个文件 —— 两边都是 `string`，编译期一个字都不报。
 *
 * 只有 `node` 笔记本（桌面版打开的本机文件夹）才有绝对路径。浏览器笔记本的
 * `fsa` 记录里 `location` 是 IndexedDB 的句柄 key（uid）、`opfs` 是浏览器私有
 * 文件系统里的目录名，**都不是路径**；所以这两类一律返回 `null`，由调用方
 * 禁用菜单项，而不是拼一个看起来像路径的东西糊弄用户。
 */

import type { Id } from "../data/types";
import type { WorkspaceRecord } from "../data/workspaces";
import { notify } from "./toast";

/** 把工作区根与工作区相对路径拼成本机绝对路径（沿用根目录自己的分隔符）。 */
export function absolutePathOf(root: string, relative: string): string {
  const separator = root.includes("\\") ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${relative.split("/").join(separator)}`;
}

/**
 * 笔记 / 文件夹的绝对路径；非本机磁盘笔记本（浏览器、OPFS）返回 `null`。
 *
 * `id` 就是工作区相对路径（回收站里的笔记是 `.opennote/trash/<原路径>`，
 * 仍然真实存在），所以这里不需要知道它是笔记还是文件夹。
 */
export function noteAbsolutePath(workspace: WorkspaceRecord | null | undefined, id: Id): string | null {
  if (!workspace || workspace.kind !== "node" || !workspace.location) return null;
  return absolutePathOf(workspace.location, id);
}

/**
 * 复制地址到系统剪贴板。
 *
 * 桌面版是 `file://`（安全上下文），`navigator.clipboard` 可用；浏览器版走
 * localhost 也是安全上下文。被拒绝时**如实报错**，不假装成功 —— 用户拿到的
 * 是一句「拒绝了剪贴板访问」，而不是一个空剪贴板加一句「已复制」。
 */
export async function copyPathToClipboard(workspace: WorkspaceRecord | null | undefined, id: Id): Promise<void> {
  const absolute = noteAbsolutePath(workspace, id);
  if (!absolute) {
    notify("这个笔记本在浏览器里，没有本机路径可复制", { kind: "danger" });
    return;
  }
  try {
    await navigator.clipboard.writeText(absolute);
    notify("已复制地址");
  } catch {
    notify("浏览器拒绝了剪贴板访问", { kind: "danger" });
  }
}
