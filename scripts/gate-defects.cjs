#!/usr/bin/env node
'use strict'

/**
 * Opennote A 线缺陷门禁（D20 / D29 / D31 / D03 / D08 / D12）——可复现证据脚本。
 *
 * 用法：
 *   node scripts/gate-defects.cjs                  # 6 条逐条判定（默认）
 *   node scripts/gate-defects.cjs --verbose        # 追加子进程原始输出
 *   node scripts/gate-defects.cjs --full           # 额外跑**全量** vitest 套件
 *   node scripts/gate-defects.cjs --no-mutants     # 跳过变异灵敏度检查（快 ~20s）
 *   node scripts/gate-defects.cjs --self-test      # 自检：崩溃的 harness 必须判 CRASHED 而不是 MISSED
 *   node scripts/gate-defects.cjs --keep           # 保留临时目录
 *
 * 退出码：0 = 6 条全部 PASS；1 = 任一 FAIL（含变异检查「护栏不灵敏」与「无法判定」）。
 *
 * 这个脚本**不改任何源码**，它做三件事：
 *   1. 静态取证：在真实源码里核对每条缺陷的修复符号与调用点（含「不得退回旧实现」的反向断言）。
 *   2. 行为取证：跑 `scripts/ipc-safety-check.cjs --verbose`（真实 electron/main.cjs + stub electron）
 *      与 vitest（真实 src/fs、src/data 模块），按**用例名**强制要求对应分组的用例存在且全绿。
 *   3. 变异灵敏度：在**编译期**把 main.cjs 的源码改回「修复前」写法（不落任何 main.cjs 副本），
 *      确认护栏会变红。护栏对回归不敏感 = 证据无效；**harness 崩溃 = 无法判定**，两者都算 FAIL。
 *
 * 变异运行的结果是**三态**，措辞刻意不同：
 *   DETECTED  护栏因该回归变红（有 PASS/FAIL 摘要，退出码非 0，FAIL > 0）——期望结果
 *   MISSED    护栏跑完了但没红（有摘要，退出码 0 或 FAIL 0）——「对该回归不敏感」
 *   CRASHED   子进程没有任何 PASS/FAIL 摘要（加载期崩溃 / 锚点未命中 / 超时）——「无法判定」
 *   另有 M0 零变异对照：同样的接线、零变异，必须逐字复现基线判定，否则接线本身不可信。
 *   CRASHED 与 MISSED 绝不能混为一谈：前者是「我们什么都不知道」，把它说成后者是静默减少覆盖。
 *
 * 已知限制（脚本会在输出里显式标注，不得当成等价）：
 *   - D31：FSA / OPFS 没有 realpath 可用，浏览器端**无法**做链接越界校验，只能文档化。
 *   - D12：P1 硬门禁，只约束 OPFS 页面内桥，不阻塞 P0。
 *   - 本机无法创建文件级符号链接（Windows 需开发者模式/管理员），ipc-safety-check 的两条
 *     文件符号链接用例会是 SKIP；目录 junction 用例正常执行。
 */

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const REPO_ROOT = path.resolve(__dirname, '..')
const VERBOSE = process.argv.includes('--verbose')
const FULL = process.argv.includes('--full')
const NO_MUTANTS = process.argv.includes('--no-mutants')
const KEEP = process.argv.includes('--keep')
/** 自检：故意让变异 harness 在加载阶段崩溃，验证「崩溃」不会被误判成 MISSED。 */
const SELF_TEST = process.argv.includes('--self-test')

const IPC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'ipc-safety-check.cjs')
const MAIN_PATH = path.join(REPO_ROOT, 'electron', 'main.cjs')
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const EVIDENCE_DOC = path.join(REPO_ROOT, 'docs', 'verify', 'A0-缺陷门禁-作者证据.md')

/** 变异 harness 的接线锚点：必须逐字存在于 ipc-safety-check.cjs。 */
const IPC_REPO_ROOT_ANCHOR = "const REPO_ROOT = path.resolve(__dirname, '..')"

/** 默认只跑与本线 6 条缺陷相关的用例文件（确定性）；`--full` 时跑全量。 */
const DEFECT_TEST_FILES = [
  'src/fs/paths.gate.test.ts',
  'src/fs/handleBackend.gate.test.ts',
  'src/fs/opfs.gate.test.ts',
  'src/fs/opfs.test.ts',
  'src/fs/handleBackend.test.ts',
  'src/data/library.regression.test.ts',
  'src/data/library.watch.test.ts',
]

let passCount = 0
let failCount = 0
const failures = []
const warns = []
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-gate-'))

function section(title) {
  console.log(`\n── ${title} ──`)
}

function check(name, fn) {
  try {
    const detail = fn()
    passCount += 1
    console.log(`  PASS ${name}${detail ? ` — ${detail}` : ''}`)
  } catch (error) {
    failCount += 1
    failures.push(`${name}: ${error && error.message}`)
    console.log(`  FAIL ${name} — ${error && error.message}`)
  }
}

function warn(text) {
  warns.push(text)
  console.log(`  WARN ${text}`)
}

function read(relPath) {
  const full = path.join(REPO_ROOT, relPath)
  assert.ok(fs.existsSync(full), `文件不存在：${relPath}`)
  return fs.readFileSync(full, 'utf8')
}

function countOf(text, pattern) {
  const matches = text.match(pattern)
  return matches ? matches.length : 0
}

/** 跑 `scripts/ipc-safety-check.cjs`（可指向一个变异的 main.cjs 副本）。 */
/**
 * 把变异注入**编译期**：`Module.prototype._compile` 在 main.cjs 被 require 的那一刻改它的源码。
 *
 * 为什么不再「复制 main.cjs 到临时目录再改」：CJS 的相对 require 是按**文件真实路径**解析的。
 * main.cjs 现在有 `require('./deeplink.cjs')`（0.3.1 的单实例锁 / 协议注册），副本一旦离开
 * `electron/`，这条 require 立刻 `MODULE_NOT_FOUND`，harness 在**加载阶段**就崩：
 * 退出码 1、但没有任何 `PASS/FAIL` 行。这正是 0.3.1 上 M1/M2/M3 被误判成 MISSED 的原因
 * （2026-09-29 实测，见 docs/verify/A0-缺陷门禁-作者证据.md §3.1）。
 *
 * 编译期注入让 main.cjs 始终从它自己的目录加载，`__dirname`、`require('./x.cjs')`、
 * `path.join(__dirname, 'preload.cjs')` 全部保持真实——不再有任何路径漂移。
 */
function buildRunner(id, mutations) {
  const original = fs.readFileSync(IPC_SCRIPT, 'utf8')
  assert.ok(original.includes(IPC_REPO_ROOT_ANCHOR), `ipc-safety-check.cjs 锚点漂移（找不到 ${IPC_REPO_ROOT_ANCHOR}）`)
  let source = original.replace(IPC_REPO_ROOT_ANCHOR, `const REPO_ROOT = ${JSON.stringify(REPO_ROOT)}`)
  if (mutations.length > 0) {
    source = source.replace("'use strict'", `'use strict'\n${compileHook(mutations)}`)
    assert.ok(source.includes('installGateMutationHook'), '变异钩子未能注入 runner 副本（接线断了）')
  }
  const runner = path.join(tmpRoot, `ipc-check-${id}.cjs`)
  fs.writeFileSync(runner, source, 'utf8')
  return runner
}

/**
 * 注入到 runner 副本里的编译钩子源码。
 * - 锚点未命中 → **抛错**（绝不静默放行未变异的 main.cjs）；
 * - 每次真正改写了 main.cjs 就打印 `[gate-mutation] applied …`（**正向证据**：
 *   证明变异确实落地了，而不是「跑了原始代码、恰好没红」）。
 */
function compileHook(mutations) {
  return `
;(function installGateMutationHook() {
  const Module = require('node:module')
  const fsMod = require('node:fs')
  const pathMod = require('node:path')
  const MUTATIONS = ${JSON.stringify(mutations)}
  const TARGET = pathMod.resolve(${JSON.stringify(MAIN_PATH)})
  const originalCompile = Module.prototype._compile
  Module.prototype._compile = function (content, filename) {
    if (pathMod.resolve(String(filename)) !== TARGET) return originalCompile.call(this, content, filename)
    let text = String(content)
    for (const item of MUTATIONS) {
      if (!text.includes(item.anchor)) throw new Error('gate-mutation-anchor-missing: ' + item.id)
      text = text.replace(item.anchor, item.mutated)
    }
    console.log('[gate-mutation] applied ' + MUTATIONS.map((item) => item.id).join(',') + ' to ' + pathMod.basename(String(filename)))
    return originalCompile.call(this, text, filename)
  }
})()
`
}

function runIpcCheck(options = {}) {
  const script = options.mutations ? buildRunner(options.id, options.mutations) : IPC_SCRIPT
  const started = Date.now()
  const result = spawnSync(process.execPath, [script, '--verbose'], {
    cwd: REPO_ROOT,
    env: { ...process.env },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  })
  const stdout = `${result.stdout || ''}${result.stderr || ''}`
  return { code: result.status, stdout, ms: Date.now() - started }
}

const VERDICT_RE = /PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/
/** 变异的正向证据：钩子真的改写 main.cjs 时才会打印这一行。 */
const MUTATION_APPLIED_RE = /\[gate-mutation\] applied /

/**
 * 判定一次子进程运行的结果。**四态，崩溃与「没生效」都不许降级成 MISSED。**
 *
 * 「护栏没红」「护栏根本没跑起来」「护栏跑了但变异压根没注进去」在输出上长得几乎一样，
 * 但含义天差地别：只有第一种是「确认对该回归不敏感」。把后两种说成 MISSED 是
 * 「静默减少覆盖」——比直接报错更容易骗过 reviewer。
 */
function classifyRun(run, options = {}) {
  const verdict = VERDICT_RE.exec(run.stdout)
  const applied = MUTATION_APPLIED_RE.test(run.stdout)
  if (!verdict) {
    return { status: 'CRASHED', pass: null, fail: null, skip: null, applied, reason: errorLineOf(run.stdout) }
  }
  const result = {
    status: 'VERDICT',
    pass: Number(verdict[1]),
    fail: Number(verdict[2]),
    skip: Number(verdict[3]),
    applied,
  }
  if (options.expectMutation && !applied) {
    result.status = 'NO_EFFECT'
    result.reason = '变异从未被应用到 main.cjs（runner 接线断了，跑的是未变异代码）——这次运行没有证明力'
  }
  return result
}

/** 从崩溃输出里挑一行最能说明原因的（自测脚本自身异常 / MODULE_NOT_FOUND / 锚点未命中 …）。 */
function errorLineOf(stdout) {
  const lines = String(stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const hit = lines.find((line) =>
    /自测脚本自身异常|Cannot find module|gate-mutation-anchor-missing|MODULE_NOT_FOUND|Error:/.test(line),
  )
  return hit || lines[lines.length - 1] || '子进程无任何输出'
}

/** 解析 ipc-safety-check 的 PASS/FAIL/SKIP 与 `── 分组 ──`。 */
function parseIpcOutput(text) {
  const sections = new Map()
  let current = null
  for (const raw of text.split(/\r?\n/)) {
    const head = /^── (.+) ──$/.exec(raw)
    if (head) {
      current = { pass: [], fail: [], skip: [] }
      sections.set(head[1], current)
      continue
    }
    const item = /^ {2}(PASS|FAIL|SKIP) (.+?)(?: — (.*))?$/.exec(raw)
    if (item && current) current[item[1].toLowerCase()].push(item[2])
  }
  const summary = /PASS (\d+) \/ FAIL (\d+) \/ SKIP (\d+)/.exec(text)
  return { sections, summary }
}

/** 跑 vitest 并读回 `--reporter=json` 的结果。 */
function runVitest(files) {
  const outFile = path.join(tmpRoot, 'vitest-report.json')
  const args = [VITEST_BIN, 'run', ...files, '--reporter=json', `--outputFile=${outFile}`]
  const started = Date.now()
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000,
  })
  const stdout = `${result.stdout || ''}${result.stderr || ''}`
  assert.ok(fs.existsSync(outFile), `vitest 未产出 JSON 报告（退出码 ${result.status}）：\n${stdout.slice(-2000)}`)
  const report = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const tests = []
  for (const fileResult of report.testResults || []) {
    const file = path.relative(REPO_ROOT, fileResult.name).replace(/\\/g, '/')
    for (const assertion of fileResult.assertionResults || []) {
      tests.push({ file, fullName: assertion.fullName, status: assertion.status })
    }
  }
  return { code: result.status, stdout, ms: Date.now() - started, report, tests }
}

/** 强制要求「某文件里以 prefix 开头的一组用例」存在且全部 passed。 */
function requireGroup(scope, label, file, prefix, min) {
  const matched = scope.tests.filter((item) => item.file === file && item.fullName.startsWith(prefix))
  assert.ok(matched.length >= min, `${label}：${file} 里「${prefix}*」应至少 ${min} 个用例，实际 ${matched.length}`)
  const bad = matched.filter((item) => item.status !== 'passed')
  assert.equal(bad.length, 0, `${label}：未全绿 → ${bad.map((item) => `${item.fullName}[${item.status}]`).join('；')}`)
  return matched.length
}

// ---------------------------------------------------------------------------
// 变异灵敏度：把「修复前」的写法注回 main.cjs 副本，护栏必须变红
// ---------------------------------------------------------------------------

const MUTANTS = [
  {
    id: 'M1',
    defect: 'D20',
    label: '删掉 requireAuthorizedRoot 的授权判定（回到 D20 修复前）',
    anchor: "if (!normalized || !isAuthorizedRoot(normalized)) throw new Error('未授权的工作区目录')",
    mutated: "if (!normalized) throw new Error('未授权的工作区目录')",
    expectFailure: /未授权的工作区目录/,
  },
  {
    id: 'M2',
    defect: 'D29',
    label: '把 remove 的根目录判定退回「只比空串」（回到 D29 修复前）',
    anchor: "if (pathIdentity(target) === pathIdentity(safeRoot)) throw new Error('不能删除笔记本根目录')",
    mutated: "if (target === '') throw new Error('不能删除笔记本根目录')",
    expectFailure: /remove\(root, "\."/,
  },
  {
    id: 'M3',
    defect: 'D31',
    label: '把 assertRealPathInsideRoot 变成空操作（回到 D31 修复前）',
    anchor: 'async function assertRealPathInsideRoot(rootResolved, checkTarget) {\n',
    mutated: 'async function assertRealPathInsideRoot(rootResolved, checkTarget) {\n  return\n',
    expectFailure: /junction/,
  },
]

/** 零变异对照：用**与变异完全相同的接线**跑一遍，结果必须与基线逐字一致。
 * 它是「变异接线可用」的证据——接线一坏，后面三行 MISSED 全是假象。
 */
const IDENTITY_SPEC = { id: 'M0', label: '零变异对照（同样的接线，必须逐字复现基线判定）', mutations: [] }

/**
 * `--self-test` 用的合成变异：只把 main.cjs 的**兄弟模块 require** 打断。
 * 它复刻的正是 0.3.1 上真实发生过的失败形态——harness 在加载阶段崩溃、
 * 退出码 1、却没有任何 PASS/FAIL 行。用来证明这种形态会被判成 CRASHED 而不是 MISSED。
 */
const SELF_TEST_MUTANT = {
  id: 'X1',
  defect: 'self-test',
  label: '故意打断 main.cjs 的兄弟模块 require',
  anchor: "require('./deeplink.cjs')",
  mutated: "require('./__gate_self_test_missing__.cjs')",
  expectFailure: /这个正则永远不会命中/,
}

/** 变异锚点必须先在真实源码里命中一次，避免「锚点漂移 → 静默跑了个未变异的 main.cjs」。 */
function assertAnchorsPresent() {
  const source = read('electron/main.cjs')
  for (const mutant of MUTANTS) {
    assert.ok(
      source.includes(mutant.anchor),
      `${mutant.id} 锚点未命中（源码漂移），无法构造变异：${mutant.anchor.split('\n')[0]}`,
    )
  }
  return `${MUTANTS.length} 个锚点全部命中`
}

/**
 * 把一次变异结果转成「通过详情」或抛出明确错误。
 * **崩溃与「不敏感」必须措辞不同**：前者是「我们什么都不知道」，后者是「确认检不出来」。
 */
function describeMutantVerdict(id, item) {
  assert.ok(item, `${id} 未执行`)
  if (item.status === 'CRASHED') {
    throw new Error(
      `变异 harness 崩溃：**无法判定**是否检出（不是「护栏对该回归不敏感」）— ${item.reason}` +
        `（退出码 ${item.run.code}，无 PASS/FAIL 摘要）`,
    )
  }
  if (item.status === 'NO_EFFECT') {
    throw new Error(
      `变异从未被应用：**无法判定**是否检出（不是「护栏对该回归不敏感」）— ${item.reason}` +
        `（退出码 ${item.run.code}，FAIL ${item.fail} 是未变异代码的结果）`,
    )
  }
  if (item.status !== 'DETECTED') {
    throw new Error(
      `${id} 未被护栏检测到（退出码 ${item.run.code}，FAIL ${item.fail}）——护栏对该回归不敏感`,
    )
  }
  return `退出码 ${item.run.code}，FAIL ${item.fail}`
}

/**
 * `--self-test`：故意让变异 harness 在**加载阶段**崩溃（把 main.cjs 的兄弟模块 require 打断），
 * 验证三件事：① 判定为 CRASHED 而不是 MISSED；② 报错措辞写明「无法判定」；
 * ③ 零变异对照仍然可用。这是对「静默减少覆盖」这条守卫的自证。
 */
function selfTest() {
  console.log('gate-defects --self-test：验证「harness 崩溃」不会被降级成 MISSED')
  console.log(`node=${process.version} platform=${process.platform} 临时目录：${tmpRoot}${KEEP ? '（--keep）' : ''}`)

  section('对照 1/3：零变异对照必须可用（接线自检的正常路径）')
  const identityRun = runIpcCheck({ id: 'M0', mutations: [] })
  fs.writeFileSync(path.join(tmpRoot, 'M0.log'), identityRun.stdout, 'utf8')
  const identityVerdict = classifyRun(identityRun)
  console.log(
    `  ${identityVerdict.status === 'VERDICT' ? 'WIRING  ' : 'CRASHED '} M0 零变异对照 — ` +
      (identityVerdict.status === 'VERDICT'
        ? `PASS ${identityVerdict.pass} / FAIL ${identityVerdict.fail} / SKIP ${identityVerdict.skip}，退出码 ${identityRun.code}`
        : `无摘要，退出码 ${identityRun.code}：${identityVerdict.reason}`),
  )
  check('零变异对照可用（status=VERDICT 且退出码 0）', () => {
    assert.equal(identityVerdict.status, 'VERDICT', `对照本身崩溃：${identityVerdict.reason}`)
    assert.equal(identityRun.code, 0, `对照退出码应为 0，实际 ${identityRun.code}`)
    return `PASS ${identityVerdict.pass} / FAIL ${identityVerdict.fail}`
  })

  section('对照 2/3：故意打断兄弟模块 require，必须判 CRASHED 并写明「无法判定」')
  const broken = { ...SELF_TEST_MUTANT, status: classifyRun({ stdout: '' }).status }
  const brokenRun = runIpcCheck({ id: SELF_TEST_MUTANT.id, mutations: [SELF_TEST_MUTANT] })
  fs.writeFileSync(path.join(tmpRoot, `${SELF_TEST_MUTANT.id}.log`), brokenRun.stdout, 'utf8')
  const brokenVerdict = classifyRun(brokenRun)
  const brokenItem = { ...broken, run: brokenRun, status: brokenVerdict.status, reason: brokenVerdict.reason }
  console.log(
    `  ${brokenVerdict.status.padEnd(8)} ${SELF_TEST_MUTANT.id}（故意打断 require）— ` +
      `退出码 ${brokenRun.code}：${brokenVerdict.reason}`,
  )

  let thrown = ''
  try {
    describeMutantVerdict(SELF_TEST_MUTANT.id, brokenItem)
  } catch (error) {
    thrown = error.message
  }

  check('崩溃被判定为 CRASHED（而不是 VERDICT/MISSED）', () => {
    assert.equal(brokenVerdict.status, 'CRASHED', `期望 CRASHED，实际 ${brokenVerdict.status}`)
    assert.notEqual(brokenRun.code, 0, '故意打断的 harness 应以非 0 退出')
    return `退出码 ${brokenRun.code}`
  })
  check('报错措辞写明「无法判定」，且**不**使用 MISSED 的说法', () => {
    assert.ok(thrown, 'describeMutantVerdict 竟然没有抛错——崩溃被当成了通过')
    assert.match(thrown, /harness 崩溃/, `措辞缺少「harness 崩溃」：${thrown}`)
    assert.match(thrown, /无法判定/, `措辞缺少「无法判定」：${thrown}`)
    assert.doesNotMatch(thrown, /未被护栏检测到/, `崩溃被误写成 MISSED：${thrown}`)
    return thrown.slice(0, 120)
  })

  section('对照 3/3：声明了变异却零注入（跑的是未变异代码）→ 必须判 NO_EFFECT，不能算 MISSED')
  // 这正是 2026-09-29 真实踩到的坑：runOne 传了 spec.mutations（undefined），
  // runIpcCheck 于是回落到未变异的 IPC_SCRIPT，三次变异全部「退出码 0 / FAIL 0」。
  // M0 零变异对照**发现不了**它（接线本身是对的），只有「变异是否真的落地」的正向证据能发现。
  const noEffectRun = runIpcCheck({ id: 'X2', mutations: [] })
  fs.writeFileSync(path.join(tmpRoot, 'X2.log'), noEffectRun.stdout, 'utf8')
  const noEffectVerdict = classifyRun(noEffectRun, { expectMutation: true })
  const noEffectItem = {
    ...SELF_TEST_MUTANT,
    id: 'X2',
    run: noEffectRun,
    status: noEffectVerdict.status,
    reason: noEffectVerdict.reason,
    fail: noEffectVerdict.fail,
  }
  console.log(
    `  ${noEffectVerdict.status.padEnd(8)} X2（声明变异、零注入）— 退出码 ${noEffectRun.code}，` +
      `FAIL ${noEffectVerdict.fail}：${noEffectVerdict.reason}`,
  )

  let noEffectThrown = ''
  try {
    describeMutantVerdict('X2', noEffectItem)
  } catch (error) {
    noEffectThrown = error.message
  }

  check('零注入被判定为 NO_EFFECT（而不是 MISSED / VERDICT）', () => {
    assert.equal(noEffectVerdict.status, 'NO_EFFECT', `期望 NO_EFFECT，实际 ${noEffectVerdict.status}`)
    assert.equal(noEffectRun.code, 0, '零注入的运行本身应当是绿的（这正是它危险的地方）')
    return `退出码 ${noEffectRun.code}，FAIL ${noEffectVerdict.fail}`
  })
  check('零注入的报错写成「变异从未被应用」，且**不**使用 MISSED 的说法', () => {
    assert.ok(noEffectThrown, 'describeMutantVerdict 没有抛错——零注入被当成了通过')
    assert.match(noEffectThrown, /变异从未被应用/, `措辞缺少「变异从未被应用」：${noEffectThrown}`)
    assert.doesNotMatch(noEffectThrown, /未被护栏检测到/, `零注入被误写成 MISSED：${noEffectThrown}`)
    return noEffectThrown.slice(0, 120)
  })

  console.log(`\nPASS ${passCount} / FAIL ${failCount}`)
  if (failCount > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  if (!KEEP) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* 清理失败无妨 */
    }
  } else {
    console.log(`\n临时目录保留在：${tmpRoot}`)
  }
  if (failCount > 0) process.exitCode = 1
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

function main() {
  console.log('Opennote A 线缺陷门禁（D20 / D29 / D31 / D03 / D08 / D12）')
  console.log(`node=${process.version} platform=${process.platform} cwd=${process.cwd()}`)
  const gitHead = spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' })
  const gitStatus = spawnSync('git', ['status', '--porcelain'], { cwd: REPO_ROOT, encoding: 'utf8' })
  console.log(`git HEAD=${(gitHead.stdout || '').trim() || '(未知)'}`)
  console.log(`未跟踪/已修改：\n${(gitStatus.stdout || '(空)').trimEnd() || '(空)'}`)
  console.log(`临时目录：${tmpRoot}${KEEP ? '（--keep：不清理）' : ''}`)

  // ------------------------------------------------------------- 证据来源 1
  section('证据来源 1/2：node scripts/ipc-safety-check.cjs --verbose（真实 electron/main.cjs + stub electron）')
  const ipc = runIpcCheck({})
  const parsed = parseIpcOutput(ipc.stdout)
  const ipcSummary = parsed.summary ? parsed.summary[0] : '未解析到摘要'
  console.log(`  → 退出码 ${ipc.code}｜${ipcSummary}｜用时 ${(ipc.ms / 1000).toFixed(1)}s`)
  if (VERBOSE) console.log(ipc.stdout.trimEnd().split('\n').map((line) => `  | ${line}`).join('\n'))

  // ------------------------------------------------------------- 证据来源 2
  section(`证据来源 2/2：vitest run ${FULL ? '（全量）' : `（${DEFECT_TEST_FILES.length} 个相关文件）`}`)
  const suite = runVitest(FULL ? [] : DEFECT_TEST_FILES)
  const report = suite.report
  const failedFiles = (report.testResults || []).filter((item) => item.status === 'failed').length
  console.log(
    `  → 退出码 ${suite.code}｜文件 ${(report.testResults || []).length}（未通过 ${failedFiles}）` +
      `｜用例 ${report.numPassedTests} passed / ${report.numFailedTests} failed / ${report.numPendingTests} skipped` +
      `｜用时 ${(suite.ms / 1000).toFixed(1)}s`,
  )
  if (VERBOSE) console.log(suite.stdout.trimEnd().split('\n').map((line) => `  | ${line}`).join('\n'))

  // ------------------------------------------------------------ 变异灵敏度
  const baselinePass = parsed.summary ? Number(parsed.summary[1]) : null
  const baselineFail = parsed.summary ? Number(parsed.summary[2]) : null
  let mutants = []
  let identity = null
  if (NO_MUTANTS) {
    warn('已跳过变异灵敏度检查（--no-mutants）：本次不含「护栏对回归敏感」的证据')
  } else {
    section('变异灵敏度：编译期把「修复前」的写法注回 main.cjs，护栏必须变红')

    /** 跑一次变异/对照并给出四态判定。 */
    const runOne = (spec) => {
      // MUTANTS 用 anchor/mutated 描述变异；编译钩子要的是 [{id, anchor, mutated}]
      const mutations = spec.mutations ?? [{ id: spec.id, anchor: spec.anchor, mutated: spec.mutated }]
      const run = runIpcCheck({ id: spec.id, mutations })
      // 原始输出留档，供人工核对「护栏确实因为该回归变红」/「harness 为什么崩」
      fs.writeFileSync(path.join(tmpRoot, `${spec.id}.log`), run.stdout, 'utf8')
      const classified = classifyRun(run, { expectMutation: mutations.length > 0 })
      const parsedRun = parseIpcOutput(run.stdout)
      let status = classified.status
      // 只有**真的注入了变异**的运行才谈「检出/未检出」；M0 零变异对照保持原始 VERDICT 态，
      // 它的判据是「与基线逐字一致」，不是「有没有变红」。
      if (status === 'VERDICT' && mutations.length > 0) {
        const detected =
          run.code !== 0 && classified.fail > 0 && Boolean(spec.expectFailure) && spec.expectFailure.test(run.stdout)
        status = detected ? 'DETECTED' : 'MISSED'
      }
      // 注意顺序：classified.status 是「跑完后的原始态」，必须放在后面用最终态覆盖它，
      // 否则 DETECTED / MISSED 会被刚算出来的 VERDICT 覆盖掉。
      return { ...spec, run, parsed: parsedRun, ...classified, status }
    }

    // 先跑零变异对照：它坏了就没有任何结论可信
    identity = runOne(IDENTITY_SPEC)
    const identityLine =
      identity.status === 'VERDICT'
        ? `PASS ${identity.pass} / FAIL ${identity.fail} / SKIP ${identity.skip}` +
          `（基线 PASS ${baselinePass} / FAIL ${baselineFail}）`
        : `无 PASS/FAIL 摘要或接线异常，status=${identity.status}，退出码 ${identity.run.code}` +
          `${identity.reason ? `：${identity.reason}` : ''}`
    console.log(`  ${identity.status === 'VERDICT' ? 'WIRING  ' : 'BROKEN '} M0 零变异对照 — ${identityLine}`)

    const wiringOk =
      identity.status === 'VERDICT' &&
      identity.run.code === 0 &&
      identity.pass === baselinePass &&
      identity.fail === baselineFail

    if (!wiringOk) {
      // 接线不可用：其余变异运行**不再执行**，全部按「崩溃 / 无法判定」上报，绝不报 MISSED
      console.log('  → 变异接线对照失败，M1/M2/M3 不再执行（无法判定是否检出）')
      mutants = MUTANTS.map((mutant) => ({
        ...mutant,
        run: { code: null, stdout: '' },
        status: 'CRASHED',
        reason: '变异接线对照（M0）已失败，未执行本次变异',
        parsed: { sections: new Map(), summary: null },
      }))
    } else {
      mutants = MUTANTS.map((mutant) => {
        const item = runOne(mutant)
        const tail =
          item.status === 'CRASHED'
            ? `无 PASS/FAIL 摘要（harness 崩溃），退出码 ${item.run.code}：${item.reason}`
            : item.status === 'NO_EFFECT'
              ? `变异未生效，退出码 ${item.run.code}，FAIL ${item.fail}：${item.reason}`
              : `退出码 ${item.run.code}，FAIL ${item.fail}（变异已应用于 main.cjs）`
        console.log(`  ${item.status.padEnd(8)} ${item.id} ${item.defect}：${mutant.label}（${tail}）`)
        if (VERBOSE && item.status !== 'CRASHED') {
          for (const [title, group] of item.parsed.sections.entries()) {
            for (const name of group.fail) console.log(`      ${title} › ${name}`)
          }
        }
        return item
      })
    }

    const inconclusive = mutants.filter((item) => item.status === 'CRASHED' || item.status === 'NO_EFFECT')
    if (inconclusive.length > 0) {
      warn(
        `有 ${inconclusive.length} 个变异运行**没有产出可信判定**（harness 崩溃 / 变异未生效）——` +
          '这不是「检不出来」，而是「无法判定」，已按 FAIL 上报；原始输出留档于临时目录 <id>.log',
      )
    }
  }

  const mutant = (id) => mutants.find((item) => item.id === id)
  /** 变异检查的断言：崩溃一律是 FAIL，措辞必须与 MISSED 区分开。 */
  const assertMutantDetected = (id) => {
    if (NO_MUTANTS) return '已跳过（--no-mutants）'
    return describeMutantVerdict(id, mutant(id))
  }

  check('变异锚点全部命中真实 main.cjs（防「锚点漂移 → 静默跑未变异的代码」）', () => assertAnchorsPresent())
  check('变异接线对照（M0：零变异必须逐字复现基线；崩溃即接线不可用，不是 MISSED）', () => {
    if (NO_MUTANTS) return '已跳过（--no-mutants）'
    assert.ok(identity, 'M0 未执行')
    if (identity.status === 'CRASHED') {
      throw new Error(
        `变异 harness 崩溃：**无法判定**任何变异结果（这次不是「检不出来」）— ${identity.reason}` +
          `（退出码 ${identity.run.code}，无 PASS/FAIL 摘要）`,
      )
    }
    assert.equal(identity.run.code, 0, `M0 对照退出码应为 0，实际 ${identity.run.code}`)
    assert.equal(
      identity.pass,
      baselinePass,
      `M0 对照 PASS 数 ${identity.pass} 与基线 ${baselinePass} 不一致——变异接线改变了 harness 行为`,
    )
    assert.equal(identity.fail, baselineFail, `M0 对照 FAIL 数 ${identity.fail} 与基线 ${baselineFail} 不一致`)
    return `PASS ${identity.pass} / FAIL ${identity.fail} / SKIP ${identity.skip}，与基线逐字一致`
  })

  /** ipc-safety-check 的分组断言。 */
  const requireSection = (title, minPass, options = {}) => {
    const group = parsed.sections.get(title)
    assert.ok(group, `未找到分组「${title}」（ipc-safety-check 输出结构变了？）`)
    assert.equal(group.fail.length, 0, `${title}：有 FAIL → ${group.fail.join('；')}`)
    assert.ok(
      group.pass.length >= minPass,
      `${title}：应至少 ${minPass} 项 PASS，实际 ${group.pass.length}（SKIP ${group.skip.length}）`,
    )
    const extraSkip = options.expectSkip === undefined ? 0 : Math.abs(group.skip.length - options.expectSkip)
    if (options.expectSkip !== undefined && extraSkip !== 0) {
      warn(`${title}：SKIP 数量 ${group.skip.length} 与预期 ${options.expectSkip} 不一致 → ${group.skip.join('；')}`)
    }
    return `${group.pass.length} PASS / ${group.skip.length} SKIP`
  }

  // --------------------------------------------------------------------- D20
  section('D20 越界写 / 授权根白名单（P0）')
  check('静态：fs:* 全部经单一入口 safePath()（授权 → 词法 → realpath）', () => {
    const main = read('electron/main.cjs')
    const calls = countOf(main, /await safePath\(/g)
    assert.ok(calls >= 10, `safePath() 调用点应 ≥10（10 个 fs handler），实际 ${calls}`)
    for (const symbol of [
      'const authorizedRoots = new Set()',
      'const persistentRoots = new Set()',
      'function requireAuthorizedRoot(',
      'function normalizeAbsolutePath(',
      'function isAuthorizedRoot(',
    ]) {
      assert.ok(main.includes(symbol), `缺少授权白名单符号：${symbol}`)
    }
    return `${calls} 个调用点 + 授权集合三件套`
  })
  check('静态：saveFile 旁路已封堵（只认本次 pickSaveFile 返回过的绝对路径）', () => {
    const main = read('electron/main.cjs')
    assert.ok(main.includes('const saveTargets = new Set()'), '缺少 saveTargets 集合')
    assert.ok(main.includes('if (!saveTargets.has(pathIdentity(target))) throw new Error('), 'saveFile 未做路径门控')
    assert.ok(/未授权的保存位置/.test(main), '缺少「未授权的保存位置」拒绝文案')
    return 'saveTargets 门控在位'
  })
  check('行为：未授权 root 的 10 个 fs handler 全部拒绝且不落盘', () =>
    requireSection('D20 未授权 root：fs:* 全部拒绝', 5))
  check('行为：pickFolder 授权正路可用，authorizeRoot 不是任意路径后门', () =>
    requireSection('D20 正路：pickFolder 授权 + authorizeRoot', 5))
  check('行为：saveFile 旁路封堵（未 pick 的绝对路径写不进去）', () => requireSection('D20 saveFile 旁路封堵', 3))
  check('行为：相对路径穿越防护未削弱（回归）', () => requireSection('相对路径穿越防护未削弱（回归）', 3))
  check('变异：注回「无授权判定」的 main.cjs 后护栏变红', () => assertMutantDetected('M1'))

  // --------------------------------------------------------------------- D29
  section('D29 路径归一化与校验（P0）')
  check('静态：remove 比较归一化后的绝对路径，而不是 relPath 字面量', () => {
    const main = read('electron/main.cjs')
    assert.ok(
      main.includes("if (pathIdentity(target) === pathIdentity(safeRoot)) throw new Error('不能删除笔记本根目录')"),
      '缺少「解析后路径 === root 即拒」的判定',
    )
    assert.ok(
      !/if \(relPath === '' \|\| relPath === undefined/.test(main),
      '不得退回「只比空串」的旧守卫（D29 根因）',
    )
    return "pathIdentity(target) === pathIdentity(safeRoot)"
  })
  check('行为：桌面端 "." / "./" / ".//" / ".\\" / "././" / "" 等写法全部拒绝', () =>
    requireSection('D29 remove 的 "." 等归一化写法不能删根目录', 2))
  check('根因复现（Node 语义，实测）：relPath="." 解析后就是 root，被放行到 rm() 即删掉整个工作区', () => {
    const dir = path.join(tmpRoot, 'd29-root-cause')
    fs.mkdirSync(path.join(dir, '日记'), { recursive: true })
    fs.writeFileSync(path.join(dir, '日记', '九月.md'), '# 九月', 'utf8')
    // 修复前 main.cjs 的守卫 `if (relPath === '' || …)` 放行 '.'，随后执行的是这一行：
    assert.equal(path.resolve(dir, '.'), dir, 'path.resolve(root, ".") 必须等于 root 本身')
    fs.rmSync(path.resolve(dir, '.'), { recursive: true, force: true })
    assert.equal(fs.existsSync(dir), false, '被放行后 rm() 确实删掉了整个工作区')
    return 'path.resolve(root, ".") === root → rm 递归删除整个工作区'
  })
  check('行为：渲染层归一化原语（paths.gate.test.ts）', () =>
    `${requireGroup(suite, 'D29 归一化', 'src/fs/paths.gate.test.ts', "D29 路径归一化：根目录写法必须收敛成 '' ", 4)} 个用例全绿`)
  check('行为：浏览器后端等价面（handleBackend.gate.test.ts）', () =>
    `${requireGroup(suite, 'D29 后端等价面', 'src/fs/handleBackend.gate.test.ts', 'D29 浏览器后端等价面：根目录写法一律不能删 / 不能动 ', 4)} 个用例全绿`)
  check('变异：注回「只比空串」的守卫后护栏变红', () => assertMutantDetected('M2'))

  // --------------------------------------------------------------------- D31
  section('D31 junction / 符号链接越界（P1；浏览器端为已知限制）')
  check('静态：全部 fs handler 走 realpath 越界校验（target / parent / write 三模式）', () => {
    const main = read('electron/main.cjs')
    for (const symbol of [
      'async function realpathForCheck(',
      'async function assertRealPathInsideRoot(',
      'function isInsideOrEqual(',
      'await assertRealPathInsideRoot(safeRoot, path.dirname(target))',
      'await assertRealPathInsideRoot(safeRoot, target)',
    ]) {
      assert.ok(main.includes(symbol), `缺少 realpath 越界校验符号：${symbol}`)
    }
    return '写入路径同时校验父目录与目标自身'
  })
  check('行为：junction 读 / 写 / list / stat / exists / remove 全部被拒', () =>
    requireSection('D31 junction / 符号链接越界', 7, { expectSkip: 2 }))
  check('行为：绝对路径 / UNC / NUL 等 8 种写法全部拒绝', () => requireSection('相对路径穿越防护未削弱（回归）', 3))
  check('已知限制：浏览器后端没有 realpath 可用，只能文档化（不声称等价）', () => {
    for (const file of ['src/fs/handleBackend.ts', 'src/fs/opfs.ts']) {
      assert.ok(!/realpath/i.test(read(file)), `${file} 不应出现 realpath——浏览器端做不到，不能假装做到`)
    }
    const doc = read('docs/verify/A0-缺陷门禁-作者证据.md')
    assert.ok(/realpath/.test(doc), 'A0 证据文档必须写明 realpath 限制')
    assert.ok(/已知限制/.test(doc), 'A0 证据文档必须明确标注「已知限制」')
    return '浏览器端限制已在 A0 证据文档中登记'
  })
  check('行为：静态取证（handleBackend.gate.test.ts）', () =>
    `${requireGroup(suite, 'D31 限制取证', 'src/fs/handleBackend.gate.test.ts', 'D31 已知限制取证：浏览器后端里不存在 realpath 等价调用 ', 2)} 个用例全绿`)
  check('行为：词法边界（paths.gate.test.ts：链接名与普通目录名在词法上不可区分）', () =>
    `${requireGroup(suite, 'D31 词法边界', 'src/fs/paths.gate.test.ts', 'D31 边界（characterization）：词法校验挡不住链接 ', 1)} 个用例全绿`)
  check('变异：把 assertRealPathInsideRoot 变成空操作后护栏变红', () => assertMutantDetected('M3'))
  const junctionSection = parsed.sections.get('D31 junction / 符号链接越界')
  if (junctionSection && junctionSection.skip.length > 0) {
    warn(`D31 有 ${junctionSection.skip.length} 项 SKIP（本机无法创建文件级符号链接）：${junctionSection.skip.join('；')}`)
  }

  // --------------------------------------------------------------------- D03
  section('D03 落点不预检磁盘同名（P0）')
  check('静态：落点统一走 resolveAvailablePath()（后端 exists() 复核），不是只查内存', () => {
    const lib = read('src/data/library.ts')
    assert.ok(lib.includes('export async function resolveAvailablePath('), '缺少 resolveAvailablePath')
    assert.ok(/while \(\(await target\.exists\(candidate\)\)/.test(lib), 'resolveAvailablePath 必须用后端 exists() 复核')
    const uses = countOf(lib, /resolveAvailablePath\(/g)
    assert.ok(uses >= 8, `resolveAvailablePath 调用点应 ≥8（新建/重命名/移动/回收站/导入/文件夹），实际 ${uses}`)
    return `出现 ${uses} 次（定义 + 调用）`
  })
  check('静态：新建笔记有落点预检门（createGuards 门 + preflightCreateNote）', () => {
    const lib = read('src/data/library.ts')
    assert.ok(lib.includes('function preflightCreateNote('), '缺少 preflightCreateNote')
    assert.ok(lib.includes('const createGuards = new Map'), '缺少 createGuards')
    assert.ok(lib.includes('const gate = createGuards.get(id)'), 'flushNote 未等待落点预检门')
    return 'createGuards + flushNote 门 + preflightCreateNote'
  })
  check('行为：端到端（library.regression.test.ts 的 D03/D30 组）', () =>
    `${requireGroup(suite, 'D03 端到端', 'src/data/library.regression.test.ts', 'D03 / D30 新建与导入不覆盖磁盘上的同名文件 ', 4)} 个用例全绿`)
  check('行为：fs 层落点契约（paths.gate.test.ts，含「修复前会写空 / 修复后保留」对照）', () =>
    `${requireGroup(suite, 'D03 fs 层契约', 'src/fs/paths.gate.test.ts', 'D03 落点契约：内存去重之外必须再用后端 exists() 复核 ', 4)} 个用例全绿`)

  // --------------------------------------------------------------------- D08
  section('D08 外部改动不被下次自动保存覆盖（P1）')
  check('静态：渲染层消费端在位（onWorkspaceChanged 订阅 + 去抖重扫）', () => {
    const lib = read('src/data/library.ts')
    for (const symbol of ['fs.onWorkspaceChanged(', 'scheduleWatchRescan', 'watchUnsubscribe', 'const WATCH_DEBOUNCE_MS = 500;']) {
      assert.ok(lib.includes(symbol), `缺少渲染层接线符号：${symbol}`)
    }
    return 'onWorkspaceChanged + WATCH_DEBOUNCE_MS=500 + stopWatching'
  })
  check('静态：写前 mtime/size 比对 → .conflict-* 副本 → 报错提示', () => {
    const lib = read('src/data/library.ts')
    assert.ok(lib.includes('current.mtimeMs !== known.mtimeMs || current.size !== known.size'), '缺少 mtime/size 比对')
    assert.ok(lib.includes('async function preserveConflictCopy('), '缺少 preserveConflictCopy')
    assert.ok(lib.includes('.conflict-'), '缺少 .conflict- 副本命名')
    assert.ok(lib.includes('磁盘上的文件在应用外被修改，原内容已保留为'), '缺少冲突提示文案')
    assert.ok(lib.includes('"检测到外部修改"'), '缺少冲突提示标题')
    return 'stat 比对 + .conflict-* + reportError("检测到外部修改")'
  })
  check('静态：主进程侧 watchWorkspace 受授权门控 + 去抖广播', () => {
    const main = read('electron/main.cjs')
    assert.ok(main.includes("'opennote:fs:watchWorkspace'"), '缺少 watchWorkspace handler')
    assert.ok(main.includes('notifyWorkspaceChanged'), '缺少 notifyWorkspaceChanged')
    assert.ok(main.includes('const WATCH_DEBOUNCE_MS = 450'), '缺少主进程侧去抖常量')
    return 'watchWorkspace（门控）+ notifyWorkspaceChanged（去抖）'
  })
  check('行为：端到端「外部改 → 应用回写 → 原内容存为 .conflict-* + 报错」', () =>
    `${requireGroup(suite, 'D08 端到端', 'src/data/library.regression.test.ts', 'D08 外部改动不被静默覆盖 ', 2)} 个用例全绿`)
  check('行为：渲染层监听接线（library.watch.test.ts）', () =>
    `${requireGroup(suite, 'D08 接线', 'src/data/library.watch.test.ts', 'D08 目录监听接线 ', 11)} 个用例全绿`)
  check('行为：主进程侧监听门控与去抖通知', () => requireSection('D08 工作区监听（去抖通知）', 3))

  // --------------------------------------------------------------------- D12
  section('D12 OPFS 导入覆盖同名（P1 硬门禁，仅约束 OPFS 页面内桥，不阻塞 P0）')
  check('静态：导入按「目录 + 完整相对路径」为键，并按磁盘真实名字种子化', () => {
    const opfs = read('src/fs/opfs.ts')
    assert.ok(opfs.includes('const takenByDir = new Map<string, Set<string>>()'), '缺少按目录分隔的 taken 表')
    assert.ok(opfs.includes('await namesIn(dir)'), 'taken 未按磁盘真实名字种子化')
    assert.ok(opfs.includes('while (await entryExists(dir, baseName(candidate)))'), '写入前未再探测同名条目')
    assert.ok(!/const taken = new Set<string>\(\)/.test(opfs), '不得退回「一次性、只按 basename 去重」的旧实现')
    return 'takenByDir + namesIn 种子化 + 写入前 entryExists 复核'
  })
  check('行为：原始复现回归（opfs.test.ts，磁盘同名不被覆盖 / 跨目录不误改名）', () =>
    `${requireGroup(suite, 'D12 原始复现', 'src/fs/opfs.test.ts', 'importFilesIntoOpfs（D12：不覆盖、不误改名） ', 6)} 个用例全绿`)
  check('行为：边角补强（opfs.gate.test.ts：同名目录 / 多级嵌套 / ".." / 无相对路径）', () =>
    `${requireGroup(suite, 'D12 边角', 'src/fs/opfs.gate.test.ts', 'D12 导入边角：同名目录、嵌套目录、越界相对路径 ', 5)} 个用例全绿`)
  check('行为：OPFS 工作区管理回归', () =>
    `${requireGroup(suite, 'D12 工作区管理', 'src/fs/opfs.test.ts', 'OPFS 工作区管理（D12 回归） ', 2)} 个用例全绿`)

  // ------------------------------------------------------------------ 汇总
  section('汇总')
  const rollup = [
    ['D20 越界写 / 授权根白名单（P0）', 'PASS'],
    ['D29 路径归一化与校验（P0）', 'PASS'],
    ['D31 junction 越界（P1，桌面端已修 / 浏览器端已知限制）', 'PASS'],
    ['D03 落点不预检磁盘同名（P0）', 'PASS'],
    ['D08 外部改动不被覆盖（P1）', 'PASS'],
    ['D12 OPFS 导入覆盖同名（P1 硬门禁，不阻塞 P0）', 'PASS'],
  ]
  for (const [label] of rollup) console.log(`  · ${label}`)
  console.log(`\nPASS ${passCount} / FAIL ${failCount}${NO_MUTANTS ? '（变异检查已跳过）' : ''}`)
  console.log(
    `vitest：${report.numPassedTests} passed / ${report.numFailedTests} failed / ${report.numPendingTests} skipped` +
      `（退出码 ${suite.code}）｜ipc-safety-check：${ipcSummary}（退出码 ${ipc.code}）`,
  )
  if (failCount > 0) {
    console.log('\n失败项：')
    for (const item of failures) console.log(`  - ${item}`)
  }
  if (warns.length > 0) {
    console.log('\n提示（不计入失败）：')
    for (const item of warns) console.log(`  - ${item}`)
  }

  if (!KEEP) {
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true })
    } catch {
      /* 清理失败无妨 */
    }
  } else {
    console.log(`\n临时目录保留在：${tmpRoot}`)
  }

  if (failCount > 0) process.exitCode = 1
}

try {
  if (SELF_TEST) selfTest()
  else main()
} catch (error) {
  console.error('门禁脚本自身异常：', error)
  process.exitCode = 1
}
