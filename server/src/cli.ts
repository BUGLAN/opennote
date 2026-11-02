/**
 * 运维 CLI（`docs/执行-同步重写-2026-11-02.md`「身份模型」）。
 *
 * ## 它是「根信任」的运维通道
 *
 * 管理员全都忘了密码、控制台进不去时，必须有一条不走 HTTP、不需要任何已有凭据的通道 ——
 * 能登上这台服务器的人就是根信任。
 *
 * ## 密码不经过命令行
 *
 * `create-admin` / `reset-password` **不收密码参数**：命令行参数会进 shell 历史和进程列表。
 * 它们只打印一条一次性的「设置密码」链接（24 小时有效），由本人在浏览器里设密码。
 *
 * ## 输出纪律
 *
 * 链接 / 邀请码**只在 stdout 出现一次**，不写日志、不落盘。诊断信息走 stderr，
 * 于是 `… create-admin a@b.com > link.txt` 得到的文件里只有那一条链接。
 *
 * 服务端仍然没有任何加解密能力（红线 3）：CLI 不碰 `wrapped_enc_root`。
 */

import { AccountError, AccountStore, accountLabel, type AccountRow } from "./auth/accounts";
import { loadConfig, ConfigError, type ServerConfig } from "./config";
import { openDatabase } from "./db";
import { CouchClient } from "./couch/client";
import { NotebookStore } from "./notebooks";

/** 命令签名：`argv` 是**去掉 `node script`** 之后的部分（即 `["create-admin", "a@b.com"]`）。 */
export interface CliContext {
  out: (line: string) => void;
  err: (line: string) => void;
  config: ServerConfig;
  accounts: AccountStore;
  notebooks: NotebookStore;
  couch: CouchClient;
  couchAdmin: CouchClient;
}

export interface CliDeps {
  /** 覆盖环境（测试注入）。 */
  env?: Record<string, string | undefined>;
  out?: (line: string) => void;
  err?: (line: string) => void;
  now?: () => number;
  /**
   * 直接给一个**已经装配好**的上下文，跳过 `createCliContext()`。
   *
   * 为什么需要它：`createCliContext()` 按配置开库，而用例里的库是内存库 ——
   * 于是每次执行都是**全新的空库**，「有账号时的 `list-accounts`」这类用例
   * 根本没法测（只能测到「还没有任何账号」那条早退分支）。
   * 有了这个口子，用例可以先往上下文里塞几个账号再跑命令 ——
   * 那样测到的是**命令本身**，而不是「空库时的样子」。
   */
  context?: CliContext;
}

export const CLI_COMMANDS = [
  "create-admin",
  "reset-password",
  "setup-couch-user",
  "create-invite",
  "list-accounts",
  "disable-account",
  "recompute-quota",
  "grant-admin",
  "revoke-admin",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

/** 用法（每条都带一句「什么时候用它」——运维急的时候不该去翻文档）。 */
export const USAGE = `opennote-server 运维 CLI

用法：node dist/cli.js <命令> [参数]

命令：
  create-admin <邮箱>          建一个管理员账号，打印一次性「设置密码」链接（24 小时有效）
                               正常情况下第一个管理员在网页 /admin 初始化；这个命令用于救急
  reset-password <邮箱|id>     打印一次性「重置密码」链接，并让该账号所有设备下线
  setup-couch-user             在 CouchDB 的 _users 里建/更新运行时专用账号（★ 首次部署必须先跑这个）
                               否则每个笔记本请求都会 401 —— 因为 _security.members 里写的那个
                               「专用账号」在 CouchDB 里根本不是一条配置，而是一条 _users 文档。
  create-invite [--email 邮箱] [--admin] [--max-uses N] [--days N]
                               应急生成邀请链接（正常情况用控制台）
  list-accounts                列出账号（id / 邮箱 / 状态 / 用量）—— 不含密码哈希与令牌
  disable-account <邮箱|id>    停用账号并让它所有设备下线（应急止血）
  grant-admin <邮箱|id>        把一个已有账号提升为管理员
  revoke-admin <邮箱|id>       取消管理员；**不允许取消最后一个活跃管理员**
  recompute-quota [--account <accountId>]
                               从账本重算配额缓存

环境变量（与 server 相同，见 .env.example）：
  EXTERNAL_BASE_URL COUCH_URL COUCH_USER COUCH_PASSWORD COUCH_ADMIN_USER COUCH_ADMIN_PASSWORD
  SQLITE_PATH（默认 ./data/control.db）
`;

/** 解析 `--key value` / `--flag` 形式的参数。 */
export function parseFlags(argv: readonly string[]): { positional: string[]; flags: Map<string, string> } {
  const positional: string[] = [];
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;
    if (token.startsWith("--")) {
      const name = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags.set(name, next);
        index += 1;
      } else {
        flags.set(name, "true");
      }
    } else {
      positional.push(token);
    }
  }
  return { positional, flags };
}

/** 组装 CLI 上下文（测试可注入 env / 输出）。 */
export function createCliContext(deps: CliDeps = {}): CliContext {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const config = loadConfig(env);
  const db = openDatabase({ path: config.sqlitePath });
  return {
    out: deps.out ?? ((line) => process.stdout.write(`${line}\n`)),
    err: deps.err ?? ((line) => process.stderr.write(`${line}\n`)),
    config,
    accounts: new AccountStore(db),
    notebooks: new NotebookStore(db),
    couch: CouchClient.fromConfig(config),
    couchAdmin: CouchClient.adminFromConfig(config),
  };
}

/**
 * 执行一条命令。返回进程退出码（0 = 成功）。
 *
 * 拆成「纯函数 + 返回码」而不是直接 `process.exit()`：这样用例能断言每一条命令的
 * 输出与退出码，而不必起子进程。
 */
export async function runCli(argv: readonly string[], deps: CliDeps = {}): Promise<number> {
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const { positional, flags } = parseFlags(argv);
  const command = positional[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    out(USAGE);
    return command ? 0 : 1;
  }
  if (!(CLI_COMMANDS as readonly string[]).includes(command)) {
    err(`未知命令：${command}`);
    err(USAGE);
    return 1;
  }

  let context: CliContext;
  try {
    context = deps.context ?? createCliContext({ ...deps, out, err });
  } catch (error) {
    if (error instanceof ConfigError) {
      err("配置有问题，未执行：");
      for (const problem of error.problems) err(`  · ${problem}`);
      return 2;
    }
    throw error;
  }

  switch (command as CliCommand) {
    case "create-admin":
      return await createAdmin(context, positional[1]);
    case "reset-password":
      return resetPassword(context, positional[1]);
    case "setup-couch-user":
      return await setupCouchUser(context);
    case "create-invite":
      return createInvite(context, flags);
    case "list-accounts":
      return listAccounts(context);
    case "disable-account":
      return disableAccount(context, positional[1]);
    case "recompute-quota":
      return recomputeQuota(context, flags);
    case "grant-admin":
      return setAdmin(context, positional[1], true);
    case "revoke-admin":
      return setAdmin(context, positional[1], false);
  }
}

/**
 * 提权 / 降权（`grant-admin` / `revoke-admin`）。
 *
 * 控制台里管理员也能做这件事；CLI 这一份是给「没有任何管理员能登录」时用的根信任通道。
 * 不能降掉**最后一个活跃管理员**（`AccountStore.setAdmin` 守），提权/降权都写审计。
 */
export function setAdmin(context: CliContext, who: string | undefined, isAdmin: boolean): number {
  if (!who) {
    context.err(`用法：${isAdmin ? "grant-admin" : "revoke-admin"} <邮箱|accountId>`);
    return 1;
  }
  const target = findAccount(context, who);
  if (!target) return 1;
  const accountId = target.id;
  const result = context.accounts.setAdmin(accountId, isAdmin);
  if (!result.ok) {
    if (result.reason === "last-admin") {
      context.err("拒绝：这是最后一个**活跃**管理员。");
      context.err("降掉它会让控制台永久进不去。要换人，请先 grant-admin 另一个账号，再 revoke-admin 这个。");
      return 1;
    }
    context.err(`账号不存在：${who}`);
    return 1;
  }
  if (!result.changed) {
    context.out(`${accountLabel(target)} 的管理员身份已经是「${isAdmin ? "是" : "否"}」，未改动。`);
    return 0;
  }
  context.notebooks.audit({
    actorId: null,
    action: isAdmin ? "cli_grant_admin" : "cli_revoke_admin",
    target: accountId,
    ip: null,
    detail: "via CLI",
  });
  context.out(`${isAdmin ? "已提升为管理员" : "已取消管理员"}：${accountLabel(target)}`);
  context.err("");
  context.err(isAdmin ? "这个账号现在可以登录 /admin 控制台了。" : "这个账号下一次请求起就没有管理员权限（无需重新登录）。");
  return 0;
}

/** 邮箱或 accountId → 账号；找不到时把原因写到 stderr 并返回 null。 */
function findAccount(context: CliContext, who: string): AccountRow | null {
  const row = who.includes("@") ? context.accounts.findByEmail(who) : context.accounts.findById(who);
  if (!row) {
    context.err(`账号不存在：${who}`);
    context.err("先用 list-accounts 看看有哪些账号。");
  }
  return row;
}

/**
 * 建管理员（救急用；正常情况第一个管理员在 `/admin` 初始化）。
 *
 * 账号建出来**没有密码**，stdout 打印一次性「设置密码」链接 —— 密码由本人在浏览器里设，
 * 不经过命令行。
 */
export async function createAdmin(context: CliContext, email: string | undefined): Promise<number> {
  if (!email) {
    context.err("用法：create-admin <邮箱>");
    return 1;
  }
  let row: AccountRow;
  try {
    row = await context.accounts.create({ email, isAdmin: true });
  } catch (error) {
    if (error instanceof AccountError) {
      context.err(`没建成：${error.message}`);
      if (error.rejection === "email-taken") context.err("这个邮箱已有账号：要让它成为管理员用 grant-admin，要重设密码用 reset-password。");
      return 1;
    }
    throw error;
  }
  context.notebooks.audit({ actorId: null, action: "cli_create_admin", target: row.id, ip: null, detail: "via CLI" });
  return printPasswordLink(context, row, "设置密码");
}

/** 打印一次性「重置密码」链接，并让这个账号所有设备下线。 */
export function resetPassword(context: CliContext, who: string | undefined): number {
  if (!who) {
    context.err("用法：reset-password <邮箱|accountId>");
    return 1;
  }
  const row = findAccount(context, who);
  if (!row) return 1;
  const revoked = context.accounts.revokeAllSessions(row.id);
  context.notebooks.audit({ actorId: null, action: "cli_reset_password", target: row.id, ip: null, detail: `revokedSessions=${revoked}` });
  return printPasswordLink(context, row, "重置密码");
}

function printPasswordLink(context: CliContext, row: AccountRow, what: string): number {
  const { code, expiresAt } = context.accounts.createPasswordReset({ accountId: row.id, createdBy: null });
  context.out(`${context.config.externalBaseUrl}/reset/${code}`);
  // 说明走 stderr，于是 `> link.txt` 里只有链接本身。
  context.err("");
  context.err(`★ ${accountLabel(row)} 的一次性「${what}」链接（只显示这一次，不写日志、不落盘）`);
  context.err(`  有效期至 ${new Date(expiresAt).toISOString()}，用过即失效。`);
  context.err("  在浏览器里打开它设好密码，然后用客户端或 /admin 登录。");
  return 0;
}

/**
 * ★ 首次部署**必须先跑**这一步：在 CouchDB 的 `_users` 里建运行时专用账号。
 *
 * ## 为什么它不是「锦上添花」
 *
 * 置备时我们写 `_security.members.names = [COUCH_USER]`（§7.3 第 2 条：运行时用专用账号、
 * **不是 admin**）。但 CouchDB 里「专用账号」**不是一条配置**，而是 `_users` 库里的一条文档。
 *
 * 少了这一步，栈**能起来**、`/v1/health` 也正常，但**每个笔记本请求都 401** ——
 * 而 401 看起来像「服务端配置错了」，会让人去查错方向。
 * 这是我在真 CouchDB 3.3.3 上跑出来的：单独验 `_security` 用 admin 打一切正常，
 * 换成 `sync-service` 就 401，因为它根本不存在。
 *
 * 幂等：重复跑只更新口令。
 */
export async function setupCouchUser(context: CliContext): Promise<number> {
  const name = context.config.couchUser;
  if (!name) {
    context.err("COUCH_USER 没配，无法建专用账号。");
    return 2;
  }
  if (name === context.config.couchAdminUser) {
    /*
     * 如果这两个配成同一个，那「运行时用专用账号」这条纪律就白写了：
     * 服务端等于拿着 admin 凭据在跑，一次漏洞就能删库、改 `_design`（§7.3 第 2 条）。
     * 这里**拒绝**而不是警告 —— 警告会被忽略，而配置错误的代价是整个租户隔离失效。
     */
    context.err("COUCH_USER 与 COUCH_ADMIN_USER 不能是同一个账号：");
    context.err("  运行时用 admin 会让「一条漏洞 = 能删库、能改 _design」重新成立（§7.3 第 2 条）。");
    return 2;
  }

  try {
    // 先确认 `_users` 在（CouchDB 首次启动后它可能还不存在）。
    if (!(await context.couchAdmin.databaseExists("_users"))) {
      await context.couchAdmin.createDatabase("_users");
      context.err("已创建 `_users` 库。");
    }
    const { created } = await context.couchAdmin.ensureUser(name, context.config.couchPassword);
    context.out(created ? `已创建 CouchDB 专用账号：${name}` : `已更新 CouchDB 专用账号的口令：${name}`);
    context.err("");
    context.err("它是**普通用户**（roles 为空），不是 admin —— 于是它只能访问");
    context.err("`_security.members` 里列了它的那些笔记本库（§7.3 第 2 条）。");
    context.err("口令来自环境变量 COUCH_PASSWORD，**不会**被打印。");
    return 0;
  } catch (error) {
    context.err(`建专用账号失败：${String(error)}`);
    context.err("检查 COUCH_URL / COUCH_ADMIN_USER / COUCH_ADMIN_PASSWORD，以及 CouchDB 是否已起来。");
    return 1;
  }
}

/** 应急生成邀请链接（正常情况用控制台）。 */
export function createInvite(context: CliContext, flags: Map<string, string>): number {
  const maxUses = clampInt(flags.get("max-uses"), 1, 1, 1000);
  const days = clampInt(flags.get("days"), 7, 1, 365);
  // `createdBy: null` —— CLI 发码时可能还没有任何账号（迁移 2 因此把该列改成可空）。
  let created: { code: string; maxUses: number };
  try {
    created = context.accounts.createInvite({
      createdBy: null,
      email: flags.get("email") ?? null,
      grantAdmin: flags.get("admin") === "true",
      expiresInSeconds: days * 86400,
      maxUses,
    });
  } catch (error) {
    if (error instanceof AccountError) {
      context.err(`没建成：${error.message}`);
      return 1;
    }
    throw error;
  }
  context.out(`${context.config.externalBaseUrl}/join/${created.code}`);
  context.err("");
  context.err(`邀请链接（可用 ${created.maxUses} 次，${days} 天后过期，只显示这一次）`);
  context.err("对方在浏览器里打开它设好密码，再用客户端登录。");
  return 0;
}

/**
 * 列出账号。
 *
 * ⚠️ **只读且只读安全字段** —— 刻意不打印 `password_hash` 与会话令牌。
 * 打印它们没有任何运维价值，
 * 却会让一次「随手 `list-accounts > 工单附件`」变成一次凭据泄露。
 */
export function listAccounts(context: CliContext): number {
  const rows = context.accounts.list();
  if (rows.length === 0) {
    context.out("（还没有任何账号）");
    return 0;
  }
  context.out(["accountId", "email", "name", "status", "admin", "notebooks", "createdAt"].join("\t"));
  for (const row of rows) {
    const quota = context.notebooks.quotaOf(row.id);
    context.out(
      [
        row.id,
        row.email ?? "-",
        row.display_name ?? "-",
        row.status,
        row.is_admin === 1 ? "yes" : "no",
        String(quota.notebooks),
        new Date(row.created_at).toISOString(),
      ].join("\t"),
    );
  }
  context.out("");
  context.out(`共 ${rows.length} 个账号。（不显示密码哈希与会话令牌 —— 它们没有运维价值，只会带来泄露风险）`);
  return 0;
}

/** 停用账号（应急止血）：所有设备立刻下线，数据保留。 */
export function disableAccount(context: CliContext, who: string | undefined): number {
  if (!who) {
    context.err("用法：disable-account <邮箱|accountId>");
    return 1;
  }
  const target = findAccount(context, who);
  if (!target) return 1;
  context.accounts.setStatus(target.id, "disabled");
  context.notebooks.audit({ actorId: null, action: "cli_disable_account", target: target.id, ip: null, detail: "via CLI" });
  context.out(`已停用 ${accountLabel(target)}（${target.id}）`);
  // 说清「停用 ≠ 删号」：数据保留，可以在控制台重新启用。
  context.err("这是**停用**：它所有设备已经下线，数据保留，可以在控制台重新启用。");
  return 0;
}

/**
 * 从账本重算配额缓存。
 *
 * 「本地就能算准的那一半」（笔记本数）重算；**字节数这一半重算不了** ——
 * 那要逐库问 CouchDB（`_all_docs` 的 sizes），在 1000 个库的规模上会把 CouchDB 打满（U22）。
 * 所以这里如实说明字节数是缓存值，不假装算过。
 */
export function recomputeQuota(context: CliContext, flags: Map<string, string>): number {
  const only = flags.get("account");
  const rows = only ? context.accounts.list().filter((row) => row.id === only) : context.accounts.list();
  if (only && rows.length === 0) {
    context.err(`账号不存在：${only}`);
    return 1;
  }
  for (const row of rows) {
    const count = context.notebooks.recomputeNotebookCount(row.id);
    context.out(`${row.id}\t笔记本数=${count}`);
  }
  context.err("");
  context.err("已重算**笔记本数**。字节数仍是缓存值 —— 重算它需要对每个库跑一次 `_all_docs`，");
  context.err("在 1000 个库的规模上会把 CouchDB 打满（文档 §10 的 U22 专门核实这件事）。");
  return 0;
}

/** 把 `--flag` 的字符串夹进 [min, max]，缺省用 fallback。 */
function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = raw === undefined ? Number.NaN : Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/** 直接执行（`node dist/cli.js …` / `tsx server/src/cli.ts …`）。 */
const isMain = (() => {
  const entry = process.argv[1] ?? "";
  return /cli\.(ts|js|mjs|cjs)$/.test(entry);
})();

if (isMain) {
  /*
   * `.env` 只在**直接执行**时读；被 `import` 时不碰进程环境
   * （否则用例会被宿主机上的 `.env` 影响 —— 那是很难查的一类「本地过、CI 不过」）。
   * `process.loadEnvFile` 是 Node 20.12+ 的 API；不存在时静默跳过。
   */
  try {
    process.loadEnvFile?.(".env");
  } catch {
    // 没有 .env 是正常的（生产是 compose 注入环境变量）。
  }
  void runCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error("[opennote-cli] 执行失败", error);
      process.exit(1);
    },
  );
}
