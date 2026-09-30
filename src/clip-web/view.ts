import type { ClipBoot, ClipReceipt, ClipStage } from "./contract";
import type { ClipForm } from "./requests";

/* ============================================================================
   Opennote 剪藏页 —— 视图状态
   页面状态是一个纯 reducer：暂存/目录/表单/入库各自的状态怎么变、按钮什么时候能按、
   回执怎么变成人看得懂的话，全部在这里。DOM 层只负责把 state 画出来、把事件派回来，
   于是"用户改了正文但提交的还是旧内容"这类问题能在判据里被直接盯住。
   ========================================================================= */

export type StageState =
  | { kind: "loading" }
  | { kind: "ready"; stage: ClipStage }
  | { kind: "failed"; message: string };

export type FoldersState =
  | { kind: "loading" }
  | { kind: "ready"; folders: string[] }
  | { kind: "empty" }
  | { kind: "failed"; message: string };

export type CommitState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "done"; receipt: ClipReceipt }
  | { kind: "failed"; message: string };

export interface ClipState {
  boot: ClipBoot;
  stage: StageState;
  folders: FoldersState;
  /** 编辑区里当前的内容：提交时读的就是这一份。 */
  form: ClipForm;
  /** 编辑区初始内容取自哪里（正文只从 `body` 来）。 */
  draftSource: DraftSource;
  commit: CommitState;
}

/** 正文**只有一个来源**：暂存的 `body`（`selection` 是布尔，不是选中的文字）。 */
export type DraftSource = "body" | "empty";

export interface StageDraft {
  title: string;
  body: string;
  source: DraftSource;
}

/**
 * 编辑区一开始填什么：暂存的正文；正文为空就如实留空。
 * 绝不在这里"补"内容，也不给正文造第二个来源。
 */
export function draftFromStage(stage: ClipStage): StageDraft {
  if (stage.body.trim() !== "") return { title: stage.title, body: stage.body, source: "body" };
  return { title: stage.title, body: "", source: "empty" };
}

export function createInitialState(boot: ClipBoot): ClipState {
  return {
    boot,
    stage: { kind: "loading" },
    folders: { kind: "loading" },
    // 落点默认留空：`""` 是"不指定落点"（默认设置下进收件箱），真正落到哪以回执为准。
    form: { title: "", body: "", folder: "" },
    draftSource: "empty",
    commit: { kind: "idle" },
  };
}

export type ClipAction =
  | { type: "retry-stage" }
  | { type: "stage-loaded"; stage: ClipStage }
  | { type: "stage-failed"; message: string }
  | { type: "retry-folders" }
  | { type: "folders-loaded"; folders: string[] }
  | { type: "folders-failed"; message: string }
  | { type: "edit-title"; title: string }
  | { type: "edit-body"; body: string }
  | { type: "pick-folder"; folder: string }
  | { type: "commit-started" }
  | { type: "commit-succeeded"; receipt: ClipReceipt }
  | { type: "commit-failed"; message: string }
  | { type: "commit-dismiss" };

export function clipReducer(state: ClipState, action: ClipAction): ClipState {
  switch (action.type) {
    case "retry-stage":
      return { ...state, stage: { kind: "loading" }, commit: { kind: "idle" } };
    case "stage-loaded": {
      const draft = draftFromStage(action.stage);
      // 目录选择不动（暂存重读不该顺手改掉用户已经选好的落点）。
      return {
        ...state,
        stage: { kind: "ready", stage: action.stage },
        form: { ...state.form, title: draft.title, body: draft.body },
        draftSource: draft.source,
      };
    }
    case "stage-failed":
      return { ...state, stage: { kind: "failed", message: action.message } };
    case "retry-folders":
      return { ...state, folders: { kind: "loading" } };
    case "folders-loaded":
      return { ...state, folders: toFoldersState(action.folders) };
    case "folders-failed":
      return { ...state, folders: { kind: "failed", message: action.message } };
    case "edit-title":
      return afterEdit(state, { ...state.form, title: action.title });
    case "edit-body":
      return afterEdit(state, { ...state.form, body: action.body });
    case "pick-folder":
      return afterEdit(state, { ...state.form, folder: action.folder });
    case "commit-started":
      return { ...state, commit: { kind: "running" } };
    case "commit-succeeded":
      // 表单不动：入库失败或想再存一次时，用户改过的内容还在。
      return { ...state, commit: { kind: "done", receipt: action.receipt } };
    case "commit-failed":
      return { ...state, commit: { kind: "failed", message: action.message } };
    case "commit-dismiss":
      return { ...state, commit: { kind: "idle" } };
  }
}

/**
 * 改动编辑区或落点时的共同处理。
 * 成功回执说的是"上一次提交的那份内容"；内容一改它就不再代表眼前这一份，
 * 所以把它收起来，免得用户以为"改动也已经入库了"。
 * 失败提示则留着——那正是"改一改再试一次"的依据。
 */
function afterEdit(state: ClipState, form: ClipForm): ClipState {
  return { ...state, form, commit: state.commit.kind === "done" ? { kind: "idle" } : state.commit };
}

/**
 * 接口给的目录列表 → 目录状态。
 * - `[]`：桥一个目录都没给 ⇒ "empty"，界面必须把原因说出来，不许假装工作区只有收件箱；
 * - `[""]`：桥说"只有收件箱" ⇒ 这是真的，按 ready 处理，不吓唬人。
 */
export function toFoldersState(payload: string[]): FoldersState {
  if (payload.length === 0) return { kind: "empty" };
  return { kind: "ready", folders: [...new Set(payload.filter((name) => name !== ""))] };
}

/* ------------------------------------------------------------- 下拉与按钮 -- */

/**
 * `""` 的显示名。
 * 契约说空落点 = 收件箱；但桥的注释写得更准：`""` → `target.folder: null`（**不指定落点**），
 * 默认设置（㉕ `importConflict:"inbox"`）下进收件箱，用户若改成「直接入库」就是工作区根。
 * 所以界面说的是"默认"，**真正落到哪以回执的 `path` 为准**（页面不许替用户承诺收件箱）。
 */
export const INBOX_LABEL = "收件箱（默认）";

export function folderLabel(folder: string): string {
  return folder === "" ? INBOX_LABEL : folder;
}

export interface FolderOption {
  value: string;
  label: string;
}

/**
 * 落点下拉的选项。**收件箱永远可选**（契约㉕，这句话只在这里写一次）；
 * 目录读不到时只列收件箱，但原因必须由 {@link foldersNote} 同时说出来。
 */
export function folderOptions(state: ClipState): FolderOption[] {
  const options: FolderOption[] = [{ value: "", label: INBOX_LABEL }];
  if (state.folders.kind === "ready") {
    for (const folder of state.folders.folders) options.push({ value: folder, label: folder });
  }
  return options;
}

/** 目录不是"读到了、就是这些"时如实说明原因；正常时是 null。 */
export function foldersNote(state: ClipState): string | null {
  switch (state.folders.kind) {
    case "loading":
      return "正在读取可选目录…";
    case "empty":
      return `本地接口没有给出任何可选目录，这次落点只能选「${INBOX_LABEL}」。可以重试读取。`;
    case "failed":
      return `可选目录没读到：${state.folders.message}`;
    case "ready":
      return null;
  }
}

/** 目录只在读失败或读到空时给重试（读的过程中不给，免得连点）。 */
export function canRetryFolders(state: ClipState): boolean {
  return state.folders.kind === "failed" || state.folders.kind === "empty";
}

/** 暂存只在读失败时给重试：读成功之后再读一次会覆盖用户已经改过的正文。 */
export function canRetryStage(state: ClipState): boolean {
  return state.stage.kind === "failed";
}

/** 不能入库的理由；能入库时是 null。 */
export function commitBlockReason(state: ClipState): string | null {
  switch (state.stage.kind) {
    case "loading":
      return "暂存内容还没读到，先等一下；如果一直读不到，可以重试。";
    case "failed":
      return "暂存内容没读到，所以还不能入库。";
    case "ready":
      break;
  }
  if (state.commit.kind === "running") return "正在入库…";
  if (state.form.title.trim() === "" && state.form.body.trim() === "") return "标题和正文都是空的，先写点什么再入库。";
  return null;
}

export function canCommit(state: ClipState): boolean {
  return commitBlockReason(state) === null;
}

export function commitLabel(state: ClipState): string {
  switch (state.commit.kind) {
    case "running":
      return "正在入库…";
    case "done":
      return "再入库一次";
    default:
      return "确认入库";
  }
}

/** 底部那一行状态：一次只说最要紧的一句，别把界面变成日志堆。 */
export interface StatusLine {
  tone: "muted" | "error";
  text: string;
}

export function statusLine(state: ClipState): StatusLine {
  if (state.commit.kind === "failed") {
    return { tone: "error", text: `入库没有成功：${state.commit.message}` };
  }
  if (state.commit.kind === "done") {
    const warnings = state.commit.receipt.warnings.length;
    return { tone: "muted", text: warnings > 0 ? `入库完成，接口给了 ${warnings} 条提醒，见上面的回执。` : "入库完成，见上面的回执。" };
  }
  const note = foldersNote(state);
  if (note !== null) return { tone: "muted", text: note };
  const reason = commitBlockReason(state);
  if (reason !== null) return { tone: "muted", text: reason };
  return {
    tone: "muted",
    text: `确认无误后点「${commitLabel(state)}」；落点留空时按 Opennote 的设置走（默认进收件箱），最终落点以回执为准。`,
  };
}

/* ----------------------------------------------------------------- 回执 -- */

export interface ReceiptView {
  headline: string;
  /** 内容是否真的落到了某个地方（新笔记 / 追加 / 收件箱条目）。 */
  landed: boolean;
  pathText: string;
  folderText: string;
  lines: string[];
  warnings: string[];
  nextStep: string;
}

export function receiptView(receipt: ClipReceipt, chosenFolder: string): ReceiptView {
  const headline = RECEIPT_HEADLINES[receipt.status];
  const landed = receipt.status === "created" || receipt.status === "appended" || receipt.status === "pending";
  const folderText = folderLabel(chosenFolder);
  const pathText =
    receipt.path !== null
      ? receipt.path
      : receipt.inboxId !== null
        ? `收件箱条目 ${receipt.inboxId}`
        : "回执没有给出落盘路径";

  // 「你选的是」与「实际落盘」分开写：空落点不等于"一定进收件箱"（见 INBOX_LABEL 的注释）。
  const lines = [`你选的是：${folderText}`, `回执状态：${receipt.status}`, `实际落盘：${pathText}`];
  if (receipt.deduped) lines.push("去重：这次命中了已有内容，没有新建笔记");
  if (receipt.importId !== "") lines.push(`导入 id：${receipt.importId}`);
  if (receipt.tags.length > 0) lines.push(`标签：${receipt.tags.join("、")}`);
  if (receipt.assets.length > 0) lines.push(`附件：${receipt.assets.length} 件`);

  return {
    headline,
    landed,
    pathText,
    folderText,
    lines,
    warnings: receipt.warnings,
    nextStep: landed
      ? "可以关掉这个页面了：内容已经在 Opennote 里，落点如上。"
      : "这次没有写入新内容；请到 Opennote 里确认这次剪藏后再决定要不要重来。",
  };
}

const RECEIPT_HEADLINES: Record<ClipReceipt["status"], string> = {
  created: "已入库",
  appended: "已追加到已有笔记",
  deduped: "内容重复：没有新建笔记",
  duplicate: "已存在同名笔记：没有覆盖",
  pending: "已进入收件箱，等待在 Opennote 里处理",
  skipped: "已跳过：没有落盘",
};

/* ------------------------------------------------------------- 顶部事实 -- */

/** 顶部那几行"这次剪的是什么"：只列真的有的字段，缺的不编。 */
export function stageFacts(stage: ClipStage, now: number): string[] {
  const facts: string[] = [];
  if (stage.url !== "") facts.push(`来源：${stage.url}`);
  const source: string[] = [];
  if (stage.source.site !== null) source.push(`站点：${stage.source.site}`);
  if (stage.source.author !== null) source.push(`作者：${stage.source.author}`);
  if (stage.source.publishedAt !== null) source.push(`发布：${stage.source.publishedAt}`);
  if (source.length > 0) facts.push(source.join(" · "));
  // selection 是布尔：它回答的是"正文是不是来自选区"，不是选中的那段文字。
  facts.push(stage.selection ? "正文来源：你选中的一段文字" : "正文来源：整页提取");
  if (stage.assetCount > 0) facts.push(`附件：${stage.assetCount} 件`);
  if (stage.tags.length > 0) facts.push(`标签：${stage.tags.join("、")}`);
  const captured = formatCapturedAt(stage.capturedAt, now);
  if (captured !== null) facts.push(captured);
  const expiry = formatExpiry(stage.expiresAt, now);
  if (expiry !== null) facts.push(expiry);
  return facts;
}

/** 编辑区是空的时候要说一句（免得用户以为剪错了或界面坏了）。 */
export function draftNote(source: DraftSource): string | null {
  switch (source) {
    case "empty":
      return "这次暂存的正文是空的，编辑区是空的：可以直接写，或者回扩展弹窗重新剪一次。";
    case "body":
      return null;
  }
}

export function formatExpiry(expiresAt: number | null, now: number): string | null {
  if (expiresAt === null) return null;
  const left = expiresAt - now;
  if (left <= 0) return "这条暂存已经过了有效期，入库可能被接口拒绝，请重新剪藏。";
  return `这条暂存还有 ${formatSpan(left)} 的有效期，过期后需要重新剪藏。`;
}

export function formatCapturedAt(capturedAt: string | null, now: number): string | null {
  if (capturedAt === null) return null;
  const at = Date.parse(capturedAt);
  // 认不出来的时间戳就原样显示，不折算成假的时间。
  if (!Number.isFinite(at)) return `抓取时间：${capturedAt}`;
  return `抓取于 ${formatSpan(Math.max(0, now - at))}前`;
}

function formatSpan(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}
