/**
 * 导入收件箱 `.opennote/inbox/`（契约 `docs/import/02` §5.8 / `00` §6.10②·§6.12②）。
 *
 * 磁盘形状（逐字，字段名不得增删）：
 *
 * ```text
 * .opennote/inbox/<YYYYMMDDTHHMMSS（UTC 秒级）>-<importId 前 8 字符>/
 *   entry.json   opennote.import/v1 信封（正文外置为 body.md，附件外置到 assets/）
 *   body.md      正文（`entry.json.body` 为 null 且带 `bodyFile: "body.md"`）
 *   assets/      附件（`assets[].file`）
 *   state.json   { "status", "attempts", "lastError", "committedPath", "updatedAt" }
 * ```
 *
 * 五态逐字：`pending` / `committing` / `committed` / `failed` / `discarded`。
 * 保留期逐字：`pending`·`committing` **不设期限**、`committed` **24 小时**、
 * `failed` **7 天**；`discarded` 不是保留期而是**销毁动作**——立即 `rm -r` 条目目录，
 * **不进回收站、不可恢复**（`.opennote/trash/` 里不会出现 `inbox-*`）。
 * `.opennote/inbox/` 下的内容因此只有两种结局：入库（`committed`）或被丢弃（`discarded`）。
 *
 * 原子写：三个后端的 `writeText` 本身就是 tmp+rename（桌面端 `electron/main.cjs`
 * 的 `writeFileAtomic`）。`src/data/library.ts` 的 `writeStateFile()` 注释解释了为什么
 * **不**用显式 `tmp + move`：各后端的 `move` 不覆盖已存在的目标，那会引入「目标已删、
 * 新内容未就位」的窗口。这里沿用同一条路径，并在写完后清掉可能残留的 `*.tmp`。
 *
 * 变更检测：`.opennote/**` 被既有工作区监听显式跳过，所以收件箱靠主进程的**独立
 * watcher** + 频道 `opennote:inbox:changed`（payload `{ root, pending }`）。渲染层只做
 * 消费端：`desktopBridge()` 提供 `onInboxChanged` 时订阅、去抖 450ms 后刷新；
 * **没有 watcher 时（浏览器后端 / 旧 preload）退化为 30 秒轮询 + 窗口聚焦刷新 +
 * 显式 `refreshInbox()`**——浏览器后端没有 watcher，这一点不得含糊。
 */
import {
  desktopBridge,
  type ImportClient,
  type ImportEnvelope,
  type ImportResult,
  type InboxEntry,
  type InboxStatus,
} from "../desktop/bridge";
import { assertSafeRelative, baseName, joinPath, sanitizeName } from "../fs/paths";
import type { FileSystemBackend } from "../fs/types";
import { createStore, useStore } from "../lib/store";
import { currentBackend, currentWorkspace, rescanWorkspace } from "./library";

export type { InboxEntry, InboxStatus } from "../desktop/bridge";

/* ================================ 常量 ================================= */

/** 收件箱根目录（工作区相对路径）。 */
export const INBOX_DIR = ".opennote/inbox";

const ENTRY_FILE = "entry.json";
const STATE_FILE = "state.json";
const BODY_FILE = "body.md";
const ASSETS_DIR = "assets";

/** 条目总量上限；达到上限时拒绝新投递（`IMP-4013`）。 */
export const INBOX_LIMIT = 500;

/** 列表顶部的满额提示（`02` §5.8.5 / `03` UI-03 补充，逐字）。 */
export const INBOX_FULL_MESSAGE = "收件箱已满（500 条），请先处理一些条目。";

/** `committed` 条目保留 24 小时（留时间给用户「撤销」）。 */
export const INBOX_COMMITTED_TTL_MS = 24 * 60 * 60 * 1000;
/** `failed` 条目保留 7 天。 */
export const INBOX_FAILED_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** 清除时机 = 工作区打开时扫一遍 + 每 6 小时一次（`02` §5.8.5）。 */
const CLEANUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 兜底轮询间隔：窗口可见时每 30 秒一次（`02` §5.8.4 方案 C）。 */
const POLL_INTERVAL_MS = 30 * 1000;
/** 渲染层消费端的去抖（主进程侧 watcher 已经去抖 450ms）。 */
const REFRESH_DEBOUNCE_MS = 450;

/** 单个附件解码后 ≤ 8 MiB；数量 ≤ 32（`02` §2.7）。 */
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const MAX_ASSETS = 32;

/** 正文预览截断长度（只是预览，不是正文上限）。 */
const PREVIEW_LIMIT = 400;

/* ============================== 错误模型 =============================== */

/**
 * `code` + 中文 `userMessage` 的领域错误（与 C1 的 `ImportRejection` 同形，
 * 便于 `commitInbox` 的调用方按 `code` 分支）。
 */
export class InboxError extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(code: string, userMessage: string, options: { retryable?: boolean } = {}) {
    super(userMessage);
    this.name = "InboxError";
    this.code = code;
    this.userMessage = userMessage;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * `code` → 中文用户文案（逐字取自 `02` §6.2 的「中文用户文案」列）。
 * `empty_body` 是 `01`/`03` 冻结的客户端本地状态（不是 `IMP-` 码），一并收在这里，
 * 免得界面把内部码原样显示给用户。
 */
const MESSAGES: Record<string, string> = {
  "IMP-1001": "本地接口未开启。请在 Opennote 的「设置 · 文件 · 导入与接口」里开启，然后重试。",
  "IMP-1002": "本地接口启动失败，端口可能被安全软件占用。可在设置里换一个端口，或查看日志。",
  "IMP-1003": "8787 到 8796 端口都被占用了。请关闭占用端口的程序，或在设置里指定其它端口。",
  "IMP-1004": "本地接口没有及时响应。请确认 Opennote 正在运行。",
  "IMP-3002": "导入内容不是有效的 JSON，请重试。",
  "IMP-3003": "导入内容为空。",
  "IMP-4001": "导入内容格式不正确。",
  "IMP-4002": "这个客户端版本太旧（或太新），请更新后再试。",
  "IMP-4003": "导入内容缺少必要信息（标题、来源时间或地址），请重试。",
  "IMP-4004": "正文太长了（超过 8 MB），请分次导入。",
  "IMP-4005": "这次剪藏的内容太大（超过 16 MB），请分次导入或去掉图片。",
  "IMP-4006": "Opennote 的窗口已关闭。请重新打开 Opennote，再试一次。",
  "IMP-4007": "Opennote 里还没有打开笔记本，请先打开一个文件夹（或新建浏览器笔记本）。",
  "IMP-4008": "目标目录不合法：不能使用 `..`、绝对路径或系统保留字符。",
  "IMP-4009": "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。",
  "IMP-4010": "这个目录里同名文件太多了，请换一个目录或改标题。",
  "IMP-4011": "「追加」的目标不存在，已改为新建一篇。",
  "IMP-4012": "有一个附件无法导入（格式不支持或太大）。",
  "IMP-4013": "附件太多或太大，请减少后用重新剪藏。",
  "IMP-4014": "导入时出现了内部错误，已记录日志。请重试一次。",
  "IMP-4015": "导入太频繁了，请稍等几秒再试。",
  "IMP-4017": "没有找到这条导入记录。",
  "IMP-4020": "上一次导入还在进行中，请稍候重试。",
  "IMP-5001": "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
  empty_body: "没有可导入的内容：标题和正文都是空的。",
};

/** `code` → 中文文案；未知码原样返回（保证任何提示都能追溯到 `code`）。 */
export function inboxFailureMessage(code: string | null | undefined): string {
  if (!code) return "";
  return MESSAGES[code] ?? code;
}

/* ============================== 视图模型 =============================== */

/** 附件视图信息（名称 / 条目相对路径 / 字节数）。 */
export interface InboxAssetInfo {
  name: string;
  file: string;
  size: number;
}

/**
 * 面板需要的完整视图。`entry` 就是冻结的 `InboxEntry`（其字段全部来自磁盘），
 * 其余字段是从 `entry.json` 推导的**只读**视图，不写回磁盘。
 */
export interface InboxDetail {
  entry: InboxEntry;
  /** 条目目录名 = `<UTC 时间戳>-<importId 前 8 位>`。 */
  dirName: string;
  spec: string;
  /** 来源站点名；缺失时用 URL 的 host，仍拿不到则为空串。 */
  site: string;
  pageTitle: string | null;
  author: string | null;
  publishedAt: string | null;
  /** `source.capturedAt` 的毫秒值；不可解析时为 null。 */
  capturedAt: number | null;
  selection: boolean;
  /** 只渲染 `new` / `append` / `skip`：收件箱通道一律忽略 `overwrite`（`00` §6.7①）。 */
  conflict: "new" | "append" | "skip";
  clientName: ImportClient["name"];
  clientLabel: string;
  clientVersion: string | null;
  /**
   * 投递方不是应用自己、而且没有可识别的客户端身份 → 列表标题右侧加一个「外部」小字
   * （`03` UI-03 补充）。`chrome-extension`/`cli`/`mcp`/`share-target`/`manual` 都有自己的
   * 中文标签，只有 `other`（手工写在磁盘上的信封）需要额外提示来源不明。
   */
  external: boolean;
  assets: InboxAssetInfo[];
  /** 正文预览（外置正文需要 `readInboxDetail()` 才会填充）。 */
  bodyPreview: string;
  /** `entry.json` 的 `bodyFile`（外置正文的条目相对路径），没有则为 null。 */
  bodyFile: string | null;
}

const CLIENT_LABELS: Record<ImportClient["name"], string> = {
  "chrome-extension": "插件",
  cli: "命令行",
  mcp: "AI 助手",
  "share-target": "分享",
  manual: "手动放入",
  other: "外部",
};

function clientNameOf(value: unknown): ImportClient["name"] {
  const name = typeof value === "string" ? value : "";
  return name in CLIENT_LABELS ? (name as ImportClient["name"]) : "other";
}

function isInboxStatus(value: unknown): value is InboxStatus {
  return (
    value === "pending" ||
    value === "committing" ||
    value === "committed" ||
    value === "failed" ||
    value === "discarded"
  );
}

/* ================================ 存储 ================================= */

const EMPTY_ENTRIES: InboxEntry[] = [];

const entriesStore = createStore<InboxEntry[]>(EMPTY_ENTRIES);
const detailsStore = createStore<InboxDetail[]>([]);
/** 「当前收件箱已经至少完整读过一次」——用来区分「加载中」与「真的是空的」。 */
const loadedStore = createStore(false);

/** 当前已加载的条目（含视图字段）；`publish()` 是唯一的写入口。 */
let details: InboxDetail[] = [];

/** 本次会话里 C1 回执给的 `userMessage`（比 `code` 的通用文案更贴合现场）。 */
const failureMessages = new Map<string, string>();

function publish(next: InboxDetail[]): void {
  details = next;
  detailsStore.set(next);
  entriesStore.set(next.map((detail) => detail.entry));
}

/** 未入库的条目（`pending` / `committing`）——侧栏徽标与状态栏用的就是它。 */
export function useInbox(): InboxEntry[] {
  return useStore(entriesStore);
}

export function useInboxDetails(): InboxDetail[] {
  return useStore(detailsStore);
}

/** 收件箱是否已经读过一次（关闭笔记本后会回到 false）。 */
export function useInboxLoaded(): boolean {
  return useStore(loadedStore);
}

/** 待确认条目数（`pending` + `committing`）；`committed`/`failed`/`discarded` 不计入。 */
export function inboxCount(): number {
  let count = 0;
  for (const detail of detailsStore.get()) {
    if (detail.entry.status === "pending" || detail.entry.status === "committing") count += 1;
  }
  return count;
}

/* ============================== 路径与时间 ============================== */

function entryDirPath(dirName: string): string {
  return joinPath(INBOX_DIR, dirName);
}

function entryFilePath(dirName: string): string {
  return joinPath(entryDirPath(dirName), ENTRY_FILE);
}

function stateFilePath(dirName: string): string {
  return joinPath(entryDirPath(dirName), STATE_FILE);
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** 条目目录名的时间戳部分：`YYYYMMDDTHHMMSS`（**UTC**，秒级）。 */
export function inboxStamp(at: number): string {
  const date = new Date(at);
  return (
    `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}`
  );
}

function dirNameFor(importId: string, at: number): string {
  const slug = importId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 8) || "entry";
  return `${inboxStamp(at)}-${slug}`;
}

function toIso(at: number): string {
  return new Date(at).toISOString();
}

function parseIso(value: unknown, fallback: number): number {
  if (typeof value !== "string" || !value) return fallback;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/* ============================ state.json ============================== */

interface InboxDiskState {
  status: InboxStatus;
  attempts: number;
  lastError: string | null;
  committedPath: string | null;
  updatedAt: number;
}

function emptyState(at: number): InboxDiskState {
  return { status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: at };
}

/** 解析 `state.json`；字段非法时逐字段回落，整份不可解析时返回 null（由调用方备份）。 */
function parseStateFile(raw: string | null): InboxDiskState | null {
  if (raw === null) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const attempts = typeof record.attempts === "number" && Number.isFinite(record.attempts) ? Math.max(0, Math.floor(record.attempts)) : 0;
  return {
    status: isInboxStatus(record.status) ? record.status : "pending",
    attempts,
    lastError: typeof record.lastError === "string" && record.lastError ? record.lastError : null,
    committedPath: typeof record.committedPath === "string" && record.committedPath ? record.committedPath : null,
    updatedAt: parseIso(record.updatedAt, Date.now()),
  };
}

/**
 * 写 `state.json`。`writeText` 在三个后端上都是 tmp+rename（见文件头），写完后清掉
 * 可能残留的 `*.tmp`——半写的状态文件会让条目状态不可判读。
 */
async function writeStateFile(target: FileSystemBackend, dirName: string, state: InboxDiskState): Promise<void> {
  const path = stateFilePath(dirName);
  const contents = `${JSON.stringify(
    {
      status: state.status,
      attempts: state.attempts,
      lastError: state.lastError,
      committedPath: state.committedPath,
      updatedAt: toIso(state.updatedAt),
    },
    null,
    2,
  )}\n`;
  await target.mkdir(entryDirPath(dirName)).catch(() => undefined);
  await target.writeText(path, contents);
  await target.remove(`${path}.tmp`).catch(() => undefined);
}

/** 读 `state.json`；整份不可解析时备份为 `state.json.corrupt-<ts>` 并按 `pending` 继续。 */
async function readStateFile(target: FileSystemBackend, dirName: string, fallbackAt: number): Promise<InboxDiskState> {
  const path = stateFilePath(dirName);
  const raw = await target.readText(path).catch(() => null);
  if (raw === null) return emptyState(fallbackAt);
  const parsed = parseStateFile(raw);
  if (parsed) return parsed;
  // 与 `src/data/library.ts` 的 backupCorruptState() 同一模式：先留证据，再以空状态继续。
  const stamp = toIso(Date.now()).replace(/[:.]/g, "-");
  await target.writeText(`${path}.corrupt-${stamp}`, raw).catch(() => undefined);
  await writeStateFile(target, dirName, emptyState(fallbackAt)).catch(() => undefined);
  return emptyState(fallbackAt);
}

/** 条目目录还在时才写 `state.json`：入库途中被丢弃的条目**不能**被状态写复活。 */
async function writeStateIfPresent(
  target: FileSystemBackend,
  dirName: string,
  state: InboxDiskState,
): Promise<boolean> {
  if (!(await target.exists(entryFilePath(dirName)))) return false;
  await writeStateFile(target, dirName, state);
  return true;
}

/* ============================== 读取条目 =============================== */

function hostOf(url: string): string {
  if (!url) return "";
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
}

function previewOf(text: string): string {
  const flat = text.replace(/\r\n?/g, "\n").trim();
  if (!flat) return "";
  const body = flat.startsWith("---") ? flat.replace(/^---\n[\s\S]*?\n---\n?/, "") : flat;
  const trimmed = body.replace(/^#{1,6}\s+/gm, "").replace(/\n{2,}/g, "\n").trim();
  return trimmed.length > PREVIEW_LIMIT ? `${trimmed.slice(0, PREVIEW_LIMIT)}…` : trimmed;
}

function safeJoinWithin(dirName: string, relative: string): string | null {
  try {
    return joinPath(entryDirPath(dirName), assertSafeRelative(relative));
  } catch {
    return null;
  }
}

/** 条目目录名（升序）：契约里的「第一个」= 最早投递的那一个。 */
async function listDirNames(target: FileSystemBackend): Promise<string[]> {
  try {
    const entries = await target.list(INBOX_DIR);
    return entries
      .filter((entry) => entry.kind === "directory")
      .map((entry) => entry.name)
      .sort();
  } catch {
    // 目录不存在（或后端拒绝列目录）→ 空收件箱。目录由 ensureInboxDir() 重建。
    return [];
  }
}

async function readDir(target: FileSystemBackend, dirName: string): Promise<InboxDetail | null> {
  const path = entryFilePath(dirName);
  let raw: string;
  try {
    raw = await target.readText(path);
  } catch {
    // 没有 entry.json 的目录不是收件箱条目（例如用户在 inbox/ 里放了别的东西）。
    return null;
  }
  const stat = await target.stat(path).catch(() => null);
  const fallbackAt = stat?.mtimeMs ?? Date.now();

  let envelope: ImportEnvelope | null = null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) envelope = parsed as ImportEnvelope;
  } catch {
    envelope = null;
  }

  const state = await readStateFile(target, dirName, fallbackAt);
  const id = typeof envelope?.importId === "string" && envelope.importId ? envelope.importId : dirName;
  const source = (envelope?.source ?? {}) as Record<string, unknown>;
  const sourceUrl = typeof source.url === "string" ? source.url : "";
  const site = (typeof source.site === "string" && source.site) || hostOf(sourceUrl);
  const target_ = (envelope?.target ?? {}) as Record<string, unknown>;
  const folder = typeof target_.folder === "string" && target_.folder ? target_.folder : null;
  const tags = Array.isArray(envelope?.tags) ? envelope!.tags!.filter((tag): tag is string => typeof tag === "string") : [];
  const bodyFile = typeof envelope?.bodyFile === "string" && envelope.bodyFile ? envelope.bodyFile : null;
  const inlineBody = typeof envelope?.body === "string" ? envelope.body : "";
  const conflictRaw = typeof envelope?.conflict === "string" ? envelope.conflict : "new";
  // 收件箱通道一律忽略 overwrite（`00` §6.7①），界面只渲染 new / append / skip。
  const conflict: InboxDetail["conflict"] = conflictRaw === "append" || conflictRaw === "skip" ? conflictRaw : "new";
  const clientName = clientNameOf(envelope?.client?.name);
  const capturedRaw = typeof source.capturedAt === "string" ? source.capturedAt : "";
  const capturedAt = capturedRaw ? parseIso(capturedRaw, NaN) : NaN;

  const assets: InboxAssetInfo[] = [];
  for (const asset of envelope?.assets ?? []) {
    if (!asset || typeof asset !== "object") continue;
    const file = typeof asset.file === "string" ? asset.file : "";
    const name = typeof asset.name === "string" && asset.name ? asset.name : baseName(file) || "附件";
    const resolved = file ? safeJoinWithin(dirName, file) : null;
    const info = resolved ? await target.stat(resolved).catch(() => null) : null;
    assets.push({ name, file: resolved ? file : "", size: info?.size ?? 0 });
  }

  const envelopeBroken = envelope === null;
  const status: InboxStatus = envelopeBroken ? "failed" : state.status;
  const lastError = envelopeBroken ? "IMP-4001" : state.lastError;
  const sessionMessage = failureMessages.get(id) ?? null;

  const entry: InboxEntry = {
    id,
    status,
    attempts: state.attempts,
    lastError,
    committedPath: state.committedPath,
    updatedAt: toIso(state.updatedAt),
    createdAt: fallbackAt,
    title: typeof envelope?.title === "string" ? envelope.title : "",
    sourceUrl,
    targetFolder: folder,
    tags,
    // notePath 是 UI 用的落点，committedPath 是 state.json 契约键的镜像；入库后两者一致。
    notePath: state.committedPath,
    message: lastError ? (sessionMessage ?? inboxFailureMessage(lastError)) : null,
    envelopePath: path,
  };

  return {
    entry,
    dirName,
    spec: typeof envelope?.spec === "string" ? envelope.spec : "",
    site,
    pageTitle: typeof source.title === "string" ? source.title : null,
    author: typeof source.author === "string" ? source.author : null,
    publishedAt: typeof source.publishedAt === "string" ? source.publishedAt : null,
    capturedAt: Number.isFinite(capturedAt) ? capturedAt : null,
    selection: source.selection === true,
    conflict,
    clientName,
    clientLabel: CLIENT_LABELS[clientName],
    clientVersion: typeof envelope?.client?.version === "string" && envelope.client.version ? envelope.client.version : null,
    external: clientName === "other",
    assets,
    bodyPreview: previewOf(inlineBody),
    bodyFile,
  };
}

/** 幂等：同 id 的第二个条目标 `failed` 并记 `IMP-4017`（`02` §5.8.2）。 */
const DUPLICATE_CODE = "IMP-4017";

/** 并发护栏：只让最后一次 `refreshInbox` 的结果落地（外部投递可能连发多次）。 */
let refreshSeq = 0;

/**
 * 从磁盘重读收件箱。写盘之后、`onInboxChanged` 到达之后、以及面板打开时都会调用。
 * 同时执行契约规定的幂等收尾：同 `importId` 的第二个条目只处理第一个。
 */
export async function refreshInbox(): Promise<void> {
  const seq = ++refreshSeq;
  const target = currentBackend();
  if (!target) {
    if (seq === refreshSeq) {
      publish([]);
      loadedStore.set(true);
    }
    return;
  }
  const names = await listDirNames(target);
  const seen = new Set<string>();
  const next: InboxDetail[] = [];
  for (const dirName of names) {
    const detail = await readDir(target, dirName);
    if (!detail) continue;
    if (seen.has(detail.entry.id)) {
      // 只有第一次发现时写盘；否则每次刷新都会写一个文件，watcher 会自激。
      if (detail.entry.status !== "failed" || detail.entry.lastError !== DUPLICATE_CODE) {
        await writeStateFile(target, dirName, {
          status: "failed",
          attempts: detail.entry.attempts,
          lastError: DUPLICATE_CODE,
          committedPath: detail.entry.committedPath,
          updatedAt: Date.now(),
        }).catch(() => undefined);
        detail.entry = {
          ...detail.entry,
          status: "failed",
          lastError: DUPLICATE_CODE,
          message: failureMessages.get(detail.entry.id) ?? inboxFailureMessage(DUPLICATE_CODE),
        };
      }
    }
    seen.add(detail.entry.id);
    next.push(detail);
  }
  if (seq === refreshSeq) {
    // 列表按目录名倒序 = 最新投递的排在最前（目录名以 UTC 时间戳开头，可直接比较）。
    publish(next.sort((a, b) => (a.dirName < b.dirName ? 1 : a.dirName > b.dirName ? -1 : 0)));
    loadedStore.set(true);
  }
}

export async function listInboxDetails(): Promise<InboxDetail[]> {
  await refreshInbox();
  return detailsStore.get();
}

export async function listInbox(): Promise<InboxEntry[]> {
  await refreshInbox();
  return entriesStore.get();
}

/** 当前已加载的视图（同步读，不碰磁盘）。 */
export function inboxDetails(): InboxDetail[] {
  return details;
}

/**
 * 定位一个条目目录。命中缓存时也会**重读该目录**，保证调用方拿到的是磁盘上的当前
 * 状态（外部程序可能刚改过 `state.json`）。
 *
 * **`id` 接受两种写法**（`02` §5.8.2 与 §5.8.3 的口径）：
 * 1. `entry.id` = `envelope.importId`（渲染层内部与 `InboxEntry.id` 用的抓手）；
 * 2. **条目目录名** = `<YYMMDDTHHMMSS>-<importId 前 8>`——契约 `02:719` 把回执里的
 *    `inboxId` **逐字定义为目录名**，所以这是客户端唯一的抓手，必须能用。
 *
 * 两种写法走**同一套解析**：`readInboxEntry` / `setInboxStatus` / `commitInbox` /
 * `discardInbox` 都经由这里，不允许各写一遍。两者同时命中时 `importId` 优先
 * （在一次扫描里决定，避免歧义）；顺序在磁盘扫描与缓存两条路径上保持一致。
 */
async function findDir(
  target: FileSystemBackend,
  id: string,
): Promise<{ dirName: string; detail: InboxDetail } | null> {
  if (!id) return null;
  // 1) 缓存：先按 importId，再按目录名。
  const cached = details.find((detail) => detail.entry.id === id);
  if (cached) {
    const fresh = await readDir(target, cached.dirName);
    return { dirName: cached.dirName, detail: fresh ?? cached };
  }
  // 2) 磁盘扫描：外部刚投递/刚删改的条目可能还没进缓存。
  let alias: { dirName: string; detail: InboxDetail } | null = null;
  for (const dirName of await listDirNames(target)) {
    const detail = await readDir(target, dirName);
    if (!detail) continue;
    if (detail.entry.id === id) return { dirName, detail };
    if (!alias && dirName === id) alias = { dirName, detail };
  }
  if (alias) return alias;
  // 3) 缓存兜底（`list()` 失败或目录刚被删掉时仍以缓存为准）。
  await refreshInbox();
  const found = details.find((detail) => detail.entry.id === id) ?? details.find((detail) => detail.dirName === id);
  return found ? { dirName: found.dirName, detail: found } : null;
}

/** 带上正文预览（外置正文要多读一次 `body.md`）。 */
async function withBody(target: FileSystemBackend, detail: InboxDetail): Promise<InboxDetail> {
  if (!detail.bodyFile || detail.bodyPreview) return detail;
  const path = safeJoinWithin(detail.dirName, detail.bodyFile);
  if (!path) return detail;
  const text = await target.readText(path).catch(() => "");
  return { ...detail, bodyPreview: previewOf(text) };
}

export async function readInboxDetail(id: string): Promise<InboxDetail | null> {
  const target = currentBackend();
  if (!target) return null;
  const found = await findDir(target, id);
  if (!found) return null;
  return withBody(target, found.detail);
}

export async function readInboxEntry(id: string): Promise<InboxEntry | null> {
  const detail = await readInboxDetail(id);
  return detail?.entry ?? null;
}

/* ============================== 入队（投递） ============================ */

function decodeBase64(input: string): Uint8Array {
  const clean = input.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** `sha256(bytes)` 的前 8 个十六进制字符（契约 §3.4 的附件落盘名前缀）。 */
async function contentHash8(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)]
    .slice(0, 4)
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function ensureInboxDir(): Promise<FileSystemBackend | null> {
  const target = currentBackend();
  if (!target) return null;
  // 目录被删 → 重建（与 `.opennote/` 既有语义一致：删掉它不影响正文）。
  await target.mkdir(INBOX_DIR).catch(() => undefined);
  return target;
}

/** 把内联附件与外部附件都落到条目自己的 `assets/` 下，返回归一后的 `assets[]`。 */
async function stageAssets(
  target: FileSystemBackend,
  dirName: string,
  assets: ImportEnvelope["assets"],
  folder: string | null,
): Promise<NonNullable<ImportEnvelope["assets"]>> {
  const list = assets ?? [];
  if (list.length > MAX_ASSETS) {
    throw new InboxError("IMP-4013", inboxFailureMessage("IMP-4013"));
  }
  const out: NonNullable<ImportEnvelope["assets"]> = [];
  for (const asset of list) {
    if (!asset || typeof asset !== "object") continue;
    const name = typeof asset.name === "string" && asset.name ? asset.name : "附件";
    const mime = typeof asset.mime === "string" ? asset.mime : "application/octet-stream";
    let bytes: Uint8Array | null = null;
    if (typeof asset.dataBase64 === "string" && asset.dataBase64) {
      try {
        bytes = decodeBase64(asset.dataBase64);
      } catch {
        throw new InboxError("IMP-4012", inboxFailureMessage("IMP-4012"));
      }
    } else if (typeof asset.file === "string" && asset.file) {
      // 通道级扩展：`file` 相对工作区（`02` §2.5）；找不到时再试落点目录。
      const candidates = [asset.file, folder ? joinPath(folder, asset.file) : ""].filter(Boolean);
      for (const candidate of candidates) {
        let relative: string;
        try {
          relative = assertSafeRelative(candidate);
        } catch {
          continue;
        }
        const found = await target.readBytes(relative).catch(() => null);
        if (found) {
          bytes = found;
          break;
        }
      }
      if (!bytes) throw new InboxError("IMP-4012", inboxFailureMessage("IMP-4012"));
    }
    if (!bytes) continue;
    if (bytes.byteLength > MAX_ASSET_BYTES) {
      throw new InboxError("IMP-4012", inboxFailureMessage("IMP-4012"));
    }
    const hash = await contentHash8(bytes);
    const finalName = `${hash}-${sanitizeName(name, "attachment")}`;
    const relative = joinPath(ASSETS_DIR, finalName);
    await target.mkdir(joinPath(entryDirPath(dirName), ASSETS_DIR)).catch(() => undefined);
    await target.writeBytes(joinPath(entryDirPath(dirName), relative), bytes);
    out.push({ name, mime, file: relative });
  }
  return out;
}

/**
 * 投递一个信封到收件箱（`enqueueInbox`）。
 *
 * - 条目目录名 = `<UTC 时间戳>-<importId 前 8 位>`；`importId` 缺省时用 `meta.bodyHash`
 *   （手动把 `.md` 拖进 inbox 的场景，幂等键由应用生成，`02` §5.8.4）。
 * - 正文外置为 `body.md`，附件外置到 `assets/`，`entry.json` 里 `body` 置 null 并加
 *   `bodyFile`——**只允许**这两个契约扩展字段（外加 `enqueuedAt`）。
 * - 同 `importId` 再次投递是**幂等**的：返回既有条目，不新建第二个目录。
 * - 总量达到 500 → 拒绝并抛 `IMP-4013`（`INBOX_FULL_MESSAGE`）。
 */
export async function enqueueInbox(
  envelopeJson: string,
  meta: { title: string; sourceUrl: string; tags: string[]; targetFolder: string | null; bodyHash: string },
): Promise<InboxEntry> {
  const target = await ensureInboxDir();
  if (!target) throw new InboxError("IMP-4007", inboxFailureMessage("IMP-4007"));

  let parsed: unknown;
  try {
    parsed = JSON.parse(envelopeJson);
  } catch {
    throw new InboxError("IMP-3002", inboxFailureMessage("IMP-3002"));
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new InboxError("IMP-4001", inboxFailureMessage("IMP-4001"));
  }
  const envelope = parsed as ImportEnvelope;
  if (envelope.spec !== "opennote.import/v1") {
    throw new InboxError("IMP-4002", inboxFailureMessage("IMP-4002"));
  }
  const importId =
    (typeof envelope.importId === "string" && envelope.importId) ||
    (typeof meta.bodyHash === "string" && meta.bodyHash) ||
    "";
  if (!importId) throw new InboxError("IMP-4003", inboxFailureMessage("IMP-4003"));

  // 幂等：同 id 已有条目就直接返回它（目录名里的 id 前缀 + entry.json 的完整 id）。
  await refreshInbox();
  const existing = details.find((detail) => detail.entry.id === importId);
  if (existing) return existing.entry;

  if (details.length >= INBOX_LIMIT) {
    throw new InboxError("IMP-4013", INBOX_FULL_MESSAGE);
  }

  const at = Date.now();
  let dirName = dirNameFor(importId, at);
  let guard = 0;
  while (await target.exists(entryDirPath(dirName))) {
    guard += 1;
    if (guard > 50) throw new InboxError("IMP-4010", inboxFailureMessage("IMP-4010"));
    dirName = `${dirNameFor(importId, at)}-${guard + 1}`;
  }
  await target.mkdir(entryDirPath(dirName));

  const body = typeof envelope.body === "string" ? envelope.body : "";
  const folder = envelope.target?.folder ?? meta.targetFolder ?? null;
  // 来源信息原样保留（`capturedAt` 缺失时补投递时刻，保证信封可读）。
  const source = { ...(envelope.source ?? {}) } as Record<string, unknown>;
  if (typeof source.url !== "string" && source.url !== null) source.url = meta.sourceUrl || null;
  if (typeof source.capturedAt !== "string" || !source.capturedAt) source.capturedAt = toIso(at);
  const envelopeOut: ImportEnvelope = {
    spec: "opennote.import/v1",
    importId,
    title: typeof envelope.title === "string" && envelope.title ? envelope.title : meta.title,
    body: null,
    bodyFile: BODY_FILE,
    source: source as unknown as ImportEnvelope["source"],
    target: { folder, notePath: envelope.target?.notePath ?? null },
    conflict: envelope.conflict,
    tags: Array.isArray(envelope.tags) ? envelope.tags.filter((tag): tag is string => typeof tag === "string") : meta.tags,
    assets: await stageAssets(target, dirName, envelope.assets, folder),
    client: envelope.client,
    enqueuedAt: toIso(at),
  };
  await target.writeText(joinPath(entryDirPath(dirName), BODY_FILE), body);
  await target.writeText(joinPath(entryDirPath(dirName), ENTRY_FILE), `${JSON.stringify(envelopeOut, null, 2)}\n`);
  await writeStateFile(target, dirName, emptyState(at));

  await refreshInbox();
  await rescanWorkspace();
  const created = details.find((detail) => detail.entry.id === importId);
  if (!created) throw new InboxError("IMP-4014", inboxFailureMessage("IMP-4014"));
  return created.entry;
}

/* ============================== 状态迁移 =============================== */

/**
 * 改状态（`state.json`）并可选地补丁视图字段。
 *
 * - `patch.notePath` / `patch.committedPath` 写入 `committedPath`，`patch.message` 只作为
 *   本次会话的界面文案（`state.json` 的契约键是 `lastError`）。
 * - `patch.title` / `sourceUrl` / `targetFolder` / `tags` 会写回 `entry.json`。
 * - `status === "discarded"` 不是保留期而是销毁动作 → 委托 `discardInbox()`。
 *
 * `id` 可以是 `entry.id` 或条目目录名（见 `findDir`）。
 */
export async function setInboxStatus(
  id: string,
  status: InboxStatus,
  patch: Partial<InboxEntry> = {},
): Promise<void> {
  if (status === "discarded") {
    await discardInbox(id);
    return;
  }
  const target = currentBackend();
  if (!target) throw new InboxError("IMP-4007", inboxFailureMessage("IMP-4007"));
  const found = await findDir(target, id);
  if (!found) throw new InboxError("IMP-4017", inboxFailureMessage("IMP-4017"));

  const previous = await readStateFile(target, found.dirName, Date.now());
  const updatedAt = typeof patch.updatedAt === "string" ? parseIso(patch.updatedAt, Date.now()) : Date.now();
  // 目录已不在（比如面板刚丢弃）时不再写状态，避免复活空壳目录。
  await writeStateIfPresent(target, found.dirName, {
    status,
    attempts: typeof patch.attempts === "number" ? patch.attempts : previous.attempts,
    lastError: typeof patch.lastError === "string" || patch.lastError === null ? patch.lastError : previous.lastError,
    committedPath:
      typeof patch.committedPath === "string" || patch.committedPath === null
        ? patch.committedPath
        : typeof patch.notePath === "string"
          ? patch.notePath
          : previous.committedPath,
    updatedAt,
  });

  // 会话文案表按 `entry.id` 建键：调用方可能传的是目录名。
  const key = found.detail.entry.id;
  if (patch.message) failureMessages.set(key, patch.message);
  else if (status !== "failed") failureMessages.delete(key);

  const touchesEnvelope =
    patch.title !== undefined ||
    patch.sourceUrl !== undefined ||
    patch.targetFolder !== undefined ||
    patch.tags !== undefined;
  if (touchesEnvelope) await patchEnvelope(target, found.dirName, patch);

  await refreshInbox();
}

async function patchEnvelope(
  target: FileSystemBackend,
  dirName: string,
  patch: Partial<InboxEntry>,
): Promise<void> {
  const path = entryFilePath(dirName);
  const raw = await target.readText(path).catch(() => null);
  if (raw === null) return;
  let envelope: ImportEnvelope;
  try {
    envelope = JSON.parse(raw) as ImportEnvelope;
  } catch {
    return;
  }
  if (typeof patch.title === "string") envelope.title = patch.title;
  if (typeof patch.sourceUrl === "string") {
    envelope.source = { ...(envelope.source ?? { capturedAt: toIso(Date.now()) }), url: patch.sourceUrl || null };
  }
  if (patch.targetFolder !== undefined) {
    envelope.target = { ...(envelope.target ?? {}), folder: patch.targetFolder };
  }
  if (Array.isArray(patch.tags)) envelope.tags = [...patch.tags];
  await target.writeText(path, `${JSON.stringify(envelope, null, 2)}\n`);
  await target.remove(`${path}.tmp`).catch(() => undefined);
}

/* ================================ 入库 ================================= */

/**
 * C1 的接收端（`src/lib/clip/receive.ts`）。签名由 Lead 冻结：
 * `(envelopeJson, { channel: "inbox" }) => Promise<ImportResult>`。
 *
 * 依赖方向刻意保持「接收端 → 收件箱」：收件箱不静态 import 接收端，避免两者
 * 互相 import 时在模块初始化期踩 TDZ。接线方式见 `loadClipReceiver()`。
 */
export type InboxReceiver = (
  envelopeJson: string,
  meta: { channel: "inbox" },
) => Promise<ImportResult>;

let receiver: InboxReceiver | null = null;

/** 正在入库的条目（同进程内的并发护栏；跨窗口由磁盘上的 `committing` 兜住）。 */
const inFlight = new Set<string>();

/** 注册接收端（`null` = 注销）。测试与接线点用它注入。 */
export function setInboxReceiver(fn: InboxReceiver | null): void {
  receiver = fn;
}

export function hasInboxReceiver(): boolean {
  return receiver !== null;
}

/**
 * 默认接收端的惰性解析：**字面量动态导入** `src/lib/clip/receive.ts`（C1 的 L2 接收端）。
 *
 * - 动态导入避免「收件箱 ↔ 接收端」在模块初始化期互相 import（收件端会 import 数据层）；
 * - 优先用 `receiveEnvelopeOutcome()`：它**永不抛**，把 `{code,message,userMessage,…}`
 *   原样交回来，异常跨模块传播时丢字段的风险就此消失；
 * - 入库前把通道上下文设为 `inbox`：收件箱通道一律忽略 `overwrite`（`00` §6.7①）。
 *
 * 模块加载失败（打包缺失、循环初始化失败）时返回 null，由调用方**如实失败**，
 * 绝不假装入库成功。
 */
async function loadClipReceiver(): Promise<InboxReceiver | null> {
  try {
    const clip = await import("../lib/clip/receive");
    return async (envelopeJson, meta) => {
      clip.setImportChannelContext({ channel: meta.channel, overwriteEnabled: false });
      const outcome = await clip.receiveEnvelopeOutcome(envelopeJson);
      if (!outcome.ok) {
        throw new InboxError(outcome.error.code, outcome.error.userMessage, {
          retryable: outcome.error.retryable,
        });
      }
      // `ImportReceipt` 是桥上 `ImportResult` 的超集（多 `message` / `undoSeconds`），可直接交回。
      return outcome.result;
    };
  } catch (error) {
    console.warn("[opennote] 导入接收端加载失败", error);
    return null;
  }
}

async function resolveReceiver(): Promise<InboxReceiver> {
  if (receiver) return receiver;
  const loaded = await loadClipReceiver();
  if (loaded) return loaded;
  throw new InboxError("IMP-4014", "导入接收端还没有就绪，请重启 Opennote 后再试。");
}

/** 把条目信封还原成**纯内联**形态交给接收端（正文与附件都内联，路径不再是问题）。 */
async function envelopeForReceiver(target: FileSystemBackend, dirName: string): Promise<string> {
  const raw = await target.readText(entryFilePath(dirName));
  const envelope = JSON.parse(raw) as ImportEnvelope;
  if (envelope.bodyFile) {
    const path = safeJoinWithin(dirName, envelope.bodyFile);
    envelope.body = path ? await target.readText(path).catch(() => "") : "";
    delete envelope.bodyFile;
  }
  if (envelope.body === null || envelope.body === undefined) envelope.body = "";
  const assets: NonNullable<ImportEnvelope["assets"]> = [];
  for (const asset of envelope.assets ?? []) {
    if (!asset || typeof asset !== "object") continue;
    if (typeof asset.dataBase64 === "string" && asset.dataBase64) {
      assets.push(asset);
      continue;
    }
    if (typeof asset.file === "string" && asset.file) {
      const path = safeJoinWithin(dirName, asset.file);
      const bytes = path ? await target.readBytes(path).catch(() => null) : null;
      if (bytes) {
        assets.push({ name: asset.name, mime: asset.mime, dataBase64: encodeBase64(bytes) });
        continue;
      }
    }
    assets.push(asset);
  }
  envelope.assets = assets;
  return JSON.stringify(envelope);
}

function describeFailure(error: unknown): { code: string; message: string } {
  const candidate = error as { code?: unknown; userMessage?: unknown; message?: unknown } | null;
  const raw = typeof candidate?.code === "string" ? candidate.code : "";
  const code = /^IMP-[1-5]\d{3}$/.test(raw) || /^IMP-W\d{3}$/.test(raw) ? raw : "IMP-5001";
  const userMessage =
    typeof candidate?.userMessage === "string" && candidate.userMessage.trim() ? candidate.userMessage.trim() : "";
  return { code, message: userMessage || inboxFailureMessage(code) };
}

/**
 * 确认入库：把条目交回 C1 的接收端落盘（`02` §8.1：正文只由渲染层写）。
 *
 * 失败时把 `code` 写进 `state.json.lastError` 并把状态置 `failed`，然后**抛出**
 * `InboxError`（`code` + 中文 `userMessage`），让面板能弹 `UI-07` 的提示——
 * 条目本身留在收件箱里，用户可重试或丢弃。
 */
export async function commitInbox(id: string): Promise<void> {
  await commitInboxResult(id);
}

/**
 * 与 `commitInbox` 同一份实现，额外把接收端的 `ImportResult` 交回调用方
 * （IPC 转交层 `opennote:inbox:commit` 的契约返回形状就是它）。
 * 已经入库的条目返回 `null`（幂等，不重复写盘）。
 */
export async function commitInboxResult(id: string): Promise<ImportResult | null> {
  const target = currentBackend();
  if (!target) throw new InboxError("IMP-4007", inboxFailureMessage("IMP-4007"));
  // 同一进程里的并发护栏：两次点击/Enter+点击不会跑两遍接收端。
  if (inFlight.has(id)) throw new InboxError("IMP-4020", inboxFailureMessage("IMP-4020"), { retryable: true });
  inFlight.add(id);
  try {
    return await runCommit(target, id);
  } finally {
    inFlight.delete(id);
  }
}

async function runCommit(target: FileSystemBackend, id: string): Promise<ImportResult | null> {
  const found = await findDir(target, id);
  if (!found) throw new InboxError("IMP-4017", inboxFailureMessage("IMP-4017"));
  const status = found.detail.entry.status;
  if (status === "committed") {
    // 幂等：已经入库的条目再点一次不重复写盘。
    await refreshInbox();
    return null;
  }
  if (status === "committing") {
    throw new InboxError("IMP-4020", inboxFailureMessage("IMP-4020"), { retryable: true });
  }

  const attempts = found.detail.entry.attempts + 1;
  const previousPath = found.detail.entry.committedPath;
  // 会话文案表按 `entry.id`（importId）建键：调用方可能传的是目录名。
  const key = found.detail.entry.id;
  // 「正在处理」的锁：UI 立刻显示「正在写入…」，同时防止重复处理。
  await writeStateFile(target, found.dirName, {
    status: "committing",
    attempts,
    lastError: null,
    committedPath: previousPath,
    updatedAt: Date.now(),
  });
  await refreshInbox();

  let result: ImportResult;
  try {
    const receive = await resolveReceiver();
    const envelopeJson = await envelopeForReceiver(target, found.dirName);
    result = await receive(envelopeJson, { channel: "inbox" });
  } catch (error) {
    const described = describeFailure(error);
    failureMessages.set(key, described.message);
    // 途中被丢弃（目录已不在）时不再写状态，否则会把丢弃过的条目「复活」成一个空壳目录。
    await writeStateIfPresent(target, found.dirName, {
      status: "failed",
      attempts,
      lastError: described.code,
      committedPath: previousPath,
      updatedAt: Date.now(),
    }).catch(() => undefined);
    await refreshInbox().catch(() => undefined);
    if (error instanceof InboxError) throw error;
    throw new InboxError(described.code, described.message, { retryable: true });
  }

  // 接收端若把这条又放回收件箱（`pending`），就不能算入库；其余状态都是终态成功。
  const settled: InboxStatus = result.status === "pending" ? "pending" : "committed";
  failureMessages.delete(key);
  const kept = await writeStateIfPresent(target, found.dirName, {
    status: settled,
    attempts,
    lastError: null,
    committedPath: settled === "committed" ? result.path ?? null : previousPath,
    updatedAt: Date.now(),
  });
  // 入库后界面必须 3 秒内可见：重扫工作区 + 重读收件箱。
  await rescanWorkspace();
  await refreshInbox();
  return kept ? result : null;
}

/* ================================ 丢弃 ================================= */

/**
 * 丢弃（`00` §6.12②，语义写死）：`rm -r` 掉条目目录与内容，
 * **不写任何回收站记录、不可恢复**，`.opennote/trash/` 里不会出现 `inbox-*`。
 *
 * `id` 既可以是 `entry.id`（`importId`），也可以是**条目目录名**（= 契约回执里的
 * `inboxId`）。找不到时**抛 `IMP-4017`**，绝不静默返回——静默返回会让客户端
 * 「以为丢弃了、其实没丢弃」（§8 反模式清单里的「静默成功」）。
 */
export async function discardInbox(id: string): Promise<void> {
  const target = currentBackend();
  if (!target) throw new InboxError("IMP-4007", inboxFailureMessage("IMP-4007"));
  const found = await findDir(target, id);
  if (!found) throw new InboxError("IMP-4017", inboxFailureMessage("IMP-4017"));
  failureMessages.delete(found.detail.entry.id);
  await target.remove(entryDirPath(found.dirName), { recursive: true });
  await refreshInbox();
}

/* ============================== 保留期清理 ============================== */

/**
 * 保留期清理：`committed` 24 小时后、`failed` 7 天后删除条目目录；
 * `pending` / `committing` **永不自动删除**。清理同样**不进回收站**。
 * 返回被清理的条目数。
 */
export async function cleanupInbox(now = Date.now()): Promise<number> {
  const target = currentBackend();
  if (!target) return 0;
  const names = await listDirNames(target);
  let removed = 0;
  for (const dirName of names) {
    const detail = await readDir(target, dirName);
    if (!detail) continue;
    const { status, updatedAt } = detail.entry;
    const ttl =
      status === "committed" ? INBOX_COMMITTED_TTL_MS : status === "failed" ? INBOX_FAILED_TTL_MS : null;
    if (ttl === null) continue;
    if (now - parseIso(updatedAt, now) <= ttl) continue;
    await target.remove(entryDirPath(dirName), { recursive: true });
    removed += 1;
  }
  if (removed) await refreshInbox();
  return removed;
}

/* ============================== 变更检测 =============================== */

let watching = false;
let watchUnsubscribe: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let cleanupTimer: ReturnType<typeof setInterval> | null = null;
let focusHandler: (() => void) | null = null;
let watchingRoot: string | null = null;

function normalizeRoot(path: string | null | undefined): string {
  return String(path ?? "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .toLowerCase();
}

/** 主进程广播的是绝对路径；只认当前打开的笔记本。 */
export function inboxEventMatches(changed: string | null | undefined, root: string | null | undefined): boolean {
  const a = normalizeRoot(changed);
  const b = normalizeRoot(root);
  if (!a || !b) return false;
  return a === b;
}

function scheduleRefresh(): void {
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => {
    refreshTimer = null;
    void refreshInbox().catch(() => undefined);
  }, REFRESH_DEBOUNCE_MS);
  refreshTimer.unref?.();
}

/**
 * 启动消费端。**幂等**——重复调用不会叠加订阅或定时器。
 *
 * - 桌面版（`desktopBridge().onInboxChanged`）：订阅独立 watcher 的广播，去抖 450ms 刷新。
 * - 浏览器后端 / 旧 preload（没有 `onInboxChanged`）：**没有 watcher**，退化为 30 秒轮询
 *   + 窗口聚焦时立即刷新 + 调用方的显式 `refreshInbox()`。
 * - 两种模式下都会：重建被删的 `inbox/` 目录、跑一次保留期清理、每 6 小时再清理一次。
 */
export function startInboxWatch(): void {
  if (watching) return;
  watching = true;
  watchingRoot = currentWorkspace()?.location ?? null;

  void ensureInboxDir()
    .then(() => cleanupInbox())
    .catch(() => undefined);
  cleanupTimer = setInterval(() => {
    void cleanupInbox().catch(() => undefined);
  }, CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();

  const bridge = desktopBridge();
  if (typeof bridge?.onInboxChanged === "function") {
    watchUnsubscribe = bridge.onInboxChanged((changed) => {
      const root = currentWorkspace()?.location ?? watchingRoot ?? null;
      // 广播发给每个窗口：不是当前笔记本就忽略。
      if (changed?.root && !inboxEventMatches(changed.root, root)) return;
      scheduleRefresh();
    });
  } else {
    // 浏览器后端没有 watcher（`.opennote/**` 也被工作区监听跳过）——只能轮询。
    pollTimer = setInterval(() => {
      void refreshInbox().catch(() => undefined);
    }, POLL_INTERVAL_MS);
    pollTimer.unref?.();
  }

  if (typeof window !== "undefined") {
    focusHandler = () => {
      void refreshInbox().catch(() => undefined);
    };
    window.addEventListener("focus", focusHandler);
  }

  void refreshInbox().catch(() => undefined);
}

/**
 * 停止消费端并清空视图（关闭 / 切换笔记本时调用）。收件箱属于某一个工作区，
 * 换了笔记本还留着上一条的计数就是错的。
 */
export function stopInboxWatch(): void {
  watching = false;
  if (refreshTimer) {
    clearTimeout(refreshTimer);
    refreshTimer = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
  const unsubscribe = watchUnsubscribe;
  watchUnsubscribe = null;
  if (unsubscribe) {
    try {
      unsubscribe();
    } catch {
      /* 退订失败不影响后续状态 */
    }
  }
  if (focusHandler && typeof window !== "undefined") {
    window.removeEventListener("focus", focusHandler);
  }
  focusHandler = null;
  watchingRoot = null;
  publish([]);
  loadedStore.set(false);
}

/** 当前是否处于「有 watcher」模式（浏览器后端一定是 false，`no watcher` 必须如实呈现）。 */
export function inboxWatchMode(): "watch" | "poll" | "off" {
  if (!watching) return "off";
  return watchUnsubscribe ? "watch" : "poll";
}
