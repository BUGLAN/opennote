#!/usr/bin/env node
'use strict'

/**
 * macOS 原地自更新的**端到端**脚本（真跑，绝不碰真实的 /Applications 安装）。
 *
 *   node scripts/update-e2e-mac.cjs [--keep]
 *
 * 它做的事：
 *   1. 拿 `release/mac-arm64/Opennote.app`（`pnpm package:mac` 的产物）复制两份：
 *      · 一份当**安装目录**里的旧版本（当前 package.json 的版本）
 *      · 一份改造成「新版本」fixture：asar 里的 `package.json` 与 Info.plist 都改成
 *        `9.9.9`，加一个标记文件，然后**重新 ad-hoc 签名**（改完不签就起不来），
 *        再用 `ditto` 压成 `Opennote-9.9.9-mac-<arch>.zip`。
 *      为什么两处都要改：`app.getVersion()` 读的是 asar 里的 `package.json`，
 *      而更新器的**验签预检**读的是 Info.plist 的 `CFBundleShortVersionString`；
 *      真发布时两者由 electron-builder 一起写，fixture 必须同样对待，否则测不出
 *      「更新后版本号真的变了」。
 *   2. 起本地 HTTP 服务器冒充 GitHub Releases（`/repos/<owner>/<repo>/releases/latest`、
 *      `/download/v9.9.9/<asset>`、`SHA256SUMS`），用 `OPENNOTE_UPDATE_API_BASE` /
 *      `OPENNOTE_UPDATE_DOWNLOAD_BASE` 把应用指过去。
 *   3. 启动安装目录里的应用，用 CDP 调
 *      `window.opennote.update.status()/check({force:true})/download()/restart()`
 *      （真实 IPC、真实网络、真实磁盘、真实 `ditto` 解压、真实 `codesign` 验签、
 *      真实覆盖脚本），然后断言：
 *        · `supported === true`（mac 平台硬门已放开）
 *        · 下载后 staging 里是**完整且验签通过**的 `Opennote.app`
 *        · restart 之后安装目录里的 bundle 变成了 9.9.9，**签名仍然有效**，
 *          标记文件出现（证明确实整包换过去了）
 *        · 新进程真的起来了（CDP 重新连上且 `current === 9.9.9`）
 *        · 没留下 `.Opennote.app.old-*` 备份，`userData/updates` 被新版本收尾清干净
 *   4. 用 CDP 的 `SystemInfo.getProcessInfo` 拿到进程 PID 再精确杀（绝不 `pkill Opennote`：
 *      那会连用户自己开着的实例一起杀）。
 *
 * 本脚本**没有**覆盖什么（如实列出）：真实 GitHub、真实发布包（这里的「新版本」是
 * 由当前产物改造的 fixture）、只读安装目录、App Translocation、断电中断。
 * 退出码：0 = 全 PASS；1 = 有 FAIL；2 = 环境不具备（先跑 `pnpm package:mac`）。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const { spawn, spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const BUILT_APP = path.join(REPO_ROOT, 'release', `mac-${process.arch}`, 'Opennote.app')
const BUNDLE_NAME = 'Opennote.app'
const APP_EXEC = path.join('Contents', 'MacOS', 'Opennote')
const FAKE_VERSION = '9.9.9'
const ASSET_NAME = `Opennote-${FAKE_VERSION}-mac-${process.arch}.zip`
const MARKER_NAME = `UPDATE-MARKER-${FAKE_VERSION}.txt`
const KEEP = process.argv.includes('--keep')

const CODESIGN = '/usr/bin/codesign'
const PLUTIL = '/usr/bin/plutil'
const DITTO = '/usr/bin/ditto'

const results = []
let failures = 0

function check(label, fn) {
  try {
    const detail = fn()
    results.push({ ok: true, label, detail })
    console.log(`PASS  ${label}${detail ? ` —— ${detail}` : ''}`)
  } catch (error) {
    failures += 1
    results.push({ ok: false, label, detail: error.message })
    console.log(`FAIL  ${label} —— ${error.message}`)
  }
}

function skip(label, reason) {
  results.push({ ok: true, label, detail: `SKIP: ${reason}` })
  console.log(`SKIP  ${label} —— ${reason}`)
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitFor(label, predicate, timeoutMs, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let value
    try {
      value = await predicate()
    } catch {
      value = false
    }
    if (value) return value
    if (Date.now() > deadline) throw new Error(`超时（${timeoutMs}ms）：${label}`)
    await delay(intervalMs)
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

/** 同步跑一个系统工具；失败即抛（setup 阶段用，出错就应该立刻停）。 */
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.status !== 0) {
    throw new Error(`${command} ${args[0] || ''} 失败（${result.status}）：${(result.stderr || '').trim()}`)
  }
  return result
}

function codesignVerify(appPath) {
  const result = spawnSync(CODESIGN, ['--verify', '--deep', '--strict', appPath], { encoding: 'utf8' })
  return { ok: result.status === 0, detail: (result.stderr || '').trim() }
}

function plistVersion(appPath) {
  return run(PLUTIL, ['-extract', 'CFBundleShortVersionString', 'raw', path.join(appPath, 'Contents', 'Info.plist')])
    .stdout.trim()
}

/** asar CLI 在 pnpm 的 .pnpm 里（顶层解析不到），按需定位。 */
function asarCli() {
  const base = path.join(REPO_ROOT, 'node_modules', '.pnpm')
  const entry = fs
    .readdirSync(base)
    .filter((name) => name.startsWith('@electron+asar@'))
    .sort()
    .pop()
  if (!entry) throw new Error('找不到 @electron/asar（pnpm 依赖被裁掉了？）')
  const cli = path.join(base, entry, 'node_modules', '@electron', 'asar', 'bin', 'asar.js')
  if (!fs.existsSync(cli)) throw new Error(`找不到 asar CLI：${cli}`)
  return cli
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/* ------------------------------------------------------------------ CDP */

class CdpClient {
  constructor(socket) {
    this.socket = socket
    this.nextId = 1
    this.pending = new Map()
  }

  static async connect(port, timeoutMs = 30000) {
    const targets = await waitFor(
      `CDP :${port} 页面目标`,
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const list = await response.json()
        return list.some((target) => target.type === 'page') ? list : false
      },
      timeoutMs,
      300,
    )
    const page = targets.find((target) => target.type === 'page')
    const socket = new WebSocket(page.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const client = new CdpClient(socket)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data)
      const pending = client.pending.get(message.id)
      if (!pending) return
      client.pending.delete(message.id)
      if (message.error) pending.reject(new Error(JSON.stringify(message.error)))
      else pending.resolve(message.result)
    })
    return client
  }

  send(method, params = {}) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.socket.send(JSON.stringify({ id, method, params }))
    })
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) {
      throw new Error(`EVAL ERROR: ${JSON.stringify(result.exceptionDetails.exception?.description ?? result.exceptionDetails)}`)
    }
    return result.result.value
  }

  close() {
    try {
      this.socket.close()
    } catch {
      /* 已经关了 */
    }
  }
}

/** 精确杀掉我们启动的那个进程（绝不按进程名杀，免得连带用户的实例）。 */
async function killByPid(client) {
  try {
    const info = await client.send('SystemInfo.getProcessInfo')
    const pid = info?.processInfo?.id
    if (pid) process.kill(pid, 'SIGTERM')
    return pid
  } catch {
    return null
  }
}

/* --------------------------------------------------------- fake release */

function startFakeRelease({ zipPath, sums, size }) {
  const server = http.createServer((request, response) => {
    // 端口是 listen(0) 之后才知道的，所以 URL 在**请求时**才拼（不能写死占位符）。
    const base = `http://127.0.0.1:${server.address().port}`
    const url = request.url || ''
    if (url.endsWith('/releases/latest')) {
      const body = JSON.stringify({
        tag_name: `v${FAKE_VERSION}`,
        html_url: 'https://example.invalid/release',
        assets: [
          {
            name: ASSET_NAME,
            browser_download_url: `${base}/download/v${FAKE_VERSION}/${ASSET_NAME}`,
            size,
          },
        ],
      })
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(body)
      return
    }
    if (url === `/download/v${FAKE_VERSION}/SHA256SUMS`) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.end(sums)
      return
    }
    if (url === `/download/v${FAKE_VERSION}/${ASSET_NAME}`) {
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': size })
      fs.createReadStream(zipPath).pipe(response)
      return
    }
    response.writeHead(404)
    response.end('not found')
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

/* --------------------------------------------------------------- main */

async function main() {
  if (process.platform !== 'darwin') {
    skip('整体', 'macOS 专属脚本')
    return
  }
  if (!fs.existsSync(path.join(BUILT_APP, APP_EXEC))) {
    skip(
      '整体',
      `没有 ${path.relative(REPO_ROOT, BUILT_APP)}；先跑 pnpm package:mac`,
    )
    process.exitCode = 2
    return
  }

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-mac-update-e2e-'))
  console.log(`工作目录：${workDir}${KEEP ? '（--keep：结束后保留）' : ''}\n`)

  const installDir = path.join(workDir, 'install')
  const fixtureDir = path.join(workDir, 'fixture')
  const assetsDir = path.join(workDir, 'assets')
  const userData = path.join(workDir, 'userdata')
  for (const dir of [installDir, fixtureDir, assetsDir, userData]) fs.mkdirSync(dir, { recursive: true })

  let server = null
  let client = null
  try {
    const baseVersion = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version

    console.log('· 构造「安装目录里的旧版本」（当前产物原样复制）')
    run(DITTO, [BUILT_APP, path.join(installDir, BUNDLE_NAME)])
    check('前置：旧版本 bundle 签名有效、版本与 package.json 一致', () => {
      const verify = codesignVerify(path.join(installDir, BUNDLE_NAME))
      if (!verify.ok) throw new Error(`签名无效：${verify.detail}`)
      const version = plistVersion(path.join(installDir, BUNDLE_NAME))
      if (version !== baseVersion) throw new Error(`Info.plist 版本 ${version} != ${baseVersion}`)
      return `${version}，签名通过`
    })

    console.log('· 构造「新版本」fixture（asar + Info.plist 都改成 9.9.9，再重新签名）')
    const fixtureApp = path.join(fixtureDir, BUNDLE_NAME)
    run(DITTO, [BUILT_APP, fixtureApp])
    const asarPath = path.join(fixtureApp, 'Contents', 'Resources', 'app.asar')
    const asarOut = path.join(workDir, 'asar-out')
    run(process.execPath, [asarCli(), 'extract', asarPath, asarOut])
    const innerPkgPath = path.join(asarOut, 'package.json')
    const innerPkg = JSON.parse(fs.readFileSync(innerPkgPath, 'utf8'))
    innerPkg.version = FAKE_VERSION
    fs.writeFileSync(innerPkgPath, JSON.stringify(innerPkg, null, 2))
    fs.rmSync(asarPath, { force: true })
    run(process.execPath, [asarCli(), 'pack', asarOut, asarPath])
    fs.writeFileSync(path.join(fixtureApp, 'Contents', 'Resources', MARKER_NAME), `updated by e2e at ${new Date().toISOString()}\n`)
    run(PLUTIL, ['-replace', 'CFBundleShortVersionString', '-string', FAKE_VERSION, path.join(fixtureApp, 'Contents', 'Info.plist')])
    run(CODESIGN, ['--force', '--deep', '--sign', '-', fixtureApp])
    check('fixture：改完 asar/plist 之后重新 ad-hoc 签名有效，两处版本都是 9.9.9', () => {
      const verify = codesignVerify(fixtureApp)
      if (!verify.ok) throw new Error(`签名无效：${verify.detail}`)
      const version = plistVersion(fixtureApp)
      if (version !== FAKE_VERSION) throw new Error(`Info.plist 版本 ${version} != ${FAKE_VERSION}`)
      // 从**打包后的 asar** 里把 package.json 读回来确认 —— `app.getVersion()` 读的是它，
      // 只改 Info.plist 是不够的（踩过：应用起来仍报旧版本号）。
      // 注意 `asar extract-file` 是把文件写到**当前工作目录**、不是 stdout（踩过：读到空串）。
      const packedOut = path.join(workDir, 'asar-verify')
      fs.rmSync(packedOut, { recursive: true, force: true })
      run(process.execPath, [asarCli(), 'extract', asarPath, packedOut])
      const packaged = JSON.parse(fs.readFileSync(path.join(packedOut, 'package.json'), 'utf8'))
      if (packaged.version !== FAKE_VERSION) throw new Error(`asar 内 package.json 版本 ${packaged.version} != ${FAKE_VERSION}`)
      return `${FAKE_VERSION}（Info.plist 与 asar 内 package.json 一致）`
    })

    const zipPath = path.join(assetsDir, ASSET_NAME)
    run(DITTO, ['-c', '-k', '--sequesterRsrc', '--keepParent', fixtureApp, zipPath])
    const digest = sha256File(zipPath)
    const size = fs.statSync(zipPath).size
    fs.writeFileSync(path.join(assetsDir, 'SHA256SUMS'), `${digest}  ${ASSET_NAME}\n`)

    server = await startFakeRelease({ zipPath, sums: `${digest}  ${ASSET_NAME}\n`, size })
    const baseUrl = `http://127.0.0.1:${server.address().port}`
    console.log(`· 假 Release 已就绪：${baseUrl}（${ASSET_NAME}，${(size / 1048576).toFixed(1)} MB）\n`)

    const debugPort = await freePort()
    const env = { ...process.env, OPENNOTE_UPDATE_API_BASE: baseUrl, OPENNOTE_UPDATE_DOWNLOAD_BASE: baseUrl }
    delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(path.join(installDir, BUNDLE_NAME, APP_EXEC), [`--user-data-dir=${userData}`, `--remote-debugging-port=${debugPort}`], {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let appLog = ''
    child.stdout.on('data', (chunk) => (appLog += chunk))
    child.stderr.on('data', (chunk) => (appLog += chunk))

    client = await CdpClient.connect(debugPort, 60000)
    check('应用启动并连上 CDP', () => `pid=${child.pid}`)

    const initial = await client.evaluate('return await window.opennote.update.status()')
    check('macOS 上更新入口是支持的（平台硬门已放开）', () => {
      if (initial.supported !== true) throw new Error(`supported=${initial.supported} error=${JSON.stringify(initial.error)}`)
      if (initial.current !== baseVersion) throw new Error(`current=${initial.current} != ${baseVersion}`)
      return `current=${initial.current}, canAutoInstall=${initial.canAutoInstall}`
    })

    const available = await client.evaluate('return await window.opennote.update.check({ force: true })')
    check(`检查更新认出 v${FAKE_VERSION} 与 mac 资产`, () => {
      if (available.latest !== FAKE_VERSION) throw new Error(`latest=${available.latest} error=${JSON.stringify(available.error)}`)
      if (!available.asset || available.asset.name !== ASSET_NAME) throw new Error(`asset=${JSON.stringify(available.asset)}`)
      return `${available.asset.name}（${(available.asset.size / 1048576).toFixed(1)} MB）`
    })

    const ready = await client.evaluate('return await window.opennote.update.download()')
    check('下载 + ditto 解压 + 验签预检全部通过（phase=ready）', () => {
      if (ready.phase !== 'ready') throw new Error(`phase=${ready.phase} error=${JSON.stringify(ready.error)}`)
      return 'phase=ready'
    })
    check('zip 解压成功后立刻删掉，staging 里只剩 bundle 与标记', () => {
      const updates = path.join(userData, 'updates')
      if (fs.existsSync(path.join(updates, ASSET_NAME))) throw new Error('zip 应在解压成功后删除')
      if (fs.existsSync(path.join(updates, `${ASSET_NAME}.part`))) throw new Error('.part 残留')
      const staging = path.join(updates, `staging-${FAKE_VERSION}`)
      if (!fs.existsSync(path.join(staging, BUNDLE_NAME))) throw new Error(`缺少 staging/${BUNDLE_NAME}`)
      if (!fs.existsSync(path.join(staging, '.ready'))) throw new Error('缺少 .ready 标记')
      if (fs.existsSync(path.join(staging, '__MACOSX'))) throw new Error('__MACOSX 没被清掉')
      const verify = codesignVerify(path.join(staging, BUNDLE_NAME))
      if (!verify.ok) throw new Error(`staging 里的 bundle 签名无效：${verify.detail}`)
      return 'staging 就位且验签通过'
    })
    check('staging 里的 bundle 没有 quarantine 标记（否则换上去会被 Gatekeeper 拦）', () => {
      const staging = path.join(userData, 'updates', `staging-${FAKE_VERSION}`, BUNDLE_NAME)
      const result = spawnSync('/usr/bin/xattr', ['-p', 'com.apple.quarantine', staging], { encoding: 'utf8' })
      if (result.status === 0 && (result.stdout || '').trim()) throw new Error(`带 quarantine：${result.stdout.trim()}`)
      return '无 quarantine'
    })

    const restart = await client.evaluate('return await window.opennote.update.restart()')
    check('重启并更新被接受（主进程开始编排整包替换）', () => {
      if (restart.ok !== true) throw new Error(`restart=${JSON.stringify(restart)}`)
      return 'ok=true'
    })
    client.close()
    client = null

    const applyLog = path.join(userData, 'updates', 'apply.log')
    await waitFor(
      '覆盖脚本报告完成',
      () => fs.existsSync(applyLog) && fs.readFileSync(applyLog, 'utf8').includes('整包替换'),
      180000,
      300,
    )

    await waitFor('安装目录换成新版本', () => plistVersion(path.join(installDir, BUNDLE_NAME)) === FAKE_VERSION, 180000, 500)
    check('安装目录里的 bundle 真的被整包换成 9.9.9，且签名仍然有效', () => {
      const installed = path.join(installDir, BUNDLE_NAME)
      const verify = codesignVerify(installed)
      if (!verify.ok) throw new Error(`换上去的 bundle 签名无效：${verify.detail}`)
      if (!fs.existsSync(path.join(installed, 'Contents', 'Resources', MARKER_NAME))) throw new Error('缺少新版本标记文件')
      return `${plistVersion(installed)}，签名通过，标记文件在`
    })
    check('旧版本备份被清掉（不留 .Opennote.app.old-*）', () => {
      const leftovers = fs.readdirSync(installDir).filter((name) => name.includes('.old-'))
      if (leftovers.length) throw new Error(`残留 ${JSON.stringify(leftovers)}`)
      return '无残留'
    })

    // 「新版本真的起来了」的主证据：它启动时会消费 result.json 并清掉 staging。
    await waitFor(
      '新版本启动并完成收尾（result.json 被消费、staging 被清掉）',
      () => !fs.existsSync(path.join(userData, 'updates', `staging-${FAKE_VERSION}`)),
      120000,
      500,
    )
    check('新版本启动并完成收尾（staging 被清掉、无 zip/.part 残留）', () => {
      const updates = path.join(userData, 'updates')
      const leftovers = fs.readdirSync(updates).filter((name) => name.startsWith('staging-') || name.endsWith('.zip') || name.endsWith('.part'))
      if (leftovers.length) throw new Error(`残留 ${JSON.stringify(leftovers)}`)
      return '清理干净'
    })

    const second = await CdpClient.connect(debugPort, 60000)
    client = second
    const after = await client.evaluate('return await window.opennote.update.status()')
    check('新进程报的版本号变成了 9.9.9（真·更新完成）', () => {
      if (after.current !== FAKE_VERSION) throw new Error(`current=${after.current}`)
      return `current=${after.current}（更新前 ${initial.current}）`
    })
    check('重启后不再提示「有更新」（已经是这个版本了）', () => {
      if (after.latest && after.latest !== FAKE_VERSION) throw new Error(`latest=${after.latest}`)
      return `phase=${after.phase}`
    })
  } finally {
    if (client) {
      await killByPid(client)
      client.close()
    }
    if (server) server.close()
    await delay(500)
    if (!KEEP) {
      fs.rmSync(workDir, { recursive: true, force: true })
    } else {
      console.log(`\n保留工作目录：${workDir}`)
    }
  }
}

main()
  .then(() => {
    console.log(`\n结果：${results.filter((r) => r.ok).length} PASS / ${failures} FAIL（共 ${results.length} 项）`)
    if (failures > 0) process.exitCode = 1
  })
  .catch((error) => {
    console.error(`\n脚本异常：${error && error.stack ? error.stack : String(error)}`)
    process.exitCode = 1
  })
