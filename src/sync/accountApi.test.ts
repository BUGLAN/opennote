/**
 * `accountApi` 的形状测试（不发真网：发送函数注入）。
 *
 * 钉住的是**适配层**的承诺：`{error, code}` 错误形状 → 带状态的异常；
 * 请求头/请求体按契约拼装；2xx 的 JSON 正常解析。
 */
import { describe, expect, it } from "vitest";
import { openAccountApi } from "./accountApi";
import type { HttpSend } from "./http";

function jsonSend(status: number, body: unknown): HttpSend & { calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] } {
  const calls: { method: string; url: string; headers: Record<string, string>; body?: string }[] = [];
  const send = (async (request) => {
    calls.push({ method: request.method, url: request.url, headers: request.headers, body: typeof request.body === "string" ? request.body : undefined });
    return { status, headers: {}, bytes: new TextEncoder().encode(JSON.stringify(body)) };
  }) as HttpSend & { calls: typeof calls };
  send.calls = calls;
  return send;
}

describe("错误形状", () => {
  it("非 2xx 的 {error, code} → AccountApiError（带状态与机器可读 code）", async () => {
    const send = jsonSend(409, { error: "账号已存在", code: "conflict" });
    const api = await openAccountApi({ baseUrl: "https://notes.example.com", authToken: "t".repeat(32) }, send);
    await expect(api.register({ accountId: "a".repeat(32), authToken: "t".repeat(32), wrappedEncRoot: "w".repeat(32) })).rejects.toMatchObject({
      status: 409,
      code: "conflict",
    });
  });
});

describe("请求拼装", () => {
  it("带令牌时发 Bearer；注册体逐字按契约", async () => {
    const send = jsonSend(201, { accountId: "a".repeat(32), isAdmin: true, protocolVersion: 1 });
    const api = await openAccountApi({ baseUrl: "https://notes.example.com/", authToken: "t".repeat(32) }, send);
    const response = await api.register({
      accountId: "a".repeat(32),
      authToken: "t".repeat(32),
      wrappedEncRoot: "w".repeat(32),
      bootstrapCode: "boot_abc",
    });
    expect(response.isAdmin).toBe(true);
    expect(send.calls[0]?.url).toBe("https://notes.example.com/v1/account");
    expect(send.calls[0]?.headers.authorization).toBe("Bearer " + "t".repeat(32));
    expect(JSON.parse(send.calls[0]?.body ?? "{}")).toMatchObject({ bootstrapCode: "boot_abc" });
  });

  it("不带令牌（注册前）不发 Authorization 头", async () => {
    const send = jsonSend(200, { notebooks: [] });
    const api = await openAccountApi({ baseUrl: "https://notes.example.com" }, send);
    await api.listNotebooks();
    expect(send.calls[0]?.headers.authorization).toBeUndefined();
  });
});
