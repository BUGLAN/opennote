'use strict'

/**
 * Opennote 网页版剪藏页 · 暂存区（内存态，带 TTL）。
 *
 * 职责边界（一个事实一个产地）：
 *   - **stageId 与 k 只在这里生成**：32 字节随机 → base64url（43 字符），不可猜；
 *     调用方（`bridge.cjs`）绝不允许把客户端给的 id 当 stageId 用。
 *   - **TTL 与「已提交」记录只在这里维护**：到期即查不到；同一条成功提交过的
 *     指纹与回执存下来，供幂等重放（不写第二遍）。
 *   - **不做**：HTTP、鉴权比较（k 的定时安全比较在 `bridge.cjs`，那里已有唯一实现）、
 *     落盘、信封校验。
 *
 * **如实说明**：暂存只活在内存里，**进程退出即失效**（不落盘、不假装是持久队列）。
 * 契约出处：`docs/import/02-接口契约-导入信封与通道.md` §5.9。
 */

const crypto = require('node:crypto')

/** 暂存有效期：15 分钟（契约 §5.9）。 */
const CLIP_STAGE_TTL_MS = 15 * 60 * 1000
/**
 * 同时在内存里的暂存条数上限（内存上限保护，不是产品语义）。
 *
 * 每条暂存最长可带 8 MiB 正文 + 至多 16 MiB 的请求体，所以条数必须有界；
 * 超出时淘汰**最旧**的一条（被淘汰的页面再提交会拿到「暂存已失效」，
 * 用户重新剪藏一次即可 —— 比让主进程吃满内存好）。
 */
const CLIP_STAGE_MAX = 16
/** stageId / k 的随机字节数：32 字节 → base64url 43 字符（契约要求「≥32 字符、不可猜」）。 */
const CLIP_SECRET_BYTES = 32
const CLIP_SECRET_LENGTH = 43

function positiveInt(value, fallback) {
  const number = typeof value === 'string' && value.trim() !== '' ? Number(value) : value
  if (typeof number !== 'number' || !Number.isFinite(number) || number <= 0) return fallback
  return Math.floor(number)
}

/** 32 字节随机 → base64url（只用 `[A-Za-z0-9_-]`，可直接进 URL）。 */
function newSecret() {
  return crypto.randomBytes(CLIP_SECRET_BYTES).toString('base64url')
}

/**
 * @param {object} [options]
 * @param {number} [options.ttlMs] 覆盖 TTL（自测用；产品路径用默认值）
 * @param {number} [options.maxStages] 覆盖条数上限（自测用）
 * @param {Function} [options.now] 时钟注入（自测用）
 */
function createClipStageStore(options = {}) {
  const clock = typeof options.now === 'function' ? options.now : Date.now
  const ttlMs = positiveInt(options.ttlMs, CLIP_STAGE_TTL_MS)
  const maxStages = positiveInt(options.maxStages, CLIP_STAGE_MAX)

  /** stageId → entry（`Map` 保持插入顺序，淘汰最旧时用它）。 */
  const entries = new Map()

  function purgeExpired() {
    const at = clock()
    for (const [id, entry] of entries) {
      if (entry.expiresAt <= at) entries.delete(id)
    }
  }

  function stage(payload) {
    purgeExpired()
    while (entries.size >= maxStages) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
    const createdAt = clock()
    const entry = {
      stageId: newSecret(),
      key: newSecret(),
      createdAt,
      expiresAt: createdAt + ttlMs,
      payload,
      /** 成功提交过才有值：`{ fingerprint, receipt, httpStatus }`（幂等重放的唯一产地）。 */
      commit: null,
    }
    entries.set(entry.stageId, entry)
    return entry
  }

  /** 取出未过期的暂存；不存在或已过期 → `null`（过期条目顺带清掉）。 */
  function get(stageId) {
    purgeExpired()
    if (typeof stageId !== 'string' || stageId === '') return null
    const entry = entries.get(stageId)
    if (!entry) return null
    if (entry.expiresAt <= clock()) {
      entries.delete(stageId)
      return null
    }
    return entry
  }

  /**
   * 记下一次**成功**的提交。只由入库通路成功返回后调用 —— 失败不记，
   * 客户端可以用同一个 stageId 重试（失败不该把暂存「用掉」）。
   */
  function recordCommit(stageId, fingerprint, receipt, httpStatus) {
    const entry = entries.get(stageId)
    if (!entry) return false
    entry.commit = { fingerprint, receipt, httpStatus }
    return true
  }

  function size() {
    purgeExpired()
    return entries.size
  }

  function clear() {
    entries.clear()
  }

  return { stage, get, recordCommit, size, clear, ttlMs, maxStages }
}

module.exports = {
  createClipStageStore,
  CLIP_STAGE_TTL_MS,
  CLIP_STAGE_MAX,
  CLIP_SECRET_BYTES,
  CLIP_SECRET_LENGTH,
}
