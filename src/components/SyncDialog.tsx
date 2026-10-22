/**
 * 同步设置对话框（§5.3 的界面入口）。
 *
 * ## 三块内容，对应三条用户旅程
 *
 * 1. **账号**：注册（粘服务端的 `boot_` 引导码，或管理员发的 `inv_` 邀请码）或
 *    导入另一台设备导出的密钥。注册遵循 onboarding 的纪律 —— **先抄下密钥、
 *    勾了「我已保存」才允许注册**（离开 confirm-saved 的唯一途径）。
 * 2. **连接**：填服务地址 → 拉笔记本列表（或新建）→ 选一个 → 保存并连接。
 *    保存走 `updateWorkspaceSync`（半配好存下去也是「关」）。
 * 3. **状态与冲突**：状态栏同一份文案（`describeSyncStatus`），冲突逐条列出处，
 *    两个动作都写明后果 ——「采用远端」与「用我的版本覆盖远端」都不是静默的。
 *
 * 已知边界（如实展示，不假装）：桌面端实时订阅（SSE）还没走主进程桥，
 * 触发源是「启动 / 保存 / 回前台 / 手动」四个。
 */

import { type ReactNode, useEffect, useState } from "react";
import { Modal } from "./Overlays";
import { Icon } from "./Icons";
import { formatRelativeTime } from "../lib/utils";
import { useStore } from "../lib/store";
import {
  closeWorkspaceSync,
  completeRegistration,
  createNotebook as createNotebookApi,
  exportCurrentKey,
  forgetAccountKey,
  importAccountKey,
  listNotebooks as listNotebooksApi,
  manualSync,
  openWorkspaceSync,
  prepareRegistration,
  resolveConflict,
  saveWorkspaceConnection,
  syncStatusBarInfo,
  unlockAccount,
  syncUiStore,
} from "../sync/appSync";
import { activeBackend } from "../data/library";
import { describeSyncStatus } from "../sync/runner";
import { normalizeSyncConfig, type WorkspaceRecord } from "../data/workspaces";
import type { RegistrationMaterial } from "../sync/accountKey";
import type { NotebookSummary } from "../sync/accountApi";

export function SyncDialog({ workspace, onClose }: { workspace: WorkspaceRecord | null; onClose: () => void }): ReactNode {
  const ui = useStore(syncUiStore);
  const bar = syncStatusBarInfo(ui, workspace !== null);

  return (
    <Modal title="同步" onClose={onClose} settings tall>
      <div className="sync-dialog">
        <AccountSection />
        {workspace ? <ConnectionSection workspace={workspace} /> : <p className="dialog__note">先打开一个笔记本，才能配置同步。</p>}
        <StatusSection />
        <ConflictSection />
      </div>
      <p className="dialog__note" style={{ marginTop: 10 }}>
        {bar
          ? `状态栏当前显示「${bar.label}」。同步默认关闭；开启后它也只是一个旁路 —— 关掉就一个请求都不会发。`
          : "同步以笔记本为单位：打开一个笔记本后，在这里为它配置服务地址与远端笔记本。"}
      </p>
    </Modal>
  );
}

/* ==================================== 账号 ================================== */

function AccountSection(): ReactNode {
  const ui = useStore(syncUiStore);
  const [mode, setMode] = useState<"register" | "import" | null>(null);

  if (!ui.hasKey) {
    return (
      <section className="sync-dialog__card">
        <h3 className="sync-dialog__title">
          <Icon name="shield" size={13} /> 账号
        </h3>
        {mode === null ? (
          <div className="sync-dialog__row">
            <button type="button" className="btn btn--primary" onClick={() => setMode("register")}>
              注册新账号
            </button>
            <button type="button" className="btn" onClick={() => setMode("import")}>
              导入已有密钥
            </button>
          </div>
        ) : mode === "register" ? (
          <RegisterForm onDone={() => setMode(null)} onCancel={() => setMode(null)} />
        ) : (
          <ImportForm onDone={() => setMode(null)} onCancel={() => setMode(null)} />
        )}
      </section>
    );
  }

  return (
    <section className="sync-dialog__card">
      <h3 className="sync-dialog__title">
        <Icon name="shield" size={13} /> 账号
      </h3>
      <p className="dialog__message">
        已登录：<code>{ui.accountId?.slice(0, 16)}…</code>
      </p>
      {ui.storage ? (
        <p className="dialog__note">
          {ui.storage.where}
          {ui.storage.risk ? ` ${ui.storage.risk}` : ""}
        </p>
      ) : null}
      <div className="sync-dialog__row">
        <CopyKeyButton />
        <button
          type="button"
          className="btn btn--danger"
          onClick={() => {
            if (window.confirm("清除这台设备保存的账号密钥？密钥文本只在你手里，没有它这台设备就连不上同步。")) {
              void forgetAccountKey();
            }
          }}
        >
          清除本机密钥
        </button>
      </div>
    </section>
  );
}

/** 已登录状态下导出密钥：多设备接第二台设备的唯一入口。 */
function CopyKeyButton(): ReactNode {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="btn"
      onClick={() => {
        void exportCurrentKey().then((text) => {
          if (!text) return;
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true);
            window.setTimeout(() => setCopied(false), 2500);
          });
        });
      }}
      title="把这把密钥粘到另一台设备的「导入已有密钥」里 —— 两台设备共用同一个账号"
    >
      <Icon name="copy" size={13} /> {copied ? "已复制到剪贴板" : "复制密钥"}
    </button>
  );
}

function RegisterForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): ReactNode {
  const [baseUrl, setBaseUrl] = useState("");
  const [code, setCode] = useState("");
  const [draft, setDraft] = useState<{ material: RegistrationMaterial; keyText: string; accountId: string } | null>(null);
  const [savedConfirmed, setSavedConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = () => {
    if (!/^https?:\/\//.test(baseUrl.trim())) {
      setError("先填服务地址（https://… 或 http://…）");
      return;
    }
    setDraft(prepareRegistration());
    setError(null);
  };

  const submit = async () => {
    if (!draft) return;
    setBusy(true);
    setError(null);
    try {
      await completeRegistration({ baseUrl, code, material: draft.material, keyText: draft.keyText });
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="sync-dialog__form">
      <label className="sync-dialog__label">
        服务地址
        <input className="field" value={baseUrl} placeholder="https://notes.example.com" onChange={(event) => setBaseUrl(event.target.value)} />
      </label>
      {draft === null ? (
        <>
          <label className="sync-dialog__label">
            管理员引导码（boot_…）或注册邀请码（inv_…）
            <input className="field" value={code} placeholder="boot_…" onChange={(event) => setCode(event.target.value)} />
          </label>
          <div className="sync-dialog__row">
            <button type="button" className="btn btn--primary" onClick={start}>
              生成我的账号密钥
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="dialog__message">
            这是你的<strong>账号密钥</strong>。它就是你的账号 —— <strong>丢了无法找回，服务端没有副本</strong>。请复制
            保存到密码管理器或导出成文件：
          </p>
          <textarea className="field sync-dialog__key" readOnly value={draft.keyText} onFocus={(event) => event.currentTarget.select()} rows={4} />
          <div className="sync-dialog__row">
            <button
              type="button"
              className="btn"
              onClick={() => {
                void navigator.clipboard.writeText(draft.keyText).catch(() => undefined);
              }}
            >
              <Icon name="copy" size={13} /> 复制
            </button>
            <label className="switch">
              <input type="checkbox" checked={savedConfirmed} onChange={(event) => setSavedConfirmed(event.target.checked)} />
              我已保存好这把密钥
            </label>
          </div>
          <div className="sync-dialog__row">
            <button type="button" className="btn btn--primary" disabled={!savedConfirmed || busy} onClick={() => void submit()}>
              {busy ? "注册中…" : "已保存，注册到服务"}
            </button>
            <button type="button" className="btn" onClick={onCancel}>
              取消
            </button>
          </div>
        </>
      )}
      {error ? <p className="dialog__note sync-dialog__error">{error}</p> : null}
    </div>
  );
}

function ImportForm({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }): ReactNode {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="sync-dialog__form">
      <p className="dialog__message">粘贴另一台设备导出的账号密钥（opennote-key-v1.… 开头）。</p>
      <textarea
        className="field sync-dialog__key"
        value={text}
        onChange={(event) => setText(event.target.value)}
        rows={4}
        placeholder="opennote-key-v1.…"
      />
      <div className="sync-dialog__row">
        <button
          type="button"
          className="btn btn--primary"
          disabled={busy || text.trim() === ""}
          onClick={() => {
            setBusy(true);
            setError(null);
            importAccountKey(text)
              .then(onDone)
              .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? "导入中…" : "导入"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          取消
        </button>
      </div>
      {error ? <p className="dialog__note sync-dialog__error">{error}</p> : null}
    </div>
  );
}

/* ==================================== 连接 ================================== */

function ConnectionSection({ workspace }: { workspace: WorkspaceRecord }): ReactNode {
  const ui = useStore(syncUiStore);
  const config = normalizeSyncConfig(workspace.sync);
  const [baseUrl, setBaseUrl] = useState(config.baseUrl);
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [selected, setSelected] = useState<string>(config.notebookId);
  const [newName, setNewName] = useState("");
  const [newCrypto, setNewCrypto] = useState<"none" | "user-key">("none");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 列表依赖「有钥匙」：注册/导入成功后（hasKey 翻真）自动拉一次。
  // 地址输入要**去抖**：每敲一个字符都打一次服务端，既是浪费也是限流桶里的冤枉请求。
  useEffect(() => {
    if (!ui.hasKey || baseUrl.trim() === "") return;
    const timer = window.setTimeout(() => {
      setBusy("正在读取笔记本列表…");
      setError(null);
      listNotebooksApi(baseUrl.trim())
        .then((body) => setNotebooks(body))
        .catch((cause: unknown) => {
          setNotebooks(null);
          setError(cause instanceof Error ? cause.message : String(cause));
        })
        .finally(() => setBusy(null));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [ui.hasKey, baseUrl]);

  // 保存之后**不需要**在这里重绑：record 是新建的对象，App 的绑定 effect 会因
  // 它变化自动重跑（关旧的、接新的）。这里只负责把配置写进工作区记录。
  const save = (enabled: boolean, notebookId = selected) => {
    if (enabled && notebookId === "") {
      setError("先在列表里选一个远端笔记本（或新建一个）");
      return;
    }
    setError(null);
    const updated = saveWorkspaceConnection(workspace, {
      baseUrl: baseUrl.trim(),
      notebookId,
      cryptoMode: notebooks?.find((item) => item.notebookId === notebookId)?.cryptoMode ?? config.cryptoMode,
      enabled,
    });
    /*
     * ★ 保存后必须**在这里显式重绑**，不能指望 App 的绑定 effect 兜底：
     *   effect 依赖的是 `library.workspace` —— 那是**打开笔记本那一刻**的记录副本，
     *   而 updateWorkspaceSync 更新的是**注册表**里的记录，副本不会变
     *   ⇒ effect 不重跑 ⇒ attach 永远不执行 ⇒ 同步永远停在「关」
     *   （真机实测：点「保存并开启同步」毫无反应，状态栏纹丝不动）。
     */
    if (!updated) {
      setError("保存失败：工作区记录不存在");
      return;
    }
    if (enabled) {
      const backend = activeBackend();
      if (backend) void openWorkspaceSync(updated, backend);
      else setError("笔记本还没有打开，无法开启同步");
    } else {
      closeWorkspaceSync();
    }
  };

  const createNotebook = () => {
    const name = newName.trim();
    if (name === "") {
      setError("先给远端笔记本起个名字");
      return;
    }
    setBusy("正在创建笔记本…");
    setError(null);
    createNotebookApi(baseUrl.trim(), { name, cryptoMode: newCrypto })
      .then((created) => {
        setNotebooks((prev) => [...(prev ?? []), created]);
        setSelected(created.notebookId);
        setNewName("");
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusy(null));
  };

  return (
    <section className="sync-dialog__card">
      <h3 className="sync-dialog__title">
        <Icon name="layers" size={13} /> 连接（{workspace.name}）
      </h3>
      <label className="sync-dialog__label">
        服务地址
        <input
          className="field"
          value={baseUrl}
          placeholder="https://notes.example.com"
          onChange={(event) => {
            setBaseUrl(event.target.value);
            setNotebooks(null);
          }}
        />
      </label>

      {!ui.hasKey ? (
        <p className="dialog__note">先在上面的「账号」里注册或导入密钥。</p>
      ) : notebooks === null ? (
        <p className="dialog__note">{busy ?? "填写地址后自动读取笔记本列表。"}</p>
      ) : (
        <>
          <div className="sync-dialog__list">
            {notebooks.length === 0 ? <p className="dialog__note">这个账号名下还没有笔记本，在下面新建一个。</p> : null}
            {notebooks.map((item) => (
              <label key={item.notebookId} className="switch sync-dialog__option">
                <input type="radio" name="sync-notebook" checked={selected === item.notebookId} onChange={() => setSelected(item.notebookId)} />
                <span>
                  {item.name}
                  <span className="muted">
                    {" "}
                    · {item.cryptoMode === "user-key" ? "端到端加密" : "明文"} · {item.role}
                  </span>
                </span>
              </label>
            ))}
          </div>
          <div className="sync-dialog__row">
            <input
              className="field"
              style={{ flex: 1 }}
              value={newName}
              placeholder="新建远端笔记本的名字"
              onChange={(event) => setNewName(event.target.value)}
            />
            <label className="switch">
              <input type="checkbox" checked={newCrypto === "user-key"} onChange={(event) => setNewCrypto(event.target.checked ? "user-key" : "none")} />
              端到端加密
            </label>
            <button type="button" className="btn" disabled={busy !== null} onClick={createNotebook}>
              新建
            </button>
          </div>
          <p className="dialog__note">
            {newCrypto === "user-key"
              ? "端到端加密：服务端只存密文。注意——其他全新设备要先能拿到路径映射才能拉取（该能力在本分支尚未接完）。"
              : "明文模式：服务端能看到文件名与内容。"}
          </p>
          <div className="sync-dialog__row">
            <button
              type="button"
              className="btn btn--primary"
              disabled={busy !== null || selected === ""}
              onClick={() => {
                setBusy("正在连接…");
                Promise.resolve()
                  .then(() => {
                    const crypto = notebooks?.find((item) => item.notebookId === selected)?.cryptoMode;
                    if (crypto === "user-key") return unlockAccount(baseUrl.trim());
                    return undefined;
                  })
                  .then(() => save(true))
                  .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
                  .finally(() => setBusy(null));
              }}
            >
              保存并开启同步
            </button>
            {config.enabled ? (
              <button
                type="button"
                className="btn"
                onClick={() => {
                  save(false);
                }}
              >
                关闭同步
              </button>
            ) : null}
          </div>
        </>
      )}
      {busy && notebooks !== null ? <p className="dialog__note">{busy}</p> : null}
      {error ? <p className="dialog__note sync-dialog__error">{error}</p> : null}
    </section>
  );
}

/* ================================ 状态与冲突 ================================ */

function StatusSection(): ReactNode {
  const ui = useStore(syncUiStore);
  if (ui.status === null && ui.error === null) return null;
  const text = ui.status ? describeSyncStatus(ui.status) : null;

  return (
    <section className="sync-dialog__card">
      <h3 className="sync-dialog__title">
        <Icon name="rotate" size={13} /> 状态
      </h3>
      {text ? (
        <p className="dialog__message">
          {text.label}
          {text.detail ? <span className="muted"> — {text.detail}</span> : null}
        </p>
      ) : null}
      {ui.status?.phase === "syncing" ? (
        <div className="sync-progress">
          <div className="sync-progress__bar">
            <div
              className="sync-progress__fill"
              style={{
                width:
                  ui.status.progress && ui.status.progress.total > 0
                    ? `${Math.round((ui.status.progress.done / ui.status.progress.total) * 100)}%`
                    : "30%",
              }}
            />
          </div>
          <span className="muted">
            {ui.status.progress && ui.status.progress.total > 0
              ? `文件 ${ui.status.progress.done}/${ui.status.progress.total}`
              : "正在列出与规划…"}
          </span>
        </div>
      ) : null}
      {ui.last ? (
        <p className="dialog__note">
          上次同步 {formatRelativeTime(ui.last.at)}：推 {ui.last.pushed} · 拉 {ui.last.pulled} · 删 {ui.last.deleted + ui.last.remoteDeleted}
          {ui.last.unknownDids > 0 ? ` · ${ui.last.unknownDids} 条远端记录认不出路径（E2EE 映射未重建）` : ""}
        </p>
      ) : null}
      <div className="sync-dialog__row">
        <button type="button" className="btn" disabled={ui.phase !== "attached"} onClick={() => void manualSync()}>
          立即同步
        </button>
        {ui.phase === "attached" ? null : <span className="muted">同步未接上，无法手动同步。</span>}
      </div>
      <p className="dialog__note">
        触发时机：打开应用、保存笔记、窗口回到前台、手动点击。桌面端的实时订阅（SSE）还要走主进程桥，目前未接入。
      </p>
      {ui.error ? <p className="dialog__note sync-dialog__error">{ui.error}</p> : null}
    </section>
  );
}

function ConflictSection(): ReactNode {
  const ui = useStore(syncUiStore);
  const [busyPath, setBusyPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (ui.last === null || ui.last.conflicts.length === 0) return null;

  const act = (path: string, direction: "remote" | "local") => {
    setBusyPath(path);
    setError(null);
    resolveConflict(path, direction)
      .then((outcome) => {
        if (!outcome.ok && outcome.error) setError(`${path}：${outcome.error}`);
      })
      .catch((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)))
      .finally(() => setBusyPath(null));
  };

  return (
    <section className="sync-dialog__card">
      <h3 className="sync-dialog__title">
        <Icon name="edit" size={13} /> 冲突（{ui.last.conflicts.length}）
      </h3>
      <p className="dialog__note">两边都改过、引擎绝不替你猜。选定一边之后，另一台设备会在下一轮同步里收敛到同一份。</p>
      <ul className="sync-dialog__conflicts">
        {ui.last.conflicts.map((item) => (
          <li key={item.path} className="sync-dialog__conflict">
            <span className="sync-dialog__conflict-path" title={item.path}>
              {item.path}
            </span>
            <span className="muted">{kindLabel(item.kind)}</span>
            <span className="sync-dialog__row">
              <button type="button" className="btn" disabled={busyPath !== null} onClick={() => act(item.path, "remote")}>
                采用远端
              </button>
              <button type="button" className="btn" disabled={busyPath !== null} onClick={() => act(item.path, "local")}>
                用我的版本覆盖远端
              </button>
            </span>
          </li>
        ))}
      </ul>
      {busyPath ? <p className="dialog__note">正在处理 {busyPath} …</p> : null}
      {error ? <p className="dialog__note sync-dialog__error">{error}</p> : null}
    </section>
  );
}

function kindLabel(kind: string): string {
  switch (kind) {
    case "both-modified":
      return "两边都改了";
    case "deleted-locally-modified-remotely":
      return "本地已删，远端改过";
    case "deleted-remotely-modified-locally":
      return "远端已删，本地改过";
    default:
      return kind;
  }
}
