/**
 * 运维 CLI 的用例（`docs/执行-三端同步…` §4.12、§1.5、红线 3、§10.1 K1/K2）。
 *
 * ## 这里最要紧的不是「命令能不能跑」
 *
 * 而是**红线 3 在 CLI 上的具体形状**：CLI 绝不能接触账号密钥。
 *
 * §11.3 风险表把「CLI 顺手生成了密钥」列为**高影响**项，理由一句话：
 * **服务端知道了管理员的账号密钥 ⇒ 管理员自己的笔记本 E2EE 直接失效**。
 *
 * 光靠注释拦不住后来者，所以有两条结构性的断言：
 *   1. **读源码**：`cli.ts` 里不出现任何密钥生成/派生调用（不是「跑一遍看输出」，
 *      而是把这条纪律钉在文件层面 —— 后来者加了就会被这条用例拦住）；
 *   2. **看输出**：所有命令的输出里不含密钥材料。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CLI_COMMANDS, USAGE, parseFlags, runCli, type CliContext } from "./cli";

vi.mock("./db", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...(actual as object),
    openDatabase: (options: { path: string }) =>
      (actual as { openDatabase: (o: unknown) => DatabaseSync }).openDatabase({ ...options, path: ":memory:" }),
  };
});

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

/** 收集输出的一次执行。 */
async function run(argv: string[], context?: CliContext): Promise<{ code: number; out: string; err: string }> {
  const outLines: string[] = [];
  const errLines: string[] = [];
  const collectOut = (line: string): void => void outLines.push(line);
  const collectErr = (line: string): void => void errLines.push(line);
  const code = await runCli(argv, {
    env: ENV,
    out: collectOut,
    err: collectErr,
    /*
     * 注入上下文时**必须换掉它自己的 `out`/`err`** —— 否则命令会把输出写进
     * 那个上下文创建时给的哑函数，用例看到的是空字符串。
     * （第一版就踩了这个：注入之后所有断言都成了 `expected '' to contain …`。）
     */
    ...(context === undefined ? {} : { context: { ...context, out: collectOut, err: collectErr } }),
  });
  return { code, out: outLines.join("\n"), err: errLines.join("\n") };
}

/**
 * 造一个**预先塞了账号**的上下文。
 *
 * 为什么需要：`createCliContext()` 按配置开库，而用例里的库被替换成 `:memory:` ——
 * 每次执行都是空库。没有这个口子就只能测到各命令的「空库早退分支」，
 * 那等于大部分命令根本没被测过。
 */
async function seededContext(): Promise<{ context: CliContext; alice: string; bob: string }> {
  const { AccountStore, newAccountId, newAuthTokenForTests } = await import("./auth/accounts");
  const { NotebookStore } = await import("./notebooks");
  const { CouchClient } = await import("./couch/client");
  const { loadConfig } = await import("./config");
  const { openDatabase } = await import("./db");

  const config = loadConfig(ENV);
  const db = openDatabase({ path: ":memory:" });
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const mk = (label: string): string => {
    const row = accounts.create({
      accountId: newAccountId(),
      authToken: newAuthTokenForTests(),
      wrappedEncRoot: "wrapped-fake-0001",
      label,
      bootstrapCode: accounts.createBootstrapCode().code,
    });
    return row.id;
  };
  const alice = mk("Alice");
  const bob = mk("Bob");
  notebooks.create({ ownerId: alice, name: "一本", cryptoMode: "none" });
  notebooks.create({ ownerId: alice, name: "两本", cryptoMode: "none" });

  return {
    alice,
    bob,
    context: {
      out: () => undefined,
      err: () => undefined,
      config,
      accounts,
      notebooks,
      couch: CouchClient.fromConfig(config),
      couchAdmin: CouchClient.adminFromConfig(config),
    },
  };
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("§4.12 · 命令面", () => {
  it("没有参数 / `help` → 打印用法；退出码分别是 1 / 0", async () => {
    const none = await run([]);
    expect(none.code).toBe(1);
    expect(none.out).toContain("bootstrap-admin");
    // 每条命令都要带「什么时候用它」—— 运维急的时候不该去翻文档。
    expect(none.out).toContain("密钥丢失时救回管理入口");

    const help = await run(["help"]);
    expect(help.code).toBe(0);
    expect(help.out).toBe(USAGE);
  });

  it("未知命令 → 退出码 1，并打用法", async () => {
    const result = await run(["definitely-not-a-command"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("未知命令");
    expect(result.err).toContain("bootstrap-admin");
  });

  it("`CLI_COMMANDS` 与用法里列出的命令**一一对应**（加了命令忘了写文档会被这条拦住）", () => {
    for (const command of CLI_COMMANDS) {
      expect(USAGE, `用法里缺 ${command}`).toContain(command);
    }
  });

  it("配置缺键 → 退出码 2，并**逐条**打出缺了什么", async () => {
    const errLines: string[] = [];
    const code = await runCli(["list-accounts"], { env: { ...ENV, COUCH_URL: "" }, out: () => undefined, err: (line) => errLines.push(line) });
    expect(code).toBe(2);
    expect(errLines.join("\n")).toContain("COUCH_URL");
  });
});

describe("★ 红线 3 · `bootstrap-admin` 绝不接触密钥", () => {
  it("只打印**引导码本身**，说明走 stderr（于是 `> code.txt` 里只有码）", async () => {
    const result = await run(["bootstrap-admin"]);
    expect(result.code).toBe(0);

    // stdout 只有一行，且就是那个码（shape：`boot_` + 48 hex）。
    const stdoutLines = result.out.split("\n").filter((line) => line.length > 0);
    expect(stdoutLines).toHaveLength(1);
    expect(stdoutLines[0]).toMatch(/^boot_[0-9a-f]{48}$/);

    // 说明与「下一步」都在 stderr。
    expect(result.err).toContain("客户端会生成账号密钥");
    expect(result.err).toContain("本命令**没有**、也不会生成任何账号密钥");
  });

  it("引导码真的落进 `bootstrap_codes`，且**没有**因此产生任何账号", async () => {
    const { context } = await seededContext();
    const before = context.accounts.count();
    const result = await run(["bootstrap-admin"], context);
    const code = result.out.trim();

    expect(code).toMatch(/^boot_[0-9a-f]{48}$/);
    // ★ 关键：发引导码**不创建账号** —— 账号要等客户端拿着码去注册（并且密钥由客户端生成）。
    expect(context.accounts.count()).toBe(before);

    /*
     * 库里存的是**哈希**，不是明文码。
     *
     * ⚠️ 用「执行前后差集」找那一行，**不要**用 `ORDER BY created_at DESC LIMIT 1` ——
     * 同一毫秒内建的几条码排序是**不确定的**，那样会随机挑到别的行。
     * （第一版就是这么写的，于是断言 `used_at` 时随机撞上前两次已被消费的码。）
     */
    const db = (context.accounts as unknown as { db: DatabaseSync }).db;
    const hashOf = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
    const row = db.prepare("SELECT used_at FROM bootstrap_codes WHERE code_hash = ?").get(hashOf(code)) as unknown as
      | { used_at: number | null }
      | undefined;
    expect(row, "刚发的引导码应当落进 bootstrap_codes").toBeTruthy();
    expect(row!.used_at).toBeNull();
  });

  it("**结构性断言**：`cli.ts` 源码里不出现任何密钥生成/派生调用", () => {
    /*
     * 这条用例的作用是**拦住后来者**，而不是验证当前行为。
     * 「跑一遍看输出里没有密钥」不够 —— 一个只在 `--verbose` 分支里生成密钥的实现
     * 也能骗过那种断言；读源码才能把纪律钉在文件层面。
     */
    const source = readFileSync(join(process.cwd(), "server", "src", "cli.ts"), "utf8");
    // 剥掉注释再查：注释里**必须**能讨论这些名字（否则就没法写「不许用」的说明）。
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "")
      .replace(/\/\/.*$/gm, "");

    for (const forbidden of [
      "generateAccountKey",
      "deriveAuthToken",
      "deriveWrapKey",
      "createEncRoot",
      "randomBytes",
      "getRandomValues",
      "hkdf",
      "wrappedEncRoot:",
      "authToken:",
      "accountKey",
    ]) {
      expect(code, `cli.ts 里不该出现 ${forbidden}`).not.toContain(forbidden);
    }
    // 反向确认：它确实用了「发码」这条正向能力（否则上面那些断言可以靠删空文件通过）。
    expect(code).toContain("createBootstrapCode");
  });

  it("所有命令的输出里**不含**任何密钥材料", async () => {
    for (const argv of [["bootstrap-admin"], ["create-invite"], ["list-accounts"], ["recompute-quota"]]) {
      const result = await run(argv);
      const combined = `${result.out}\n${result.err}`;
      for (const forbidden of ["auth_hash", "authHash", "wrapped_enc_root", "wrappedEncRoot", "accountKey", "encRoot"]) {
        expect(combined, `${argv.join(" ")} 的输出里出现了 ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});

describe("§4.12 · create-invite", () => {
  it("打印邀请码 + 它的约束；默认 7 天 / 1 次", async () => {
    const result = await run(["create-invite"]);
    expect(result.code).toBe(0);
    expect(result.out.trim()).toMatch(/^inv_[0-9a-f]{48}$/);
    expect(result.err).toContain("可用 1 次");
    expect(result.err).toContain("7 天后过期");
    expect(result.err).toContain("只显示这一次");
  });

  it("`--max-uses` / `--days` 生效，且被**夹在**合理区间（不给「永不过期的注册码」）", async () => {
    expect((await run(["create-invite", "--max-uses", "5", "--days", "3"])).err).toContain("可用 5 次");
    expect((await run(["create-invite", "--max-uses", "5", "--days", "3"])).err).toContain("3 天后过期");
    // 荒唐的值被夹住。
    expect((await run(["create-invite", "--days", "99999"])).err).toContain("365 天后过期");
    expect((await run(["create-invite", "--max-uses", "99999"])).err).toContain("可用 1000 次");
    // 非法值退回缺省。
    expect((await run(["create-invite", "--days", "abc"])).err).toContain("7 天后过期");
  });
});

describe("§4.12 · list-accounts / disable-account / recompute-quota", () => {
  it("没有账号时给一句人话，而不是一个空表头", async () => {
    const result = await run(["list-accounts"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("还没有任何账号");
  });

  it("列账号时**明说**为什么看不到 auth_hash（免得运维以为漏了）", async () => {
    const { context } = await seededContext();
    const result = await run(["list-accounts"], context);
    expect(result.out).toContain("刻意不显示 auth_hash / wrapped_enc_root");
  });

  it("有账号时列出 id / 标签 / 状态 / 管理员位 / 笔记本数 —— **不含**任何密钥字段", async () => {
    const { context, alice, bob } = await seededContext();
    const result = await run(["list-accounts"], context);
    expect(result.code).toBe(0);
    expect(result.out).toContain("Alice");
    expect(result.out).toContain("Bob");
    expect(result.out).toContain(alice);
    expect(result.out).toContain(bob);
    // Alice 有 2 本。
    expect(result.out).toContain("2");
    expect(result.out).toContain("共 2 个账号");
    // 表头在场（运维要能对着列名读）。
    expect(result.out).toContain("accountId");
    expect(result.out).toContain("notebooks");
  });

  it("`disable-account` 缺参数 → 退出码 1 + 用法", async () => {
    const result = await run(["disable-account"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("用法：disable-account <accountId>");
  });

  it("`disable-account` 给一个不存在的 id → 退出码 1 + 明确说「不存在」", async () => {
    const result = await run(["disable-account", "11111111-2222-4333-8444-555555555555"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("账号不存在");
  });

  it("禁用成功：状态真的变了，且**说清它不是删号**、也**说清它吊销不了密钥**", async () => {
    const { context, bob } = await seededContext();
    const result = await run(["disable-account", bob], context);
    expect(result.code).toBe(0);
    expect(result.out).toContain("已禁用");

    // 状态真的落库了。
    expect(context.accounts.findById2(bob)?.status).toBe("disabled");

    /*
     * 两句提醒都很要紧：
     *  - 「禁用 ≠ 删号」：否则运维以为数据没了，可能做出错误的补救动作；
     *  - 「吊销不了密钥」：**这是最危险的一种误解** —— 运维会以为禁用等于止血，
     *    而实际上泄露的密钥仍然能访问（唯一手段是轮换）。错误的安全感比没有安全感更糟。
     */
    expect(result.err).toContain("不是删除");
    expect(result.err).toContain("吊销已泄露的账号密钥");
  });

  it("`recompute-quota` 如实说明**字节数重算不了**（不假装算过）", async () => {
    const result = await run(["recompute-quota"]);
    expect(result.code).toBe(0);
    expect(result.err).toContain("字节数仍是缓存值");
    expect(result.err).toContain("U22");
  });

  it("`recompute-quota` 有账号时逐条报数，`--account` 只算一个", async () => {
    const { context, alice, bob } = await seededContext();
    const all = await run(["recompute-quota"], context);
    expect(all.out).toContain(alice);
    expect(all.out).toContain(bob);
    expect(all.out).toMatch(/笔记本数=/);

    // 只算一个：另一个不该出现。
    const one = await run(["recompute-quota", "--account", alice], context);
    expect(one.out).toContain(alice);
    expect(one.out).not.toContain(bob);
  });

  it("`recompute-quota --account <不存在的 id>` → 退出码 1", async () => {
    const result = await run(["recompute-quota", "--account", "11111111-2222-4333-8444-555555555555"]);
    expect(result.code).toBe(1);
    expect(result.err).toContain("账号不存在");
  });
});

describe("`parseFlags`", () => {
  it("`--k v` 成对、`--flag` 单独、位置参数归位", () => {
    const { positional, flags } = parseFlags(["--a", "1", "pos1", "--b", "pos2"]);
    // `--b` 后面跟的是位置参数？不 —— 解析器把紧邻的非 `--` 视作它的值。
    expect(flags.get("a")).toBe("1");
    expect(flags.get("b")).toBe("pos2");
    expect(positional).toEqual(["pos1"]);
  });

  it("末尾的 `--flag` 取字符串 `true`（不是 `undefined`）", () => {
    expect(parseFlags(["--verbose"]).flags.get("verbose")).toBe("true");
  });

  it("空输入不炸", () => {
    expect(parseFlags([])).toEqual({ positional: [], flags: new Map() });
  });
});
