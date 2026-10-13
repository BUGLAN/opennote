/**
 * 运维 CLI（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.12）。
 *
 * ## 它是「根信任」的**唯一**运维通道
 *
 * 控制台在管理员密钥丢失时**进不去**（密钥即身份：没有密钥就没有账号）。
 * 所以必须有一条不走 HTTP、不需要任何已有凭据的通道 —— 那就是这个文件。
 *
 * ## ★ 红线 3 在这里的具体形状：**CLI 绝不接触密钥**
 *
 * 文档 §1.5、§4.12、§11.3 反复强调同一件事（§11.3 风险表里把它列为「高」影响项）：
 *
 * > CLI 如果顺手生成了管理员的账号密钥，服务端就知道了它 ⇒ 管理员自己的笔记本 E2EE 直接失效。
 *
 * 所以这个文件里**没有、也不许有**：
 *   - `accountKey` / `authToken` / `encRoot` / `wrappedEncRoot` 的**生成**
 *   - 写这些字段（除了 `list-accounts` 的**只读**用途，而它连读都不读它们）
 *
 * 它只做一件事：**发一个一次性引导码**，然后由**客户端**去生成密钥并注册。
 * 这条纪律有一条用例钉住（`cli.test.ts`：断言 CLI 源码里不出现密钥生成调用，
 * 且输出里不含任何密钥材料）—— 光靠注释是拦不住后来者的。
 *
 * ## 输出纪律
 *
 * 引导码 / 邀请码**只在 stdout 出现一次**，**不写日志、不落盘**。
 * 所有诊断信息走 stderr，于是 `... bootstrap-admin > code.txt` 得到的文件里
 * 只有那一个码，不会混进日志行。
 */

import { AccountStore } from "./auth/accounts";
import { loadConfig, ConfigError, type ServerConfig } from "./config";
import { openDatabase } from "./db";
import { CouchClient } from "./couch/client";
import { NotebookStore } from "./notebooks";

/** 命令签名：`argv` 是**去掉 `node script`** 之后的部分（即 `["bootstrap-admin"]`）。 */
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
  "bootstrap-admin",
  "setup-couch-user",
  "create-invite",
  "list-accounts",
  "disable-account",
  "recompute-quota",
] as const;

export type CliCommand = (typeof CLI_COMMANDS)[number];

/** 用法（每条都带一句「什么时候用它」——运维急的时候不该去翻文档）。 */
export const USAGE = `opennote-server 运维 CLI（§4.12）

用法：node dist/cli.js <命令> [参数]

命令：
  bootstrap-admin              发一个**一次性管理员引导码**（★ 唯一能在密钥丢失时救回管理入口的办法）
                               码只在 stdout 出现一次，不写日志、不落盘。**本命令不生成任何密钥。**
  setup-couch-user             在 CouchDB 的 _users 里建/更新运行时专用账号（★ 首次部署必须先跑这个）
                               否则每个笔记本请求都会 401 —— 因为 _security.members 里写的那个
                               「专用账号」在 CouchDB 里根本不是一条配置，而是一条 _users 文档。
  create-invite [--max-uses N] [--days N]
                               应急生成注册邀请码（正常情况用控制台）
  list-accounts                列出账号（id / 标签 / 状态 / 用量）—— **不含任何密钥材料**
  disable-account <accountId>  禁用账号（应急止血）
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
    case "bootstrap-admin":
      return bootstrapAdmin(context);
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
  }
}

/**
 * ★ 核心命令：打印一个一次性管理员引导码。
 *
 * **它不生成任何密钥。** 只写 `bootstrap_codes` 一行（`code_hash` + 过期时间），
 * 明文码只在 stdout 出现这一次。
 *
 * 附带告诉运维**下一步该做什么** —— 这一步很容易漏（拿到码之后不知道往哪填），
 * 而漏掉的后果是「码过期了才发现没用上」。
 */
export function bootstrapAdmin(context: CliContext): number {
  const { code, expiresAt } = context.accounts.createBootstrapCode();
  const minutes = Math.round((expiresAt - Date.now()) / 60000);

  context.out(code);
  // 说明走 **stderr**，于是 `> code.txt` 里只有码本身。
  context.err("");
  context.err("★ 一次性管理员引导码（只显示这一次，不写日志、不落盘）");
  context.err(`  有效期：约 ${minutes} 分钟（${new Date(expiresAt).toISOString()}）`);
  context.err("");
  context.err("下一步（在**客户端**上做，密钥只在那里生成）：");
  context.err(`  1. 打开 ${context.config.externalBaseUrl}`);
  context.err("  2. 选择「创建新账号」，把上面那串码粘进去");
  context.err("  3. 客户端会生成账号密钥并**让你抄下来** —— 那串密钥就是你的账号，丢了就没了");
  context.err("");
  context.err("本命令**没有**、也不会生成任何账号密钥（红线 3 / §1.5）。");
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

/** 应急生成注册邀请码（正常情况用控制台）。 */
export function createInvite(context: CliContext, flags: Map<string, string>): number {
  const maxUses = clampInt(flags.get("max-uses"), 1, 1, 1000);
  const days = clampInt(flags.get("days"), 7, 1, 365);
    /*
   * `createdBy: null` —— **CLI 发码时通常还没有任何账号**（那正是这条命令存在的场景）。
   * 第一版写成 `"cli"` 这个字符串，结果撞上 `created_by REFERENCES accounts(id)`
   * 的外键：一个不存在的账号 id。修法不是「随便找个账号 id 塞进去」，而是承认
   * 「谁发的」这个问题在 CLI 场景下**没有答案**，于是迁移 2 把该列改成可空。
   */
  const created = context.accounts.createInvite({ createdBy: null, expiresInSeconds: days * 86400, maxUses });

  context.out(created.code);
  context.err("");
  context.err(`注册邀请码（可用 ${created.maxUses} 次，${days} 天后过期，只显示这一次）`);
  context.err("客户端用它在「创建新账号」里注册；密钥仍由客户端生成。");
  return 0;
}

/**
 * 列出账号。
 *
 * ⚠️ **只读且只读安全字段** —— 刻意不打印 `auth_hash` / `wrapped_enc_root`。
 * 打印它们没有任何运维价值（服务端自己也解不开 `wrapped_enc_root`），
 * 却会让一次「随手 `list-accounts > 工单附件`」变成一次凭据泄露。
 */
export function listAccounts(context: CliContext): number {
  const rows = context.accounts.list();
  if (rows.length === 0) {
    context.out("（还没有任何账号）");
    return 0;
  }
  context.out(["accountId", "label", "status", "admin", "notebooks", "createdAt"].join("\t"));
  for (const row of rows) {
    const quota = context.notebooks.quotaOf(row.id);
    context.out(
      [
        row.id,
        row.label ?? "-",
        row.status,
        row.is_admin === 1 ? "yes" : "no",
        String(quota.notebooks),
        new Date(row.created_at).toISOString(),
      ].join("\t"),
    );
  }
  context.out("");
  context.out(`共 ${rows.length} 个账号。（刻意不显示 auth_hash / wrapped_enc_root —— 它们没有运维价值，只会带来泄露风险）`);
  return 0;
}

/** 禁用账号（应急止血）。 */
export function disableAccount(context: CliContext, accountId: string | undefined): number {
  if (!accountId) {
    context.err("用法：disable-account <accountId>");
    return 1;
  }
  const target = context.accounts.findById2(accountId);
  if (!target) {
    context.err(`账号不存在：${accountId}`);
    return 1;
  }
  context.accounts.setStatus(accountId, "disabled");
  context.out(`已禁用 ${accountId}`);
  // 说清「禁用 ≠ 删号」：数据保留，可以再启用；也是提醒运维别以为数据没了。
  context.err("注意：这是**禁用**（数据保留、可用 enable 恢复），不是删除。");
  context.err("它**不能**吊销已泄露的账号密钥 —— 唯一的吊销手段是让该账号轮换密钥。");
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
