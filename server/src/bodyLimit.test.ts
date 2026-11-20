import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { bodyLimit } from "./bodyLimit";

function makeApp(limit: number) {
  let handled = 0;
  const app = new Hono();
  app.use("*", bodyLimit({ limitFor: () => limit }));
  app.post("/json", async (c) => {
    handled += 1;
    return c.json({ body: await c.req.json() });
  });
  app.put("/raw", async (c) => {
    handled += 1;
    return c.json({ size: (await c.req.arrayBuffer()).byteLength });
  });
  return { app, handled: () => handled };
}

function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      controller.close();
    },
  });
}

describe("请求体上限", () => {
  it("Content-Length 超限时不进入路由，直接 413", async () => {
    const world = makeApp(8);
    const response = await world.app.request("http://localhost/json", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "9" },
      body: "{}",
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({ code: "too-large" });
    expect(world.handled()).toBe(0);
  });

  it("刚好等于上限时放行，路由读到完整 body", async () => {
    const world = makeApp(8);
    const response = await world.app.request("http://localhost/json", {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "8" },
      body: '{"a":12}',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ body: { a: 12 } });
    expect(world.handled()).toBe(1);
  });

  it("没有 Content-Length 的分块 body 累计超限 → 413", async () => {
    const world = makeApp(8);
    const response = await world.app.request("http://localhost/raw", {
      method: "PUT",
      body: streamOf([new Uint8Array(5), new Uint8Array(5)]),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(world.handled()).toBe(0);
  });

  it("没有 Content-Length 的分块 body 在限额内 → 放行，分块被合并", async () => {
    const world = makeApp(10);
    const response = await world.app.request("http://localhost/raw", {
      method: "PUT",
      body: streamOf([new Uint8Array(4).fill(1), new Uint8Array(6).fill(2)]),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ size: 10 });
  });

  it("声明长度偏小、实际流超限 → 仍然 413", async () => {
    const world = makeApp(8);
    const response = await world.app.request("http://localhost/raw", {
      method: "PUT",
      headers: { "content-length": "4" },
      body: streamOf([new Uint8Array(5), new Uint8Array(5)]),
      duplex: "half",
    } as RequestInit);
    expect(response.status).toBe(413);
    expect(world.handled()).toBe(0);
  });
});
