'use strict'

/**
 * Opennote 更新落地脚本（覆盖安装 + 重启）。**两种形态**，由 `handoff.layout` 决定：
 *
 *   · `files`（Windows）—— 把 staging 里的逐个文件复制进安装目录。
 *   · `bundle`（macOS）—— 把 staging 里的整个 `Opennote.app` **整包换过去**。
 *
 * 为什么 mac 不能用 `files`：`.app` 是代码签名的，改里面任何一个文件都会让
 * `_CodeSignature/CodeResources` 失配；Apple Silicon 上内核会直接拒绝启动，
 * 也就是「更新完应用打不开了」。而 ad-hoc 签名**不绑定路径**，所以整包 `rename`
 * 过去签名依然有效 —— 换包反而比补文件更简单、更安全。
 *
 * 它**不是**被主进程 require 的模块，而是：
 *   1. 主进程把它从 asar 里 `copyFile` 到 `staging/.apply-update.cjs`（真实文件）；
 *   2. 用 **staging 里那份新版可执行文件** 以 `ELECTRON_RUN_AS_NODE=1` 执行它，然后退出。
 *      Windows 上是 `staging/Opennote.exe`，macOS 上是
 *      `staging/Opennote.app/Contents/MacOS/Opennote`。
 *
 * 为什么必须是「staging 里的新可执行文件」：Windows 上正在运行的 exe 锁着自己；
 * macOS 上虽然可以 unlink 运行中的二进制，但用 staging 那份的理由还多一条 ——
 * 整包 rename 之后，helper 自己的路径会跟着换到新位置，不会出现「边跑边删自己」。
 *
 * 为什么不用 cmd/robocopy/PowerShell：中文路径在 .cmd 里要过代码页、`-ExecutionPolicy`
 * 受策略影响，而 `ELECTRON_RUN_AS_NODE` 已实测可用（v24.21.0），且 helper 只用
 * node 内建模块 —— 零依赖，也没有第二套文件复制语义。
 *
 * 与主进程的契约（`electron/update.cjs` 的 `PROTOCOL`）：字段名必须逐字一致，
 * `src/desktop/updateProtocol.test.ts` 会把两边的键名列表逐字比对。
 *
 * 失败时**不改动已复制成功的部分之外的东西**、写 `result.json` 如实报错、保留 staging
 * 让用户能重试；成功则清掉 staging（除自身可执行文件，它正在运行）并启动新版本。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')

/**
 * 关掉 Electron 的 asar 补丁：staging 与安装目录里都有 `resources/app.asar`，
 * 补丁会把「路径里含 `.asar`」的读写当归档操作，抛 `Invalid package`。
 * helper 以 `ELECTRON_RUN_AS_NODE` 运行（那套补丁本来就不装），这里是**第二道保险**：
 * 万一将来有人改成用普通 Electron 主进程跑它，也不会突然「复制 app.asar 必失败」。
 */
process.noAsar = true

/** 与 `electron/update.cjs` 的 PROTOCOL 逐字一致（由 updateProtocol.test.ts 咬住）。 */
const HANDOFF_ENV = 'OPENNOTE_UPDATE_HANDOFF'
const HANDOFF_KEYS = [
  'pid',
  'installDir',
  'stagingDir',
  'exeName',
  'argv',
  'logPath',
  'version',
  'resultPath',
  'from',
  'layout',
  'bundleName',
]
const RESULT_KEYS = ['ok', 'from', 'to', 'at', 'error']
const HELPER_NAME = '.apply-update.cjs'
const READY_MARKER = '.ready'
const APPLYING_MARKER = '.applying'
const RESULT_FILE = 'result.json'
const EXE_NAME = 'Opennote.exe'
const LAYOUT_FILES = 'files'
const LAYOUT_BUNDLE = 'bundle'
const BUNDLE_NAME = 'Opennote.app'

const WAIT_TIMEOUT_MS = 120000
const WAIT_INTERVAL_MS = 250
const COPY_ATTEMPTS = 6
const COPY_RETRY_DELAY_MS = 500
const BACKUP_SUFFIX = '.old-'

/** macOS 系统自带，不需要 Xcode CLT。 */
const CODESIGN = '/usr/bin/codesign'
const DITTO = '/usr/bin/ditto'

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function appendLog(file, line) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.appendFileSync(file, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* 日志失败不影响覆盖 */
  }
}

/** 进程是否还活着。`kill(pid, 0)` 在 Windows 上走 OpenProcess，EPERM 说明「活着但没权限」。 */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return Boolean(error && error.code === 'EPERM')
  }
}

async function waitForExit(pid, timeoutMs = WAIT_TIMEOUT_MS, intervalMs = WAIT_INTERVAL_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!processAlive(pid)) return true
    await delay(intervalMs)
  }
  return !processAlive(pid)
}

/** 递归收集 staging 里的**文件**相对路径（目录靠复制时按需创建）。 */
function collectFiles(root, relative = '') {
  const base = relative === '' ? root : path.join(root, relative)
  const result = []
  let entries = []
  try {
    entries = fs.readdirSync(base, { withFileTypes: true })
  } catch {
    return result
  }
  for (const entry of entries) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      result.push(...collectFiles(root, next))
      continue
    }
    if (!entry.isFile()) continue
    if (relative === '' && entry.name === HELPER_NAME) continue
    result.push(next)
  }
  return result
}

/**
 * 覆盖顺序：其它文件 → `resources/app.asar` → `Opennote.exe` **最后**。
 * 这样中途断电时，磁盘上至少是「旧 exe + 新 asar」或「新 exe + 新 asar」，
 * 两种组合都能启动（asar 里才是整个应用），不会出现「新 exe 配半截 asar」。
 */
function rankOf(relative, exeName = EXE_NAME) {
  if (relative === exeName) return 2
  if (relative === 'resources/app.asar') return 1
  return 0
}

function sortForApply(files, exeName = EXE_NAME) {
  return [...files].sort((left, right) => {
    const delta = rankOf(left, exeName) - rankOf(right, exeName)
    return delta !== 0 ? delta : left.localeCompare(right)
  })
}

/** 复制单个文件；目标已存在时先改名成 `.old-<ts>` 再写（同名文件被占用时的唯一出路）。 */
async function copyWithRetry(source, target, options) {
  const { log, attempts, retryDelayMs, now } = options
  let backup = ''
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (fs.existsSync(target)) {
        backup = `${target}${BACKUP_SUFFIX}${now().toString(36)}`
        try {
          fs.renameSync(target, backup)
        } catch (error) {
          log(`重命名旧文件失败（${error.code}）：${target}`)
        }
      }
      fs.copyFileSync(source, target)
      return true
    } catch (error) {
      log(`复制失败（第 ${attempt}/${attempts} 次，${error.code}）：${target}`)
      // 已经把旧文件改名走、新文件又没写进去时，先把旧的放回去，别留下空洞。
      if (backup && !fs.existsSync(target) && fs.existsSync(backup)) {
        try {
          fs.renameSync(backup, target)
        } catch {
          /* 放不回去也只能如实报错 */
        }
      }
      if (attempt < attempts) await delay(retryDelayMs)
    }
  }
  throw new Error(`复制失败：${path.basename(target)}`)
}

/** 清掉上一次更新留下的 `*.old-*` 备份（它们是「上一版」，没有回滚价值：旧包随时能重新下）。 */
function cleanStaleBackups(dir, log) {
  let entries = []
  try {
    entries = fs.readdirSync(dir)
  } catch {
    return
  }
  for (const name of entries) {
    if (!name.includes(BACKUP_SUFFIX)) continue
    try {
      fs.rmSync(path.join(dir, name), { force: true, recursive: true })
      log(`清掉旧备份：${name}`)
    } catch (error) {
      log(`清理旧备份失败（${error.code}）：${name}`)
    }
  }
}

/**
 * 启动新版本，并**确认它真的起来了**。
 *
 * `spawn()` 同步返回不代表启动成功：找不到文件/权限不足是异步的 `error` 事件。
 * 早先这里直接 return，于是「覆盖成功但新版本根本没起来」也会写 `ok:true` ——
 * 用户看到的是「更新成功」，然后应用没了。所以这里等到 `spawn` 或 `error` 再下结论。
 */
function launchAndConfirm(exePath, argv, cwd, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result) => {
      if (settled) return
      settled = true
      resolve(result)
    }
    let child
    try {
      const env = { ...process.env }
      // 关键：不能把 ELECTRON_RUN_AS_NODE 传给新进程，否则「打开应用」会变成跑 node 空转。
      delete env[HANDOFF_ENV]
      delete env.ELECTRON_RUN_AS_NODE
      child = spawn(exePath, Array.isArray(argv) ? argv : [], {
        cwd,
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        env,
      })
    } catch (error) {
      finish({ ok: false, error: `启动新版本失败：${(error && error.code) || '未知原因'}` })
      return
    }
    child.on('error', (error) => {
      finish({ ok: false, error: `启动新版本失败：${(error && error.code) || error.message || '未知原因'}` })
    })
    child.on('spawn', () => {
      child.unref()
      finish({ ok: true, error: null })
    })
    const timer = setTimeout(() => {
      // 事件迟迟不来时不要卡住 helper（它还得写回执、清 staging）。
      finish({ ok: true, error: null })
    }, timeoutMs)
    timer.unref?.()
  })
}

/** 一次 codesign 复验（最后一道闸门；失败就绝不换包）。同步跑，helper 本来就在等。 */
function verifyBundleSignature(bundlePath) {
  const result = spawnSync(CODESIGN, ['--verify', '--deep', '--strict', bundlePath], {
    stdio: ['ignore', 'ignore', 'pipe'],
    timeout: 5 * 60 * 1000,
  })
  return result.status === 0
}

/** bundle 形态的路径推导。注意 `installDir` 是 `.app` 的**父目录**（/Applications）。 */
function bundlePathsFor(handoff) {
  const bundleName = handoff.bundleName || BUNDLE_NAME
  const installDir = handoff.installDir
  return {
    bundleName,
    installDir,
    target: path.join(installDir, bundleName),
    staged: path.join(handoff.stagingDir, bundleName),
    // bundle 内部的相对路径（`Contents/MacOS/Opennote`），由主进程从验过的 Info.plist 取。
    exeName: handoff.exeName || path.join('Contents', 'MacOS', 'Opennote'),
  }
}

/** 清掉上一次失败留下的 `.Opennote.app.old-*`（不清就会在 /Applications 里越堆越多）。 */
function cleanStaleBundleBackups(installDir, bundleName, log) {
  let entries = []
  try {
    entries = fs.readdirSync(installDir)
  } catch {
    return
  }
  const prefix = `.${bundleName}${BACKUP_SUFFIX}`
  for (const name of entries) {
    if (!name.startsWith(prefix)) continue
    try {
      fs.rmSync(path.join(installDir, name), { recursive: true, force: true })
    } catch (error) {
      log(`清理旧备份失败（${error.code}）：${name}`)
    }
  }
}

/**
 * macOS 的覆盖动作：**整包替换 + 失败回滚**。
 *
 * 顺序上是刻意的：
 *   ① 先确认 staging 里那个 bundle 结构与签名都对（坏包绝不发车）；
 *   ② `rename(旧 → 备份)`，再 `rename(新 → 原位)`；第二步失败就把备份 rename 回来；
 *   ③ **只有在确认新版能起来之后**才删掉备份 —— 起不来就把旧版换回去。
 *      这一步和 Windows 的取舍不同：Windows 逐文件覆盖没法回退（所以 exe 放最后），
 *      而 bundle 是一个整体，留着备份就能真的回滚。
 *
 * rename 而不是复制：同一个卷上 rename 是原子的，且**不改动 bundle 内容**，
 * 所以 ad-hoc 签名原样有效。跨卷（EXDEV）时才退回 `ditto` 整包复制。
 */
async function applyBundleSwap(handoff, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const launch = typeof deps.launch === 'function' ? deps.launch : launchAndConfirm
  const verify = typeof deps.verify === 'function' ? deps.verify : verifyBundleSignature
  const { bundleName, installDir, target, staged, exeName } = bundlePathsFor(handoff)

  if (!fs.existsSync(staged)) {
    return { ok: false, error: `解压目录里没有 ${bundleName}，已放弃替换（没有改动任何文件）` }
  }
  if (!fs.existsSync(path.join(staged, exeName))) {
    return { ok: false, error: `${bundleName} 里没有可执行文件 ${exeName}，安装包不完整，已放弃替换` }
  }
  if (!verify(staged)) {
    return { ok: false, error: '安装包的代码签名复验没有通过，已放弃替换（磁盘上的 Opennote 没有被改动）' }
  }

  cleanStaleBundleBackups(installDir, bundleName, log)

  const backup = path.join(installDir, `.${bundleName}${BACKUP_SUFFIX}${Date.now()}`)
  let movedAside = false
  if (fs.existsSync(target)) {
    try {
      fs.renameSync(target, backup)
      movedAside = true
    } catch (error) {
      return { ok: false, error: `无法移开旧版本（${error.code || '未知原因'}），已放弃替换（没有改动任何文件）` }
    }
  }

  const rollback = () => {
    try {
      fs.rmSync(target, { recursive: true, force: true })
      if (movedAside) fs.renameSync(backup, target)
      log('已回滚到旧版本')
    } catch (error) {
      log(`回滚失败（${error.code || '未知原因'}）：需要手动把 ${backup} 改回 ${target}`)
    }
  }

  try {
    fs.renameSync(staged, target)
  } catch (error) {
    // EXDEV：staging 与安装目录不在同一个卷（把应用装在移动硬盘上）。退回整包复制。
    log(`rename 失败（${error.code || '未知原因'}），改用 ditto 整包复制`)
    const copied = spawnSync(DITTO, [staged, target], { stdio: ['ignore', 'ignore', 'pipe'] })
    if (copied.status !== 0) {
      rollback()
      return { ok: false, error: `替换失败（${error.code || '未知原因'}），已回滚到旧版本` }
    }
  }

  // 换上去的这一份也要能跑：复制路径值得再验一次（rename 路径下这次几乎必然通过）。
  if (!verify(target)) {
    rollback()
    return { ok: false, error: '替换后的应用没有通过签名复验，已回滚到旧版本' }
  }

  try {
    const launched = await launch(path.join(target, exeName), handoff.argv, installDir)
    if (launched && launched.ok === false) {
      rollback()
      return { ok: false, error: `${launched.error || '启动新版本失败'}，已回滚到旧版本` }
    }
  } catch (error) {
    rollback()
    return { ok: false, error: `启动新版本失败：${error && error.code ? error.code : '未知原因'}，已回滚到旧版本` }
  }

  // 到这里新版本已经起来了，才敢把旧版本删掉。
  try {
    fs.rmSync(backup, { recursive: true, force: true })
  } catch (error) {
    log(`清理旧版本备份失败（${error.code}）：${backup}`)
  }
  try {
    fs.rmSync(path.join(handoff.stagingDir, APPLYING_MARKER), { force: true })
  } catch {
    /* 标记文件清不掉不影响结果 */
  }
  return { ok: true, error: null }
}

/**
 * 真正的覆盖动作（可注入依赖，便于单测真跑一遍而不真的拉起应用）。
 *
 * @param {object} handoff
 * @param {{ log?: (line: string) => void, launch?: Function, waitForExit?: Function,
 *           now?: () => number, attempts?: number, retryDelayMs?: number }} [deps]
 */
async function runUpdate(handoff, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const wait = typeof deps.waitForExit === 'function' ? deps.waitForExit : waitForExit

  log(`等待旧进程退出：pid=${handoff.pid}`)
  const exited = await wait(handoff.pid, WAIT_TIMEOUT_MS, WAIT_INTERVAL_MS)
  if (!exited) {
    return { ok: false, error: '旧进程没有在 2 分钟内退出，已放弃覆盖（没有改动任何文件）' }
  }
  log('旧进程已退出，开始覆盖')

  // macOS：整包替换（见 applyBundleSwap）。Windows 走下面的逐文件覆盖。
  if (handoff.layout === LAYOUT_BUNDLE) {
    log(`形态：整包替换 ${handoff.bundleName || BUNDLE_NAME}`)
    return applyBundleSwap(handoff, deps)
  }

  const launch = typeof deps.launch === 'function' ? deps.launch : launchAndConfirm
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const attempts = Number(deps.attempts) > 0 ? Number(deps.attempts) : COPY_ATTEMPTS
  const retryDelayMs = Number.isFinite(deps.retryDelayMs) ? Number(deps.retryDelayMs) : COPY_RETRY_DELAY_MS

  const installExe = path.join(handoff.installDir, handoff.exeName || EXE_NAME)

  cleanStaleBackups(handoff.installDir, log)
  const files = sortForApply(collectFiles(handoff.stagingDir), handoff.exeName || EXE_NAME)
  if (files.length === 0) return { ok: false, error: '解压目录是空的，已放弃覆盖' }
  log(`待覆盖 ${files.length} 个文件`)

  let copied = 0
  try {
    for (const relative of files) {
      const source = path.join(handoff.stagingDir, relative)
      const target = path.join(handoff.installDir, relative)
      try {
        fs.mkdirSync(path.dirname(target), { recursive: true })
      } catch (error) {
        throw new Error(`复制失败：${relative}（${error && error.code ? error.code : '未知原因'}）`)
      }
      await copyWithRetry(source, target, { log, attempts, retryDelayMs, now })
      copied += 1
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { ok: false, error: detail.startsWith('复制失败') ? detail : `复制失败：${detail}` }
  }
  log(`覆盖完成（${copied} 个文件），启动新版本`)

  try {
    fs.rmSync(path.join(handoff.stagingDir, APPLYING_MARKER), { force: true })
  } catch {
    /* 标记文件清不掉不影响结果 */
  }

  try {
    const launched = await launch(installExe, handoff.argv, handoff.installDir)
    if (launched && launched.ok === false) {
      return { ok: false, error: launched.error || '启动新版本失败' }
    }
  } catch (error) {
    return { ok: false, error: `启动新版本失败：${error && error.code ? error.code : '未知原因'}` }
  }
  return { ok: true, error: null }
}

function writeResult(handoff, outcome) {
  const file = handoff.resultPath || path.join(path.dirname(handoff.stagingDir), RESULT_FILE)
  const payload = {
    ok: outcome.ok === true,
    from: typeof handoff.from === 'string' ? handoff.from : '',
    to: typeof handoff.version === 'string' ? handoff.version : '',
    at: new Date().toISOString(),
    error: typeof outcome.error === 'string' ? outcome.error : null,
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
  } catch {
    /* 结果文件写不下去时只能靠日志 */
  }
  return payload
}

/** 清掉 staging 里除「正在运行的自己」之外的一切（剩下的由新版本启动时收尾）。 */
function cleanupStaging(handoff, log) {
  // bundle 形态下「正在运行的自己」在 `Opennote.app/Contents/MacOS/` 里，所以整个
  // bundle 都要留着：rename 路径下它已经被搬走（这一条是空操作），但跨卷复制路径下
  // 它还在 staging 里，删了就等于删掉正在运行的自己。
  const keep = new Set([HELPER_NAME, handoff.exeName || EXE_NAME, BUNDLE_NAME, handoff.bundleName || ''])
  let entries = []
  try {
    entries = fs.readdirSync(handoff.stagingDir)
  } catch {
    return
  }
  for (const name of entries) {
    if (keep.has(name)) continue
    try {
      fs.rmSync(path.join(handoff.stagingDir, name), { recursive: true, force: true })
    } catch (error) {
      log(`清理 staging 失败（${error.code}）：${name}`)
    }
  }
}

async function main() {
  const handoffPath = process.env[HANDOFF_ENV]
  const handoff = handoffPath ? readJson(handoffPath) : null
  if (!handoff || typeof handoff !== 'object') {
    process.exitCode = 1
    return { ok: false, error: '缺少更新握手信息' }
  }
  const log = (line) => appendLog(handoff.logPath, line)
  log(`helper 启动：version=${handoff.version} staging=${handoff.stagingDir}`)

  let outcome
  try {
    outcome = await runUpdate(handoff, { log })
  } catch (error) {
    outcome = { ok: false, error: `覆盖失败：${error instanceof Error ? error.message : String(error)}` }
    log(outcome.error)
  }

  writeResult(handoff, outcome)
  if (outcome.ok) cleanupStaging(handoff, log)
  log(`helper 结束：ok=${outcome.ok}`)
  process.exitCode = outcome.ok ? 0 : 1
  return outcome
}

if (require.main === module) {
  main().then(
    () => process.exit(process.exitCode || 0),
    (error) => {
      try {
        process.stderr.write(`opennote update helper failed: ${error && error.message}\n`)
      } catch {
        /* 忽略 */
      }
      process.exit(1)
    },
  )
}

module.exports = {
  HANDOFF_ENV,
  HANDOFF_KEYS,
  RESULT_KEYS,
  HELPER_NAME,
  READY_MARKER,
  APPLYING_MARKER,
  RESULT_FILE,
  EXE_NAME,
  LAYOUT_FILES,
  LAYOUT_BUNDLE,
  BUNDLE_NAME,
  BACKUP_SUFFIX,
  collectFiles,
  rankOf,
  sortForApply,
  copyWithRetry,
  processAlive,
  waitForExit,
  verifyBundleSignature,
  bundlePathsFor,
  cleanStaleBundleBackups,
  applyBundleSwap,
  runUpdate,
  writeResult,
  cleanupStaging,
  main,
}
