#!/usr/bin/env node
'use strict'

/**
 * Opennote A 线缺陷门禁（D20 / D29 / D31 / D03 / D08 / D12）——可复现证据脚本。
 *
 * 用法：
 *   node scripts/gate-defects.cjs                  # 6 条逐条判定（默认）
 *   node scripts/gate-defects.cjs --verbose        # 追加子进程原始输出
 *   node scripts/gate-defects.cjs --full           # 额外跑**全量** vitest 套件
 *   node scripts/gate-defects.cjs --no-mutants     # 跳过变异灵敏度检查（快 ~40s）
 *   node scripts/gate-defects.cjs --keep           # 保留临时目录
 *
 * 退出码：0 = 6 条全部 PASS；1 = 任一 FAIL（含变异检查「护栏不灵敏」）。
 *
 * 这个脚本**不改任何源码**，它做三件事：
 *   1. 静态取证：在真实源码里核对每条缺陷的修复符号与调用点（含「不得退回旧实现」的反向断言）。
 *   2. 行为取证：跑 `scripts/ipc-safety-check.cjs --verbose`（真实 electron/main.cjs + stub electron）
 *      与 vitest（真实 src/fs、src/data 模块），按**用例名**强制要求对应分组的用例存在且全绿。
 *   3. 变异灵敏度：把 main.cjs 复制到临时目录并注回「修复前」的写法，确认护栏会变红。
 *      护栏对回归不敏感 = 证据无效，所以这一步失败同样算 FAIL。
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

const IPC_SCRIPT = path.join(REPO_ROOT, 'scripts', 'ipc-safety-check.cjs')
const VITEST_BIN = path.join(REPO_ROOT, 'node_modules', 'vitest', 'vitest.mjs')
const EVIDENCE_DOC = path.join(REPO_ROOT, 'docs', 'verify', 'A0-缺陷门禁-作者证据.md')

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
function runIpcCheck(options = {}) {
  let script = IPC_SCRIPT
  const env = { ...process.env }
  if (options.mutantMain) {
    const runner = path.join(tmpRoot, `ipc-check-${options.id}.cjs`)
    const source = fs
      .readFileSync(IPC_SCRIPT, 'utf8')
      .replace(
        "const REPO_ROOT = path.resolve(__dirname, '..')",
        `const REPO_ROOT = ${JSON.stringify(REPO_ROOT)}`,
      )
      .replace(
        "const MAIN_PATH = path.join(REPO_ROOT, 'electron', 'main.cjs')",
        'const MAIN_PATH = process.env.OPENNOTE_GATE_MAIN',
      )
    assert.notEqual(source, fs.readFileSync(IPC_SCRIPT, 'utf8'), '无法改写 ipc-safety-check 副本（锚点漂移）')
    fs.writeFileSync(runner, source, 'utf8')
    script = runner
    env.OPENNOTE_GATE_MAIN = options.mutantMain
  }
  const started = Date.now()
  const result = spawnSync(process.execPath, [script, '--verbose'], {
    cwd: REPO_ROOT,
    env,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 300000,
  })
  const stdout = `${result.stdout || ''}${result.stderr || ''}`
  return { code: result.status, stdout, ms: Date.now() - started }
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

function writeMutant(mutant) {
  const source = read('electron/main.cjs')
  assert.ok(source.includes(mutant.anchor), `${mutant.id} 锚点未命中（源码漂移）：${mutant.anchor.split('\n')[0]}`)
  // 变异副本放在临时目录里，__dirname 会跟着变（main.cjs 用它拼 preload 路径）。
  // 指回仓库的 electron/，否则每次变异运行都会多出一条与缺陷无关的「preload 路径基线」失败，
  // 让「护栏为什么变红」变得不可读。
  const pinned = `__dirname = ${JSON.stringify(path.join(REPO_ROOT, 'electron'))}\n`
  const mutated = (pinned + source).replace(mutant.anchor, mutant.mutated)
  const file = path.join(tmpRoot, `main-${mutant.id}.cjs`)
  fs.writeFileSync(file, mutated, 'utf8')
  return file
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
  let mutants = []
  if (NO_MUTANTS) {
    warn('已跳过变异灵敏度检查（--no-mutants）：本次不含「护栏对回归敏感」的证据')
  } else {
    section('变异灵敏度：把「修复前」的写法注回 main.cjs 副本，护栏必须变红')
    mutants = MUTANTS.map((mutant) => {
      const file = writeMutant(mutant)
      const run = runIpcCheck({ id: mutant.id, mutantMain: file })
      const parsedMutant = parseIpcOutput(run.stdout)
      // 变异运行的原始输出留档，供人工核对「护栏确实因为该回归变红」
      fs.writeFileSync(path.join(tmpRoot, `${mutant.id}.log`), run.stdout, 'utf8')
      const detected = run.code !== 0 && mutant.expectFailure.test(run.stdout)
      console.log(
        `  ${detected ? 'DETECTED' : 'MISSED  '} ${mutant.id} ${mutant.defect}：${mutant.label}` +
          `（退出码 ${run.code}，FAIL ${parsedMutant.summary ? parsedMutant.summary[2] : '?'}）`,
      )
      if (VERBOSE) {
        const hits = [...parsedMutant.sections.entries()].flatMap(([title, group]) =>
          group.fail.map((name) => `      ${title} › ${name}`),
        )
        for (const line of hits) console.log(line)
      }
      return { ...mutant, detected, run, parsed: parsedMutant }
    })
  }

  const mutant = (id) => mutants.find((item) => item.id === id)
  /** 变异检查的断言：必须被检测到；跳过时明确降级成 WARN。 */
  const assertMutantDetected = (id) => {
    if (NO_MUTANTS) return '已跳过（--no-mutants）'
    const item = mutant(id)
    assert.ok(item, `${id} 未执行`)
    assert.ok(
      item.detected,
      `${id} 未被护栏检测到（退出码 ${item.run.code}，FAIL ${item.parsed.summary ? item.parsed.summary[2] : '?'}）——护栏对该回归不敏感`,
    )
    return `退出码 ${item.run.code}，FAIL ${item.parsed.summary ? item.parsed.summary[2] : '?'}`
  }

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
  main()
} catch (error) {
  console.error('门禁脚本自身异常：', error)
  process.exitCode = 1
}
