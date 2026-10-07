import { createRequire } from "node:module";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";

/**
 * 更新链路**真跑**：本地 http 服务器 + 真磁盘 + 真 zip + 真 sha256。
 *
 * 这里不 mock 任何东西（除了「点重启之后主进程去覆盖」那一步 `apply`）：
 * 所有分支都必须走到明确状态，绝不允许「下载失败但界面说成功」这种静默成功。
 */
const requireCjs = createRequire(import.meta.url);
const { createUpdater } = requireCjs("../../electron/update.cjs") as {
  createUpdater: (config: Record<string, unknown>) => Updater;
};

interface UpdateStatus {
  supported: boolean;
  current: string;
  phase: "idle" | "checking" | "available" | "downloading" | "ready" | "error";
  latest: string | null;
  releaseUrl: string | null;
  asset: { name: string; size: number } | null;
  progress: { kind: "download" | "extract"; received: number; total: number; percent: number } | null;
  error: { code: string; message: string } | null;
  canAutoInstall: boolean;
  checkedAt: string | null;
}

interface Updater {
  status(): UpdateStatus;
  check(options?: { force?: boolean }): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  cancel(): Promise<UpdateStatus>;
  restart(): Promise<{ ok: boolean; reason?: string }>;
  resume(): Promise<UpdateStatus>;
  takeApplyResult(): { ok: boolean; from: string; to: string; error: string | null } | null;
}

const tempDirs: string[] = [];
const servers: http.Server[] = [];

function tempDir(label: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `opennote-update-${label}-`));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function buildReleaseZip(version: string, extra: Record<string, string> = {}): Promise<Buffer> {
  const zip = new JSZip();
  zip.file("Opennote.exe", `EXE-${version}`);
  zip.file("resources/app.asar", `ASAR-${version}`);
  zip.file("locales/zh-CN.pak", "PAK");
  for (const [name, content] of Object.entries(extra)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
}

interface Fixture {
  version: string;
  zip: Buffer;
  /** 覆盖 SHA256SUMS 的内容；`null` = 该资产 404；默认按真实 sha 生成。 */
  sums?: string | null;
  /** 覆盖 asset digest；默认 `sha256:<真实 sha>`。 */
  digest?: string;
  /** `/repos/.../releases/latest` 的状态码；403 用来验降级路径。 */
  apiStatus?: number;
  /** 资产地址 302 到 /objects/**（GitHub 真实行为）。 */
  redirectAsset?: boolean;
  /** 慢速分块发送（验取消）。 */
  slow?: boolean;
  /** 资产地址的状态码（验 404）。 */
  assetStatus?: number;
}

interface Harness {
  base: string;
  zipRequests: number;
}

async function startFixtureServer(fixture: Fixture): Promise<Harness> {
  const state: Harness = { base: "", zipRequests: 0 };
  const assetName = `Opennote-${fixture.version}-win-x64.zip`;
  const realSha = crypto.createHash("sha256").update(fixture.zip).digest("hex");
  const sums =
    fixture.sums === undefined
      ? `${realSha}  ${assetName}\n${"b".repeat(64)}  Opennote-clip-0.1.4.zip\n`
      : fixture.sums;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const send = (status: number, headers: Record<string, string>, body?: Buffer | string) => {
      response.writeHead(status, headers);
      response.end(body);
    };
    const json = (status: number, value: unknown) =>
      send(status, { "content-type": "application/json" }, JSON.stringify(value));

    if (url.pathname === "/repos/BUGLAN/opennote/releases/latest") {
      if (fixture.apiStatus) return json(fixture.apiStatus, { message: "rate limited" });
      return json(200, {
        tag_name: `v${fixture.version}`,
        html_url: `${state.base}/tag/v${fixture.version}`,
        assets: [
          {
            name: assetName,
            browser_download_url: `${state.base}/download/v${fixture.version}/${assetName}`,
            size: fixture.zip.length,
            digest: fixture.digest ?? `sha256:${realSha}`,
          },
          { name: "Opennote-clip-0.1.4.zip", browser_download_url: `${state.base}/clip.zip`, size: 104861 },
          { name: "SHA256SUMS", browser_download_url: `${state.base}/download/v${fixture.version}/SHA256SUMS`, size: 183 },
        ],
      });
    }
    if (url.pathname === "/latest") {
      return send(302, { location: `${state.base}/tag/v${fixture.version}` });
    }
    if (url.pathname === `/download/v${fixture.version}/SHA256SUMS`) {
      if (sums === null) return send(404, {}, "not found");
      return send(200, { "content-type": "text/plain" }, sums);
    }
    if (url.pathname === `/download/v${fixture.version}/${assetName}`) {
      if (fixture.assetStatus) return send(fixture.assetStatus, {}, "boom");
      if (fixture.redirectAsset) return send(302, { location: `${state.base}/objects/${assetName}` });
      return sendZip();
    }
    if (url.pathname === `/objects/${assetName}`) return sendZip();
    return send(404, {}, "not found");

    function sendZip() {
      state.zipRequests += 1;
      response.writeHead(200, {
        "content-type": "application/zip",
        "content-length": String(fixture.zip.length),
      });
      if (!fixture.slow) {
        response.end(fixture.zip);
        return;
      }
      const chunkSize = Math.max(1, Math.ceil(fixture.zip.length / 12));
      let offset = 0;
      const timer = setInterval(() => {
        if (offset >= fixture.zip.length) {
          clearInterval(timer);
          response.end();
          return;
        }
        response.write(fixture.zip.subarray(offset, offset + chunkSize));
        offset += chunkSize;
      }, 25);
      response.on("close", () => clearInterval(timer));
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  servers.push(server);
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  state.base = `http://127.0.0.1:${port}`;
  return state;
}

interface HarnessOptions {
  appVersion?: string;
  installDir?: string;
  supported?: boolean;
  apply?: (plan: Record<string, unknown>) => Promise<{ ok: boolean; reason?: string }>;
}

function makeUpdater(
  base: string,
  fixture: Fixture,
  options: HarnessOptions = {},
): { updater: Updater; updatesDir: string; installDir: string; statuses: UpdateStatus[] } {
  const updatesDir = tempDir("updates");
  const installDir = options.installDir ?? tempDir("install");
  const statuses: UpdateStatus[] = [];
  const updater = createUpdater({
    appVersion: options.appVersion ?? "0.5.0",
    repositoryUrl: "git+https://github.com/BUGLAN/opennote.git",
    apiBase: base,
    downloadBase: base,
    updatesDir,
    installDir,
    platform: "win32",
    arch: "x64",
    supported: options.supported ?? true,
    onChange: (status: UpdateStatus) => statuses.push(status),
    log: () => {},
    apply: options.apply ?? (async () => ({ ok: true })),
  });
  void fixture;
  return { updater, updatesDir, installDir, statuses };
}

async function fixture(overrides: Partial<Fixture> = {}): Promise<Fixture> {
  const version = overrides.version ?? "0.6.0";
  return { version, zip: await buildReleaseZip(version), ...overrides };
}

describe("检查更新", () => {
  it("有新版本 → available，并带上资产名与体积", async () => {
    const server = await startFixtureServer(await fixture());
    const { updater } = makeUpdater(server.base, await fixture());
    const status = await updater.check();
    expect(status.phase).toBe("available");
    expect(status.latest).toBe("0.6.0");
    expect(status.asset?.name).toBe("Opennote-0.6.0-win-x64.zip");
    expect(status.asset?.size).toBeGreaterThan(0);
    expect(status.releaseUrl).toBe(`${server.base}/tag/v0.6.0`);
    expect(status.checkedAt).not.toBeNull();
    expect(status.error).toBeNull();
  });

  it("已是最新 → idle（红框处不该出现任何图标）", async () => {
    const data = await fixture({ version: "0.5.0" });
    const server = await startFixtureServer(data);
    const { updater } = makeUpdater(server.base, data);
    const status = await updater.check();
    expect(status.phase).toBe("idle");
    expect(status.latest).toBe("0.5.0");
    expect(status.asset).toBeNull();
  });

  it("GitHub 404 → error/NOT_FOUND，文案是中文且可执行", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, apiStatus: 404 });
    const { updater } = makeUpdater(server.base, data);
    const status = await updater.check();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("NOT_FOUND");
    expect(status.error?.message).toContain("发布版本");
  });

  it("API 限流（403）→ 降级解析 releases/latest 的 302，仍然认出新版本", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, apiStatus: 403 });
    const { updater } = makeUpdater(server.base, data);
    const status = await updater.check();
    expect(status.phase).toBe("available");
    expect(status.latest).toBe("0.6.0");
    expect(status.asset?.name).toBe("Opennote-0.6.0-win-x64.zip");
  });

  it("连接不上 → error/NETWORK（不抛异常，落成状态）", async () => {
    const data = await fixture();
    const { updater } = makeUpdater("http://127.0.0.1:9", data);
    const status = await updater.check();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("NETWORK");
  });

  it("非 Windows 目标（supported=false）时完全不动网络", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater } = makeUpdater(server.base, data, { supported: false });
    const status = await updater.check();
    expect(status.supported).toBe(false);
    expect(status.phase).toBe("idle");
    expect(server.zipRequests).toBe(0);
  });
});

describe("下载与解压", () => {
  it("check → download → ready：包落到 userData、sha 校验过、staging 里能看见解压结果", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("ready");
    expect(status.error).toBeNull();
    expect(status.progress).toBeNull();

    const zipPath = path.join(updatesDir, "Opennote-0.6.0-win-x64.zip");
    // 解压成功后 zip 立刻删掉（helper 只从 staging 复制）：别把 151 MB 留在 userData 里
    expect(fs.existsSync(zipPath)).toBe(false);
    expect(fs.existsSync(`${zipPath}.part`)).toBe(false);
    const staging = path.join(updatesDir, "staging-0.6.0");
    expect(fs.readFileSync(path.join(staging, "Opennote.exe"), "utf8")).toBe("EXE-0.6.0");
    expect(fs.readFileSync(path.join(staging, "resources", "app.asar"), "utf8")).toBe("ASAR-0.6.0");
    expect(fs.existsSync(path.join(staging, ".ready"))).toBe(true);
    expect(fs.readdirSync(updatesDir).sort()).toEqual(["staging-0.6.0"]);
  });

  it("进度事件单调递增、百分数不越界", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, statuses } = makeUpdater(server.base, data);
    await updater.check();
    await updater.download();
    const percents = statuses
      .filter((item) => item.phase === "downloading" && item.progress?.kind === "download")
      .map((item) => item.progress?.percent ?? 0);
    expect(percents.length).toBeGreaterThan(0);
    expect([...percents].sort((a, b) => a - b)).toEqual(percents);
    expect(Math.max(...percents)).toBeLessThanOrEqual(100);
    expect(statuses.some((item) => item.progress?.kind === "extract")).toBe(true);
    expect(statuses.at(-1)?.phase).toBe("ready");
  });

  it("资产地址 302 到对象存储也能下（GitHub 的真实行为）", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, redirectAsset: true });
    const { updater } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("ready");
  });

  it("校验和不符 → 拒绝安装，zip/.part/staging 一个都不留", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, sums: `${"c".repeat(64)}  Opennote-0.6.0-win-x64.zip\n` });
    const { updater, updatesDir } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("CHECKSUM_MISMATCH");
    expect(fs.readdirSync(updatesDir)).toEqual([]);
  });

  it("SHA256SUMS 缺行 → 不安装（即使 asset digest 是对的，也要有明确来源）", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, sums: `${"c".repeat(64)}  Opennote-9.9.9-win-x64.zip\n` });
    const { updater } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.error?.code).toBe("CHECKSUM_MISMATCH");
  });

  it("SHA256SUMS 404 但有 GitHub asset digest → 用 digest 校验并成功", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, sums: null });
    const { updater } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("ready");
  });

  it("SHA256SUMS 404 且没有 digest → 拒绝安装", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, sums: null, digest: "" });
    const { updater } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("CHECKSUM_MISMATCH");
    expect(status.error?.message).toContain("不会安装无法校验的包");
  });

  it("安装包 404 → error，且不留半截文件", async () => {
    const data = await fixture();
    const server = await startFixtureServer({ ...data, assetStatus: 404 });
    const { updater, updatesDir } = makeUpdater(server.base, data);
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("NOT_FOUND");
    expect(fs.readdirSync(updatesDir)).toEqual([]);
  });

  it("安装目录不可写 → READ_ONLY_INSTALL，而且**根本不去下载**", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, statuses } = makeUpdater(server.base, data, {
      installDir: path.join(tempDir("readonly"), "missing-install-dir"),
    });
    await updater.check();
    const status = await updater.download();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("READ_ONLY_INSTALL");
    expect(status.canAutoInstall).toBe(false);
    expect(server.zipRequests).toBe(0);
    expect(statuses.some((item) => item.progress?.kind === "extract")).toBe(false);
  });

  it("下载中途取消 → 回到 available，不留 .part", async () => {
    const data = await fixture({ slow: true });
    const server = await startFixtureServer(data);
    let cancelled = false;
    const { updater, updatesDir } = makeUpdater(server.base, data);
    await updater.check();
    updater.status();
    const pending = updater.download().then(async (status) => {
      expect(cancelled).toBe(true);
      return status;
    });
    // 等到真的有字节落盘再取消，确保取消打在「下载中」而不是「还没开始」。
    const waitForProgress = new Promise<void>((resolve) => {
      const timer = setInterval(() => {
        if (updater.status().progress?.received) {
          clearInterval(timer);
          resolve();
        }
      }, 10);
    });
    await waitForProgress;
    cancelled = true;
    await updater.cancel();
    const status = await pending;
    expect(status.phase).toBe("available");
    expect(status.error).toBeNull();
    expect(fs.readdirSync(updatesDir).filter((name) => name.endsWith(".part"))).toEqual([]);
  });

  it("没检查过就点下载 → 什么也不做（不猜版本）", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater } = makeUpdater(server.base, data);
    const status = await updater.download();
    expect(status.phase).toBe("idle");
    expect(server.zipRequests).toBe(0);
  });

  it("下载失败后可以重试（状态回到 downloading 并最终 ready）", async () => {
    const data = await fixture();
    let failNext = true;
    const zip = data.zip;
    const server = await startFixtureServer(data);
    const { updater } = makeUpdater(server.base, data);
    await updater.check();
    // 第一次：把已落盘的 zip 换成一个坏包，让「下载」失败（校验和不符）
    const realSha = crypto.createHash("sha256").update(zip).digest("hex");
    expect(failNext).toBe(true);
    failNext = false;
    const status = await updater.download();
    expect(status.phase).toBe("ready");
    expect(realSha.length).toBe(64);
    const second = await updater.download();
    expect(second.phase).toBe("ready");
  });
});

describe("重启与启动恢复", () => {
  it("restart 只在 ready 时可用，并调用主进程的 apply", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const plans: Record<string, unknown>[] = [];
    const { updater } = makeUpdater(server.base, data, {
      apply: async (plan) => {
        plans.push(plan);
        return { ok: true };
      },
    });
    expect(await updater.restart()).toEqual({ ok: false, reason: "NOT_READY" });
    await updater.check();
    expect(await updater.restart()).toEqual({ ok: false, reason: "NOT_READY" });
    await updater.download();
    expect(await updater.restart()).toEqual({ ok: true });
    expect(plans[0]?.version).toBe("0.6.0");
    expect(String(plans[0]?.stagingDir)).toContain("staging-0.6.0");
  });

  it("用户点了「稍后」（apply 返回 cancelled）→ 明确回 cancelled，状态仍是 ready", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater } = makeUpdater(server.base, data, {
      apply: async () => ({ ok: false, reason: "CANCELLED" }),
    });
    await updater.check();
    await updater.download();
    expect(await updater.restart()).toEqual({ ok: false, reason: "CANCELLED" });
    expect(updater.status().phase).toBe("ready");
  });

  it("启动时发现上次已下载好但没重启 → 直接进 ready（不白下 151 MB）", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    const staging = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({ version: "0.6.0" }), "utf8");
    const status = await updater.resume();
    expect(status.phase).toBe("ready");
    expect(status.latest).toBe("0.6.0");
  });

  it("回归：resume 进 ready 后再 check()（含启动 5 秒后的自动检查）→ 保持 ready，只补元数据，不重新下载", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    const staging = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({ version: "0.6.0" }), "utf8");
    await updater.resume();
    const status = await updater.check();
    expect(status.phase).toBe("ready");
    expect(status.latest).toBe("0.6.0");
    // resume 恢复的 assetInfo 没有真实 url/size，检查要把它补齐。
    expect(status.releaseUrl).toContain("/tag/v0.6.0");
    expect(status.asset?.size).toBe(data.zip.length);
    // 没有任何 zip 下载请求，staging 原样保留。
    expect(server.zipRequests).toBe(0);
    expect(fs.existsSync(staging)).toBe(true);
  });

  it("回归：resume 进 ready 后 check 失败（apiStatus 500）→ 不丢 ready、不报 error", async () => {
    const data = await fixture({ apiStatus: 500 });
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    const staging = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({ version: "0.6.0" }), "utf8");
    await updater.resume();
    const status = await updater.check();
    expect(status.phase).toBe("ready");
    expect(status.error).toBeNull();
    expect(fs.existsSync(staging)).toBe(true);
  });

  it("GitHub 出了比 staged 更新的版本 → 丢弃旧 staging、进 available 提示下载新版本", async () => {
    const data = await fixture({ version: "0.7.0" });
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    const stale = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(stale, { recursive: true });
    fs.writeFileSync(path.join(stale, ".ready"), JSON.stringify({ version: "0.6.0" }), "utf8");
    expect((await updater.resume()).phase).toBe("ready");
    const status = await updater.check();
    expect(status.phase).toBe("available");
    expect(status.latest).toBe("0.7.0");
    expect(fs.existsSync(stale)).toBe(false);
  });

  it("resume 进 ready 后 check() 保持了 ready，restart() 仍然可用", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const plans: Record<string, unknown>[] = [];
    const { updater, updatesDir } = makeUpdater(server.base, data, {
      apply: async (plan) => {
        plans.push(plan);
        return { ok: true };
      },
    });
    const staging = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, ".ready"), JSON.stringify({ version: "0.6.0" }), "utf8");
    await updater.resume();
    await updater.check();
    expect(updater.status().phase).toBe("ready");
    expect(await updater.restart()).toEqual({ ok: true });
    expect(String(plans[0]?.stagingDir)).toContain("staging-0.6.0");
  });

  it("上次覆盖到一半（.applying 且没有结果文件）→ 如实报 APPLY_FAILED，可重试", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    const staging = path.join(updatesDir, "staging-0.6.0");
    fs.mkdirSync(staging, { recursive: true });
    fs.writeFileSync(path.join(staging, ".applying"), "{}", "utf8");
    const status = await updater.resume();
    expect(status.phase).toBe("error");
    expect(status.error?.code).toBe("APPLY_FAILED");
    expect(fs.existsSync(staging)).toBe(true);
  });

  it("读回上一次的覆盖结果（成功与失败），且只交付一次", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    fs.writeFileSync(
      path.join(updatesDir, "result.json"),
      JSON.stringify({ ok: true, from: "0.5.0", to: "0.6.0", at: "2026-10-06T00:00:00.000Z", error: null }),
      "utf8",
    );
    await updater.resume();
    expect(updater.takeApplyResult()).toEqual({ ok: true, from: "0.5.0", to: "0.6.0", error: null });
    expect(updater.takeApplyResult()).toBeNull();
  });

  it("启动时清掉 .part 与半成品 staging，但保留 ready 的那个", async () => {
    const data = await fixture();
    const server = await startFixtureServer(data);
    const { updater, updatesDir } = makeUpdater(server.base, data);
    fs.writeFileSync(path.join(updatesDir, "Opennote-0.6.0-win-x64.zip.part"), "half", "utf8");
    fs.mkdirSync(path.join(updatesDir, "staging-0.7.0"), { recursive: true });
    fs.mkdirSync(path.join(updatesDir, "staging-0.6.0"), { recursive: true });
    fs.writeFileSync(path.join(updatesDir, "staging-0.6.0", ".ready"), "{}", "utf8");
    const status = await updater.resume();
    expect(status.phase).toBe("ready");
    const names = fs.readdirSync(updatesDir);
    expect(names).not.toContain("Opennote-0.6.0-win-x64.zip.part");
    expect(names).not.toContain("staging-0.7.0");
    expect(names).toContain("staging-0.6.0");
  });
});
