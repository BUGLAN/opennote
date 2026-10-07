'use strict'

/**
 * Opennote 桌面端自更新的**唯一大脑**（主进程侧）。
 *
 * 为什么在主进程：
 *   渲染层拿不到本机磁盘与进程控制，也不该为更新放开 CSP 的 `connect-src`
 *   （`electron/main.cjs` 的 `cspPolicy()` 是冻结基线）。所以：网络、磁盘、进程
 *   全在这里；渲染层只拿一个 `UpdateStatus` 对象决定画哪个图标。
 *
 * 不变式（改动前先读）：
 *   1. 渲染层**不能**指定 URL / 路径 / 版本 —— 它只能调
 *      `status / check / download / cancel / restart`（见 `electron/preload.cjs`）。
 *      唯一可配置的入口是主进程环境变量 `OPENNOTE_UPDATE_API_BASE`（镜像与 e2e 用）。
 *   2. 仓库身份只来自打包内 `package.json` 的 `repository.url`（不是 `homepage`：
 *      那个字段曾经指向一个不存在的组织）。
 *   3. 校验不过 = 删包 + 明确报错，**绝不安装未校验的字节**。
 *   4. 覆盖安装必须由用户点「重启并更新」触发，没有静默安装。
 *   5. 失败一律落成 `{ code, message }`（中文、可执行、不含绝对路径），绝不静默。
 *
 * 顶层只 require node 内建 + 同目录的 `./zip.cjs`（见 RELEASING.md 已知坑 #4：
 * 主进程不许 require 第三方包）。
 */

const crypto = require('node:crypto')
const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const https = require('node:https')
const path = require('node:path')
const { Transform } = require('node:stream')
const { pipeline } = require('node:stream/promises')
const { extract, ZipError, withAsarDisabled } = require('./zip.cjs')

/** 与 `electron/update-helper.cjs` 之间的握手/回执字段名（helper 独立运行，见那边的注释）。 */
const PROTOCOL = {
  handoffEnv: 'OPENNOTE_UPDATE_HANDOFF',
  helperName: '.apply-update.cjs',
  handoffFile: 'handoff.json',
  resultFile: 'result.json',
  logFile: 'apply.log',
  readyMarker: '.ready',
  applyingMarker: '.applying',
  stagingPrefix: 'staging-',
  exeName: 'Opennote.exe',
  handoffKeys: ['pid', 'installDir', 'stagingDir', 'exeName', 'argv', 'logPath', 'version', 'resultPath', 'from'],
  resultKeys: ['ok', 'from', 'to', 'at', 'error'],
}

const CHECK_COOLDOWN_MS = 30 * 1000
const PROGRESS_EMIT_INTERVAL_MS = 200
const REQUEST_TIMEOUT_MS = 20000
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024
const USER_AGENT = 'Opennote-Updater'
const JSON_HEADERS = { accept: 'application/vnd.github+json', 'user-agent': USER_AGENT }
const TEXT_HEADERS = { 'user-agent': USER_AGENT }
const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

class UpdateError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'UpdateError'
    this.code = code
  }
}

// ---------------------------------------------------------------------------
// 纯函数：版本、资产、校验和
// ---------------------------------------------------------------------------

/** 解析 `v0.6.0` / `0.6.0-rc.1`。无法识别返回 null（宁可不说，也不瞎猜）。 */
function parseVersion(value) {
  if (typeof value !== 'string') return null
  const match = VERSION_PATTERN.exec(value.trim())
  if (!match) return null
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  }
}

/** semver 口径比较：返回 -1 / 0 / 1。任一侧无法识别时返回 0（= 不提示更新）。 */
function compareVersions(left, right) {
  const a = parseVersion(left)
  const b = parseVersion(right)
  if (!a || !b) return 0
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] > b[key] ? 1 : -1
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0
  if (a.prerelease.length === 0) return 1
  if (b.prerelease.length === 0) return -1
  const length = Math.max(a.prerelease.length, b.prerelease.length)
  for (let index = 0; index < length; index += 1) {
    const leftPart = a.prerelease[index]
    const rightPart = b.prerelease[index]
    if (leftPart === undefined) return -1
    if (rightPart === undefined) return 1
    const leftNumeric = /^\d+$/.test(leftPart)
    const rightNumeric = /^\d+$/.test(rightPart)
    if (leftNumeric && rightNumeric) {
      if (Number(leftPart) !== Number(rightPart)) return Number(leftPart) > Number(rightPart) ? 1 : -1
      continue
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1
    if (leftPart !== rightPart) return leftPart > rightPart ? 1 : -1
  }
  return 0
}

function isNewer(candidate, current) {
  return compareVersions(candidate, current) > 0
}

/**
 * 从 `repository.url` 取 GitHub 归属。
 * 认 `git+https://github.com/o/r.git`、`https://github.com/o/r`、`git@github.com:o/r.git`。
 */
function parseRepoSlug(url) {
  if (typeof url !== 'string') return null
  const cleaned = url
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '')
  const match = /github\.com[/:]([^/]+)\/([^/]+)$/.exec(cleaned)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

/** 发布资产的命名约定（与 `.github/workflows/release.yml` 的 artifactName 一致）。 */
function assetNameFor(version, options = {}) {
  const platform = options.platform || 'win'
  const arch = options.arch || 'x64'
  return `Opennote-${version}-${platform}-${arch}.zip`
}

/** 只认 Windows 免安装包；找不到就返回 null（由调用方报「没有可用的安装包」）。 */
function pickWindowsAsset(release, options = {}) {
  const arch = options.arch || 'x64'
  const assets = release && Array.isArray(release.assets) ? release.assets : []
  const wanted = new RegExp(`^Opennote-(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?)-win-${arch}\\.zip$`)
  for (const asset of assets) {
    if (!asset || typeof asset.name !== 'string') continue
    const match = wanted.exec(asset.name)
    if (!match) continue
    return {
      name: asset.name,
      version: match[1],
      url: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
      size: Number(asset.size) > 0 ? Number(asset.size) : 0,
      digest: typeof asset.digest === 'string' ? asset.digest : '',
    }
  }
  return null
}

/** `SHA256SUMS`（GNU coreutils 格式：`<64 hex>  <文件名>`，可带 `*` 二进制标记）。 */
function parseChecksums(text) {
  const table = new Map()
  if (typeof text !== 'string') return table
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(line)
    if (!match) continue
    table.set(match[2].trim(), match[1].toLowerCase())
  }
  return table
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

function formatMegabytes(bytes) {
  return `${Math.round(bytes / (1024 * 1024))} MB`
}

// ---------------------------------------------------------------------------
// HTTP（node 内建，跟随重定向，带超时与体积上限）
// ---------------------------------------------------------------------------

function statusError(status) {
  if (status === 403 || status === 429) {
    return new UpdateError('RATE_LIMIT', 'GitHub 暂时限制了查询，请稍后再试，或到 Releases 页面手动下载')
  }
  if (status === 404) return new UpdateError('NOT_FOUND', '没有找到可用的发布版本')
  return new UpdateError('NETWORK', `连接更新服务失败（HTTP ${status}），请稍后重试`)
}

/**
 * 发起 GET 并**立刻**交回响应流（不缓冲）。
 *
 * @returns {Promise<import('node:http').IncomingMessage>}
 */
function requestStream(url, options = {}) {
  const headers = options.headers || TEXT_HEADERS
  const signal = options.signal
  const redirects = options.redirects === undefined ? 5 : options.redirects
  const followRedirects = options.followRedirects !== false
  return new Promise((resolve, reject) => {
    let parsed
    try {
      parsed = new URL(url)
    } catch {
      reject(new UpdateError('NETWORK', '更新地址无法识别'))
      return
    }
    const transport = parsed.protocol === 'https:' ? https : parsed.protocol === 'http:' ? http : null
    if (!transport) {
      reject(new UpdateError('NETWORK', '更新地址必须是 http(s)'))
      return
    }
    const request = transport.request(
      parsed,
      { method: 'GET', headers, timeout: REQUEST_TIMEOUT_MS, signal },
      (response) => {
        const status = response.statusCode || 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && location) {
          if (!followRedirects) {
            // 调用方要看 Location（限流降级路径靠它拿 tag），所以原样交回响应。
            resolve(response)
            return
          }
          response.resume()
          if (redirects <= 0) {
            reject(new UpdateError('NETWORK', '更新地址重定向次数过多'))
            return
          }
          let next
          try {
            next = new URL(location, parsed).toString()
          } catch {
            reject(new UpdateError('NETWORK', '更新地址重定向无效'))
            return
          }
          requestStream(next, { ...options, headers, redirects: redirects - 1 }).then(resolve, reject)
          return
        }
        if (status < 200 || status >= 300) {
          response.resume()
          reject(statusError(status))
          return
        }
        resolve(response)
      },
    )
    request.on('timeout', () => {
      request.destroy(new UpdateError('NETWORK', '连接更新服务超时，请检查网络后重试'))
    })
    request.on('error', (error) => {
      if (error && error.name === 'AbortError') reject(new UpdateError('ABORTED', '已取消'))
      else if (error instanceof UpdateError) reject(error)
      else reject(new UpdateError('NETWORK', '连接更新服务失败，请检查网络后重试'))
    })
    request.end()
  })
}

async function readAll(response, limit = MAX_RESPONSE_BYTES) {
  const chunks = []
  let total = 0
  for await (const chunk of response) {
    total += chunk.length
    if (total > limit) throw new UpdateError('NETWORK', '更新服务的响应过大，已中止')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function fetchText(url, options = {}) {
  const response = await requestStream(url, options)
  return readAll(response, options.limit)
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options)
  try {
    return JSON.parse(text)
  } catch {
    throw new UpdateError('NOT_FOUND', '发布信息格式无法识别')
  }
}

/**
 * 流式下载到 `targetPath`，边下边算 sha256，下完立刻比对。
 * 校验不过抛 `CHECKSUM_MISMATCH`（调用方负责删掉半截文件）。
 */
async function downloadToFile(url, targetPath, options = {}) {
  const response = await requestStream(url, { headers: TEXT_HEADERS, signal: options.signal })
  const headerLength = Number(response.headers['content-length'])
  const total = Number.isFinite(headerLength) && headerLength > 0 ? headerLength : 0
  const hash = crypto.createHash('sha256')
  let received = 0
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length
      hash.update(chunk)
      if (typeof options.onProgress === 'function') options.onProgress(received, total)
      callback(null, chunk)
    },
  })
  await fsp.mkdir(path.dirname(targetPath), { recursive: true })
  try {
    await pipeline(
      response,
      meter,
      fs.createWriteStream(targetPath),
      options.signal ? { signal: options.signal } : {},
    )
  } catch (error) {
    // 取消（用户点了「取消」或正在退出）不是「失败」：上层据此回到「可下载」而不是报错。
    if (error && error.name === 'AbortError') throw new UpdateError('ABORTED', '已取消')
    throw error
  }
  const digest = hash.digest('hex')
  if (isSha256(options.expectedSha256) && digest !== options.expectedSha256) {
    throw new UpdateError('CHECKSUM_MISMATCH', '下载的安装包校验失败，已丢弃（请重试）')
  }
  return { bytes: received, sha256: digest, total }
}

function errorCodeOf(error) {
  if (error instanceof UpdateError) return error.code
  if (error && error.code === 'ABORTED') return 'ABORTED'
  if (error instanceof ZipError) return 'EXTRACT_FAILED'
  return 'NETWORK'
}

function errorMessageOf(error) {
  const raw = error instanceof Error && typeof error.message === 'string' ? error.message : ''
  if (error instanceof UpdateError || error instanceof ZipError) return raw
  if (error && error.code === 'ENOSPC') return '磁盘空间不足，更新已中止'
  return '更新失败，请稍后重试'
}

/**
 * 日志用（**不是**给用户看的）：未知错误的原文往往只有 `EPERM`/`EBUSY` 这类信息，
 * 全被上面那句通用文案吃掉的话，线上就只剩「更新失败，请稍后重试」无从下手。
 * 绝对路径在这里也要脱敏（日志经常被整段贴进 issue）。
 */
function errorDetailForLog(error) {
  if (!error || typeof error !== 'object') return String(error)
  const name = typeof error.name === 'string' ? error.name : 'Error'
  const code = typeof error.code === 'string' ? error.code : ''
  const message = typeof error.message === 'string' ? error.message : ''
  const scrubbed = message
    .replace(/[A-Za-z]:[\\/][^\s'"，。）]*/g, '<路径已隐藏>')
    .replace(/\/(?:Users|home|root|tmp|var|etc|opt|mnt|media|private)\/[^\s'"，。）]*/g, '<路径已隐藏>')
  const stack = typeof error.stack === 'string' ? error.stack : ''
  const frames = stack
    .split('\n')
    .slice(1, 5)
    .map((line) => line.trim().replace(/[A-Za-z]:[\\/][^\s)('"]*/g, '<路径已隐藏>'))
    .join(' ← ')
  return `${name}${code ? `(${code})` : ''}${scrubbed ? `: ${scrubbed}` : ''}${frames ? ` @ ${frames}` : ''}`
}

// ---------------------------------------------------------------------------
// 状态机
// ---------------------------------------------------------------------------

/**
 * @param {object} config
 * @param {string} config.appVersion        `app.getVersion()`
 * @param {string} config.repositoryUrl     打包内 `package.json` 的 `repository.url`
 * @param {string} [config.apiBase]         默认 https://api.github.com（e2e/镜像可覆盖）
 * @param {string} [config.downloadBase]    默认 https://github.com/<owner>/<repo>/releases
 * @param {string} config.updatesDir        `userData/updates`
 * @param {string} config.installDir        exe 所在目录
 * @param {string} [config.platform]        `process.platform`
 * @param {string} [config.arch]            `process.arch`
 * @param {boolean} [config.supported]      硬门（打包 + win32 + x64）
 * @param {(plan: object) => Promise<{ok: boolean, reason?: string}>} [config.apply] 覆盖并重启
 * @param {(status: object) => void} [config.onChange]
 * @param {(message: string) => void} [config.log]
 * @param {() => number} [config.now]
 */
function createUpdater(config = {}) {
  const appVersion = typeof config.appVersion === 'string' ? config.appVersion : '0.0.0'
  const repositoryUrl = typeof config.repositoryUrl === 'string' ? config.repositoryUrl : ''
  const slug = parseRepoSlug(repositoryUrl)
  const apiBase = String(config.apiBase || 'https://api.github.com').replace(/\/+$/, '')
  const downloadBase = String(
    config.downloadBase || (slug ? `https://github.com/${slug.owner}/${slug.repo}/releases` : ''),
  ).replace(/\/+$/, '')
  const updatesDir = config.updatesDir || ''
  const installDir = config.installDir || ''
  const arch = config.arch || process.arch
  /**
   * 硬门：既要平台/打包形态对，也要**仓库身份能解析出来**。
   * 解析不出来（`repository.url` 缺失或写错组织）时宁可完全不显示更新入口 ——
   * 否则每次检查都只会得到一个 404，用户看到的是一个永远失败的图标。
   */
  const supported =
    (config.supported === undefined
      ? Boolean(updatesDir && installDir)
      : config.supported === true) && Boolean(slug)
  const log = typeof config.log === 'function' ? config.log : () => {}
  const onChange = typeof config.onChange === 'function' ? config.onChange : () => {}
  const apply = typeof config.apply === 'function' ? config.apply : null
  const now = typeof config.now === 'function' ? config.now : () => Date.now()
  const fileSystem = config.fs || fsp
  const extractZip = config.extract || extract

  let phase = 'idle'
  let latest = null
  let latestTag = null
  let releaseUrl = null
  let assetInfo = null
  let progress = null
  let lastError = null
  let checkedAt = null
  let lastCheckAt = 0
  let lastProgressEmitAt = 0
  let installWritable = null
  let readyPlan = null
  let controller = null
  let inFlight = null
  let applyResult = null

  function statusPayload() {
    return {
      supported,
      current: appVersion,
      phase,
      latest,
      releaseUrl,
      asset: assetInfo ? { name: assetInfo.name, size: assetInfo.size } : null,
      progress: progress ? { ...progress } : null,
      error: lastError ? { ...lastError } : null,
      canAutoInstall: supported && installWritable !== false,
      checkedAt: checkedAt ? new Date(checkedAt).toISOString() : null,
    }
  }

  function emit() {
    try {
      onChange(statusPayload())
    } catch (error) {
      log(`更新状态广播失败：${errorMessageOf(error)}`)
    }
  }

  function reportProgress(kind, received, total) {
    const safeTotal = total > 0 ? total : 0
    const percent = safeTotal > 0 ? Math.min(100, Math.round((received / safeTotal) * 100)) : 0
    progress = { kind, received, total: safeTotal, percent }
    const at = now()
    if (at - lastProgressEmitAt >= PROGRESS_EMIT_INTERVAL_MS || percent >= 100) {
      lastProgressEmitAt = at
      emit()
    }
  }

  /** 从 GitHub API 取最新 Release；限流时降级成「解析 releases/latest 的 302」。 */
  async function fetchLatestRelease(signal) {
    if (!slug) throw new UpdateError('UNSUPPORTED', '应用里没有可用的仓库信息，无法检查更新')
    const url = `${apiBase}/repos/${slug.owner}/${slug.repo}/releases/latest`
    try {
      const release = await fetchJson(url, { headers: JSON_HEADERS, signal })
      if (!release || typeof release.tag_name !== 'string') {
        throw new UpdateError('NOT_FOUND', '发布信息格式无法识别')
      }
      const version = String(release.tag_name).replace(/^v/, '')
      if (!parseVersion(version)) throw new UpdateError('NOT_FOUND', '发布版本号无法识别')
      return {
        tag: release.tag_name,
        version,
        htmlUrl: typeof release.html_url === 'string' ? release.html_url : '',
        assets: Array.isArray(release.assets) ? release.assets : [],
      }
    } catch (error) {
      if (errorCodeOf(error) !== 'RATE_LIMIT') throw error
      log('GitHub API 限流，降级为 releases/latest 重定向解析')
      return fetchLatestByRedirect(signal)
    }
  }

  async function fetchLatestByRedirect(signal) {
    const response = await requestStream(`${downloadBase}/latest`, {
      headers: TEXT_HEADERS,
      redirects: 0,
      followRedirects: false,
      signal,
    })
    const location = typeof response.headers.location === 'string' ? response.headers.location : ''
    response.resume()
    const match = /\/tag\/([^/?#]+)$/.exec(location)
    if (!match) throw new UpdateError('NOT_FOUND', '没有找到可用的发布版本')
    const tag = decodeURIComponent(match[1])
    const version = tag.replace(/^v/, '')
    if (!parseVersion(version)) throw new UpdateError('NOT_FOUND', '发布版本号无法识别')
    return {
      tag,
      version,
      htmlUrl: location.startsWith('http') ? location : `https://github.com${location}`,
      assets: [],
    }
  }

  async function check(options = {}) {
    if (!supported) return statusPayload()
    if (phase === 'downloading') return statusPayload()
    const force = options.force === true
    if (!force && phase === 'checking') return statusPayload()
    if (!force && checkedAt && now() - lastCheckAt < CHECK_COOLDOWN_MS) return statusPayload()
    if (inFlight) return inFlight
    phase = 'checking'
    lastError = null
    emit()
    inFlight = (async () => {
      try {
        const release = await fetchLatestRelease(undefined)
        checkedAt = new Date(now()).toISOString()
        lastCheckAt = now()
        latest = release.version
        latestTag = release.tag
        releaseUrl = release.htmlUrl || `${downloadBase}/tag/${release.tag}`
        if (!isNewer(release.version, appVersion)) {
          assetInfo = null
          phase = 'idle'
          return statusPayload()
        }
        let asset = pickWindowsAsset({ assets: release.assets }, { arch })
        if (!asset && release.assets.length === 0) {
          // 降级路径拿不到资产列表：按命名约定拼一个，完整性仍由 SHA256SUMS 保证。
          asset = {
            name: assetNameFor(release.version, { platform: 'win', arch }),
            version: release.version,
            url: `${downloadBase}/download/${release.tag}/${assetNameFor(release.version, { platform: 'win', arch })}`,
            size: 0,
            digest: '',
          }
        }
        if (!asset) {
          throw new UpdateError('UNSUPPORTED', '最新版本没有 Windows x64 免安装包')
        }
        assetInfo = asset
        phase = 'available'
      } catch (error) {
        progress = null
        lastError = { code: errorCodeOf(error), message: errorMessageOf(error) }
        phase = 'error'
        log(`检查更新失败（${lastError.code}）：${lastError.message}`)
      } finally {
        inFlight = null
        emit()
      }
      return statusPayload()
    })()
    return inFlight
  }

  /** 安装目录必须可写，否则「下载成功但覆盖不了」比不下载更糟。 */
  async function assertInstallWritable() {
    if (!installDir) {
      installWritable = false
      throw new UpdateError('READ_ONLY_INSTALL', '无法确定 Opennote 的安装目录，不能自动覆盖更新')
    }
    const probe = path.join(installDir, `.opennote-write-probe-${process.pid}`)
    try {
      await fileSystem.writeFile(probe, 'probe', 'utf8')
      await fileSystem.rm(probe, { force: true })
      installWritable = true
    } catch {
      installWritable = false
      throw new UpdateError(
        'READ_ONLY_INSTALL',
        'Opennote 所在的目录不可写（例如 Program Files），无法自动覆盖。请到 Releases 页面手动下载解压覆盖。',
      )
    }
  }

  /** 磁盘预检（尽力而为：statfs 不可用就跳过，绝不拿假数字拦人）。 */
  async function assertDiskSpace(zipSize) {
    if (!zipSize || typeof fileSystem.statfs !== 'function') return
    let available = 0
    try {
      const stats = await fileSystem.statfs(updatesDir)
      available = Number(stats.bavail) * Number(stats.bsize)
    } catch {
      return
    }
    const needed = zipSize * 3.5 + 32 * 1024 * 1024
    if (available > 0 && available < needed) {
      throw new UpdateError(
        'DISK_FULL',
        `磁盘空间不足：更新需要约 ${formatMegabytes(needed)}，当前可用 ${formatMegabytes(available)}`,
      )
    }
  }

  /** 期望的 sha256：优先 `SHA256SUMS`（发布方自己发的），其次 GitHub 的 asset digest。 */
  async function resolveExpectedChecksum(asset, tag) {
    try {
      const text = await fetchText(`${downloadBase}/download/${tag}/SHA256SUMS`, { headers: TEXT_HEADERS })
      const expected = parseChecksums(text).get(asset.name)
      if (!expected) {
        throw new UpdateError('CHECKSUM_MISMATCH', '发布包里没有这个安装包的校验和，已取消更新')
      }
      return expected
    } catch (error) {
      if (error instanceof UpdateError && error.code === 'CHECKSUM_MISMATCH') throw error
      const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice(7) : ''
      if (isSha256(digest)) return digest
      throw new UpdateError('CHECKSUM_MISMATCH', '读不到发布包的校验和，已取消更新（不会安装无法校验的包）')
    }
  }

  async function download() {
    if (!supported) return statusPayload()
    if (phase === 'checking' || phase === 'downloading') return statusPayload()
    const retryable = phase === 'error' && assetInfo && latestTag
    if (phase !== 'available' && !retryable) return statusPayload()

    const asset = assetInfo
    const version = asset.version
    const tag = latestTag
    phase = 'downloading'
    lastError = null
    progress = { kind: 'download', received: 0, total: asset.size || 0, percent: 0 }
    controller = new AbortController()
    const signal = controller.signal
    try {
      await assertInstallWritable()
      await assertDiskSpace(asset.size)
      const expected = await resolveExpectedChecksum(asset, tag)
      const zipPath = path.join(updatesDir, asset.name)
      const partPath = `${zipPath}.part`
      await fileSystem.mkdir(updatesDir, { recursive: true })
      await fileSystem.rm(partPath, { force: true })
      try {
        await downloadToFile(asset.url, partPath, {
          expectedSha256: expected,
          signal,
          onProgress: (received, total) => reportProgress('download', received, total || asset.size),
        })
      } catch (error) {
        await fileSystem.rm(partPath, { force: true }).catch(() => {})
        throw error
      }
      await fileSystem.rm(zipPath, { force: true })
      await fileSystem.rename(partPath, zipPath)

      const stagingDir = path.join(updatesDir, `${PROTOCOL.stagingPrefix}${version}`)
      // staging 里会出现 `resources/app.asar`：删除与写入都要关掉 Electron 的 asar 补丁
      // （否则补丁会把那个文件名当归档打开，抛 `Invalid package`，见 zip.cjs 的注释）。
      await withAsarDisabled(() => fileSystem.rm(stagingDir, { recursive: true, force: true }))
      progress = { kind: 'extract', received: 0, total: 0, percent: 0 }
      emit()
      await extractZip(zipPath, stagingDir, {
        signal,
        onProgress: (done, total) => reportProgress('extract', done, total),
      })
      // 解压成功后 zip 就没用了（helper 从 staging 复制，不再碰它）：立刻删掉，
      // 别把 151 MB 留在 userData 里。`readyPlan.zipPath` 只作记录，不代表文件还在。
      await fileSystem.rm(zipPath, { force: true }).catch(() => {})
      await withAsarDisabled(() =>
        fileSystem.writeFile(
          path.join(stagingDir, PROTOCOL.readyMarker),
          JSON.stringify({ version, at: new Date(now()).toISOString(), asset: asset.name }),
          'utf8',
        ),
      )
      readyPlan = {
        version,
        tag,
        zipPath,
        stagingDir,
        exeName: PROTOCOL.exeName,
        assetName: asset.name,
      }
      progress = null
      phase = 'ready'
      log(`已下载并解压 v${version}，等待用户重启更新`)
    } catch (error) {
      progress = null
      readyPlan = null
      if (error && error.code === 'ABORTED') {
        lastError = null
        phase = assetInfo && latestTag ? 'available' : 'idle'
      } else {
        lastError = { code: errorCodeOf(error), message: errorMessageOf(error) }
        phase = 'error'
        log(`下载更新失败（${lastError.code}）：${errorDetailForLog(error)}`)
      }
    } finally {
      controller = null
      emit()
    }
    return statusPayload()
  }

  async function cancel() {
    if (controller) controller.abort()
    return statusPayload()
  }

  /** 交给主进程去「落盘 → 关窗 → 覆盖 → 重开」；这里只管调用与错误落账。 */
  async function restart() {
    if (!supported) return { ok: false, reason: 'UNSUPPORTED' }
    if (phase !== 'ready' || !readyPlan) return { ok: false, reason: 'NOT_READY' }
    if (!apply) return { ok: false, reason: 'NO_APPLIER' }
    try {
      const result = await apply({ ...readyPlan })
      if (!result || result.ok !== true) {
        return { ok: false, reason: (result && result.reason) || 'FAILED' }
      }
      return { ok: true }
    } catch (error) {
      lastError = { code: 'APPLY_FAILED', message: errorMessageOf(error) }
      phase = 'error'
      emit()
      return { ok: false, reason: 'FAILED' }
    }
  }

  async function pathExists(target) {
    try {
      await fileSystem.access(target)
      return true
    } catch {
      return false
    }
  }

  /**
   * 启动时收尾：
   *   ① 读回上一次覆盖脚本留下的 `result.json`（成功/失败都要如实播报一次）；
   *   ② 上次已下载好但没重启 → 直接进 `ready`（不白下 151 MB）；
   *   ③ 清掉 `*.part` 与半成品 staging（保留 ready 那个）。
   */
  async function resume() {
    if (!supported) return statusPayload()
    applyResult = await consumeApplyResult()
    // 握手文件里只有上一次的 pid / argv / 路径，用完即删（`apply.log` 保留：它是排障线索）。
    await fileSystem.rm(path.join(updatesDir, PROTOCOL.handoffFile), { force: true }).catch(() => {})
    try {
      const names = await fileSystem.readdir(updatesDir)
      for (const name of names) {
        const target = path.join(updatesDir, name)
        if (name.endsWith('.part')) {
          await fileSystem.rm(target, { force: true })
          continue
        }
        if (!name.startsWith(PROTOCOL.stagingPrefix)) continue
        const version = name.slice(PROTOCOL.stagingPrefix.length)
        const hasReady = await pathExists(path.join(target, PROTOCOL.readyMarker))
        const applying = await pathExists(path.join(target, PROTOCOL.applyingMarker))
        if (hasReady && isNewer(version, appVersion)) {
          latest = version
          assetInfo = { name: assetNameFor(version, { platform: 'win', arch }), version, url: '', size: 0, digest: '' }
          readyPlan = {
            version,
            tag: `v${version}`,
            zipPath: path.join(updatesDir, assetNameFor(version, { platform: 'win', arch })),
            stagingDir: target,
            exeName: PROTOCOL.exeName,
            assetName: assetNameFor(version, { platform: 'win', arch }),
          }
          phase = 'ready'
          log(`发现上次已下载的 v${version}，等待重启更新`)
          continue
        }
        if (applying && !applyResult) {
          lastError = {
            code: 'APPLY_FAILED',
            message: '上次更新没有完成，当前仍是旧版本。可以重试，或到 Releases 页面手动覆盖。',
          }
          phase = 'error'
          continue
        }
        await withAsarDisabled(() => fileSystem.rm(target, { recursive: true, force: true }).catch(() => {}))
      }
    } catch {
      /* userData/updates 不存在是正常情况（从没更新过） */
    }
    emit()
    return statusPayload()
  }

  async function consumeApplyResult() {
    const file = path.join(updatesDir, PROTOCOL.resultFile)
    try {
      const raw = await fileSystem.readFile(file, 'utf8')
      await fileSystem.rm(file, { force: true })
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed !== 'object') return null
      return {
        ok: parsed.ok === true,
        from: typeof parsed.from === 'string' ? parsed.from : '',
        to: typeof parsed.to === 'string' ? parsed.to : '',
        error: typeof parsed.error === 'string' ? parsed.error : null,
      }
    } catch {
      return null
    }
  }

  /** 一次性取走「上次覆盖的结果」（主进程随第一次 status 一起发给渲染层）。 */
  function takeApplyResult() {
    const value = applyResult
    applyResult = null
    return value
  }

  return {
    status: statusPayload,
    check,
    download,
    cancel,
    restart,
    resume,
    takeApplyResult,
    isSupported: () => supported,
    PROTOCOL,
  }
}

module.exports = {
  createUpdater,
  parseVersion,
  compareVersions,
  isNewer,
  parseRepoSlug,
  assetNameFor,
  pickWindowsAsset,
  parseChecksums,
  requestStream,
  fetchText,
  fetchJson,
  downloadToFile,
  isSha256,
  UpdateError,
  PROTOCOL,
}
