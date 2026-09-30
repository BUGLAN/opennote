import type { ImportErrorBody, ImportResult } from "../desktop/bridge";

/* ============================================================================
   Opennote 剪藏页 —— 契约层
   这里只放纯函数：不碰 DOM、不发请求、不设计时器。boot 数据怎么读、响应怎么判、
   失败时对人说什么，全部集中在这一处，判据才好盯住"用户看得见的那条路径"
   （真正解析出来的 stageId、真正发出去的 folder、真正显示出来的那句话）。
   ========================================================================= */

/** 每个请求都必须有超时：这是一次性页面，没有超时的等待态就是永久白屏。 */
export const STAGE_TIMEOUT_MS = 8000;
export const FOLDERS_TIMEOUT_MS = 8000;
/** 提交要落盘，给得宽一些；它同样有上限，不会无限等。 */
export const COMMIT_TIMEOUT_MS = 20000;

/** 中文界面里的固定说法：一次性页面，不再拼更花的句子。 */
const RETRY_HINT = "请回到 Opennote 剪藏扩展的弹窗重新发起剪藏。";

/** 成功或失败的两种结果：失败一定带一句能读给人听的话。 */
export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

type Json = Record<string, unknown>;

/* ------------------------------------------------------------------ boot -- */

/** 桥注入的 `<script type="application/json" id="clip-boot">` 内容。 */
export interface ClipBoot {
  port: number;
  stageId: string;
  k: string;
}

/**
 * 读桥注入的 boot 数据。缺了、坏了都要给出能照做的一句话，绝不静默。
 * 注意这里**不读 DOM**：调用方把 `#clip-boot` 的文本取出来传进来即可，
 * 于是"stageId 到底是从输入读出来的还是写死的"可以被判据直接盯住。
 */
export function parseBoot(text: string | null): Parsed<ClipBoot> {
  if (text === null || text.trim() === "") {
    return { ok: false, message: `页面里没有找到这次剪藏的启动信息（clip-boot），无法知道该读哪一条暂存。${RETRY_HINT}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: `页面里的启动信息不是合法的 JSON，无法知道该读哪一条暂存。${RETRY_HINT}` };
  }

  if (!isRecord(parsed)) {
    return { ok: false, message: `页面里的启动信息不是一个 JSON 对象，无法知道该读哪一条暂存。${RETRY_HINT}` };
  }

  const stageId = asText(parsed.stageId);
  const k = asText(parsed.k);
  const port = asPort(parsed.port);
  if (stageId === null || k === null || port === null) {
    const missing = [stageId === null ? "stageId" : null, k === null ? "k" : null, port === null ? "port" : null];
    return {
      ok: false,
      message: `页面里的启动信息缺少 ${missing.filter(Boolean).join(" / ")}，无法读取这次暂存。${RETRY_HINT}`,
    };
  }

  return { ok: true, value: { port, stageId, k } };
}

/**
 * boot 里的端口必须与页面自己的端口一致：不一致说明页面和接口不是同一个服务，
 * 这时**一个请求也不发**（宁可不做事，也不把内容提交到错误的地方）。
 * 端口 80 / 443 在 `location.port` 里是空串，那种情况不算冲突。
 */
export function checkBootPort(boot: ClipBoot, locationPort: string): string | null {
  if (locationPort === "" || locationPort === String(boot.port)) return null;
  return `页面地址的端口（${locationPort}）与这次剪藏的端口（${boot.port}）不一致，为避免把内容提交到别的服务，页面已停止操作。${RETRY_HINT}`;
}

/* ----------------------------------------------------------------- stage -- */

export interface ClipStageSource {
  site: string | null;
  author: string | null;
  publishedAt: string | null;
}

/** `GET /v1/clip/stage` 的暂存内容（页面真正会用到的部分）。 */
export interface ClipStage {
  url: string;
  title: string;
  body: string;
  /**
   * 这次剪藏的正文**是不是来自文本选区**（00 §6.15㉝ / 02 §2.3）。
   * 它是**布尔**，不是选中的那段文字 —— 正文只有 `body` 一个来源；
   * 把 selection 当字符串用就是"一个字段两个含义"（A2 曾经犯过，已改）。
   */
  selection: boolean;
  tags: string[];
  source: ClipStageSource;
  /** 只有数量：页面不重写资源地址（那会是第二个产地），也不去下载附件（那是扩展侧的开关）。 */
  assetCount: number;
  capturedAt: string | null;
  expiresAt: number | null;
}

export function parseStagePayload(status: number, text: string): Parsed<ClipStage> {
  const envelope = readEnvelope(status, text, "读取这次剪藏");
  if (!envelope.ok) return envelope;

  const stage = envelope.value.stage;
  if (!isRecord(stage)) {
    return { ok: false, message: "读取这次剪藏失败：接口响应里的 stage 不是一个对象（这条暂存可能已经过期）。" };
  }

  const sourceRecord: Json = isRecord(stage.source) ? stage.source : {};
  return {
    ok: true,
    value: {
      url: asText(stage.url) ?? "",
      title: typeof stage.title === "string" ? stage.title : "",
      body: typeof stage.body === "string" ? stage.body : "",
      // 契约把 selection 钉成布尔（桥的 smoke 有 `typeof === "boolean"`）。不是布尔就按 false，
      // 只影响顶部那一行"正文来源"的显示，绝不参与正文的取舍。
      selection: typeof stage.selection === "boolean" ? stage.selection : false,
      tags: stringList(stage.tags),
      source: {
        // `source` 契约上是对象；真有桥只给一个字符串时，把它当站点名用，不丢信息。
        site: asText(sourceRecord.site) ?? asText(stage.source),
        author: asText(sourceRecord.author),
        publishedAt: asText(sourceRecord.publishedAt),
      },
      assetCount: Array.isArray(stage.assets) ? stage.assets.length : 0,
      capturedAt: asText(stage.capturedAt),
      expiresAt: asNumber(envelope.value.expiresAt),
    },
  };
}

/* --------------------------------------------------------------- folders -- */

/**
 * `GET /v1/clip/folders` 的目录列表。原样返回（只去重、只留字符串），
 * **不在这一层补 "收件箱"**：收件箱永远可选是页面的事实，由视图层保证一个产地。
 */
export function parseFoldersPayload(status: number, text: string): Parsed<string[]> {
  const envelope = readEnvelope(status, text, "读取目录列表");
  if (!envelope.ok) return envelope;

  const folders = envelope.value.folders;
  if (!Array.isArray(folders)) {
    return { ok: false, message: "读取目录列表失败：接口响应里没有 folders 数组（无法知道有哪些落点）。" };
  }
  return { ok: true, value: [...new Set(stringList(folders))] };
}

/* ---------------------------------------------------------------- commit -- */

/**
 * 回执是桥的 `ImportResult` 的投影：只挑页面真正显示的那几个字段，
 * 字段名与类型直接取自桥的类型（不在这里另写一份形状）。
 */
export type ClipReceipt = Pick<
  ImportResult,
  "status" | "importId" | "path" | "inboxId" | "deduped" | "warnings" | "tags" | "assets"
>;

const RECEIPT_STATUSES = ["created", "appended", "deduped", "duplicate", "pending", "skipped"] as const;

export function parseCommitPayload(status: number, text: string): Parsed<ClipReceipt> {
  const envelope = readEnvelope(status, text, "入库");
  if (!envelope.ok) return envelope;

  // 契约说回执与 ImportResult 同形状。这里同时容忍两种封装：
  // `{ ok:true, result:{...} }`（与桥的 ImportOutcome 一致）与平铺的 `{ ok:true, ...回执 }`。
  const record = isRecord(envelope.value.result) ? envelope.value.result : envelope.value;
  const receiptStatus = RECEIPT_STATUSES.find((name) => name === record.status);
  if (receiptStatus === undefined) {
    return {
      ok: false,
      message: `入库请求被接口接受了，但回执里的 status（${String(record.status)}）不在契约的六种之内，页面无法如实显示结果。请到 Opennote 的收件箱里确认这次剪藏。`,
    };
  }

  return {
    ok: true,
    value: {
      status: receiptStatus,
      importId: asText(record.importId) ?? "",
      path: asText(record.path),
      inboxId: asText(record.inboxId),
      deduped: record.deduped === true,
      warnings: stringList(record.warnings),
      tags: stringList(record.tags),
      assets: stringList(record.assets),
    },
  };
}

/* ------------------------------------------------------------------ 失败 -- */

/** 网络层（连不上 / 超时）失败的说法。`timeoutMs` 要如实写进句子里。 */
export function describeNetworkFailure(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  const detail = error instanceof Error ? error.message : String(error);
  if (name === "TimeoutError" || name === "AbortError") {
    return `请求超时：等了 ${formatSeconds(timeoutMs)} 也没有等到本地接口的回应。可以重试；如果一直超时，请确认 Opennote 正在运行。`;
  }
  if (name === "TypeError") {
    return "连不上本地接口：请求被拒绝或者连接中断。请确认 Opennote 正在运行、本地接口已经打开，然后重试。";
  }
  return `请求失败（${name || "未知错误"}）${detail ? `：${detail}` : ""}。可以重试。`;
}

/* ------------------------------------------------------------------ 内部 -- */

function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asText(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asPort(value: unknown): number | null {
  const port = asNumber(value);
  return port !== null && Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function formatSeconds(ms: number): string {
  return `${Math.round(ms / 100) / 10} 秒`;
}

/**
 * 一次响应分两段判：
 * - HTTP 层：**2xx 都算成功**。桥的 `respondWithReceipt` 成功的状态码不是只有一个：
 *   `deduped`/`skipped` → 200、建了新笔记 → 201、收件箱那条待处理路径 → 202
 *   （`electron/bridge.cjs:1346` `typeof value.status === "number" ? value.status : …`）。
 *   只认 200 会把"其实成功了"显示成失败 —— A2 第一版就是这么写的，已改。
 * - 业务层：2xx 也必须是 `ok === true`；失败时优先用桥给的 userMessage。
 * 非 2xx 一律算失败，**即使 body 里写着 ok:true**（那说明这一层的话不可信）。
 */
function readEnvelope(status: number, text: string, what: string): Parsed<Json> {
  let parsed: unknown;
  let parsedOk = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = null;
    parsedOk = false;
  }

  const httpOk = status >= 200 && status < 300;
  if (!httpOk) {
    const error = parsedOk && isRecord(parsed) ? parsed.error : null;
    return { ok: false, message: describeErrorBody(error, status, what) };
  }
  if (!parsedOk || !isRecord(parsed)) {
    return { ok: false, message: `${what}失败：接口返回的不是 JSON 对象，页面读不懂这次的响应。` };
  }
  if (parsed.ok !== true) {
    return { ok: false, message: describeErrorBody(parsed.error, status, what) };
  }
  return { ok: true, value: parsed };
}

function describeErrorBody(error: unknown, status: number, what: string): string {
  if (isRecord(error)) {
    const body = error as Partial<ImportErrorBody>;
    const userMessage = asText(body.userMessage);
    const code = asText(body.code);
    if (userMessage) return code ? `${userMessage}（${code}）` : userMessage;
    if (code) return `${what}失败：本地接口拒绝了这次请求（${code}，HTTP ${status}）。`;
  }
  return `${what}失败：本地接口返回 HTTP ${status}，没有给出可读的原因。`;
}
