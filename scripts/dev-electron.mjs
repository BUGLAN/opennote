#!/usr/bin/env node
/**
 * Opennote 一键开发启动器（纯 Node ESM，无额外依赖）。
 *
 * 流程：
 *   1. 用当前 Node 可执行文件直接跑 vite/bin/vite.js（不依赖 .cmd shim，Windows 下更可靠）
 *   2. 轮询 http://127.0.0.1:5173，最多 40 次 × 500ms
 *   3. 就绪后拉起 Electron，注入 OPENNOTE_DEV_URL，stdio 继承到当前终端
 *   4. Electron 退出 → 结束 Vite 子进程 → 以相同退出码退出
 *
 * Ctrl+C：Windows 下 SIGINT 会同时送达同控制台的子进程，这里再做一次兜底清理。
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const DEV_URL = process.env.OPENNOTE_DEV_URL || 'http://127.0.0.1:5173'
const POLL_ATTEMPTS = 40
const POLL_INTERVAL_MS = 500
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129 }

const log = (message) => console.log(`[dev-electron] ${message}`)
const delay = (ms) => new Promise((resolve) => { setTimeout(resolve, ms) })

let viteChild = null
let electronChild = null
let shuttingDown = false

/** 解析 vite 的入口脚本（package.json 的 exports 可能不暴露 bin 路径，故有兜底）。 */
function resolveViteBin() {
  const candidates = []
  try {
    candidates.push(path.join(path.dirname(require.resolve('vite/package.json')), 'bin', 'vite.js'))
  } catch {
    /* vite 不在依赖里，继续尝试直接找路径 */
  }
  candidates.push(path.join(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js'))
  return candidates.find((candidate) => existsSync(candidate)) || null
}

/** 结束子进程；Windows 上没有真正的信号，用 taskkill /T 连子进程树一起收掉。 */
function killChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  if (process.platform === 'win32' && typeof child.pid === 'number') {
    const result = spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
    if (!result.error && result.status === 0) return
  }
  try {
    child.kill('SIGTERM')
  } catch {
    /* 忽略：进程可能已经退出 */
  }
}

function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  killChild(electronChild)
  killChild(viteChild)
  process.exit(code)
}

for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
  process.on(signal, () => {
    log(`收到 ${signal}，正在关闭…`)
    shutdown(SIGNAL_EXIT_CODES[signal])
  })
}

async function waitForDevServer(url) {
  for (let attempt = 1; attempt <= POLL_ATTEMPTS; attempt += 1) {
    if (viteChild && viteChild.exitCode !== null) {
      throw new Error(`Vite 进程已退出（退出码 ${viteChild.exitCode}）`)
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) })
      if (response.status < 500) return true
    } catch {
      /* 服务器还没起来，继续等 */
    }
    if (attempt < POLL_ATTEMPTS) await delay(POLL_INTERVAL_MS)
  }
  return false
}

async function main() {
  const viteBin = resolveViteBin()
  if (!viteBin) throw new Error('未找到 vite，请先在项目根目录执行 pnpm install')

  const target = new URL(DEV_URL)
  const port = target.port || '5173'

  log(`启动 Vite 开发服务器（${DEV_URL}）…`)
  viteChild = spawn(
    process.execPath,
    [viteBin, '--host', target.hostname, '--port', port, '--strictPort'],
    { cwd: projectRoot, stdio: 'inherit', env: { ...process.env, BROWSER: 'none' } },
  )
  viteChild.on('error', (error) => {
    log(`Vite 启动失败：${error.message}`)
    shutdown(1)
  })
  viteChild.on('exit', (code) => {
    if (shuttingDown) return
    log(`Vite 已退出（code=${code ?? 'null'}）`)
    shutdown(typeof code === 'number' ? code : 1)
  })

  const ready = await waitForDevServer(DEV_URL)
  if (!ready) throw new Error(`等待 ${DEV_URL} 超时（${POLL_ATTEMPTS} 次 × ${POLL_INTERVAL_MS}ms）`)
  log(`Vite 已就绪，${DEV_URL}`)

  const electronPath = require('electron')
  if (typeof electronPath !== 'string' || !existsSync(electronPath)) {
    throw new Error('未找到 electron 可执行文件，请确认 electron 已安装')
  }

  log('启动 Electron…')
  electronChild = spawn(electronPath, [projectRoot], {
    cwd: projectRoot,
    stdio: 'inherit',
    env: { ...process.env, OPENNOTE_DEV_URL: DEV_URL },
  })
  electronChild.on('error', (error) => {
    log(`Electron 启动失败：${error.message}`)
    shutdown(1)
  })
  electronChild.on('exit', (code, signal) => {
    const exitCode = typeof code === 'number' ? code : signal ? 1 : 0
    log(`Electron 已退出（code=${code ?? 'null'} signal=${signal ?? 'null'}）`)
    shutdown(exitCode)
  })
}

main().catch((error) => {
  console.error(`[dev-electron] ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
})
