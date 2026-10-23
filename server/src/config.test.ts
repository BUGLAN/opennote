/**
 * 服务端配置的用例（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §1.3、§4.11、§8.1）。
 *
 * 重点不是「能解析」，而是**该拦的必须拦住**：这个服务是唯一公网入口，
 * 一个悄悄取默认值的凭据或猜出来的基址，后果是「数据写进错的库」或「凭据是空的」。
 */
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../shared/contract";
import { ConfigError, REQUIRED_ENV_KEYS, clientIpFrom, describeConfig, loadConfig } from "./config";

/** 一份最小合法环境。 */
function baseEnv(): Record<string, string> {
  return {
    EXTERNAL_BASE_URL: "https://notes.example.com",
    COUCH_URL: "http://couchdb:5984",
    COUCH_USER: "sync-service",
    COUCH_PASSWORD: "not-a-real-password",
    COUCH_ADMIN_USER: "admin",
    COUCH_ADMIN_PASSWORD: "not-a-real-admin-password",
  };
}

describe("缺失即启动失败（没有安全默认值）", () => {
  it("六个必填项全缺时**一次说清**（不要让人跑十遍）", () => {
    let problems: string[] = [];
    try {
      loadConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      problems = (error as ConfigError).problems;
    }
    for (const key of REQUIRED_ENV_KEYS) {
      expect(problems.some((item) => item.includes(key))).toBe(true);
    }
  });

  it("只缺一个也拦（不给默认值兜底）", () => {
    const env = baseEnv();
    delete env.COUCH_PASSWORD;
    expect(() => loadConfig(env)).toThrow(/COUCH_PASSWORD/);
  });

  it("空字符串等于缺失（`COUCH_PASSWORD=` 不算配了）", () => {
    expect(() => loadConfig({ ...baseEnv(), COUCH_PASSWORD: "   " })).toThrow(/COUCH_PASSWORD/);
  });
});

describe("EXTERNAL_BASE_URL 的形状", () => {
  it("去尾斜杠、保留子路径（同一个 hostname 可以挂在子路径下）", () => {
    expect(loadConfig({ ...baseEnv(), EXTERNAL_BASE_URL: "https://notes.example.com/" }).externalBaseUrl).toBe("https://notes.example.com");
    expect(loadConfig({ ...baseEnv(), EXTERNAL_BASE_URL: "https://example.com/notes/" }).externalBaseUrl).toBe("https://example.com/notes");
  });

  it("不是 URL / 协议不对都拦", () => {
    expect(() => loadConfig({ ...baseEnv(), EXTERNAL_BASE_URL: "notes.example.com" })).toThrow(/不是合法 URL/);
    expect(() => loadConfig({ ...baseEnv(), EXTERNAL_BASE_URL: "ftp://notes.example.com" })).toThrow(/协议/);
  });
});

describe("COUCH_URL", () => {
  it("必须有协议前缀", () => {
    expect(() => loadConfig({ ...baseEnv(), COUCH_URL: "couchdb:5984" })).toThrow(/http/);
  });

  it("去尾斜杠", () => {
    expect(loadConfig({ ...baseEnv(), COUCH_URL: "http://couchdb:5984/" }).couchUrl).toBe("http://couchdb:5984");
  });
});

describe("协议版本自检（§8.1）", () => {
  it("默认取 shared/contract.ts 的常量（唯一产地）", () => {
    expect(loadConfig(baseEnv()).protocolVersionExpected).toBe(PROTOCOL_VERSION);
  });

  it("显式配成不一致时**拒绝启动**（镜像与服务端代码版本错配）", () => {
    expect(() => loadConfig({ ...baseEnv(), PROTOCOL_VERSION_EXPECTED: String(PROTOCOL_VERSION + 1) })).toThrow(/版本错配/);
  });
});

describe("入口相关三项不绑定厂商（§1.3）", () => {
  it("SSE 心跳默认 25s，且必须在合理区间内", () => {
    expect(loadConfig(baseEnv()).sseHeartbeatMs).toBe(25000);
    expect(() => loadConfig({ ...baseEnv(), SSE_HEARTBEAT_MS: "500" })).toThrow(/太密/);
    expect(() => loadConfig({ ...baseEnv(), SSE_HEARTBEAT_MS: "120000" })).toThrow(/读超时/);
  });

  it("TRUSTED_PROXY_HEADERS **默认空 = 谁都不信**", () => {
    const config = loadConfig(baseEnv());
    expect(config.trustedProxyHeaders).toEqual([]);
    // 默认配置下，任何代理头都不认。
    const headers = new Headers({ "cf-connecting-ip": "1.2.3.4", "x-forwarded-for": "5.6.7.8" });
    expect(clientIpFrom(headers, config)).toBeNull();
  });

  it("配了才认，且大小写不敏感、取逗号列表的**最后一跳**", () => {
    const config = loadConfig({ ...baseEnv(), TRUSTED_PROXY_HEADERS: "CF-Connecting-IP" });
    expect(config.trustedProxyHeaders).toEqual(["cf-connecting-ip"]);
    expect(clientIpFrom(new Headers({ "cf-connecting-ip": "1.2.3.4" }), config)).toBe("1.2.3.4");
    // `x-forwarded-for` 可能是列表：取最后一跳（最近的那个），不是可伪造的第一个。
    const multi = loadConfig({ ...baseEnv(), TRUSTED_PROXY_HEADERS: "x-forwarded-for" });
    expect(clientIpFrom(new Headers({ "x-forwarded-for": "9.9.9.9, 5.6.7.8" }), multi)).toBe("5.6.7.8");
  });
});

describe("数值项的校验", () => {
  it("非法正整数会拦（不是静默取默认值）", () => {
    expect(() => loadConfig({ ...baseEnv(), MAX_FILE_BYTES: "abc" })).toThrow(/MAX_FILE_BYTES/);
    expect(() => loadConfig({ ...baseEnv(), PORT: "-1" })).toThrow(/PORT/);
    expect(() => loadConfig({ ...baseEnv(), LOG_LEVEL: "verbose" })).toThrow(/LOG_LEVEL/);
  });

  it("突发容量可以单独配（令牌桶的 burst）", () => {
    const config = loadConfig({ ...baseEnv(), ACCOUNT_BURST: "50", GLOBAL_BURST: "7" });
    expect(config.accountBurst).toBe(50);
    expect(config.globalBurst).toBe(7);
  });

  it("没配的数值项用 §4.11 的默认值", () => {
    const config = loadConfig(baseEnv());
    expect(config.port).toBe(8787);
    expect(config.maxFileBytes).toBe(33554432);
    expect(config.defaultAccountQuotaBytes).toBe(2147483648);
    expect(config.defaultAccountQuotaNotebooks).toBe(100);
    // ★ 2026-10-22 改：协议是「一篇一请求」，120/分钟 = 2 篇/秒，等于把正常同步按死。
    expect(config.accountRequestsPerMinute).toBe(1200);
    expect(config.accountSseConnections).toBe(4);
    expect(config.globalRequestsPerMinute).toBe(6000);
    // 突发容量默认取每分钟速率的 1/10（10 秒的量），且至少 20。
    expect(config.accountBurst).toBe(120);
    expect(config.globalBurst).toBe(600);
  });
});

describe("describeConfig 不回显凭据", () => {
  it("快照里只有非敏感项（连「配了没配」都不说，避免变成探测信号）", () => {
    const snapshot = describeConfig(loadConfig(baseEnv()));
    const text = JSON.stringify(snapshot);
    expect(text).not.toContain("not-a-real-password");
    expect(text).not.toContain("not-a-real-admin-password");
    expect(Object.keys(snapshot)).not.toContain("couchPassword");
    expect(Object.keys(snapshot)).not.toContain("couchUser");
    // 但该有的诊断信息要有。
    expect(snapshot.couchUrl).toBe("http://couchdb:5984");
    expect(snapshot.protocolVersionExpected).toBe(PROTOCOL_VERSION);
  });
});

describe("config 里**没有**的东西（都是刻意的）", () => {
  it("没有 SESSION_SECRET（本版没有会话签名，§8.1）", () => {
    const keys = Object.keys(loadConfig(baseEnv()));
    expect(keys).not.toContain("sessionSecret");
  });

  it("没有任何口令相关项（密钥即身份，§1.5）", () => {
    const keys = Object.keys(loadConfig(baseEnv())).map((key) => key.toLowerCase());
    expect(keys.some((key) => key.includes("password") && key !== "couchpassword" && key !== "couchadminpassword")).toBe(false);
    expect(keys.some((key) => key.includes("scrypt") || key.includes("argon"))).toBe(false);
  });
});
