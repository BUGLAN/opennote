import { afterEach, describe, expect, it, vi } from "vitest";
import {
  INPAGE_HELLO,
  INPAGE_IMPORT,
  INPAGE_MAX_BYTES,
  INPAGE_READY,
  INPAGE_RESULT,
  createInpageBridge,
  inpagePayloadBytes,
  readInpageMessage,
  validateInpageEvent,
  type InpageEventLike,
  type InpageHost,
} from "./inpageBridge";
import { getImportChannelContext, resetImportChannelContext, type EnvelopeOutcome, type ImportReceipt } from "./receive";

const PAGE_ORIGIN = "https://buglan.github.io";

/** 一个最小宿主：记录发出去的消息、能被驱动的监听器、以及脱敏告警。 */
function fakeHost() {
  const sent: { data: unknown; targetOrigin: string }[] = [];
  const warnings: string[] = [];
  const self = { name: "page-window" };
  let handler: ((event: InpageEventLike) => void) | null = null;
  const host: InpageHost = {
    window: () => self,
    origin: () => PAGE_ORIGIN,
    onMessage: (next) => {
      handler = next;
      return () => {
        handler = null;
      };
    },
    post: (data, targetOrigin) => {
      sent.push({ data, targetOrigin });
    },
    warn: (message) => {
      warnings.push(message);
    },
  };
  return {
    host,
    self,
    sent,
    warnings,
    emit: (event: InpageEventLike) => handler?.(event),
    detached: () => handler === null,
  };
}

/** 驱动一次异步的 `import` 处理（处理器里是 `void handleImport(...)`）。 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function event(data: unknown, overrides: Partial<InpageEventLike> = {}): InpageEventLike {
  return { source: null, origin: PAGE_ORIGIN, data, ...overrides };
}

const RECEIPT: ImportReceipt = {
  status: "created",
  importId: "3f9a1c02-7e41-4b90-8a35-1d2c4f6a8b90",
  path: "剪藏/标题.md",
  inboxId: null,
  deduped: false,
  dedupedBy: null,
  revertible: true,
  preimage: null,
  assets: [],
  tags: [],
  warnings: [],
  message: "已从网页剪藏：标题。",
};

afterEach(() => {
  resetImportChannelContext();
});

describe("readInpageMessage", () => {
  it("接受四条已知类型里的入站两条", () => {
    const read = readInpageMessage({ type: INPAGE_HELLO, v: 1, reqId: "r1" });
    expect(read).toEqual({ ok: true, message: { type: INPAGE_HELLO, v: 1, reqId: "r1", envelope: undefined } });
    expect(readInpageMessage({ type: INPAGE_IMPORT, v: 1, reqId: "r2", envelope: {} }).ok).toBe(true);
  });

  it("前缀 / 版本 / reqId / 已知类型逐条卡死", () => {
    expect(readInpageMessage(null)).toEqual({ ok: false, reason: "not-json" });
    expect(readInpageMessage("文本")).toEqual({ ok: false, reason: "not-json" });
    expect(readInpageMessage({ type: "other:hello", v: 1, reqId: "r" })).toEqual({ ok: false, reason: "bad-prefix" });
    expect(readInpageMessage({ type: INPAGE_HELLO, v: 2, reqId: "r" })).toEqual({ ok: false, reason: "bad-version" });
    expect(readInpageMessage({ type: INPAGE_HELLO, v: 1 })).toEqual({ ok: false, reason: "bad-reqid" });
    expect(readInpageMessage({ type: INPAGE_HELLO, v: 1, reqId: "" })).toEqual({ ok: false, reason: "bad-reqid" });
    expect(readInpageMessage({ type: INPAGE_HELLO, v: 1, reqId: "x".repeat(65) })).toEqual({
      ok: false,
      reason: "bad-reqid",
    });
    expect(readInpageMessage({ type: "opennote:inpage:event", v: 1, reqId: "r" })).toEqual({
      ok: false,
      reason: "unknown-type",
    });
  });
});

describe("validateInpageEvent", () => {
  const self = { window: { id: "w" }, origin: PAGE_ORIGIN };

  it("只认自己窗口 + 同源 + 合法形状", () => {
    const good = validateInpageEvent(
      { source: self.window, origin: PAGE_ORIGIN, data: { type: INPAGE_HELLO, v: 1, reqId: "r" } },
      self,
    );
    expect(good.ok).toBe(true);
  });

  it("iframe 转发（source 不是自己）一律拒绝", () => {
    expect(
      validateInpageEvent(
        { source: { id: "iframe" }, origin: PAGE_ORIGIN, data: { type: INPAGE_HELLO, v: 1, reqId: "r" } },
        self,
      ),
    ).toEqual({ ok: false, reason: "not-self-window" });
  });

  it("异源拒绝（订正后的第 2 条判据是同源，不是 chrome-extension://）", () => {
    expect(
      validateInpageEvent(
        { source: self.window, origin: "https://evil.test", data: { type: INPAGE_HELLO, v: 1, reqId: "r" } },
        self,
      ),
    ).toEqual({ ok: false, reason: "foreign-origin" });
  });
});

describe("createInpageBridge", () => {
  it("hello → ready：带上真实工作区名与可写性，且 targetOrigin 是本页 origin", async () => {
    const box = fakeHost();
    createInpageBridge(box.host, {
      workspace: () => ({ name: "我的笔记", writable: true }),
      receive: vi.fn(),
    });

    box.emit(event({ type: INPAGE_HELLO, v: 1, reqId: "r1" }, { source: box.self }));

    expect(box.sent).toHaveLength(1);
    expect(box.sent[0].targetOrigin).toBe(PAGE_ORIGIN);
    expect(box.sent[0].data).toEqual({
      type: INPAGE_READY,
      v: 1,
      reqId: "r1",
      ok: true,
      workspace: { name: "我的笔记", writable: true },
    });
  });

  it("import → 先声明通道为 inpage，再回执；原样透传回执", async () => {
    const box = fakeHost();
    const receive = vi.fn(async (): Promise<EnvelopeOutcome> => ({ ok: true, status: 201, result: RECEIPT }));
    createInpageBridge(box.host, { workspace: () => ({ name: null, writable: false }), receive });

    box.emit(event({ type: INPAGE_IMPORT, v: 1, reqId: "r2", envelope: { title: "标题" } }, { source: box.self }));
    await flush();

    expect(receive).toHaveBeenCalledWith({ title: "标题" });
    // 不声明的话「外部导入先进收件箱」与 overwrite 闸门会同时静默失效
    expect(getImportChannelContext().channel).toBe("inpage");
    expect(box.sent[0].data).toEqual({ type: INPAGE_RESULT, v: 1, reqId: "r2", ok: true, result: RECEIPT });
  });

  it("import 失败 → ok:false + 结构化错误（不抛）", async () => {
    const box = fakeHost();
    const error = { code: "IMP-4007", message: "no workspace", userMessage: "Opennote 里还没有打开笔记本文件夹。", http: 409, retryable: true };
    createInpageBridge(box.host, {
      workspace: () => ({ name: null, writable: false }),
      receive: async () => ({ ok: false, error }),
    });

    box.emit(event({ type: INPAGE_IMPORT, v: 1, reqId: "r3", envelope: {} }, { source: box.self }));
    await flush();

    expect(box.sent[0].data).toEqual({ type: INPAGE_RESULT, v: 1, reqId: "r3", ok: false, error });
  });

  it("超 1 MiB → 用 IMP-4005 如实拒绝，且**不调用**接收端", async () => {
    const box = fakeHost();
    const receive = vi.fn();
    createInpageBridge(box.host, { workspace: () => ({ name: "n", writable: true }), receive });

    box.emit(
      event(
        { type: INPAGE_IMPORT, v: 1, reqId: "r4", envelope: { body: "x".repeat(INPAGE_MAX_BYTES + 16) } },
        { source: box.self },
      ),
    );
    await flush();

    expect(receive).not.toHaveBeenCalled();
    const reply = box.sent[0].data as { ok: boolean; error: { code: string; http: number } };
    expect(reply.ok).toBe(false);
    expect(reply.error.code).toBe("IMP-4005");
    expect(reply.error.http).toBe(413);
  });

  it("来源不明 / 形状不对 → 一条消息都不回，只留脱敏告警", async () => {
    const box = fakeHost();
    createInpageBridge(box.host, { workspace: () => ({ name: "n", writable: true }), receive: vi.fn() });

    box.emit(event({ type: INPAGE_HELLO, v: 1, reqId: "r" }, { source: { other: true } }));
    box.emit(event({ type: INPAGE_HELLO, v: 1, reqId: "r" }, { origin: "https://evil.test" }));
    box.emit(event({ type: "nope", v: 1, reqId: "r" }, { source: box.self }));
    await flush();

    expect(box.sent).toHaveLength(0);
    expect(box.warnings).toHaveLength(3);
    // 告警里不许出现正文（这里连 reqId 都不带）
    expect(box.warnings.every((line) => line.includes("忽略一条来源不明的页面内桥消息"))).toBe(true);
  });

  it("退订后不再处理消息", () => {
    const box = fakeHost();
    const detach = createInpageBridge(box.host, { workspace: () => ({ name: null, writable: false }), receive: vi.fn() });
    detach();
    expect(box.detached()).toBe(true);
  });
});

describe("inpagePayloadBytes", () => {
  it("按 UTF-8 字节数算（中文 3 字节），不可序列化时返回 null", () => {
    expect(inpagePayloadBytes({ a: "中" })).toBe(Buffer.byteLength(JSON.stringify({ a: "中" }), "utf8"));
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(inpagePayloadBytes(cyclic)).toBeNull();
  });
});
