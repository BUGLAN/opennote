/**
 * 这台设备的同步账号（`docs/执行-同步重写-2026-11-02.md` 阶段 ⑤）。
 *
 * 一台设备只登录一个服务器上的一个账号；所有笔记本共用它。这里负责：
 *
 * | 事 | 入口 |
 * | --- | --- |
 * | 登录 | 邮箱密码 `signInWithPassword` · GitHub `beginGithubSignIn` → `completeGithubSignIn` · 配对 `joinWithCode` |
 * | 退出 | `signOut`（吊销服务端会话、清掉本机凭据与 encRoot） |
 * | 加密口令 | `setPassphrase` · `unlockWithPassphrase` · `changePassphrase` · `forgetRememberedKey` |
 * | 添加设备 | `startAddDevice`（A 端显示 6 位码、确认对方） |
 * | 账号页 | `listDevices` · `removeDevice` · `changePassword` · `linkGithub` · `unlinkGithub` |
 *
 * 会话令牌只在 `keys.ts` 的保管里与本模块的内存里；UI 只能看到 `syncAccountStore` 里的摘要。
 * 解开的 encRoot 默认只在内存（退出应用就要重新输口令），用户勾了「记在这台设备上」才进保管。
 */

import type { DeviceDescriptor, DeviceInfo, EncryptionState, HealthResponse, Me, NotebookSummary } from "../../shared/contract";
import { createStore } from "../lib/store";
import { appVersion } from "../lib/appVersion";
import { desktopBridge } from "../desktop/bridge";
import { isCapacitorNative } from "../fs/capacitorBackend";
import { fromBase64Url, toBase64Url } from "./accountKey";
import { encodeCredentials, normalizeServer, parseCredentials, type SyncCredentials } from "./credentials";
import { getDeviceId } from "./device";
import { describeCredentialStorage, resolveCredentialStore, type CredentialStore } from "./keys";
import { openSyncApi, SyncApiError, type SyncApi } from "./syncApi";
import {
  createPairingKeys,
  createPkce,
  createVault,
  openFromPeer,
  openVault,
  pairingSecrets,
  passphraseProblem,
  rewrapVault,
  sealForPeer,
} from "./vault";

/* ============================================================================
   状态（React 经 `useStore(syncAccountStore)` 订阅）
   ============================================================================ */

export type EncryptionPhase = "unknown" | "none" | "locked" | "unlocked";

export interface SyncAccountState {
  /** 本机凭据读完了没有（读完之前界面不该说「未登录」）。 */
  loaded: boolean;
  /** 已登录的摘要；没登录是 null。**不含令牌**。 */
  account: { server: string; accountId: string; email: string | null; deviceName: string } | null;
  /** 最近一次从服务端拿到的「我」（配额、登录方式、是不是管理员）。 */
  me: Me | null;
  /** 服务端说这台设备的登录已经失效（401）：要重新登录。 */
  needsSignIn: boolean;
  /** 账号停用（403 disabled）。 */
  disabled: boolean;
  encryption: EncryptionPhase;
  /** encRoot 记在这台设备上了（下次打开不用再输口令）。 */
  rememberedKey: boolean;
  storage: { where: string; risk: string | null };
  /** 能不能把 encRoot 安全地记在本机（桌面有 safeStorage / 网页有 localStorage 但有风险）。 */
  canRemember: boolean;
}

const store: CredentialStore = resolveCredentialStore();

export const syncAccountStore = createStore<SyncAccountState>({
  loaded: false,
  account: null,
  me: null,
  needsSignIn: false,
  disabled: false,
  encryption: "unknown",
  rememberedKey: false,
  storage: describeCredentialStorage(store),
  canRemember: store.host !== "memory",
});

/** 带令牌的那一份（只在本模块与 `appSync.ts` 里用）。 */
let credentials: SyncCredentials | null = null;
/** 解开的加密根（只在内存；勾了「记住」时另存一份进保管）。 */
let encRoot: Uint8Array | null = null;
/** 登录状态变了（登录 / 退出 / 解锁）时通知 appSync 重新接上。 */
const listeners = new Set<() => void>();

export function onAccountChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emitChange(): void {
  for (const listener of listeners) listener();
}

function publish(patch: Partial<SyncAccountState> = {}): void {
  syncAccountStore.set((prev) => ({
    ...prev,
    account: credentials ? { server: credentials.server, accountId: credentials.accountId, email: credentials.email, deviceName: credentials.deviceName } : null,
    rememberedKey: credentials?.encRoot !== undefined,
    ...patch,
  }));
}

export function currentCredentials(): SyncCredentials | null {
  return credentials;
}

export function currentEncRoot(): Uint8Array | null {
  return encRoot;
}

/** 同步那边收到 401 / 403 disabled 时调：界面据此提示「需要重新登录」/「账号已被停用」。 */
export function reportSessionProblem(kind: "signed-out" | "disabled"): void {
  publish(kind === "signed-out" ? { needsSignIn: true } : { disabled: true });
}

/* ============================================================================
   启动
   ============================================================================ */

let loading: Promise<void> | null = null;

/** 读本机凭据（只读一次；之后的调用等同一个 Promise）。 */
export function loadAccount(): Promise<void> {
  loading ??= (async () => {
    const text = await store.load().catch(() => null);
    try {
      credentials = text ? parseCredentials(text) : null;
    } catch {
      credentials = null;
    }
    encRoot = credentials?.encRoot ? fromBase64Url(credentials.encRoot) : null;
    publish({ loaded: true, encryption: encRoot ? "unlocked" : "unknown" });
    if (credentials) void refreshAccount();
  })();
  return loading;
}

async function api(): Promise<SyncApi> {
  if (!credentials) throw new Error("还没有登录同步账号");
  return openSyncApi({ server: credentials.server, token: credentials.token });
}

/** 401 / 403 统一在这里落到状态上，再把错误抛给调用方。 */
async function withSession<T>(task: (client: SyncApi) => Promise<T>): Promise<T> {
  try {
    const result = await task(await api());
    if (syncAccountStore.get().needsSignIn) publish({ needsSignIn: false });
    return result;
  } catch (error) {
    if (error instanceof SyncApiError && error.status === 401) publish({ needsSignIn: true });
    if (error instanceof SyncApiError && error.code === "disabled") publish({ disabled: true });
    throw error;
  }
}

/** 刷新「我」与加密状态（打开设置页、登录后各调一次；失败不抛）。 */
export async function refreshAccount(): Promise<void> {
  if (!credentials) return;
  try {
    const [me, encryption] = await withSession((client) => Promise.all([client.me(), client.encryption()]));
    publish({ me, needsSignIn: false, disabled: false, encryption: encryptionPhase(encryption) });
  } catch {
    /* 离线 / 失效：状态已经由 withSession 标好 */
  }
}

function encryptionPhase(state: EncryptionState): EncryptionPhase {
  if (!state.configured) return "none";
  return encRoot ? "unlocked" : "locked";
}

/* ============================================================================
   设备描述
   ============================================================================ */

function detectOs(): DeviceDescriptor["os"] {
  const agent = typeof navigator === "undefined" ? "" : navigator.userAgent;
  if (/Android/i.test(agent)) return "android";
  if (/iPhone|iPad|iPod/i.test(agent)) return "ios";
  if (/Mac OS X|Macintosh/i.test(agent)) return "macos";
  if (/Windows/i.test(agent)) return "windows";
  if (/Linux/i.test(agent)) return "linux";
  return "other";
}

export function devicePlatform(): DeviceDescriptor["platform"] {
  if (desktopBridge()) return "desktop";
  if (isCapacitorNative()) return "android";
  return "web";
}

/** 设备名的默认值（登录表单预填；用户可改）。 */
export function defaultDeviceName(): string {
  const os = detectOs();
  const label = { macos: "Mac", windows: "Windows 电脑", linux: "Linux 电脑", android: "Android 手机", ios: "iPhone", other: "设备" }[os ?? "other"];
  return devicePlatform() === "web" ? `${label} 上的浏览器` : label;
}

export function deviceDescriptor(name: string): DeviceDescriptor {
  const version = appVersion();
  return {
    deviceId: getDeviceId(),
    name: name.trim().slice(0, 120) || defaultDeviceName(),
    platform: devicePlatform(),
    os: detectOs(),
    ...(version ? { clientVersion: version.slice(0, 40) } : {}),
  };
}

/* ============================================================================
   登录 / 退出
   ============================================================================ */

/** 探测服务器：能连上、是 Opennote、支持哪些登录方式。 */
export async function probeServer(server: string): Promise<HealthResponse> {
  const client = await openSyncApi({ server: normalizeServer(server) });
  const health = await client.health();
  if (!health || health.ok !== true || typeof health.protocolVersion !== "number") {
    throw new SyncApiError(0, "这个地址上不是 Opennote 同步服务", "not-opennote");
  }
  return health;
}

async function saveCredentials(next: SyncCredentials): Promise<void> {
  credentials = next;
  await store.save(encodeCredentials(next));
}

/** 换来会话之后的共同收尾：存凭据、清掉上一个账号的 encRoot、刷新状态、通知同步重新接上。 */
async function adoptSession(input: { server: string; token: string; me: Me; deviceName: string; encRoot?: Uint8Array | null; remember?: boolean }): Promise<void> {
  const sameAccount = credentials?.accountId === input.me.accountId;
  if (!sameAccount) encRoot = null;
  if (input.encRoot) encRoot = input.encRoot;
  const remember = input.remember ?? (sameAccount && credentials?.encRoot !== undefined);
  await saveCredentials({
    v: 2,
    server: input.server,
    token: input.token,
    accountId: input.me.accountId,
    email: input.me.email,
    deviceName: input.deviceName,
    ...(remember && encRoot ? { encRoot: toBase64Url(encRoot) } : {}),
  });
  publish({ me: input.me, needsSignIn: false, disabled: false, encryption: encRoot ? "unlocked" : "unknown" });
  void refreshAccount();
  emitChange();
}

export async function signInWithPassword(input: { server: string; email: string; password: string; deviceName: string }): Promise<void> {
  const server = normalizeServer(input.server);
  const client = await openSyncApi({ server });
  const device = deviceDescriptor(input.deviceName);
  const result = await client.login({ email: input.email.trim(), password: input.password, device });
  await adoptSession({ server, token: result.token, me: result.me, deviceName: device.name });
}

/** 退出：吊销服务端会话（失败也照退）、清掉本机凭据与 encRoot。本机笔记文件不动。 */
export async function signOut(): Promise<void> {
  if (credentials) {
    await api()
      .then((client) => client.logout())
      .catch(() => undefined);
  }
  credentials = null;
  encRoot = null;
  await store.clear();
  publish({ me: null, needsSignIn: false, disabled: false, encryption: "unknown" });
  emitChange();
}

/**
 * 登录表单的预填（`/join` 页的「在 Opennote 中打开」→ `opennote://sync/sign-in?server=…&email=…`）。
 * 只是建议值，不会自动提交。
 */
export const signInPrefillStore = createStore<{ server: string | null; email: string | null }>({ server: null, email: null });

/* ------------------------------------------------------------ GitHub */

const GITHUB_PENDING_KEY = "opennote.sync.githubPending";

interface GithubPending {
  server: string;
  verifier: string;
  state: string;
  deviceName: string;
  startedAt: number;
}

function savePending(pending: GithubPending | null): void {
  try {
    if (pending) sessionStorage.setItem(GITHUB_PENDING_KEY, JSON.stringify(pending));
    else sessionStorage.removeItem(GITHUB_PENDING_KEY);
  } catch {
    /* 没有 sessionStorage：桌面端进程一直在，内存那份够用 */
  }
}

let githubPending: GithubPending | null = null;

function loadPending(): GithubPending | null {
  if (githubPending) return githubPending;
  try {
    const text = sessionStorage.getItem(GITHUB_PENDING_KEY);
    return text ? (JSON.parse(text) as GithubPending) : null;
  } catch {
    return null;
  }
}

/**
 * 开始 GitHub 登录：生成 PKCE，返回要在浏览器里打开的地址。
 * 桌面 / 手机：系统浏览器打开，授权完经 `opennote://sync/callback` 回来；
 * 网页端：本页跳过去，回来时地址栏带 `?sync_code=`。
 */
export function beginGithubSignIn(input: { server: string; deviceName: string }): { url: string; returnTo: "app" | "web" } {
  const server = normalizeServer(input.server);
  const { verifier, challenge } = createPkce();
  const state = toBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  githubPending = { server, verifier, state, deviceName: input.deviceName, startedAt: Date.now() };
  savePending(githubPending);
  const returnTo = devicePlatform() === "web" ? "web" : "app";
  const query = new URLSearchParams({ mode: "app", challenge, state, return: returnTo });
  return { url: `${server}/auth/github?${query.toString()}`, returnTo };
}

export function cancelGithubSignIn(): void {
  githubPending = null;
  savePending(null);
}

export function githubSignInPending(): boolean {
  return loadPending() !== null;
}

/** 回调里带的东西（深链或网页地址栏）。 */
export interface GithubCallback {
  code?: string | null;
  state?: string | null;
  error?: string | null;
  message?: string | null;
  github?: string | null;
}

/** GitHub 授权回来：核对 state，用 verifier 换会话。失败抛一句人话。 */
export async function completeGithubSignIn(callback: GithubCallback): Promise<void> {
  const pending = loadPending();
  if (!pending || !callback.state || callback.state !== pending.state) {
    throw new Error("这次 GitHub 登录已经过期或不是从这里发起的，请重新点「使用 GitHub 登录」");
  }
  cancelGithubSignIn();
  if (callback.error) throw new Error(callback.message || "GitHub 登录没有完成");
  if (!callback.code) throw new Error("GitHub 登录没有完成");
  const client = await openSyncApi({ server: pending.server });
  const device = deviceDescriptor(pending.deviceName);
  const result = await client.githubExchange({ code: callback.code, verifier: pending.verifier, device });
  await adoptSession({ server: pending.server, token: result.token, me: result.me, deviceName: device.name });
}

/**
 * GitHub 登录走到哪了（设置页的「等待 GitHub 授权」那一步读它）。
 * 回调可能来自深链（桌面 / 手机）或地址栏（网页端），都经 `finishGithubSignIn` 落到这里。
 */
export const githubFlowStore = createStore<{ phase: "idle" | "waiting" | "finishing" | "error"; url: string | null; error: string | null }>({
  phase: "idle",
  url: null,
  error: null,
});

/** 在浏览器里打开授权页，并把设置页切到「等待授权」。 */
export async function startGithubSignIn(input: { server: string; deviceName: string }): Promise<void> {
  const { url, returnTo } = beginGithubSignIn(input);
  githubFlowStore.set({ phase: "waiting", url, error: null });
  if (returnTo === "web") {
    window.location.assign(url);
    return;
  }
  await openInBrowser(url);
}

export function abandonGithubSignIn(): void {
  cancelGithubSignIn();
  githubFlowStore.set({ phase: "idle", url: null, error: null });
}

/** 回调到了：换会话。成功后状态回到 idle（设置页看到已登录），失败留在 error 显示原因。 */
export async function finishGithubSignIn(callback: GithubCallback): Promise<boolean> {
  githubFlowStore.set({ ...githubFlowStore.get(), phase: "finishing", error: null });
  try {
    await completeGithubSignIn(callback);
    githubFlowStore.set({ phase: "idle", url: null, error: null });
    return true;
  } catch (error) {
    githubFlowStore.set({ phase: "error", url: githubFlowStore.get().url, error: error instanceof Error ? error.message : String(error) });
    return false;
  }
}

export async function linkGithub(): Promise<string> {
  return (await withSession((client) => client.githubLink())).url;
}

export async function unlinkGithub(): Promise<void> {
  const me = await withSession((client) => client.githubUnlink());
  publish({ me });
}

/** 在系统浏览器（桌面）或新标签页（网页）里打开一个地址。 */
export async function openInBrowser(url: string): Promise<void> {
  const bridge = desktopBridge();
  if (bridge) return bridge.shell.openExternal(url);
  window.open(url, "_blank", "noopener,noreferrer");
}

/* ============================================================================
   加密口令
   ============================================================================ */

async function rememberChoice(remember: boolean): Promise<void> {
  if (!credentials) return;
  const next: SyncCredentials = { ...credentials };
  if (remember && encRoot) next.encRoot = toBase64Url(encRoot);
  else delete next.encRoot;
  await saveCredentials(next);
}

/** 第一次设加密口令（账号还没有）。encRoot 在本机生成，服务端只拿到包好的那份。 */
export async function setPassphrase(passphrase: string, remember: boolean): Promise<void> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);
  if (!credentials) throw new Error("还没有登录同步账号");
  const vault = await createVault(passphrase, credentials.accountId);
  await withSession((client) => client.putEncryption({ wrappedEncRoot: vault.wrappedEncRoot, kdf: vault.kdf, expected: null }));
  encRoot = vault.encRoot;
  await rememberChoice(remember);
  publish({ encryption: "unlocked" });
  emitChange();
}

/** 用口令解开（新设备 / 没记住口令的设备）。 */
export async function unlockWithPassphrase(passphrase: string, remember: boolean): Promise<void> {
  if (!credentials) throw new Error("还没有登录同步账号");
  const state = await withSession((client) => client.encryption());
  if (!state.configured) {
    publish({ encryption: "none" });
    throw new Error("这个账号还没有设过加密口令");
  }
  encRoot = await openVault(passphrase, state.wrappedEncRoot, state.kdf, credentials.accountId);
  await rememberChoice(remember);
  publish({ encryption: "unlocked" });
  emitChange();
}

/** 改口令：用新口令重新包同一个 encRoot（已加密的笔记本不用动）。必须先解锁。 */
export async function changePassphrase(next: string): Promise<void> {
  const problem = passphraseProblem(next);
  if (problem) throw new Error(problem);
  if (!credentials || !encRoot) throw new Error("先解锁加密口令，才能修改它");
  const current = await withSession((client) => client.encryption());
  const rewrapped = await rewrapVault(next, encRoot, credentials.accountId);
  await withSession((client) =>
    client.putEncryption({ wrappedEncRoot: rewrapped.wrappedEncRoot, kdf: rewrapped.kdf, expected: current.configured ? current.wrappedEncRoot : null }),
  );
}

/** 不再把 encRoot 记在本机（本次运行仍保持解锁）。 */
export async function forgetRememberedKey(): Promise<void> {
  await rememberChoice(false);
  publish();
}

/* ============================================================================
   配对
   ============================================================================ */

export interface AddDeviceSession {
  code: string;
  expiresAt: number;
  /** 等新设备输入码；有人认领了就返回它的设备与双方都看得到的校验码。 */
  waitForClaim(signal: AbortSignal): Promise<{ device: { name: string; platform: string; os: string | null }; check: string } | null>;
  approve(): Promise<void>;
  reject(): Promise<void>;
}

const POLL_MS = 1500;

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    });
  });
}

/** A 端：「添加设备」。 */
export async function startAddDevice(): Promise<AddDeviceSession> {
  if (!credentials) throw new Error("还没有登录同步账号");
  const accountId = credentials.accountId;
  const keys = await createPairingKeys();
  const created = await withSession((client) => client.pairingCreate(keys.publicKey));
  let secrets: { key: Uint8Array; check: string } | null = null;
  return {
    code: created.code,
    expiresAt: created.expiresAt,
    async waitForClaim(signal) {
      while (!signal.aborted && Date.now() < created.expiresAt) {
        const state = await withSession((client) => client.pairingGet(created.id));
        if (state.status === "claimed" && state.device && state.publicKey) {
          secrets = await pairingSecrets({ own: keys, peerPublicKey: state.publicKey, initiatorPublicKey: keys.publicKey, claimantPublicKey: state.publicKey });
          return { device: state.device, check: secrets.check };
        }
        await sleep(POLL_MS, signal);
      }
      return null;
    },
    async approve() {
      if (!secrets) throw new Error("还没有设备输入这个码");
      // 没解锁（或账号没设加密口令）时不带口令过去：新设备之后自己输口令解锁。
      const sealed = encRoot ? sealForPeer(secrets.key, encRoot, accountId) : null;
      await withSession((client) => client.pairingApprove(created.id, sealed));
    },
    async reject() {
      await withSession((client) => client.pairingReject(created.id)).catch(() => undefined);
    },
  };
}

export interface JoinSession {
  email: string | null;
  /** 两台设备上应该一致的校验码。 */
  check: string;
  /** 等另一台设备点确认。 */
  wait(signal: AbortSignal): Promise<"done" | "rejected" | "expired">;
}

/** B 端：「从另一台设备加入」。 */
export async function joinWithCode(input: { server: string; code: string; deviceName: string; remember: boolean }): Promise<JoinSession> {
  const server = normalizeServer(input.server);
  const client = await openSyncApi({ server });
  const keys = await createPairingKeys();
  const device = deviceDescriptor(input.deviceName);
  const claimed = await client.pairingClaim({ code: input.code.trim(), publicKey: keys.publicKey, device });
  const secrets = await pairingSecrets({ own: keys, peerPublicKey: claimed.publicKey, initiatorPublicKey: claimed.publicKey, claimantPublicKey: keys.publicKey });
  return {
    email: claimed.email,
    check: secrets.check,
    async wait(signal) {
      while (!signal.aborted && Date.now() < claimed.expiresAt) {
        const result = await client.pairingResult(claimed.id, claimed.claimToken);
        if (result.status === "rejected") return "rejected";
        if (result.status === "done") {
          const root = result.sealed ? openFromPeer(secrets.key, result.sealed, result.me.accountId) : null;
          await adoptSession({ server, token: result.token, me: result.me, deviceName: device.name, encRoot: root, remember: input.remember });
          return "done";
        }
        await sleep(POLL_MS, signal);
      }
      return "expired";
    },
  };
}

/* ============================================================================
   账号页的其它动作
   ============================================================================ */

export const listDevices = (): Promise<DeviceInfo[]> => withSession((client) => client.devices());
export const removeDevice = (deviceId: string): Promise<void> => withSession((client) => client.removeDevice(deviceId));
export const remoteNotebooks = (): Promise<NotebookSummary[]> => withSession((client) => client.notebooks());
export const createRemoteNotebook = (input: { name: string; cryptoMode: "none" | "user-key" }): Promise<NotebookSummary> =>
  withSession((client) => client.createNotebook(input));

export async function changePassword(currentPassword: string, newPassword: string): Promise<void> {
  await withSession((client) => client.changePassword({ currentPassword, newPassword }));
}

/** 只给测试用：换一个保管、清空模块状态。 */
export function resetAccountForTests(): void {
  credentials = null;
  encRoot = null;
  loading = null;
  githubPending = null;
  listeners.clear();
}
