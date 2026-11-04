/**
 * HTML 页面的端到端链路（不 mock 数据层自身）：
 *
 *   Skill 投进收件箱的条目（`body.html` + `resources/` + `entry.json`）
 *     → 收件箱读出 `format: "html"` 与资源清单 → 预览文档已内联
 *     → 「导入」走真实接收端 → 落成**单个** `.html`（资源全部内联）
 *     → 库里是一篇 kind=html、只读的页面；搜索认它的文字、不认它的 base64
 *
 * 条目的磁盘形状逐字照 `.agents/skills/opennote-ingest/scripts/opennote-ingest.mjs` 的
 * `deliverToInbox()` 写出来的样子（字段、目录名、文件位置）。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryBackend } from "../lib/clip/testing/memoryBackend";
import type { WorkspaceRecord } from "../data/workspaces";

let testBackend: MemoryBackend;
vi.mock("../data/workspaces", () => ({
  activeWorkspaceRecord: () => null,
  resolveBackend: async () => testBackend,
  setActiveWorkspace: () => undefined,
}));

import { duplicateNote, flushAll, getLibrary, openWorkspace, searchNotes, updateNoteContent } from "../data/library";
import { commitInboxResult, listInboxDetails, readInboxHtmlPreview, refreshInbox, setInboxReceiver } from "../data/inbox";
import { resetImportIndexCache } from "../data/importLog";
import { noteKind } from "../data/types";
import { receiveEnvelope, resetImportChannelContext, resetImportLandingPreference, setImportNotifications } from "../lib/clip/receive";

const RECORD: WorkspaceRecord = { id: "t", name: "临时笔记本", kind: "node", location: "unused", addedAt: 1, lastOpenedAt: 1 };
const DIR = ".opennote/inbox/20261028T120055-agent-d5";
const IMPORT_ID = "agent-d50e6732d63c46b2";

const PAGE = [
  "<!doctype html>",
  '<html><head><meta charset="utf-8"><title>季度报告</title>',
  '<link rel="stylesheet" href="css/main.css">',
  '<script defer src="js/app.js"></script></head>',
  '<body><h1>季度报告</h1><p>营收增长</p><img src="img/logo.png"></body></html>',
].join("\n");

function seedSkillEntry(): void {
  testBackend.seed(`${DIR}/body.html`, PAGE);
  testBackend.seed(`${DIR}/resources/css/main.css`, "body{background:url(../img/bg.svg)}");
  testBackend.seed(`${DIR}/resources/img/bg.svg`, '<svg xmlns="http://www.w3.org/2000/svg"/>');
  testBackend.seed(`${DIR}/resources/img/logo.png`, "PNG");
  testBackend.seed(`${DIR}/resources/js/app.js`, 'document.body.dataset.ok="1"');
  testBackend.seed(
    `${DIR}/entry.json`,
    JSON.stringify({
      spec: "opennote.import/v1",
      importId: IMPORT_ID,
      title: "季度报告",
      body: null,
      bodyFile: "body.html",
      source: { url: null, title: "/tmp/bundle/index.html", site: null, author: null, publishedAt: null, capturedAt: "2026-10-28T05:00:55-07:00", selection: false },
      target: { folder: "Agent 产出", notePath: null },
      conflict: "new",
      tags: [],
      assets: [],
      format: "html",
      resources: [
        { path: "css/main.css", mime: "text/css", file: "resources/css/main.css" },
        { path: "img/bg.svg", mime: "image/svg+xml", file: "resources/img/bg.svg" },
        { path: "img/logo.png", mime: "image/png", file: "resources/img/logo.png" },
        { path: "js/app.js", mime: "text/javascript", file: "resources/js/app.js" },
      ],
      client: { name: "cli", version: "0.1.0" },
      enqueuedAt: "2026-10-28T12:00:55.000Z",
    }),
  );
  testBackend.seed(
    `${DIR}/state.json`,
    JSON.stringify({ status: "pending", attempts: 0, lastError: null, committedPath: null, updatedAt: "2026-10-28T12:00:55.000Z" }),
  );
}

beforeEach(async () => {
  testBackend = new MemoryBackend();
  resetImportIndexCache();
  resetImportChannelContext();
  resetImportLandingPreference();
  setImportNotifications(false);
  setInboxReceiver(null); // 用真实接收端（`loadClipReceiver()`）
  await openWorkspace(RECORD, { silent: true });
});

describe("Skill → 收件箱 → HTML 页面", () => {
  it("收件箱认出 HTML 条目与资源；预览就是入库后的那一页", async () => {
    seedSkillEntry();
    await refreshInbox();
    const [detail] = await listInboxDetails();
    expect(detail.format).toBe("html");
    expect(detail.resources.map((resource) => resource.path)).toEqual(["css/main.css", "img/bg.svg", "img/logo.png", "js/app.js"]);

    const preview = await readInboxHtmlPreview(IMPORT_ID);
    expect(preview).toContain("<style data-opennote-href=\"css/main.css\">");
    expect(preview).toContain("data:image/svg+xml;base64,");
    expect(preview).toContain('src="data:image/png;base64,');
    expect(preview).toContain('defer src="data:text/javascript;base64,');
  });

  it("「导入」落成单个 .html：资源全部内联、暂存资源清掉、库里是只读的 html 页面", async () => {
    seedSkillEntry();
    await refreshInbox();
    const result = await commitInboxResult(IMPORT_ID);
    expect(result?.status).toBe("created");
    expect(result?.path).toBe("Agent 产出/季度报告.html");

    const written = testBackend.text("Agent 产出/季度报告.html") ?? "";
    expect(written).not.toMatch(/<link|src="img\/logo\.png"|src="js\/app\.js"/);
    expect(written).toContain("<h1>季度报告</h1>");
    // 散装资源没有被写进笔记本（只有一个文件），收件箱里的暂存副本也已清掉。
    expect(testBackend.paths().filter((path) => !path.startsWith(".opennote/"))).toEqual(["Agent 产出/季度报告.html"]);
    expect(testBackend.paths().some((path) => path.startsWith(`${DIR}/resources/`))).toBe(false);

    const note = getLibrary().notes["Agent 产出/季度报告.html"];
    expect(note && noteKind(note)).toBe("html");
    expect(note?.title).toBe("季度报告");

    // 搜索认页面文字，不认内联的 base64 / 脚本。
    expect(searchNotes("营收增长").map((hit) => hit.note.id)).toEqual(["Agent 产出/季度报告.html"]);
    expect(searchNotes("base64")).toEqual([]);
  });

  it("★ 应用内只读：updateNoteContent 拒收，磁盘一个字节都不变", async () => {
    seedSkillEntry();
    await refreshInbox();
    await commitInboxResult(IMPORT_ID);
    const before = testBackend.text("Agent 产出/季度报告.html");
    updateNoteContent("Agent 产出/季度报告.html", "<p>被改写</p>");
    await flushAll();
    expect(getLibrary().dirty["Agent 产出/季度报告.html"]).toBeUndefined();
    expect(testBackend.text("Agent 产出/季度报告.html")).toBe(before);
  });

  it("创建副本保留 .html 扩展名与原文", async () => {
    seedSkillEntry();
    await refreshInbox();
    await commitInboxResult(IMPORT_ID);
    const copy = duplicateNote("Agent 产出/季度报告.html");
    await flushAll();
    expect(copy?.id).toBe("Agent 产出/季度报告 副本.html");
    expect(testBackend.text("Agent 产出/季度报告 副本.html")).toBe(testBackend.text("Agent 产出/季度报告.html"));
  });
});

describe("接收端 · format: html 的信封", () => {
  const envelope = (overrides: Record<string, unknown> = {}) =>
    JSON.stringify({
      spec: "opennote.import/v1",
      importId: "html-envelope-0001",
      title: "图表页",
      body: '<html><head><link rel="stylesheet" href="a.css"></head><body><p>x</p></body></html>',
      source: { url: null, capturedAt: "2026-10-28T12:00:00Z" },
      format: "html",
      resources: [{ path: "a.css", dataBase64: Buffer.from("p{color:red}").toString("base64") }],
      client: { name: "cli", version: "1" },
      ...overrides,
    });

  it("桥 / 应用内直传：落 .html、style 已内联", async () => {
    const receipt = await receiveEnvelope(envelope());
    expect(receipt.status).toBe("created");
    expect(receipt.path).toBe("图表页.html");
    expect(testBackend.text("图表页.html")).toContain("<style data-opennote-href=\"a.css\">p{color:red}</style>");
  });

  it("append / overwrite 不适用：按新建入库并给警告", async () => {
    const receipt = await receiveEnvelope(envelope({ conflict: "append" }));
    expect(receipt.status).toBe("created");
    expect(receipt.warnings.join("\n")).toContain("HTML 页面不支持追加或覆盖");
  });

  it("没被页面引用到的资源、引用了却没随附的资源都如实警告", async () => {
    const receipt = await receiveEnvelope(
      envelope({
        body: '<img src="missing.png"><link rel="stylesheet" href="a.css">',
        resources: [
          { path: "a.css", dataBase64: Buffer.from("p{}").toString("base64") },
          { path: "data.json", dataBase64: Buffer.from("{}").toString("base64") },
        ],
      }),
    );
    const warnings = receipt.warnings.join("\n");
    expect(warnings).toContain("有 1 个资源没有被页面直接引用");
    expect(warnings).toContain("页面引用的 1 个本地资源没有随附");
  });

  it("只改了资源的第二次投递不是 duplicate（去重哈希算上资源）", async () => {
    await receiveEnvelope(envelope());
    const second = await receiveEnvelope(
      envelope({ importId: "html-envelope-0002", resources: [{ path: "a.css", dataBase64: Buffer.from("p{color:blue}").toString("base64") }] }),
    );
    expect(second.status).toBe("created");
    expect(second.path).toBe("图表页 2.html");
  });

  it("★ 外置 file 形态的资源同一条体积判据：单件超 8 MiB 拒收且不落盘", async () => {
    testBackend.seed("staged/big.png", "x".repeat(9 * 1024 * 1024));
    await expect(
      receiveEnvelope(envelope({ resources: [{ path: "big.png", file: "staged/big.png" }] })),
    ).rejects.toMatchObject({ name: "ImportRejection", code: "IMP-4012" });
    // 笔记本里除了投递前就存在的暂存文件，没有被写进任何页面。
    expect(testBackend.paths().filter((path) => !path.startsWith(".opennote/"))).toEqual(["staged/big.png"]);
  });

  it("★ 合计上限跨形态闭合：dataBase64 与 file 混合超 8 MiB 拒收", async () => {
    testBackend.seed("staged/mid.png", "x".repeat(4 * 1024 * 1024));
    await expect(
      receiveEnvelope(
        envelope({
          resources: [
            { path: "a.css", dataBase64: Buffer.alloc(5 * 1024 * 1024).toString("base64") },
            { path: "mid.png", file: "staged/mid.png" },
          ],
        }),
      ),
    ).rejects.toMatchObject({ name: "ImportRejection", code: "IMP-4013" });
  });
});
