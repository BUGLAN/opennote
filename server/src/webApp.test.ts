/**
 * 同步服务器托管网页版（issue #1）。走完整的 `createApp`，这样路由顺序（网页版必须最后挂、
 * 不能盖住 `/v1` 与控制台）也在测试范围里。
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { openDatabase } from "./db";
import { couchClient, FakeCouch } from "./couch/fakeCouch.test-helper";
import { resolveWebRoot } from "./webApp";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://127.0.0.1:59999",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

const INDEX = '<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src \'self\'"></head><body>web</body></html>';

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function webDist(): string {
  const root = mkdtempSync(join(tmpdir(), "opennote-web-"));
  dirs.push(root);
  writeFileSync(join(root, "index.html"), INDEX);
  writeFileSync(join(root, "sw.js"), "self.addEventListener('fetch', () => {});");
  writeFileSync(join(root, "manifest.webmanifest"), "{}");
  writeFileSync(join(root, "html-sandbox.html"), "<!doctype html><p>sandbox</p>");
  writeFileSync(join(root, ".secret"), "nope");
  mkdirSync(join(root, "assets", "lazy"), { recursive: true });
  writeFileSync(join(root, "assets", "index-abc123.js"), "console.log('app')");
  writeFileSync(join(root, "assets", "lazy", "mermaid-def456.js"), "console.log('lazy')");
  return root;
}

function world(webRoot: string | null) {
  const db = openDatabase({ path: ":memory:" });
  const couch = couchClient(new FakeCouch());
  return createApp({ config: loadConfig(ENV), db, couch, couchAdmin: couch, webRoot });
}

describe("同步服务器托管网页版（issue #1）", () => {
  it("`/` 返回网页版 index.html，带 SAMEORIGIN 与 frame-ancestors，不发任何 CORS 头", async () => {
    const { app } = world(webDist());
    const response = await app.request("http://localhost/", { headers: { origin: "https://evil.example" } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(await response.text()).toBe(INDEX);
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
    expect(response.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("no-cache");
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("没有扩展名的页面路径回落到 index.html（SPA）", async () => {
    const { app } = world(webDist());
    for (const path of ["/notes", "/some/deep/page", "/assets/"]) {
      const response = await app.request(`http://localhost${path}`);
      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe(INDEX);
    }
  });

  it("静态资源按类型发：哈希文件永久缓存，sw.js 与 manifest 每次确认", async () => {
    const { app } = world(webDist());
    const script = await app.request("http://localhost/assets/index-abc123.js");
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(script.headers.get("cache-control")).toContain("immutable");

    const lazy = await app.request("http://localhost/assets/lazy/mermaid-def456.js");
    expect(lazy.status).toBe(200);

    const sw = await app.request("http://localhost/sw.js");
    expect(sw.headers.get("cache-control")).toBe("no-cache");
    const manifest = await app.request("http://localhost/manifest.webmanifest");
    expect(manifest.headers.get("content-type")).toContain("application/manifest+json");

    const sandbox = await app.request("http://localhost/html-sandbox.html");
    expect(sandbox.status).toBe(200);
    expect(sandbox.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });

  it("ETag 没变就回 304", async () => {
    const { app } = world(webDist());
    const first = await app.request("http://localhost/sw.js");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const second = await app.request("http://localhost/sw.js", { headers: { "if-none-match": etag! } });
    expect(second.status).toBe(304);
  });

  it("不存在的带扩展名文件是 404（不回落成 index.html）", async () => {
    const { app } = world(webDist());
    const response = await app.request("http://localhost/assets/missing-000.js");
    expect(response.status).toBe(404);
    expect(((await response.json()) as { code: string }).code).toBe("not-found");
  });

  it("目录穿越与隐藏文件一律不发", async () => {
    const { app } = world(webDist());
    for (const path of ["/../../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd.txt", "/.secret", "/assets/%2e%2e/.secret", "/a%00.js"]) {
      const response = await app.request(`http://localhost${path}`);
      const body = await response.text();
      expect(body, path).not.toContain("nope");
      expect(body, path).not.toContain("root:");
    }
  });

  it("API 与控制台的路径不受影响：未知 /v1 仍是 JSON 404，/v1/health、/admin 照常", async () => {
    const { app } = world(webDist());
    const unknown = await app.request("http://localhost/v1/nope");
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get("content-type")).toContain("application/json");

    const health = await app.request("http://localhost/v1/health");
    expect(health.status).toBe(200);
    expect(((await health.json()) as { ok: boolean }).ok).toBe(true);

    const admin = await app.request("http://localhost/admin");
    expect(admin.status).toBe(200);
    expect(await admin.text()).not.toBe(INDEX);
    // 控制台仍是 DENY + 自己的 CSP，没有被网页版的头换掉。
    expect(admin.headers.get("x-frame-options")).toBe("DENY");

    for (const path of ["/join/unknown-code", "/reset/unknown-code", "/panel/missing.js", "/auth/nope", "/v1"]) {
      const response = await app.request(`http://localhost${path}`);
      expect(await response.clone().text(), path).not.toBe(INDEX);
    }
  });

  it("不是 GET 的请求不回落", async () => {
    const { app } = world(webDist());
    const response = await app.request("http://localhost/notes", { method: "POST" });
    expect(response.status).toBe(404);
  });

  it("没有网页版产物时行为与以前一样：`/` 是 404", async () => {
    const { app, webRoot } = world(null);
    expect(webRoot).toBeNull();
    const response = await app.request("http://localhost/");
    expect(response.status).toBe(404);
  });

  it("resolveWebRoot：没有 index.html 的目录不托管；WEB_ROOT 优先于默认目录", () => {
    const empty = mkdtempSync(join(tmpdir(), "opennote-web-empty-"));
    dirs.push(empty);
    expect(resolveWebRoot(empty)).toBeNull();
    expect(resolveWebRoot(null)).toBeNull();
    const dist = webDist();
    expect(resolveWebRoot(undefined, { WEB_ROOT: dist })).toBe(dist);
    expect(resolveWebRoot(undefined, { WEB_ROOT: empty })).toBeNull();
  });
});
