import { afterEach, describe, expect, it, vi } from "vitest";

import type { ClipBoot } from "./contract";
import { COMMIT_URL, buildCommitBody, commitClip, foldersUrl, loadFolders, loadStage, stageUrl } from "./requests";

const BOOT: ClipBoot = { port: 8790, stageId: "stage-A", k: "key-A" };

interface Captured {
  url: string;
  init: RequestInit;
}

/** 记下「真正发出去的那一次请求」，判据才好盯用户看得见的路径。 */
function capture(body: unknown, status = 200): { calls: Captured[] } {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }),
    );
  });
  return { calls };
}

function receiptBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    status: "created",
    importId: "imp-0001",
    path: "收件箱/20240501-abc/note.md",
    inboxId: null,
    deduped: false,
    revertible: true,
    preimage: null,
    assets: [],
    tags: [],
    warnings: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("URL 与请求体：一个产地", () => {
  it("stage / folders 的 URL 带上真实的 stageId 与 k", () => {
    expect(stageUrl(BOOT)).toBe("/v1/clip/stage?stageId=stage-A&k=key-A");
    expect(foldersUrl(BOOT)).toBe("/v1/clip/folders?stageId=stage-A&k=key-A");
    expect(stageUrl({ port: 8791, stageId: "stage-B", k: "key-B" })).not.toBe(stageUrl(BOOT));
  });

  it("URL 里的 stageId / k 做转义（不拼出坏查询串）", () => {
    const weird: ClipBoot = { port: 8790, stageId: "a b&c", k: "k/1?" };
    expect(stageUrl(weird)).toBe(`/v1/clip/stage?stageId=${encodeURIComponent("a b&c")}&k=${encodeURIComponent("k/1?")}`);
    expect(foldersUrl(weird)).toContain(encodeURIComponent("k/1?"));
  });

  it("落点原样送出：空 = 收件箱，非空 = 用户选的目录（页面不改写目录名）", () => {
    expect(buildCommitBody(BOOT, { title: "t", body: "b", folder: "" }).folder).toBe("");
    expect(buildCommitBody(BOOT, { title: "t", body: "b", folder: "归档" }).folder).toBe("归档");
    expect(buildCommitBody(BOOT, { title: "t", body: "b", folder: "剪藏/技术" }).folder).toBe("剪藏/技术");
  });

  it("请求体的 stageId / k 来自 boot，不是写死的", () => {
    const other: ClipBoot = { port: 8791, stageId: "stage-B", k: "key-B" };
    expect(buildCommitBody(other, { title: "t", body: "b", folder: "" })).toMatchObject({ stageId: "stage-B", k: "key-B" });
  });
});

describe("commitClip：发出去的是编辑后的内容", () => {
  it("POST 到 /v1/clip/commit，body 是编辑后的标题/正文 + 用户选的落点", async () => {
    const stub = capture({ ok: true, result: receiptBody() });
    const result = await commitClip(BOOT, { title: "改过的标题", body: "改过的正文", folder: "归档" });

    expect(result.ok).toBe(true);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].url).toBe(COMMIT_URL);
    expect(stub.calls[0].init.method).toBe("POST");
    const sent = JSON.parse(String(stub.calls[0].init.body)) as Record<string, unknown>;
    expect(sent).toEqual({ stageId: "stage-A", k: "key-A", title: "改过的标题", body: "改过的正文", folder: "归档" });
  });

  it("入库失败时把桥的 userMessage 原样交回（附错误码）", async () => {
    capture({ ok: false, error: { code: "IMP-4005", userMessage: "这个目录不存在，没有自动创建。", retryable: true } }, 409);
    const result = await commitClip(BOOT, { title: "t", body: "b", folder: "不存在的目录" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("这个目录不存在，没有自动创建。");
    expect(result.message).toContain("IMP-4005");
  });
});

describe("读暂存与读目录", () => {
  it("loadStage 解析出暂存内容", async () => {
    capture({ ok: true, stage: { url: "https://example.com", title: "标题", body: "正文" }, expiresAt: 1 });
    const result = await loadStage(BOOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.body).toBe("正文");
  });

  it("loadFolders 读回目录列表", async () => {
    capture({ ok: true, folders: ["", "归档"] });
    const result = await loadFolders(BOOT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual(["", "归档"]);
  });

  it("连不上（TypeError）时说人话，而不是抛出去", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));
    const result = await loadStage(BOOT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("连不上");
  });
});

describe("每个请求都要有超时", () => {
  it("超时后中止请求并报超时，不会一直等下去", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    vi.stubGlobal("fetch", (_url: string, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        // 没有 signal 就让它一直挂着：这条用例会因为等不到结果而变红。
        if (!signal) return;
        signal.addEventListener("abort", () => reject(signal.reason));
      });
    });

    const started = Date.now();
    const result = await loadStage(BOOT, 30);
    const elapsed = Date.now() - started;

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(elapsed).toBeLessThan(3000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.message).toContain("超时");
  });

  it("请求不代持凭据、不读缓存（页面永不持有长期令牌）", async () => {
    const stub = capture({ ok: true, folders: [""] });
    await loadFolders(BOOT);
    expect(stub.calls[0].init.credentials).toBe("omit");
    expect(stub.calls[0].init.cache).toBe("no-store");
  });

  it("POST 带 json 内容类型，GET 不带 body", async () => {
    const stub = capture({ ok: true, folders: [""] });
    await loadFolders(BOOT);
    const headers = stub.calls[0].init.headers as Record<string, string>;
    expect(headers.accept).toBe("application/json");
    expect(headers["content-type"]).toBeUndefined();
    expect(stub.calls[0].init.body).toBeUndefined();

    const post = capture({ ok: true, result: receiptBody() });
    await commitClip(BOOT, { title: "t", body: "b", folder: "" });
    const postHeaders = post.calls[0].init.headers as Record<string, string>;
    expect(postHeaders["content-type"]).toBe("application/json");
  });
});
