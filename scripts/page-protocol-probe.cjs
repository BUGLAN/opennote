'use strict'

/**
 * 真实 Electron 探针：`opennote-page:` 协议 + 沙箱 iframe 的端到端验证。
 *
 * ## 为什么非要有这个探针
 *
 * 这条链路上有三件事**只能**在真实 Chromium 里验证，静态检查与单测都看不见：
 *
 *   1. **内联脚本在页面里真的跑了吗？** —— 我们绕开 `srcdoc` 的全部理由就是
 *      「子框架继承父文档 CSP，内联脚本会被静默挡掉」。如果协议这条路也挡，功能等于没做，
 *      而失败形态是**白屏**（不是报错），最容易在自测里被忽略。
 *   2. **父文档的 CSP 会不会挡住这个 iframe？** —— 需要 `frame-src opennote-page:`；
 *      写错一个字符的症状同样是白屏。
 *   3. **`frame-ancestors` 会不会把我们自己挡在外面？** —— 页面策略里的
 *      `frame-ancestors file:` 要靠 Chromium 对 `file://` 祖先的实际判定来兑现。
 *      写得过窄 = 页面永远嵌不进来；写得过宽 = 任何本地页面都能嵌。这一条**猜不得**。
 *
 * 顺带验证反方向：页面拿不到 `parent.document`、拿不到 `localStorage`、
 * `fetch` 被拦；回收站里的页面照样渲染；`.opennote/sync.json` 拿不到。
 *
 * ## 怎么跑
 *
 *   pnpm exec electron scripts/page-protocol-probe.cjs
 *
 * 无头环境也能跑（窗口 `show: false`）。全部通过 → 退出码 0；
 * 任何一条不通过 → 打印**实际观测值**并以 1 退出（不静默、不猜测）。
 */

const { app, BrowserWindow, net, protocol, session } = require('electron')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const { PAGE_SCHEME, PAGE_CSP, pageUrlFor } = require(path.join(__dirname, '..', 'electron', 'pageProtocol.cjs'))

/** 模拟「应用主窗口」的策略：与 `electron/main.cjs` 的 `cspPolicy()` 同形（只差 hash）。 */
const APP_CSP = [
  "default-src 'none'",
  "script-src 'self' file: 'unsafe-inline'",
  "style-src 'self' file: 'unsafe-inline'",
  "img-src 'self' file: data: blob:",
  "font-src 'self' file: data:",
  "connect-src 'self' file:",
  "media-src 'self' file: blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  'frame-src opennote-page:',
  "worker-src 'self' blob:",
].join('; ')

/** 临时工作区：放一个带内联脚本与同目录图片的页面，以及回收站与敏感文件。 */
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'opennote-page-probe-'))
fs.mkdirSync(path.join(workspace, '原型'), { recursive: true })
fs.writeFileSync(path.join(workspace, '原型', '登录页.html'), "<!doctype html><html lang=\"zh-CN\"><head><meta charset=\"utf-8\"><title>探针页面</title></head>\n<body><h1 id=\"t\">未运行</h1>\n<img id=\"i\" src=\"./logo.svg\" alt=\"\">\n<script>\nvar out = { probe: \"opennote-page\", slot: \"page\" };\n// ① 内联脚本能否执行：这一行本身就是证据（写了 h1 才会变）\ndocument.getElementById(\"t\").textContent = \"脚本已运行\";\nout.heading = document.getElementById(\"t\").textContent;\n// ② 沙箱边界\ntry { out.canReachParent = Boolean(parent.document); } catch (e) { out.canReachParent = false; }\ntry { out.canReachStorage = Boolean(localStorage.length >= 0); } catch (e) { out.canReachStorage = false; }\n// ③ 相对资源（同目录 logo.svg）\nvar img = document.getElementById(\"i\");\nvar send = function () { parent.postMessage(out, \"*\"); };\nvar finish = function () {\n  // ④ 策略边界：fetch 必须被拦（页面策略里没有 connect-src）\n  fetch(\"/__probe-fetch__\").then(function () { out.fetchBlocked = false; send(); },\n    function () { out.fetchBlocked = true; send(); });\n};\nif (img && img.complete) { out.imageLoaded = img.naturalWidth > 0; finish(); }\nelse if (img) {\n  img.addEventListener(\"load\", function () { out.imageLoaded = true; finish(); });\n  img.addEventListener(\"error\", function () { out.imageLoaded = false; finish(); });\n  setTimeout(finish, 3000);\n} else { out.imageLoaded = false; finish(); }\n</script></body></html>")
fs.writeFileSync(
  path.join(workspace, '原型', 'logo.svg'),
  '<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="red"/></svg>',
)
fs.mkdirSync(path.join(workspace, '.opennote', 'trash'), { recursive: true })
fs.writeFileSync(path.join(workspace, '.opennote', 'sync.json'), '{"SECRET":"DO-NOT-LEAK"}')
fs.writeFileSync(path.join(workspace, '.opennote', 'trash', '旧页.html'), "<!doctype html><html><head><meta charset=\"utf-8\"><title>旧页</title></head><body><p id=\"p\">trash-ok</p>\n<script>parent.postMessage({ probe: \"opennote-page\", slot: \"trash\", text: document.getElementById(\"p\").textContent }, \"*\");</script>\n</body></html>")

/** 父窗口：空文档，稍后用 executeJavaScript 往里挂 iframe。 */
const parentFile = path.join(workspace, '_parent.html')
fs.writeFileSync(parentFile, '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')

protocol.registerSchemesAsPrivileged([
  { scheme: PAGE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: false, corsEnabled: false, stream: false } },
])

let failures = 0
function fail(message, detail) {
  failures += 1
  console.log('FAIL ' + message + (detail === undefined ? '' : ' — ' + detail))
}
function pass(message, detail) {
  console.log('PASS ' + message + (detail === undefined ? '' : ' — ' + detail))
}

app.whenReady().then(async () => {
  // 父文档的 CSP 必须在**响应头**里给（与主进程同一做法：file:// 注入）。
  session.defaultSession.webRequest.onHeadersReceived({ urls: ['file://*/*'] }, (details, callback) => {
    callback({ responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [APP_CSP] } })
  })

  protocol.handle(PAGE_SCHEME, async (request) => {
    const url = new URL(request.url)
    const rel = decodeURIComponent(url.pathname.replace(/^\//, ''))
    const segments = rel.split('/')
    // 与 main.cjs 同一套规则：.opennote 下只放行 trash / history
    if (segments[0] === '.opennote' && !['trash', 'history'].includes(segments[1])) {
      return new Response('forbidden', { status: 403, headers: { 'Content-Security-Policy': PAGE_CSP } })
    }
    try {
      const data = fs.readFileSync(path.join(workspace, rel))
      const isHtml = rel.endsWith('.html')
      return new Response(data, {
        status: 200,
        headers: {
          'Content-Type': isHtml ? 'text/html; charset=utf-8' : 'image/svg+xml',
          'Content-Security-Policy': PAGE_CSP,
          'Cache-Control': 'no-store',
        },
      })
    } catch {
      return new Response('not found', { status: 404, headers: { 'Content-Security-Policy': PAGE_CSP } })
    }
  })

  const win = new BrowserWindow({
    show: false,
    width: 900,
    height: 600,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true },
  })
  await win.loadFile(parentFile)

  const pageSrc = pageUrlFor('原型/登录页.html')
  const trashSrc = pageUrlFor('.opennote/trash/旧页.html')
  const secretSrc = pageUrlFor('.opennote/sync.json')

  /*
   * 在父页面里挂沙箱 iframe，并在**子页面内部**跑断言。
   *
   * 为什么断言写在子页面里而不在父页面：父页面读不到 opaque origin 子框架的 DOM
   * （这正是沙箱生效的证据）。所以子页面自己检测、自己 postMessage 回来 ——
   * 能收到回执这件事本身，也说明 allow-scripts 没把它彻底关死。
   *
   * sandbox 值传的就是 'allow-scripts' —— 与 src/components/HtmlPageView.tsx 的
   * HTML_PAGE_SANDBOX 同一字符串（有一条单测钉住它）。
   */
  const script = [
    'new Promise(function (resolve) {',
    '  var results = { page: null, trash: null };',
    '  window.addEventListener("message", function (event) {',
    '    var data = event.data;',
    '    if (!data || data.probe !== "opennote-page") return;',
    '    results[data.slot] = data;',
    '  });',
    '  function frame(slot, src) {',
    '    var el = document.createElement("iframe");',
    '    el.setAttribute("sandbox", "allow-scripts");',
    '    el.src = src;',
    '    document.body.appendChild(el);',
    '  }',
    '  frame("page", ' + JSON.stringify(pageSrc) + ');',
    '  frame("trash", ' + JSON.stringify(trashSrc) + ');',
    '  var started = Date.now();',
    '  var timer = setInterval(function () {',
    '    if (results.page || Date.now() - started > 6000) { clearInterval(timer); resolve(results); }',
    '  }, 40);',
    '})',
  ].join('\n')

  let observed = null
  try {
    observed = await win.webContents.executeJavaScript(script, true)
  } catch (error) {
    fail('父页面脚本执行失败', error && error.message)
  }

  if (observed && observed.page) {
    const page = observed.page
    if (page.heading === '脚本已运行') pass('页面里的内联脚本真的执行了', 'h1 = ' + page.heading)
    else fail('页面里的内联脚本没有执行（CSP 把内联脚本挡掉了）', 'h1 = ' + JSON.stringify(page.heading))

    if (page.imageLoaded === true) pass('同目录相对资源能解析（URL 与工作区同构）')
    else fail('相对资源加载失败（naturalWidth = 0）')

    if (page.canReachParent === false) pass('沙箱隔离生效：页面读不到 parent.document')
    else fail('沙箱失效：页面能读 parent.document')

    if (page.canReachStorage === false) pass('沙箱隔离生效：页面读不到 localStorage')
    else fail('沙箱失效：页面能读 localStorage')

    if (page.fetchBlocked === true) pass('页面策略拦住了 fetch（没有 connect-src）')
    else fail('页面能发 fetch（connect-src 没被掐掉）')
  } else {
    fail('沙箱 iframe 没有回报结果（页面没加载 / 被 CSP 挡住 / 脚本被拦）', JSON.stringify(observed))
  }

  if (observed && observed.trash && observed.trash.text.indexOf('trash-ok') >= 0) {
    pass('回收站里的页面照常渲染（.opennote/trash 放行）')
  } else {
    fail('回收站里的页面打不开', JSON.stringify(observed && observed.trash))
  }

  /*
   * 元数据文件必须拿不到。
   *
   * 分两步、两种口径，因为它们是**两道不同的闸**，各自都可能先拦住：
   *   ① 页面里的 fetch：父文档 CSP 的 connect-src 不含 opennote-page:，所以请求
   *      在渲染层就被拒（network-error）。这一条证明「页面拿不到」，但证不到协议层；
   *   ② 主进程的 net.fetch：绕过渲染层的 CSP，直接打协议 handler —— 这才验证到
   *      「.opennote/sync.json 返回 403」本身。
   * 只做 ① 会让「协议其实放行了 sync.json」这种缺陷漏网（渲染层挡住了它，看不出差别）。
   */
  let secretDirect = null
  try {
    const response = await net.fetch(secretSrc)
    secretDirect = response.status
  } catch (error) {
    secretDirect = 'throw:' + (error && error.message ? error.message : String(error))
  }
  if (secretDirect === 403) pass('协议层直接拒绝 .opennote/sync.json（403）', 'net.fetch status = 403')
  else fail('协议层没有拒绝 .opennote/sync.json', 'net.fetch status = ' + secretDirect)

  // 反向控制组：回收站里的页面在协议层必须是 200（证明上面那条 403 是「按规则拒」，
  // 而不是「什么都读不到」—— 后者会让所有断言假绿）。
  let trashDirect = null
  try {
    trashDirect = (await net.fetch(trashSrc)).status
  } catch (error) {
    trashDirect = 'throw'
  }
  if (trashDirect === 200) pass('控制组：协议层对 .opennote/trash/旧页.html 返回 200')
  else fail('控制组失败：回收站页面在协议层不可读', 'net.fetch status = ' + trashDirect)

  // 元数据文件必须拿不到：403 或（被我方 CSP 拦成）网络错误都算通过。
  let secretStatus = null
  try {
    secretStatus = await win.webContents.executeJavaScript(
      'fetch(' + JSON.stringify(secretSrc) + ').then(function (r) { return r.status; }, function () { return "network-error"; })',
      true,
    )
  } catch (error) {
    secretStatus = 'network-error'
  }
  if (secretStatus === 403 || secretStatus === 'network-error') {
    pass('.opennote/sync.json 拿不到（403 或被拦）', 'status = ' + secretStatus)
  } else {
    fail('.opennote/sync.json 竟然可读', 'status = ' + secretStatus)
  }

  console.log(failures === 0 ? 'PROBE_OK' : 'PROBE_FAILED(' + failures + ')')
  win.destroy()
  app.exit(failures === 0 ? 0 : 1)
}).catch((error) => {
  fail('探针崩溃', error && error.stack ? String(error.stack).split('\n')[0] : String(error))
  app.exit(1)
})

// 兜底：任何情况下都不许挂着不退（CI 里挂住比失败更难查）。
setTimeout(() => {
  console.log('FAIL 探针超时（未在 30 秒内给出结论）')
  process.exit(1)
}, 30000)
