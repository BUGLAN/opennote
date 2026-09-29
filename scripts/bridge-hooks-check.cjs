#!/usr/bin/env node
/**
 * 桥挂钩装配漂移检查（静态）。
 *
 * 为什么需要它：主进程与桥是**同一进程里的两侧**，桥用
 * `typeof options.X === 'function' ? options.X() : <兜底>` 的写法声明挂钩，
 * 装配处（`main.cjs` 的 `createBridge({...})`）漏传一个，桥不会报错，只会
 * 安静地走兜底分支。这类缺陷已经被独立验证抓到两次：
 *
 *   1. `bridgeStatusPayload()` 逐字段重建 → `address/error/lastRejectedOrigin/
 *      startPort/portRange/lastPairing` 6 个字段被截断，R4b 轮换警告、R8 拒绝
 *      记录、S4/S5「下一步」三处 UI 成为死代码。
 *   2. `getWorkspaceInfo` 从未传给桥 → `workspace.open` 恒 false → 插件对着一本
 *      开着的笔记本报 `IMP-4007`（「笔记本文件夹没打开」）。
 *
 * 两次都是**两侧各自单测全绿、断在中间的缝**，所以必须有一条跨文件的静态
 * 断言：桥读了哪些 `options.*`，装配处就得传哪些。
 *
 * 用法：node scripts/bridge-hooks-check.cjs [--verbose]
 */
'use strict'

const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '..')
const BRIDGE = path.join(ROOT, 'electron', 'bridge.cjs')
const MAIN = path.join(ROOT, 'electron', 'main.cjs')

/**
 * 必须装配的挂钩。每个都对应一条**用户可见**的能力，漏了就是功能坏掉而不是降级：
 *   getWorkspaceInfo —— /v1/health 与 /v1/workspace 的 workspace.open，插件据此
 *                       判断能不能剪藏（漏了 → 恒报 IMP-4007）
 *   getAppVersion    —— /v1/health 的 app 字段，漏了回桥自己的常量（版本说错）
 *   getInboxEnabled  —— /v1/health 的 inbox 字段，漏了恒 false（明明支持收件箱）
 *   getDefaultFolder —— /v1/workspace 的 defaultFolder，落点默认值
 */
const REQUIRED = ['getWorkspaceInfo', 'getAppVersion', 'getInboxEnabled', 'getDefaultFolder']

/**
 * 已知**本轮未接线**的挂钩，附原因。列在这里是为了让它们保持「可见」：
 * 一旦有人接上，下面的断言会立刻 FAIL 提醒把这一行删掉，不允许悄悄留成僵尸条目。
 *   三个都要读**渲染层**的数据（导入日志 / 幂等索引 / 标签），而桥在主进程，
 *   得走 `opennote:import:request` relay；其中 `getTags` 还被桥**同步**调用
 *   （`bridge.cjs` 的 `/v1/tags` 分支），relay 是异步的，接之前要先把那处改成 await。
 */
const KNOWN_UNWIRED = ['getRecentImports', 'getImportRecord', 'getTags']

/**
 * **设计上就该用桥的默认值**的可选挂钩，没有装配不是缺陷。每条都要写清为什么。
 *   isEnabled        —— 桥的运行与否由主进程用 start()/stop() 控制，不靠这个开关
 *   limits           —— 限流/体积上限走桥的内置默认值，本轮没有产品需求要覆盖
 *   startPort        —— 起始端口由 `bridge.start({port})` 传（设置面板里选的），
 *                       不是装配期常量
 *   getInboxWatchMode—— 桥自己的 status 会回一个猜测值，主进程在
 *                       `bridgeStatusPayload()` 里如实覆盖 `inboxWatch`，所以不需要
 *   getTokenHash     —— 令牌哈希由桥自己读写 `userData/bridge.json` 持久化；
 *                       只有渲染层代管令牌时才需要这个挂钩
 */
const OPTIONAL_BY_DESIGN = ['isEnabled', 'limits', 'startPort', 'getInboxWatchMode', 'getTokenHash']

let pass = 0
let fail = 0
const failures = []

function check(ok, label, detail) {
  if (ok) {
    pass += 1
    if (VERBOSE) console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail += 1
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`)
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

const VERBOSE = process.argv.includes('--verbose')

function readFileOrDie(file) {
  if (!fs.existsSync(file)) {
    console.error(`找不到 ${path.relative(ROOT, file)}`)
    process.exit(2)
  }
  return fs.readFileSync(file, 'utf8')
}

/** 桥侧读到的所有 `options.<name>`（去掉注释，避免把文档里的示例当成真挂钩）。 */
function bridgeReadsHooks(source) {
  const code = stripComments(source)
  const names = new Set()
  for (const m of code.matchAll(/\boptions\.([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  return names
}

/** 装配处 `createBridge({ ... })` 那个对象字面量的**顶层键**。 */
function passedHookNames(source) {
  const code = stripComments(source)
  const start = code.indexOf('createBridge({')
  if (start < 0) return { found: false, names: new Set(), body: '' }
  const open = code.indexOf('{', start + 'createBridge('.length)
  let depth = 0
  let end = -1
  for (let i = open; i < code.length; i += 1) {
    const ch = code[i]
    if (ch === '{') depth += 1
    else if (ch === '}') {
      depth -= 1
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return { found: false, names: new Set(), body: '' }
  const body = code.slice(open + 1, end)
  // 只取深度为 0 的键，避免把嵌套对象（如 lastPairing 的字段）算进来。
  const names = new Set()
  let level = 0
  const lines = body.split('\n')
  for (const raw of lines) {
    const line = raw.trim()
    if (level === 0) {
      // `key: value` 与 **简写属性**（`getAdvancedOverwrite,`）都要认 ——
      // 早先只认带冒号的写法，把简写漏成了「未装配」，是个假阳性。
      const kv = /^([A-Za-z_$][\w$]*)\s*:/.exec(line)
      const shorthand = /^([A-Za-z_$][\w$]*)\s*,$/.exec(line)
      if (kv && kv[1]) names.add(kv[1])
      else if (shorthand && shorthand[1]) names.add(shorthand[1])
    }
    for (const ch of raw) {
      if (ch === '{' || ch === '(' || ch === '[') level += 1
      else if (ch === '}' || ch === ')' || ch === ']') level -= 1
    }
  }
  return { found: true, names, body }
}

/** 去注释，但保留字符串字面量（避免把 `'//'` 当注释切掉）。 */
function stripComments(source) {
  let out = ''
  let i = 0
  let state = 'code'
  let quote = ''
  while (i < source.length) {
    const ch = source[i]
    const next = source[i + 1]
    if (state === 'code') {
      if (ch === '/' && next === '/') {
        state = 'line'
        i += 2
        continue
      }
      if (ch === '/' && next === '*') {
        state = 'block'
        i += 2
        continue
      }
      if (ch === '"' || ch === "'" || ch === '`') {
        state = 'string'
        quote = ch
      }
      out += ch
      i += 1
      continue
    }
    if (state === 'line') {
      if (ch === '\n') {
        state = 'code'
        out += ch
      }
      i += 1
      continue
    }
    if (state === 'block') {
      if (ch === '*' && next === '/') {
        state = 'code'
        i += 2
        continue
      }
      if (ch === '\n') out += ch
      i += 1
      continue
    }
    // string
    if (ch === '\\') {
      out += ch + (next ?? '')
      i += 2
      continue
    }
    if (ch === quote) state = 'code'
    out += ch
    i += 1
  }
  return out
}

console.log('='.repeat(66))
console.log('桥挂钩装配漂移检查（main.cjs ↔ bridge.cjs）')
console.log('='.repeat(66))

const bridgeSource = readFileOrDie(BRIDGE)
const mainSource = readFileOrDie(MAIN)

const read = bridgeReadsHooks(bridgeSource)
const passed = passedHookNames(mainSource)

check(read.size > 0, '桥侧 `options.*` 挂钩读取解析成功', `读到 ${read.size} 个：${[...read].sort().join(', ')}`)
check(passed.found, '装配处 `createBridge({...})` 对象字面量解析成功', passed.found ? `顶层键 ${passed.names.size} 个` : '未找到')
if (!passed.found) {
  console.log('\n解析失败，后面的断言没有意义。')
  process.exit(2)
}

// 1) 契约里的必需挂钩一个都不能漏 —— 这条断言就是为了 IMP-4007 那个缺陷。
for (const name of REQUIRED) {
  check(
    passed.names.has(name),
    `必需挂钩 \`${name}\` 已装配`,
    passed.names.has(name) ? 'ok' : '漏传：桥会走兜底分支，功能静默失效',
  )
}

// 2) 桥读的每个挂钩都得有交代：装配了，或已归类（KNOWN_UNWIRED / OPTIONAL_BY_DESIGN）。
const unwired = [...read].filter((name) => !passed.names.has(name)).sort()
const undeclared = unwired.filter(
  (name) => !KNOWN_UNWIRED.includes(name) && !OPTIONAL_BY_DESIGN.includes(name),
)
check(
  undeclared.length === 0,
  '桥读到的挂钩都在装配处有交代（已装配 / KNOWN_UNWIRED / OPTIONAL_BY_DESIGN）',
  undeclared.length === 0
    ? `未装配 ${unwired.length} 个，均已归类`
    : `未交代：${undeclared.join(', ')}`,
)

// 3) 反向：分类名单里的条目一旦被接上就必须删掉，不许留僵尸说明。
const stale = [...KNOWN_UNWIRED, ...OPTIONAL_BY_DESIGN].filter((name) => passed.names.has(name))
check(
  stale.length === 0,
  'KNOWN_UNWIRED / OPTIONAL_BY_DESIGN 没有已经接线的僵尸条目',
  stale.length === 0 ? 'ok' : `已接线但仍在名单里（请删除）：${stale.join(', ')}`,
)

check(
  [...KNOWN_UNWIRED, ...OPTIONAL_BY_DESIGN].every((name) => read.has(name)),
  '两个分类名单里的名字都是桥真的读的挂钩（防止名单写错）',
  'ok',
)

// 4) 上次那条缺陷的锚点：`bridgeStatusPayload()` 不许再逐字段重建。
check(
  /return\s*\{\s*\/\/[\s\S]{0,600}?\.\.\.raw,/.test(stripComments(mainSource)) ||
    /\.\.\.raw,/.test(stripComments(mainSource)),
  '`bridgeStatusPayload()` 仍带 `...raw` 透传（6 字段截断不复发）',
  'ok',
)

console.log('-'.repeat(66))
if (!VERBOSE) console.log('（加 --verbose 看每条 PASS）')
console.log(`PASS ${pass} · FAIL ${fail}`)
if (fail > 0) {
  console.log('\n失败项：')
  for (const item of failures) console.log(`  - ${item}`)
}
console.log('='.repeat(66))
process.exit(fail > 0 ? 1 : 0)
