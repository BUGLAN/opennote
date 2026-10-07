import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import packageJson from "../../package.json";

/**
 * 仓库身份护栏。
 *
 * 为什么值得单独一条：0.6.0 的端到端脚本（`scripts/update-e2e.cjs`）第一次真跑时抓到的
 * **真缺陷**就是这里 —— `package.json` 的 `homepage` 与 `repository.url` 都写着
 * `github.com/opennote/opennote`，而真实仓库是 `github.com/BUGLAN/opennote`。
 * 打包后的 `package.json` 会被更新器读到（`repository.url` 是它判断「去哪问新版本」的唯一产地），
 * 于是「检查更新」在生产里只会拿到一个 404，界面上是一个永远失败的图标。
 *
 * 单测拿不到网络（也不该拿网络），所以这里咬的是**能离线判定**的那部分：
 *   ① `repository.url` 必须能解析出 owner/repo（解析不出来 = 打包后更新功能直接哑掉）；
 *   ② `homepage` 与 `repository.url` 必须指向同一个仓库（这次的缺陷正是两个字段各写一份、
 *      一起写错 —— 只要它们必须一致，下次至少不会只错一个）。
 */

const requireCjs = createRequire(import.meta.url);
const { parseRepoSlug } = requireCjs("../../electron/update.cjs") as {
  parseRepoSlug: (url: unknown) => { owner: string; repo: string } | null;
};

describe("仓库身份", () => {
  it("repository.url 能解析出 owner/repo（否则打包后更新器无处可问）", () => {
    const slug = parseRepoSlug(packageJson.repository.url);
    expect(slug).not.toBeNull();
    expect(slug?.owner).toBeTruthy();
    expect(slug?.repo).toBeTruthy();
  });

  it("homepage 与 repository.url 指向同一个仓库（两个产地必须一致）", () => {
    const slug = parseRepoSlug(packageJson.repository.url);
    const homepage = String(packageJson.homepage);
    expect(slug).not.toBeNull();
    expect(homepage).toContain(`${slug?.owner}/${slug?.repo}`);
  });
});
