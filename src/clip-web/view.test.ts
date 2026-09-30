import { describe, expect, it } from "vitest";

import type { ClipBoot, ClipReceipt, ClipStage } from "./contract";
import type { ClipForm } from "./requests";
import {
  INBOX_LABEL,
  canCommit,
  canRetryFolders,
  canRetryStage,
  clipReducer,
  commitBlockReason,
  commitLabel,
  createInitialState,
  draftFromStage,
  draftNote,
  folderLabel,
  folderOptions,
  foldersNote,
  formatCapturedAt,
  formatExpiry,
  receiptView,
  stageFacts,
  statusLine,
  toFoldersState,
  type ClipAction,
  type ClipState,
} from "./view";

const BOOT: ClipBoot = { port: 8790, stageId: "stage-A", k: "key-A" };

function stage(overrides: Partial<ClipStage> = {}): ClipStage {
  return {
    url: "https://example.com/post",
    title: "原标题",
    body: "原正文",
    // 契约：布尔，表示"正文是不是来自选区"。
    selection: false,
    tags: [],
    source: { site: null, author: null, publishedAt: null },
    assetCount: 0,
    capturedAt: null,
    expiresAt: null,
    ...overrides,
  };
}

function receipt(overrides: Partial<ClipReceipt> = {}): ClipReceipt {
  return {
    status: "created",
    importId: "imp-0001",
    path: "收件箱/20240501-abc/note.md",
    inboxId: null,
    deduped: false,
    warnings: [],
    tags: [],
    assets: [],
    ...overrides,
  };
}

function apply(state: ClipState, ...actions: ClipAction[]): ClipState {
  return actions.reduce(clipReducer, state);
}

/** 暂存与目录都读到了、正文标题都改过、落点选好的一页。 */
function editedState(form: Partial<ClipForm> = {}): ClipState {
  const base = apply(
    createInitialState(BOOT),
    { type: "stage-loaded", stage: stage() },
    { type: "folders-loaded", folders: ["", "归档"] },
    { type: "edit-title", title: "改过的标题" },
    { type: "edit-body", body: "改过的正文" },
  );
  return { ...base, form: { ...base.form, ...form } };
}

/* -------------------------------------------------------------- 初始状态 -- */

describe("初始状态", () => {
  it("落点默认留空（= 不指定落点，默认设置下进收件箱），暂存与目录都在读", () => {
    const state = createInitialState(BOOT);
    expect(state.form).toEqual({ title: "", body: "", folder: "" });
    expect(folderLabel(state.form.folder)).toBe(INBOX_LABEL);
    expect(state.stage.kind).toBe("loading");
    expect(state.folders.kind).toBe("loading");
    expect(state.commit).toEqual({ kind: "idle" });
    expect(state.draftSource).toBe("empty");
  });
});

/* ------------------------------------------------------------ 编辑区初值 -- */

describe("draftFromStage：编辑区一开始填什么", () => {
  it("有正文就用正文", () => {
    expect(draftFromStage(stage())).toEqual({ title: "原标题", body: "原正文", source: "body" });
  });

  it("selection 为 false 而 body 非空 → 正文就是 body", () => {
    const draft = draftFromStage(stage({ selection: false, body: "整页提取出来的正文" }));
    expect(draft).toEqual({ title: "原标题", body: "整页提取出来的正文", source: "body" });
  });

  it("selection 为 true → 正文仍然是 body（不把 selection 当文字用）", () => {
    const draft = draftFromStage(stage({ selection: true, body: "选中的那句话" }));
    expect(draft).toEqual({ title: "原标题", body: "选中的那句话", source: "body" });
    expect(draft.source).toBe("body");
  });

  it("正文为空就如实留空，不编内容、也没有第二个来源", () => {
    const draft = draftFromStage(stage({ body: "", selection: true }));
    expect(draft.body).toBe("");
    expect(draft.source).toBe("empty");
    expect(draftNote("body")).toBeNull();
    expect(draftNote("empty")).not.toBeNull();
  });
});

/* ------------------------------------------------------------------ 暂存 -- */

describe("暂存读回来之后", () => {
  it("标题与正文来自暂存（换一份暂存就换一份初值）", () => {
    const first = apply(createInitialState(BOOT), {
      type: "stage-loaded",
      stage: stage({ title: "甲", body: "甲的正文" }),
    });
    const second = apply(createInitialState(BOOT), {
      type: "stage-loaded",
      stage: stage({ title: "乙", body: "乙的正文" }),
    });
    expect(first.form.title).toBe("甲");
    expect(first.form.body).toBe("甲的正文");
    expect(second.form.title).toBe("乙");
    expect(second.form.body).toBe("乙的正文");
    expect(second.form).not.toEqual(first.form);
  });

  it("暂存读回不覆盖已经选好的落点", () => {
    const state = apply(
      createInitialState(BOOT),
      { type: "pick-folder", folder: "归档" },
      { type: "stage-loaded", stage: stage() },
    );
    expect(state.form.folder).toBe("归档");
  });

  it("失败后 stage 是 failed，并保留原因；只有失败态才给重试", () => {
    const failed = apply(createInitialState(BOOT), { type: "stage-failed", message: "暂存已经过期" });
    expect(failed.stage).toEqual({ kind: "failed", message: "暂存已经过期" });
    expect(canRetryStage(failed)).toBe(true);
    // 读成功之后再给重试，就等于允许"再读一次覆盖用户已经改过的正文"。
    expect(canRetryStage(editedState())).toBe(false);
    expect(canRetryStage(createInitialState(BOOT))).toBe(false);
  });
});

/* ------------------------------------------------------------------ 目录 -- */

describe("目录列表", () => {
  it("一个目录都没有（[]）→ empty，界面必须说出原因，而不是假装只有收件箱", () => {
    expect(toFoldersState([])).toEqual({ kind: "empty" });
    const state = apply(createInitialState(BOOT), { type: "folders-loaded", folders: [] });
    expect(foldersNote(state)).not.toBeNull();
    expect(foldersNote(state)).toContain("没有给出任何可选目录");
    expect(canRetryFolders(state)).toBe(true);
    expect(folderOptions(state)).toEqual([{ value: "", label: INBOX_LABEL }]);
  });

  it("只有收件箱（[\"\"]）是真话，按 ready 处理、不吓唬人", () => {
    expect(toFoldersState([""])).toEqual({ kind: "ready", folders: [] });
    const state = apply(createInitialState(BOOT), { type: "folders-loaded", folders: [""] });
    expect(foldersNote(state)).toBeNull();
    expect(folderOptions(state)).toEqual([{ value: "", label: INBOX_LABEL }]);
  });

  it("去重后列出来，收件箱永远在第一项", () => {
    const state = apply(createInitialState(BOOT), { type: "folders-loaded", folders: ["", "归档", "归档", "剪藏/技术"] });
    expect(folderOptions(state)).toEqual([
      { value: "", label: INBOX_LABEL },
      { value: "归档", label: "归档" },
      { value: "剪藏/技术", label: "剪藏/技术" },
    ]);
    expect(foldersNote(state)).toBeNull();
    expect(canRetryFolders(state)).toBe(false);
  });

  it("目录读失败时保留原因，并给出重试", () => {
    const state = apply(createInitialState(BOOT), { type: "folders-failed", message: "工作区还没打开。" });
    expect(foldersNote(state)).toContain("工作区还没打开。");
    expect(canRetryFolders(state)).toBe(true);
    // 只列收件箱，但原因就在旁边 —— 没有假装"工作区里只有收件箱"。
    expect(folderOptions(state)).toEqual([{ value: "", label: INBOX_LABEL }]);
  });

  it("重试读取目录时进入 loading，不给连点", () => {
    const state = apply(createInitialState(BOOT), { type: "folders-failed", message: "x" }, { type: "retry-folders" });
    expect(state.folders.kind).toBe("loading");
    expect(canRetryFolders(state)).toBe(false);
    expect(foldersNote(state)).toContain("正在读取");
  });
});

/* ------------------------------------------------------------------ 表单 -- */

describe("表单", () => {
  it("改动分别落到 form 上", () => {
    const state = apply(
      createInitialState(BOOT),
      { type: "edit-title", title: "新标题" },
      { type: "edit-body", body: "新正文" },
      { type: "pick-folder", folder: "归档" },
    );
    expect(state.form).toEqual({ title: "新标题", body: "新正文", folder: "归档" });
  });

  it("入库失败不清空用户改过的内容（失败要能改一改再试）", () => {
    const state = apply(editedState(), { type: "commit-started" }, { type: "commit-failed", message: "连不上" });
    expect(state.commit).toEqual({ kind: "failed", message: "连不上" });
    expect(state.form.title).toBe("改过的标题");
    expect(state.form.body).toBe("改过的正文");
    // 失败之后按钮要能再按一次。
    expect(canCommit(state)).toBe(true);
  });

  it("入库成功之后再改内容，回执就收起来（免得以为改动也入库了）", () => {
    const done = apply(editedState(), { type: "commit-succeeded", receipt: receipt() });
    expect(done.commit.kind).toBe("done");
    expect(apply(done, { type: "edit-body", body: "又改了" }).commit).toEqual({ kind: "idle" });
    expect(apply(done, { type: "edit-title", title: "又改了" }).commit).toEqual({ kind: "idle" });
  });

  it("回执可以收起；收起后按钮回到确认入库", () => {
    const done = apply(editedState(), { type: "commit-succeeded", receipt: receipt() });
    const dismissed = apply(done, { type: "commit-dismiss" });
    expect(dismissed.commit).toEqual({ kind: "idle" });
    expect(commitLabel(dismissed)).toBe("确认入库");
    expect(commitLabel(done)).toBe("再入库一次");
    expect(commitLabel(apply(done, { type: "commit-started" }))).toBe("正在入库…");
  });
});

/* ------------------------------------------------------------ 按钮与状态 -- */

describe("能不能入库", () => {
  it("暂存在读 / 读失败时都不能入库，并给出理由", () => {
    const loading = createInitialState(BOOT);
    expect(canCommit(loading)).toBe(false);
    expect(commitBlockReason(loading)).toContain("还没读到");

    const failed = apply(loading, { type: "stage-failed", message: "过期" });
    expect(canCommit(failed)).toBe(false);
    expect(commitBlockReason(failed)).toContain("没读到");
  });

  it("标题和正文都是空的就不能入库（不许提交一个空笔记）", () => {
    const state = apply(createInitialState(BOOT), { type: "stage-loaded", stage: stage({ title: "", body: "", selection: false }) });
    expect(canCommit(state)).toBe(false);
    expect(commitBlockReason(state)).toContain("都是空的");
  });

  it("有内容就能入库；正在入库时不能连点", () => {
    expect(canCommit(editedState())).toBe(true);
    expect(commitBlockReason(editedState())).toBeNull();

    const running = apply(editedState(), { type: "commit-started" });
    expect(canCommit(running)).toBe(false);
    expect(commitBlockReason(running)).toContain("正在入库");
    expect(commitLabel(running)).toBe("正在入库…");
  });

  it("底部状态行：失败说失败、成功说回执、目录没读到说原因", () => {
    const failed = apply(editedState(), { type: "commit-failed", message: "目录不存在" });
    expect(statusLine(failed)).toEqual({ tone: "error", text: "入库没有成功：目录不存在" });

    const done = apply(editedState(), { type: "commit-succeeded", receipt: receipt({ warnings: ["有一张图没下载下来"] }) });
    expect(statusLine(done).text).toContain("1 条提醒");

    const noFolders = apply(editedState(), { type: "folders-loaded", folders: [] });
    expect(statusLine(noFolders).text).toBe(foldersNote(noFolders));

    expect(statusLine(editedState()).text).toContain("确认入库");
  });
});

/* ------------------------------------------------------------------ 回执 -- */

describe("receiptView：回执变成人看得懂的话", () => {
  it("created：真的落盘了，「你选的是」与「实际落盘」都显示出来", () => {
    const view = receiptView(receipt(), "归档");
    expect(view.landed).toBe(true);
    expect(view.folderText).toBe("归档");
    expect(view.pathText).toBe("收件箱/20240501-abc/note.md");
    expect(view.lines.join("\n")).toContain("你选的是：归档");
    expect(view.lines.join("\n")).toContain("实际落盘：收件箱/20240501-abc/note.md");
    expect(view.warnings).toEqual([]);
  });

  it("落点为空串时说的是「收件箱（默认）」，真正落到哪看回执的实际路径", () => {
    // 桥的注释（electron/bridge.cjs）：空落点 = 不指定落点，默认设置下进收件箱，
    // 但用户可能把默认改成「直接入库」⇒ 页面不许替用户承诺收件箱。
    const view = receiptView(receipt({ path: "工作区根笔记.md" }), "");
    expect(view.folderText).toBe(INBOX_LABEL);
    expect(view.folderText).toContain("默认");
    expect(view.lines.join("\n")).toContain("你选的是：收件箱（默认）");
    expect(view.pathText).toBe("工作区根笔记.md");
    expect(view.lines.join("\n")).toContain("实际落盘：工作区根笔记.md");
  });

  it("没有 path 时用收件箱条目 id 顶上，不能显示成空", () => {
    const view = receiptView(receipt({ status: "pending", path: null, inboxId: "inbox-9" }), "");
    expect(view.landed).toBe(true);
    expect(view.pathText).toContain("inbox-9");
  });

  it("deduped / skipped 不谎报落盘", () => {
    const deduped = receiptView(receipt({ status: "deduped", path: null, inboxId: null, deduped: true }), "");
    expect(deduped.landed).toBe(false);
    expect(deduped.pathText).toBe("回执没有给出落盘路径");
    expect(deduped.headline).not.toBe(receiptView(receipt(), "").headline);

    const skipped = receiptView(receipt({ status: "skipped", path: null, inboxId: null }), "");
    expect(skipped.landed).toBe(false);
    expect(skipped.nextStep).toContain("没有写入新内容");
  });

  it("提醒与标签原样带到视图（不吞掉 warnings）", () => {
    const view = receiptView(receipt({ warnings: ["有 2 张图没下载下来"], tags: ["甲", "乙"], assets: ["a.png"] }), "");
    expect(view.warnings).toEqual(["有 2 张图没下载下来"]);
    expect(view.lines.join("\n")).toContain("甲、乙");
    expect(view.lines.join("\n")).toContain("附件：1 件");
  });
});

/* ------------------------------------------------------------ 顶部与时间 -- */

describe("顶部事实与时间", () => {
  const NOW = Date.parse("2024-05-01T10:30:00.000Z");

  it("只列真的有的字段（缺的不编）", () => {
    const facts = stageFacts(stage(), NOW);
    expect(facts).toEqual(["来源：https://example.com/post", "正文来源：整页提取"]);

    const rich = stageFacts(
      stage({
        selection: true,
        source: { site: "example.com", author: "某人", publishedAt: "2024-05-01" },
        tags: ["甲"],
        assetCount: 3,
        capturedAt: "2024-05-01T10:20:00.000Z",
        expiresAt: Date.parse("2024-05-01T11:30:00.000Z"),
      }),
      NOW,
    );
    expect(rich.join("\n")).toContain("站点：example.com");
    expect(rich.join("\n")).toContain("作者：某人");
    expect(rich.join("\n")).toContain("正文来源：你选中的一段文字");
    expect(rich.join("\n")).toContain("附件：3 件");
    expect(rich.join("\n")).toContain("标签：甲");
    expect(rich.join("\n")).toContain("10 分钟前");
    expect(rich.join("\n")).toContain("还有 1 小时");
  });

  it("过期与还没过期说法不同", () => {
    expect(formatExpiry(null, NOW)).toBeNull();
    expect(formatExpiry(NOW + 120_000, NOW)).toContain("还有 2 分钟");
    expect(formatExpiry(NOW - 1, NOW)).toContain("已经过了有效期");
  });

  it("认不出的抓取时间原样显示，不折算成假的时间", () => {
    expect(formatCapturedAt(null, NOW)).toBeNull();
    expect(formatCapturedAt("2024-05-01T10:00:00.000Z", NOW)).toBe("抓取于 30 分钟前");
    expect(formatCapturedAt("不知道什么时候", NOW)).toBe("抓取时间：不知道什么时候");
  });
});
