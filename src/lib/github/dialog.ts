/**
 * 「从 GitHub 仓库导入 / 同步」两个对话框的请求模型。
 *
 * 与 `src/lib/dialogs.ts` 同形（store + Promise 接口），但**单独一份**而不是往
 * `DialogRequest` 里加一支：那边是「一句话 + 一个输入框」的通用小对话框（重命名、确认、
 * 选文件夹），GitHub 这两个要装地址 + 令牌 + 记住开关 + 变更清单 + 冲突清单，
 * 塞进同一个联合类型只会让那三支的渲染分支多出两个它不认识的形状。
 */

import { createStore, useStore } from "../store";
import { uid } from "../utils";

export interface GithubImportInitial {
  /** 预填的仓库地址（例如上次导入过的那个，或当前笔记本对应的远端）。 */
  repo: string;
  /** 预填的令牌：它就是本机浏览器里的那一串，界面上是密码框。 */
  token: string;
  remember: boolean;
  /** 这个仓库已经有令牌时说明一句，免得用户以为必须重填。 */
  hasSavedToken: boolean;
}

export interface GithubImportAnswer {
  repo: string;
  token: string;
  remember: boolean;
}

export interface GithubImportRequest {
  kind: "import";
  id: string;
  initial: GithubImportInitial;
  resolve: (value: GithubImportAnswer | null) => void;
}

export interface GithubSyncSummary {
  owner: string;
  repo: string;
  ref: string;
  added: number;
  modified: number;
  deleted: number;
  /** 两边都改了 / 远端删了但本地也改了：**这次不会动**，列出来给人看。 */
  conflicts: string[];
  /** 本地有没有可用的令牌（没有 = 只能拉取，推送按钮置灰并说明原因）。 */
  hasToken: boolean;
  /** 默认提交信息（用户可改）。 */
  message: string;
}

export type GithubSyncAction = "push" | "pull" | "overwrite-conflicts";

/** 同步对话框的结论：动作 + （推送时才有的）提交信息。 */
export interface GithubSyncAnswer {
  action: GithubSyncAction;
  message?: string;
}

export interface GithubSyncRequest {
  kind: "sync";
  id: string;
  summary: GithubSyncSummary;
  resolve: (value: GithubSyncAnswer | null) => void;
}

export type GithubDialogRequest = GithubImportRequest | GithubSyncRequest;

export const githubDialogStore = createStore<GithubDialogRequest | null>(null);

export function useGithubDialogRequest(): GithubDialogRequest | null {
  return useStore(githubDialogStore);
}

/** 关掉当前对话框（Esc / 点遮罩）：`resolve(null)` = 用户取消，调用方一律当「什么都没做」。 */
export function closeGithubDialog(): void {
  const request = githubDialogStore.get();
  if (!request) return;
  request.resolve(null);
  githubDialogStore.set(null);
}

export function askGithubImport(initial: Partial<GithubImportInitial> = {}): Promise<GithubImportAnswer | null> {
  return new Promise((resolve) => {
    const request: GithubImportRequest = {
      kind: "import",
      id: uid(),
      initial: { repo: "", token: "", remember: true, hasSavedToken: false, ...initial },
      // 关闭 store 与兑现 promise 是**同一件事**：对话框只有一个出口
      resolve: (value) => {
        githubDialogStore.set(null);
        resolve(value);
      },
    };
    githubDialogStore.set(request);
  });
}

export function askGithubSync(summary: GithubSyncSummary): Promise<GithubSyncAnswer | null> {
  return new Promise((resolve) => {
    const request: GithubSyncRequest = {
      kind: "sync",
      id: uid(),
      summary,
      resolve: (value) => {
        githubDialogStore.set(null);
        resolve(value);
      },
    };
    githubDialogStore.set(request);
  });
}

/** 同步对话框里那句默认提交信息（一个产地：界面与推送都读它）。 */
export function defaultCommitMessage(counts: { added: number; modified: number; deleted: number }): string {
  const parts: string[] = [];
  if (counts.added) parts.push(`新增 ${counts.added} 个`);
  if (counts.modified) parts.push(`修改 ${counts.modified} 个`);
  if (counts.deleted) parts.push(`删除 ${counts.deleted} 个`);
  return `Opennote 同步：${parts.length ? parts.join("、") : "没有改动"}`;
}
