/**
 * `src/lib/clip` —— 剪藏与导入的 L2 接收端（`opennote.import/v1`）。
 *
 * C2 / C3 只需要 import 这一个入口：
 *
 * ```ts
 * import {
 *   receiveEnvelope,          // 应用内调用（域错误抛 ImportRejection）
 *   receiveEnvelopeOutcome,   // IPC 转交（永不抛，返回结构化错误）
 *   validateEnvelope,         // 纯函数校验器
 *   undoImport,               // 撤销（有前像 → 逐字节还原；无 → 移入回收站）
 *   setImportChannelContext,  // 桥 / 收件箱入库前声明通道
 *   setImportConflictResolver,// 把 UI-06 ConflictDialog 接上
 *   DUPLICATE_MESSAGE,        // 重复剪藏唯一规范文案
 *   UNDO_WINDOW_MS,           // 10 秒撤销窗口
 * } from "../lib/clip";
 * ```
 *
 * 幂等索引 / 前像 / 导入日志在 `src/data/importLog.ts`（`.opennote/` 下，渲染层写）。
 */

export {
  IMPORT_SPEC,
  IMPORT_ERRORS,
  IMPORT_WARNINGS,
  IMPORT_CONFLICTS,
  IMPORT_CLIENT_NAMES,
  ASSET_MIME_WHITELIST,
  MAX_BODY_BYTES,
  MAX_REQUEST_BYTES,
  MAX_ASSETS,
  MAX_ASSET_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
  MAX_TAGS,
  MAX_TAG_CHARS,
  ImportRejection,
  importProblem,
  isImportRejection,
  toImportErrorBody,
  isParseableTimestamp,
  isSafeSvg,
  isTimestampWithTimezone,
  normalizeFolder,
  normalizeNotePath,
  sanitizeTags,
  checkResolvedBody,
  decodeBase64,
  encodeBase64,
  serializeEnvelope,
  serializeEnvelopeJson,
  timestampMs,
  utf8Bytes,
  validateEnvelope,
  validateImportEnvelope,
  warningText,
} from "./envelope";

export type {
  ImportAsset,
  ImportClient,
  ImportClientName,
  ImportConflict,
  ImportEnvelope,
  ImportEnvelopeSource,
  ImportEnvelopeTarget,
  ImportProblem,
  ImportWarningCode,
  EnvelopeValidation,
} from "./envelope";

export {
  receiveEnvelope,
  receiveEnvelopeOutcome,
  undoImport,
  setImportChannelContext,
  getImportChannelContext,
  resetImportChannelContext,
  // 0.3.0 落点偏好（00 §6.14㉕㉖）：界面侧把 `UiSettings.importConflict` 接进来，
  // 否则「先进入收件箱」就只是个改 UI 值的假开关。
  setImportLandingPreference,
  getImportLandingPreference,
  resetImportLandingPreference,
  setImportConflictResolver,
  setImportNotifications,
  DUPLICATE_MESSAGE,
  UNDO_WINDOW_MS,
} from "./receive";

export type {
  EnvelopeOutcome,
  ImportChannel,
  ImportChannelContext,
  ImportConflictChoice,
  ImportConflictPrompt,
  ImportConflictResolver,
  ImportLandingPreference,
  ImportReceipt,
  ImportUndoResult,
} from "./receive";

export {
  FRONT_MATTER_KEYS,
  downgradeLeadingH1,
  firstHeading,
  renderAppended,
  renderBodyBlock,
  renderFrontMatter,
  renderMarkdown,
  renderTagLine,
  yamlScalar,
} from "./frontmatter";

export { bodyHashOf, contentHash8, contentHashOf, sha256Hex, sha256Ref, shortRef, sourceHashOf } from "./hash";

export {
  allocateAssetPath,
  allocateNotePath,
  assetFinalName,
  assetsDirFor,
  ensureFolderDirs,
  findUndeclaredAssetRefs,
  isAppendOf,
  requestedNotePath,
  rewriteAssetRefs,
} from "./landing";

export type { AssetRename, AssetTarget } from "./landing";
