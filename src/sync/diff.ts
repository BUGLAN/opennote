/**
 * 同步的**纯 diff 函数**：基线 + 本地现状 + 远端树 → 计划（`docs/执行-三端同步…` §1.6、附录 A.3）。
 *
 * ## 这是「搬家」，不是「重写」
 *
 * 实现语义**逐行**来自 `src/lib/github/sync.ts` 的 `planPush` / `planPull`（那份逻辑已经过
 * 生产验证）。搬家的唯一理由是：新的同步不该依赖 `lib/github` 这个模块名 ——
 * `opennote` provider 与 `github` provider 都要用同一套收敛判据。
 *
 * **「语义没变」由证据证明，不由声明证明**：现有 GitHub 测试套件（`src/lib/github/sync.test.ts`）
 * 保持全绿 —— 它原本测的就是这几个函数，而 `src/lib/github/sync.ts` 现在从这里转发。
 *
 * ## 判据只有一个来源：基线
 *
 * 每个文件的 `localHash`（本地改没改）与 `remoteSha`/`remoteHash`（远端改没改）。
 *
 * ```
 *            本地改了   远端改了     推送时           拉取时
 *   否          否       不动             不动
 *   是          否       提交并推送       不动
 *   否          是       不动             覆盖本地
 *   是          是       ——（先拉取）     冲突，跳过并列出
 * ```
 *
 * ## 两条硬纪律（与 GitHub 通道一致）
 *
 * 1. **只动我们物化过的文件**（`imported: true`）与**本地新建**的文件；
 *    树里那些故意只记账的条目（`imported: false`）永不触碰 —— 否则一次同步会把远端
 *    我们没导入的东西当成「用户删了」而全部删掉。
 * 2. **远端树必须完整才允许「树里没有 ⇒ 删除」的推断**（`truncated`，§6.4 规则 1）。
 *
 * ## 这一层不认识明文，也不认识密钥
 *
 * 它只比较「标识字符串」：明文模式下是内容哈希，E2EE 下是 `ehash`（`HMAC(macKey, sha256(pt))`）。
 * 所以两种加密模式共用同一套收敛判据 —— 这也是为什么 `ehash` **必须是 HMAC**：
 * 直接送 `sha256(明文)` 会让服务端也能做同样的等价性判断（§3.9 第 2 条）。
 */

import { isMaterializable } from "../../shared/paths";

/** 推送的候选：一个本地文件的当前状态。 */
export interface LocalFile {
  path: string;
  hash: string;
  bytes: number;
}

export interface PushPlan {
  added: LocalFile[];
  modified: LocalFile[];
  deleted: string[];
}

/**
 * 远端树里的一条（**provider 无关**的最小投影）。
 *
 * `hash` 是「远端那一版的标识」：GitHub 用 blob sha，`opennote` provider 用文档的
 * `hash`（明文）或 `ehash`（E2EE）。对 diff 逻辑而言两者没有区别 —— 它只比相等。
 *
 * ⚠️ **不同 provider 的标识不是同一种哈希**（GitHub 是 git 的 blob SHA-1，我们是 sha256 或
 * `ehash`），所以「远端标识 == 本地标识」永远不成立。这不是缺陷：它恰好说明
 * **false-conflict 的判定只能在同一个哈希空间里做**（见 `planPull` 里的说明）。
 */
export interface RemoteTreeEntry {
  path: string;
  hash: string;
}

export interface RemoteTree {
  /** 远端树是否**只取了一部分**（分页没取完 / API 说 truncated）。 */
  truncated?: boolean;
  entries: RemoteTreeEntry[];
}

/**
 * 基线里的一条（**provider 无关**的最小形状）。
 *
 * 注意字段名是 `remoteHash` 而不是 GitHub 基线里的 `remoteSha`：
 * 「远端那一版的标识」在 `opennote` 那条路上是内容标识（明文 sha256 / E2EE 的 `ehash`），
 * 不一定是 sha。GitHub 的 `GithubBaselineFile` 与同步账本 `SyncLedgerFile` **都**结构上
 * 满足这一份（前者由 `src/lib/github/sync.ts` 映射，后者字段名本来就是 `remoteHash`）。
 */
export interface BaselineFile {
  /** 远端那一版的标识（判断「远端改没改」）。 */
  remoteHash: string | null;
  /** 上次同步时本地内容的标识（判断「本地改没改」）；没物化的文件是 `null`。 */
  localHash: string | null;
  /** 我们有没有把这一条写到本地。`false` = 只在基线里记账，同步永不触碰它。 */
  imported: boolean;
}

export interface BaselineLike {
  files: Record<string, BaselineFile>;
}

/**
 * 纯函数：基线 + 本地现状 → 推送计划。
 *
 * 判定「本地改了」用的是**内容标识**而不是 mtime：Git 克隆、网盘同步、手工拷贝
 * 都可能改 mtime 而不改内容，用 mtime 会让整棵树每次都被判成「改过」。
 */
export function planPush(baseline: BaselineLike, local: LocalFile[]): PushPlan {
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const added: LocalFile[] = [];
  const modified: LocalFile[] = [];
  const deleted: string[] = [];

  for (const file of local) {
    const known = baseline.files[file.path];
    if (!known) {
      added.push(file);
      continue;
    }
    if (known.localHash !== file.hash) modified.push(file);
  }
  for (const [path, known] of Object.entries(baseline.files)) {
    if (!known.imported) continue; // 没物化过的东西绝不当作「用户删了」
    if (localByPath.has(path)) continue;
    deleted.push(path);
  }
  return { added, modified, deleted };
}

export function pushIsEmpty(plan: PushPlan): boolean {
  return plan.added.length === 0 && plan.modified.length === 0 && plan.deleted.length === 0;
}

export interface PullPlan {
  /** 远端新增或远端已改、且本地没动 —— 可以直接覆盖本地。 */
  download: { path: string; sha: string }[];
  /** 远端删了、本地没动 —— 可以删本地。 */
  removeLocal: string[];
  /** 两边都改了（含「本地删了 / 远端改了」）：**不动**，列出来给人看。 */
  conflicts: { path: string; reason: "both-modified" | "deleted-locally-modified-remotely" | "deleted-remotely-modified-locally" }[];
}

/**
 * 纯函数：基线 + 远端树 + 本地现状 → 拉取计划。
 *
 * **只有「该物化的路径」才可能进 `download`**（判据是 `isMaterializable()`，与导入同一份）：
 * 基线里那些故意只记账的源码/配置（`imported:false`）**永远不落地** —— 否则一次拉取就会把
 * 远端源码写进笔记本，而下一次推送又把它当成新笔记推回去。
 *
 * ⚠️ **`truncated` 的处理不在这个纯函数里**，而在调用方：本函数只依据「传进来的这棵树」
 * 做判定，所以树不完整时**调用方必须拒绝执行 `removeLocal`**（§6.4 规则 1）。
 * 这样拆分是为了让「误删」这件最严重的事有一个**单一、可测**的闸门，
 * 而不是散在纯函数的条件分支里。
 */
export function planPull(baseline: BaselineLike, remote: RemoteTree, local: LocalFile[]): PullPlan {
  const localByPath = new Map(local.map((file) => [file.path, file]));
  const remoteByPath = new Map(remote.entries.map((entry) => [entry.path, entry]));
  const download: PullPlan["download"] = [];
  const removeLocal: string[] = [];
  const conflicts: PullPlan["conflicts"] = [];

  for (const [path, entry] of remoteByPath) {
    const known = baseline.files[path];
    const localFile = localByPath.get(path);
    const remoteChanged = !known || known.remoteHash !== entry.hash;
    if (!remoteChanged) continue;

    if (!isMaterializable(path)) continue; // 源码 / 配置：只更新下面那一轮账本，绝不落地
    if (!known || !known.imported) {
      /*
       * 两种情况都直接拉：
       * - 远端新增的笔记或图片：没有本地改动可言；
       * - **上次没物化成功的**（超上限 / 取字节失败）：`localHash` 是 null、本地也确实没有这个文件，
       *   那不是「用户删了它」—— 这里给它一次重试机会（拉下来之后 `localHash` 才成为真值）。
       */
      download.push({ path, sha: entry.hash });
      continue;
    }
    if (!localFile) {
      // 物化过的文件被本地删了，远端又改了它：两边都动了，只能问人
      conflicts.push({ path, reason: "deleted-locally-modified-remotely" });
      continue;
    }
    const localChanged = localFile.hash !== known.localHash;
    if (localChanged) {
      /*
       * **「false conflict」判定（§6.2、§9 P1 验收）**：两边都改了，但内容标识**相同**
       * ⇒ 判为已同步，不进冲突。
       *
       * ⚠️ **这条只在同一个哈希空间里成立**，所以它不是普适的：
       *   - `opennote` provider（明文模式）：远端 `hash` 与本地 `hash` **都是 sha256** ⇒ 能判；
       *   - `opennote` provider（E2EE）：两边**都是 `ehash`** ⇒ 能判（这就是 `ehash` 必须
       *     是 HMAC 而不是裸 `sha256(明文)` 的原因之一，§3.9 第 2 条）；
       *   - `github` provider：远端是 git 的 blob SHA-1、本地是 sha256 ⇒ **永远不相等**，
       *     这条分支实际不可达。这是**如实记录**，不是缺陷：GitHub 的 blob sha 本来就是
       *     内容寻址且自带去重，「两边都改但内容相同」在那边表现为「远端 sha 有变、
       *     但下载下来的字节与本地一样」，需要另一次字节比较才能认出来。
       *
       * 少了这条判定，每次同步都会冒出一批「其实一样」的假冲突，用户很快就不看那个列表了。
       * 依据：rclone bisync 的官方定义；二次来源是 Unison 手册的 "false conflict"。
       */
      if (localFile.hash === entry.hash) {
        // 已经同步过了：只更新账本（调用方负责），不进任何计划。
        continue;
      }
      conflicts.push({ path, reason: "both-modified" });
      continue;
    }
    download.push({ path, sha: entry.hash });
  }

  for (const [path, known] of Object.entries(baseline.files)) {
    if (!known.imported) continue;
    if (remoteByPath.has(path)) continue;
    const localFile = localByPath.get(path);
    if (!localFile) continue; // 两边都没了
    const localChanged = localFile.hash !== known.localHash;
    if (localChanged) conflicts.push({ path, reason: "deleted-remotely-modified-locally" });
    else removeLocal.push(path);
  }

  return { download, removeLocal, conflicts };
}

/**
 * 删除保护阈值（§6.3）：一次同步计划删除数 > `max(20, 总量 × 25%)` → 停止并请用户确认。
 *
 * **客户端与服务端各跑一遍**（服务端那一份拒绝经 `/v1/*` 过来的批量删除）。
 * 返回 `null` = 放行；返回字符串 = 拦住并说明原因。
 */
export function assertDeletionBudget(totalKnown: number, plannedDeletes: number): string | null {
  const budget = Math.max(20, Math.floor(totalKnown * 0.25));
  if (plannedDeletes <= budget) return null;
  return `这一次要删除 ${plannedDeletes} 个文件，超过保护阈值（${budget} 个，= max(20, 总量的 25%)）。请确认后重试。`;
}

/**
 * 树不完整时把删除计划挂起（§6.4 规则 1）。
 *
 * **这是防误删的那一道闸门**：`truncated` 为真时只做新增与更新，
 * **全部删除一律挂起待确认** —— 因为「树里没有」很可能只是「这一页没取到」。
 */
export function applyTruncationGuard(plan: PullPlan, truncated: boolean): PullPlan & { suspendedDeletes: string[] } {
  if (!truncated) return { ...plan, suspendedDeletes: [] };
  return { ...plan, removeLocal: [], suspendedDeletes: [...plan.removeLocal] };
}
