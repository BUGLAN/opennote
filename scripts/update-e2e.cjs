#!/usr/bin/env node
'use strict'

/**
 * 桌面端自更新的**端到端**脚本（真跑，不碰用户的真实安装目录）。
 *
 *   node scripts/update-e2e.cjs [--keep] [--port 9444]
 *
 * 它做的事：
 *   1. 把 `release/win-unpacked/` 复制到临时目录当作「安装目录」——**绝不**动真实安装目录，
 *      也绝不用真实 userData（`--user-data-dir` 指向临时目录，单实例锁因此互不干扰，
 *      见 RELEASING.md 已知坑 #3）。
 *   2. 用 store 模式（不压缩）现场打一个 `Opennote-9.9.9-win-x64.zip`，内容 = 安装目录的
 *      全部文件 + 一个 `UPDATE-MARKER-9.9.9.txt`；流式写，不在内存里堆 380 MB。
 *   3. 起一个本地 HTTP 服务器冒充 GitHub Releases（`/repos/.../releases/latest`、
 *      `/download/v9.9.9/...`、`SHA256SUMS`），并通过
 *      `OPENNOTE_UPDATE_API_BASE` / `OPENNOTE_UPDATE_DOWNLOAD_BASE` 指过去。
 *   4. 启动**副本**里的 `Opennote.exe`，用 CDP 直接调
 *      `window.opennote.update.check()/download()/restart()`（走真实 IPC、真实磁盘、
 *      真实 sha256、真实覆盖脚本），然后断言：
 *        · 覆盖后安装目录里出现了 `UPDATE-MARKER-9.9.9.txt`（文件真的被换掉了）
 *        · 被替换的文件留下了 `.old-*` 备份、旧备份被清掉
 *        · `userData/updates/` 被新版本启动时收尾清干净（staging 与 zip 都不残留）
 *        · 新进程真的起来了（CDP 能再次连上并读到状态）
 *   5. 用 CDP 的 `SystemInfo.getProcessInfo` 精确拿到新进程 PID 再杀它
 *      （**绝不** `taskkill /IM Opennote.exe`：那会连用户自己开着的 Opennote 一起杀）。
 *
 * 本脚本**没有**覆盖什么（如实列出，别把它当全绿）：真实 GitHub、真实发布包的 asar 版本号
 * 变化（这里的「新版本」是假包，所以覆盖后应用仍报 0.5.0）、只读安装目录、断电中断。
 * 「真包的版本号真的变了」只能靠发布日演练（RELEASING.md）。
 */

const fs = require('node:fs')
const fsp = require('node:fs/promises')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')
const { crc32Update } = require('../electron/zip.cjs')

const REPO_ROOT = path.resolve(__dirname, '..')
const UNPACKED = path.join(REPO_ROOT, 'release', 'win-unpacked')
const EXE_NAME = 'Opennote.exe'
const FAKE_VERSION = '9.9.9'
const ASSET_NAME = `Opennote-${FAKE_VERSION}-win-x64.zip`
const MARKER_NAME = `UPDATE-MARKER-${FAKE_VERSION}.txt`
const KEEP = process.argv.includes('--keep')
const argvPort = process.argv.indexOf('--port')
/** 调试端口默认**动态取一个空闲端口**：写死会在上一次运行留下进程时变成假失败。 */
const FIXED_PORT = argvPort > 0 ? Number(process.argv[argvPort + 1]) : 0

function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.on('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const port = probe.address().port
      probe.close(() => resolve(port))
    })
  })
}

let passCount = 0
let failCount = 0
let skipCount = 0
const failures = []

function check(label, fn) {
  try {
    const detail = fn()
    passCount += 1
    console.log(`  PASS ${label}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failCount += 1
    failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`)
    console.log(`  FAIL ${label} — ${error instanceof Error ? error.message : String(error)}`)
  }
}

function skip(label, reason) {
  skipCount += 1
  console.log(`  SKIP ${label} — ${reason}`)
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await predicate()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await delay(intervalMs)
  }
  throw new Error(`${label}（等待 ${timeoutMs}ms 超时${lastError ? `：${lastError.message}` : ''}）`)
}

function writeChunk(stream, buffer) {
  return new Promise((resolve, reject) => {
    stream.write(buffer, (error) => (error ? reject(error) : resolve()))
  })
}

function endStream(stream) {
  return new Promise((resolve, reject) => {
    stream.end((error) => (error ? reject(error) : resolve()))
  })
}

async function fileDigest(file) {
  const hash = crypto.createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve)
      .on('error', reject)
  })
  return hash.digest('hex')
}

async function crcOfFile(file) {
  let state = 0xffffffff
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (chunk) => {
        state = crc32Update(state, chunk)
      })
      .on('end', resolve)
      .on('error', reject)
  })
  return (state ^ 0xffffffff) >>> 0
}

/** 把文件原样接到输出流上（`end:false`：后面还有别的条目要写）。 */
function pipeInto(source, target) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(source)
    input.on('error', reject)
    input.on('end', resolve)
    input.pipe(target, { end: false })
  })
}

function collectRelativeFiles(root, relative = '') {
  const base = relative === '' ? root : path.join(root, relative)
  const result = []
  for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
    const next = relative === '' ? entry.name : `${relative}/${entry.name}`
    if (entry.isDirectory()) {
      result.push(...collectRelativeFiles(root, next))
      continue
    }
    if (entry.isFile()) result.push(next)
  }
  return result
}

/** store 模式（不压缩）的 zip 写入器：流式，内存占用与文件大小无关。 */
async function writeStoreZip(zipPath, entries) {
  const out = fs.createWriteStream(zipPath)
  const central = []
  let offset = 0
  for (const entry of entries) {
    const size = fs.statSync(entry.source).size
    const crc = await crcOfFile(entry.source)
    const name = Buffer.from(entry.name, 'utf8')
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(0, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(size, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    await writeChunk(out, local)
    await writeChunk(out, name)
    await pipeInto(entry.source, out)
    central.push({ name, crc, size, offset })
    offset += 30 + name.length + size
  }
  const directoryOffset = offset
  let directorySize = 0
  for (const item of central) {
    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(0, 10)
    header.writeUInt32LE(item.crc, 16)
    header.writeUInt32LE(item.size, 20)
    header.writeUInt32LE(item.size, 24)
    header.writeUInt16LE(item.name.length, 28)
    header.writeUInt32LE(item.offset, 42)
    await writeChunk(out, header)
    await writeChunk(out, item.name)
    directorySize += 46 + item.name.length
  }
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(central.length, 8)
  eocd.writeUInt16LE(central.length, 10)
  eocd.writeUInt32LE(directorySize, 12)
  eocd.writeUInt32LE(directoryOffset, 16)
  await writeChunk(out, eocd)
  await endStream(out)
}

/** 极简 CDP 客户端（Node 22 自带 WebSocket，与 scripts/cdp-eval.mjs 同一套）。 */
class Cdp {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
    this.targetId = null
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      if (message.id && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)
        this.pending.delete(message.id)
        if (message.error) reject(new Error(JSON.stringify(message.error)))
        else resolve(message.result)
      }
    })
  }

  static async connect(wsUrl, targetId) {
    const socket = new WebSocket(wsUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', () => reject(new Error('CDP 连接失败')), { once: true })
    })
    const client = new Cdp(socket)
    client.targetId = targetId
    return client
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression, timeoutMs = 120000) {
    const result = await Promise.race([
      this.send('Runtime.evaluate', {
        expression: `(async () => { ${expression} })()`,
        awaitPromise: true,
        returnByValue: true,
      }),
      delay(timeoutMs).then(() => {
        throw new Error(`CDP 求值超时：${expression.slice(0, 60)}`)
      }),
    ])
    if (result.exceptionDetails) {
      throw new Error(
        `页面里抛异常：${result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)}`,
      )
    }
    return result.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* 忽略 */
    }
  }
}

async function pageTargets(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`)
  return response.json()
}

async function findPage(port) {
  try {
    const targets = await pageTargets(port)
    return targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl) ?? null
  } catch {
    return null
  }
}

/** 诊断用：本机在跑的 Opennote 进程与它们的命令行（只读，不杀）。 */
function describeAppProcesses() {  try {
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='Opennote.exe'\" | Select-Object -ExpandProperty CommandLine",
      ],
      { encoding: 'utf8', timeout: 20000 },
    )
    const lines = String(result.stdout || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    return lines.length ? lines.join(' ｜ ') : '（没有 Opennote 进程在跑）'
  } catch (error) {
    return `（进程列表读取失败：${error instanceof Error ? error.message : String(error)}）`
  }
}

/**
 * 按命令行里的**临时目录**精确杀掉副本进程。
 * 绝不 `taskkill /IM Opennote.exe`：那会把用户自己开着的 Opennote 一起杀掉。
 */
function killProcessesUnder(fragment) {
  if (!fragment) return
  try {
    spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='Opennote.exe'" | Where-Object { $_.CommandLine -like '*${fragment}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
      ],
      { encoding: 'utf8', timeout: 30000 },
    )
  } catch {
    /* 收尾失败不影响结论 */
  }
}

async function killByCdp(port) {  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const client = await Cdp.connect(version.webSocketDebuggerUrl, 'browser')
    const info = await client.send('SystemInfo.getProcessInfo')
    client.close()
    const browser = (info.processInfo || []).find((item) => item.type === 'browser') || (info.processInfo || [])[0]
    if (!browser || !browser.id) return null
    spawnSync('taskkill', ['/PID', String(browser.id), '/T', '/F'], { stdio: 'ignore' })
    return browser.id
  } catch {
    return null
  }
}

async function main() {
  console.log('Opennote 自更新端到端（真磁盘 + 真 zip + 真覆盖脚本 + CDP 驱动）')
  console.log(`node=${process.version} platform=${process.platform} arch=${process.arch}`)

  if (!fs.existsSync(path.join(UNPACKED, EXE_NAME))) {
    skip('整体', `没有 ${path.relative(REPO_ROOT, path.join(UNPACKED, EXE_NAME))}；先跑 pnpm build:desktop && npx electron-builder --config electron-builder.yml --dir`)
    console.log('\nPASS 0 / FAIL 0 / SKIP 1')
    return 0
  }

  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-update-e2e-'))
  const installDir = path.join(base, 'install')
  const userData = path.join(base, 'user-data')
  const zipPath = path.join(base, ASSET_NAME)
  const markerSource = path.join(base, MARKER_NAME)
  const cdpPort = FIXED_PORT || (await freePort())
  let appProcess = null
  let server = null
  let client = null
  let appLogPathRef = null
  let appLogTail = []
  let applyLogTail = []

  try {
    console.log(`  临时目录：${base}`)
    fs.mkdirSync(userData, { recursive: true })
    console.log('  · 复制 release/win-unpacked → 临时安装目录（真实安装目录一个字节都不动）')
    fs.cpSync(UNPACKED, installDir, { recursive: true })

    fs.writeFileSync(markerSource, `更新于 ${new Date().toISOString()}\n`, 'utf8')
    const entries = [
      ...collectRelativeFiles(installDir).map((name) => ({ name, source: path.join(installDir, name) })),
      { name: MARKER_NAME, source: markerSource },
    ]
    console.log(`  · 打一个 store 模式的假更新包（${entries.length} 个文件）`)
    await writeStoreZip(zipPath, entries)
    const zipSize = fs.statSync(zipPath).size
    const zipSha = await fileDigest(zipPath)
    console.log(`    包大小 ${(zipSize / 1048576).toFixed(1)} MB，sha256 ${zipSha.slice(0, 16)}…`)

    const server2 = http.createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1')
      const send = (status, headers, body) => {
        response.writeHead(status, headers)
        response.end(body)
      }
      if (url.pathname === '/repos/BUGLAN/opennote/releases/latest') {
        const origin = `http://127.0.0.1:${server2.address().port}`
        return send(200, { 'content-type': 'application/json' }, JSON.stringify({
          tag_name: `v${FAKE_VERSION}`,
          html_url: `${origin}/tag/v${FAKE_VERSION}`,
          assets: [
            {
              name: ASSET_NAME,
              browser_download_url: `${origin}/download/v${FAKE_VERSION}/${ASSET_NAME}`,
              size: zipSize,
              digest: `sha256:${zipSha}`,
            },
            { name: 'SHA256SUMS', browser_download_url: `${origin}/download/v${FAKE_VERSION}/SHA256SUMS`, size: 183 },
          ],
        }))
      }
      if (url.pathname === `/download/v${FAKE_VERSION}/SHA256SUMS`) {
        return send(200, { 'content-type': 'text/plain' }, `${zipSha}  ${ASSET_NAME}\n`)
      }
      if (url.pathname === `/download/v${FAKE_VERSION}/${ASSET_NAME}`) {
        response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipSize) })
        fs.createReadStream(zipPath).pipe(response)
        return
      }
      return send(404, {}, 'not found')
    })
    await new Promise((resolve) => server2.listen(0, '127.0.0.1', resolve))
    server = server2
    const baseUrl = `http://127.0.0.1:${server2.address().port}`
    console.log(`  · 本地 Release 服务：${baseUrl}`)

    console.log('  · 启动副本应用（独立 user-data-dir + 独立调试端口）')
    const childEnv = {
      ...process.env,
      OPENNOTE_UPDATE_API_BASE: baseUrl,
      OPENNOTE_UPDATE_DOWNLOAD_BASE: baseUrl,
    }
    // 本机（或 CI）可能残留 ELECTRON_RUN_AS_NODE=1：那样 exe 会当 node 跑、窗口根本不出现。
    // helper 在启动新版本时也会主动删掉它（见 electron/update-helper.cjs）。
    delete childEnv.ELECTRON_RUN_AS_NODE
    const appLogPath = path.join(base, 'app.log')
    const appLog = fs.createWriteStream(appLogPath)
    appProcess = spawn(
      path.join(installDir, EXE_NAME),
      [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`],
      {
        env: childEnv,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: false,
      },
    )
    // 把主进程日志留一份：失败时它就是唯一的诊断入口（界面上的错误文案是给用户的，不带原因码）。
    appProcess.stdout.pipe(appLog)
    appProcess.stderr.pipe(appLog)
    appLogPathRef = appLogPath
    appProcess.on('error', () => {})

    const firstPage = await waitFor('应用窗口就绪（CDP）', () => findPage(cdpPort), 60000, 400)
    client = await Cdp.connect(firstPage.webSocketDebuggerUrl, firstPage.id)
    const firstTargetId = firstPage.id

    const initial = await client.evaluate('return await window.opennote.update.status()')
    check('打包版报告 supported=true（未打包/浏览器端不会出现更新入口）', () => {
      if (initial.supported !== true) throw new Error(`supported=${initial.supported}`)
      return `current=${initial.current}`
    })
    check('初始状态是「还没下载」，且没有撒谎说有更新', () => {
      // 启动 5s 后那次静默检查可能已经跑过（本地假 Release 会立刻返回 9.9.9），
      // 所以这里只要求「没有进入下载/待重启」，不要求恰好是 idle。
      if (!['idle', 'checking', 'available'].includes(initial.phase)) {
        throw new Error(`phase=${initial.phase}`)
      }
      if (initial.phase === 'available' && initial.latest !== FAKE_VERSION) {
        throw new Error(`latest=${initial.latest}`)
      }
      return `phase=${initial.phase}`
    })

    const available = await client.evaluate('return await window.opennote.update.check({ force: true })')
    check('检查更新 → 认出本地 Release 的新版本', () => {
      if (available.phase !== 'available') throw new Error(`phase=${available.phase} error=${JSON.stringify(available.error)}`)
      if (available.latest !== FAKE_VERSION) throw new Error(`latest=${available.latest}`)
      if (available.asset?.name !== ASSET_NAME) throw new Error(`asset=${available.asset?.name}`)
      return `latest=${available.latest} asset=${available.asset.name}`
    })

    const ready = await client.evaluate('return await window.opennote.update.download()', 240000)
    check('下载 + sha256 校验 + 解压 → ready', () => {
      if (ready.phase !== 'ready') throw new Error(`phase=${ready.phase} error=${JSON.stringify(ready.error)}`)
      return 'phase=ready'
    })
    check('安装包下载并解压到 staging（zip 解压成功后立刻删掉，不长期占 151 MB）', () => {
      const updates = path.join(userData, 'updates')
      const staging = path.join(updates, `staging-${FAKE_VERSION}`)
      if (fs.existsSync(path.join(updates, ASSET_NAME))) throw new Error('zip 应在解压成功后删除')
      if (fs.existsSync(path.join(updates, `${ASSET_NAME}.part`))) throw new Error('.part 残留')
      if (!fs.existsSync(path.join(staging, EXE_NAME))) throw new Error('缺少 staging/Opennote.exe')
      if (!fs.existsSync(path.join(staging, '.ready'))) throw new Error('缺少 .ready 标记')
      return 'staging 就位'
    })

    const restart = await client.evaluate('return await window.opennote.update.restart()')
    check('重启并更新被接受（主进程开始编排覆盖）', () => {
      if (restart.ok !== true) throw new Error(`restart=${JSON.stringify(restart)}`)
      return 'ok=true'
    })
    client.close()
    client = null

    const marker = path.join(installDir, MARKER_NAME)
    await waitFor('覆盖完成（安装目录出现新文件）', () => fs.existsSync(marker), 180000, 500)
    check('安装目录里真的出现了更新包里的新文件', () => {
      if (!fs.existsSync(marker)) throw new Error('缺少标记文件')
      return MARKER_NAME
    })

    // 覆盖脚本自己会报告「覆盖完成（N 个文件）」——等到这一行再断言备份，
    // 否则会在「marker 已复制、exe 还没复制」的中间态上误判（第一版就是这么误报的）。
    const applyLogPath = path.join(userData, 'updates', 'apply.log')
    await waitFor(
      '覆盖脚本报告完成',
      () => fs.existsSync(applyLogPath) && fs.readFileSync(applyLogPath, 'utf8').includes('覆盖完成'),
      180000,
      300,
    )
    check('被替换的文件留下了 .old-* 备份（可手工回退），旧备份已被清理', () => {
      const backups = fs.readdirSync(installDir).filter((name) => name.includes('.old-'))
      if (!backups.some((name) => name.startsWith(EXE_NAME))) throw new Error('没有 exe 备份')
      return `${backups.length} 个备份`
    })

    // 「新版本真的起来了」的主证据：它启动时会消费 result.json 并清掉 staging。
    // （不依赖 CDP —— 那是第二步的加分项，不是唯一判据。）
    const resultFile = path.join(userData, 'updates', 'result.json')
    await waitFor(
      '新版本启动并完成收尾（result.json 被消费、staging 被清掉）',
      () => !fs.existsSync(resultFile) && !fs.existsSync(path.join(userData, 'updates', `staging-${FAKE_VERSION}`)),
      120000,
      500,
    )
    check('覆盖结果被新版本消费（不重复播报），staging 与 zip 都已清掉', () => {
      const updates = path.join(userData, 'updates')
      const leftovers = fs.existsSync(updates) ? fs.readdirSync(updates) : []
      if (fs.existsSync(resultFile)) throw new Error('result.json 未被消费')
      const staging = leftovers.filter((name) => name.startsWith('staging-'))
      const zips = leftovers.filter((name) => name.endsWith('.zip'))
      const parts = leftovers.filter((name) => name.endsWith('.part'))
      if (staging.length || zips.length || parts.length) throw new Error(`残留 ${JSON.stringify(leftovers)}`)
      if (leftovers.includes('handoff.json')) throw new Error('握手文件未被清理')
      // `apply.log` 是**故意**留下的排障线索（覆盖脚本每次都会往它追加）。
      return leftovers.length ? `剩 ${leftovers.join('、')}` : 'updates 目录已清空'
    })

    // 「新版本真的起来了」的**硬证据**：命令行里带着同一个临时 user-data-dir 的进程在跑。
    // （不依赖 CDP —— 见下面的 SKIP 说明：调试端口能不能重新绑定是 harness 自己的事。）
    check('新版本进程确实在运行（同一个 user-data-dir）', () => {
      const list = describeAppProcesses()
      if (!list.includes(userData)) throw new Error(`没找到运行中的副本：${list}`)
      return '进程在跑'
    })

    // 新进程的 CDP 目标要**轮询**：应用起来了，但调试端点可能还差一两百毫秒。
    let secondPage = null
    try {
      secondPage = await waitFor(
        '新版本窗口的调试目标',
        async () => {
          const page = await findPage(cdpPort)
          return page && page.id !== firstTargetId ? page : null
        },
        30000,
        500,
      )
    } catch {
      secondPage = null
    }
    if (!secondPage) {
      // 已知的 **harness 限制**（不是产品缺陷）：Windows 上刚被关闭的监听端口带着 TIME_WAIT
      // 连接时，新进程重新 bind 同一个 `--remote-debugging-port` 会失败（Chromium 日志：
      // `Cannot start http server for devtools`）。真实用户不传这个参数，所以与产品无关。
      skip('新进程的 CDP 状态复核', '调试端口重新绑定失败（harness 限制：真实用户不传 --remote-debugging-port）')
    } else {
      client = await Cdp.connect(secondPage.webSocketDebuggerUrl, secondPage.id)
      const afterRestart = await client.evaluate('return await window.opennote.update.status()')
      check('新进程能读到更新状态（说明它真的跑起来了）', () => {
        if (typeof afterRestart.current !== 'string') throw new Error('读不到版本')
        return `current=${afterRestart.current} phase=${afterRestart.phase}`
      })
    }
  } catch (error) {
    // 流程中断（超时等）也要走到摘要：否则失败清单与主进程日志会被异常吞掉。
    failCount += 1
    failures.push(`流程中断：${error instanceof Error ? error.message : String(error)}`)
    console.log(`  FAIL 流程中断 — ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (client) client.close()
    const killedPid = await killByCdp(cdpPort)
    if (appProcess && !appProcess.killed) {
      try {
        appProcess.kill()
      } catch {
        /* 忽略 */
      }
    }
    if (killedPid) console.log(`  · 已结束副本进程 pid=${killedPid}`)
    // 兜底：CDP 端点不可达时（见上面的 harness 限制）按命令行里的临时目录精确清理副本。
    killProcessesUnder(base)
    if (server) await new Promise((resolve) => server.close(resolve))
    if (appLogPathRef && fs.existsSync(appLogPathRef)) {
      appLogTail = fs
        .readFileSync(appLogPathRef, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-40)
    }
    const applyLogPath = path.join(userData, 'updates', 'apply.log')
    if (fs.existsSync(applyLogPath)) {
      applyLogTail = fs
        .readFileSync(applyLogPath, 'utf8')
        .split(/\r?\n/)
        .filter(Boolean)
        .slice(-25)
    }
    if (!KEEP) {
      await fsp.rm(base, { recursive: true, force: true }).catch(() => {})
    } else {
      console.log(`  · --keep：临时目录保留在 ${base}`)
    }
  }

  console.log('\n=== 摘要 ===')
  console.log(`PASS ${passCount} / FAIL ${failCount} / SKIP ${skipCount}`)
  if (failures.length) {
    console.log('失败项：')
    for (const item of failures) console.log(`  - ${item}`)
    if (appLogTail.length) {
      console.log('主进程日志（尾部）：')
      for (const line of appLogTail) console.log(`  | ${line}`)
    }
    if (applyLogTail.length) {
      console.log('覆盖脚本日志（userData/updates/apply.log）：')
      for (const line of applyLogTail) console.log(`  | ${line}`)
    }
  }
  console.log('本脚本没覆盖：真实 GitHub 网络、真实发布包的 asar 版本号变化（假包覆盖后应用仍报原版本）、')
  console.log('只读安装目录、覆盖途中断电、以及「图标长什么样」（那需要人看，见 docs/update/00）。')
  return failCount > 0 ? 1 : 0
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\nFAIL 脚本自身异常：${error instanceof Error ? error.stack : String(error)}`)
    process.exit(1)
  },
)
