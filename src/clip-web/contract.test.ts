import { describe, expect, it } from "vitest";

import {
  COMMIT_TIMEOUT_MS,
  FOLDERS_TIMEOUT_MS,
  STAGE_TIMEOUT_MS,
  checkBootPort,
  describeNetworkFailure,
  parseBoot,
  parseCommitPayload,
  parseFoldersPayload,
  parseStagePayload,
  type Parsed,
} from "./contract";

/** 判据里只关心"解析出来的是不是输入里那份"，所以失败一律抛出来而不是静默。 */
function unwrap<T>(parsed: Parsed<T>): T {
  if (!parsed.ok) throw new Error(`期望解析成功，实际失败：${parsed.message}`);
  return parsed.value;
}

function failure(parsed: Parsed<unknown>): string {
  if (parsed.ok) throw new Error("期望解析失败，实际成功了");
  return parsed.message;
}

function stagePayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ok: true,
    expiresAt: 1_800_000_000_000,
    stage: {
      url: "https://example.com/post",
      title: "一篇被剪的文章",
      body: "正文第一段",
      // 契约：selection 是布尔（这次剪藏的正文是不是来自文本选区），不是选中的那段文字。
      selection: true,
      tags: ["甲", "乙"],
      source: { site: "example.com", author: "某人", publishedAt: "2024-05-01" },
      assets: [{ name: "a.png" }, { name: "b.png" }],
      capturedAt: "2024-05-01T10:00:00.000Z",
      ...overrides,
    },
  });
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
    assets: ["a.png"],
    tags: ["甲"],
    warnings: [],
    ...overrides,
  };
}

/* ------------------------------------------------------------------ boot -- */

describe("parseBoot：桥注入的启动信息", () => {
  it("stageId / k 是从输入里读出来的，不是写死的常量", () => {
    const first = unwrap(parseBoot(JSON.stringify({ port: 8790, stageId: "stage-A", k: "key-A" })));
    const second = unwrap(parseBoot(JSON.stringify({ port: 8791, stageId: "stage-B", k: "key-B" })));
    expect(first.stageId).toBe("stage-A");
    expect(first.k).toBe("key-A");
    expect(first.port).toBe(8790);
    expect(second.stageId).toBe("stage-B");
    expect(second.k).toBe("key-B");
    expect(second.stageId).not.toBe(first.stageId);
  });

  it("端口是字符串也认（桥可能写成字符串）", () => {
    expect(unwrap(parseBoot(JSON.stringify({ port: "8795", stageId: "s", k: "k" }))).port).toBe(8795);
  });

  it("缺失 / 空白 / 非法 JSON / 不是对象，都要给一句能照做的话", () => {
    expect(failure(parseBoot(null))).toContain("重新发起剪藏");
    expect(failure(parseBoot("   "))).toContain("重新发起剪藏");
    expect(failure(parseBoot("{不是 json"))).toContain("JSON");
    expect(failure(parseBoot("[]"))).toContain("JSON 对象");
    expect(failure(parseBoot('"stage"'))).toContain("JSON 对象");
  });

  it("缺字段要点名缺的是哪一个", () => {
    expect(failure(parseBoot(JSON.stringify({ port: 8790, stageId: "s" })))).toContain("k");
    expect(failure(parseBoot(JSON.stringify({ port: 8790, k: "k" })))).toContain("stageId");
    expect(failure(parseBoot(JSON.stringify({ stageId: "s", k: "k" })))).toContain("port");
  });

  it("端口越界（0 / 70000 / 非数字）不算合法 boot", () => {
    expect(failure(parseBoot(JSON.stringify({ port: 0, stageId: "s", k: "k" })))).toContain("port");
    expect(failure(parseBoot(JSON.stringify({ port: 70000, stageId: "s", k: "k" })))).toContain("port");
    expect(failure(parseBoot(JSON.stringify({ port: "abc", stageId: "s", k: "k" })))).toContain("port");
  });
});

describe("checkBootPort：页面端口与 boot 端口必须一致", () => {
  const boot = { port: 8790, stageId: "s", k: "k" };

  it("一致就不阻止", () => {
    expect(checkBootPort(boot, "8790")).toBeNull();
  });

  it("不一致要阻止，并把两个端口都说出来", () => {
    const message = checkBootPort(boot, "8791");
    expect(message).not.toBeNull();
    expect(message).toContain("8790");
    expect(message).toContain("8791");
  });

  it("默认端口（location.port 是空串）不误报", () => {
    expect(checkBootPort(boot, "")).toBeNull();
  });
});

/* ----------------------------------------------------------------- stage -- */

describe("parseStagePayload：暂存内容", () => {
  it("读出暂存的各个字段（含 expiresAt 与附件数量）", () => {
    const stage = unwrap(parseStagePayload(200, stagePayload()));
    expect(stage.url).toBe("https://example.com/post");
    expect(stage.title).toBe("一篇被剪的文章");
    expect(stage.body).toBe("正文第一段");
    expect(stage.selection).toBe(true);
    expect(stage.tags).toEqual(["甲", "乙"]);
    expect(stage.source).toEqual({ site: "example.com", author: "某人", publishedAt: "2024-05-01" });
    expect(stage.assetCount).toBe(2);
    expect(stage.capturedAt).toBe("2024-05-01T10:00:00.000Z");
    expect(stage.expiresAt).toBe(1_800_000_000_000);
  });

  it("selection 是布尔：它是「正文是否来自选区」，不是选中的那段文字", () => {
    expect(unwrap(parseStagePayload(200, stagePayload({ selection: false }))).selection).toBe(false);
    expect(unwrap(parseStagePayload(200, stagePayload({ selection: true }))).selection).toBe(true);
    // 类型层面也不许被当成字符串用（改成字符串时 tsc 会因为这两行报错）。
    const parsed = unwrap(parseStagePayload(200, stagePayload()));
    const asBoolean: boolean = parsed.selection;
    expect(typeof asBoolean).toBe("boolean");
    // @ts-expect-error selection 是布尔，不是选中文字
    const asString: string = parsed.selection;
    void asString;
    // 桥万一给了字符串（违约），按 false 处理：它绝不参与正文的取舍。
    expect(unwrap(parseStagePayload(200, stagePayload({ selection: "选中的句子" }))).selection).toBe(false);
  });

  it("缺 body / title 时按空串处理，不抛也不编", () => {
    const stage = unwrap(parseStagePayload(200, JSON.stringify({ ok: true, stage: { url: "https://a" } })));
    expect(stage.body).toBe("");
    expect(stage.title).toBe("");
    expect(stage.selection).toBe(false);
    expect(stage.assetCount).toBe(0);
    expect(stage.expiresAt).toBeNull();
  });

  it("非 200 且带错误体：用桥的 userMessage，并附上错误码", () => {
    const text = JSON.stringify({ ok: false, error: { code: "IMP-4006", userMessage: "这次暂存已经过期了。", http: 404 } });
    const message = failure(parseStagePayload(404, text));
    expect(message).toContain("这次暂存已经过期了。");
    expect(message).toContain("IMP-4006");
  });

  it("HTTP 200 但 ok 不是 true 也算失败（不因为状态码就当作成功）", () => {
    const text = JSON.stringify({ ok: false, error: { code: "IMP-4001", userMessage: "key 不对。" } });
    expect(failure(parseStagePayload(200, text))).toContain("key 不对。");
    expect(failure(parseStagePayload(200, JSON.stringify({ stage: {} })))).toContain("失败");
  });

  it("非 JSON 的错误页要如实报 HTTP 码，不假装读懂了", () => {
    expect(failure(parseStagePayload(500, "<html>oops</html>"))).toContain("500");
  });

  it("200 但没有 stage 对象 → 失败（不当成空暂存）", () => {
    expect(failure(parseStagePayload(200, JSON.stringify({ ok: true })))).toContain("stage");
  });
});

/* --------------------------------------------------------------- folders -- */

describe("parseFoldersPayload：落点目录", () => {
  it("原样读出目录（含收件箱那一个空串），并去重", () => {
    const folders = unwrap(parseFoldersPayload(200, JSON.stringify({ ok: true, folders: ["", "归档", "归档", "剪藏/技术"] })));
    expect(folders).toEqual(["", "归档", "剪藏/技术"]);
  });

  it("空数组是「读到了、一个目录都没有」，交给视图层判空（不在这一层补收件箱）", () => {
    expect(unwrap(parseFoldersPayload(200, JSON.stringify({ ok: true, folders: [] })))).toEqual([]);
  });

  it("只有收件箱也是合法结果", () => {
    expect(unwrap(parseFoldersPayload(200, JSON.stringify({ ok: true, folders: [""] })))).toEqual([""]);
  });

  it("失败时用桥的 userMessage", () => {
    const text = JSON.stringify({ ok: false, error: { code: "IMP-4010", userMessage: "工作区还没打开。" } });
    expect(failure(parseFoldersPayload(409, text))).toContain("工作区还没打开。");
  });

  it("没有 folders 数组 → 失败（不假装只有收件箱）", () => {
    expect(failure(parseFoldersPayload(200, JSON.stringify({ ok: true })))).toContain("folders");
  });
});

/* ---------------------------------------------------------------- commit -- */

describe("parseCommitPayload：入库回执", () => {
  it("读 { ok:true, result:{...} } 这种封装（真桥 sendOk 就是这个形状）", () => {
    const receipt = unwrap(parseCommitPayload(200, JSON.stringify({ ok: true, result: receiptBody() })));
    expect(receipt.status).toBe("created");
    expect(receipt.importId).toBe("imp-0001");
    expect(receipt.path).toBe("收件箱/20240501-abc/note.md");
    expect(receipt.inboxId).toBeNull();
    expect(receipt.deduped).toBe(false);
    expect(receipt.tags).toEqual(["甲"]);
    expect(receipt.assets).toEqual(["a.png"]);
    expect(receipt.warnings).toEqual([]);
  });

  it("成功的状态码不止 200：201（新建）与 202（待处理）都必须算成功", () => {
    // 真桥 electron/bridge.cjs:1346：deduped/skipped → 200，新建 → 201，
    // 收件箱那条待处理路径由渲染层给 202。只认 200 会把成功显示成失败。
    const created = unwrap(parseCommitPayload(201, JSON.stringify({ ok: true, result: receiptBody() })));
    expect(created.status).toBe("created");
    expect(created.path).toBe("收件箱/20240501-abc/note.md");

    const pending = unwrap(
      parseCommitPayload(202, JSON.stringify({ ok: true, result: receiptBody({ status: "pending", path: null, inboxId: "inbox-9" }) })),
    );
    expect(pending.status).toBe("pending");
    expect(pending.inboxId).toBe("inbox-9");
  });

  it("非 2xx 一律算失败，即使 body 里写着 ok:true（这一层的话不可信）", () => {
    expect(failure(parseCommitPayload(500, JSON.stringify({ ok: true, result: receiptBody() })))).toContain("500");
  });

  it("平铺的 { ok:true, ...回执 } 也认（两种封装读出来必须是同一份回执）", () => {
    const flat = unwrap(parseCommitPayload(200, JSON.stringify({ ok: true, ...receiptBody() })));
    const wrapped = unwrap(parseCommitPayload(200, JSON.stringify({ ok: true, result: receiptBody() })));
    expect(flat).toEqual(wrapped);
  });

  it("null 路径与提醒原样保留（不把 null 变成空串，也不丢掉 warnings）", () => {
    const text = JSON.stringify({
      ok: true,
      result: receiptBody({ status: "pending", path: null, inboxId: "inbox-9", deduped: true, warnings: ["有 2 张图没下载下来"] }),
    });
    const receipt = unwrap(parseCommitPayload(200, text));
    expect(receipt.path).toBeNull();
    expect(receipt.inboxId).toBe("inbox-9");
    expect(receipt.deduped).toBe(true);
    expect(receipt.warnings).toEqual(["有 2 张图没下载下来"]);
  });

  it("失败回执用 userMessage，并带上错误码", () => {
    const text = JSON.stringify({ ok: false, error: { code: "IMP-4005", userMessage: "这个目录不存在，没有自动创建。", retryable: true } });
    const message = failure(parseCommitPayload(409, text));
    expect(message).toContain("这个目录不存在，没有自动创建。");
    expect(message).toContain("IMP-4005");
  });

  it("status 不在契约的六种之内 → 失败，绝不猜成「已入库」", () => {
    expect(failure(parseCommitPayload(200, JSON.stringify({ ok: true, result: receiptBody({ status: "who-knows" }) })))).toContain("status");
  });
});

/* ------------------------------------------------------------- 网络失败 --- */

describe("describeNetworkFailure：连不上与超时", () => {
  it("超时要如实说出等了多久", () => {
    const timeout = new Error("The operation was aborted due to timeout");
    timeout.name = "TimeoutError";
    const message = describeNetworkFailure(timeout, 8000);
    expect(message).toContain("超时");
    expect(message).toContain("8 秒");
  });

  it("连接被拒绝要说「连不上」，并给出可照做的动作", () => {
    const refused = new TypeError("Failed to fetch");
    const message = describeNetworkFailure(refused, 8000);
    expect(message).toContain("连不上");
    expect(message).toContain("重试");
  });

  it("其它异常也不能吞掉名字", () => {
    expect(describeNetworkFailure(new Error("boom"), 8000)).toContain("boom");
  });
});

/* -------------------------------------------------------------- 超时取值 -- */

describe("超时取值不能是无限", () => {
  it("三个超时都是正有限数（Infinity 就等于没有超时）", () => {
    for (const value of [STAGE_TIMEOUT_MS, FOLDERS_TIMEOUT_MS, COMMIT_TIMEOUT_MS]) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThan(0);
    }
  });
});
