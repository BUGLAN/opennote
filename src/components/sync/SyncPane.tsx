/**
 * 设置 → 同步（`docs/sync/mockups/02-settings-sync.html`，取代 SyncDialog）。
 *
 * 一条旅程，按账号状态分两段：
 *
 * | 没登录 | 首屏二选一（登录 / 从另一台设备加入）→ 登录表单（邮箱密码或 GitHub）/ 6 位码 → 选笔记本 |
 * | 已登录 | 一句话状态 + 笔记本开关 + 冲突 + 设备 + 加密口令 + 账号 + 诊断 |
 *
 * 只同步**当前打开**的笔记本；其它笔记本的开关只是记下意愿，「下次打开时同步」。
 * 强调色只给需要你处理的：待处理冲突、待解锁、需要重新登录。
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { HealthResponse, NotebookSummary } from "../../../shared/contract";
import { listWorkspaces, normalizeSyncConfig, useWorkspaces, workspaceDisplayName, type WorkspaceRecord } from "../../data/workspaces";
import { askConfirm } from "../../lib/dialogs";
import { useStore } from "../../lib/store";
import { clearSyncHistory, loadSyncHistory, syncHistoryStore, type SyncHistoryEntry } from "../../sync/history";
import { notify } from "../../lib/toast";
import { cn, formatBytes, formatRelativeTime } from "../../lib/utils";
import {
  abandonGithubSignIn,
  changePassphrase,
  changePassword,
  defaultDeviceName,
  forgetRememberedKey,
  githubFlowStore,
  joinWithCode,
  linkGithub,
  listDevices,
  openInBrowser,
  probeSameOriginServer,
  probeServer,
  refreshAccount,
  remoteNotebooks,
  removeDevice,
  setPassphrase,
  signInPrefillStore,
  signInWithPassword,
  signOut,
  startAddDevice,
  startGithubSignIn,
  syncAccountStore,
  unlinkGithub,
  unlockWithPassphrase,
  type AddDeviceSession,
} from "../../sync/account";
import { manualSync, setWorkspaceSyncEnabled, syncUiStore } from "../../sync/appSync";
import { passphraseProblem } from "../../sync/vault";
import { ConflictPanel } from "../ConflictPanel";
import { Icon } from "../Icons";
import { Modal } from "../Overlays";

/** GitHub 标志（与原型同一个路径）。 */
function GithubMark(): ReactNode {
  return (
    <svg className="sync-gh" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 跑一个异步动作：期间 busy，失败把错误放进 setError（不弹 toast：错误就留在表单旁边）。 */
function useAction(): { busy: boolean; error: string | null; setError(message: string | null): void; run(task: () => Promise<void>): Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  useEffect(() => () => void (mounted.current = false), []);
  return {
    busy,
    error,
    setError,
    async run(task) {
      setBusy(true);
      setError(null);
      try {
        await task();
        return true;
      } catch (failure) {
        if (mounted.current) setError(errorText(failure));
        return false;
      } finally {
        if (mounted.current) setBusy(false);
      }
    },
  };
}

type View = "home" | "sign-in" | "pair" | "choose" | "main";

export function SyncPane({
  workspace: opened,
  onDownloadRemote,
}: {
  workspace: WorkspaceRecord | null;
  /** 「只在云端的」笔记本 → 在本机建一个笔记本并绑上它（由 App 决定建在哪：文件夹 / 浏览器 / 手机）。 */
  onDownloadRemote(notebook: NotebookSummary): Promise<void>;
}): ReactNode {
  const account = useStore(syncAccountStore);
  const github = useStore(githubFlowStore);
  const [view, setView] = useState<View>("home");
  // App 传进来的是打开时那一份记录；同步开关改的是注册表里的新一份 —— 以注册表为准。
  const registry = useWorkspaces();
  const workspace = opened ? (registry.workspaces.find((record) => record.id === opened.id) ?? opened) : null;
  const signedIn = account.account !== null;

  useEffect(() => {
    void refreshAccount();
  }, []);

  // 登录成功（任何一条路）之后：第一次进入「选笔记本」；退出之后回首屏。
  const wasSignedIn = useRef(signedIn);
  useEffect(() => {
    if (signedIn && !wasSignedIn.current) setView("choose");
    if (!signedIn && wasSignedIn.current) setView("home");
    wasSignedIn.current = signedIn;
  }, [signedIn]);

  if (!account.loaded) return <div className="sync-pane muted">正在读取同步状态…</div>;

  if (!signedIn) {
    if (github.phase !== "idle") return <GithubWait />;
    if (view === "sign-in") return <SignInView onBack={() => setView("home")} />;
    if (view === "pair") return <PairView onBack={() => setView("home")} />;
    return <HomeView onSignIn={() => setView("sign-in")} onPair={() => setView("pair")} />;
  }
  if (account.needsSignIn) return <SignInView onBack={null} relogin />;
  if (view === "choose") return <ChooseView workspace={workspace} onDone={() => setView("main")} onDownloadRemote={onDownloadRemote} />;
  return <MainView workspace={workspace} onDownloadRemote={onDownloadRemote} />;
}

/* ============================================================================
   没登录
   ============================================================================ */

/**
 * 没登录时的首屏：**安静地说明**，不催。
 *
 * 很多人就是离线用的 —— 笔记是这台设备上的普通文件，不登录什么都不缺。以前这里是一张带边框的
 * 大卡片「这台设备还没有开启同步」+ 两块大按钮，读起来像「出问题了」（用户原话：太醒目）。
 * 现在：一段平铺的说明 + 两行和其它设置项一样的入口，没有图标框、没有强调色。
 */
function HomeView({ onSignIn, onPair }: { onSignIn(): void; onPair(): void }): ReactNode {
  return (
    <div className="sync-pane">
      <div className="sync-intro">
        <p>同步是可选的。不登录也能完整使用：笔记一直是这台设备上的普通文件。</p>
        <p>想让电脑、手机和网页上的笔记保持一致时，再连上一台自托管的 Opennote 同步服务器。</p>
      </div>
      <div className="sync-list">
        <button type="button" className="sync-row sync-row--link" onClick={onSignIn}>
          <span className="sync-row__main">
            登录同步账号
            <small>邮箱密码或 GitHub。第一次用，先打开管理员发给你的邀请链接。</small>
          </span>
          <Icon name="chevronRight" size={14} className="sync-row__chevron" />
        </button>
        <button type="button" className="sync-row sync-row--link" onClick={onPair}>
          <span className="sync-row__main">
            从另一台设备加入
            <small>在已经同步的那台设备上点「添加设备」，在这里输入 6 位码。</small>
          </span>
          <Icon name="chevronRight" size={14} className="sync-row__chevron" />
        </button>
      </div>
    </div>
  );
}

/** 服务器地址输入框：失焦就探测，结果写在框下面。 */
function useServerProbe(initial: string): {
  server: string;
  setServer(value: string): void;
  probe(): Promise<HealthResponse | null>;
  health: HealthResponse | null;
  hint: ReactNode;
} {
  const [server, setServer] = useState(initial);
  const [state, setState] = useState<{ checked: string; health: HealthResponse | null; error: string | null; checking: boolean }>({ checked: "", health: null, error: null, checking: false });
  const probe = async (): Promise<HealthResponse | null> => {
    const target = server.trim();
    if (target === "") return null;
    if (state.checked === target && state.health) return state.health;
    setState({ checked: target, health: null, error: null, checking: true });
    try {
      const health = await probeServer(target);
      setState({ checked: target, health, error: null, checking: false });
      return health;
    } catch (error) {
      setState({ checked: target, health: null, error: errorText(error), checking: false });
      return null;
    }
  };
  useEffect(() => {
    if (initial.trim() !== "") {
      void probe();
      return;
    }
    /*
     * 没有预填地址：网页版若就是同步服务器自己托管的（issue #1，同源），把这个源填上。
     * 只在用户还没动过输入框时填；探测不到就什么也不显示。
     */
    let cancelled = false;
    void probeSameOriginServer().then((found) => {
      if (cancelled || !found) return;
      setServer((current) => (current.trim() === "" ? found.server : current));
      setState((current) => (current.checked === "" ? { checked: found.server, health: found.health, error: null, checking: false } : current));
    });
    return () => {
      cancelled = true;
    };
    // 只在第一次进来时探测一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const health = state.checked === server.trim() ? state.health : null;
  const hint = state.checking ? (
    <span className="sync-hint">正在连接…</span>
  ) : health ? (
    <span className="sync-hint sync-hint--ok">
      已找到 Opennote 同步服务 · 协议 {health.protocolVersion}
      {health.auth.github ? " · 支持 GitHub 登录" : ""}
      {health.registration === "invite" ? " · 仅限邀请注册" : health.registration === "open" ? " · 开放注册" : " · 暂不接受新账号"}
    </span>
  ) : state.error && state.checked === server.trim() ? (
    <span className="sync-hint sync-hint--bad">{state.error}</span>
  ) : (
    <span className="sync-hint">例如 notes.example.com。粘贴邀请链接也行，会自动取出地址。</span>
  );
  return {
    server,
    setServer: (value) => {
      // 粘贴的是邀请链接（https://x/join/…）：只留地址部分。
      const match = /^(https?:\/\/[^/]+)\/(?:join|reset)\//.exec(value.trim());
      setServer(match ? match[1]! : value);
    },
    probe,
    health,
    hint,
  };
}

function SignInView({ onBack, relogin = false }: { onBack: (() => void) | null; relogin?: boolean }): ReactNode {
  const account = useStore(syncAccountStore);
  const prefill = useStore(signInPrefillStore);
  const { server, setServer, probe, health, hint } = useServerProbe(account.account?.server ?? prefill.server ?? "");
  const [email, setEmail] = useState(account.account?.email ?? prefill.email ?? "");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(account.account?.deviceName ?? defaultDeviceName());
  const action = useAction();

  const submit = async () => {
    const found = await probe();
    if (!found) return action.setError("先填一个能连上的服务器地址");
    if (!email.trim() || !password) return action.setError("请填写邮箱和密码");
    await action.run(() => signInWithPassword({ server, email, password, deviceName }));
  };
  const withGithub = async () => {
    const found = await probe();
    if (!found) return;
    await action.run(() => startGithubSignIn({ server, deviceName }));
  };

  return (
    <div className="sync-pane sync-pane--flow">
      {relogin ? null : (
        <div className="sync-steps">
          <b>① 登录</b>
          <span>—</span>
          <span>② 选择要同步的笔记本</span>
          <span>—</span>
          <span>③ 完成</span>
        </div>
      )}
      <h3>{relogin ? "需要重新登录" : "登录同步账号"}</h3>
      <p className="dialog__message">
        {relogin ? "这台设备的同步登录已失效（密码在别处改过，或这台设备被移除了）。本机笔记都还在，登录后接着同步。" : "粘贴邀请链接会自动填好服务器地址。"}
      </p>
      <form
        className="sync-form"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label className="sync-lab">
          服务器地址
          <input className="field" value={server} onChange={(event) => setServer(event.target.value)} onBlur={() => void probe()} placeholder="notes.example.com" spellCheck={false} autoComplete="url" />
          {hint}
        </label>
        {health?.auth.github ? (
          <>
            <button type="button" className="btn" disabled={action.busy} onClick={() => void withGithub()}>
              <GithubMark />
              使用 GitHub 登录
            </button>
            {health.auth.password ? <div className="sync-divider">或用邮箱登录</div> : null}
          </>
        ) : null}
        {health && !health.auth.password ? null : (
          <>
            <label className="sync-lab">
              邮箱
              <input className="field" type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="username" />
            </label>
            <label className="sync-lab">
              密码
              <input className="field" type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
            </label>
          </>
        )}
        <label className="sync-lab">
          设备名称
          <input className="field" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={120} />
          <span className="sync-hint">会出现在设备列表里，方便你分辨是哪台。</span>
        </label>
        {action.error ? <p className="sync-error" role="alert">{action.error}</p> : null}
        <div className="sync-row-actions">
          {health && !health.auth.password ? null : (
            <button type="submit" className="btn btn--primary" disabled={action.busy}>
              {action.busy ? "正在登录…" : "登录"}
            </button>
          )}
          {onBack ? (
            <button type="button" className="btn btn--ghost" onClick={onBack}>
              返回
            </button>
          ) : (
            <button type="button" className="btn btn--ghost" onClick={() => void signOut()}>
              退出这个账号
            </button>
          )}
          <span className="grow" />
          <span className="sync-hint" title="服务器不发邮件：请管理员在控制台里给你生成一个设置密码链接">
            忘记密码？找管理员要设置密码链接
          </span>
        </div>
      </form>
      {relogin ? null : (
        <div className="sync-callout">第一次使用？先打开管理员发给你的邀请链接（服务器地址/join/…），在网页里设密码或用 GitHub 接受邀请，再回来登录。</div>
      )}
    </div>
  );
}

function GithubWait(): ReactNode {
  const flow = useStore(githubFlowStore);
  return (
    <div className="sync-pane sync-pane--flow">
      <div className="sync-steps">
        <b>① 登录</b>
        <span>—</span>
        <span>② 选择要同步的笔记本</span>
        <span>—</span>
        <span>③ 完成</span>
      </div>
      <h3>在浏览器里完成 GitHub 授权</h3>
      {flow.phase === "error" ? (
        <div className="sync-callout sync-callout--attn">
          <strong>没能用 GitHub 登录</strong>：{flow.error}
        </div>
      ) : (
        <>
          <p className="dialog__message">已经在浏览器打开 GitHub 的授权页。点「Authorize」之后会自动回到 Opennote。</p>
          <div className="sync-row-actions muted">
            <span className="sync-spin" /> {flow.phase === "finishing" ? "正在登录…" : "等待授权完成…"}
          </div>
        </>
      )}
      <div className="sync-row-actions">
        {flow.url && flow.phase !== "finishing" ? (
          <button type="button" className="btn btn--sm" onClick={() => void openInBrowser(flow.url!)}>
            重新打开浏览器
          </button>
        ) : null}
        {flow.url ? (
          <button type="button" className="btn btn--sm" onClick={() => void navigator.clipboard?.writeText(flow.url!).then(() => notify("已复制授权链接"))}>
            <Icon name="copy" size={13} />
            复制授权链接
          </button>
        ) : null}
        <button type="button" className="btn btn--ghost btn--sm" onClick={abandonGithubSignIn}>
          {flow.phase === "error" ? "返回" : "取消"}
        </button>
      </div>
    </div>
  );
}

/** 6 个格子的码输入：粘贴整串也行。 */
function CodeInput({ value, onChange, disabled }: { value: string; onChange(value: string): void; disabled: boolean }): ReactNode {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = value.padEnd(6, " ").slice(0, 6).split("");
  const set = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, "");
    if (clean.length > 1) {
      onChange(clean.slice(0, 6));
      refs.current[Math.min(clean.length, 5)]?.focus();
      return;
    }
    const next = digits.map((digit, i) => (i === index ? clean || " " : digit)).join("").replace(/\s+$/, "");
    onChange(next);
    if (clean && index < 5) refs.current[index + 1]?.focus();
  };
  return (
    <div className="sync-code6" role="group" aria-label="6 位配对码">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => void (refs.current[index] = node)}
          inputMode="numeric"
          autoComplete="one-time-code"
          aria-label={`第 ${index + 1} 位`}
          value={digit.trim()}
          disabled={disabled}
          onChange={(event) => set(index, event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Backspace" && !digit.trim() && index > 0) refs.current[index - 1]?.focus();
          }}
        />
      ))}
    </div>
  );
}

function PairView({ onBack }: { onBack(): void }): ReactNode {
  const account = useStore(syncAccountStore);
  const prefill = useStore(signInPrefillStore);
  const { server, setServer, probe, hint } = useServerProbe(prefill.server ?? "");
  const [code, setCode] = useState("");
  const [deviceName, setDeviceName] = useState(defaultDeviceName());
  const [remember, setRemember] = useState(account.storage.risk === null);
  const [joined, setJoined] = useState<{ check: string; email: string | null } | null>(null);
  const action = useAction();
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const submit = async () => {
    if (!(await probe())) return action.setError("先填一个能连上的服务器地址");
    if (!/^\d{6}$/.test(code)) return action.setError("配对码是 6 位数字");
    await action.run(async () => {
      const session = await joinWithCode({ server, code, deviceName, remember });
      setJoined({ check: session.check, email: session.email });
      abort.current = new AbortController();
      const result = await session.wait(abort.current.signal);
      if (result === "rejected") throw new Error("另一台设备拒绝了这次加入");
      if (result === "expired") throw new Error("配对码已经过期了，请在另一台设备上换一个码");
    });
    setJoined(null);
  };

  return (
    <div className="sync-pane sync-pane--flow">
      <div className="sync-steps">
        <b>① 配对</b>
        <span>—</span>
        <span>② 选择要同步的笔记本</span>
        <span>—</span>
        <span>③ 完成</span>
      </div>
      <h3>{joined ? "在另一台设备上确认" : "输入配对码"}</h3>
      {joined ? (
        <>
          <p className="dialog__message">
            另一台设备{joined.email ? `（${joined.email}）` : ""}上会出现「这台设备想要加入」。确认那边显示的校验码与这里一致，再点「确认」。
          </p>
          <p className="sync-check">{joined.check}</p>
          <div className="sync-row-actions muted" style={{ justifyContent: "center" }}>
            <span className="sync-spin" /> 等待确认…
          </div>
        </>
      ) : (
        <>
          <p className="dialog__message">在已经同步的设备上打开「设置 → 同步 → 添加设备」，把那里显示的 6 位码填到这里。</p>
          <form
            className="sync-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label className="sync-lab">
              服务器地址
              <input className="field" value={server} onChange={(event) => setServer(event.target.value)} onBlur={() => void probe()} placeholder="和另一台设备用的同一个" spellCheck={false} />
              {hint}
            </label>
            <CodeInput value={code} onChange={setCode} disabled={action.busy} />
            <label className="sync-lab">
              设备名称
              <input className="field" value={deviceName} onChange={(event) => setDeviceName(event.target.value)} maxLength={120} />
            </label>
            {account.canRemember ? (
              <label className="switch">
                <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
                把加密口令记在这台设备上
              </label>
            ) : null}
            <div className="sync-callout">配对成功后这台设备会登录<strong>同一个账号</strong>，加密口令也会一起安全地带过来，不需要再输入一遍。</div>
            {action.error ? <p className="sync-error" role="alert">{action.error}</p> : null}
            <div className="sync-row-actions">
              <button type="submit" className="btn btn--primary" disabled={action.busy}>
                加入
              </button>
              <button type="button" className="btn btn--ghost" onClick={onBack}>
                返回
              </button>
            </div>
          </form>
        </>
      )}
      {joined && action.error ? <p className="sync-error">{action.error}</p> : null}
    </div>
  );
}

/* ============================================================================
   选笔记本（登录后的第二步，也是日常视图里「笔记本」一节）
   ============================================================================ */

function useRemoteNotebooks(): { notebooks: NotebookSummary[] | null; reload(): void } {
  const [notebooks, setNotebooks] = useState<NotebookSummary[] | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    remoteNotebooks()
      .then((list) => !cancelled && setNotebooks(list))
      .catch(() => !cancelled && setNotebooks([]));
    return () => void (cancelled = true);
  }, [tick]);
  return { notebooks, reload: () => setTick((value) => value + 1) };
}

/** 一行本机笔记本该怎么说（会发生什么）。 */
function describeLocal(record: WorkspaceRecord, current: boolean, remote: NotebookSummary[] | null): { text: string; tag: ReactNode } {
  const config = normalizeSyncConfig(record.sync);
  const name = workspaceDisplayName(record);
  const bound = remote?.find((notebook) => notebook.notebookId === config.notebookId) ?? null;
  const sameName = remote?.find((notebook) => notebook.name === name) ?? null;
  const target = bound ?? (config.notebookId === "" ? sameName : null);
  const encrypted = (target?.cryptoMode ?? config.cryptoMode) === "user-key";
  const tag = encrypted ? <span className="sync-tag sync-tag--solid">端到端加密</span> : <span className="sync-tag sync-tag--solid">明文</span>;
  if (!config.enabled) return { text: sameName ? "云端有同名笔记本 · 打开同步后会合并" : "只在这台设备", tag: <span className="sync-tag">不同步</span> };
  const when = current ? "" : " · 下次打开时同步";
  if (bound) return { text: `已对上云端笔记本${when}`, tag };
  if (sameName) return { text: `将与云端的同名笔记本合并${when}`, tag };
  return { text: `云端没有 · 将新建并上传${when}`, tag };
}

/** 云端有、这台设备上没有的笔记本：可以下载到本机（新设备上手的主路径）。 */
function CloudOnlyList({ notebooks, onDownloadRemote }: { notebooks: NotebookSummary[]; onDownloadRemote(notebook: NotebookSummary): Promise<void> }): ReactNode {
  const [downloading, setDownloading] = useState<string | null>(null);
  if (notebooks.length === 0) return null;
  return (
    <>
      <p className="sync-section-h">只在云端的</p>
      <div className="sync-list">
        {notebooks.map((notebook) => (
          <div key={notebook.notebookId} className="sync-row">
            <span className="sync-row__icon">
              <Icon name={notebook.cryptoMode === "user-key" ? "lock" : "note"} size={15} />
            </span>
            <div className="sync-row__main">
              {notebook.name}
              <small>{notebook.cryptoMode === "user-key" ? "端到端加密 · " : ""}在这台设备上还没有</small>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              disabled={downloading !== null}
              onClick={() => {
                setDownloading(notebook.notebookId);
                void onDownloadRemote(notebook)
                  .catch((error: unknown) => notify(errorText(error), { kind: "danger" }))
                  .finally(() => setDownloading(null));
              }}
            >
              {downloading === notebook.notebookId ? "正在准备…" : "下载到本机…"}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function NotebookList({
  workspace,
  remote,
  newMode,
  onToggle,
  onDownloadRemote,
}: {
  workspace: WorkspaceRecord | null;
  remote: NotebookSummary[] | null;
  newMode: "none" | "user-key";
  onToggle(record: WorkspaceRecord, enabled: boolean): void;
  onDownloadRemote(notebook: NotebookSummary): Promise<void>;
}): ReactNode {
  useWorkspaces(); // 开关改了 record.sync 之后重画
  const locals = listWorkspaces();
  const ui = useStore(syncUiStore);
  const boundIds = new Set(locals.map((record) => normalizeSyncConfig(record.sync).notebookId).filter(Boolean));
  const localNames = new Set(locals.map((record) => workspaceDisplayName(record)));
  const cloudOnly = (remote ?? []).filter((notebook) => !boundIds.has(notebook.notebookId) && !localNames.has(notebook.name));

  return (
    <>
      <p className="sync-section-h">这台设备上的</p>
      <div className="sync-list">
        {locals.length === 0 ? <div className="sync-row sync-row--empty">还没有打开过任何笔记本。</div> : null}
        {locals.map((record) => {
          const current = record.id === workspace?.id;
          const config = normalizeSyncConfig(record.sync);
          const described = describeLocal(record, current, remote);
          const status = current && config.enabled ? currentStatusText(ui) : null;
          return (
            <div key={record.id} className="sync-row">
              <label className="switch" aria-label={`同步「${workspaceDisplayName(record)}」`}>
                <input type="checkbox" checked={config.enabled} onChange={(event) => onToggle(record, event.target.checked)} />
              </label>
              <div className="sync-row__main">
                {workspaceDisplayName(record)}
                {current ? <span className="muted">（正在用）</span> : null}
                <small>{status ?? described.text}</small>
              </div>
              {config.enabled || config.notebookId ? described.tag : <span className="sync-tag">{newMode === "user-key" ? "新建时加密" : "不同步"}</span>}
            </div>
          );
        })}
      </div>
      <CloudOnlyList notebooks={cloudOnly} onDownloadRemote={onDownloadRemote} />
    </>
  );
}

/** 「新笔记本加密」+（需要时）设加密口令。返回当前选择与「能不能开始」。 */
function NewNotebookEncryption({ mode, onMode }: { mode: "none" | "user-key"; onMode(mode: "none" | "user-key"): void }): ReactNode {
  const account = useStore(syncAccountStore);
  return (
    <div className="setting">
      <div className="setting__label">
        新笔记本加密<small>只影响云端还没有的</small>
      </div>
      <div className="setting__control">
        <div className="segmented">
          <button type="button" className={cn(mode === "none" && "is-active")} onClick={() => onMode("none")}>
            不加密
          </button>
          <button type="button" className={cn(mode === "user-key" && "is-active")} onClick={() => onMode("user-key")}>
            端到端加密
          </button>
        </div>
        <div className="setting__meta">
          端到端加密时服务器只存密文，管理员也看不到内容。需要一个<strong>加密口令</strong>，忘了无法找回。
          {mode === "user-key" && account.encryption === "unlocked" ? " 已解锁，可以直接用。" : ""}
        </div>
        {mode === "user-key" && account.encryption !== "unlocked" ? <PassphraseForm compact /> : null}
      </div>
    </div>
  );
}

function ChooseView({ workspace, onDone, onDownloadRemote }: { workspace: WorkspaceRecord | null; onDone(): void; onDownloadRemote(notebook: NotebookSummary): Promise<void> }): ReactNode {
  const account = useStore(syncAccountStore);
  const { notebooks } = useRemoteNotebooks();
  const [mode, setMode] = useState<"none" | "user-key">("none");
  const [picked, setPicked] = useState<Set<string>>(() => new Set(workspace ? [workspace.id] : []));
  useWorkspaces();
  const locals = listWorkspaces();
  const blocked = mode === "user-key" && account.encryption !== "unlocked";

  const start = () => {
    try {
      for (const record of locals) setWorkspaceSyncEnabled(record, picked.has(record.id), mode);
      onDone();
    } catch (error) {
      notify(errorText(error), { kind: "danger" });
    }
  };

  return (
    <div className="sync-pane">
      <div className="sync-steps">
        <span>① 登录</span>
        <span>—</span>
        <b>② 选择要同步的笔记本</b>
        <span>—</span>
        <span>③ 完成</span>
      </div>
      <h3>要同步哪些笔记本？</h3>
      <p className="dialog__message">按名字自动配对本机与云端的笔记本：同名的合并，两边都改过的篇目进冲突列表，不会静默覆盖。以后随时可以在这里改。</p>
      <p className="sync-section-h">这台设备上的</p>
      <div className="sync-list">
        {locals.length === 0 ? <div className="sync-row sync-row--empty">还没有打开过任何笔记本。</div> : null}
        {locals.map((record) => {
          const name = workspaceDisplayName(record);
          const same = notebooks?.find((notebook) => notebook.name === name) ?? null;
          const on = picked.has(record.id);
          return (
            <div key={record.id} className="sync-row">
              <label className="switch" aria-label={`同步「${name}」`}>
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(event) =>
                    setPicked((prev) => {
                      const next = new Set(prev);
                      if (event.target.checked) next.add(record.id);
                      else next.delete(record.id);
                      return next;
                    })
                  }
                />
              </label>
              <div className="sync-row__main">
                {name}
                {record.id === workspace?.id ? <span className="muted">（正在用）</span> : null}
                <small>
                  {!on
                    ? "只留在这台设备"
                    : same
                      ? `云端已有同名笔记本 · 将合并${same.cryptoMode === "user-key" ? "（端到端加密）" : ""}`
                      : `云端没有 · 将新建并上传${record.id === workspace?.id ? "" : "（下次打开时）"}`}
                </small>
              </div>
              <span className={cn("sync-tag", on && "sync-tag--solid")}>
                {!on ? "不同步" : same ? "合并" : mode === "user-key" ? "新建 · 加密" : "新建"}
              </span>
            </div>
          );
        })}
      </div>
      <CloudOnlyList notebooks={(notebooks ?? []).filter((notebook) => !locals.some((record) => workspaceDisplayName(record) === notebook.name))} onDownloadRemote={onDownloadRemote} />
      <NewNotebookEncryption mode={mode} onMode={setMode} />
      <div className="sync-row-actions">
        <button type="button" className="btn btn--primary" disabled={blocked} onClick={start} title={blocked ? "先设好加密口令" : undefined}>
          {picked.size > 0 ? `开始同步 ${picked.size} 个笔记本` : "完成"}
        </button>
        <button type="button" className="btn btn--ghost" onClick={onDone}>
          稍后再说
        </button>
      </div>
    </div>
  );
}

/* ============================================================================
   已登录：日常
   ============================================================================ */

function currentStatusText(ui: ReturnType<typeof syncUiStore.get>): string | null {
  if (ui.reason === "locked") return "等待解锁加密口令";
  if (ui.reason === "other-server") return "绑的是另一台服务器";
  if (ui.reason === "other-tab") return "正在另一个标签页里同步";
  const status = ui.status;
  if (!status) return ui.phase === "attaching" ? "正在连接…" : null;
  if (status.phase === "syncing") return status.progress && status.progress.total > 0 ? `同步中 ${status.progress.done} / ${status.progress.total}` : "同步中…";
  if (status.phase === "offline") return "离线，恢复后自动上传";
  if (status.phase === "error") return `出错：${status.error}`;
  if (status.phase === "idle") {
    const pending = Math.max(status.conflicts, ui.last?.conflicts.length ?? 0);
    if (pending > 0) return `${pending} 篇待处理 · 其余已同步`;
    return status.lastSyncedAt ? `已同步 · ${formatRelativeTime(status.lastSyncedAt)}` : "等待第一次同步";
  }
  return null;
}

function Hero({ workspace }: { workspace: WorkspaceRecord | null }): ReactNode {
  const ui = useStore(syncUiStore);
  const account = useStore(syncAccountStore);
  const config = workspace ? normalizeSyncConfig(workspace.sync) : null;
  const action = useAction();
  const conflicts = ui.last?.conflicts ?? [];

  if (account.disabled) {
    return <HeroBox attn icon="lock" title="同步账号已被停用" sub="这台设备的同步暂停了，本机笔记都还在。请联系同步服务器的管理员。" />;
  }
  if (!workspace) return <HeroBox icon="note" title="先打开一个笔记本" sub="只同步当前打开的笔记本；打开之后这里会显示它的同步状态。" />;
  if (!config?.enabled) {
    return <HeroBox icon="rotate" title={`「${workspaceDisplayName(workspace)}」没有开启同步`} sub="在下面「笔记本」里打开它的开关，就会和云端合并并保持一致。" />;
  }
  if (ui.reason === "locked") return <UnlockHero name={workspaceDisplayName(workspace)} />;
  if (ui.reason === "other-server") {
    return <HeroBox attn icon="info" title="这个笔记本绑的是另一台服务器" sub={`它绑的是 ${config.baseUrl}，而这台设备登录的是 ${account.account?.server}。关掉它的同步再打开，就会改绑到当前服务器（按名字合并）。`} />;
  }
  if (ui.reason === "other-tab") {
    return <HeroBox icon="info" title="这个笔记本正在另一个标签页里同步" sub="同一时间只让一个标签页同步，免得重复上传、互相覆盖同步记录。这里照常编辑，改动会交给那边上传；关掉那个标签页后，这里会自动接手。" />;
  }
  if (conflicts.length > 0) {
    return <HeroBox attn icon="info" title={`${conflicts.length} 篇笔记需要你决定保留哪一份`} sub="这几篇在你处理之前不会再上传或覆盖；其余笔记照常同步。" />;
  }
  const status = ui.status;
  if (status?.phase === "syncing") {
    const progress = status.progress;
    const ratio = progress && progress.total > 0 ? progress.done / progress.total : null;
    return (
      <div className="sync-hero">
        <div className="sync-hero__icon">
          <span className="sync-spin" />
        </div>
        <div className="sync-hero__main">
          <div className="sync-hero__title">
            正在同步「{workspaceDisplayName(workspace)}」{progress && progress.total > 0 ? ` · ${progress.done} / ${progress.total}` : ""}
          </div>
          <div className="sync-hero__sub">可以继续写作，新改动会排在后面。</div>
          {ratio !== null ? (
            <div className="sync-progress">
              <i style={{ width: `${Math.round(ratio * 100)}%` }} />
            </div>
          ) : null}
        </div>
      </div>
    );
  }
  const retry = (
    <button type="button" className="btn btn--sm" disabled={action.busy} onClick={() => void action.run(async () => void (await manualSync()))}>
      {action.busy ? "正在同步…" : status?.phase === "offline" || status?.phase === "error" ? "现在重试" : "立即同步"}
    </button>
  );
  if (status?.phase === "offline") {
    return <HeroBox icon="info" title="连不上同步服务器" sub={`改动都安全地存在本机，恢复连接后会自动上传。（${status.error}）`} action={retry} />;
  }
  if (status?.phase === "error") return <HeroBox attn icon="info" title="同步出错了" sub={status.error} action={retry} />;
  const last = ui.last;
  const quotaFull = last?.rejected?.filter((item) => item.reason === "quota") ?? [];
  if (quotaFull.length > 0) {
    // 服务端的原话里带着已用 / 配额（「空间已满：已用 …，配额 …」），直接给人看。
    return (
      <HeroBox
        attn
        icon="info"
        title={`空间已满，有 ${quotaFull.length} 个文件没上传`}
        sub={`${quotaFull[0].message}。删掉一些云端的内容或请管理员调高配额后会自动重试；其它改动照常同步，这些文件仍好好地存在本机。`}
        action={retry}
      />
    );
  }
  const tooLarge = last?.rejected?.filter((item) => item.reason === "too-large") ?? [];
  if (tooLarge.length > 0) {
    const names = tooLarge.slice(0, 3).map((item) => item.path.split("/").pop()).join("、");
    return (
      <HeroBox
        attn
        icon="info"
        title={`有 ${tooLarge.length} 个文件超过服务器的单个文件上限，没有上传`}
        sub={`${names}${tooLarge.length > 3 ? " 等" : ""}：${tooLarge[0].message}。它们只留在这台设备上；其它改动照常同步。`}
        action={retry}
      />
    );
  }
  if (last && last.unknownDids > 0) {
    // 文件名对照表（m:pathmap）里还没有它们：通常是建它们的那台设备还没装新版、或还没同步完一轮。
    return (
      <HeroBox
        attn
        icon="lock"
        title={`云端有 ${last.unknownDids} 篇加密笔记这台设备还认不出来`}
        sub="端到端加密时连文件名也是加密的，要靠云端的文件名对照表才认得出来。建这些笔记的设备装上新版并同步一次后，这里会自动补上；在那之前先跳过它们（不会写乱码到本机）。"
        action={retry}
      />
    );
  }
  const sub = status?.phase === "idle" && status.lastSyncedAt
    ? `最后一次 ${formatRelativeTime(status.lastSyncedAt)}${last ? ` · 这一轮上传 ${last.pushed} · 下载 ${last.pulled}${last.deleted + last.remoteDeleted > 0 ? ` · 删除 ${last.deleted + last.remoteDeleted}` : ""}` : ""}`
    : ui.phase === "attaching"
      ? "正在连接同步服务…"
      : "等待第一次同步";
  return <HeroBox icon="check" title={status?.phase === "idle" && status.lastSyncedAt ? "已同步" : "已开启同步"} sub={sub} action={retry} />;
}

function HeroBox({ attn = false, icon, title, sub, action }: { attn?: boolean; icon: Parameters<typeof Icon>[0]["name"]; title: string; sub: string; action?: ReactNode }): ReactNode {
  return (
    <div className={cn("sync-hero", attn && "sync-hero--attn")}>
      <div className="sync-hero__icon">
        <Icon name={icon} size={16} />
      </div>
      <div className="sync-hero__main">
        <div className="sync-hero__title">{title}</div>
        <div className="sync-hero__sub">{sub}</div>
      </div>
      {action ?? null}
    </div>
  );
}

function UnlockHero({ name }: { name: string }): ReactNode {
  const account = useStore(syncAccountStore);
  const [passphrase, setPassphraseValue] = useState("");
  const [remember, setRemember] = useState(account.storage.risk === null);
  const action = useAction();
  if (account.encryption === "none") {
    return (
      <div className="sync-hero sync-hero--attn">
        <div className="sync-hero__icon">
          <Icon name="lock" size={16} />
        </div>
        <div className="sync-hero__main">
          <div className="sync-hero__title">「{name}」是加密的，但这个账号还没有加密口令</div>
          <div className="sync-hero__sub">在下面「加密口令」里设一个，加密笔记本就能开始同步。</div>
        </div>
      </div>
    );
  }
  return (
    <div className="sync-hero sync-hero--attn">
      <div className="sync-hero__icon">
        <Icon name="lock" size={16} />
      </div>
      <form
        className="sync-hero__main"
        onSubmit={(event) => {
          event.preventDefault();
          void action.run(() => unlockWithPassphrase(passphrase, remember));
        }}
      >
        <div className="sync-hero__title">「{name}」是加密的，输入加密口令才能同步</div>
        <div className="sync-hero__sub">加密口令和登录密码不是同一个：它只在你的设备上用，服务器和管理员都无法帮你找回。</div>
        <div className="sync-row-actions">
          <input className="field" type="password" placeholder="加密口令" value={passphrase} onChange={(event) => setPassphraseValue(event.target.value)} autoComplete="off" />
          <button type="submit" className="btn btn--primary btn--sm" disabled={action.busy || passphrase === ""}>
            {action.busy ? "正在解锁…" : "解锁"}
          </button>
        </div>
        {account.canRemember ? (
          <label className="switch">
            <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
            记在这台设备上
          </label>
        ) : null}
        {action.error ? <p className="sync-error">{action.error}</p> : null}
        <p className="sync-hint">忘了加密口令？从一台已经解锁的设备用「添加设备」配对过来，口令会自动带上。</p>
      </form>
    </div>
  );
}

function MainView({ workspace, onDownloadRemote }: { workspace: WorkspaceRecord | null; onDownloadRemote(notebook: NotebookSummary): Promise<void> }): ReactNode {
  const ui = useStore(syncUiStore);
  const { notebooks, reload } = useRemoteNotebooks();
  const [newMode, setNewMode] = useState<"none" | "user-key">("none");
  const account = useStore(syncAccountStore);
  const conflicts = ui.last?.conflicts ?? [];

  const toggle = (record: WorkspaceRecord, enabled: boolean) => {
    if (enabled && newMode === "user-key" && account.encryption !== "unlocked" && normalizeSyncConfig(record.sync).notebookId === "") {
      notify("要新建端到端加密的笔记本，先在下面设好或解锁加密口令", { kind: "danger" });
      return;
    }
    try {
      setWorkspaceSyncEnabled(record, enabled, newMode);
      reload();
    } catch (error) {
      notify(errorText(error), { kind: "danger" });
    }
  };

  return (
    <div className="sync-pane">
      <Hero workspace={workspace} />
      {conflicts.length > 0 ? <ConflictPanel conflicts={conflicts} /> : null}

      <NotebookList workspace={workspace} remote={notebooks} newMode={newMode} onToggle={toggle} onDownloadRemote={onDownloadRemote} />
      <NewNotebookEncryption mode={newMode} onMode={setNewMode} />

      <HistorySection workspace={workspace} />

      <DevicesSection />
      <EncryptionSection />
      <AccountSection />

      <details className="sync-diag">
        <summary>诊断（排查问题时给开发者看）</summary>
        <pre>{ui.logs.length > 0 ? ui.logs.join("\n") : "（还没有日志）"}</pre>
      </details>
    </div>
  );
}

/** 「最近同步」平时显示几条（其余点「显示全部」）。 */
const HISTORY_PREVIEW = 6;

/**
 * 最近同步（`src/sync/history.ts`）：这台设备上、当前笔记本**真的动了东西**的那几轮，
 * 以及出错 / 离线。点一条「已同步」能看到具体是哪几篇。
 */
function HistorySection({ workspace }: { workspace: WorkspaceRecord | null }): ReactNode {
  const config = workspace ? normalizeSyncConfig(workspace.sync) : null;
  const notebookId = config?.enabled ? config.notebookId : "";
  const all = useStore(syncHistoryStore);
  const [showAll, setShowAll] = useState(false);
  useEffect(() => {
    loadSyncHistory(notebookId);
  }, [notebookId]);
  if (notebookId === "") return null;
  const entries = all[notebookId] ?? [];
  const visible = showAll ? entries : entries.slice(0, HISTORY_PREVIEW);

  return (
    <>
      <p className="sync-section-h">最近同步</p>
      <div className="sync-list">
        {entries.length === 0 ? (
          <div className="sync-row sync-row--empty">还没有记录。上传、下载、删除或出错时会记在这里（只记这台设备上的）。</div>
        ) : null}
        {visible.map((entry) => (
          <HistoryRow key={`${entry.kind}-${entry.firstAt ?? entry.at}`} entry={entry} />
        ))}
      </div>
      {entries.length > 0 ? (
        <div className="sync-row-actions">
          {entries.length > HISTORY_PREVIEW ? (
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => setShowAll((value) => !value)}>
              {showAll ? "收起" : `显示全部 ${entries.length} 条`}
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn--ghost btn--sm"
            onClick={async () => {
              const ok = await askConfirm({
                title: "清空同步记录？",
                message: "只清掉这台设备上「最近同步」的列表，不影响任何笔记，也不影响同步本身。",
                confirmLabel: "清空",
              });
              if (ok) clearSyncHistory(notebookId);
            }}
          >
            清空记录
          </button>
        </div>
      ) : null}
    </>
  );
}

/** 路径 → 给人看的样子：笔记本内的相对路径；Markdown 去掉 `.md`（侧栏里也是这么叫它的），其它种类保留扩展名。 */
function displayPath(path: string): string {
  return path.toLowerCase().endsWith(".md") ? path.slice(0, -3) : path;
}

/**
 * 一条记录：**一行**（用户原话：改成单行，用相对路径，「从云端下载」这种字不用显示）。
 *
 * `[方向图标] 操作系统/线程相关 · 保存了 2 次                 3 分钟前`
 *
 * - 方向只用图标说：上传 / 下载 / 删除；几种混在一起时用同步图标，并在后面淡淡地写各方向的数量；
 * - 文件写笔记本里的相对路径；几篇时写前两篇 +「等 N 篇」，点开看全部；
 * - 失败 / 离线同样一行：原因跟在后面，次数用「× N」。
 */
function HistoryRow({ entry }: { entry: SyncHistoryEntry }): ReactNode {
  const when = (
    <time className="sync-history__time" dateTime={new Date(entry.at).toISOString()} title={new Date(entry.at).toLocaleString()}>
      {formatRelativeTime(entry.at)}
    </time>
  );
  if (entry.kind !== "synced") {
    const label = entry.kind === "offline" ? "连不上同步服务器" : "同步出错";
    return (
      <div
        className={cn("sync-row", "sync-history__row", entry.kind === "error" && "is-error")}
        title={`${label}：${entry.message}${entry.repeat > 1 ? `（从 ${new Date(entry.firstAt).toLocaleString()} 起共 ${entry.repeat} 次）` : ""}`}
      >
        <span className="sync-row__icon">
          <Icon name="info" size={14} />
        </span>
        <span className="sync-history__line">
          <span className="sync-history__name">{label}</span>
          <span className="sync-history__meta">
            {/* 传输层的报错自带「连不上同步服务：」开头，和前面的标签说的是同一件事 —— 只留原因。 */}
            {entry.message.replace(/^连不上同步服务[：:]\s*/, "")}
            {entry.repeat > 1 ? ` · × ${entry.repeat}` : ""}
          </span>
        </span>
        {when}
      </div>
    );
  }

  const groups: { key: string; label: string; verb: string; icon: Parameters<typeof Icon>[0]["name"]; total: number; paths: string[] }[] = [
    { key: "pushed", label: "上传到云端", verb: "上传", icon: "upload" as const, total: entry.pushed, paths: entry.paths.pushed },
    { key: "pulled", label: "从云端下载", verb: "下载", icon: "download" as const, total: entry.pulled, paths: entry.paths.pulled },
    { key: "deleted", label: "跟着云端删掉", verb: "删除", icon: "trash" as const, total: entry.deleted, paths: entry.paths.deleted },
    { key: "remoteDeleted", label: "在云端删掉", verb: "删除", icon: "trash" as const, total: entry.remoteDeleted, paths: entry.paths.remoteDeleted },
  ].filter((group) => group.total > 0);
  const moved = groups.reduce((sum, group) => sum + group.total, 0);
  const paths = groups.flatMap((group) => group.paths);
  const only = groups.length === 1 ? groups[0]! : null;
  const single = only !== null && only.total === 1 && only.paths.length === 1 ? only.paths[0]! : null;

  const title =
    moved === 0
      ? "没有改动"
      : paths.length === 0
        ? `${moved} 篇`
        : `${paths.slice(0, 2).map(displayPath).join("、")}${moved > 2 ? ` 等 ${moved} 篇` : ""}`;
  const rounds = entry.rounds ?? 1;
  const meta = [
    // 方向混在一起时图标说不清，补一句各方向的数量；只有一个方向时图标就够了。
    groups.length > 1 ? groups.map((group) => `${group.verb} ${group.total}`).join(" · ") : null,
    rounds > 1 ? (only?.key === "pushed" ? `保存了 ${rounds} 次` : only?.key === "pulled" ? `收到 ${rounds} 次更新` : `${rounds} 次`) : null,
  ].filter((part): part is string => part !== null);

  const summary = (
    <>
      <span className="sync-row__icon" title={only?.label}>
        <Icon name={only !== null ? only.icon : moved === 0 ? "info" : "rotate"} size={14} />
      </span>
      <span className="sync-history__line" title={single ?? undefined}>
        <span className="sync-history__name">{title}</span>
        {meta.length > 0 ? <span className="sync-history__meta">{meta.join(" · ")}</span> : null}
        {entry.conflicts > 0 ? <span className="sync-history__meta sync-history__attn">{entry.conflicts} 篇待处理</span> : null}
      </span>
      {when}
    </>
  );

  // 只动了一篇、没有冲突：一行就说完了，不用再点开。
  if (single !== null && entry.conflicts === 0) return <div className="sync-row sync-history__row">{summary}</div>;

  const listed = [...groups, { key: "conflicts", label: "待处理冲突", verb: "冲突", icon: "info" as const, total: entry.conflicts, paths: entry.paths.conflicts }].filter(
    (group) => group.total > 0,
  );
  return (
    <details className="sync-row sync-history__row sync-history__details">
      <summary>{summary}</summary>
      <div className="sync-history__paths">
        {listed.map((group) => (
          <div key={group.key}>
            <div className="sync-history__group">
              {group.label} {group.total}
            </div>
            <ul>
              {group.paths.map((path) => (
                <li key={path} title={path}>
                  {displayPath(path)}
                </li>
              ))}
              {group.total > group.paths.length ? <li className="sync-history__more">还有 {group.total - group.paths.length} 篇</li> : null}
            </ul>
          </div>
        ))}
      </div>
    </details>
  );
}

function DevicesSection(): ReactNode {
  const [devices, setDevices] = useState<Awaited<ReturnType<typeof listDevices>> | null>(null);
  const [adding, setAdding] = useState(false);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    listDevices()
      .then((list) => !cancelled && setDevices(list))
      .catch(() => !cancelled && setDevices([]));
    return () => void (cancelled = true);
  }, [tick]);
  const active = (devices ?? []).filter((device) => device.active);
  const osLabel: Record<string, string> = { macos: "macOS", windows: "Windows", linux: "Linux", android: "Android", ios: "iOS", other: "其它系统" };
  const platformLabel: Record<string, string> = { desktop: "桌面端", android: "手机", web: "网页端" };
  return (
    <>
      <p className="sync-section-h">设备</p>
      <div className="sync-list">
        {devices === null ? <div className="sync-row sync-row--empty">正在读取…</div> : null}
        {devices !== null && active.length === 0 ? <div className="sync-row sync-row--empty">读不到设备列表（离线？）</div> : null}
        {active.map((device) => (
          <div key={device.deviceId} className="sync-row">
            <div className="sync-row__main">
              {device.name ?? "未命名设备"} {device.current ? <span className="sync-tag">这台</span> : null}
              <small>
                {[device.os ? osLabel[device.os] : null, device.platform ? platformLabel[device.platform] : null, device.clientVersion].filter(Boolean).join(" · ")}
                {device.current ? " · 在线" : device.lastSeenAt ? ` · ${formatRelativeTime(device.lastSeenAt)}` : ""}
              </small>
            </div>
            {device.current ? null : (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={async () => {
                  const ok = await askConfirm({
                    title: `移除「${device.name ?? "未命名设备"}」？`,
                    message: "这台设备会被登出，下次联网时提示「需要重新登录」。它本机上的笔记文件不受影响。",
                    confirmLabel: "移除",
                    danger: true,
                  });
                  if (!ok) return;
                  try {
                    await removeDevice(device.deviceId);
                    setTick((value) => value + 1);
                  } catch (error) {
                    notify(errorText(error), { kind: "danger" });
                  }
                }}
              >
                移除
              </button>
            )}
          </div>
        ))}
      </div>
      <div className="sync-row-actions">
        <button type="button" className="btn btn--sm" onClick={() => setAdding(true)}>
          <Icon name="plus" size={13} />
          添加设备
        </button>
      </div>
      {adding ? (
        <AddDeviceDialog
          onClose={() => {
            setAdding(false);
            setTick((value) => value + 1);
          }}
        />
      ) : null}
    </>
  );
}

function AddDeviceDialog({ onClose }: { onClose(): void }): ReactNode {
  const account = useStore(syncAccountStore);
  const [session, setSession] = useState<AddDeviceSession | null>(null);
  const [claim, setClaim] = useState<{ device: { name: string; platform: string; os: string | null }; check: string } | null>(null);
  const [phase, setPhase] = useState<"starting" | "waiting" | "claimed" | "done" | "expired" | "error">("starting");
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [generation, setGeneration] = useState(0);

  useEffect(() => {
    const abort = new AbortController();
    let created: AddDeviceSession | null = null;
    setPhase("starting");
    setClaim(null);
    void (async () => {
      try {
        created = await startAddDevice();
        if (abort.signal.aborted) return;
        setSession(created);
        setPhase("waiting");
        const claimed = await created.waitForClaim(abort.signal);
        if (abort.signal.aborted) return;
        if (!claimed) return setPhase("expired");
        setClaim(claimed);
        setPhase("claimed");
      } catch (failure) {
        if (!abort.signal.aborted) {
          setError(errorText(failure));
          setPhase("error");
        }
      }
    })();
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      abort.abort();
      clearInterval(timer);
      // 关掉窗口时还没确认的配对一律作废：不留一个等着被人认领的码。
      if (created) void created.reject();
    };
  }, [generation]);

  const left = session ? Math.max(0, session.expiresAt - now) : 0;
  const leftText = `${Math.floor(left / 60000)} 分 ${String(Math.floor((left % 60000) / 1000)).padStart(2, "0")} 秒后失效 · 只能用一次`;

  return (
    <Modal
      title="添加设备"
      onClose={onClose}
      footer={
        <>
          {phase === "waiting" || phase === "expired" ? (
            <button type="button" className="btn btn--ghost" onClick={() => setGeneration((value) => value + 1)}>
              换一个码
            </button>
          ) : null}
          <div className="spacer" />
          {phase === "claimed" ? (
            <>
              <button
                type="button"
                className="btn"
                onClick={async () => {
                  await session?.reject();
                  onClose();
                }}
              >
                拒绝
              </button>
              <button
                type="button"
                className="btn btn--primary"
                onClick={async () => {
                  try {
                    await session?.approve();
                    setPhase("done");
                  } catch (failure) {
                    setError(errorText(failure));
                    setPhase("error");
                  }
                }}
              >
                确认加入
              </button>
            </>
          ) : (
            <button type="button" className={cn("btn", phase === "done" && "btn--primary")} onClick={onClose}>
              {phase === "done" ? "完成" : "取消"}
            </button>
          )}
        </>
      }
    >
      <div className="sync-pane">
        {phase === "claimed" && claim ? (
          <>
            <p className="dialog__message">
              <strong>「{claim.device.name}」</strong>想要加入你的账号。确认新设备上显示的校验码与下面一致，再点「确认加入」。
            </p>
            <p className="sync-check">{claim.check}</p>
            <div className="sync-callout">
              新设备会登录你的账号（{account.account?.email}）
              {account.encryption === "unlocked" ? "，并拿到端到端加密的口令。" : "。这台设备还没解锁加密口令，新设备加入后需要自己输入口令。"}不认识的请求请点「拒绝」。
            </div>
          </>
        ) : phase === "done" ? (
          <p className="dialog__message">新设备已经加入。它会出现在设备列表里。</p>
        ) : phase === "error" ? (
          <p className="sync-error">{error}</p>
        ) : phase === "expired" ? (
          <p className="dialog__message">配对码已经过期了，点「换一个码」再来一次。</p>
        ) : (
          <>
            <p className="dialog__message">在新设备上打开 Opennote →「设置 → 同步 → 从另一台设备加入」，输入下面的码。</p>
            <div className="sync-code6" aria-label="配对码">
              {(session?.code ?? "      ").split("").map((digit, index) => (
                <span key={index}>{digit.trim()}</span>
              ))}
            </div>
            <p className="dialog__note" style={{ textAlign: "center" }}>
              {session ? leftText : "正在生成配对码…"}
            </p>
            <div className="sync-row-actions muted" style={{ justifyContent: "center" }}>
              <span className="sync-spin" /> 等待新设备…
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/** 设加密口令（账号还没有时）。 */
function PassphraseForm({ compact = false }: { compact?: boolean }): ReactNode {
  const account = useStore(syncAccountStore);
  const [first, setFirst] = useState("");
  const [second, setSecond] = useState("");
  const [remember, setRemember] = useState(account.storage.risk === null);
  const action = useAction();
  const unlock = account.encryption === "locked";
  const submit = () =>
    void action.run(async () => {
      if (unlock) return unlockWithPassphrase(first, remember);
      const problem = passphraseProblem(first);
      if (problem) throw new Error(problem);
      if (first !== second) throw new Error("两次输入的加密口令不一样");
      await setPassphrase(first, remember);
    });
  return (
    <form
      className="sync-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="sync-row-actions">
        <input className="field" type="password" placeholder={unlock ? "加密口令" : "设一个加密口令"} value={first} onChange={(event) => setFirst(event.target.value)} autoComplete="new-password" />
        {unlock ? null : <input className="field" type="password" placeholder="再输入一次" value={second} onChange={(event) => setSecond(event.target.value)} autoComplete="new-password" />}
        <button type="submit" className={cn("btn btn--sm", !compact && "btn--primary")} disabled={action.busy || first === ""}>
          {action.busy ? "正在处理…" : unlock ? "解锁" : "设好了"}
        </button>
      </div>
      {account.canRemember ? (
        <label className="switch">
          <input type="checkbox" checked={remember} onChange={(event) => setRemember(event.target.checked)} />
          记在这台设备上（下次打开不用再输）
        </label>
      ) : null}
      {action.error ? <p className="sync-error">{action.error}</p> : null}
      {unlock ? null : <p className="sync-hint">至少 8 位。它只在你的设备上用来加密，服务器和管理员都无法帮你找回 —— 请记在安全的地方。</p>}
    </form>
  );
}

function EncryptionSection(): ReactNode {
  const account = useStore(syncAccountStore);
  const [changing, setChanging] = useState(false);
  const [next, setNext] = useState("");
  const action = useAction();
  return (
    <>
      <p className="sync-section-h">加密口令</p>
      <div className="setting">
        <div className="setting__label">
          端到端加密<small>账号级，所有加密笔记本共用</small>
        </div>
        <div className="setting__control">
          {account.encryption === "unknown" ? <div className="setting__meta">正在读取…</div> : null}
          {account.encryption === "none" ? (
            <>
              <div className="setting__meta">这个账号还没有加密口令。只在你想新建端到端加密的笔记本时才需要。</div>
              <PassphraseForm />
            </>
          ) : null}
          {account.encryption === "locked" ? (
            <>
              <div className="setting__meta">已设置，但这台设备还没解锁。</div>
              <PassphraseForm />
            </>
          ) : null}
          {account.encryption === "unlocked" ? (
            <>
              <div className="setting__meta">已解锁{account.rememberedKey ? " · 记在这台设备上" : " · 只在本次运行有效，退出后要重新输入"}。</div>
              {account.storage.risk && account.rememberedKey ? <div className="sync-hint">{account.storage.risk}</div> : null}
              <div className="sync-row-actions">
                <button type="button" className="btn btn--sm" onClick={() => setChanging((value) => !value)}>
                  修改加密口令…
                </button>
                {account.rememberedKey ? (
                  <button type="button" className="btn btn--ghost btn--sm" onClick={() => void forgetRememberedKey()}>
                    不再记在这台设备上
                  </button>
                ) : null}
              </div>
              {changing ? (
                <form
                  className="sync-row-actions"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void action.run(async () => {
                      await changePassphrase(next);
                      setChanging(false);
                      setNext("");
                      notify("加密口令已修改。其它设备下次解锁时用新口令。");
                    });
                  }}
                >
                  <input className="field" type="password" placeholder="新的加密口令（至少 8 位）" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" />
                  <button type="submit" className="btn btn--sm btn--primary" disabled={action.busy || next === ""}>
                    保存
                  </button>
                </form>
              ) : null}
              {action.error ? <p className="sync-error">{action.error}</p> : null}
            </>
          ) : null}
        </div>
      </div>
    </>
  );
}

function AccountSection(): ReactNode {
  const account = useStore(syncAccountStore);
  const me = account.me;
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const action = useAction();
  const server = account.account?.server ?? "";
  useEffect(() => {
    if (server) probeServer(server).then(setHealth).catch(() => setHealth(null));
  }, [server]);
  const usage = useMemo(() => (me ? `已用 ${formatBytes(me.quota.bytesUsed)} / ${formatBytes(me.quota.bytesLimit)}` : null), [me]);

  return (
    <>
      <p className="sync-section-h">账号</p>
      <div className="setting">
        <div className="setting__label">已登录</div>
        <div className="setting__control">
          <div className="setting__value">{account.account?.email ?? "（没有邮箱）"}</div>
          <div className="setting__path">
            {server.replace(/^https?:\/\//, "")}
            {usage ? ` · ${usage}` : ""}
          </div>
          <div className="sync-row-actions setting__meta">
            登录方式：
            {me?.loginMethods.github ? (
              <span className="sync-row-actions">
                <GithubMark /> @{me.loginMethods.github}
              </span>
            ) : null}
            {me?.loginMethods.github && me.loginMethods.password ? "·" : null}
            {me?.loginMethods.password ? "密码" : null}
            {me?.loginMethods.github ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void action.run(async () => {
                  await unlinkGithub();
                  notify("已解绑 GitHub");
                })}
              >
                解绑 GitHub
              </button>
            ) : health?.auth.github ? (
              <button
                type="button"
                className="btn btn--ghost btn--sm"
                onClick={() => void action.run(async () => {
                  await openInBrowser(await linkGithub());
                  notify("在浏览器里完成绑定后，回到这里刷新即可");
                })}
              >
                绑定 GitHub
              </button>
            ) : null}
          </div>
          <div className="sync-row-actions">
            {me?.loginMethods.password ? (
              <button type="button" className="btn btn--sm" onClick={() => setChanging((value) => !value)}>
                修改密码…
              </button>
            ) : null}
            <button
              type="button"
              className="btn btn--sm btn--danger"
              onClick={async () => {
                const ok = await askConfirm({
                  title: "退出同步账号？",
                  message: "这台设备停止同步，本机的笔记文件都还在。下次登录后会按名字重新配对、接着同步。",
                  confirmLabel: "退出登录",
                });
                if (ok) await signOut();
              }}
            >
              退出登录
            </button>
          </div>
          {changing ? (
            <form
              className="sync-form"
              onSubmit={(event) => {
                event.preventDefault();
                void action.run(async () => {
                  await changePassword(current, next);
                  setChanging(false);
                  setCurrent("");
                  setNext("");
                  notify("密码已修改，其它设备需要重新登录");
                });
              }}
            >
              <input className="field" type="password" placeholder="当前密码" value={current} onChange={(event) => setCurrent(event.target.value)} autoComplete="current-password" />
              <input className="field" type="password" placeholder="新密码（至少 10 位）" value={next} onChange={(event) => setNext(event.target.value)} autoComplete="new-password" />
              <div className="sync-row-actions">
                <button type="submit" className="btn btn--sm btn--primary" disabled={action.busy}>
                  保存
                </button>
                <span className="sync-hint">改了之后，其它设备都要用新密码重新登录。</span>
              </div>
            </form>
          ) : null}
          {action.error ? <p className="sync-error">{action.error}</p> : null}
          <div className="sync-hint">{account.storage.where}</div>
        </div>
      </div>
    </>
  );
}
