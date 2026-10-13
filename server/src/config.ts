/**
 * 服务端配置：**环境变量解析与校验，缺失即启动失败**
 * （`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.1、§8.1）。
 *
 * ## 为什么「缺失即启动失败」而不是「给个默认值」
 *
 * 这个服务是**唯一公网入口**，后面挂着所有人的笔记。一个悄悄取默认值的
 * `COUCH_PASSWORD`、一个猜出来的 `EXTERNAL_BASE_URL`，后果不是「功能不可用」而是
 * 「数据写进了错的库」或「凭据是空的」。所以凡是**没有安全默认值**的项一律
 * 抛错并列出全部缺失项（一次说清，不要让人跑十遍）。
 *
 * ## 入口相关三项刻意不绑定任何厂商（§1.3）
 *
 * | 配置 | 默认 | 为什么 |
 * | --- | --- | --- |
 * | `SSE_HEARTBEAT_MS` | `25000` | **必须 < 边缘读超时**。CF 是 125s，但换隧道就变 —— 所以是配置项，不写死 |
 * | `TRUSTED_PROXY_HEADERS` | **空** | 默认**谁都不信**。头可伪造，只用于日志与粗粒度限流，**不用于鉴权决策** |
 * | `EXTERNAL_BASE_URL` | （必填） | 只有一个 hostname（§2.4）：`/` PWA、`/v1/*` 客户端、`/panel` 控制台，全部同源 |
 *
 * ## 这里**没有**的东西（都是刻意的）
 *
 * - **没有 `SESSION_SECRET`**：本版没有会话签名（`authToken` 本身就是凭据，§8.1）。
 * - **没有任何口令相关配置**：密钥即身份，没有口令体系（§1.5）。
 * - **没有 `@noble/*` 相关配置**：服务端不做加解密（红线 3、§4.9）。
 */

import { PROTOCOL_VERSION } from "../../shared/contract";

export interface ServerConfig {
  /** HTTP 监听端口（compose 里是 8787）。 */
  port: number;
  /** 对外基址（不含尾部斜杠）。用于拼 PWA 链接与 CORS 自检。 */
  externalBaseUrl: string;
  /** 启动自检：与 `shared/contract.ts` 不一致就**拒绝启动**（§8.1）。 */
  protocolVersionExpected: number;

  /** CouchDB 地址与**运行时专用账号**（不是 admin，§4.4 纪律 4）。 */
  couchUrl: string;
  couchUser: string;
  couchPassword: string;
  /** 仅用于建库 / 改 `_design` 的 admin 凭据（§4.5）。 */
  couchAdminUser: string;
  couchAdminPassword: string;

  /** SQLite 控制面数据库的落点（永不放笔记字节，§4.1）。 */
  sqlitePath: string;

  /** 单文件上限（字节）。受边缘 30s 写超时约束（U18）。 */
  maxFileBytes: number;
  /** 每账号配额。 */
  defaultAccountQuotaBytes: number;
  defaultAccountQuotaNotebooks: number;

  /** SSE 心跳（毫秒）。**换入口要重新核算这个值**（§1.3）。 */
  sseHeartbeatMs: number;
  /** 信任的代理头（**默认空 = 谁都不信**）。 */
  trustedProxyHeaders: string[];

  /** 每账号请求速率（req/min）；不按 socket IP（隧道下都是边缘地址，§4.11）。 */
  accountRequestsPerMinute: number;
  /** 每账号 SSE 连接数上限。 */
  accountSseConnections: number;
  /** 全局限流（req/min per IP）：**防 DoS，不是防爆破**（密钥无法爆破）。 */
  globalRequestsPerMinute: number;

  /** 日志级别。 */
  logLevel: "debug" | "info" | "warn" | "error";
}

/** 配置有问题：**启动阶段**抛它，附带全部缺失/非法项。 */
export class ConfigError extends Error {
  constructor(readonly problems: string[]) {
    super(`服务端配置有问题，拒绝启动：\n  - ${problems.join("\n  - ")}`);
    this.name = "ConfigError";
  }
}

type Env = Record<string, string | undefined>;

const DEFAULTS = {
  PORT: "8787",
  PROTOCOL_VERSION_EXPECTED: String(PROTOCOL_VERSION),
  SQLITE_PATH: "./data/control.db",
  MAX_FILE_BYTES: "33554432",
  DEFAULT_ACCOUNT_QUOTA_BYTES: "2147483648",
  DEFAULT_ACCOUNT_QUOTA_NOTEBOOKS: "100",
  SSE_HEARTBEAT_MS: "25000",
  TRUSTED_PROXY_HEADERS: "",
  ACCOUNT_REQUESTS_PER_MINUTE: "120",
  ACCOUNT_SSE_CONNECTIONS: "4",
  GLOBAL_REQUESTS_PER_MINUTE: "600",
  LOG_LEVEL: "info",
} as const;

/** 必填项（没有安全默认值，缺了就停）。 */
const REQUIRED = ["EXTERNAL_BASE_URL", "COUCH_URL", "COUCH_USER", "COUCH_PASSWORD", "COUCH_ADMIN_USER", "COUCH_ADMIN_PASSWORD"] as const;

function readPositiveInt(env: Env, key: string, fallback: string, problems: string[]): number {
  const raw = env[key]?.trim() || fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value <= 0) {
    problems.push(`${key} 必须是正整数，实得 ${JSON.stringify(raw)}`);
    return Number.parseInt(fallback, 10);
  }
  return value;
}

function readRequired(env: Env, key: string, problems: string[]): string {
  const value = env[key]?.trim();
  if (!value) {
    problems.push(`${key} 必填（没有安全默认值）`);
    return "";
  }
  return value;
}

/**
 * 解析配置。`env` 显式传入（而不是直接读 `process.env`）—— 这样用例可以给一个
 * 假环境，而不必去改真实进程的环境变量（改进程环境在并行用例之间会互相污染）。
 */
export function loadConfig(env: Env = process.env): ServerConfig {
  const problems: string[] = [];

  /*
   * ⚠️ 顺序很重要：**必填项必须在 `problems` 检查之前读**。
   *
   * 第一版把 `readRequired(env, "COUCH_USER", [])` 写在最后那个 `return` 里，
   * 而那时 `problems` 已经检查完了 —— 于是「只缺一个必填项」根本不报错，
   * 只是在返回值里悄悄给了一个空串。用例当场抓到（`expected [Function] to throw`）。
   */
  const required = new Map<string, string>();
  for (const key of REQUIRED) required.set(key, readRequired(env, key, problems));

  const externalBaseUrlRaw = required.get("EXTERNAL_BASE_URL") ?? "";
  let externalBaseUrl = "";
  if (externalBaseUrlRaw) {
    try {
      const url = new URL(externalBaseUrlRaw);
      if (url.protocol !== "https:" && url.protocol !== "http:") {
        problems.push(`EXTERNAL_BASE_URL 的协议必须是 http/https，实得 ${url.protocol}`);
      }
      externalBaseUrl = `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
    } catch {
      problems.push(`EXTERNAL_BASE_URL 不是合法 URL：${JSON.stringify(externalBaseUrlRaw)}`);
    }
  }

  const couchUrlRaw = required.get("COUCH_URL") ?? "";
  let couchUrl = "";
  if (couchUrlRaw) {
    if (!/^https?:\/\//.test(couchUrlRaw)) {
      problems.push(`COUCH_URL 必须以 http:// 或 https:// 开头，实得 ${JSON.stringify(couchUrlRaw)}`);
    } else {
      couchUrl = couchUrlRaw.replace(/\/+$/, "");
    }
  }

  const protocolVersionExpected = readPositiveInt(env, "PROTOCOL_VERSION_EXPECTED", DEFAULTS.PROTOCOL_VERSION_EXPECTED, problems);
  /*
   * 启动自检（§8.1）：镜像里写死的期望值与代码里的常量必须一致。
   * 不一致说明「镜像与服务端代码版本错配」——那是单仓构建里唯一还会出现的错配，
   * 所以留一道显式的闸门，而不是让它以奇怪的 400 形式在运行期冒出来。
   */
  if (env.PROTOCOL_VERSION_EXPECTED !== undefined && protocolVersionExpected !== PROTOCOL_VERSION) {
    problems.push(
      `PROTOCOL_VERSION_EXPECTED=${protocolVersionExpected} 与 shared/contract.ts 的 PROTOCOL_VERSION=${PROTOCOL_VERSION} 不一致（镜像与服务端代码版本错配）`,
    );
  }

  const sseHeartbeatMs = readPositiveInt(env, "SSE_HEARTBEAT_MS", DEFAULTS.SSE_HEARTBEAT_MS, problems);
  /*
   * 心跳的硬约束：**必须远小于边缘读超时**（CF 是 125s，§1.3）。
   * 这里只做「不小于 1 秒、不大于 60 秒」的合理性检查 —— 具体上限取决于入口，
   * 换入口时按 §4.8 重新核算，代码里不替运维猜。
   */
  if (sseHeartbeatMs < 1000) problems.push("SSE_HEARTBEAT_MS 小于 1000ms：心跳太密，且没有意义");
  if (sseHeartbeatMs > 60_000) problems.push("SSE_HEARTBEAT_MS 大于 60000ms：多数边缘的读超时都会先杀掉连接");

  // 数值项也全部先读一遍（`readPositiveInt` 会把非法值记进 `problems`）。
  const port = readPositiveInt(env, "PORT", DEFAULTS.PORT, problems);
  const maxFileBytes = readPositiveInt(env, "MAX_FILE_BYTES", DEFAULTS.MAX_FILE_BYTES, problems);
  const defaultAccountQuotaBytes = readPositiveInt(env, "DEFAULT_ACCOUNT_QUOTA_BYTES", DEFAULTS.DEFAULT_ACCOUNT_QUOTA_BYTES, problems);
  const defaultAccountQuotaNotebooks = readPositiveInt(env, "DEFAULT_ACCOUNT_QUOTA_NOTEBOOKS", DEFAULTS.DEFAULT_ACCOUNT_QUOTA_NOTEBOOKS, problems);
  const accountRequestsPerMinute = readPositiveInt(env, "ACCOUNT_REQUESTS_PER_MINUTE", DEFAULTS.ACCOUNT_REQUESTS_PER_MINUTE, problems);
  const accountSseConnections = readPositiveInt(env, "ACCOUNT_SSE_CONNECTIONS", DEFAULTS.ACCOUNT_SSE_CONNECTIONS, problems);
  const globalRequestsPerMinute = readPositiveInt(env, "GLOBAL_REQUESTS_PER_MINUTE", DEFAULTS.GLOBAL_REQUESTS_PER_MINUTE, problems);

  const trustedProxyHeaders = (env.TRUSTED_PROXY_HEADERS ?? DEFAULTS.TRUSTED_PROXY_HEADERS)
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0);

  const logLevelRaw = (env.LOG_LEVEL?.trim() || DEFAULTS.LOG_LEVEL).toLowerCase();
  const logLevels = ["debug", "info", "warn", "error"] as const;
  if (!logLevels.includes(logLevelRaw as (typeof logLevels)[number])) {
    problems.push(`LOG_LEVEL 必须是 ${logLevels.join(" / ")} 之一，实得 ${JSON.stringify(logLevelRaw)}`);
  }

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    externalBaseUrl,
    protocolVersionExpected,
    couchUrl,
    couchUser: required.get("COUCH_USER") ?? "",
    couchPassword: required.get("COUCH_PASSWORD") ?? "",
    couchAdminUser: required.get("COUCH_ADMIN_USER") ?? "",
    couchAdminPassword: required.get("COUCH_ADMIN_PASSWORD") ?? "",
    sqlitePath: env.SQLITE_PATH?.trim() || DEFAULTS.SQLITE_PATH,
    maxFileBytes,
    defaultAccountQuotaBytes,
    defaultAccountQuotaNotebooks,
    sseHeartbeatMs,
    trustedProxyHeaders,
    accountRequestsPerMinute,
    accountSseConnections,
    globalRequestsPerMinute,
    logLevel: logLevelRaw as ServerConfig["logLevel"],
  };
}

/**
 * 取真实客户端 IP。
 *
 * **只从 `TRUSTED_PROXY_HEADERS` 里配的头取**，而它**默认是空的 = 谁都不信**。
 * 头可以伪造，所以结果**只用于日志与粗粒度限流，绝不用于鉴权决策**（U19、§4.11）。
 */
export function clientIpFrom(headers: Headers, config: ServerConfig): string | null {
  for (const name of config.trustedProxyHeaders) {
    const value = headers.get(name);
    if (!value) continue;
    // `x-forwarded-for` 可能是逗号列表：取最后一个（最近一跳）而不是第一个（可伪造）。
    const candidate = value.split(",").map((item) => item.trim()).filter(Boolean).pop();
    if (candidate) return candidate;
  }
  return null;
}

/** 只读快照，用于诊断（**不含任何凭据**）。 */
export function describeConfig(config: ServerConfig): Record<string, string | number | boolean | string[]> {
  return {
    port: config.port,
    externalBaseUrl: config.externalBaseUrl,
    protocolVersionExpected: config.protocolVersionExpected,
    couchUrl: config.couchUrl,
    sqlitePath: config.sqlitePath,
    maxFileBytes: config.maxFileBytes,
    sseHeartbeatMs: config.sseHeartbeatMs,
    trustedProxyHeaders: config.trustedProxyHeaders,
    accountRequestsPerMinute: config.accountRequestsPerMinute,
    globalRequestsPerMinute: config.globalRequestsPerMinute,
    logLevel: config.logLevel,
    // 凭据一律**不回显**，连「配了没配」都不说（避免变成一次探测信号）。
  };
}

/** 必须出现的环境变量名（给 `ConfigError` 的文案与启动脚本用）。 */
export const REQUIRED_ENV_KEYS: readonly string[] = REQUIRED;
