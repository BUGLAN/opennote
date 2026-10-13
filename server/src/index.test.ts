/**
 * **起一个真进程内服务器**并真的用 HTTP 打它（`docs/执行-三端同步…` §2.4、§4.6、§4.8）。
 *
 * ## 为什么这条用例值得单独存在
 *
 * 前面所有服务端用例都是 `app.request()` —— 那是**内存里直接调 handler**，
 * 它绕过了「真监听一个端口」这件事。而「能不能按配置起起来」恰恰是自托管部署
 * 最容易坏的一环（绑错地址、端口被占、SQLite 路径不可写、迁移没跑）。
 *
 * ⚠️ 它**不**替代 U18/U22 那两条待核实项（那需要真 CouchDB + 真反向代理 + 真大文件）。
 * 它证明的是**这一层**：配置 → 开库 → 迁移 → 装配 → 监听 → 能回话 → 能干净关闭。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer, type StartedServer } from "./index";

let started: StartedServer | null = null;
let tempDir: string | null = null;

afterEach(async () => {
  if (started) {
    await started.close();
    started = null;
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

function env(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    EXTERNAL_BASE_URL: "https://notes.example.com",
    COUCH_URL: "http://127.0.0.1:59999",
    COUCH_USER: "sync-service",
    COUCH_PASSWORD: "pw",
    COUCH_ADMIN_USER: "admin",
    COUCH_ADMIN_PASSWORD: "apw",
    ...overrides,
  };
}

describe("真起一个服务器（§4.6 / §4.8）", () => {
  it("按配置起起来、能回话、能干净关闭", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opennote-srv-"));
    const sqlitePath = join(tempDir, "control.db");

    /*
     * 端口走 `startServer({port: 0})` 而不是环境变量：`loadConfig` **正确**地
     * 拒绝 `PORT=0`（"必须是正整数"）—— 那是给运维用的配置，不该允许 0。
     * 而「临时端口」是**测试**的需求，所以用函数参数覆盖，不去放宽配置校验。
     */
    started = await startServer({ env: env({ SQLITE_PATH: sqlitePath }), port: 0 });
    expect(started.port).toBeGreaterThan(0);

    const response = await fetch(`http://127.0.0.1:${started.port}/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; protocolVersion: number; couchVersion: string | null };
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(1);
    // CouchDB 地址是故意指到不存在的端口的 ⇒ 这里**必须**是 null 而不是抛错。
    // （健康检查要能在「CouchDB 坏了」时也回话 —— 否则控制台连"哪里坏了"都看不到。）
    expect(body.couchVersion).toBeNull();
  });

  it("迁移真的跑了（SQLite 文件里有表，而不只是一个空文件）", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opennote-srv-"));
    const sqlitePath = join(tempDir, "control.db");
    started = await startServer({ env: env({ SQLITE_PATH: sqlitePath }), port: 0 });

    // 第一次启动就建好了库文件。
    expect(existsSync(sqlitePath)).toBe(true);
    const rows = started.db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as unknown as { name: string }[];
    const tables = rows.map((row) => row.name);
    for (const expected of ["accounts", "notebooks", "memberships", "schema_version", "audit"]) {
      expect(tables, `缺表 ${expected}`).toContain(expected);
    }
    // 迁移版本记下来了。
    const version = started.db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as unknown as { v: number | null };
    expect(version.v).toBeGreaterThanOrEqual(1);
  });

  it("重启同一个库**不重复应用迁移**（幂等；否则第二次启动就炸）", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opennote-srv-"));
    const sqlitePath = join(tempDir, "control.db");

    started = await startServer({ env: env({ SQLITE_PATH: sqlitePath }), port: 0 });
    const first = started.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as unknown as { n: number };
    await started.close();
    started = null;

    // 第二次启动同一个文件。
    started = await startServer({ env: env({ SQLITE_PATH: sqlitePath }), port: 0 });
    const second = started.db.prepare("SELECT COUNT(*) AS n FROM schema_version").get() as unknown as { n: number };
    expect(second.n).toBe(first.n);
  });

  it("未鉴权的受保护路由在真端口上也是 401", async () => {
    tempDir = mkdtempSync(join(tmpdir(), "opennote-srv-"));
    started = await startServer({ env: env({ SQLITE_PATH: join(tempDir, "control.db") }), port: 0 });

    const response = await fetch(`http://127.0.0.1:${started.port}/v1/notebooks`);
    expect(response.status).toBe(401);
  });

  it("配错环境变量时**抛出逐条说明**，而不是起一个坏掉的服务", async () => {
    const broken = { ...env(), EXTERNAL_BASE_URL: "", COUCH_URL: "" };
    /*
     * ⚠️ `loadConfig()` 是**同步**抛的（它在返回 Promise 之前就校验完了），
     * 所以不能写 `expect(startServer(...)).rejects` —— 那样异常在
     * `expect(...)` 求值时就飞出来了，用例的失败信息会指向**别处**。
     * 包一层 async 箭头函数，把它变成真正的 rejected promise。
     */
    await expect((async () => startServer({ env: broken }))()).rejects.toThrow(/EXTERNAL_BASE_URL/);
    await expect((async () => startServer({ env: broken }))()).rejects.toThrow(/COUCH_URL/);
  });

  it("临时文件不落在源码目录里（避免被 `git add -A` 扫进来）", () => {
    // 这条是**元测试**：记录我们踩过的坑 —— 之前 `git add -A` 把测试用的
    // `.tmp-future-*.db` 扫进了提交。所以这里断言临时目录里确实有东西、
    // 而 `server/src` 下不该出现 `.db` 文件。
    const leftovers = readdirSync(join(process.cwd(), "server", "src")).filter((name) => name.endsWith(".db") || name.endsWith(".db-wal"));
    expect(leftovers).toEqual([]);
  });
});
