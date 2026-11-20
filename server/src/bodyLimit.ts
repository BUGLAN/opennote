/**
 * 请求体上限（应用装配层，所有路由共用）。
 *
 * 只在路由里比较 `bytes.byteLength` 太晚：`await c.req.arrayBuffer()` /
 * `c.req.json()` 已经把整个流读进内存，未认证请求可以先用一个超大 body 把进程打满。
 * 这里在进入路由前做两件事：
 *
 * 1. `Content-Length` 已超限：不读 body，立即 413；
 * 2. 没有长度或长度不可信：按实际读取的字节计数，超过上限就中止并 413。
 *
 * 通过检查的 body 会以 `ArrayBuffer` 放进 Hono 的 `bodyCache`，路由读到的仍是同一份
 * 字节，不会再次从网络流拉取。
 */

import type { Context, MiddlewareHandler } from "hono";

export interface BodyLimitOptions {
  /** 当前请求允许的最大字节数；返回 ≤ 0 表示不限。 */
  limitFor: (c: Context) => number;
}

export function bodyLimit(options: BodyLimitOptions): MiddlewareHandler {
  return async (c, next) => {
    const limit = options.limitFor(c);
    if (!Number.isFinite(limit) || limit <= 0) {
      await next();
      return;
    }

    const request = c.req.raw;
    if (request.body === null) {
      await next();
      return;
    }

    const declared = contentLengthOf(request.headers);
    if (declared !== null && declared > limit) {
      await request.body.cancel().catch(() => undefined);
      return tooLarge(limit);
    }

    const body = await readAtMost(request.body, limit);
    if (body === null) return tooLarge(limit);
    // Hono 的 `BodyCache` 类型写的是解析结果，运行时实际存的是 Promise（见 #cachedBody）。
    (c.req.bodyCache as Record<string, unknown>).arrayBuffer = Promise.resolve(body);
    await next();
  };
}

function contentLengthOf(headers: Headers): number | null {
  const raw = headers.get("content-length");
  if (raw === null) return null;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null;
}

/**
 * 读完受限的 body。返回 `null` 表示超限。
 *
 * `Content-Length` 不可信，不能拿它预分配（否则声明 32 MiB、一个字节不发也能占住
 * 内存）。这里只按**实际收到**的分块累计；超过上限立即取消上游。
 */
async function readAtMost(stream: ReadableStream<Uint8Array>, limit: number): Promise<ArrayBuffer | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;

      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  if (chunks.length === 0) return new ArrayBuffer(0);
  if (chunks.length === 1) return exactBuffer(chunks[0]!);

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

function exactBuffer(value: Uint8Array): ArrayBuffer {
  return (value.byteOffset === 0 && value.byteLength === value.buffer.byteLength ? value.buffer : value.slice().buffer) as ArrayBuffer;
}

function tooLarge(limit: number): Response {
  return new Response(JSON.stringify({ error: `请求体超过上限（${limit} 字节）`, code: "too-large" }), {
    status: 413,
    headers: {
      "content-type": "application/json; charset=utf-8",
      // 超限请求通常还有大量未读字节；关闭连接比继续读完更省资源。
      connection: "close",
    },
  });
}
