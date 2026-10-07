import { describe, expect, it, vi } from "vitest";
import { createGithubApi, GithubError } from "./api";

/** 假 fetch：按 URL 分派，并记下每次请求（用来断言「令牌只在头里」「走的是哪条路」）。 */
function fakeFetch(routes: Record<string, { status?: number; body?: unknown; text?: string; headers?: Record<string, string> }>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (!key) return new Response("not found", { status: 404 });
    const route = routes[key];
    const status = route.status ?? 200;
    const text = route.text ?? (route.body === undefined ? "" : JSON.stringify(route.body));
    return new Response(text, { status, headers: route.headers });
  };
  return { fetchLike, calls };
}

const target = { owner: "BUGLAN", repo: "opennote" };

describe("createGithubApi · 读", () => {
  it("repo()：默认分支与推送时间；令牌只在 Authorization 头里，绝不进 URL", async () => {
    const { fetchLike, calls } = fakeFetch({
      "/repos/BUGLAN/opennote": {
        body: { default_branch: "main", private: false, description: "笔记", pushed_at: "2026-10-01T00:00:00Z" },
        headers: { "x-ratelimit-remaining": "57" },
      },
    });
    const api = createGithubApi({ fetch: fetchLike, token: "ghp_secret", target });
    const info = await api.repo();
    expect(info).toMatchObject({ defaultBranch: "main", pushedAt: "2026-10-01T00:00:00Z", rateLimitRemaining: 57 });
    expect(calls[0].url).not.toContain("ghp_secret");
    const headers = (calls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe("Bearer ghp_secret");
  });

  it("tree()：只保留 blob，并如实带上 truncated", async () => {
    const { fetchLike } = fakeFetch({
      "/git/trees/main": {
        body: {
          sha: "tree-1",
          truncated: true,
          tree: [
            { path: "docs", type: "tree", sha: "t" },
            { path: "docs/a.md", type: "blob", sha: "blob-a", size: 12 },
            { path: "logo.png", type: "blob", sha: "blob-b", size: 34 },
          ],
        },
      },
    });
    const api = createGithubApi({ fetch: fetchLike, target });
    const tree = await api.tree("main");
    expect(tree.truncated).toBe(true);
    expect(tree.entries).toEqual([
      { path: "docs/a.md", type: "blob", sha: "blob-a", size: 12 },
      { path: "logo.png", type: "blob", sha: "blob-b", size: 34 },
    ]);
  });

  it("raw()：走 CDN、不带 Authorization（带上反而会被拒）", async () => {
    const calls: { url: string; init?: RequestInit }[] = [];
    const fetchLike = async (url: string, init?: RequestInit): Promise<Response> => {
      calls.push({ url, init });
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    };
    const api = createGithubApi({ fetch: fetchLike, token: "ghp_secret", target });
    const bytes = await api.raw("docs/中文 名.md", "main");
    expect([...bytes]).toEqual([1, 2, 3]);
    expect(calls[0].url).toBe("https://raw.githubusercontent.com/BUGLAN/opennote/main/docs/%E4%B8%AD%E6%96%87%20%E5%90%8D.md");
    expect(calls[0].init?.headers).toBeUndefined();
  });
});

describe("createGithubApi · 错误映射（一个码一句话）", () => {
  const cases: [number, Record<string, string>, string][] = [
    [401, {}, "访问令牌无效或已过期，请重新填写。"],
    [404, {}, "仓库或文件不存在，或者它是私有仓库（私有仓库需要访问令牌）。"],
    [403, { "x-ratelimit-remaining": "0" }, "GitHub 的匿名访问配额用完了（每小时 60 次）。填一个访问令牌，或过一会儿再试。"],
    [403, { "x-ratelimit-remaining": "12" }, "GitHub 拒绝了这次请求：令牌可能缺少这个仓库的读写权限。"],
    [422, {}, "远端有新的提交，推送被拒绝了。请先「从远端拉取」。"],
  ];
  for (const [status, headers, message] of cases) {
    it(`${status}（rate-limit=${headers["x-ratelimit-remaining"] ?? "—"}）→ ${message.slice(0, 12)}…`, async () => {
      const { fetchLike } = fakeFetch({ "/repos/BUGLAN/opennote": { status, text: "boom", headers } });
      const api = createGithubApi({ fetch: fetchLike, target });
      await expect(api.repo()).rejects.toMatchObject({ userMessage: message, status });
    });
  }

  it("断网 → 一句人话（不是 fetch 的原始 TypeError）", async () => {
    const fetchLike = async (): Promise<Response> => {
      throw new TypeError("Failed to fetch");
    };
    const api = createGithubApi({ fetch: fetchLike, target });
    const error = await api.repo().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(GithubError);
    expect((error as GithubError).userMessage).toBe("连不上 GitHub，请检查网络后重试。");
  });
});

describe("createGithubApi · 写一个提交", () => {
  it("blob → tree（删除项 sha:null）→ commit（parents=head）→ ref（force:false）", async () => {
    const { fetchLike, calls } = fakeFetch({
      "/git/blobs": { body: { sha: "blob-new" } },
      "/git/trees": { body: { sha: "tree-new" } },
      "/git/commits": { body: { sha: "commit-new" } },
      "/git/refs/heads/main": { body: { object: { sha: "commit-new" } } },
    });
    const api = createGithubApi({ fetch: fetchLike, token: "t", target });
    expect(await api.createBlob(new TextEncoder().encode("你好"))).toBe("blob-new");
    expect(await api.createTree({ baseTree: "tree-old", entries: [{ path: "a.md", sha: "blob-new" }, { path: "b.md", sha: null }] })).toBe("tree-new");
    expect(await api.createCommit({ message: "同步", tree: "tree-new", parents: ["head-1"] })).toBe("commit-new");
    await api.updateRef("main", "commit-new");

    const blobBody = JSON.parse(String(calls[0].init?.body)) as { content: string; encoding: string };
    expect(blobBody.encoding).toBe("base64");
    expect(Buffer.from(blobBody.content, "base64").toString("utf8")).toBe("你好");

    const treeBody = JSON.parse(String(calls[1].init?.body)) as { base_tree: string; tree: unknown[] };
    expect(treeBody.base_tree).toBe("tree-old");
    expect(treeBody.tree).toEqual([
      { path: "a.md", mode: "100644", type: "blob", sha: "blob-new" },
      { path: "b.md", mode: "100644", type: "blob", sha: null },
    ]);

    const commitBody = JSON.parse(String(calls[2].init?.body)) as { parents: string[] };
    expect(commitBody.parents).toEqual(["head-1"]);
    const refBody = JSON.parse(String(calls[3].init?.body)) as { sha: string; force: boolean };
    expect(refBody).toEqual({ sha: "commit-new", force: false });
  });

  it("headSha()：读不到分支时如实报错（不返回空串）", async () => {
    const { fetchLike } = fakeFetch({ "/git/ref/heads/main": { body: {} } });
    const api = createGithubApi({ fetch: fetchLike, target });
    await expect(api.headSha("main")).rejects.toMatchObject({ userMessage: "读不到这个分支的最新提交，请稍后重试。" });
  });
});

describe("createGithubApi · 无令牌（公开仓库只读）", () => {
  it("没有令牌时不带 Authorization 头", async () => {
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}", { status: 200 }));
    const api = createGithubApi({ fetch: spy, target });
    await api.tree("main");
    const headers = (spy.mock.calls[0][1]?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBeUndefined();
  });
});
