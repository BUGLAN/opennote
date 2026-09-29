/**
 * L0 导入信封 `opennote.import/v1` 的字段类型与校验器。
 *
 * 唯一权威：`docs/import/02-接口契约-导入信封与通道.md` §2（字段规范）、§6.2（错误码/
 * 警告总表）、附录 A.1（JSON Schema）。**字段名、错误码、front-matter 键名逐字照抄，
 * 禁止改名**。
 *
 * 三条贯穿的硬约束（§1.2）：
 * 1. **未知字段一律忽略**（不报错、不写入文件），保证 v1 客户端在 v2 服务端上仍可工作；
 *    `spec` 是唯一允许拒绝请求的版本字段；
 * 2. 校验顺序固定：`spec` → 必填字段 → 类型 → 长度/大小 → 枚举值（§7.3）；
 * 3. 校验是**纯函数、无副作用**：本模块不碰磁盘、不读全局状态（`bodyFile` / `assets[].file`
 *    这类外置形态的字节由 `receive.ts` 读取后再走同一套校验）。
 */

import { assertSafeRelative, isMarkdownPath, sanitizeName } from "../../fs/paths";
import { normalizeEol } from "../utils";

/* ============================== 常量与上限 ============================== */

export const IMPORT_SPEC = "opennote.import/v1";

export const MAX_TITLE_CHARS = 200;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** 整个请求体上限：桥在解析 JSON **之前**按它拒绝（`IMP-4005`）。 */
export const MAX_REQUEST_BYTES = 16 * 1024 * 1024;
export const MAX_ASSETS = 32;
export const MAX_ASSET_BYTES = 8 * 1024 * 1024;
export const MAX_ASSETS_TOTAL_BYTES = 24 * 1024 * 1024;
export const MAX_TAGS = 32;
export const MAX_TAG_CHARS = 32;
export const MAX_FOLDER_DEPTH = 10;
export const MAX_FOLDER_SEGMENT_CHARS = 80;
export const MAX_SOURCE_TITLE_CHARS = 300;
export const MAX_SOURCE_FIELD_CHARS = 120;

/** §2.5：附件 MIME 白名单。 */
export const ASSET_MIME_WHITELIST = [
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/bmp",
] as const;

export const IMPORT_CONFLICTS = ["new", "append", "skip", "overwrite"] as const;
export type ImportConflict = (typeof IMPORT_CONFLICTS)[number];

export const IMPORT_CLIENT_NAMES = ["chrome-extension", "cli", "mcp", "share-target", "manual", "other"] as const;
export type ImportClientName = (typeof IMPORT_CLIENT_NAMES)[number];

/* ============================ 错误与警告总表 ============================ */

/**
 * 统一错误响应（契约 §6.1）。`code` 稳定不变，客户端按它分支、不按文案分支；
 * `userMessage` 是面向用户的中文文案。
 */
export interface ImportProblem {
  code: string;
  /** 面向开发者的短描述（可含字段名）。 */
  message: string;
  /** 面向用户的中文文案，可直接显示。 */
  userMessage: string;
  /** HTTP 状态码（本地桥用；非 HTTP 通道可忽略）。 */
  http: number;
  /** 客户端是否可以原样重试。 */
  retryable: boolean;
  detail?: Record<string, unknown>;
}

interface ProblemTemplate {
  message: string;
  userMessage: string;
  http: number;
  retryable: boolean;
}

/** 本接收端实际会产出的错误码（文案逐字来自契约 §6.2）。 */
export const IMPORT_ERRORS: Record<string, ProblemTemplate> = {
  "IMP-3002": { message: "JSON 解析失败", userMessage: "导入内容不是有效的 JSON，请重试。", http: 400, retryable: false },
  "IMP-3003": { message: "请求体为空", userMessage: "导入内容为空。", http: 400, retryable: false },
  "IMP-4001": {
    message: "请求体不是 JSON 对象",
    userMessage: "导入内容格式不正确。",
    http: 400,
    retryable: false,
  },
  "IMP-4002": {
    message: "spec 缺失或不是 opennote.import/v1",
    userMessage: "这个客户端版本太旧（或太新），请更新后再试。",
    http: 422,
    retryable: false,
  },
  "IMP-4003": {
    message: "必填字段缺失或类型/取值非法",
    userMessage: "导入内容缺少必要信息（标题、来源时间或地址），请重试。",
    http: 422,
    retryable: false,
  },
  "IMP-4004": {
    message: "body 超过 8 MiB",
    userMessage: "正文太长了（超过 8 MB），请分次导入。",
    http: 413,
    retryable: false,
  },
  "IMP-4005": {
    message: "请求体超过 16 MiB",
    userMessage: "这次剪藏的内容太大（超过 16 MB），请分次导入或去掉图片。",
    http: 413,
    retryable: false,
  },
  // 00 §6.14㉗（0.3.0，逐字冻结，**优先于** 02/03 的旧文案）：用户把旧文案
  // 「Opennote 里还没有打开笔记本」读成「要先打开某一篇笔记」，所以这里明确写「笔记本文件夹」，
  // 并把下一步动作说到「左侧选一个文件夹 / 新建一个」。**禁止**再用
  // 「还没有打开笔记本」「请先打开一个文件夹（或新建浏览器笔记本）」这类措辞。
  // 本接收端不产出 `IMP-4006`（那是桥/扩展侧的「应用没运行」），但把它一起放进表里：
  // `toImportErrorBody()` 需要按码给跨模块来的错误补 `http`/`retryable`，且㉗ 的三态区分
  // （应用没运行 / 工作区没打开 / 某一篇笔记没打开）需要一个权威副本。
  "IMP-4006": {
    message: "应用窗口不在场（应用没运行 / 窗口已关闭）",
    userMessage: "Opennote 没有在运行。请先打开 Opennote，再试一次。",
    http: 409,
    retryable: true,
  },
  "IMP-4007": {
    message: "工作区未打开",
    userMessage: "Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。",
    http: 409,
    retryable: true,
  },
  "IMP-4008": {
    message: "target 路径非法",
    // 注意：**不要**写成 `` `..` `` —— `02` 附录 A.3 表格里的反引号是 Markdown 内联代码标记，
    // 抄进字符串就会连反引号一起显示给用户。`electron/bridge.cjs:129` 与 `src/data/inbox.ts` 都无引号，
    // `envelope.test.ts` 有一条「全表不得含反引号 + 与桥逐字相等」的护栏盯着这里。
    userMessage: "目标目录不合法：不能使用 ..、绝对路径或系统保留字符。",
    http: 422,
    retryable: false,
  },
  "IMP-4009": {
    message: "append 目标不可用或目录创建被拒",
    userMessage: "找不到要追加的那篇笔记，或目标目录无法创建（可能没有写入权限）。",
    http: 404,
    retryable: false,
  },
  "IMP-4010": {
    message: "无法分配文件名（重试 500 次仍冲突）",
    userMessage: "这个目录里同名文件太多了，请换一个目录或改标题。",
    http: 409,
    retryable: false,
  },
  "IMP-4011": {
    message: "冲突策略命中（append 无目标 / overwrite 降级 / skip 命中）",
    userMessage: "「追加」的目标不存在，已改为新建一篇。",
    http: 409,
    retryable: false,
  },
  "IMP-4012": {
    message: "附件不可用（MIME / base64 / 单件过大 / SVG 净化失败）",
    userMessage: "有一个附件无法导入（格式不支持或太大）。",
    http: 415,
    retryable: false,
  },
  "IMP-4013": {
    message: "附件数量或合计体积超限",
    // 逐字照抄 `02:1703`（唯一文案源；「用」指 03 号里那个「重新剪藏」按钮，不是笔误）。
    // 收件箱满 500 的场景由 `src/data/inbox.ts` 的 `INBOX_FULL_MESSAGE` 给更贴切的文案，
    // 走 `toImportErrorBody()` 透传时以错误对象自带的 userMessage 为准（见该函数注释）。
    userMessage: "附件太多或太大，请减少后用重新剪藏。",
    http: 413,
    retryable: false,
  },
  "IMP-4014": {
    message: "内部一致性错误",
    userMessage: "导入时出现了内部错误，已记录日志。请重试一次。",
    http: 500,
    retryable: true,
  },
  "IMP-5001": {
    message: "写盘失败",
    userMessage: "写入笔记失败，磁盘可能已满或没有权限。原内容没有丢失。",
    http: 500,
    retryable: true,
  },
};

/** §6.2 的 `IMP-Wxxx` 警告文案（逐字）。 */
export const IMPORT_WARNINGS = {
  "IMP-W001": "正文为空，只写入了标题。",
  "IMP-W002": "正文里有未声明的本地附件引用，已原样保留。",
  "IMP-W003": "没找到要追加的笔记，已新建一篇。",
  "IMP-W004": "目标笔记有外部改动，已另存为新文件以免覆盖。",
  "IMP-W005": "幂等索引写入失败，重复导入可能产生副本。",
  "IMP-W006": "网页发布时间无法识别，已忽略。",
  "IMP-W007": "部分标签不符合规则，已忽略。",
  "IMP-W008": "本次追加没有留下可回退的前像，撤销将只把笔记移入回收站。",
} as const;

export type ImportWarningCode = keyof typeof IMPORT_WARNINGS;

/** 回执里的 `warnings[]` 形态：`"IMP-W002 正文里有未声明的本地附件引用，已原样保留。"` */
export function warningText(code: ImportWarningCode): string {
  return `${code} ${IMPORT_WARNINGS[code]}`;
}

/** 构造一条统一错误（§6.1）。文案取自总表，`detail` 不得含宿主机绝对路径/用户名/令牌。 */
export function importProblem(code: string, detail?: Record<string, unknown>): ImportProblem {
  const template = IMPORT_ERRORS[code] ?? {
    message: code,
    userMessage: IMPORT_ERRORS["IMP-4014"].userMessage,
    http: 500,
    retryable: true,
  };
  const problem: ImportProblem = {
    code,
    message: template.message,
    userMessage: template.userMessage,
    http: template.http,
    retryable: template.retryable,
  };
  if (detail) problem.detail = detail;
  return problem;
}

/**
 * 域错误。`receiveEnvelope()` 用它把 `IMP-4xxx` 抛给调用方（应用内调用）；
 * 渲染层 ↔ 主进程的 IPC 转交请用永不抛的 `receiveEnvelopeOutcome()`，
 * 因为 `ipcMain.handle` 会把抛出的异常退化成字符串，结构化字段会丢。
 */
export class ImportRejection extends Error {
  readonly code: string;
  readonly userMessage: string;
  readonly http: number;
  readonly retryable: boolean;
  readonly detail?: Record<string, unknown>;

  constructor(problem: ImportProblem) {
    super(problem.message);
    this.name = "ImportRejection";
    this.code = problem.code;
    this.userMessage = problem.userMessage;
    this.http = problem.http;
    this.retryable = problem.retryable;
    if (problem.detail) this.detail = problem.detail;
  }

  /** §6.1 的统一错误响应体，可直接交给桥 / CLI / 页面内桥。 */
  toResponse(): { ok: false; error: ImportProblem } {
    const error: ImportProblem = {
      code: this.code,
      message: this.message,
      userMessage: this.userMessage,
      http: this.http,
      retryable: this.retryable,
    };
    if (this.detail) error.detail = this.detail;
    return { ok: false, error };
  }
}

/**
 * 精确的类守卫：只认 `ImportRejection`（`instanceof` 或 `name` + `code`）。
 *
 * ⚠️ **跨模块传错误对象时不要用这个当唯一通路**：别的模块有自己的域错误类
 * （例如 `src/data/inbox.ts` 的 `InboxError`，`name === "InboxError"`），它带着
 * 完全正确的 `IMP-####` + `userMessage`，却会被这个精确守卫判成 false，
 * 于是被包成 `IMP-5001 写盘失败` —— 原因和下一步都指错（用户被叫去查磁盘，
 * 而正确动作是「去收件箱处理几条」）。这是本项目第三次同类缝：
 * **写者 A 的错误对象被写者 B 的类型守卫吃掉**。
 * 所以判定一律走下面的 `toImportErrorBody()`（按结构判、不按类判），
 * 本函数只保留给「确实要区分是不是自己抛的」的少数场景。
 */
export function isImportRejection(value: unknown): value is ImportRejection {
  return (
    value instanceof ImportRejection ||
    (typeof value === "object" &&
      value !== null &&
      (value as { name?: string }).name === "ImportRejection" &&
      typeof (value as { code?: unknown }).code === "string")
  );
}

const DOMAIN_CODE = /^IMP-\d{4}$/;

function readField(source: Record<string, unknown>, key: string): unknown {
  const value = source[key];
  return typeof value === "function" ? undefined : value;
}

/**
 * **结构化的域错误归一化**（跨模块通用）：任何带 `IMP-####` 码 + 非空 `userMessage`
 * 的错误对象都算域错误，**不依赖具体类**（`ImportRejection` / `InboxError` / 别的写者都行）。
 *
 * 缺失的 `http` / `retryable` 从 `IMPORT_ERRORS` 总表按 `code` 补齐（域错误对象通常只带
 * 码和文案，不带 HTTP 语义），`message` 缺失时同样回落到表里的开发者短描述。
 * 不是域错误（普通 `Error`、字符串、null…）一律返回 `null`，由调用方归到 `IMP-5001`。
 */
export function toImportErrorBody(error: unknown): ImportProblem | null {
  if (typeof error !== "object" || error === null) return null;
  const source = error as Record<string, unknown>;
  const rawCode = readField(source, "code");
  if (typeof rawCode !== "string" || !DOMAIN_CODE.test(rawCode)) return null;
  const rawUserMessage = readField(source, "userMessage");
  if (typeof rawUserMessage !== "string" || rawUserMessage.trim() === "") return null;

  const template = IMPORT_ERRORS[rawCode];
  const rawMessage = readField(source, "message");
  const rawHttp = readField(source, "http");
  const rawRetryable = readField(source, "retryable");
  const rawDetail = readField(source, "detail");

  const problem: ImportProblem = {
    code: rawCode,
    // 域错误自己的文案优先（同一个码在不同场景可以有不同的用户文案，例如
    // `IMP-4013` 既可能是「附件太多」也可能是「收件箱已满」），表只做兜底。
    message: typeof rawMessage === "string" && rawMessage ? rawMessage : (template?.message ?? rawCode),
    userMessage: rawUserMessage,
    http: typeof rawHttp === "number" && Number.isInteger(rawHttp) ? rawHttp : (template?.http ?? 500),
    retryable: typeof rawRetryable === "boolean" ? rawRetryable : (template?.retryable ?? true),
  };
  if (typeof rawDetail === "object" && rawDetail !== null && !Array.isArray(rawDetail)) {
    problem.detail = rawDetail as Record<string, unknown>;
  }
  return problem;
}

/* ================================ 类型 ================================ */

export interface ImportEnvelopeSource {
  url: string | null;
  title: string | null;
  site: string | null;
  author: string | null;
  publishedAt: string | null;
  /** 必填，ISO 8601 且**必须含时区**（`Z` 或 `±HH:MM`）。 */
  capturedAt: string;
  /** `true` = 用户选中的片段，`false`/缺省 = 整页正文。它是**判定输入**，不只是 UI 标签。 */
  selection: boolean;
}

export interface ImportEnvelopeTarget {
  /** 工作区相对目录（POSIX 风格）；`null`/`""` = 工作区根目录。 */
  folder: string | null;
  /** 仅 `conflict` 为 `append` / `overwrite` 时有效：指向一个**已存在**的笔记。 */
  notePath: string | null;
}

export interface ImportAsset {
  /** 原始文件名（含扩展名）。落盘名**不是**它，见契约 §3.4。 */
  name: string;
  mime: string;
  dataBase64: string | null;
  /** 外置形态：相对工作区的路径（收件箱里是相对条目目录的路径）。 */
  file: string | null;
  /** `dataBase64` 解码后的字节；`file` 形态为 `null`，由接收端读盘补齐。 */
  bytes: Uint8Array | null;
}

export interface ImportClient {
  name: ImportClientName;
  version: string;
}

export interface ImportEnvelope {
  spec: typeof IMPORT_SPEC;
  importId: string;
  title: string;
  /**
   * 内联正文。外置形态（`bodyFile`）下为空串 —— 接收端读完盘后必须**重新计算哈希**，
   * 因为哈希只认最终正文。
   */
  body: string;
  /** 通道级扩展：正文外置的路径；`null` 表示正文内联在 `body` 里。 */
  bodyFile: string | null;
  source: ImportEnvelopeSource;
  target: ImportEnvelopeTarget;
  conflict: ImportConflict;
  /**
   * 客户端是否**显式**传了 `conflict`。
   *
   * 判定链第 3/4 步（同 URL 不同内容 → 选区 `append` / 整页进收件箱）只在**没显式传**时
   * 生效（契约 §4.1 推论 4：「优先级 3/4 可被客户端的显式 `conflict` 覆盖」）。
   * `conflict` 的字段默认值是 `"new"`，若不区分「缺省」与「显式 new」，整页二次剪藏就
   * 永远不会进收件箱了。
   */
  conflictExplicit: boolean;
  tags: string[];
  assets: ImportAsset[];
  client: ImportClient;
  /** 校验阶段产生的非致命提示（已是 `IMP-Wxxx 文案` 形态）。 */
  warnings: string[];
}

export type EnvelopeValidation =
  | { ok: true; envelope: ImportEnvelope }
  | { ok: false; errorCode: string; message: string };

/* ============================== 小工具 ============================== */

const encoder = new TextEncoder();

export function utf8Bytes(text: string): number {
  return encoder.encode(text).length;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOptionalString(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : null;
}

function truncate(value: string, limit: number): string {
  return value.length > limit ? value.slice(0, limit) : value;
}

/** 抛出统一错误（`ImportRejection`）；由 `validateImportEnvelope` 统一转成 `ImportProblem`。 */
function fail(code: string, detail?: Record<string, unknown>): never {
  throw new ImportRejection(importProblem(code, detail));
}

/* ============================ 时间（§2.3） ============================ */

const ISO_WITH_TIMEZONE = /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(?:[Zz]|[+-]\d{2}:?\d{2})$/;

/** `capturedAt` 必须可解析**且含时区**；`"2026-09-29T21:00:00"` 视为非法（§10.1）。 */
export function isTimestampWithTimezone(value: string): boolean {
  const text = value.trim();
  if (!ISO_WITH_TIMEZONE.test(text)) return false;
  return !Number.isNaN(Date.parse(text));
}

/** `publishedAt` 只要求可解析；取不到就写 `null` 并回 `IMP-W006`（不失败）。 */
export function isParseableTimestamp(value: string): boolean {
  return !Number.isNaN(Date.parse(value.trim()));
}

/** 时间戳 → 毫秒；不可解析时回退 `Date.now()`。 */
export function timestampMs(value: string | null | undefined): number {
  if (!value) return Date.now();
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? Date.now() : ms;
}

/* ============================ 标签（§2.2 / §6.11③） ============================ */

/**
 * 标签清洗。规则逐条来自契约 §2.2 与 00 号 §6.11③：
 * ①去掉逗号 —— `deriveTags()` 按逗号拆 `tags: [a,b]`，含逗号必被拆成两个标签（静默漂移），
 * 因此**含逗号的标签整条丢弃**并回 `IMP-W007`；②去掉换行与 `[` `]`（同样是整条丢弃）；
 * ③每个 ≤ 32 字符；④丢弃纯数字；⑤字符集按 `[\p{L}\p{N}_\-/]` 收紧；⑥去重。
 *
 * **注意**：`src/lib/utils.ts` 的 `normalizeTag()` 是模块私有且**没有任何字符白名单过滤**，
 * 不能声称「已由 normalizeTag() 清洗」——这里做的是客户端写入前的自行过滤。
 */
export function sanitizeTags(input: unknown): { tags: string[]; truncated: boolean; dropped: boolean } {
  if (input === undefined || input === null) return { tags: [], truncated: false, dropped: false };
  if (!Array.isArray(input)) return { tags: [], truncated: false, dropped: false };
  const truncated = input.length > MAX_TAGS;
  const tags: string[] = [];
  let dropped = false;
  for (const raw of input.slice(0, MAX_TAGS)) {
    if (typeof raw !== "string") {
      dropped = true;
      continue;
    }
    let tag = raw.trim().replace(/^#+/, "").trim();
    if (!tag) continue;
    if (/[,\n\r[\]{}"']/.test(tag)) {
      dropped = true;
      continue;
    }
    if (tag.length > MAX_TAG_CHARS) {
      dropped = true;
      continue;
    }
    if (/^\d+$/.test(tag)) {
      dropped = true;
      continue;
    }
    // 字符集收紧：去掉 `[\p{L}\p{N}_\-/]` 之外的字符（空格、标点、emoji…）。
    const tightened = tag.replace(/[^\p{L}\p{N}_\-/]/gu, "");
    if (tightened !== tag) dropped = true;
    tag = tightened;
    if (!tag || /^\d+$/.test(tag) || tag.length > MAX_TAG_CHARS) {
      dropped = true;
      continue;
    }
    if (!tags.includes(tag)) tags.push(tag);
  }
  return { tags, truncated, dropped };
}

/* ============================ 路径（§2.4 / §7.3） ============================ */

function failFolder(detail: Record<string, unknown>): never {
  return fail("IMP-4008", { field: "target.folder", ...detail });
}

/**
 * 落点目录规范化：`assertSafeRelative()`（拒绝绝对路径 / `..` / `\0` / 段内 `:`）→
 * 层级与单段长度上限 → 每段 `sanitizeName()` 清洗。返回 POSIX 相对目录，`""` = 根目录。
 *
 * 落点层**不得信任上一层的结论**：即使 `validateEnvelope` 已经跑过一次，
 * `receive.ts` 拿到的路径仍要再跑一遍（§7.3）。
 */
export function normalizeFolder(input: string | null | undefined): string {
  if (input === null || input === undefined) return "";
  if (typeof input !== "string") failFolder({ reason: "type" });
  const value = input.trim();
  if (!value) return "";
  if (value.includes("\0")) failFolder({ reason: "nul", value });
  if (value.includes("\\")) failFolder({ reason: "backslash", value });
  let safe: string;
  try {
    safe = assertSafeRelative(value);
  } catch (error) {
    return failFolder({ reason: error instanceof Error ? error.message : "unsafe", value });
  }
  const segments = safe.split("/").filter(Boolean);
  if (segments.length > MAX_FOLDER_DEPTH) failFolder({ reason: "depth", value });
  const cleaned: string[] = [];
  for (const segment of segments) {
    // 契约要求「单段 ≤ 80 字」，超长属于违规，不做静默截断（否则会写到用户没预期的地方）。
    if (segment.length > MAX_FOLDER_SEGMENT_CHARS) failFolder({ reason: "segment-length", segment });
    const name = sanitizeName(segment, "文件夹");
    if (!name || name === "." || name === "..") failFolder({ reason: "segment", segment });
    cleaned.push(name);
  }
  return cleaned.join("/");
}

/** `target.notePath` 的安全校验；非法一律 `IMP-4008`。 */
export function normalizeNotePath(input: string | null | undefined): string | null {
  if (input === null || input === undefined) return null;
  const value = String(input).trim();
  if (!value) return null;
  try {
    const safe = assertSafeRelative(value);
    if (!safe || !isMarkdownPath(safe)) throw new Error("不是 Markdown 路径");
    return safe;
  } catch (error) {
    fail("IMP-4008", {
      field: "target.notePath",
      reason: error instanceof Error ? error.message : "unsafe",
      value,
    });
  }
}

/* ============================== 附件（§2.5） ============================== */

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

/** 标准 base64 解码（允许 `+/=`、允许含换行）；失败返回 `null`。 */
export function decodeBase64(input: string): Uint8Array | null {
  const compact = input.replace(/\s+/g, "");
  if (!compact || compact.length % 4 !== 0 || !BASE64.test(compact)) return null;
  try {
    const binary = atob(compact);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

/** 标准 base64 编码（不依赖 Node `Buffer`，浏览器与 Node 同一份实现）。 */
export function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/** `image/svg+xml` 必须净化：拒 `<script`、`on*=` 事件属性、`javascript:`、外部 `href`。 */export function isSafeSvg(bytes: Uint8Array): boolean {
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return false;
  }
  const lower = text.toLowerCase();
  if (lower.includes("<script")) return false;
  if (/\son[a-z]+\s*=/i.test(text)) return false;
  if (lower.includes("javascript:")) return false;
  if (/(?:xlink:)?href\s*=\s*["']?\s*(?:https?:)?\/\//i.test(text)) return false;
  if (lower.includes("<!entity")) return false;
  return true;
}

function validateAssets(raw: unknown): ImportAsset[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) fail("IMP-4012", { field: "assets", reason: "type" });
  if (raw.length > MAX_ASSETS) fail("IMP-4013", { field: "assets", count: raw.length });
  const assets: ImportAsset[] = [];
  let total = 0;
  raw.forEach((item, index) => {
    if (!isRecord(item)) fail("IMP-4012", { field: `assets[${index}]`, reason: "type" });
    const name = typeof item.name === "string" ? item.name.trim() : "";
    if (!name) fail("IMP-4012", { field: `assets[${index}].name`, assetIndex: index });
    const mime = typeof item.mime === "string" ? item.mime.trim().toLowerCase() : "";
    if (!(ASSET_MIME_WHITELIST as readonly string[]).includes(mime)) {
      fail("IMP-4012", { field: `assets[${index}].mime`, assetIndex: index, value: mime });
    }
    const dataBase64 = asOptionalString(item.dataBase64);
    const file = asOptionalString(item.file);
    if (!dataBase64 && !file) fail("IMP-4012", { field: `assets[${index}]`, assetIndex: index, reason: "no-payload" });
    let bytes: Uint8Array | null = null;
    if (dataBase64) {
      bytes = decodeBase64(dataBase64);
      if (!bytes) fail("IMP-4012", { field: `assets[${index}].dataBase64`, assetIndex: index, reason: "base64" });
      if (bytes.byteLength > MAX_ASSET_BYTES) {
        fail("IMP-4012", { field: `assets[${index}].dataBase64`, assetIndex: index, reason: "size", bytes: bytes.byteLength });
      }
      total += bytes.byteLength;
      if (total > MAX_ASSETS_TOTAL_BYTES) fail("IMP-4013", { field: "assets", assetIndex: index, reason: "total" });
    } else if (file) {
      try {
        assertSafeRelative(file);
      } catch (error) {
        fail("IMP-4012", {
          field: `assets[${index}].file`,
          assetIndex: index,
          reason: error instanceof Error ? error.message : "unsafe",
        });
      }
    }
    assets.push({ name, mime, dataBase64, file, bytes });
  });
  return assets;
}

/* ============================== 校验器主体 ============================== */

function parseEnvelope(value: unknown): ImportEnvelope {
  if (!isRecord(value)) fail("IMP-4001", { reason: "not-an-object" });
  const raw = value;

  // ① spec —— 唯一允许拒绝请求的版本字段。
  if (raw.spec !== IMPORT_SPEC) fail("IMP-4002", { field: "spec", value: raw.spec });
  const warnings: string[] = [];

  // ② importId：幂等键。
  if (typeof raw.importId !== "string" || raw.importId.length < 8 || raw.importId.length > 128 || !/^[A-Za-z0-9_-]+$/.test(raw.importId)) {
    fail("IMP-4003", { field: "importId" });
  }
  const importId = raw.importId;

  // ③ title：1–200 字符（UTF-16 码元计数），超长截断 + warning，空串失败。
  if (typeof raw.title !== "string" || !raw.title.trim()) fail("IMP-4003", { field: "title" });
  const rawTitle = raw.title;
  const title = truncate(rawTitle, MAX_TITLE_CHARS);
  if (title !== rawTitle) warnings.push(`标题过长，已截断到 ${MAX_TITLE_CHARS} 字符。`);

  // ④ body / bodyFile：二选一；`body: ""` 允许但不得缺字段。
  const bodyFile = typeof raw.bodyFile === "string" && raw.bodyFile.trim() ? raw.bodyFile.trim() : null;
  const hasInlineBody = typeof raw.body === "string";
  if (raw.body === null && !bodyFile) fail("IMP-4003", { field: "body" });
  if (!hasInlineBody && !bodyFile) fail("IMP-4003", { field: "body" });
  if (raw.body !== undefined && raw.body !== null && !hasInlineBody) fail("IMP-4003", { field: "body" });
  const body = hasInlineBody ? (raw.body as string) : "";
  if (bodyFile) {
    try {
      assertSafeRelative(bodyFile);
    } catch (error) {
      fail("IMP-4003", {
        field: "bodyFile",
        reason: error instanceof Error ? error.message : "unsafe",
      });
    }
  }
  if (hasInlineBody) {
    if (utf8Bytes(body) > MAX_BODY_BYTES) fail("IMP-4004", { field: "body", bytes: utf8Bytes(body) });
    if (!body) warnings.push(warningText("IMP-W001"));
  }

  // ⑤ source：`capturedAt` 必填且必须含时区。
  if (!isRecord(raw.source)) fail("IMP-4003", { field: "source" });
  const source = raw.source;
  const capturedAt = typeof source.capturedAt === "string" ? source.capturedAt.trim() : "";
  if (!capturedAt || !isTimestampWithTimezone(capturedAt)) {
    fail("IMP-4003", { field: "source.capturedAt", value: capturedAt || null });
  }
  let url: string | null = null;
  if (source.url !== undefined && source.url !== null) {
    if (typeof source.url !== "string") fail("IMP-4003", { field: "source.url" });
    const candidate = source.url.trim();
    if (candidate) {
      if (!/^https?:\/\//i.test(candidate)) fail("IMP-4003", { field: "source.url", value: candidate });
      url = candidate;
    }
  }
  let publishedAt: string | null = null;
  const rawPublished = asOptionalString(source.publishedAt);
  if (rawPublished) {
    if (isParseableTimestamp(rawPublished)) publishedAt = rawPublished;
    else warnings.push(warningText("IMP-W006"));
  }
  const sourceValue: ImportEnvelopeSource = {
    url,
    title: asOptionalString(source.title) ? truncate(asOptionalString(source.title) as string, MAX_SOURCE_TITLE_CHARS) : null,
    site: asOptionalString(source.site) ? truncate(asOptionalString(source.site) as string, MAX_SOURCE_FIELD_CHARS) : null,
    author: asOptionalString(source.author) ? truncate(asOptionalString(source.author) as string, MAX_SOURCE_FIELD_CHARS) : null,
    publishedAt,
    capturedAt,
    selection: source.selection === true,
  };

  // ⑥ target：目录逐段清洗 + `assertSafeRelative()`；`notePath` 仅 append/overwrite 有效。
  let folder: string | null = null;
  let notePath: string | null = null;
  if (raw.target !== undefined && raw.target !== null) {
    if (!isRecord(raw.target)) fail("IMP-4008", { field: "target", reason: "type" });
    const rawFolder = asOptionalString(raw.target.folder);
    folder = normalizeFolder(rawFolder) || null;
    notePath = normalizeNotePath(asOptionalString(raw.target.notePath));
  }

  // ⑦ conflict：枚举，缺省 `new`。
  let conflict: ImportConflict = "new";
  if (raw.conflict !== undefined && raw.conflict !== null) {
    if (typeof raw.conflict !== "string" || !(IMPORT_CONFLICTS as readonly string[]).includes(raw.conflict)) {
      fail("IMP-4003", { field: "conflict", value: raw.conflict });
    }
    conflict = raw.conflict as ImportConflict;
  }
  if (notePath && conflict !== "append" && conflict !== "overwrite") {
    warnings.push("conflict 不是 append/overwrite，target.notePath 已忽略。");
    notePath = null;
  }

  // ⑧ tags：≤32 截断 + 逐条过滤（`IMP-W007`）。
  const tagResult = sanitizeTags(raw.tags);
  if (tagResult.dropped) warnings.push(warningText("IMP-W007"));
  if (tagResult.truncated) warnings.push(`标签超过 ${MAX_TAGS} 个，已截断。`);

  // ⑨ assets：MIME 白名单、base64、单件与合计上限。
  const assets = validateAssets(raw.assets);

  // ⑩ client：未知值归一到 `other`（不报错，向后兼容），只用于日志与 UI 展示。
  let clientName: ImportClientName = "manual";
  let clientVersion = "";
  if (isRecord(raw.client)) {
    const name = typeof raw.client.name === "string" ? raw.client.name : "";
    clientName = (IMPORT_CLIENT_NAMES as readonly string[]).includes(name) ? (name as ImportClientName) : "other";
    clientVersion = typeof raw.client.version === "string" ? raw.client.version : "";
  }

  return {
    spec: IMPORT_SPEC,
    importId,
    title,
    body: normalizeBodyInline(body),
    bodyFile,
    source: sourceValue,
    target: { folder, notePath },
    conflict,
    conflictExplicit: raw.conflict !== undefined && raw.conflict !== null,
    tags: tagResult.tags,
    assets,
    client: { name: clientName, version: clientVersion },
    warnings,
  };
}

/** 内联正文的 EOL 归一（契约 §3.5：全部归一为 `\n`）。 */
function normalizeBodyInline(body: string): string {
  return normalizeEol(body);
}

/**
 * 外置正文（`bodyFile`，通道级扩展）读完盘后的补校：与内联形态**同一套规则**
 * （8 MiB 上限、`body: ""` 回 `IMP-W001`）。契约要求同一信封用 `body` 与 `bodyFile`
 * 提交时产出**逐字节相同**的文件，所以归一化也必须走这里。
 */
export function checkResolvedBody(body: string, detail: Record<string, unknown> = {}): { body: string; warnings: string[] } {
  const normalized = normalizeEol(body);
  if (utf8Bytes(normalized) > MAX_BODY_BYTES) {
    throw new ImportRejection(importProblem("IMP-4004", { field: "bodyFile", bytes: utf8Bytes(normalized), ...detail }));
  }
  return { body: normalized, warnings: normalized ? [] : [warningText("IMP-W001")] };
}

/** 详细校验结果：既给 `receiveEnvelope()` 用来抛 `ImportRejection`，也给 `validateEnvelope()`。 */
export function validateImportEnvelope(value: unknown): { ok: true; envelope: ImportEnvelope } | { ok: false; problem: ImportProblem } {
  try {
    return { ok: true, envelope: parseEnvelope(value) };
  } catch (error) {
    if (isImportRejection(error)) return { ok: false, problem: { ...error.toResponse().error } };
    throw error;
  }
}

/**
 * 冻结的跨模块接口（task-2）：纯函数校验器。
 * 失败时 `errorCode` 是 `IMP-xxxx`，`message` 是 §6.2 的**中文用户文案**。
 */
export function validateEnvelope(value: unknown): EnvelopeValidation {
  const result = validateImportEnvelope(value);
  if (result.ok) return { ok: true, envelope: result.envelope };
  return { ok: false, errorCode: result.problem.code, message: result.problem.userMessage };
}

/**
 * 信封的 JSON 安全形态（正文内联、附件统一为 `dataBase64`）。
 * 收件箱队列存的就是它：`enqueueInbox(envelopeJson, meta)` 拿到的 `envelopeJson`
 * 必须能在**另一个进程/另一次启动**里被读回来，所以不能带 `Uint8Array`。
 */
export function serializeEnvelope(envelope: ImportEnvelope): Record<string, unknown> {
  return {
    spec: IMPORT_SPEC,
    importId: envelope.importId,
    title: envelope.title,
    body: envelope.body,
    source: {
      url: envelope.source.url,
      title: envelope.source.title,
      site: envelope.source.site,
      author: envelope.source.author,
      publishedAt: envelope.source.publishedAt,
      capturedAt: envelope.source.capturedAt,
      selection: envelope.source.selection,
    },
    target: { folder: envelope.target.folder, notePath: envelope.target.notePath },
    conflict: envelope.conflict,
    tags: [...envelope.tags],
    assets: envelope.assets.map((asset) => ({
      name: asset.name,
      mime: asset.mime,
      ...(asset.dataBase64
        ? { dataBase64: asset.dataBase64 }
        : asset.bytes
          ? { dataBase64: encodeBase64(asset.bytes) }
          : {}),
    })),
    client: { name: envelope.client.name, version: envelope.client.version },
  };
}

export function serializeEnvelopeJson(envelope: ImportEnvelope): string {
  return JSON.stringify(serializeEnvelope(envelope));
}
