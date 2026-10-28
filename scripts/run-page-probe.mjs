#!/usr/bin/env node
/**
 * `pnpm probe:page` —— 用**真实 Electron** 跑 HTML 页面协议的端到端探针。
 *
 * 为什么需要一层包装：
 *   1. 直接 `npx electron xxx.cjs` 在某些环境里会把 `ELECTRON_RUN_AS_NODE=1` 传进去，
 *      于是 `require('electron')` 返回的是**路径字符串**而不是模块 —— 症状是
 *      `Cannot read properties of undefined (reading 'registerSchemesAsPrivileged')`。
 *      这里显式把它从子进程环境里删掉，并且**先自检出这个问题**而不是让人对着报错猜。
 *   2. 探针要用到 electron 包里的可执行文件路径，这个路径只有 `require('electron')`
 *      在 Node（非 Electron）里才给得出来。
 *
 * 无头环境也能跑（窗口 `show: false`）。全部通过 → 退出码 0。
 */
import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const require_ = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))

let binary
try {
  binary = require_('electron')
} catch (error) {
  console.error('[probe:page] 读不到 electron 可执行文件：' + (error && error.message ? error.message : error))
  process.exit(1)
}
if (typeof binary !== 'string') {
  console.error('[probe:page] require("electron") 返回的不是路径 —— 当前进程可能被当成 Electron 运行时启动了。')
  process.exit(1)
}

const env = { ...process.env }
// 关键：ELECTRON_RUN_AS_NODE 会让 electron.exe 以「纯 Node」身份启动 —— 此时没有 app / protocol。
delete env.ELECTRON_RUN_AS_NODE

const child = spawn(binary, [join(here, 'page-protocol-probe.cjs')], { stdio: 'inherit', env })
child.on('exit', (code, signal) => {
  if (signal) {
    console.error('[probe:page] 被信号终止：' + signal)
    process.exit(1)
  }
  process.exit(code ?? 1)
})
