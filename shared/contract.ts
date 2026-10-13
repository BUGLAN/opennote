/**
 * 线上契约：`/v1/*` 的类型 + **运行期校验**（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.6、§4.7、§11.3 C）。
 *
 * ## 为什么契约只有一处定义
 *
 * 单仓的直接好处（§1.6）：**`server/` 与 `src/` import 同一个文件**，没有契约包、没有版本钉死、
 * 没有跨仓漂移。所以这里的每一个类型都同时是「服务端要产出的」与「客户端要消费的」。
 *
 * ## 为什么用 zod（§11.3 C 已拍板：要）
 *
 * **服务端永远不要相信线上来的东西**。zod 一份定义两用：产出 TS 类型 + 运行期校验，
 * 不会像手写校验器那样与类型各自漂移。客户端也用同一份 schema 校验服务端响应
 * （自己写错的响应同样要能发现）。
 *
 * ## `PROTOCOL_VERSION` 是运行期闸门，不是装饰
 *
 * `/v1/health` 与每库的 `syncinfo` 都带它；客户端**不匹配就拒绝同步并提示升级**。
 * 它防的**不是**「两仓版本错配」（单仓没有这个问题），而是**用户机器上装着旧客户端**
 * （§11.3 第 2 条纪律）。
 *
 * ## 刻意留白
 *
 * **没有「找回密钥」的端点，也不该有**（§4.7）。密钥是用户唯一的秘密，服务端从没存过它。
 * 契约里看不到相关 endpoint 是设计，不是遗漏。
 */

import { z } from "zod";

/**
 * 线上协议版本（整数）。**唯一产地**：`/v1/health`、库内 `syncinfo`、客户端固件里的期望值
 * 都必须是这一个（§10.1 F3 会断言三处一致）。
 *
 * 改动纪律：任何**破坏性**的线上形状变更都要 +1，并同时提升客户端的最低可接受版本。
 */
export const PROTOCOL_VERSION = 1;

/** 客户端能接受的最低协议版本；服务端报出更低的版本时拒绝同步并提示升级。 */
export const MIN_SUPPORTED_PROTOCOL_VERSION = 1;

/* --------------------------------------------------------------- 基础形状 */

/** 笔记本的加密模式（§1.4）。`none` = 明文、可共享；`user-key` = E2EE、v1 不可共享。 */
export const cryptoModeSchema = z.enum(["none", "user-key"]);
export type CryptoMode = z.infer<typeof cryptoModeSchema>;

/** 成员角色（§4.3 `memberships.role`）。 */
export const roleSchema = z.enum(["owner", "editor", "viewer"]);
export type Role = z.infer<typeof roleSchema>;

/** 设备平台（§4.3 `devices.platform`）。 */
export const platformSchema = z.enum(["desktop", "android", "web"]);
export type Platform = z.infer<typeof platformSchema>;

/**
 * 文档标识 `did` 的形状。
 *
 * 模式 A = `f:` + base64url；模式 B = `h:` + hex（由客户端的 `idKey` 算出，服务端**验不出**）。
 * 服务端只校验前缀与字符集，**绝不尝试解密**（§3.8 防线 1、红线 3）。
 */
export const DID_PREFIXES = ["f:", "h:"] as const;

export const didSchema = z
  .string()
  .min(3)
  .max(512)
  .refine((value) => DID_PREFIXES.some((prefix) => value.startsWith(prefix)), {
    message: "did 必须以 f: 或 h: 开头",
  })
  .refine((value) => /^[fh]:[A-Za-z0-9_-]+$/.test(value), { message: "did 的字符集不合法" });

/** `accountId`：客户端生成的 32 位十六进制（16B 随机，公开）。 */
export const accountIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "accountId 必须是 32 位小写十六进制");

/** `notebookId`：uuid（对外）。不透明，不可枚举（§3.1）。 */
export const notebookIdSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, "notebookId 必须是 uuid");

/** `deviceId`：客户端生成的 32 位十六进制（与 `src/sync/device.ts` 同一形状）。 */
export const deviceIdSchema = z.string().regex(/^[0-9a-f]{32}$/, "deviceId 必须是 32 位小写十六进制");

/**
 * 检查点游标：**不透明字符串**，不是数字（§4.7 设计点 4）。
 *
 * CouchDB 2.0 起 update sequence 可以是任意 JSON，所以契约按字符串设计，
 * 客户端**不许**解析它、比较它、或假设它单调可加。
 */
export const cursorSchema = z.string().min(1).max(1024);

/** `sha256(...)` 或 `ehash` 的十六进制形态。 */
export const contentIdSchema = z.string().regex(/^[0-9a-f]{64}$/, "内容标识必须是 64 位小写十六进制");

/* ------------------------------------------------------------------ 账号 */

/**
 * 注册请求（§1.5 流程 ①）。
 *
 * **客户端生成一切密钥材料**，这里只上传「公开的 `accountId`」「派生出的 `authToken`」
 * 「用 `wrapKey` 包好的 `encRoot`」。服务端**永远拿不到** `accountKey` / `wrapKey` / `encRoot`。
 *
 * ⚠️ `wrappedEncRoot` 是密文（服务端解不开），所以这里不做形状之外的语义校验。
 */
export const accountCreateRequestSchema = z.object({
  accountId: accountIdSchema,
  authToken: z.string().min(32).max(256),
  wrappedEncRoot: z.string().min(16).max(4096),
  /** 一次性管理员引导码（CLI 生成）—— 与邀请码二选一，**必须有其一**。 */
  bootstrapCode: z.string().min(8).max(256).optional(),
  /** 注册邀请码（管理员在控制台生成）。 */
  inviteCode: z.string().min(8).max(256).optional(),
  /** 可选备注名（纯装饰，不参与鉴权、不唯一）。 */
  label: z.string().max(120).optional(),
});
export type AccountCreateRequest = z.infer<typeof accountCreateRequestSchema>;

export const quotaSchema = z.object({
  bytesUsed: z.number().int().nonnegative(),
  bytesLimit: z.number().int().nonnegative(),
  notebooks: z.number().int().nonnegative(),
  notebooksLimit: z.number().int().nonnegative(),
});
export type Quota = z.infer<typeof quotaSchema>;

export const accountCreateResponseSchema = z.object({
  accountId: accountIdSchema,
  isAdmin: z.boolean(),
  protocolVersion: z.number().int().positive(),
});
export type AccountCreateResponse = z.infer<typeof accountCreateResponseSchema>;

/** 解锁响应（§1.5 流程 ②）：新设备用 `accountKey` 换回 `wrappedEncRoot` 自己解。 */
export const accountUnlockResponseSchema = z.object({
  accountId: accountIdSchema,
  wrappedEncRoot: z.string().min(16).max(4096),
  quota: quotaSchema,
  protocolVersion: z.number().int().positive(),
});
export type AccountUnlockResponse = z.infer<typeof accountUnlockResponseSchema>;

/** 轮换（§1.5 流程 ③）：**零重加密** —— `encRoot` 不变，只换包着它的壳。 */
export const accountRotateRequestSchema = z.object({
  newAuthToken: z.string().min(32).max(256),
  newWrappedEncRoot: z.string().min(16).max(4096),
});
export type AccountRotateRequest = z.infer<typeof accountRotateRequestSchema>;

export const accountInfoSchema = z.object({
  accountId: accountIdSchema,
  isAdmin: z.boolean(),
  label: z.string().nullable(),
  quota: quotaSchema,
});
export type AccountInfo = z.infer<typeof accountInfoSchema>;

/* ------------------------------------------------------------------ 设备 */

/** 设备登记（§4.3：`devices` **不是凭据**，只是账本）。 */
export const deviceRegisterRequestSchema = z.object({
  deviceId: deviceIdSchema,
  name: z.string().max(120).optional(),
  platform: platformSchema,
});
export type DeviceRegisterRequest = z.infer<typeof deviceRegisterRequestSchema>;

export const deviceInfoSchema = z.object({
  deviceId: deviceIdSchema,
  name: z.string().nullable(),
  platform: platformSchema.nullable(),
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
});
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;

/* ---------------------------------------------------------------- 笔记本 */

export const notebookSummarySchema = z.object({
  notebookId: notebookIdSchema,
  name: z.string().min(1).max(200),
  role: roleSchema,
  cryptoMode: cryptoModeSchema,
  protocolVersion: z.number().int().positive(),
  createdAt: z.number().int().nonnegative(),
});
export type NotebookSummary = z.infer<typeof notebookSummarySchema>;

export const notebookCreateRequestSchema = z.object({
  name: z.string().min(1).max(200),
  /**
   * 默认 `none`（§11.3 A 已拍板）：P2 先跑通明文同步，P4 上线 E2EE 时把默认值改成 `user-key`。
   * **已建的明文笔记本不会自动变密文**（那需要客户端做一次加密迁移，v1 不做）。
   */
  cryptoMode: cryptoModeSchema.default("none"),
});
export type NotebookCreateRequest = z.infer<typeof notebookCreateRequestSchema>;

export const notebookInviteCreateRequestSchema = z.object({
  role: roleSchema.exclude(["owner"]),
  expiresInSeconds: z.number().int().positive().max(60 * 60 * 24 * 365).optional(),
  maxUses: z.number().int().positive().max(1000).optional(),
});
export type NotebookInviteCreateRequest = z.infer<typeof notebookInviteCreateRequestSchema>;

/** 加入笔记本（§1.5：共享不需要用户名，owner 发一次性邀请码）。 */
export const notebookJoinRequestSchema = z.object({ code: z.string().min(8).max(256) });
export type NotebookJoinRequest = z.infer<typeof notebookJoinRequestSchema>;

export const notebookJoinResponseSchema = z.object({
  notebookId: notebookIdSchema,
  role: roleSchema,
  cryptoMode: cryptoModeSchema,
});
export type NotebookJoinResponse = z.infer<typeof notebookJoinResponseSchema>;

export const inviteCreatedResponseSchema = z.object({
  code: z.string().min(8).max(256),
  expiresAt: z.number().int().nonnegative().nullable(),
  maxUses: z.number().int().positive(),
});
export type InviteCreatedResponse = z.infer<typeof inviteCreatedResponseSchema>;

/* ------------------------------------------------------------ 同步数据面 */

/**
 * 列树的一条（**紧凑投影，不含正文**，§4.7）。
 *
 * `hash` 与 `ehash` 至少有一个：明文模式给 `hash`，E2EE 只给 `ehash`
 * （`ehash` 必须是 HMAC，否则服务端能判断「两篇内容是否相同」，§3.9 第 2 条）。
 */
export const treeEntrySchema = z
  .object({
    did: didSchema,
    hash: contentIdSchema.optional(),
    ehash: contentIdSchema.optional(),
    size: z.number().int().nonnegative().optional(),
    esize: z.number().int().nonnegative().optional(),
    rev: z.string().min(1).max(256),
    deleted: z.boolean().optional(),
  })
  .refine((entry) => Boolean(entry.hash) || Boolean(entry.ehash), {
    message: "tree 条目必须带 hash 或 ehash",
  });
export type TreeEntry = z.infer<typeof treeEntrySchema>;

/**
 * `GET /v1/tree` 的响应。
 *
 * ⚠️ **`truncated` 是「禁止推断删除」的开关**（§6.4 规则 1、§4.7 设计点 6）：
 * 为真时只做新增与更新，**全部删除一律挂起待确认**。少取一页就被当成「远端删了」
 * 是这套设计里最严重的误删来源。
 */
export const treeResponseSchema = z.object({
  cursor: cursorSchema.nullable(),
  truncated: z.boolean(),
  files: z.array(treeEntrySchema),
});
export type TreeResponse = z.infer<typeof treeResponseSchema>;

export const changeOpSchema = z.enum(["add", "update", "delete"]);
export type ChangeOp = z.infer<typeof changeOpSchema>;

/**
 * `GET /v1/changes` 的响应。
 *
 * `resync: true` = 游标过期（日志已经回溯不到），客户端退化成全树比对
 * —— 这是 Joplin 的 `resyncRequired` 语义（§6.4 规则 2）。
 */
export const changesResponseSchema = z.object({
  cursor: cursorSchema.nullable(),
  resync: z.boolean().optional(),
  changes: z.array(z.object({ did: didSchema, op: changeOpSchema })),
});
export type ChangesResponse = z.infer<typeof changesResponseSchema>;

/** `POST /v1/account/rotate` 之后旧 `authToken` **立即失效** —— 客户端要能给明确文案（§1.5 代价 2）。 */
export const authErrorSchema = z.object({
  error: z.string(),
  /** `rotated` = 「此设备的密钥已被轮换，请导入新密钥」（与含糊的「登录失效」区分开）。 */
  code: z.enum(["unauthorized", "rotated", "disabled", "not-found", "conflict", "quota", "bad-request", "too-many"]),
});
export type AuthError = z.infer<typeof authErrorSchema>;

/* ------------------------------------------------------- 健康检查 / 闸门 */

/**
 * `/v1/health`（公开，无需鉴权）。
 *
 * `webBuildHash` 是**构建时注入的 PWA 产物哈希**：网页端信任的是「服务端当天发给它的那份 JS」，
 * 这是浏览器端 E2EE 的固有边界（§5.6⑤）。报出哈希让在意的人能核对「今天这份 JS 是不是我本地那份」。
 */
export const healthResponseSchema = z.object({
  ok: z.literal(true),
  protocolVersion: z.number().int().positive(),
  /** 服务端能接受的**最低**客户端协议版本（低于它就拒绝同步）。 */
  minSupportedProtocolVersion: z.number().int().positive(),
  webBuildHash: z.string().nullable(),
  couchVersion: z.string().nullable(),
});
export type HealthResponse = z.infer<typeof healthResponseSchema>;

/**
 * 每库的 `syncinfo` 文档（§3.2）。
 *
 * `protocolVersion` / `cryptoMode` **不匹配就拒绝同步**，而不是「尽力而为」（LiveSync 纪律）。
 */
export const syncInfoSchema = z.object({
  protocolVersion: z.number().int().positive(),
  cryptoMode: cryptoModeSchema,
  createdAt: z.string().min(1),
});
export type SyncInfo = z.infer<typeof syncInfoSchema>;

/* ------------------------------------------------------------ 客户端统计 */

/**
 * `POST /v1/stats`：客户端上报的按天计数（§4.3 `client_stats`）。
 *
 * **服务端看不到冲突内容，只有计数** —— 这与红线 2 一致：Node 不参与裁决，
 * 而且 E2EE 下它也只有密文。
 */
export const clientStatsRequestSchema = z.object({
  notebookId: notebookIdSchema,
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "day 必须是 YYYY-MM-DD"),
  conflicts: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  pushes: z.number().int().nonnegative(),
  pulls: z.number().int().nonnegative(),
  deletes: z.number().int().nonnegative(),
});
export type ClientStatsRequest = z.infer<typeof clientStatsRequestSchema>;

/* -------------------------------------------------------------- 管理接口 */

export const adminAccountSummarySchema = z.object({
  accountId: accountIdSchema,
  label: z.string().nullable(),
  status: z.enum(["active", "disabled"]),
  isAdmin: z.boolean(),
  quota: quotaSchema,
  createdAt: z.number().int().nonnegative(),
  lastSeenAt: z.number().int().nonnegative().nullable(),
});
export type AdminAccountSummary = z.infer<typeof adminAccountSummarySchema>;

export const adminServerInfoSchema = z.object({
  protocolVersion: z.number().int().positive(),
  couchVersion: z.string().nullable(),
  dbCount: z.number().int().nonnegative(),
  totalBytes: z.number().int().nonnegative(),
  accountCount: z.number().int().nonnegative(),
  uptimeSeconds: z.number().nonnegative(),
});
export type AdminServerInfo = z.infer<typeof adminServerInfoSchema>;

/* ---------------------------------------------------------------- 校验器 */

/**
 * 把一个未知值按 schema 解析，失败时抛出**带路径的可读错误**。
 *
 * 服务端与客户端都用它 —— 「永远不要相信线上来的东西」这句话要有统一的落点，
 * 否则每个端点各写一遍 `safeParse` + 拼错误信息，早晚有人忘了处理失败分支。
 */
export function parseContract<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const detail = result.error.issues
    .map((issue) => `${issue.path.length ? issue.path.join(".") : "$"}: ${issue.message}`)
    .join("；");
  throw new ContractError(`${context} 的形状不符合契约：${detail}`);
}

/** 契约校验失败（服务端应映射成 400，客户端应视为「服务端版本不对」）。 */
export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContractError";
  }
}

/**
 * 协议版本闸门：不匹配就抛，**不「尽力而为」**。
 *
 * `expected` 是客户端固件里写死的期望值；`actual` 是服务端 `/v1/health` 或库内 `syncinfo`
 * 报出的值。走另一个方向（客户端比服务端新）也要拦 —— 那是「服务端该升级了」。
 */
export function assertProtocolCompatible(actual: number, expected: number = PROTOCOL_VERSION): void {
  if (actual === expected) return;
  throw new ContractError(
    `协议版本不匹配：服务端是 ${actual}，本客户端是 ${expected}。请升级后重试（拒绝以「尽力而为」的方式同步）。`,
  );
}
