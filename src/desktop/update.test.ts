import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

/**
 * `electron/update.cjs` 的**纯函数**部分：版本比较、资产挑选、校验和解析。
 * 网络与磁盘的真实行为在 `updateServer.test.ts`（本地 http 服务器真跑）。
 */
const requireCjs = createRequire(import.meta.url);
const {
  compareVersions,
  isNewer,
  parseVersion,
  parseRepoSlug,
  assetNameFor,
  pickWindowsAsset,
  parseChecksums,
  isSha256,
} = requireCjs("../../electron/update.cjs") as {
  compareVersions: (a: string, b: string) => number;
  isNewer: (a: string, b: string) => boolean;
  parseVersion: (value: unknown) => { major: number; minor: number; patch: number; prerelease: string[] } | null;
  parseRepoSlug: (url: unknown) => { owner: string; repo: string } | null;
  assetNameFor: (version: string, options?: { platform?: string; arch?: string }) => string;
  pickWindowsAsset: (
    release: { assets: { name: string; browser_download_url?: string; size?: number; digest?: string }[] },
    options?: { arch?: string },
  ) => { name: string; version: string; url: string; size: number; digest: string } | null;
  parseChecksums: (text: unknown) => Map<string, string>;
  isSha256: (value: unknown) => boolean;
};

describe("版本比较", () => {
  it("认 v 前缀与三位版本号", () => {
    expect(parseVersion("v0.6.0")).toEqual({ major: 0, minor: 6, patch: 0, prerelease: [] });
    expect(parseVersion("0.5.0")).toEqual({ major: 0, minor: 5, patch: 0, prerelease: [] });
    expect(parseVersion("nightly")).toBeNull();
    expect(parseVersion(undefined)).toBeNull();
  });

  it("数字位逐段比较", () => {
    expect(isNewer("0.6.0", "0.5.0")).toBe(true);
    expect(isNewer("0.5.1", "0.5.0")).toBe(true);
    expect(isNewer("0.5.0", "0.5.0")).toBe(false);
    expect(isNewer("0.4.9", "0.5.0")).toBe(false);
    expect(compareVersions("v0.10.0", "0.9.9")).toBe(1);
  });

  it("预发布版本永远小于同号正式版（不会把 rc 当正式更新推给用户）", () => {
    expect(isNewer("0.6.0-rc.1", "0.6.0")).toBe(false);
    expect(isNewer("0.6.0-rc.2", "0.6.0-rc.1")).toBe(true);
    expect(isNewer("0.6.0", "0.6.0-rc.1")).toBe(true);
  });

  it("无法识别的版本一律判「不是更新」（宁可不提示，也不乱提示）", () => {
    expect(isNewer("abc", "0.5.0")).toBe(false);
    expect(isNewer("0.6.0", "dev")).toBe(false);
    expect(isNewer("nightly", "0.5.0")).toBe(false);
  });
});

describe("仓库归属", () => {
  it("从 repository.url 的四种写法里取 owner/repo", () => {
    expect(parseRepoSlug("git+https://github.com/BUGLAN/opennote.git")).toEqual({ owner: "BUGLAN", repo: "opennote" });
    expect(parseRepoSlug("https://github.com/BUGLAN/opennote")).toEqual({ owner: "BUGLAN", repo: "opennote" });
    expect(parseRepoSlug("git@github.com:BUGLAN/opennote.git")).toEqual({ owner: "BUGLAN", repo: "opennote" });
    expect(parseRepoSlug("https://gitee.com/x/y")).toBeNull();
    expect(parseRepoSlug(undefined)).toBeNull();
  });

  it("资产名与 CI 的 artifactName 约定一致", () => {
    expect(assetNameFor("0.6.0")).toBe("Opennote-0.6.0-win-x64.zip");
    expect(assetNameFor("0.6.0", { arch: "arm64" })).toBe("Opennote-0.6.0-win-arm64.zip");
  });
});

describe("资产挑选", () => {
  const release = {
    assets: [
      { name: "Opennote-clip-0.1.4.zip", browser_download_url: "u-clip", size: 100 },
      { name: "SHA256SUMS", browser_download_url: "u-sums", size: 183 },
      { name: "Opennote-0.6.0-win-x64.zip", browser_download_url: "u-desktop", size: 158472430, digest: "sha256:aa" },
    ],
  };

  it("只选 Windows x64 免安装包，忽略扩展包与 SHA256SUMS", () => {
    const asset = pickWindowsAsset(release, { arch: "x64" });
    expect(asset).not.toBeNull();
    expect(asset?.name).toBe("Opennote-0.6.0-win-x64.zip");
    expect(asset?.version).toBe("0.6.0");
    expect(asset?.url).toBe("u-desktop");
    expect(asset?.size).toBe(158472430);
    expect(asset?.digest).toBe("sha256:aa");
  });

  it("没有对应架构的包时返回 null（由调用方报「没有可用的安装包」）", () => {
    expect(pickWindowsAsset(release, { arch: "arm64" })).toBeNull();
    expect(pickWindowsAsset({ assets: [] })).toBeNull();
    expect(pickWindowsAsset({ assets: [] }, {})).toBeNull();
  });
});

describe("SHA256SUMS 解析", () => {
  it("解析 GNU coreutils 格式（含 * 二进制标记与空行）", () => {
    const text = [
      "6ffc2ef1f2277f1ae9fda6a596ed4cca997de7acf3aa6decdd4dcb0491cee575  Opennote-0.5.0-win-x64.zip",
      "",
      "2cb0cf3eb674fd1dd0a07f3f1686e42f2d0ea829e2e8dd8f306538ff6098f032 *Opennote-clip-0.1.4.zip",
      "not-a-hash  garbage.txt",
    ].join("\n");
    const table = parseChecksums(text);
    expect(table.size).toBe(2);
    expect(table.get("Opennote-0.5.0-win-x64.zip")).toBe(
      "6ffc2ef1f2277f1ae9fda6a596ed4cca997de7acf3aa6decdd4dcb0491cee575",
    );
    expect(table.get("Opennote-clip-0.1.4.zip")).toBe(
      "2cb0cf3eb674fd1dd0a07f3f1686e42f2d0ea829e2e8dd8f306538ff6098f032",
    );
    expect(table.has("garbage.txt")).toBe(false);
  });

  it("缺行就是缺行：查不到时调用方必须拒绝安装", () => {
    expect(parseChecksums("").get("Opennote-0.6.0-win-x64.zip")).toBeUndefined();
    expect(parseChecksums(undefined).size).toBe(0);
  });

  it("isSha256 只认 64 位小写十六进制", () => {
    expect(isSha256("a".repeat(64))).toBe(true);
    expect(isSha256("A".repeat(64))).toBe(false);
    expect(isSha256("sha256:abc")).toBe(false);
    expect(isSha256(undefined)).toBe(false);
  });
});
