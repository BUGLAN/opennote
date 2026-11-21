/**
 * 公开分享（`routes/shares.ts`）。钉住：
 * - 什么类型都能分享，`content-type` 由服务端按扩展名定；
 * - 是**快照**：存下的就是上传那一刻的字节，没有更新入口；
 * - 公开页不泄露存在性（不存在 / 撤销 / 作者停用 → 同一个 404）；
 * - 公开页不执行快照里的东西（Markdown 里的 HTML 按文字显示、`/raw` 带 sandbox CSP）；
 * - 撤销只能作者来，撤完链接立刻失效。
 */

import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { shareCreatedSchema } from "../../../shared/contract";
import { idForPath } from "../../../shared/paths";
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { NotebookStore } from "../notebooks";
import { SettingsStore } from "../settings";
import { seedAccount, testAccountStore } from "../auth/testAccounts.test-helper";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { CouchClient } from "../couch/client";
import { SHARE_DATABASE, ShareStore, cleanShareName, contentTypeFor } from "../shares";
import { createShareRoutes, contentDisposition, type ShareRoutesDeps } from "./shares";
import { createAdminRoutes } from "./admin";
import { createV1Routes } from "./v1";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

interface WorldOptions {
  fake?: FakeCouch;
  fetchImpl?: typeof fetch;
  now?: () => number;
  audit?: NonNullable<ShareRoutesDeps["audit"]>;
}

function makeWorld(options: WorldOptions = {}) {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(ENV);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const shares = new ShareStore(db);
  const settings = new SettingsStore(db, config);
  const fake = options.fake ?? new FakeCouch();
  const couch = options.fetchImpl
    ? new CouchClient({
        baseUrl: ENV.COUCH_URL,
        user: ENV.COUCH_USER,
        password: ENV.COUCH_PASSWORD,
        fetchImpl: options.fetchImpl,
      })
    : couchClient(fake);
  const app = new Hono();
  const audit =
    options.audit ?? ((event: Parameters<NotebookStore["audit"]>[0]) => notebooks.audit(event));
  app.route(
    "/",
    createShareRoutes({ accounts, notebooks, shares, config, couch, couchAdmin: couch, settings, audit, now: options.now }),
  );
  app.route("/v1", createV1Routes({ accounts, notebooks, config, couch, couchAdmin: couch, settings, audit }));
  app.route("/v1/admin", createAdminRoutes({ accounts, notebooks, shares, config, couch, couchAdmin: couch, settings, audit }));
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(`http://localhost${path}`, init));
  const share = async (token: string, name: string, body: string | Uint8Array) => {
    const response = await request(`/v1/shares?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  const admin = seedAccount(accounts, { isAdmin: true });
  return { db, accounts, notebooks, shares, fake, request, share, admin };
}

describe("创建", () => {
  it("上传一份快照 → 201 + 公开链接（按对外地址拼），字节进 opennote-shares 库", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    const created = await world.share(token, "读书笔记.md", "# 你好\n\n正文");
    expect(created.status).toBe(201);
    const body = shareCreatedSchema.parse(created.body);
    expect(body.url).toBe(`https://notes.example.com/s/${body.id}`);
    expect(body.rawUrl).toBe(`${body.url}/raw`);
    expect(body.name).toBe("读书笔记.md");
    expect(body.size).toBe(new TextEncoder().encode("# 你好\n\n正文").byteLength);
    expect(world.fake.databases.has(SHARE_DATABASE)).toBe(true);
    expect(world.fake.security.get(SHARE_DATABASE)).toMatchObject({ members: { names: ["sync-service"] } });
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(true);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });

  it("没登录 401；文件名缺失 / 只有路径 400", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    expect((await world.request("/v1/shares?name=a.md", { method: "POST", body: "x" })).status).toBe(401);
    expect((await world.share(token, "", "x")).status).toBe(400);
    expect((await world.share(token, "dir/", "x")).status).toBe(400);
  });

  it("不按类型拦：任何扩展名（包括没有扩展名、二进制）都能分享", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    for (const name of ["a.canvas", "page.html", "photo.png", "archive.zip", "README", "script.sh"]) {
      expect((await world.share(token, name, new Uint8Array([0, 1, 2, 255]))).status, name).toBe(201);
    }
  });

  it("超过单文件上限 413；超过空间配额 413 quota", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    world.db.prepare("UPDATE accounts SET quota_bytes = 10 WHERE id = ?").run(id);
    const first = await world.share(token, "a.txt", "12345678");
    expect(first.status).toBe(201);
    const second = await world.share(token, "b.txt", "12345678");
    expect(second.status).toBe(413);
    expect(second.body.code).toBe("quota");
  });

  it("两个并发请求共用剩余配额：只有一个 201，失败方不留下行或快照", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    world.db.prepare("UPDATE accounts SET quota_bytes = 12 WHERE id = ?").run(id);

    const results = await Promise.all([world.share(token, "a.txt", "12345678"), world.share(token, "b.txt", "12345678")]);
    expect(results.map((result) => result.status).sort()).toEqual([201, 413]);
    expect(results.find((result) => result.status === 413)?.body.code).toBe("quota");

    const rows = world.db.prepare("SELECT id, size, revoked_at FROM shares").all() as unknown as {
      id: string;
      size: number;
      revoked_at: number | null;
    }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ size: 8, revoked_at: null });
    expect(world.shares.activeBytesOf(id)).toBe(8);
    expect(world.fake.databases.get(SHARE_DATABASE)?.size).toBe(1);
    expect(world.fake.attachments.size).toBe(1);
  });

  it("CouchDB 已写入后报错：撤销分享，清理失败时留队列并可继续删快照", async () => {
    const fake = new FakeCouch();
    const baseFetch = fake.fetchImpl;
    let throwAfterCommittedWrite = true;
    let failImmediateCleanup = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const snapshotDoc = url.pathname.split("/").filter(Boolean).length === 2 && url.pathname.startsWith(`/${SHARE_DATABASE}/`);

      if ((init?.method ?? "GET") === "PUT" && snapshotDoc && body?._attachments) {
        const response = await baseFetch(input, init);
        if (throwAfterCommittedWrite) {
          throwAfterCommittedWrite = false;
          throw new Error("ECONNRESET after commit（fake）");
        }
        return response;
      }
      if ((init?.method ?? "GET") === "PUT" && snapshotDoc && body?._deleted === true && failImmediateCleanup) {
        failImmediateCleanup = false;
        throw new Error("ECONNREFUSED immediate cleanup（fake）");
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const world = makeWorld({ fake, fetchImpl });
    const owner = seedAccount(world.accounts);

    const created = await world.request("/v1/shares?name=a.md", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: "secret",
    });
    expect(created.status).toBe(500);

    const share = world.db.prepare("SELECT id, revoked_at FROM shares").get() as { id: string; revoked_at: number | null };
    expect(share.revoked_at).not.toBeNull();
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${share.id}/blob`)).toBe(true);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);
    expect(world.db.prepare("SELECT action, target, detail FROM audit WHERE action = ?").get("share_create_snapshot_cleanup_failed")).toMatchObject({
      action: "share_create_snapshot_cleanup_failed",
      target: share.id,
      detail: "pending=1",
    });

    const cleaned = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toEqual({ deleted: 1, pending: 0 });
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${share.id}/blob`)).toBe(false);
  });

  it("CouchDB 冲突也撤销分享并留下可重试的清理记录", async () => {
    const fake = new FakeCouch();
    const baseFetch = fake.fetchImpl;
    let snapshotReads = 0;
    let failCleanupReads = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : null;
      const snapshotDoc = url.pathname.split("/").filter(Boolean).length === 2 && url.pathname.startsWith(`/${SHARE_DATABASE}/`);

      if ((init?.method ?? "GET") === "PUT" && snapshotDoc && body?._attachments) {
        return new Response(JSON.stringify({ error: "conflict" }), {
          status: 409,
          headers: { "content-type": "application/json" },
        });
      }
      if ((init?.method ?? "GET") === "GET" && snapshotDoc) {
        snapshotReads += 1;
        // 第一次是 putDoc 读冲突文档；之后的读取属于失败收尾的立即删除。
        if (snapshotReads > 1 && failCleanupReads) throw new Error("ECONNREFUSED immediate cleanup（fake）");
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const world = makeWorld({ fake, fetchImpl });
    const owner = seedAccount(world.accounts);

    const created = await world.request("/v1/shares?name=a.md", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: "secret",
    });
    expect(created.status).toBe(500);
    const share = world.db.prepare("SELECT id, revoked_at FROM shares").get() as { id: string; revoked_at: number | null };
    expect(share.revoked_at).not.toBeNull();
    expect(snapshotReads).toBeGreaterThan(1);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);

    failCleanupReads = false;
    const cleaned = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(cleaned.status).toBe(200);
    expect(await cleaned.json()).toEqual({ deleted: 1, pending: 0 });
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });

  it("响应契约失败发生在任何分享行或快照写入之前", async () => {
    const world = makeWorld({ now: () => -1 });
    const owner = seedAccount(world.accounts);

    const created = await world.request("/v1/shares?name=a.md", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: "secret",
    });
    expect(created.status).toBe(500);
    expect(world.db.prepare("SELECT COUNT(*) AS n FROM shares").get()).toEqual({ n: 0 });
    expect(world.fake.databases.has(SHARE_DATABASE)).toBe(false);
    expect(world.fake.attachments.size).toBe(0);
  });

  it("审计抛错也撤销分享并删掉已写入的快照", async () => {
    const world = makeWorld({
      audit: () => {
        throw new Error("audit unavailable（fake）");
      },
    });
    const owner = seedAccount(world.accounts);

    const created = await world.request("/v1/shares?name=a.md", {
      method: "POST",
      headers: { authorization: `Bearer ${owner.token}` },
      body: "secret",
    });
    expect(created.status).toBe(500);
    const share = world.db.prepare("SELECT id, revoked_at FROM shares").get() as { id: string; revoked_at: number | null };
    expect(share.revoked_at).not.toBeNull();
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${share.id}/blob`)).toBe(false);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });

  it("★ 笔记本写与分享创建并发：共用账号配额，只有一个成功且失败方不留数据", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    world.db.prepare("UPDATE accounts SET quota_bytes = 12 WHERE id = ?").run(id);
    const notebook = world.notebooks.create({ ownerId: id, name: "a", cryptoMode: "none" });
    world.fake.databases.set(notebook.db_name, new Map());
    // 两边都在「已经预占、还没落到 CouchDB」的窗口里停一下，确保真正竞争。
    world.fake.beforePutDoc = async () => {
      await new Promise((resolve) => setTimeout(resolve, 25));
    };

    const put = world.request(`/v1/file?nb=${notebook.id}&did=${encodeURIComponent(idForPath("a.md"))}&path=a.md`, {
      method: "PUT",
      headers: { authorization: `Bearer ${token}` },
      body: "12345678",
    });
    const [note, share] = await Promise.all([put, world.share(token, "a.txt", "12345678")]);
    expect([note.status, share.status].sort()).toEqual([201, 413]);

    const losingBody = note.status === 413 ? ((await note.json()) as { code: string }) : share.body;
    expect(losingBody.code).toBe("quota");
    expect(world.notebooks.bytesOwnedBy(id) + world.shares.activeBytesOf(id)).toBe(8);
    expect(world.notebooks.reservedBytesOf(id)).toBe(0);
    if (note.status === 413) {
      expect(world.notebooks.notebookBytesOf(notebook.id)).toBe(0);
      expect(world.shares.activeBytesOf(id)).toBe(8);
      expect((world.db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n).toBe(1);
    } else {
      expect(world.notebooks.bytesOwnedBy(id)).toBe(8);
      expect(world.shares.activeBytesOf(id)).toBe(0);
      expect((world.db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n).toBe(0);
    }
  });

  it("笔记本已用计入分享配额：笔记本 8B + 分享 3B 超过 10B → 413", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    world.db.prepare("UPDATE accounts SET quota_bytes = 10 WHERE id = ?").run(id);
    const notebook = world.notebooks.create({ ownerId: id, name: "a", cryptoMode: "none" });
    world.notebooks.addNotebookBytes(notebook.id, 8);

    const denied = await world.share(token, "a.txt", "abc");
    expect(denied.status).toBe(413);
    expect(denied.body).toMatchObject({ code: "quota", bytesUsed: 8, bytesLimit: 10 });
    // 失败方不留下行；预占也释放了，腾出空间后同样的上传能成功。
    expect((world.db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n).toBe(0);
    expect(world.notebooks.reservedBytesOf(id)).toBe(0);

    world.notebooks.addNotebookBytes(notebook.id, -8);
    expect((await world.share(token, "a.txt", "12345678")).status).toBe(201);
    expect(world.shares.activeBytesOf(id)).toBe(8);
  });

  it("快照写入失败后释放预占，重试不会被自己的预占挡住", async () => {
    const fake = new FakeCouch();
    const baseFetch = fake.fetchImpl;
    let failSnapshot = true;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const segments = url.pathname.split("/").filter(Boolean);
      const snapshotDoc = segments.length === 2 && segments[0] === SHARE_DATABASE && !segments[1]!.startsWith("_");
      if (failSnapshot && (init?.method ?? "GET") === "PUT" && snapshotDoc) {
        failSnapshot = false;
        throw new Error("ECONNREFUSED snapshot（fake）");
      }
      return baseFetch(input, init);
    }) as typeof fetch;
    const world = makeWorld({ fake, fetchImpl });
    const { id, token } = seedAccount(world.accounts);
    world.db.prepare("UPDATE accounts SET quota_bytes = 10 WHERE id = ?").run(id);

    const failed = await world.request("/v1/shares?name=a.txt", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body: "12345678",
    });
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(world.notebooks.reservedBytesOf(id)).toBe(0);
    // 失败收尾按 #60：行保留但已撤销，不计入活跃用量。
    expect(world.shares.activeBytesOf(id)).toBe(0);
    expect((world.db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n).toBe(1);

    expect((await world.share(token, "a.txt", "12345678")).status).toBe(201);
    expect(world.shares.activeBytesOf(id)).toBe(8);
    expect(world.notebooks.reservedBytesOf(id)).toBe(0);
  });
});

describe("公开页", () => {
  it("/s/:id：只读网页，带「一次性快照」说明、服务端样式与严格 CSP；Markdown 里的 HTML 不执行", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    const { body } = await world.share(token, "笔记.md", "# 标题\n\n<script>alert(1)</script>\n\n[外链](https://example.com)");
    const page = await world.request(`/s/${body.id}`);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toContain("text/html");
    const csp = page.headers.get("content-security-policy")!;
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await page.text();
    expect(html).toContain("一次性快照");
    expect(html).toContain("不参与同步");
    expect(html).toContain('href="/panel/tokens.css"');
    expect(html).toContain('href="/panel/prose.css"');
    expect(html).toContain('<article class="prose share__doc">');
    expect(html).toContain("<h1>标题</h1>");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("Markdown 第一行就是同名的 # 标题时不再另画大标题；不同名时照画", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    const same = await world.share(token, "周报.md", "\n# 周报\n\n正文");
    expect(await (await world.request(`/s/${same.body.id}`)).text()).not.toContain('class="share__title"');
    const other = await world.share(token, "周报.md", "# 本周\n\n正文");
    expect(await (await world.request(`/s/${other.body.id}`)).text()).toContain('<h1 class="share__title">周报</h1>');
  });

  it("/s/:id/raw：原样字节、服务端定的类型、sandbox CSP；?download=1 改成附件（中文文件名不乱码）", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    const { body } = await world.share(token, "页面.html", "<h1>hi</h1><script>1</script>");
    const raw = await world.request(`/s/${body.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(raw.headers.get("content-security-policy")).toMatch(/^sandbox /);
    expect(raw.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(raw.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(await raw.text()).toBe("<h1>hi</h1><script>1</script>");

    const download = await world.request(`/s/${body.id}/raw?download=1`);
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="__.html"; filename*=UTF-8''${encodeURIComponent("页面.html")}`);

    const again = await world.request(`/s/${body.id}/raw`, { headers: { "if-none-match": raw.headers.get("etag")! } });
    expect(again.status).toBe(304);
  });

  it("HTML 在分享页里放进 sandbox iframe；画布列出卡片；图片直接显示；不认识的二进制给下载", async () => {
    const world = makeWorld();
    const { token } = seedAccount(world.accounts);
    const html = await world.share(token, "p.html", "<p>x</p>");
    expect(await (await world.request(`/s/${html.body.id}`)).text()).toMatch(/<iframe class="share-frame" src="\/s\/[^"]+\/raw"[^>]*sandbox="allow-scripts/);

    const canvas = JSON.stringify({ nodes: [{ id: "b", type: "text", text: "第二张", x: 0, y: 200 }, { id: "a", type: "text", text: "**第一张**", x: 0, y: 0 }], edges: [] });
    const canvasPage = await (await world.request(`/s/${(await world.share(token, "白板.canvas", canvas)).body.id}`)).text();
    expect(canvasPage.indexOf("<strong>第一张</strong>")).toBeGreaterThan(-1);
    expect(canvasPage.indexOf("<strong>第一张</strong>")).toBeLessThan(canvasPage.indexOf("第二张"));

    const image = await world.share(token, "图.png", new Uint8Array([137, 80, 78, 71]));
    expect(await (await world.request(`/s/${image.body.id}`)).text()).toContain(`<img src="/s/${image.body.id}/raw"`);

    const binary = await world.share(token, "a.bin", new Uint8Array([0xff, 0xfe, 0x00, 0x80]));
    expect(await (await world.request(`/s/${binary.body.id}`)).text()).toContain(`/s/${binary.body.id}/raw?download=1`);
  });

  it("不存在、id 形状不对、作者被停用：同一个 404 页", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    const { body } = await world.share(token, "a.md", "x");
    expect((await world.request("/s/AAAAAAAAAAAAAAAAAAAAAA")).status).toBe(404);
    expect((await world.request("/s/nope")).status).toBe(404);
    world.db.prepare("UPDATE accounts SET status = 'disabled' WHERE id = ?").run(id);
    const page = await world.request(`/s/${body.id}`);
    expect(page.status).toBe(404);
    expect(await page.text()).toContain("这个分享链接已失效");
    expect((await world.request(`/s/${body.id}/raw`)).status).toBe(404);
  });
});

describe("撤销", () => {
  it("只有作者能撤；撤完公开页与原文件都 404，字节也删掉", async () => {
    const world = makeWorld();
    const owner = seedAccount(world.accounts);
    const other = seedAccount(world.accounts);
    const { body } = await world.share(owner.token, "a.md", "secret");

    const byOther = await world.request(`/v1/shares/${body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${other.token}` } });
    expect(byOther.status).toBe(404);
    expect((await world.request(`/s/${body.id}`)).status).toBe(200);

    const byOwner = await world.request(`/v1/shares/${body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(byOwner.status).toBe(204);
    expect((await world.request(`/s/${body.id}`)).status).toBe(404);
    expect((await world.request(`/s/${body.id}/raw`)).status).toBe(404);
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(false);
    // 撤销后配额不再算它。
    expect(world.shares.activeBytesOf(owner.id)).toBe(0);
    // 删除成功就不留无意义的队列行。
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });

  it("撤销时删快照失败：链接仍立刻 404，id 留在清理队列；清扫成功后才删字节", async () => {
    const world = makeWorld();
    const owner = seedAccount(world.accounts);
    const { body } = await world.share(owner.token, "a.md", "secret");
    world.fake.failNext = `PUT /${SHARE_DATABASE}`;

    const revoke = await world.request(`/v1/shares/${body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(revoke.status).toBe(204);
    expect((await world.request(`/s/${body.id}`)).status).toBe(404);
    expect((await world.request(`/s/${body.id}/raw`)).status).toBe(404);
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(true);
    expect(world.shares.find(body.id)?.revoked_at).not.toBeNull();
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);

    // 失败记录留在队列里（下次清扫会继续重试），待清理数也进了审计。
    const row = world.db.prepare("SELECT attempts, last_error FROM share_cleanup WHERE share_id = ?").get(body.id) as {
      attempts: number;
      last_error: string;
    };
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain("ECONNREFUSED");
    expect(world.db.prepare("SELECT action, target, detail FROM audit WHERE action = ?").get("share_revoke_snapshot_cleanup_failed")).toMatchObject({
      action: "share_revoke_snapshot_cleanup_failed",
      target: body.id,
      detail: "pending=1",
    });

    world.fake.failNext = `PUT /${SHARE_DATABASE}`;
    const failed = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(failed.status).toBe(503);
    expect(await failed.json()).toMatchObject({ code: "couch-delete-failed", pending: 1 });
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);

    const retried = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ deleted: 1, pending: 0 });
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(false);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });

  it("删账号会清理活跃与已撤销分享的快照字节，公开链接立即 404", async () => {
    const world = makeWorld();
    const owner = seedAccount(world.accounts);
    const active = await world.share(owner.token, "active.md", "active secret");
    const revoked = await world.share(owner.token, "revoked.md", "revoked secret");

    world.fake.failNext = `PUT /${SHARE_DATABASE}`;
    const revoke = await world.request(`/v1/shares/${revoked.body.id}`, { method: "DELETE", headers: { authorization: `Bearer ${owner.token}` } });
    expect(revoke.status).toBe(204);
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${revoked.body.id}/blob`)).toBe(true);

    expect((await world.request(`/s/${active.body.id}`)).status).toBe(200);
    const deleted = await world.request(`/v1/admin/accounts/${owner.id}`, { method: "DELETE", headers: { authorization: `Bearer ${world.admin.token}` } });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ shareSnapshotsDeleted: 2, shareSnapshotsPending: 0 });

    expect(world.accounts.findById(owner.id)).toBeNull();
    expect(world.shares.find(active.body.id)).toBeNull();
    expect(world.shares.find(revoked.body.id)).toBeNull();
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${active.body.id}/blob`)).toBe(false);
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${revoked.body.id}/blob`)).toBe(false);
    expect((await world.request(`/s/${active.body.id}`)).status).toBe(404);
    expect((await world.request(`/s/${revoked.body.id}`)).status).toBe(404);
  });

  it("快照清理失败不阻止删账号：链接仍 404，队列保留 id 并可重试", async () => {
    const world = makeWorld();
    const owner = seedAccount(world.accounts);
    const { body } = await world.share(owner.token, "a.md", "secret");
    world.fake.failNext = `PUT /${SHARE_DATABASE}`;

    const deleted = await world.request(`/v1/admin/accounts/${owner.id}`, { method: "DELETE", headers: { authorization: `Bearer ${world.admin.token}` } });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toMatchObject({ shareSnapshotsDeleted: 0, shareSnapshotsPending: 1 });
    expect(world.accounts.findById(owner.id)).toBeNull();
    expect(world.shares.find(body.id)).toBeNull();
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(true);
    expect((await world.request(`/s/${body.id}`)).status).toBe(404);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);

    world.fake.failNext = `PUT /${SHARE_DATABASE}`;
    const failedRetry = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(failedRetry.status).toBe(503);
    expect(await failedRetry.json()).toMatchObject({ code: "couch-delete-failed", pending: 1 });
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(1);

    const retried = await world.request("/v1/admin/share-snapshots/cleanup", {
      method: "POST",
      headers: { authorization: `Bearer ${world.admin.token}` },
    });
    expect(retried.status).toBe(200);
    expect(await retried.json()).toEqual({ deleted: 1, pending: 0 });
    expect(world.fake.attachments.has(`${SHARE_DATABASE}/${body.id}/blob`)).toBe(false);
    expect(world.shares.pendingSnapshotCleanupCount()).toBe(0);
  });
});

describe("小工具", () => {
  it("文件名只留最后一段、去控制字符；类型按扩展名", () => {
    expect(cleanShareName("a/b/c.md")).toBe("c.md");
    expect(cleanShareName("  x\u0000y.md ")).toBe("xy.md");
    expect(cleanShareName("..")).toBeNull();
    expect(cleanShareName("x".repeat(256))).toBeNull();
    expect(contentTypeFor("A.MD")).toBe("text/plain; charset=utf-8");
    expect(contentTypeFor("a.canvas")).toBe("application/json; charset=utf-8");
    expect(contentTypeFor("a.exe")).toBe("application/octet-stream");
    expect(contentDisposition("inline", "a.md")).toBe(`inline; filename="a.md"; filename*=UTF-8''a.md`);
  });
});

describe("样式与客户端一致", () => {
  it("分享页用的 prose.css 是客户端 src/styles/prose.css 的原样副本（改一边忘了另一边会在这里红）", async () => {
    const { readFileSync } = await import("node:fs");
    const client = readFileSync(new URL("../../../src/styles/prose.css", import.meta.url), "utf8");
    const panel = readFileSync(new URL("../panel/prose.css", import.meta.url), "utf8");
    expect(panel).toBe(client);
  });
});
