/**
 * 「从 GitHub 仓库导入」的地址解析（唯一产地）。
 *
 * 用户可能贴进来四种写法，每一种都要能被认出来，认不出来时必须给一句能照做的话：
 *
 * ```
 * https://github.com/BUGLAN/opennote
 * https://github.com/BUGLAN/opennote/tree/main/docs      ← 分支 + 子目录
 * git@github.com:BUGLAN/opennote.git
 * BUGLAN/opennote
 * ```
 *
 * **子目录（`/tree/<ref>/<子路径>`）只用来决定分支，不缩小导入范围**：镜像与远端是
 * 按「工作区相对路径 ↔ 仓库路径」一一对应的，只导入一个子目录就得在两边各加一层前缀
 * 映射，而同步的每一条判据都要跟着改。这一版明确不做（提示句会说出来），要收窄范围
 * 请等有了「部分导入」的判定之后再谈。
 */

import { normalizePath } from "../../fs/paths";

export interface GithubTarget {
  owner: string;
  repo: string;
  /** 分支 / 标签 / 提交；`null` = 用仓库的默认分支。 */
  ref: string | null;
  /** 地址里写了子目录时原样记下（只用于提示，不参与导入）。 */
  subPath: string | null;
  /** 规范化的仓库地址（`https://github.com/owner/repo`），展示与写进基线都用它。 */
  remote: string;
}

export type ParseResult = { ok: true; value: GithubTarget } | { ok: false; message: string };

const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/** owner/repo 段：GitHub 只允许字母数字、`-`、`_`、`.`（且不能是 `.` / `..`）。 */
function validSegment(value: string): boolean {
  return SEGMENT_RE.test(value) && value !== "." && value !== "..";
}

/** 分支名：GitHub 的分支规则很宽，这里只挡掉「明显是路径而不是名字」的写法。 */
function validRef(value: string): boolean {
  return value !== "" && value.length <= 255 && !/[\s~^:?*[\\]/.test(value) && !value.includes("..");
}

/**
 * 把用户输入解析成 `{owner, repo, ref, subPath}`。
 *
 * 反向验证（`parse.test.ts`）：`github.com/BUGLAN/opennote`、`git@github.com:BUGLAN/opennote.git`
 * 与 `BUGLAN/opennote` 必须解析成**同一个** target —— 三种写法一个事实。
 */
export function parseRepoInput(input: string): ParseResult {
  const raw = String(input ?? "").trim();
  if (!raw) return { ok: false, message: "先填仓库地址。可以粘贴 https://github.com/owner/repo，或直接写 owner/repo。" };

  let rest = raw;
  let ref: string | null = null;
  let subPath: string | null = null;

  const scp = rest.match(/^git@github\.com:(.+)$/i);
  if (scp) {
    // `git@github.com:owner/repo.git`：与 https 写法同一个事实，只换了外壳
    rest = scp[1];
  } else if (/^https?:\/\//i.test(rest)) {
    let url: URL;
    try {
      url = new URL(rest);
    } catch {
      return { ok: false, message: "这个地址读不出来。可以粘贴 https://github.com/owner/repo。" };
    }
    if (!/(^|\.)github\.com$/i.test(url.hostname)) {
      return { ok: false, message: "只支持 github.com 上的公开仓库。" };
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length >= 4 && (parts[2] === "tree" || parts[2] === "blob")) {
      ref = decodeURIComponent(parts[3]);
      const tail = parts.slice(4).map((part) => decodeURIComponent(part));
      subPath = tail.length ? normalizePath(tail.join("/")) : null;
    }
    rest = parts.slice(0, 2).join("/");
  }

  const segments = rest.split("/").filter(Boolean);
  if (segments.length === 2) {
    const [owner, repoRaw] = segments;
    const repo = repoRaw.replace(/\.git$/i, "");
    if (!validSegment(owner) || !validSegment(repo)) {
      return { ok: false, message: "仓库名里出现了不认识的字符。写法是 owner/repo，比如 BUGLAN/opennote。" };
    }
    if (ref !== null && !validRef(ref)) {
      return { ok: false, message: "分支名读不出来。可以去掉 /tree/… 改用仓库的默认分支。" };
    }
    return {
      ok: true,
      value: {
        owner,
        repo,
        ref,
        subPath: subPath && subPath !== "" ? subPath : null,
        remote: `https://github.com/${owner}/${repo}`,
      },
    };
  }

  return { ok: false, message: "没认出这是哪个仓库。可以粘贴 https://github.com/owner/repo，或直接写 owner/repo。" };
}

/** 基线的显示名（`BUGLAN/opennote`）。 */
export function targetLabel(target: Pick<GithubTarget, "owner" | "repo">): string {
  return `${target.owner}/${target.repo}`;
}
