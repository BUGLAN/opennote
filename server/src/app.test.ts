import { describe, expect, it } from "vitest";
import { createApp } from "./app";
import { openDatabase } from "./db";
import { loadConfig } from "./config";
import { FakeCouch, couchClient } from "./couch/fakeCouch.test-helper";
import { seedAccount } from "./auth/testAccounts.test-helper";
import { idForPath } from "../../shared/paths";

const ENV: Record<string, string> = {
  EXTERNAL_BASE_URL: "https://notes.example.com",
  COUCH_URL: "http://couchdb:5984",
  COUCH_USER: "sync-service",
  COUCH_PASSWORD: "pw",
  COUCH_ADMIN_USER: "admin",
  COUCH_ADMIN_PASSWORD: "apw",
};

function makeWorld(extraEnv: Record<string, string> = {}) {
  const fake = new FakeCouch();
  const config = loadConfig({ ...ENV, ...extraEnv });
  const built = createApp({
    config,
    db: openDatabase({ path: ":memory:" }),
    couch: couchClient(fake),
    couchAdmin: couchClient(fake),
  });
  return {
    ...built,
    config,
    fake,
    account() {
      const { id, token } = seedAccount(built.accounts);
      return { id, token };
    },
    notebook(ownerId: string) {
      const row = built.notebooks.create({ ownerId, name: "笔记本", cryptoMode: "none" });
      fake.databases.set(row.db_name, new Map());
      return row;
    },
  };
}

describe("应用装配层的请求体闸门", () => {
  it("未认证的 JSON 入口：Content-Length 超限直接 413", async () => {
    const world = makeWorld({ MAX_JSON_BODY_BYTES: "32" });
    const response = await world.app.request("http://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "33" },
      body: '{"email":"a@example.com","password":"long-enough-pw"}',
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "too-large" });
  });

  it("未认证的 JSON 入口：无 Content-Length 的分块流超限也 413", async () => {
    const world = makeWorld({ MAX_JSON_BODY_BYTES: "32" });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(20)));
        controller.enqueue(new TextEncoder().encode("x".repeat(20)));
        controller.close();
      },
    });
    const response = await world.app.request("http://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
  });

  it("限额内的 JSON 请求仍交给路由处理", async () => {
    const world = makeWorld();
    const response = await world.app.request("http://localhost/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // 形状不对是路由自己的 400；关键是它读到了 body，而不是在闸门处 413。
    expect(response.status).toBe(400);
  });

  it("合法的 32 MiB PUT /v1/file 仍能写入", async () => {
    const world = makeWorld();
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const bytes = new Uint8Array(world.config.maxFileBytes);
    expect(bytes.byteLength).toBe(32 * 1024 * 1024);

    const response = await world.app.request(
      `http://localhost/v1/file?nb=${notebook.id}&did=${encodeURIComponent(idForPath("big.bin"))}&path=${encodeURIComponent("big.bin")}`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${alice.token}`,
          "content-length": String(bytes.byteLength),
        },
        body: bytes,
      },
    );
    expect(response.status).toBe(201);
  });

  it("分块上传超过文件上限时，在路由读取前 413", async () => {
    const world = makeWorld({ MAX_FILE_BYTES: "1024" });
    const alice = world.account();
    const notebook = world.notebook(alice.id);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(600));
        controller.enqueue(new Uint8Array(600));
        controller.close();
      },
    });
    const response = await world.app.request(
      `http://localhost/v1/file?nb=${notebook.id}&did=${encodeURIComponent(idForPath("big.bin"))}&path=${encodeURIComponent("big.bin")}`,
      {
        method: "PUT",
        headers: { authorization: `Bearer ${alice.token}` },
        body: stream,
        duplex: "half",
      } as RequestInit,
    );
    expect(response.status).toBe(413);
  });
});
