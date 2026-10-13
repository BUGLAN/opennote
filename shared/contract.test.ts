/**
 * 线上契约的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §4.7、§10.1 F2/F3、§6.4）。
 *
 * 契约是**两侧唯一的共同语言**，所以这里的重点是：
 *   - 形状真的能挡住坏输入（而不是「schema 写了但没人用」）；
 *   - `truncated` / `resync` 这两个**语义开关**如实保留（少一个就是误删或漏拉）；
 *   - `PROTOCOL_VERSION` 闸门真的会拦（不是打印一行日志就算了）。
 */
import { describe, expect, it } from "vitest";
import {
  ContractError,
  MIN_SUPPORTED_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
  accountCreateRequestSchema,
  assertProtocolCompatible,
  changesResponseSchema,
  cryptoModeSchema,
  didSchema,
  healthResponseSchema,
  notebookCreateRequestSchema,
  notebookInviteCreateRequestSchema,
  parseContract,
  syncInfoSchema,
  treeEntrySchema,
  treeResponseSchema,
} from "./contract";

describe("PROTOCOL_VERSION 闸门（§11.3 第 2 条纪律）", () => {
  it("F3 · 常量是正整数，且最低可接受版本不超过它", () => {
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
    expect(PROTOCOL_VERSION).toBeGreaterThan(0);
    expect(MIN_SUPPORTED_PROTOCOL_VERSION).toBeLessThanOrEqual(PROTOCOL_VERSION);
  });

  it("匹配就过；不匹配**抛错**，不「尽力而为」", () => {
    expect(() => assertProtocolCompatible(PROTOCOL_VERSION)).not.toThrow();
    expect(() => assertProtocolCompatible(PROTOCOL_VERSION + 1)).toThrow(ContractError);
    // 两个方向都要拦：比服务端旧要说「请升级」，比服务端新是「服务端该升级了」。
    expect(() => assertProtocolCompatible(PROTOCOL_VERSION - 1)).toThrow(/协议版本不匹配/);
  });
});

describe("基础形状", () => {
  it("cryptoMode 只有两种取值（§1.4）", () => {
    expect(cryptoModeSchema.safeParse("none").success).toBe(true);
    expect(cryptoModeSchema.safeParse("user-key").success).toBe(true);
    expect(cryptoModeSchema.safeParse("plain").success).toBe(false);
  });

  it("did 只认 `f:`（模式 A）与 `h:`（模式 B）两种前缀", () => {
    expect(didSchema.safeParse("f:bm90ZXMvYS5tZA").success).toBe(true);
    expect(didSchema.safeParse(`h:${"a".repeat(32)}`).success).toBe(true);
    expect(didSchema.safeParse("x:bm90ZXM").success).toBe(false);
    expect(didSchema.safeParse("f:not base64url!").success).toBe(false);
    expect(didSchema.safeParse("").success).toBe(false);
  });
});

describe("账号契约 · 密钥材料不许出现在请求里（红线 3）", () => {
  const valid = {
    accountId: "a".repeat(32),
    authToken: "t".repeat(43),
    wrappedEncRoot: "w".repeat(64),
    inviteCode: "invite-code-12345678",
  };

  it("最小合法请求能过", () => {
    expect(accountCreateRequestSchema.safeParse(valid).success).toBe(true);
  });

  it("`accountKey` / `encRoot` / `wrapKey` 这类字段**不在** schema 里（多余字段被丢弃）", () => {
    const parsed = accountCreateRequestSchema.parse({
      ...valid,
      // 客户端如果哪天顺手把这些发上来，zod 默认会**剥掉**未声明字段——
      // 但真正的护栏是 K1 断言（P2 实现）：服务端库里搜不到任何等于密钥的值。
      accountKey: "should-never-be-sent",
      encRoot: "should-never-be-sent",
    });
    expect("accountKey" in parsed).toBe(false);
    expect("encRoot" in parsed).toBe(false);
  });

  it("形状不对的 accountId / authToken 被拒", () => {
    expect(accountCreateRequestSchema.safeParse({ ...valid, accountId: "short" }).success).toBe(false);
    expect(accountCreateRequestSchema.safeParse({ ...valid, accountId: "A".repeat(32) }).success).toBe(false);
    expect(accountCreateRequestSchema.safeParse({ ...valid, authToken: "too-short" }).success).toBe(false);
  });
});

describe("笔记本契约", () => {
  it("§11.3 A · cryptoMode 默认 'none'（P2 先跑通明文，P4 再改默认值）", () => {
    const parsed = notebookCreateRequestSchema.parse({ name: "我的笔记本" });
    expect(parsed.cryptoMode).toBe("none");
  });

  it("笔记本邀请码只能是 editor / viewer（owner 不可通过邀请码分发）", () => {
    expect(notebookInviteCreateRequestSchema.safeParse({ role: "editor" }).success).toBe(true);
    expect(notebookInviteCreateRequestSchema.safeParse({ role: "viewer" }).success).toBe(true);
    expect(notebookInviteCreateRequestSchema.safeParse({ role: "owner" }).success).toBe(false);
  });
});

describe("同步数据面 · 两个语义开关必须如实保留", () => {
  it("tree 条目必须带 hash 或 ehash（少了两边就没法比「谁改没改」）", () => {
    expect(treeEntrySchema.safeParse({ did: "f:abc", rev: "1-abc", hash: "a".repeat(64) }).success).toBe(true);
    expect(treeEntrySchema.safeParse({ did: "f:abc", rev: "1-abc", ehash: "b".repeat(64) }).success).toBe(true);
    expect(treeEntrySchema.safeParse({ did: "f:abc", rev: "1-abc" }).success).toBe(false);
  });

  it("§6.4 · tree 响应必须带 truncated（少了它就会把「没取到」当成「被删了」）", () => {
    expect(treeResponseSchema.parse({ cursor: "1-abc", truncated: true, files: [] }).truncated).toBe(true);
    expect(treeResponseSchema.safeParse({ cursor: "1-abc", files: [] }).success).toBe(false);
  });

  it("§6.4 · changes 响应支持 resync（游标过期 → 退化成全树比对）", () => {
    const parsed = changesResponseSchema.parse({
      cursor: "5-xyz",
      resync: true,
      changes: [{ did: "f:abc", op: "delete" }],
    });
    expect(parsed.resync).toBe(true);
    expect(parsed.changes[0]!.op).toBe("delete");
    // resync 是可选的（只在真的过期时才出现）。
    expect(changesResponseSchema.safeParse({ cursor: "5-xyz", changes: [] }).success).toBe(true);
  });

  it("cursor 是不透明**字符串**（不是数字，§4.7 设计点 4）", () => {
    expect(treeResponseSchema.safeParse({ cursor: 42, truncated: false, files: [] }).success).toBe(false);
    expect(treeResponseSchema.safeParse({ cursor: "42", truncated: false, files: [] }).success).toBe(true);
    // CouchDB 2.0 起 update sequence 可以是任意 JSON —— 只要是非空字符串就接受。
    expect(treeResponseSchema.safeParse({ cursor: "7-g1AAAA", truncated: false, files: [] }).success).toBe(true);
  });

  it("op 只有 add / update / delete", () => {
    expect(changesResponseSchema.safeParse({ cursor: "1", changes: [{ did: "f:a", op: "rename" }] }).success).toBe(false);
  });
});

describe("syncinfo 与 health（协议 + 加密模式的双重闸门）", () => {
  it("syncinfo 必须同时带 protocolVersion 与 cryptoMode", () => {
    expect(syncInfoSchema.safeParse({ protocolVersion: 1, cryptoMode: "user-key", createdAt: "2026-10-13T00:00:00Z" }).success).toBe(true);
    expect(syncInfoSchema.safeParse({ protocolVersion: 1, createdAt: "2026-10-13T00:00:00Z" }).success).toBe(false);
  });

  it("health 允许 couchVersion / webBuildHash 为 null（未就绪时也要能报健康）", () => {
    const parsed = healthResponseSchema.parse({
      ok: true,
      protocolVersion: PROTOCOL_VERSION,
      minSupportedProtocolVersion: MIN_SUPPORTED_PROTOCOL_VERSION,
      webBuildHash: null,
      couchVersion: null,
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.webBuildHash).toBeNull();
  });
});

describe("parseContract：统一的失败口径", () => {
  it("成功时返回解析后的值", () => {
    expect(parseContract(cryptoModeSchema, "none", "测试")).toBe("none");
  });

  it("失败时错误信息带**字段路径**（否则线上排查只能猜）", () => {
    let message = "";
    try {
      parseContract(syncInfoSchema, { cryptoMode: "user-key" }, "/v1/notebooks/x");
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("/v1/notebooks/x");
    expect(message).toContain("protocolVersion");
    expect(message).toContain("形状不符合契约");
  });

  it("抛的是 ContractError（调用方按类型映射状态码，不靠匹配文案）", () => {
    expect(() => parseContract(cryptoModeSchema, "nope", "测试")).toThrow(ContractError);
  });
});
