import { currentBackend } from "../data/library";
import { joinPath, parentPath } from "../fs/paths";
import { inlineHtmlResources } from "./bundle";

/**
 * 渲染前把工作区里的散装资源内联进页面：入库产物本来就是单文件（这一步什么都不读），
 * 只有「用户手工把整个目录拷进笔记本」的页面才会真的读盘。
 *
 * 资源根 = 页面所在目录：`resolveLocalRef` 不许 `..` 越过它、不许点开头的段、只认白名单
 * 扩展名 —— 页面读不到笔记本里别处的笔记（见 `bundle.ts` 文件头的安全边界）。
 * 读盘失败一律当「取不到」：页面照样渲染，只是缺那份资源，与浏览器里 404 的表现一致。
 */
export async function inlineWorkspaceHtml(notePath: string, html: string): Promise<string> {
  const backend = currentBackend();
  if (!backend) return html;
  const dir = parentPath(notePath);
  const result = await inlineHtmlResources(html, {
    resolve: async (path) => {
      const bytes = await backend.readBytes(joinPath(dir, path)).catch(() => null);
      return bytes ? { bytes, mime: "" } : null;
    },
  });
  return result.html;
}
