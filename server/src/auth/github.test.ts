import { describe, expect, it } from "vitest";
import { LOGIN_CODE_TTL_MS, OAUTH_TTL_MS, OAuthFlowError, OAuthFlows } from "./github";

const START = { mode: "panel" as const };

describe("OAuth 待处理 state 的上限", () => {
  it("同一来源到上限后拒绝新 state，finish 后释放名额", () => {
    const flows = new OAuthFlows({ limits: { statesPerSource: 2, statesGlobal: 10 } });
    const first = flows.begin(START, "203.0.113.7", 1_000);
    flows.begin(START, "203.0.113.7", 1_000);
    expect(() => flows.begin(START, "203.0.113.7", 1_000)).toThrowError(OAuthFlowError);
    expect(flows.stats(1_000).states).toBe(2);

    expect(flows.finish(first, 1_001)).toEqual(START);
    expect(() => flows.begin(START, "203.0.113.7", 1_001)).not.toThrow();
  });

  it("全局上限跨来源生效，来源未知也计入", () => {
    const flows = new OAuthFlows({ limits: { statesPerSource: 2, statesGlobal: 3 } });
    flows.begin(START, "a", 1_000);
    flows.begin(START, "b", 1_000);
    flows.begin(START, "unknown", 1_000);
    expect(() => flows.begin(START, "c", 1_000)).toThrowError(OAuthFlowError);
  });

  it("过期 state 在分配前被清掉，不会永久占名额", () => {
    const flows = new OAuthFlows({ limits: { statesPerSource: 1, statesGlobal: 1 } });
    flows.begin(START, "x", 1_000);
    expect(() => flows.begin(START, "x", 1_000 + OAUTH_TTL_MS - 1)).toThrowError(OAuthFlowError);
    expect(() => flows.begin(START, "x", 1_000 + OAUTH_TTL_MS)).not.toThrow();
  });
});

describe("登录码与绑定票的上限", () => {
  it("登录码按账号与全局限制，兑换（含失败）后释放", () => {
    const flows = new OAuthFlows({ limits: { loginCodesPerAccount: 1, loginCodesGlobal: 2 } });
    const code = flows.issueLoginCode("a", "challenge", 1_000);
    expect(() => flows.issueLoginCode("a", "challenge", 1_000)).toThrowError(OAuthFlowError);
    flows.issueLoginCode("b", "challenge", 1_000);
    expect(() => flows.issueLoginCode("c", "challenge", 1_000)).toThrowError(OAuthFlowError);

    // verifier 不对也会作废，名额同样释放。
    expect(flows.redeemLoginCode(code, "wrong", 1_001)).toBeNull();
    expect(() => flows.issueLoginCode("a", "challenge", 1_001)).not.toThrow();
  });

  it("登录码过期后可重新签发", () => {
    const flows = new OAuthFlows({ limits: { loginCodesPerAccount: 1, loginCodesGlobal: 1 } });
    flows.issueLoginCode("a", "challenge", 1_000);
    expect(() => flows.issueLoginCode("a", "challenge", 1_000 + LOGIN_CODE_TTL_MS - 1)).toThrowError(OAuthFlowError);
    expect(() => flows.issueLoginCode("a", "challenge", 1_000 + LOGIN_CODE_TTL_MS)).not.toThrow();
  });

  it("绑定票按账号与全局限制，兑换后释放", () => {
    const flows = new OAuthFlows({ limits: { linkTicketsPerAccount: 1, linkTicketsGlobal: 2 } });
    const ticket = flows.issueLinkTicket("a", 1_000);
    expect(() => flows.issueLinkTicket("a", 1_000)).toThrowError(OAuthFlowError);
    flows.issueLinkTicket("b", 1_000);
    expect(() => flows.issueLinkTicket("c", 1_000)).toThrowError(OAuthFlowError);

    expect(flows.redeemLinkTicket(ticket, 1_001)).toBe("a");
    expect(() => flows.issueLinkTicket("a", 1_001)).not.toThrow();
  });
});
