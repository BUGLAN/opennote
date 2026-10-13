/**
 * `.opennote/` 的同步边界（`docs/执行-三端同步-密钥即身份-2026-10-13.md` §5.4 第 4 条）。
 *
 * `.opennote/` 是**跟着笔记本目录走**的元数据目录：导出、拷贝文件夹、进 `.git` 都会带上它。
 * 于是里面每一样东西都必须先回答一个问题：**它该不该跨设备？**
 *
 * | 文件 / 目录 | 是否跨端 | 为什么 |
 * | --- | --- | --- |
 * | `state.json` 的 `titleOverrides` | ⚠️ 语义上要同步，**但键还是路径**（见下） | 用户在某个设备上改的显示名应当跟着走 |
 * | `state.json` 的 `expanded` / `lastOpened` / `ui.*` | ❌ | 设备本地界面态，重扫时会被本地覆盖 |
 * | `trash/` | ❌ | 回收站是**设备本地**的中间态 |
 * | `history/` | ❌ | 历史快照同理；且它天然只描述本机发生过的改动 |
 * | `import-index.json` | ⚠️ 单独权衡 | 剪藏去重索引；不同步会导致同一网页在两端重复剪藏 |
 * | `github.json`（既有手动通道） | ❌ | 与新账本 `sync.json` **互相独立，绝不合并**（§4.10） |
 * | `sync.json`（新账本） | ❌ | 它就是同步的账本本身，推上去等于把账本提交进远端 |
 * | **`did` ↔ `path` 映射**（E2EE） | ❌ **绝不同步** | 它是**本机解密结果**（§2.2） |
 * | **`deviceId`** | ❌ **绝不** | 同步了会让两台设备共用一个 `_local` 检查点（见 `device.ts`） |
 * | **账号密钥 / `encRoot`** | ❌ **绝不** | 红线 3：密钥材料永不进笔记本目录 |
 *
 * ## 为什么这张表要变成代码
 *
 * 「`.opennote/` 只放本机的东西」是一条**很容易被将来的改动破坏**的纪律 —— 加一个字段、
 * 顺手写进 state.json，红线就没了，而且没有任何测试会红。所以：
 *   - `isSyncableMetaPath()` 把「哪些元数据路径永不跨端」写成可判定的函数；
 *   - `assertSafeSyncPayload()` 在**任何要落盘/外发**的入口拦住密钥材料与 `did` 映射。
 *
 * **`titleOverrides` 的已知缺口**：键是**路径**，两端各自改名会漂移（A 把 `a.md` 改名成
 * `b.md`、B 改 `titleOverride["a.md"]` → 两边对不上）。文档要求「改成按稳定 ID 关联」，
 * 那是 P1 建 `sync.json` 账本时一并做的改动，**这里先如实标记为已知缺口**，不假装已解决。
 */

import { META_DIR, normalizePath } from "../fs/paths";

/** 与同步/凭据有关的元数据文件（都在 `.opennote/` 下）。 */
export const SYNC_META_FILE = `${META_DIR}/sync.json`;
export const GITHUB_META_FILE = `${META_DIR}/github.json`;
export const IMPORT_INDEX_FILE = `${META_DIR}/import-index.json`;
export const STATE_FILE = `${META_DIR}/state.json`;

/**
 * **永不跨端**的元数据路径前缀（整棵子树）。
 *
 * 命中这里的路径在同步引擎里必须**双向不存在**：不 push、不 pull、不删、不进 diff
 * （与 §3.11 的忽略语义同一条）。`ignore.ts` 已经整目录排除了 `.opennote/`，
 * 这个表是给「不经过忽略判定的代码」（例如账本读写、E2EE 映射）用的**第二道**自检。
 */
const NEVER_SYNCED_PREFIXES: readonly string[] = [
  META_DIR, // 整个 .opennote/ —— 下面是给读代码的人看的细目
  `${META_DIR}/trash`,
  `${META_DIR}/history`,
  `${META_DIR}/inbox`,
  SYNC_META_FILE,
  GITHUB_META_FILE,
  IMPORT_INDEX_FILE,
];

/**
 * **凭据材料**：红线 3 —— 这些字段名不许出现在任何**要落进笔记本目录**或**要外发**的载荷里。
 *
 * 它是**双向**的检查：客户端不许写出去，服务端也不许收上来（§10.1 K1 就是这条的反向断言）。
 */
const FORBIDDEN_CREDENTIAL_KEYS: readonly string[] = [
  "accountKey",
  "account_key",
  "encRoot",
  "enc_root",
  "wrapKey",
  "wrap_key",
  "authToken",
  "auth_token",
  "notebookKey",
  "notebook_key",
  // 服务端存的是密文包裹，但**客户端本地也不该把它写进笔记本目录**。
  "wrappedEncRoot",
  "wrapped_enc_root",
  "privateKey",
  "private_key",
];

/**
 * **本机专属**：形状合法、在别处（例如服务端的设备清单响应）可以出现，
 * 但**绝不能落进 `.opennote/`** —— 否则会被导出、被 `.git` 带走、被同步到别的设备。
 */
const LOCAL_ONLY_KEYS: readonly string[] = [
  // E2EE 的 did ↔ path 映射：本机解密结果（§2.2）。
  "didMap",
  "didToPath",
  "pathByDid",
  // 设备身份：跨端会让两台设备共用一个 `_local` 检查点（见 `device.ts`）。
  "deviceId",
  "device_id",
];

/** 全部受管字段名（诊断用）。 */
const FORBIDDEN_PAYLOAD_KEYS: readonly string[] = [...FORBIDDEN_CREDENTIAL_KEYS, ...LOCAL_ONLY_KEYS];

/** 这条元数据路径会不会参与同步？（`false` = 永不跨端。） */
export function isSyncableMetaPath(path: string): boolean {
  const normalized = normalizePath(path);
  if (!normalized) return true;
  // 只看「精确命中」与前缀子树：`.opennote` 本身与它下面的一切都不跨端。
  for (const prefix of NEVER_SYNCED_PREFIXES) {
    if (normalized === prefix || normalized.startsWith(`${prefix}/`)) return false;
  }
  return true;
}

/** 这条路径是不是「笔记本自己的元数据」？（与 `isSyncableMetaPath` 分开，语义不同。） */
export function isMetaPath(path: string): boolean {
  const normalized = normalizePath(path);
  return normalized === META_DIR || normalized.startsWith(`${META_DIR}/`);
}

export interface PayloadViolation {
  /** 命中的字段名。 */
  key: string;
  /** 它在对象里的路径，便于定位（`ledger.device.deviceId`）。 */
  at: string;
  /** 属于哪一类约束。 */
  kind: "credential" | "local-only";
}

function scanKeys(
  value: unknown,
  keys: readonly string[],
  kind: PayloadViolation["kind"],
  at: string,
  found: PayloadViolation[],
): PayloadViolation[] {
  if (value === null || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanKeys(item, keys, kind, `${at}[${index}]`, found));
    return found;
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (keys.includes(key)) found.push({ key, at: `${at}.${key}`, kind });
    scanKeys(child, keys, kind, `${at}.${key}`, found);
  }
  return found;
}

/**
 * 深度扫描一个对象，找出**凭据材料**（红线 3，双向检查）。
 *
 * 用途：客户端落盘前的自检 + 服务端账号注册接口的「没收上来密钥」断言（§10.1 K1）。
 */
export function findCredentialKeys(value: unknown, at = "$"): PayloadViolation[] {
  return scanKeys(value, FORBIDDEN_CREDENTIAL_KEYS, "credential", at, []);
}

/**
 * 深度扫描一个对象，找出**本机专属**字段（`deviceId` / `did` 映射）。
 *
 * 用途：写 `.opennote/` 之前自检 —— 这些东西一旦进笔记本目录就会被带走。
 * **不要**拿它去检查服务端响应（设备清单里本来就有 `deviceId`，那是合法的）。
 */
export function findLocalOnlyKeys(value: unknown, at = "$"): PayloadViolation[] {
  return scanKeys(value, LOCAL_ONLY_KEYS, "local-only", at, []);
}

/**
 * 落盘 `.opennote/` 前的闸门：命中即抛。
 *
 * **抛而不是警告** —— 这些东西一旦写进笔记本目录，就会被导出、被 `.git` 带走、
 * 被同步到别的设备，事后很难收回来。
 */
export function assertSafeLocalMetaPayload(value: unknown, context: string): void {
  const violations = [...findCredentialKeys(value), ...findLocalOnlyKeys(value)];
  if (violations.length === 0) return;
  const detail = violations
    .map((item) => `${item.at}（字段 ${item.key}，${item.kind === "credential" ? "凭据材料" : "本机专属"}）`)
    .join("、");
  throw new Error(`${context} 里出现了不许落进笔记本目录的字段：${detail}`);
}

/** 诊断/文档用只读快照。 */
export function forbiddenPayloadKeys(): readonly string[] {
  return FORBIDDEN_PAYLOAD_KEYS;
}
