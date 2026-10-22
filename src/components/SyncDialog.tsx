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

import { type ReactNode, useEffect, useRef, useState } from "react";
import { Modal } from "./Overlays";
import { ConflictPanel } from "./ConflictPanel";
import { Icon } from "./Icons";
import { formatRelativeTime } from "../lib/utils";
import { askConfirm } from "../lib/dialogs";
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
  saveWorkspaceConnection,
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

  /*
   * ★ 顺序是**状态 → 连接 → 账号**，不是反过来。
   *
   * 用户打开这个对话框，多半是想知道「同步好了没 / 卡在哪」——那是高频问题；
   * 而「服务地址填什么」「密钥怎么导」一辈子只做一两次。
   * 以前的顺序把配置放在最上面，于是每次都要先划过一大片输入框才看得到状态。
   *
   * 例外：**还没有密钥**时账号是第一块 —— 没有它，下面两块都是死的。
   */
  return (
    <Modal title="同步" onClose={onClose} settings tall>
      <div className="sync-dialog">
        {ui.hasKey ? null : <AccountSection />}
        {workspace ? <StatusSection /> : null}
        {workspace ? <ConnectionSection workspace={workspace} /> : <p className="dialog__note">先打开一个笔记本，才能配置同步。</p>}
        {ui.hasKey ? <AccountSection /> : null}
        {ui.last && ui.last.conflicts.length > 0 ? <ConflictPanel conflicts={ui.last.conflicts} /> : null}
      </div>
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
            void askConfirm({
              title: "删除这台设备上的账号密钥？",
              message: "删除后，这台设备无法再读取已有的加密笔记，只能用密钥文本重新导入才能恢复。",
              rows: [
                { k: "不可撤销", v: "本机没有备份，删除即刻生效" },
                { k: "文件还在", v: "笔记文件留在原处，但加密内容读不出来" },
              ],
              confirmLabel: "删除密钥",
              danger: true,
            }).then((ok) => {
              if (ok) void forgetAccountKey();
            });
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
  /** 地址默认**只读**；点「修改」才变成输入框（一个一辈子只填一次的字段）。 */
  const [editingAddress, setEditingAddress] = useState(config.baseUrl === "");

  /**
   * ★ 读列表**只在显式动作时发生**：打开对话框（地址已经存过），或用户点「读取笔记本」。
   *
   * 以前是「地址一变就等 600ms 去打一次服务端」，于是用户输
   * `https://notes.example.com:8787` 的过程中，界面上会闪过好几次「连接失败」，
   * 还会白白消耗限流桶。一个一辈子只填一次的字段，不该有这个副作用。
   */
  const loadNotebooks = (url: string) => {
    const trimmed = url.trim();
    if (trimmed === "") return;
    setBusy("正在读取笔记本列表…");
    setError(null);
    listNotebooksApi(trimmed)
      .then((body) => setNotebooks(body))
      .catch((cause: unknown) => {
        setNotebooks(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(null));
  };
  const loadRef = useRef(loadNotebooks);
  loadRef.current = loadNotebooks;

  // 已经有地址 ⇒ 打开对话框时读一次（用户不用再点）；没有 ⇒ 等他填完再读。
  useEffect(() => {
    if (!ui.hasKey || config.baseUrl === "") return;
    loadRef.current(config.baseUrl);
  }, [ui.hasKey, config.baseUrl]);

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
      <div className="sync-dialog__row sync-dialog__addr">
        <span className="sync-dialog__label">服务地址</span>
        {editingAddress ? (
          <>
            <input
              className="field"
              value={baseUrl}
              autoFocus
              placeholder="https://notes.example.com"
              onChange={(event) => setBaseUrl(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                setNotebooks(null);
                loadNotebooks(baseUrl);
                if (baseUrl.trim() !== "") setEditingAddress(false);
              }}
            />
            <button
              type="button"
              className="btn"
              onClick={() => {
                setNotebooks(null);
                loadNotebooks(baseUrl);
                if (baseUrl.trim() !== "") setEditingAddress(false);
              }}
            >
              读取笔记本
            </button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setBaseUrl(config.baseUrl);
                setEditingAddress(false);
                loadNotebooks(config.baseUrl);
              }}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <span className="sync-dialog__value">{config.baseUrl}</span>
            <button type="button" className="btn" onClick={() => setEditingAddress(true)}>
              修改
            </button>
          </>
        )}
      </div>

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
  const text = ui.status ? describeSyncStatus(ui.status) : null;
  /*
   * 改动量：**全为零时不说「推 0 · 拉 0 · 删 0」**。
   * 三个 0 摆在那里没有任何信息量，读起来还像"出问题了"。
   */
  const changed = ui.last ? ui.last.pushed + ui.last.pulled + ui.last.deleted + ui.last.remoteDeleted : 0;

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
          上次同步 {formatRelativeTime(ui.last.at)}
          {changed === 0 ? " · 没有需要同步的改动" : ""}
          {ui.last.pushed > 0 ? ` · 推 ${ui.last.pushed} 篇` : ""}
          {ui.last.pulled > 0 ? ` · 拉 ${ui.last.pulled} 篇` : ""}
          {ui.last.deleted + ui.last.remoteDeleted > 0 ? ` · 删 ${ui.last.deleted + ui.last.remoteDeleted} 篇` : ""}
          {ui.last.unknownDids > 0 ? ` · ${ui.last.unknownDids} 条远端记录认不出路径（E2EE 映射未重建）` : ""}
        </p>
      ) : null}
      {/*
        ★ 这两个数字以前**根本不显示**，而它们恰好对应两种「看起来同步成功了、
           其实没同步」的状态：远端树没取全时，删除会被全部挂起。
           不显示 ⇒ 用户只会觉得「我删掉的笔记又回来了」，而且没有任何线索。
      */}
      {ui.last && ui.last.treeTruncated ? (
        <p className="dialog__note sync-dialog__error">
          远端笔记本太大，这一次**没有把远端列表取全**：这次只做了新增与更新，删除被全部挂起。
          如果你删过笔记却没同步过去，就是它。请再次同步（通常会继续翻页补全）。
        </p>
      ) : null}
      {ui.last && ui.last.suspendedDeletes > 0 ? (
        <p className="dialog__note sync-dialog__error">
          有 {ui.last.suspendedDeletes} 条删除被**挂起**了（远端列表不完整时不敢推断「远端删了它」）。
          这是防误删的保护，不是错误；列表取全之后它们会自动生效。
        </p>
      ) : null}
      <div className="sync-dialog__row">
        <button type="button" className="btn" disabled={ui.phase !== "attached"} onClick={() => void manualSync()}>
          立即同步
        </button>
        {ui.phase === "attached" ? null : <span className="muted">同步未接上，无法手动同步。</span>}
      </div>
      {/*
       * ★ 这段以前是**错的**，而且错得很具体：还写着「窗口回到前台」和
       * 「桌面端的实时订阅（SSE）还要走主进程桥，目前未接入」——
       * 前者早就删了，后者早就接上了。功能改完不回头改文案，界面就会替你说谎。
       */}
      <p className="dialog__note">
        打开笔记本时会核对一次（没有变化就不发请求）；保存笔记后自动推送；别的设备的改动由实时推送带过来。
      </p>
      {ui.error ? <p className="dialog__note sync-dialog__error">{ui.error}</p> : null}
      {ui.logs.length > 0 ? (
        <details className="sync-dialog__diag">
          <summary>诊断（排查用）</summary>
          <pre className="sync-dialog__logs">{ui.logs.slice(-12).join("\n")}</pre>
        </details>
      ) : null}
    </section>
  );
}
