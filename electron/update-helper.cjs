'use strict'

/**
 * Opennote 更新落地脚本（覆盖安装 + 重启）。
 *
 * 它**不是**被主进程 require 的模块，而是：
 *   1. 主进程把它从 asar 里 `copyFile` 到 `staging/.apply-update.cjs`（真实文件）；
 *   2. 用 **staging 里那份新版 exe** 以 `ELECTRON_RUN_AS_NODE=1` 执行它，然后退出。
 *
 * 为什么必须是「staging 里的新 exe」：Windows 上正在运行的 `Opennote.exe` 锁着自己，
 * 不能先覆盖它再启动它。让 helper 从 staging 跑，旧安装目录此刻没有任何进程，
 * 覆盖就是普通的文件复制；覆盖完再启动 `install/Opennote.exe`（这时它是新的）。
 *
 * 为什么不用 cmd/robocopy/PowerShell：中文路径在 .cmd 里要过代码页、`-ExecutionPolicy`
 * 受策略影响，而 `ELECTRON_RUN_AS_NODE` 已实测可用（v24.21.0），且 helper 只用
 * node 内建模块 —— 零依赖，也没有第二套文件复制语义。
 *
 * 与主进程的契约（`electron/update.cjs` 的 `PROTOCOL`）：字段名必须逐字一致，
 * `src/desktop/updateProtocol.test.ts` 会把两边的键名列表逐字比对。
 *
 * 失败时**不改动已复制成功的部分之外的东西**、写 `result.json` 如实报错、保留 staging
 * 让用户能重试；成功则清掉 staging（除自身 exe，它正在运行）并启动新版本。
 */

const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')

/**
 * 关掉 Electron 的 asar 补丁：staging 与安装目录里都有 `resources/app.asar`，
 * 补丁会把「路径里含 `.asar`」的读写当归档操作，抛 `Invalid package`。
 * helper 以 `ELECTRON_RUN_AS_NODE` 运行（那套补丁本来就不装），这里是**第二道保险**：
 * 万一将来有人改成用普通 Electron 主进程跑它，也不会突然「复制 app.asar 必失败」。
 */
process.noAsar = true

/** 与 `electron/update.cjs` 的 PROTOCOL 逐字一致（由 updateProtocol.test.ts 咬住）。 */
const HANDOFF_ENV = 'OPENNOTE_UPDATE_HANDOFF'
const HANDOFF_KEYS = ['pid', 'installDir', 'stagingDir', 'exeName', 'argv', 'logPath', 'version', 'resultPath', 'from']
const RESULT_KEYS = ['ok', 'from', 'to', 'at', 'error']
const HELPER_NAME = '.apply-update.cjs'
const READY_MARKER = '.ready'
const APPLYING_MARKER = '.applying'
const RESULT_FILE = 'result.json'
const EXE_NAME = 'Opennote.exe'

const WAIT_TIMEOUT_MS = 120000
const WAIT_INTERVAL_MS = 250
const COPY_ATTEMPTS = 6
const COPY_RETRY_DELAY_MS = 500
const BACKUP_SUFFIX = '.old-'

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

/**
 * 真正的覆盖动作（可注入依赖，便于单测真跑一遍而不真的拉起应用）。
 *
 * @param {object} handoff
 * @param {{ log?: (line: string) => void, launch?: Function, waitForExit?: Function,
 *           now?: () => number, attempts?: number, retryDelayMs?: number }} [deps]
 */
async function runUpdate(handoff, deps = {}) {
  const log = typeof deps.log === 'function' ? deps.log : () => {}
  const launch = typeof deps.launch === 'function' ? deps.launch : launchAndConfirm
  const wait = typeof deps.waitForExit === 'function' ? deps.waitForExit : waitForExit
  const now = typeof deps.now === 'function' ? deps.now : () => Date.now()
  const attempts = Number(deps.attempts) > 0 ? Number(deps.attempts) : COPY_ATTEMPTS
  const retryDelayMs = Number.isFinite(deps.retryDelayMs) ? Number(deps.retryDelayMs) : COPY_RETRY_DELAY_MS

  const installExe = path.join(handoff.installDir, handoff.exeName || EXE_NAME)
  log(`等待旧进程退出：pid=${handoff.pid}`)
  const exited = await wait(handoff.pid, WAIT_TIMEOUT_MS, WAIT_INTERVAL_MS)
  if (!exited) {
    return { ok: false, error: '旧进程没有在 2 分钟内退出，已放弃覆盖（没有改动任何文件）' }
  }
  log('旧进程已退出，开始覆盖')

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
  const keep = new Set([HELPER_NAME, handoff.exeName || EXE_NAME])
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
  BACKUP_SUFFIX,
  collectFiles,
  rankOf,
  sortForApply,
  copyWithRetry,
  processAlive,
  waitForExit,
  runUpdate,
  writeResult,
  cleanupStaging,
  main,
}
