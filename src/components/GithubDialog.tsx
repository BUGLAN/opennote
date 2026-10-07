import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  closeGithubDialog,
  useGithubDialogRequest,
  type GithubImportRequest,
  type GithubSyncRequest,
} from "../lib/github/dialog";
import { Modal } from "./Overlays";

/**
 * GitHub 的两个对话框：**导入**（地址 + 令牌 + 记住）与**同步**（变更清单 + 冲突 + 三个动作）。
 *
 * 与 `DialogHost` 分开：那一个只服务「一句话 + 一个输入框」的三支通用请求，混进来会让它的
 * 渲染分支长出一半不认识的状态。这一个只认 `githubDialogStore` 的两种请求。
 *
 * 纪律：**按钮的可用性必须说出理由** —— 没有令牌时「提交并推送」置灰，并在旁边写清为什么
 * （需要令牌），而不是让用户点了才报错（那是本项目反复抓过的「假按钮」）。
 */
export function GithubDialogHost(): ReactNode {
  const request = useGithubDialogRequest();
  if (!request) return null;
  return request.kind === "import" ? <GithubImportDialog key={request.id} request={request} /> : <GithubSyncDialog key={request.id} request={request} />;
}

function GithubImportDialog({ request }: { request: GithubImportRequest }): ReactNode {
  const { initial } = request;
  const [repo, setRepo] = useState(initial.repo);
  const [token, setToken] = useState(initial.token);
  const [remember, setRemember] = useState(initial.remember);
  const repoRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      repoRef.current?.focus();
      repoRef.current?.select();
    });
  }, []);

  const submit = () => {
    const value = repo.trim();
    if (!value) return;
    request.resolve({ repo: value, token: token.trim(), remember });
  };

  return (
    <Modal
      title="从 GitHub 仓库导入"
      onClose={closeGithubDialog}
      footer={
        <>
          <button type="button" className="btn" onClick={closeGithubDialog}>
            取消
          </button>
          <button type="button" className="btn btn--primary" disabled={!repo.trim()} onClick={submit}>
            导入
          </button>
        </>
      }
    >
      <div className="github-form">
        <label className="github-form__label" htmlFor="github-repo">
          仓库地址
        </label>
        <input
          id="github-repo"
          ref={repoRef}
          className="field"
          type="text"
          spellCheck={false}
          autoCapitalize="off"
          placeholder="https://github.com/owner/repo"
          value={repo}
          onChange={(event) => setRepo(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <p className="github-form__hint">
          公开仓库不用填令牌就能导入；填了才能把改动同步回去，也才能导入私有仓库。只支持 github.com。
        </p>

        <label className="github-form__label" htmlFor="github-token">
          访问令牌（可选）
        </label>
        <input
          id="github-token"
          className="field"
          type="password"
          spellCheck={false}
          autoComplete="off"
          placeholder={initial.hasSavedToken ? "这个仓库已经存过令牌，留空就用它" : "ghp_… 或 github_pat_…"}
          value={token}
          onChange={(event) => setToken(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") submit();
          }}
        />
        <label className="github-form__check">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          <span>记住令牌（保存在这个浏览器里，不写进笔记本）</span>
        </label>
        <p className="github-form__hint">
          令牌只存在这个浏览器里，不会写进笔记本文件夹，也不会出现在日志里；能读到这个浏览器站点数据的程序就能拿到它。
        </p>
      </div>
    </Modal>
  );
}

function GithubSyncDialog({ request }: { request: GithubSyncRequest }): ReactNode {
  const { summary } = request;
  const [message, setMessage] = useState(summary.message);
  const nothing = summary.added + summary.modified + summary.deleted === 0;

  return (
    <Modal
      title="同步到 GitHub"
      onClose={closeGithubDialog}
      footer={
        <>
          <button type="button" className="btn" onClick={closeGithubDialog}>
            取消
          </button>
          <button type="button" className="btn" onClick={() => request.resolve({ action: "pull" })}>
            从远端拉取
          </button>
          <button
            type="button"
            className="btn btn--primary"
            disabled={!summary.hasToken || nothing}
            title={summary.hasToken ? (nothing ? "本地没有改动" : undefined) : "同步改动需要一个有 repo 权限的访问令牌"}
            onClick={() => request.resolve({ action: "push", message })}
          >
            提交并推送
          </button>
        </>
      }
    >
      <div className="github-form">
        <p className="github-sync__remote">
          {summary.owner}/{summary.repo} · {summary.ref}
        </p>
        <p className="github-sync__counts">
          新增 {summary.added} · 修改 {summary.modified} · 删除 {summary.deleted}
        </p>

        {summary.conflicts.length ? (
          <div className="github-sync__conflicts">
            <p className="github-sync__conflict-title">
              有 {summary.conflicts.length} 个文件两边都改了，这次没有动它们：
            </p>
            <ul>
              {summary.conflicts.slice(0, 12).map((path) => (
                <li key={path}>
                  <code>{path}</code>
                </li>
              ))}
              {summary.conflicts.length > 12 ? <li>……还有 {summary.conflicts.length - 12} 个</li> : null}
            </ul>
            <button type="button" className="btn" onClick={() => request.resolve({ action: "overwrite-conflicts" })}>
              用远端覆盖这些文件
            </button>
          </div>
        ) : null}

        <label className="github-form__label" htmlFor="github-commit">
          提交信息
        </label>
        <input
          id="github-commit"
          className="field"
          type="text"
          value={message}
          onChange={(event) => setMessage(event.target.value)}
        />
        {summary.hasToken ? null : (
          <p className="github-form__hint">这个笔记本还没有令牌，只能从远端拉取；要推送请先在导入对话框里填一个。</p>
        )}
      </div>
    </Modal>
  );
}
