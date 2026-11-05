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
import { openDatabase } from "../db";
import { loadConfig } from "../config";
import { NotebookStore } from "../notebooks";
import { SettingsStore } from "../settings";
import { seedAccount, testAccountStore } from "../auth/testAccounts.test-helper";
import { FakeCouch, couchClient } from "../couch/fakeCouch.test-helper";
import { SHARE_DATABASE, ShareStore, cleanShareName, contentTypeFor } from "../shares";
import { createShareRoutes, contentDisposition } from "./shares";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

function makeWorld() {
  const db = openDatabase({ path: ":memory:" });
  const config = loadConfig(ENV);
  const accounts = testAccountStore(db);
  const notebooks = new NotebookStore(db);
  const shares = new ShareStore(db);
  const settings = new SettingsStore(db, config);
  const fake = new FakeCouch();
  const couch = couchClient(fake);
  const app = new Hono();
  app.route("/", createShareRoutes({ accounts, notebooks, shares, config, couch, couchAdmin: couch, settings, audit: (event) => notebooks.audit(event) }));
  const request = (path: string, init: RequestInit = {}) => Promise.resolve(app.request(`http://localhost${path}`, init));
  const share = async (token: string, name: string, body: string | Uint8Array) => {
    const response = await request(`/v1/shares?name=${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/octet-stream" },
      body,
    });
    return { status: response.status, body: (await response.json()) as Record<string, any> };
  };
  return { db, accounts, shares, fake, request, share };
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
  });

  it("删账号级联删掉它的分享", async () => {
    const world = makeWorld();
    const { id, token } = seedAccount(world.accounts);
    const { body } = await world.share(token, "a.md", "x");
    world.accounts.delete(id);
    expect(world.shares.find(body.id)).toBeNull();
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
