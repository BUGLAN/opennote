#!/usr/bin/env node
/**
 * 底栏（`.statusbar`）真窗口几何验收：**按钮永不被裁**、信息按底栏自身宽度分档降级。
 *
 *   node scripts/statusbar-fit-probe.mjs --launch          # 自己拉起 vite + electron（临时 user-data-dir）
 *   node scripts/statusbar-fit-probe.mjs --port 9223       # 连一个已经带 --remote-debugging-port 起的窗口
 *
 * 为什么值得留一个脚本：用户 2026-10-10 的截图（视口 1264 @2x、侧栏 293）里，底栏只有
 * 971px 却要排下 1170px 的内容，`overflow: hidden` 把最右的「历史 / 夜读 / 设置」整颗裁掉。
 * 那是**只有真窗口才量得出来的几何**（token/类名的护栏在 `src/components/statusbarLayout.test.ts`），
 * 改动之后要能一条命令重新量一遍，而不是靠谁手点。
 *
 * 每个用例跑四遍内容：① 应用此刻的真实内容（临时 profile 没工作区，所以偏窄）；
 * ② **用户截图那组内容**（阈值就是照它标定的）；③ 最坏内容（路径顶到 300px 上限、
 * 长文件夹名、六位数计数、含 GitHub 那两颗按钮）；④ 真实内容 + GitHub 远端。
 * ③ 严格宽于任何真实笔记本，所以它证明的是「最坏内容下也不裁」，而不只是「碰巧这次没裁」。
 *
 * 判据（任一不满足 → 退出码 1）：
 *   ① `statusbar.scrollWidth <= clientWidth + 1`（底栏自己没有横向溢出）
 *   ② 高度仍是 `--statusbar-h`（30px），底边线不会被内容顶开
 *   ③ 每颗按钮都可见（`display` 不是 none）、完整落在底栏内容盒里、自身没有被压扁、
 *      并且 `elementFromPoint(中心)` 打得到它（真的点得着）
 *   ④ 保存圆点一直可见（用户选定的「必要项」）
 *   ⑤ 除两段长文本（存放位置 / 当前文件夹，已声明允许省略号）外，没有哪一项被压出
 *      半截字（自身 scrollWidth 不超过盒子宽，且不越过信息段的右边界）
 */
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name, fallback) => {
  const index = argv.indexOf(name)
  return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback
}

const OUT_DIR = path.resolve(ROOT, value('--out', 'docs/verify/A2-shots'))
const PORT_ARG = value('--port', null)
const WANT_SHOTS = !flag('--no-shots')
const LAUNCH = flag('--launch') || !PORT_ARG

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 视口 × 侧栏宽度 × 大纲；`dpr` 只在「用户那组参数」上取 2（几何与 DPR 无关，取 2 只为和截图对齐）。 */
const MATRIX = [
  { w: 1264, h: 829, sidebar: 293, dpr: 2, outline: [false, true], shot: 'user-screenshot' },
  { w: 1264, h: 829, sidebar: 520, dpr: 1, outline: [false], shot: 'user-narrow-sidebar-max' },
  { w: 1024, h: 800, sidebar: 268, dpr: 1, outline: [false], shot: 'w1024' },
  { w: 1024, h: 800, sidebar: 520, dpr: 1, outline: [false] },
  { w: 900, h: 700, sidebar: 520, dpr: 1, outline: [false], shot: 'floor-900-sidebar-520' },
  { w: 900, h: 700, sidebar: 200, dpr: 1, outline: [false] },
  { w: 1440, h: 900, sidebar: 268, dpr: 1, outline: [false, true] },
  { w: 1920, h: 1080, sidebar: 268, dpr: 1, outline: [false, true] },
  { w: 820, h: 700, sidebar: 268, dpr: 1, outline: [false], shot: 'mobile-820' },
  { w: 600, h: 700, sidebar: 268, dpr: 1, outline: [false] },
  { w: 380, h: 700, sidebar: 268, dpr: 1, outline: [false], shot: 'mobile-380' },
]

/* ------------------------------- CDP ------------------------------------ */

function freePort() {
  return new Promise((resolve, reject) => {
    const server = require('node:net').createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function waitForPage(port, attempts = 150) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
      const page = targets.find((target) => target.type === 'page')
      if (page?.webSocketDebuggerUrl) return page
    } catch {
      /* 还没起来 */
    }
    await delay(400)
  }
  throw new Error(`等不到调试端口 ${port} 的页面（应用没起来？）`)
}

async function connect(port) {
  const page = await waitForPage(port)
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
      userGesture: true,
    })
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails))
    }
    return result.result.value
  }
  return { socket, send, evaluate }
}

/* --------------------------- 拉起一个临时窗口 ---------------------------- */

async function launchApp() {
  const vitePort = await freePort()
  const viteBin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js')
  if (!existsSync(viteBin)) throw new Error('未找到 vite（先 pnpm install）')
  const vite = spawn(process.execPath, [viteBin, '--host', '127.0.0.1', '--port', String(vitePort), '--strictPort'], {
    cwd: ROOT,
    stdio: 'ignore',
    env: { ...process.env, BROWSER: 'none' },
  })
  const devUrl = `http://127.0.0.1:${vitePort}`
  let ready = false
  for (let i = 0; i < 60 && !ready; i += 1) {
    try {
      ready = (await fetch(devUrl, { signal: AbortSignal.timeout(2000) })).status < 500
    } catch {
      ready = false
    }
    if (!ready) await delay(500)
  }
  if (!ready) throw new Error(`等不到 vite（${devUrl}）`)

  const electronPath = require('electron')
  const cdpPort = await freePort()
  const userData = mkdtempSync(path.join(tmpdir(), 'opennote-sb-probe-'))
  const env = { ...process.env, OPENNOTE_DEV_URL: devUrl }
  delete env.ELECTRON_RUN_AS_NODE
  const electron = spawn(
    electronPath,
    [ROOT, `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${userData}`],
    { cwd: ROOT, env, stdio: 'ignore', windowsHide: false },
  )
  electron.on('error', () => {})
  return {
    port: cdpPort,
    dispose: () => {
      for (const pid of [electron.pid, vite.pid]) {
        if (typeof pid !== 'number') continue
        spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' })
      }
      try {
        rmSync(userData, { recursive: true, force: true })
      } catch {
        /* 删不掉也不影响结论 */
      }
    },
  }
}

/* ------------------------------ 页面内测量 ------------------------------- */

const HELPERS = `
  const bar = () => document.querySelector('.statusbar');
  const visible = (el) => {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
  };
  const label = (el) => (el.className || '').toString().split(' ').filter((c) => c.startsWith('statusbar__item')).join('.') + ' | ' + el.textContent.trim().slice(0, 20);
`

/**
 * 页面内的文字夹具，三种内容：
 *   - `orig` 还原成应用此刻的真实内容（临时 profile 下没有工作区，所以它偏窄）；
 *   - `user` 换成**用户截图那组内容**（本机磁盘 · E:\repo\notes / 510 个文件 / Agent 产出 /
 *     已写入磁盘 · 7 分钟前 / 2,128 字 · 2,457 字符 · 约 7 分钟 / 行 25 · 列 1）——
 *     阈值就是照这组内容标定的，所以它必须单独有一遍；
 *   - `worst` 换成最宽的可能值（路径顶到 300px 上限、长文件夹名、六位数计数），
 *     严格宽于任何真实笔记本：它证明的是「最坏内容下也不裁」，而不只是「碰巧这次没裁」。
 */
const TEXT_SCRIPT = `
  ${HELPERS}
  window.__sbText = (mode) => {
    const b = bar();
    if (!b) return 0;
    /*
     * 临时 profile 没有工作区、也没有 GitHub 远端，于是两样东西**不在 DOM 里**：
     *   - 「· 7 分钟前」那段（从没落过盘）—— 补一颗同 class 的空 span；
     *   - GitHub 笔记本来就会多出来的两颗按钮 —— 复制一颗现成按钮（同一套 class
     *     → 同一套 CSS，宽度等价），只在 github 这一遍里挂着。
     * 补的是**测量夹具**，不是产品代码；不补的话这一遍量出来的内容比真实情况窄。
     */
    let saveAgo = b.querySelector('.statusbar__save-ago');
    if (!saveAgo) {
      const saveItem = b.querySelector('.statusbar__item--save');
      if (saveItem) {
        saveAgo = document.createElement('span');
        saveAgo.className = 'statusbar__save-ago';
        saveItem.appendChild(saveAgo);
      }
    }
    const ghActions = b.querySelector('.statusbar__actions');
    const ghExisting = ghActions ? [...ghActions.querySelectorAll('[data-probe-github]')] : [];
    if (mode === 'github') {
      if (!ghExisting.length && ghActions) {
        const template = ghActions.querySelector('.statusbar__item--button');
        const settingsButton = ghActions.lastElementChild;
        for (const text of ['GitHub · owner/repo', '清除令牌']) {
          const clone = template.cloneNode(true);
          clone.dataset.probeGithub = '1';
          const span = clone.querySelector('.statusbar__label');
          if (span) span.textContent = text;
          ghActions.insertBefore(clone, settingsButton);
        }
      }
    } else {
      for (const el of ghExisting) el.remove();
    }

    const targets = [];
    const push = (el, user, worst) => { if (el) targets.push({ el, user, worst }); };
    push(b.querySelector('.statusbar__item--path .statusbar__ellipsis'),
      '本机磁盘 · E:\\\\repo\\\\notes',
      '本机磁盘 · E:\\\\repo\\\\notes\\\\技术笔记\\\\计算机网络\\\\非常长的目录名还要更长一些');
    push(b.querySelector('.statusbar__item--folder .statusbar__ellipsis'),
      'Agent 产出',
      '一个很长很长的文件夹名字要占位置');
    push(b.querySelector('.statusbar__item[title$="个文件"]'), '510 个文件', '9,999 个文件');
    push(b.querySelector('.statusbar__item[title="字数统计"]'),
      '2,128 字 · 2,457 字符 · 约 7 分钟',
      '12,345 字 · 98,765 字符 · 约 123 分钟');
    push(b.querySelector('.statusbar__item--cursor'), '行 25 · 列 1', '行 1,234 · 列 99 · 选中 12,345');
    push(b.querySelector('.statusbar__save-text'), '已写入磁盘', '已写入磁盘');
    push(saveAgo, ' · 7 分钟前', ' · 59 分钟前');
    for (const el of b.querySelectorAll('.statusbar__label')) {
      if (el.textContent.startsWith('收件箱')) push(el, '收件箱', '收件箱 99');
      else if (el.textContent.startsWith('历史')) push(el, '历史', '历史 999');
      else if (el.textContent.includes('·')) push(el, 'GitHub · owner/repo', 'GitHub · very-long-owner/very-long-repo');
      else push(el, '素笺', '素笺');
    }
    for (const { el, user, worst } of targets) {
      if (mode === 'capture') el.dataset.sbOrig = el.textContent;
      else if (mode === 'orig') el.textContent = el.dataset.sbOrig ?? el.textContent;
      else el.textContent = mode === 'user' ? user : worst;
    }
    return targets.length;
  };
  return true;
`

const MEASURE = `
  ${HELPERS}
  const b = bar();
  const info = b.querySelector('.statusbar__info');
  const actions = b.querySelector('.statusbar__actions');
  const style = getComputedStyle(b);
  const rect = b.getBoundingClientRect();
  const contentLeft = rect.left + parseFloat(style.paddingLeft);
  const contentRight = rect.right - parseFloat(style.paddingRight);
  const infoRect = info.getBoundingClientRect();
  const actionsRect = actions.getBoundingClientRect();
  const buttons = [...b.querySelectorAll('.statusbar__item--button')];
  /* 只看信息段里的项：按钮也带 .statusbar__item，但它们本来就在信息段外面 */
  const infoItems = [...info.querySelectorAll('.statusbar__item')];
  /* 允许省略号的两项：宿主是 .statusbar__ellipsis 那一层
     （宿主自己不溢出 —— 是里面那层在缩，所以量里面那层） */
  const ellipsisSpans = [...b.querySelectorAll('.statusbar__ellipsis')].filter(visible);
  const ellipsisHosts = [b.querySelector('.statusbar__item--path'), b.querySelector('.statusbar__item--folder')].filter(Boolean);
  const dot = b.querySelector('.statusbar__dot');
  const truncated = (el) => el.scrollWidth > Math.ceil(el.getBoundingClientRect().width) + 1;
  return {
    viewport: { w: window.innerWidth, h: window.innerHeight },
    bar: {
      scrollWidth: b.scrollWidth,
      clientWidth: b.clientWidth,
      height: Math.round(rect.height * 100) / 100,
      bottomEdge: Math.round(rect.bottom * 10) / 10,
      contentLeft: Math.round(contentLeft * 10) / 10,
      contentRight: Math.round(contentRight * 10) / 10,
      width: Math.round((contentRight - contentLeft) * 10) / 10,
    },
    info: {
      width: Math.round(infoRect.width * 10) / 10,
      scrollWidth: info.scrollWidth,
      clientWidth: info.clientWidth,
      overflowing: info.scrollWidth > info.clientWidth + 1,
    },
    actions: {
      width: Math.round(actionsRect.width * 10) / 10,
      count: buttons.length,
      hidden: buttons.filter((el) => !visible(el)).map(label),
      outOfBar: buttons.filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        return r.right > contentRight + 0.5 || r.left < contentLeft - 0.5;
      }).map(label),
      squeezed: buttons.filter((el) => visible(el) && truncated(el)).map(label),
      unreachable: buttons.filter((el) => {
        if (!visible(el)) return false;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !hit || !el.contains(hit);
      }).map(label),
    },
    hiddenInfo: infoItems.filter((el) => !visible(el)).map(label),
    visibleInfo: infoItems.filter(visible).map((el) => label(el) + ' [' + Math.round(el.getBoundingClientRect().width) + 'px]'),
    clipped: infoItems.filter((el) => visible(el) && !ellipsisHosts.includes(el) && truncated(el)).map(label),
    pastInfoRight: infoItems.filter((el) => visible(el) && el.getBoundingClientRect().right > infoRect.right + 0.5).map(label),
    ellipsized: ellipsisSpans
      .filter((el) => truncated(el))
      .map((el) => label(el.parentElement) + ' [' + Math.round(el.getBoundingClientRect().width) + 'px]'),
    dotVisible: !!dot && visible(dot),
    actionsInsideBar: actionsRect.right <= contentRight + 0.5 && actionsRect.left >= contentLeft - 0.5,
    /* 侧栏脚注与底栏「同高同底」是写死的契约（--statusbar-h）：抽屉布局下侧栏
       隐藏（mobile=false 的用例里我们关掉了抽屉），量不到就记 null、不作数。 */
    foot: (() => {
      const foot = document.querySelector('.sidebar__foot');
      if (!foot || !visible(foot)) return null;
      const r = foot.getBoundingClientRect();
      const hasActions = Boolean(foot.querySelector('.sidebar__foot-actions'));
      return {
        height: Math.round(r.height * 100) / 100,
        bottom: Math.round(r.bottom * 10) / 10,
        noActionSlot: !hasActions,
      };
    })(),
  };
`

function violations(result) {
  const bad = []
  const { bar, info, actions } = result
  if (bar.scrollWidth > bar.clientWidth + 1) bad.push(`底栏横向溢出（scrollWidth ${bar.scrollWidth} > clientWidth ${bar.clientWidth}）`)
  if (Math.abs(bar.height - 30) > 0.6) bad.push(`底栏高度 ${bar.height} ≠ 30（--statusbar-h）`)
  if (actions.hidden.length) bad.push(`有按钮被隐藏：${actions.hidden.join(' / ')}`)
  if (actions.outOfBar.length) bad.push(`有按钮被裁出底栏：${actions.outOfBar.join(' / ')}`)
  if (actions.squeezed.length) bad.push(`有按钮被压扁：${actions.squeezed.join(' / ')}`)
  if (actions.unreachable.length) bad.push(`有按钮点不到：${actions.unreachable.join(' / ')}`)
  if (!result.actionsInsideBar) bad.push('按钮组越出底栏内容盒')
  if (!result.dotVisible) bad.push('保存圆点不可见')
  if (info.overflowing) bad.push(`信息段内部溢出（scrollWidth ${info.scrollWidth} > clientWidth ${info.clientWidth}）`)
  if (result.clipped.length) bad.push(`有信息项被压出半截字：${result.clipped.join(' / ')}`)
  if (result.pastInfoRight.length) bad.push(`有信息项越过信息段右边界（被裁）：${result.pastInfoRight.join(' / ')}`)
  if (actions.count < 7) bad.push(`按钮数量 ${actions.count} < 7`)
  if (result.foot) {
    if (Math.abs(result.foot.height - 30) > 0.6) bad.push(`侧栏脚注高度 ${result.foot.height} ≠ 30（--statusbar-h）`)
    if (Math.abs(result.foot.bottom - result.bar.bottomEdge) > 1) {
      bad.push(`侧栏脚注底边 ${result.foot.bottom} 与底栏底边 ${result.bar.bottomEdge} 不齐（两条底边线要连成一条）`)
    }
    if (!result.foot.noActionSlot) bad.push('侧栏脚注又出现了动作位 .sidebar__foot-actions（已按用户要求移除）')
  }
  return bad
}

/* ---------------------------------- 跑 ---------------------------------- */

async function main() {
  mkdirSync(OUT_DIR, { recursive: true })
  const launched = LAUNCH ? await launchApp() : null
  const port = launched ? launched.port : Number(PORT_ARG)
  const { socket, send, evaluate } = await connect(port)
  try {
    await send('Page.enable')
    // 页面目标一出现就连接，此时 React 可能还没挂上（dev 模式首屏要现编译）——先等底栏出现。
    let mounted = false
    for (let i = 0; i < 150 && !mounted; i += 1) {
      mounted = await evaluate('return Boolean(document.querySelector(".statusbar"))').catch(() => false)
      if (!mounted) await delay(400)
    }
    if (!mounted) throw new Error('等不到底栏挂载（.statusbar）——应用没起来，或首屏渲染就失败了')
    await delay(400)

    await run({ send, evaluate })
  } finally {
    socket.close()
    launched?.dispose()
  }
}

async function run({ send, evaluate }) {
  const cases = []
  let failures = 0
  const shots = []

  // 原文只在这一处记一次：放进每个用例里记的话，会把上一个用例注入的「最坏内容」当成原文，
  // 「真实内容」那一遍就永远量的是脏数据。
  await evaluate(TEXT_SCRIPT)
  await evaluate('return window.__sbText("capture")')

  for (const entry of MATRIX) {
    for (const outline of entry.outline) {
      const outlineState = outline ? 'open' : 'closed'
      await send('Emulation.setDeviceMetricsOverride', {
        width: entry.w,
        height: entry.h,
        deviceScaleFactor: entry.dpr,
        mobile: false,
      })
      // ≤820 是抽屉布局：抽屉打开时遮罩会盖住底栏，`elementFromPoint` 量到的就不是按钮了 ——
      // 移动端要按「抽屉关着」量（此时底栏占满整宽，和真实使用一致）。
      const wantOpen = entry.w > 820
      await evaluate(`
        const app = document.querySelector('.app');
        if (app) {
          const open = app.classList.contains('is-sidebar-open');
          if (open !== ${wantOpen}) {
            const btn = document.querySelector('button[title^="展开侧栏"], button[title^="收起侧栏"]');
            btn?.click();
          }
        }
        document.documentElement.style.setProperty('--sidebar-w', '${entry.sidebar}px');
        return true;
      `)
      await delay(300)
      const outlineNow = await evaluate(`
        const btn = document.querySelector('.statusbar__item--button[aria-label="大纲"]');
        return btn ? btn.classList.contains('is-on') : null;
      `)
      if (outlineNow !== outline) {
        await evaluate('document.querySelector(\'.statusbar__item--button[aria-label="大纲"]\')?.click(); return true')
        await delay(300)
      }

      const PASSES = [
        { key: 'real', mode: 'orig', name: '真实内容' },
        { key: 'user', mode: 'user', name: '用户截图那组内容' },
        { key: 'worst', mode: 'worst', name: '最坏内容' },
        { key: 'github', mode: 'github', name: '最坏内容 + GitHub 两颗按钮' },
      ]
      for (const pass of PASSES) {
        await evaluate(`return window.__sbText(${JSON.stringify(pass.mode)})`)
        await delay(60)
        const result = await evaluate(MEASURE)
        const bad = violations(result)
        if (bad.length) failures += 1
        const name = `${entry.w}x${entry.h} dpr${entry.dpr} 侧栏${entry.sidebar} 大纲${outlineState} · ${pass.name}`
        cases.push({
          name,
          barWidth: result.bar.width,
          barHeight: result.bar.height,
          foot: result.foot,
          infoWidth: result.info.width,
          actionsWidth: result.actions.width,
          buttons: result.actions.count,
          hiddenInfo: result.hiddenInfo,
          visibleInfo: result.visibleInfo,
          ellipsized: result.ellipsized,
          bad,
        })
        if (bad.length) console.log(`FAIL  ${name}\n      ${bad.join('\n      ')}`)
        else
          console.log(
            `ok    ${name}  底栏 ${result.bar.width}px（信息段 ${result.info.width} · 按钮组 ${result.actions.width}）` +
              `${result.ellipsized.length ? ` · 省略号 ${result.ellipsized.length} 项` : ''}`,
          )

        if (WANT_SHOTS && shotWanted(entry, pass.key)) {
          // 只截底栏那一条：整窗太宽，证据里要能一眼看清最右边的按钮
          const barTop = await evaluate('return Math.round(document.querySelector(".statusbar").getBoundingClientRect().top)')
          const shot = await send('Page.captureScreenshot', {
            format: 'png',
            clip: { x: 0, y: Math.max(0, barTop - 6), width: entry.w, height: 42, scale: 2 },
          })
          const suffix = outlineState === 'open' ? '-outline' : ''
          const file = path.join(OUT_DIR, `${entry.shot}-sb${entry.sidebar}${suffix}-${pass.key}.png`)
          writeFileSync(file, Buffer.from(shot.data, 'base64'))
          shots.push(path.relative(ROOT, file))
        }
      }
    }
  }

  const barWidths = cases.map((one) => one.barWidth)
  console.log('')
  console.log(`用例 ${cases.length} 个，失败 ${failures} 个`)
  console.log(`底栏可用宽度：最窄 ${Math.min(...barWidths)}px / 最宽 ${Math.max(...barWidths)}px`)
  if (shots.length) console.log(`截图：\n  ${shots.join('\n  ')}`)
  writeFileSync(
    path.resolve(ROOT, 'docs/verify/A2-状态栏窄窗-探针输出.json'),
    JSON.stringify({ cases, failures, shots }, null, 2),
  )

  if (failures) process.exitCode = 1
}

/** 只给少数几组出图（其余用例的数字已经在 JSON 里）。 */
function shotWanted(entry, passKey) {
  if (!entry.shot) return false
  if (entry.shot === 'user-screenshot') return true // 用户那组参数：每一遍内容都留图
  // 最窄的一组要留 GitHub（9 颗按钮）那一遍：全项目最紧的一次排布
  if (entry.shot === 'floor-900-sidebar-520') return passKey !== 'real'
  return passKey === 'user' || passKey === 'worst'
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
