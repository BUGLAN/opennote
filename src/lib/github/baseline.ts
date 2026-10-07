/**
 * GitHub 基线与令牌的存放（两个**不同的地方**，理由写在下面）。
 *
 * **基线**（`.opennote/github.json`）放在笔记本里：它记的是「导入/上次同步时，本地这一份
 * 与远端那棵树各自长什么样」，换台机器、换个浏览器把文件夹拷过去，同步的判据跟着走。
 * 它是同步的**唯一事实源**：`localHash` 判断「本地改没改」，`remoteSha` 判断「远端改没改」，
 * `imported` 判断「这个文件我们有没有物化过」（没物化的远端文件**永不触碰**）。
 *
 * **令牌**（`localStorage`）绝不放进笔记本：`.opennote/` 是会被同步/导出/拷贝的目录，
 * 令牌放进去等于把它写进了仓库（下一次推送就会提交上去）。所以令牌只存这个浏览器：
 * 勾了「记住令牌」进 `localStorage`（长期），没勾进 `sessionStorage`（关掉标签页即失效）。
 * 代价如实披露在对话框里：**能读到这个浏览器站点数据的程序就能拿到它**。
 */

import { joinPath, META_DIR } from "../../fs/paths";
import type { FileSystemBackend } from "../../fs/types";

export const GITHUB_META_FILE = joinPath(META_DIR, "github.json");
const TOKEN_KEY = "opennote.github.tokens.v1";
const SESSION_TOKEN_KEY = "opennote.github.tokens.session.v1";

export interface GithubBaselineFile {
  /** 远端那棵树里的 blob sha（判断「远端改没改」）。 */
  remoteSha: string;
  /** 导入/上次同步时本地内容的 sha256（判断「本地改没改」）；没物化的文件是 null。 */
  localHash: string | null;
  /** 我们有没有把这一条写到本地。false = 只在基线里记账，同步永不触碰它。 */
  imported: boolean;
}

export interface GithubBaseline {
  version: 1;
  owner: string;
  repo: string;
  ref: string;
  remote: string;
  importedAt: string;
  /** 上次同步时的分支头与树（推送时的 `parents` 与 `base_tree`）。 */
  headSha: string;
  treeSha: string;
  files: Record<string, GithubBaselineFile>;
}

export function makeBaseline(input: Omit<GithubBaseline, "version" | "importedAt">): GithubBaseline {
  return { version: 1, importedAt: new Date().toISOString(), ...input };
}

/** 读基线；文件不存在 / 读不动 / 不是 JSON → `null`（**不抛**：没有基线就是「还没导入过」）。 */
export async function readBaseline(target: FileSystemBackend): Promise<GithubBaseline | null> {
  let raw: string;
  try {
    if (!(await target.exists(GITHUB_META_FILE))) return null;
    raw = await target.readText(GITHUB_META_FILE);
  } catch (error) {
    console.warn("[opennote] 读不到 GitHub 基线", error);
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<GithubBaseline>;
    if (parsed.version !== 1 || typeof parsed.owner !== "string" || typeof parsed.repo !== "string") return null;
    if (typeof parsed.ref !== "string" || !parsed.files || typeof parsed.files !== "object") return null;
    return {
      version: 1,
      owner: parsed.owner,
      repo: parsed.repo,
      ref: parsed.ref,
      remote: typeof parsed.remote === "string" ? parsed.remote : `https://github.com/${parsed.owner}/${parsed.repo}`,
      importedAt: typeof parsed.importedAt === "string" ? parsed.importedAt : new Date().toISOString(),
      headSha: typeof parsed.headSha === "string" ? parsed.headSha : "",
      treeSha: typeof parsed.treeSha === "string" ? parsed.treeSha : "",
      files: parsed.files as Record<string, GithubBaselineFile>,
    };
  } catch (error) {
    console.warn("[opennote] GitHub 基线不是合法 JSON，按「还没有基线」处理", error);
    return null;
  }
}

export async function writeBaseline(target: FileSystemBackend, baseline: GithubBaseline): Promise<void> {
  await target.mkdir(META_DIR).catch(() => undefined);
  await target.writeText(GITHUB_META_FILE, `${JSON.stringify(baseline, null, 2)}\n`);
}

/* --------------------------------------------------------------- 令牌存储 */

interface TokenRecord {
  token: string;
  savedAt: string;
}

type TokenMap = Record<string, TokenRecord>;

function keyOf(owner: string, repo: string): string {
  return `${owner}/${repo}`;
}

/** 站点存储可能是被禁用的（D04）：所有读写都要能退化成「本次会话有效」。 */
function readMap(storage: Storage | undefined, key: string): TokenMap {
  try {
    const raw = storage?.getItem(key);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as TokenMap;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeMap(storage: Storage | undefined, key: string, map: TokenMap): void {
  try {
    storage?.setItem(key, JSON.stringify(map));
  } catch (error) {
    console.warn("[opennote] 令牌没能保存到浏览器存储", error);
  }
}

function localStore(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

function sessionStore(): Storage | undefined {
  try {
    return typeof sessionStorage === "undefined" ? undefined : sessionStorage;
  } catch {
    return undefined;
  }
}

/** 记住令牌：`remember` 为真进 localStorage（长期），否则只进 sessionStorage。 */
export function saveGithubToken(owner: string, repo: string, token: string, remember: boolean): void {
  const key = keyOf(owner, repo);
  const record: TokenRecord = { token, savedAt: new Date().toISOString() };
  if (remember) {
    writeMap(localStore(), TOKEN_KEY, { ...readMap(localStore(), TOKEN_KEY), [key]: record });
    return;
  }
  writeMap(sessionStore(), SESSION_TOKEN_KEY, { ...readMap(sessionStore(), SESSION_TOKEN_KEY), [key]: record });
}

/** 取令牌：先看本次会话，再看长期存储；都没有就是 null（匿名配额可读不可写）。 */
export function loadGithubToken(owner: string, repo: string): string | null {
  const key = keyOf(owner, repo);
  const session = readMap(sessionStore(), SESSION_TOKEN_KEY)[key];
  if (session && session.token) return session.token;
  const saved = readMap(localStore(), TOKEN_KEY)[key];
  return saved && saved.token ? saved.token : null;
}

export function forgetGithubToken(owner: string, repo: string): void {
  const key = keyOf(owner, repo);
  for (const [storage, storageKey] of [
    [localStore(), TOKEN_KEY],
    [sessionStore(), SESSION_TOKEN_KEY],
  ] as const) {
    const map = readMap(storage, storageKey);
    if (!(key in map)) continue;
    delete map[key];
    writeMap(storage, storageKey, map);
  }
}
