/**
 * 同步功能端到端集成测试（feat/sync 分支）。
 *
 * ## 它测的是什么
 *
 * 现有的 `src/sync/session.test.ts` 用的是**内存 fake provider** —— 各零件各自都对。
 * 这里把**真实零件**拼进同一条链路，验证「各自都对、拼起来也对」：
 *
 * | 零件 | 这里的形态 |
 * | --- | --- |
 * | 服务端 | **真实 HTTP**（`createApp` + `@hono/node-server` 监听 127.0.0.1 随机端口） |
 * | 控制面 | 真实路由 + 内存 SQLite；审计走 NotebookStore 自身 |
 * | 数据面 | `FakeCouch`（内存，进程内）；`OPENNOTE_TEST_REAL_COUCH=1` 时换成**真实 CouchDB 3.3** |
 * | 传输 | 真实 `fetch`（`HttpTransport` 默认发送函数） |
 * | 加密 | 真实 `@noble/*`（XChaCha20-Poly1305 / HKDF / HMAC） |
 * | 文件系统 | **真实磁盘**（`mkdtemp` 临时目录，每台设备一个工作区） |
 * | 客户端会话 | 真实 `createSyncSession` / `OpenNoteProvider` / `createSyncLedger` |
 *
 * ## 账本落盘的边界
 *
 * 现有接线（`attach.ts`）由调用方持有账本、同步后落盘 —— App.tsx 那一侧尚未把
 * 「session → 账本落盘」接上（上层接线在 UI 侧）。所以这里与现有测试同构：
 * **每个用例持有一个账本对象**，`syncNow` 之后显式落盘/重读 —— 断言的是
 * 「`writeSyncLedger` 的产物能被 `readSyncLedger` 读回」（schema/路径约束这一段是真的），
 * 而不虚构「session 自动落盘」这一尚未存在的接线。
 *
 * ## 覆盖的场景
 *
 * 1. 健康检查 / 注册 / 解锁（账号链路，真实 HTTP 契约）；
 * 2. 笔记本创建与置备（行 + 库 + 成员 + `_design`/`_security`/`_revs_limit`）;
 * 3. 明文模式两设备互同步（推 / 拉 / 删除传播 / 增量）；
 * 4. E2EE 模式两设备互同步 + 服务端库里**看不到明文**；
 * 5. 冲突：两边都改 → 只报不猜；
 * 6. 多账号隔离：B 拿不到 A 的任何东西（404 不可区分）；
 * 7. 401 → `key-rotated` 独立状态与指定文案；
 * 8. （真实 CouchDB 模式）置备验收：`_design`/`_security`/`_revs_limit` 真实落在库上；
 * 9. （真实 CouchDB 模式）`/v1/events` SSE：另一设备写入 → 本设备收到 `change` 信号。
 *
 * `FakeCouch` 刻意不实现 `_changes`，所以 SSE 场景只在真实 CouchDB 模式下跑。
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { DatabaseSync } from "node:sqlite";

import { FakeCouch, couchClient } from "../server/src/couch/fakeCouch.test-helper";
import { loadConfig } from "../server/src/config";
import { openDatabase } from "../server/src/db";
import { createApp } from "../server/src/app";
import { runCli } from "../server/src/cli";
import { AccountStore } from "../server/src/auth/accounts";
import { NotebookStore } from "../server/src/notebooks";

import { createSyncLedger, readSyncLedger, writeSyncLedger } from "../src/sync/state";
import { createSyncSession } from "../src/sync/session";
import { createOpenNoteProvider } from "../src/sync/providers/opennote";
import { deriveFromAccountKey, createRegistrationMaterial, encodeAccountKey, decodeAccountKey, deriveNotebookKey, unwrapEncRoot, deriveFromAccountKey as deriveToken } from "../src/sync/accountKey";
import { describeSyncStatus, type SyncStatus } from "../src/sync/runner";
import type { FileSystemBackend } from "../src/fs/types";

/* ============================================================================
   真实 CouchDB 模式（可选）
   ============================================================================ */

const REAL_COUCH = process.env.OPENNOTE_TEST_REAL_COUCH === "1";
const REAL_COUCH_URL = process.env.OPENNOTE_TEST_COUCH_URL ?? "http://127.0.0.1:5984";
/** 与 docker run 的 COUCHDB_USER/COUCHDB_PASSWORD 对齐（可用环境变量覆盖）。 */
const REAL_COUCH_ADMIN_USER = process.env.OPENNOTE_TEST_COUCH_ADMIN_USER ?? "admin";
const REAL_COUCH_ADMIN_PASSWORD = process.env.OPENNOTE_TEST_COUCH_ADMIN_PASSWORD ?? "adminpw";
const REAL_COUCH_SYNC_PASSWORD = process.env.OPENNOTE_TEST_COUCH_SYNC_PASSWORD ?? "sync-pw";

/** 服务端 env：两种模式共用一套形状。 */
function serverEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    EXTERNAL_BASE_URL: "http://127.0.0.1:0",
    COUCH_URL: REAL_COUCH ? REAL_COUCH_URL : "http://couchdb:5984",
    COUCH_USER: "sync-service",
    COUCH_PASSWORD: REAL_COUCH ? REAL_COUCH_SYNC_PASSWORD : "sync-pw",
    COUCH_ADMIN_USER: REAL_COUCH ? REAL_COUCH_ADMIN_USER : "admin",
    COUCH_ADMIN_PASSWORD: REAL_COUCH ? REAL_COUCH_ADMIN_PASSWORD : "admin-pw",
    LOG_LEVEL: "error",
    ...overrides,
  };
}

interface StartedApp {
  baseUrl: string;
  close: () => Promise<void>;
  db: DatabaseSync;
  fake: FakeCouch | null;
}

/** 起一个真实 HTTP 服务：真实路由 + 内存 SQLite + 可选真实 CouchDB。 */
async function startServer(): Promise<StartedApp> {
  const config = loadConfig(serverEnv());
  const db = openDatabase({ path: ":memory:" });
  let fake: FakeCouch | null = null;
  let couch;
  let couchAdmin;
  if (REAL_COUCH) {
    // 真实模式：走配置里的地址与凭据（admin 用于置备，运行时账号由 beforeAll 建立）。
    couch = undefined;
    couchAdmin = undefined;
  } else {
    fake = new FakeCouch();
    const client = couchClient(fake);
    couch = client;
    couchAdmin = client;
  }
  const { app } = createApp({ config, db, ...(couch ? { couch } : {}), ...(couchAdmin ? { couchAdmin } : {}) });
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  const address = await new Promise<{ port: number }>((resolve, reject) => {
    server.on("error", reject);
    // @hono/node-server 的 listen 回调参数挂在不同事件上；统一用 listening 事件。
    server.once("listening", () => resolve(server.address() as { port: number }));
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>((done) => {
        server.close(() => done());
      }),
    db,
    fake,
  };
}

/* ============================================================================
   真实磁盘工作区（每台设备一个临时目录）
   ============================================================================ */

/** 把真实磁盘目录适配成同步要的 `SyncFileBackend`（与 `backendFiles.ts` 同构，直接用 node fs）。 */
function diskBackend(root: string) {
  const encoder = new TextEncoder();
  const fullName = (rel: string): string => join(root, ...rel.split("/"));
  const mkdirp = async (rel: string): Promise<void> => {
    const target = fullName(rel);
    const parent = join(target, "..");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(parent, { recursive: true });
  };
  return {
    root,
    async write(path: string, text: string): Promise<void> {
      await mkdirp(path);
      await (await import("node:fs/promises")).writeFile(fullName(path), encoder.encode(text));
    },
    async read(path: string): Promise<string> {
      const bytes = await readFile(fullName(path));
      return new TextDecoder().decode(bytes);
    },
    async remove(path: string): Promise<void> {
      await rm(fullName(path), { recursive: true, force: true });
    },
    async exists(path: string): Promise<boolean> {
      try {
        await readFile(fullName(path));
        return true;
      } catch {
        return false;
      }
    },
    async list(): Promise<{ path: string; isDir: boolean }[]> {
      const out: { path: string; isDir: boolean }[] = [];
      const walk = async (rel: string): Promise<void> => {
        let entries;
        try {
          entries = await readdir(join(root, rel), { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries) {
          const path = rel === "" ? entry.name : `${rel}/${entry.name}`;
          if (entry.isDirectory()) {
            out.push({ path, isDir: true });
            await walk(path);
          } else {
            out.push({ path, isDir: false });
          }
        }
      };
      await walk("");
      return out;
    },
  };
}

/* ============================================================================
   设备：真实 HTTP provider + 真实磁盘 + 自己的账本
   ============================================================================ */

interface DeviceHandle {
  root: string;
  disk: ReturnType<typeof diskBackend>;
  ledger: ReturnType<typeof createSyncLedger>;
  session: ReturnType<typeof createSyncSession>;
}

interface World {
  base: string;
  db: DatabaseSync;
  /** 假 CouchDB（仅默认模式）；真实模式下为 null，断言走 HTTP 层。 */
  fake: FakeCouch | null;
  /** 服务端的账号存储：**只**用来签发一次性引导码（等价于 CLI 的 `bootstrap-admin`）。 */
  accounts: AccountStore;
  /** 按需建一台设备（临时目录在 afterAll 统一清理）。 */
  device(options: { cryptoMode: "none" | "user-key"; notebookKey?: Uint8Array; authToken: string; notebookId: string; gitignoreText?: string }): Promise<DeviceHandle>;
  cleanup: () => Promise<void>;
}

async function makeWorld(): Promise<World> {
  const started = await startServer();
  const db = started.db;
  const accounts = new AccountStore(db);
  const notebooks = new NotebookStore(db);
  const tempRoots: string[] = [];

  if (REAL_COUCH) {
    // 真实 CouchDB:置备写的 _security.members 里是 COUCH_USER(sync-service),
    // 而「专用账号」是 _users 里的一条文档 —— 不先建它,每个笔记本请求都 401。
    // 这正是 CLI setup-couch-user 存在的理由(§4.12):在测试里走同一条命令。
    const errLines: string[] = [];
    const code = await runCli(["setup-couch-user"], {
      env: serverEnv(),
      out: () => undefined,
      err: (line) => errLines.push(line),
    });
    if (code !== 0) throw new Error(`setup-couch-user 失败(exit ${code}):${errLines.join(" / ")}`);
  }

  const device: World["device"] = async ({ cryptoMode, notebookKey, authToken, notebookId, gitignoreText }) => {
    const root = await mkdtemp(join(tmpdir(), "opennote-sync-e2e-"));
    tempRoots.push(root);
    const ledger = createSyncLedger({
      baseUrl: started.baseUrl,
      notebookId,
      cryptoMode,
      protocolVersion: 1,
    });
    const disk = diskBackend(root);
    const session = createSyncSession({
      config: { enabled: true, baseUrl: started.baseUrl, notebookId, cryptoMode, accountRef: "test" },
      ledger,
      provider: createOpenNoteProvider({
        baseUrl: started.baseUrl,
        notebookId,
        authToken,
        cryptoMode,
        // 快速失败:集成环境里不该有值得退避 500ms 的场景。
        maxRetries: 1,
        baseDelayMs: 10,
      }),
      backend: {
        list: () => disk.list(),
        read: async (path) => {
          const bytes = await readFile(join(root, ...path.split("/")));
          return new Uint8Array(bytes);
        },
        write: async (path, bytes) => {
          const target = join(root, ...path.split("/"));
          const { mkdir, writeFile } = await import("node:fs/promises");
          await mkdir(join(target, ".."), { recursive: true });
          await writeFile(target, bytes);
        },
        remove: async (path) => {
          await rm(join(root, ...path.split("/")), { recursive: true, force: true });
        },
      },
      notebookId,
      ...(notebookKey === undefined ? {} : { notebookKey }),
      ...(gitignoreText === undefined ? {} : { gitignoreText }),
    });
    return { root, disk, ledger, session };
  };

  return {
    base: started.baseUrl,
    db,
    fake: started.fake,
    accounts,
    device,
    async cleanup() {
      await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
      await started.close();
    },
  };
}

/* ============================================================================
   注册（真实 /v1/account 契约）
   ============================================================================ */

interface AccountMaterial {
  accountId: string;
  keyText: string;
  authToken: string;
  wrappedEncRoot: string;
  encRoot: Uint8Array;
}

/** 客户端生成材料 → POST /v1/account（与 onboarding 的默认注册路径同构）。 */
async function registerAccount(base: string, bootstrapCode: string): Promise<AccountMaterial> {
  const material = createRegistrationMaterial();
  const response = await fetch(`${base}/v1/account`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      accountId: material.accountId,
      authToken: material.authToken,
      wrappedEncRoot: material.wrappedEncRoot,
      bootstrapCode,
    }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { accountId: string; isAdmin: boolean };
  expect(body.isAdmin).toBe(true);
  return {
    accountId: body.accountId,
    keyText: encodeAccountKey({ accountId: material.accountId, accountKey: material.accountKey }),
    authToken: material.authToken,
    wrappedEncRoot: material.wrappedEncRoot,
    encRoot: material.encRoot,
  };
}

/** 新设备导入密钥 → POST /v1/account/unlock 换回 wrappedEncRoot → 本地解开。 */
async function unlockOnDevice(base: string, keyText: string): Promise<{ authToken: string; encRoot: Uint8Array }> {
  const parsed = decodeAccountKey(keyText);
  const { authToken } = deriveFromAccountKey(parsed);
  const response = await fetch(`${base}/v1/account/unlock`, {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}` },
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as { wrappedEncRoot: string; accountId: string };
  const wrapKey = deriveToken(parsed).wrapKey;
  const encRoot = unwrapEncRoot(wrapKey, body.wrappedEncRoot, body.accountId);
  return { authToken, encRoot };
}

async function createNotebook(base: string, authToken: string, name: string, cryptoMode: "none" | "user-key"): Promise<string> {
  const response = await fetch(`${base}/v1/notebooks`, {
    method: "POST",
    headers: { authorization: `Bearer ${authToken}`, "content-type": "application/json" },
    body: JSON.stringify({ name, cryptoMode }),
  });
  expect(response.status).toBe(201);
  const body = (await response.json()) as { notebookId: string };
  return body.notebookId;
}

/* ============================================================================
   服务端启动 / 账本约定
   ============================================================================ */

let world: World;

beforeAll(async () => {
  world = await makeWorld();
}, 60_000);

afterAll(async () => {
  await world.cleanup();
});

/**
 * 同步一轮 + 账本落盘 + 从盘上读回（验证 schema 往返真实成立）。
 *
 * 账本落在设备**真实工作区**的 `.opennote/sync.json`（与生产同一路径约束：
 * `assertSafeLocalMetaPayload` 要过）。读回那一步保证「写下的东西下一次能被启动流程恢复」。
 */
async function syncAndPersist(device: DeviceHandle) {
  const result = await device.session.syncNow();
  if (result === null) {
    // 返回 null 意味着「同步是关的」—— 在这里就是测试装配错了,把状态原样抛出来。
    throw new Error(`syncNow() 返回 null(同步被关了?)status=${JSON.stringify(device.session.status())}`);
  }
  const fs = await import("node:fs/promises");
  const backend: FileSystemBackend = {
    kind: "node",
    label: "test",
    canWrite: true,
    list: async (rel) => {
      const entries = await fs.readdir(join(device.root, rel), { withFileTypes: true }).catch(() => []);
      return entries.map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? ("directory" as const) : ("file" as const), size: 0, mtimeMs: 0 }));
    },
    readText: async (rel) => fs.readFile(join(device.root, ...rel.split("/")), "utf8"),
    readBytes: async (rel) => new Uint8Array(await fs.readFile(join(device.root, ...rel.split("/")))),
    writeText: async (rel, text) => {
      const target = join(device.root, ...rel.split("/"));
      await fs.mkdir(join(target, ".."), { recursive: true });
      await fs.writeFile(target, text, "utf8");
    },
    writeBytes: async (rel, data) => {
      const target = join(device.root, ...rel.split("/"));
      await fs.mkdir(join(target, ".."), { recursive: true });
      await fs.writeFile(target, data);
    },
    mkdir: async () => undefined,
    remove: async (rel) => fs.rm(join(device.root, ...rel.split("/")), { recursive: true, force: true }),
    move: async (from, to) => fs.rename(join(device.root, ...from.split("/")), join(device.root, ...to.split("/"))),
    exists: async (rel) => {
      try {
        await fs.stat(join(device.root, ...rel.split("/")));
        return true;
      } catch {
        return false;
      }
    },
    stat: async (rel) => {
      const stats = await fs.stat(join(device.root, ...rel.split("/"))).catch(() => null);
      return stats ? { size: stats.size, mtimeMs: stats.mtimeMs } : null;
    },
  };
  await writeSyncLedger(backend, device.ledger);
  const readBack = await readSyncLedger(backend);
  expect(readBack).not.toBeNull();
  expect(readBack!.remote.notebookId).toBe(device.ledger.remote.notebookId);
  expect(Object.keys(readBack!.files).sort()).toEqual(Object.keys(device.ledger.files).sort());
  return result!;
}

/* ============================================================================
   ① 账号与笔记本链路（真实 HTTP）
   ============================================================================ */

describe("账号与笔记本链路（真实 /v1/* 契约）", () => {
  it("健康检查公开可用，协议版本 = 1", async () => {
    const response = await fetch(`${world.base}/v1/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; protocolVersion: number };
    expect(body.ok).toBe(true);
    expect(body.protocolVersion).toBe(1);
  });

  it("注册 → 解锁：新设备拿回 wrappedEncRoot 并解开 encRoot", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const unlocked = await unlockOnDevice(world.base, account.keyText);
    // 解开的 encRoot 必须与注册时客户端手里的那一份逐字节一致。
    expect(Buffer.from(unlocked.encRoot).equals(Buffer.from(account.encRoot))).toBe(true);
    expect(unlocked.authToken).toBe(account.authToken);
  });

  it("带引导码注册 → isAdmin = true；建 E2EE 笔记本成功", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "E2EE 笔记本", "user-key");
    expect(notebookId).toBeTruthy();
  });
});

/* ============================================================================
   ② 明文模式：两台设备互相同步
   ============================================================================ */

describe("明文模式：两台真实设备经真实 HTTP 互相同步", () => {
  it("设备 A 写 → 推上;设备 B 拉 → 内容一致", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "明文", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await a.disk.write("notes/a.md", "# 来自设备 A");
    const r1 = await syncAndPersist(a);
    expect(r1.pushed).toBe(1);

    const b = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    const r2 = await syncAndPersist(b);
    expect(r2.pulled).toBe(1);
    expect(await b.disk.read("notes/a.md")).toBe("# 来自设备 A");
  });

  it("B 修改 → A 增量同步拿到新版本", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "明文2", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await a.disk.write("notes/doc.md", "v1");
    await syncAndPersist(a);

    const b = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await syncAndPersist(b);
    await b.disk.write("notes/doc.md", "v2 · 设备 B 改");
    await syncAndPersist(b);

    const r = await syncAndPersist(a);
    expect(r.pulled).toBe(1);
    expect(await a.disk.read("notes/doc.md")).toBe("v2 · 设备 B 改");
  });

  it("A 删除 → 传播到 B（B 上的文件消失）", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "明文3", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await a.disk.write("notes/gone.md", "要被删掉的");
    await syncAndPersist(a);
    const b = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await syncAndPersist(b);

    await a.disk.remove("notes/gone.md");
    await syncAndPersist(a); // 推墓碑
    await syncAndPersist(b); // B 拉到删除
    expect(await b.disk.exists("notes/gone.md")).toBe(false);
  });

  it("忽略规则生效：.git/ 与 build/ 不进远端", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "明文4", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId, gitignoreText: "build/" });
    // 直接走 session 的依赖层（与生产同一条过滤路径）。
    await a.disk.write("notes/keep.md", "# 留下");
    await a.disk.write(".git/config", "[core]");
    await a.disk.write("build/out.js", "x");
    const result = await a.session.syncNow();
    expect(result!.pushed).toBe(1);
  });
});

/* ============================================================================
   ③ E2EE：两台设备互相同步，服务端库里只有密文
   ============================================================================ */

describe("E2EE：两台设备互相同步，库里看不到明文", () => {
  it("A 写 → B 拉:密文落库,两端明文一致", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "E2EE1", "user-key");

    // A 是注册设备（手里有 encRoot）；B 通过导入密钥 + unlock 重建。
    const aKey = decodeAccountKey(account.keyText);
    const aToken = deriveFromAccountKey(aKey).authToken;
    const encRoot = account.encRoot;
    const notebookKeyA = deriveNotebookKey(encRoot, notebookId);

    const a = await world.device({ cryptoMode: "user-key", authToken: aToken, notebookKey: notebookKeyA, notebookId });
    await a.disk.write("机密/名单.md", "张三 13800000000");
    const r1 = await syncAndPersist(a);
    expect(r1.pushed).toBe(1);

    // ★ B 在「写入路径」之前先放一个同名占位文件 —— 模拟「账本/映射里已知这条路径」
    // 的设备（P4-c 的 did↔path 映射同步尚未接线,见 7fa5209 的「尚未做」注记:
    // session 的 push/pull 还不写/读 m:pathmap,新设备重建流程也未实现）。
    // 在那张表接上之前,一个**全新空设备**拿不出路径,只能看到 unknownDids（下一条用例）。
    const b = await unlockOnDevice(world.base, account.keyText);
    const notebookKeyB = deriveNotebookKey(b.encRoot, notebookId);
    expect(Buffer.from(notebookKeyB).equals(Buffer.from(notebookKeyA))).toBe(true);

    const deviceB = await world.device({ cryptoMode: "user-key", authToken: b.authToken, notebookKey: notebookKeyB, notebookId });
    await deviceB.disk.write("机密/名单.md", "占位 —— 马上被远端版本覆盖");
    const r2 = await syncAndPersist(deviceB);
    // B 已知该路径 → did 反查成功 → 拉取并以远端版本覆盖本地占位。
    expect(r2.pulled).toBe(1);
    expect(await deviceB.disk.read("机密/名单.md")).toBe("张三 13800000000");

    // ★ 服务端库里（两种模式都验）都看不到明文 —— 这是 P4 的验收判据。
    await expectNoPlaintextOnServer({ plaintext: "张三 13800000000", pathHint: "名单" });
  });

  it("★ 全新空设备（没有 did↔path 映射）⇒ 如实报 unknownDids，盘上不写任何东西", async () => {
    /*
     * 这是 P4-c **尚未接线**的部分（7fa5209 / fe699fe 的「尚未做」注记）：
     * session 的 push/pull 还不写/读 `m:pathmap`，新设备重建流程也没有。
     * 所以模式 B 下 did 不可逆 ⇒ 全新设备认不出路径。
     *
     * 这里钉住的是「引擎的行为是**对的**」：认不出来的 did 如实上报，**绝不猜路径、
     * 绝不往盘上写密文**（那会把用户的笔记变成乱码，而且是静默的）。
     * 等 m:pathmap 接上之后，这条用例应当改成「pulled = 1」。
     */
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "E2EE-全新设备", "user-key");
    const notebookKey = deriveNotebookKey(account.encRoot, notebookId);

    const a = await world.device({ cryptoMode: "user-key", authToken: account.authToken, notebookKey, notebookId });
    await a.disk.write("notes/secret.md", "# 机密");
    await syncAndPersist(a);

    // 全新设备：同一把密钥、空目录、空账本。
    const fresh = await world.device({ cryptoMode: "user-key", authToken: account.authToken, notebookKey, notebookId });
    const result = await syncAndPersist(fresh);
    expect(result.pulled).toBe(0);
    expect(result.unknownDids).toHaveLength(1);
    // 盘上**没有任何笔记文件**（没有乱码、没有猜出来的文件名）。
    // （`.opennote/sync.json` 是账本本身，由本用例的落盘步骤写入 —— 不算「同步下来的内容」。）
    expect(await fresh.disk.exists("notes/secret.md")).toBe(false);
    const noteFiles = (await fresh.disk.list())
      .filter((entry) => !entry.isDir)
      .filter((entry) => !entry.path.startsWith(".opennote/"));
    expect(noteFiles).toEqual([]);
  });
});

/**
 * 断言服务端**任何地方**都看不到明文（路径与正文）。
 *
 * - 假 CouchDB：直接翻内存里的文档与附件；
 * - 真实 CouchDB：走 admin 的 `_all_docs?include_docs=true` + 逐条附件下载。
 *
 * 之所以两种模式都要验：单测里「某一层忘了加密」最容易表现为「fake 上看起来对、
 * 真机上明文在库里」—— 反过来也一样（这条链路两端的存储语义不同）。
 */
async function expectNoPlaintextOnServer(options: { plaintext: string; pathHint: string }): Promise<void> {
  const haystacks: string[] = [];
  if (world.fake) {
    for (const docs of world.fake.databases.values()) {
      for (const doc of docs.values()) haystacks.push(JSON.stringify(doc));
    }
    for (const bytes of world.fake.attachments.values()) haystacks.push(new TextDecoder().decode(bytes));
  } else {
    const auth = `Basic ${Buffer.from(`${REAL_COUCH_ADMIN_USER}:${REAL_COUCH_ADMIN_PASSWORD}`).toString("base64")}`;
    const allDbs = (await (await fetch(`${REAL_COUCH_URL}/_all_dbs`, { headers: { authorization: auth } })).json()) as string[];
    for (const dbName of allDbs.filter((name) => name.startsWith("nb-"))) {
      const body = (await (
        await fetch(`${REAL_COUCH_URL}/${dbName}/_all_docs?include_docs=true`, { headers: { authorization: auth } })
      ).json()) as { rows: { id: string; doc?: Record<string, unknown> }[] };
      for (const row of body.rows) {
        haystacks.push(JSON.stringify(row.doc ?? {}));
        // 正文在附件里（`blob`）—— 逐条下载再看。
        if (row.id.startsWith("_design") || row.id.startsWith("_local")) continue;
        const attachment = await fetch(`${REAL_COUCH_URL}/${dbName}/${encodeURIComponent(row.id)}/blob`, {
          headers: { authorization: auth },
        });
        if (attachment.ok) haystacks.push(await attachment.text());
      }
    }
  }

  expect(haystacks.length).toBeGreaterThan(0);
  for (const text of haystacks) {
    expect(text).not.toContain(options.plaintext);
    expect(text).not.toContain(options.pathHint);
  }
}

/* ============================================================================
   ④ 冲突：两边都改 → 只报不猜
   ============================================================================ */

describe("冲突：只报不猜", () => {
  it("两边都改同一条 → conflicts 列出,且不被自动覆盖", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "冲突", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await a.disk.write("notes/c.md", "base");
    await syncAndPersist(a);
    const b = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await syncAndPersist(b);

    // 两边各自改（互相不知道）。
    await a.disk.write("notes/c.md", "A 的版本");
    await b.disk.write("notes/c.md", "B 的版本");
    await syncAndPersist(a); // A 先推,成功
    const rb = await syncAndPersist(b); // B 的 CAS 撞上 → 冲突
    expect(rb.pushConflicts.length + rb.conflicts.length).toBeGreaterThan(0);
    // B 本地内容保持 B 的版本（没有被远端静默覆盖）。
    expect(await b.disk.read("notes/c.md")).toBe("B 的版本");
  });
});

/* ============================================================================
   ⑤ 多账号隔离
   ============================================================================ */

describe("多账号隔离", () => {
  it("账号 B 访问账号 A 的笔记本 → 404（与不存在不可区分）", async () => {
    const codeA = world.accounts.createBootstrapCode().code;
    const accountA = await registerAccount(world.base, codeA);
    const notebookA = await createNotebook(world.base, accountA.authToken, "A 的笔记本", "none");

    const codeB = world.accounts.createBootstrapCode().code;
    const accountB = await registerAccount(world.base, codeB);

    const response = await fetch(`${world.base}/v1/tree?nb=${notebookA}`, {
      headers: { authorization: `Bearer ${accountB.authToken}` },
    });
    const responseMissing = await fetch(`${world.base}/v1/tree?nb=${"00000000-0000-4000-8000-000000000000"}`, {
      headers: { authorization: `Bearer ${accountB.authToken}` },
    });
    expect(response.status).toBe(404);
    expect(responseMissing.status).toBe(404);
    expect(await response.text()).toBe(await responseMissing.text());
  });
});

/* ============================================================================
   ⑥ 401 → key-rotated 独立状态
   ============================================================================ */

describe("401 语义", () => {
  it("令牌失效 → runner 进 key-rotated,文案是指定的那句", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "轮换", "none");
    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });

    // 轮换:旧 authToken 立即失效。
    const material = createRegistrationMaterial();
    await fetch(`${world.base}/v1/account/rotate`, {
      method: "POST",
      headers: { authorization: `Bearer ${account.authToken}`, "content-type": "application/json" },
      body: JSON.stringify({ newAuthToken: material.authToken, newWrappedEncRoot: material.wrappedEncRoot }),
    });

    const statuses: SyncStatus[] = [];
    a.session.runner = a.session.runner; // runner 由 session 内部持有;通过 status() 读取
    await a.session.syncNow().catch(() => undefined);
    const status = a.session.status();
    expect(status.phase).toBe("key-rotated");
    const text = describeSyncStatus(status);
    expect(text.label).toContain("此设备的密钥已被轮换");
  });
});

/* ============================================================================
   ⑦ 真实 CouchDB 模式：置备验收 + SSE 实时
   ============================================================================ */

(REAL_COUCH ? describe : describe.skip)("真实 CouchDB", () => {
  it("置备验收:_design / _security / _revs_limit 真实落在库上", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    await createNotebook(world.base, account.authToken, "真库置备", "none");
    // 找到刚建的库(命名规则见 NotebookStore)。
    const adminAuth = `Basic ${Buffer.from(`${REAL_COUCH_ADMIN_USER}:${REAL_COUCH_ADMIN_PASSWORD}`).toString("base64")}`;
    const dbs = await (await fetch(`${REAL_COUCH_URL}/_all_dbs`, {
      headers: { authorization: adminAuth },
    })).json() as string[];
    const nbDb = dbs.find((name) => name !== "_users" && !name.startsWith("_"));
    expect(nbDb).toBeTruthy();
    const auth = adminAuth;
    const security = await (await fetch(`${REAL_COUCH_URL}/${nbDb}/_security`, { headers: { authorization: auth } })).json() as { members?: { names?: string[] } };
    expect(security.members?.names).toContain("sync-service");
    const revsLimit = await (await fetch(`${REAL_COUCH_URL}/${nbDb}/_revs_limit`, { headers: { authorization: auth } })).json() as number;
    expect(revsLimit).toBe(1000);
    const design = await fetch(`${REAL_COUCH_URL}/${nbDb}/_design/opennote`, { headers: { authorization: auth } });
    expect(design.status).toBe(200);
  });

  it("SSE:设备 B 写入 → 设备 A 收到 change 信号(真实 _changes 中继)", async () => {
    const code = world.accounts.createBootstrapCode().code;
    const account = await registerAccount(world.base, code);
    const notebookId = await createNotebook(world.base, account.authToken, "SSE", "none");

    const a = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    const b = await world.device({ cryptoMode: "none", authToken: account.authToken, notebookId });
    await syncAndPersist(a);
    await syncAndPersist(b);

    // A 建一条原生 EventSource 风格的 SSE 订阅(令牌走查询串)。
    const events: string[] = [];
    const controller = new AbortController();
    const sse = fetch(`${world.base}/v1/events?nb=${notebookId}&authToken=${encodeURIComponent(account.authToken)}`, {
      signal: controller.signal,
      headers: { accept: "text/event-stream" },
    }).then(async (response) => {
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
        if (events.join("").includes("event: change")) break;
      }
    });

    // 给 SSE 连接一点建立时间,然后 B 写入并推送。
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await b.disk.write("notes/live.md", "实时信号测试");
    await syncAndPersist(b);

    await Promise.race([sse, new Promise((_, reject) => setTimeout(() => reject(new Error("60s 内没收到 change 信号: " + events.join("").slice(0, 200))), 60_000))]);
    controller.abort();
    expect(events.join("")).toContain("event: change");
    expect(events.join("")).toContain("event: ready");
  }, 90_000);
});
