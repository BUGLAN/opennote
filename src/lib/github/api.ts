/**
 * GitHub REST 客户端（只讲三条路：读仓库、读文件、写一个提交）。
 *
 * **为什么分成两个来源**：`api.github.com` 有匿名配额（**每小时 60 次**，按 IP），
 * 而 `raw.githubusercontent.com` 是 CDN、不占那个配额。所以约定的用法是：
 *   - `api.github.com`：仓库元数据、文件树、引用、blob / tree / commit（写路径）—— 每次操作个位数请求；
 *   - `raw.githubusercontent.com`：**逐个文件读内容** —— 导入一个 200 篇的仓库就是 200 次请求，
 *     走 API 会把配额瞬间打光（60 次/小时），走 CDN 不会。
 *
 * 令牌只出现在 `Authorization` 头里，**绝不进 URL、绝不进日志**（与本地桥令牌同一条纪律）。
 * 错误一律收敛成 `GithubError`（带 `code` + 一句中文 `userMessage`），界面只贴那句话。
 */

import { encodeBase64 } from "../clip/envelope";
import type { GithubTarget } from "./parse";

/** 只用到 `fetch` 的这一小块：注入之后单测不需要任何网络。 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GithubRepoInfo {
  owner: string;
  repo: string;
  defaultBranch: string;
  private: boolean;
  description: string | null;
  pushedAt: string | null;
  /** 匿名配额剩余（拿不到就是 null）。 */
  rateLimitRemaining: number | null;
}

export interface GithubTreeEntry {
  path: string;
  type: "blob" | "tree" | "commit";
  sha: string;
  size: number;
}

export interface GithubTree {
  sha: string;
  entries: GithubTreeEntry[];
  /** GitHub 只返回了前一部分（仓库太大）—— 必须如实告诉用户。 */
  truncated: boolean;
}

export class GithubError extends Error {
  constructor(
    readonly code: string,
    readonly userMessage: string,
    readonly status: number | null,
    detail?: string,
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "GithubError";
  }
}

const API = "https://api.github.com";
const RAW = "https://raw.githubusercontent.com";

/** 统一的中文说法（一个码一句话，界面不另写一套）。 */
function messageFor(status: number, context: string, rateLimited: boolean): string {
  if (status === 401) return "访问令牌无效或已过期，请重新填写。";
  if (status === 403 && rateLimited) {
    return "GitHub 的匿名访问配额用完了（每小时 60 次）。填一个访问令牌，或过一会儿再试。";
  }
  if (status === 403) return "GitHub 拒绝了这次请求：令牌可能缺少这个仓库的读写权限。";
  if (status === 404) return "仓库或文件不存在，或者它是私有仓库（私有仓库需要访问令牌）。";
  if (status === 409 || status === 422) return "远端有新的提交，推送被拒绝了。请先「从远端拉取」。";
  if (status === 451) return "这个仓库因为法律原因不可访问。";
  return `GitHub 返回了 ${status}（${context}）。`;
}

export interface GithubApi {
  repo(): Promise<GithubRepoInfo>;
  tree(ref: string): Promise<GithubTree>;
  /** 文件原始字节（CDN，不占 API 配额）。 */
  raw(path: string, ref: string): Promise<Uint8Array>;
  headSha(ref: string): Promise<string>;
  commitTree(sha: string): Promise<string>;
  createBlob(bytes: Uint8Array): Promise<string>;
  createTree(input: { baseTree: string; entries: { path: string; sha: string | null }[] }): Promise<string>;
  createCommit(input: { message: string; tree: string; parents: string[] }): Promise<string>;
  updateRef(ref: string, sha: string): Promise<void>;
}

export interface CreateGithubApiOptions {
  fetch: FetchLike;
  token?: string | null;
  target: Pick<GithubTarget, "owner" | "repo">;
  /** 便于单测断言「令牌进了请求头」；生产恒为 `https://api.github.com`。 */
  apiBase?: string;
  rawBase?: string;
}

export function createGithubApi(options: CreateGithubApiOptions): GithubApi {
  const { fetch, target } = options;
  const token = options.token && options.token.trim() ? options.token.trim() : null;
  const apiBase = options.apiBase ?? API;
  const rawBase = options.rawBase ?? RAW;
  const repoPath = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`;

  function headers(extra: Record<string, string> = {}): Record<string, string> {
    const base: Record<string, string> = {
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...extra,
    };
    // 令牌只在请求头里（绝不放 URL）
    if (token) base.authorization = `Bearer ${token}`;
    return base;
  }

  async function request(path: string, init: RequestInit = {}): Promise<{ response: Response; text: string }> {
    let response: Response;
    try {
      response = await fetch(`${apiBase}${path}`, { ...init, headers: headers((init.headers as Record<string, string>) ?? {}) });
    } catch (error) {
      throw new GithubError("GH-NET", "连不上 GitHub，请检查网络后重试。", null, error instanceof Error ? error.message : String(error));
    }
    const text = await response.text().catch(() => "");
    if (!response.ok) {
      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      throw new GithubError(
        `GH-${response.status}`,
        messageFor(response.status, path, Number.isFinite(remaining) && remaining <= 0),
        response.status,
        text.slice(0, 300),
      );
    }
    return { response, text };
  }

  async function json<T>(path: string, init?: RequestInit): Promise<T> {
    const { text } = await request(path, init);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new GithubError("GH-JSON", "GitHub 的响应读不出来（不是合法 JSON），请稍后重试。", null, text.slice(0, 200));
    }
  }

  return {
    async repo() {
      const { response, text } = await request(repoPath);
      let data: {
        default_branch?: string;
        private?: boolean;
        description?: string | null;
        pushed_at?: string | null;
      };
      try {
        data = JSON.parse(text) as typeof data;
      } catch {
        throw new GithubError("GH-JSON", "GitHub 的响应读不出来（不是合法 JSON），请稍后重试。", null, text.slice(0, 200));
      }
      const remaining = Number(response.headers.get("x-ratelimit-remaining"));
      return {
        owner: target.owner,
        repo: target.repo,
        defaultBranch: data.default_branch || "main",
        private: Boolean(data.private),
        description: data.description ?? null,
        pushedAt: data.pushed_at ?? null,
        rateLimitRemaining: Number.isFinite(remaining) ? remaining : null,
      };
    },

    async tree(ref) {
      // 一次递归取全树（1 次请求）：`truncated` 为真时 GitHub 只给了一部分，如实往上带。
      const data = await json<{
        sha?: string;
        truncated?: boolean;
        tree?: { path?: string; type?: string; sha?: string; size?: number }[];
      }>(`${repoPath}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
      const entries: GithubTreeEntry[] = [];
      for (const item of data.tree ?? []) {
        const path = typeof item.path === "string" ? item.path : "";
        const type = item.type === "tree" || item.type === "commit" ? item.type : "blob";
        if (!path || type !== "blob") continue;
        entries.push({ path, type: "blob", sha: String(item.sha ?? ""), size: Number(item.size ?? 0) });
      }
      return { sha: String(data.sha ?? ""), entries, truncated: Boolean(data.truncated) };
    },

    async raw(path, ref) {
      const url = `${rawBase}/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}/${encodeURIComponent(ref)}/${path
        .split("/")
        .map((segment) => encodeURIComponent(segment))
        .join("/")}`;
      let response: Response;
      try {
        // CDN 不需要令牌，也不需要 Accept 头；带上 Authorization 反而可能被拒
        response = await fetch(url, { redirect: "follow" });
      } catch (error) {
        throw new GithubError("GH-NET", "连不上 GitHub，请检查网络后重试。", null, error instanceof Error ? error.message : String(error));
      }
      if (!response.ok) {
        throw new GithubError(`GH-${response.status}`, messageFor(response.status, path, false), response.status);
      }
      return new Uint8Array(await response.arrayBuffer());
    },

    async headSha(ref) {
      const data = await json<{ object?: { sha?: string } }>(`${repoPath}/git/ref/heads/${encodeURIComponent(ref)}`);
      const sha = data.object && typeof data.object.sha === "string" ? data.object.sha : "";
      if (!sha) throw new GithubError("GH-REF", "读不到这个分支的最新提交，请稍后重试。", null);
      return sha;
    },

    async commitTree(sha) {
      const data = await json<{ tree?: { sha?: string } }>(`${repoPath}/git/commits/${encodeURIComponent(sha)}`);
      const tree = data.tree && typeof data.tree.sha === "string" ? data.tree.sha : "";
      if (!tree) throw new GithubError("GH-TREE", "读不到这个提交的文件树，请稍后重试。", null);
      return tree;
    },

    async createBlob(bytes) {
      const data = await json<{ sha?: string }>(`${repoPath}/git/blobs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: encodeBase64(bytes), encoding: "base64" }),
      });
      const sha = data.sha ?? "";
      if (!sha) throw new GithubError("GH-BLOB", "GitHub 没有返回这次上传的标识，推送没有完成。", null);
      return sha;
    },

    async createTree({ baseTree, entries }) {
      const data = await json<{ sha?: string }>(`${repoPath}/git/trees`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          base_tree: baseTree,
          tree: entries.map((entry) => ({
            path: entry.path,
            mode: "100644",
            type: "blob",
            // `sha: null` = 删除这一条（GitHub 的 tree API 就是这么表达删除的）
            sha: entry.sha,
          })),
        }),
      });
      const sha = data.sha ?? "";
      if (!sha) throw new GithubError("GH-TREE", "GitHub 没有返回新的文件树，推送没有完成。", null);
      return sha;
    },

    async createCommit({ message, tree, parents }) {
      const data = await json<{ sha?: string }>(`${repoPath}/git/commits`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message, tree, parents }),
      });
      const sha = data.sha ?? "";
      if (!sha) throw new GithubError("GH-COMMIT", "GitHub 没有返回新的提交，推送没有完成。", null);
      return sha;
    },

    async updateRef(ref, sha) {
      // `force:false`：远端前进时这次更新会被拒绝（**不做**静默强推覆盖别人的提交）
      await request(`${repoPath}/git/refs/heads/${encodeURIComponent(ref)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sha, force: false }),
      });
    },
  };
}
