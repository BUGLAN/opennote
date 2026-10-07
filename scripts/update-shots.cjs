#!/usr/bin/env node
'use strict'

/**
 * 给「红框处那个更新图标」拍真图（docs/update/shots/ 里那四张就是这么来的）。
 *
 *   node scripts/update-shots.cjs        # 或 pnpm update:shots
 *
 * 做法：跑 `release/win-unpacked/Opennote.exe`（独立 `--user-data-dir`，绝不碰用户真实数据），
 * 把 `OPENNOTE_UPDATE_API_BASE` / `OPENNOTE_UPDATE_DOWNLOAD_BASE` 指向一个本地假 Release，
 * 再用 CDP 依次把状态推到 available / downloading / ready，各截一张侧栏头部特写；
 * 最后打开「设置 → 帮助」截一张整窗（看「更新」那一行）。
 *
 * 为什么值得单独留一个脚本：这几张图是「颜色要与普通图标区分」「位置就在红框处」
 * 这两条需求的**肉眼证据**，改样式之后要能一条命令重新生成，而不是靠谁手点一遍。
 *
 * 依赖：本机已 `pnpm build:desktop && npx electron-builder --config electron-builder.yml --dir`
 * （与 RELEASING.md 第 2 节的打包命令一致）。
 */

const fs = require('node:fs')
const http = require('node:http')
const net = require('node:net')
const crypto = require('node:crypto')
const os = require('node:os')
const path = require('node:path')
const { spawn, spawnSync } = require('node:child_process')
const { crc32 } = require('../electron/zip.cjs')

const ROOT = path.resolve(__dirname, '..')
const EXE = path.join(ROOT, 'release', 'win-unpacked', 'Opennote.exe')
const OUT = path.join(ROOT, 'docs', 'update', 'shots')
const VERSION = '9.9.9'
const ASSET = `Opennote-${VERSION}-win-x64.zip`

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/** 一个极小的 store 模式 zip：够走完「下载 → 校验 → 解压」，又不至于让截图等太久。 */
function buildTinyZip() {
  const data = Buffer.from('hello', 'utf8')
  const name = Buffer.from('a.txt', 'utf8')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(20, 4)
  local.writeUInt32LE(crc32(data), 14)
  local.writeUInt32LE(data.length, 18)
  local.writeUInt32LE(data.length, 22)
  local.writeUInt16LE(name.length, 26)
  const central = Buffer.alloc(46)
  central.writeUInt32LE(0x02014b50, 0)
  central.writeUInt16LE(20, 4)
  central.writeUInt16LE(20, 6)
  central.writeUInt32LE(crc32(data), 16)
  central.writeUInt32LE(data.length, 20)
  central.writeUInt32LE(data.length, 24)
  central.writeUInt16LE(name.length, 28)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(1, 8)
  eocd.writeUInt16LE(1, 10)
  eocd.writeUInt32LE(central.length + name.length, 12)
  eocd.writeUInt32LE(local.length + name.length + data.length, 16)
  return Buffer.concat([local, name, data, central, name, eocd])
}

async function main() {
  if (!fs.existsSync(EXE)) {
    console.error(`FAIL  没有 ${path.relative(ROOT, EXE)}；先跑 pnpm build:desktop && npx electron-builder --config electron-builder.yml --dir`)
    process.exitCode = 1
    return
  }
  fs.mkdirSync(OUT, { recursive: true })

  const port = await freePort()
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-shots-'))
  const userData = path.join(base, 'ud')
  fs.mkdirSync(userData, { recursive: true })
  const zipBuffer = buildTinyZip()
  const sha = crypto.createHash('sha256').update(zipBuffer).digest('hex')

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1')
    const origin = `http://127.0.0.1:${server.address().port}`
    if (url.pathname === '/repos/BUGLAN/opennote/releases/latest') {
      response.writeHead(200, { 'content-type': 'application/json' })
      return response.end(
        JSON.stringify({
          tag_name: `v${VERSION}`,
          html_url: `${origin}/tag/v${VERSION}`,
          assets: [
            {
              name: ASSET,
              browser_download_url: `${origin}/download/v${VERSION}/${ASSET}`,
              size: zipBuffer.length,
              digest: `sha256:${sha}`,
            },
          ],
        }),
      )
    }
    if (url.pathname === `/download/v${VERSION}/SHA256SUMS`) {
      response.writeHead(200, { 'content-type': 'text/plain' })
      return response.end(`${sha}  ${ASSET}\n`)
    }
    if (url.pathname === `/download/v${VERSION}/${ASSET}`) {
      // 慢速分块：让界面停在「下载中」，把进度弧拍下来。
      response.writeHead(200, { 'content-type': 'application/zip', 'content-length': String(zipBuffer.length) })
      let offset = 0
      const step = Math.max(1, Math.ceil(zipBuffer.length / 12))
      const timer = setInterval(() => {
        if (offset >= zipBuffer.length) {
          clearInterval(timer)
          response.end()
          return
        }
        response.write(zipBuffer.subarray(offset, offset + step))
        offset += step
      }, 120)
      return
    }
    response.writeHead(404)
    response.end('nope')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  const env = { ...process.env, OPENNOTE_UPDATE_API_BASE: baseUrl, OPENNOTE_UPDATE_DOWNLOAD_BASE: baseUrl }
  // 本机可能残留它：那样 exe 会当 node 跑，窗口根本不出现。
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(EXE, [`--user-data-dir=${userData}`, `--remote-debugging-port=${port}`], {
    env,
    stdio: 'ignore',
    windowsHide: false,
  })
  child.on('error', () => {})

  let page = null
  for (let i = 0; i < 120 && !page; i += 1) {
    try {
      page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page')
    } catch {
      page = null
    }
    if (!page) await delay(400)
  }
  if (!page) throw new Error('应用没起来（先确认没有别的 Opennote 占着同一个 user-data-dir）')

  const socket = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data)
    if (message.id && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) reject(new Error(JSON.stringify(message.error)))
      else resolve(message.result)
    }
  })
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      socket.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const result = await send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  const shoot = async (file, clip) => {
    const result = await send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 3 } })
    fs.writeFileSync(path.join(OUT, file), Buffer.from(result.data, 'base64'))
    console.log(`  → docs/update/shots/${file}`)
  }

  await send('Page.enable')
  await delay(1500)

  // ① 有更新：强调色下载图标
  await evaluate('return await window.opennote.update.check({ force: true })')
  await delay(600)
  await shoot('01-available.png', { x: 0, y: 0, width: 300, height: 40 })
  console.log(`  available phase=${await evaluate('return (await window.opennote.update.status()).phase')}`)

  // ② 下载中：进度弧
  void evaluate('return await window.opennote.update.download()')
  for (let i = 0; i < 40; i += 1) {
    const percent = await evaluate('return (await window.opennote.update.status()).progress?.percent ?? -1')
    if (percent >= 20 && percent < 100) break
    await delay(150)
  }
  await shoot('02-downloading.png', { x: 0, y: 0, width: 300, height: 40 })
  console.log(`  downloading progress=${await evaluate('return JSON.stringify((await window.opennote.update.status()).progress)')}`)

  // ③ 已下载：重启图标
  for (let i = 0; i < 60; i += 1) {
    if ((await evaluate('return (await window.opennote.update.status()).phase')) === 'ready') break
    await delay(250)
  }
  await delay(400)
  await shoot('03-ready.png', { x: 0, y: 0, width: 300, height: 40 })
  console.log(`  ready phase=${await evaluate('return (await window.opennote.update.status()).phase')}`)

  // ④ 设置 →「帮助」：那一行「更新」
  await evaluate('document.querySelector(\'button[title="设置"]\')?.click(); return "clicked"')
  await delay(700)
  await evaluate(
    '[...document.querySelectorAll(".settings__tab")].find((b) => b.textContent.includes("帮助"))?.click(); return "tab"',
  )
  await delay(700)
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  fs.writeFileSync(path.join(OUT, '04-settings-help.png'), Buffer.from(shot.data, 'base64'))
  console.log('  → docs/update/shots/04-settings-help.png')

  // 收尾：按调试端口精确杀掉这个副本（绝不 taskkill /IM：那会连用户自己的 Opennote 一起杀）
  try {
    const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()
    const browser = new WebSocket(version.webSocketDebuggerUrl)
    await new Promise((resolve) => browser.addEventListener('open', resolve, { once: true }))
    browser.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo', params: {} }))
    const info = await new Promise((resolve) => {
      browser.addEventListener('message', (event) => resolve(JSON.parse(event.data)))
    })
    const pid = (info.result.processInfo || []).find((item) => item.type === 'browser')?.id
    if (pid) {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      console.log(`  已结束副本 pid=${pid}`)
    }
  } catch (error) {
    console.log(`  收尾失败（不影响图片）：${error.message}`)
  }
  server.close()
  await delay(500)
  fs.rmSync(base, { recursive: true, force: true })
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
