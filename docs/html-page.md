# HTML 页面

把 `.html` / `.htm` 文件放进笔记本文件夹，它就以**第二种页面类型**出现在树里：
打开是渲染好的页面本身（不是源码、不是要另开浏览器的附件），右上角有全屏按钮，
**恒为只读**。

这一页写四件事：它是什么、为什么是这么做的、边界在哪里、怎么验证。

---

## 1. 它是什么

| | Markdown 笔记 | HTML 页面 |
| --- | --- | --- |
| 怎么认 | 扩展名 `.md/.markdown/.mdown/.mkd/.txt` | 扩展名 `.html/.htm` |
| 打开后 | CodeMirror 编辑器（所见即所得） | iframe 里的**独立文档** |
| 能编辑吗 | 能 | **不能**，锁按钮显示锁定且不可点 |
| 标题从哪来 | 正文第一个 H1 → 文件名 | `<title>` → 第一个 `<h1>` → 文件名 |
| 标签 / 字数 | 从正文派生 | 不派生（为空） |
| 进回收站 | 是 | 是（**回收站里的页面照样能打开**） |

`.md` 与 `.html` 是**两种页面**，不是「一篇笔记的两种写法」。判据只有扩展名一条
（`src/lib/htmlPage.ts` 的 `pageKindOf()`）：从内容猜会让一篇写着 `<div>` 示例的
Markdown 笔记莫名其妙变成只读页面。

## 2. 渲染：为什么不是 srcdoc

一开始最省事的写法是把正文塞进 `<iframe srcdoc="...">`。它**不工作**，原因不在我们的配置：

> 子框架会**继承父文档的 CSP**。

应用窗口的策略是 `script-src 'self' file: 'sha256-…'`（桌面端在
`electron/main.cjs` 的 `cspPolicy()`，网页端在 `vite.config.ts` 的
`contentSecurityPolicyPlugin()`）。原型页面的脚本一律内联，于是会被**静默挡掉**：
页面看起来渲染了，但按钮点了没反应，只有 DevTools 里有一行 violation。

所以页面必须从一个**自带策略的 URL** 加载。两条路：

| 宿主 | 载体 | 策略从哪来 |
| --- | --- | --- |
| 桌面（Electron） | `opennote-page://page/<工作区相对路径>` | 主进程给每个响应加 `Content-Security-Policy` 头 |
| 网页 / PWA | `/__page/<token>`（Service Worker 合成） | SW 合成的响应带自己的 CSP |

桌面端用**路径**而不是 token：相对资源（`./logo.png`、`style.css`、CSS 里的 `url()`）
按文档 URL 解析，URL 与工作区同构时它们自然落到正确位置 —— 不用改写正文、不用内联。

### 页面的 CSP

```
default-src 'none';
script-src 'unsafe-inline' 'unsafe-eval';
style-src 'unsafe-inline' opennote-page:;   /* 网页版为 'unsafe-inline' */
img-src opennote-page: data: blob:;          /* 网页版为 data: blob: */
font-src …; media-src …;
object-src 'none'; base-uri 'none'; form-action 'none';
frame-ancestors …
```

两条刻意的省略：

- **没有 `connect-src`** ⇒ 落到 `default-src 'none'`，页面的 fetch / XHR / WebSocket 全被拦。
  原型页面本来就不该联网，这也是「页面拿不到同步凭据」之外的第二道闸。
- **`script-src` 里没有 `'self'`** ⇒ 页面不能 `<script src="../../index.js">` 去加载
  应用自己的打包产物（那等于把宿主代码拉进不可信上下文里跑）。

## 3. 隔离：两层，缺一不可

**第一层是 iframe 的 `sandbox`**：`sandbox="allow-scripts"`，**不含 `allow-same-origin`**。

页面因此是 opaque origin：读不到 `localStorage`（里面存着 `opennote.ui.v1` 与 GitHub
令牌）、摸不到 `window.parent.opennote`、也读不到工作区里别的文件。
`allow-scripts` 与 `allow-same-origin` **同时给等于没有沙箱** —— 页面可以直接操作父文档。
这条属性不会被类型系统拦住，所以有一条单测直接读 `HTML_PAGE_SANDBOX` 这个常量。

同时**不给**：`allow-top-navigation`（不能把整个应用导航走）、`allow-popups`、
`allow-forms`、`allow-modals`。

**第二层是 CSP 与协议白名单**（桌面端）。协议只服务当前打开的那个工作区，且：

| 路径 | 结果 | 理由 |
| --- | --- | --- |
| `.opennote/sync.json` | **403** | 存 E2EE 的 `did ↔ 路径` 映射，绝不能跨端 |
| `.opennote/github.json` / `state.json` / `hash-cache.json` | **403** | 远端配置与本地状态 |
| `.opennote/inbox/**` | **403** | 未确认的入库内容 |
| `.opennote/trash/**`、`.opennote/history/**` | **放行** | 回收站只是普通目录；不给看就等于「进回收站就再也看不到」 |
| 普通目录下的 `*.html` 与配套 css/js/png | 放行 | 相对资源按 URL 同构解析 |

读盘还过三层：纯函数规则 → `requireAuthorizedRoot` + `resolveInsideRoot`（词法在工作区内）
→ `assertRealPathInsideRoot`（realpath 之后仍在工作区内，挡 junction 越界）。

## 4. 只读：是**类型**，不是一把锁

HTML 页面恒为只读，而且这个只读**不写进 `ui.lockedNotes`**：

- 它是页面类型的属性，不是一个能点掉的锁；
- 写进去会留脏数据 —— 用户把 `.html` 改名成 `.md` 之后，那篇笔记会莫名带着一把锁；
  删掉页面之后 `lockedNotes` 里还留着永久残留的 id。

界面上看到的「锁定」是 `activeLocked || activeForceLocked` 的**合成结果**，锁按钮
`disabled` 且换一句专属 `title`（点了没反应又不说明原因，比按钮不存在更糟）。
`onToggleLock` 里还有一道 early return：命令面板与将来的自动化都会绕过 `disabled`。

连带受影响的地方：

- 打开 HTML 的标签**不挂 CodeMirror 实例**（后台挂一个看不见的可编辑器会抢 focus、
  注册输入法合成，还会让 `viewRef` 指向一个用户看不见的文档）；
- 状态栏把「字数 / 行列」换成一句「只读页面」（这两组数字对页面没有意义，
  显示一排永远为 0 的数字比不显示更糟）；
- 「复制为 Markdown / 导出 Markdown / 创建副本」对页面整条禁用，且在**处理函数**里
  再挡一次 —— 命令面板的 `enabled` 挡不住快捷键。

## 5. 全屏

右上角悬浮按钮，`requestFullscreen()` 优先；被拒（非用户手势、WebView、权限策略）
时退化成铺满视口的浮层，并如实提示「已改为应用内全屏」。

两个决定：

- **状态的真相是 `fullscreenchange` 事件**，不是组件 state。用户按 Esc、用系统手势、
  切窗口都能退出，只听按钮会让「按了 Esc 但界面还标着全屏」成为常态。
- **不重建 iframe**。重新挂一棵子树 = 页面重新加载，滚动位置、表单内容、动画进度全丢。
  按钮与被全屏的容器在同一个组件里，React 只切 class。

## 6. 已知边界

| 情况 | 行为 |
| --- | --- |
| 空文件 / 只有 `<head>` 与脚本 | 显示「这个页面没有内容」，不是一片空白 |
| 页面引用的远程图片 | 不显示（CSP 不放 https）—— 与桌面版既有的 `img-src` 裁决一致 |
| 页面的 fetch / XHR / WebSocket | 被 CSP 拦（没有 `connect-src`） |
| 网页版 CSS 里的 `url()` 相对资源 | **不解析**（SW 只合成文档本身）；需要把图片内联成 `data:` 或在正文里用 `<img>` |
| 网页版首次打开、SW 还没接管 | 提示「页面模式还没准备好，刷新一次即可」（不假装成功） |
| 网页版 SW 被系统回收 | 下次打开重新 stage；`/__page/<token>` 未 stage 时返回 404 |
| 页面里 `target="_blank"` 的链接 | 桌面端交给系统浏览器（`hardenWebContents` 的既有行为）；沙箱内不能开窗 |
| 页面过大 | 桌面协议对单个响应有上限；超出时按读取失败处理 |

## 7. 怎么验证

```
pnpm typecheck:all          # 应用 + shared + server + sw（四份 tsconfig）
pnpm test                   # 含下列 HTML 专属用例
pnpm check:boundaries
node scripts/ipc-safety-check.cjs
node scripts/verify-contract.cjs
pnpm build                  # 网页版：确认 injectManifest 产出 dist/sw.js
pnpm probe:page             # 真实 Electron：协议 + 沙箱 iframe 的端到端探针
```

HTML 专属的用例（都在 `pnpm test` 里）：

| 文件 | 钉住什么 |
| --- | --- |
| `src/lib/htmlPage.test.ts` | 标题取谁、空页面怎么认、摘要按码点截断、实体解码 |
| `src/lib/pageStage.test.ts` | 网页版载体：路由拼接、**没有 SW / 手机壳 / 未接管时如实失败**、别人的回执不认、释放 |
| `src/data/library.files.test.ts`（「HTML 页面」一节） | 扫描进树、标签/字数归零、Markdown 派生一格不变、回收站往返 |
| `src/desktop/pageProtocol.test.ts` | 路径 ⇄ URL 往返、`.opennote/` 精确边界、编码分隔符拒绝、CSP 形状 |
| `src/components/htmlPage.test.ts` | 三态渲染、全屏按钮存在、**sandbox 不含 `allow-same-origin`** |
| `scripts/page-protocol-probe.cjs`（`pnpm probe:page`） | **真实 Chromium** 里的一次性验证：内联脚本真的跑、相对资源能解析、沙箱摸不到 parent/localStorage、fetch 被拦、回收站页面可读、`.opennote/sync.json` 协议层 403 且回收站 200（控制组） |

真机手动验证（桌面端最值得先做的四条）：

1. 往笔记本里放 `原型/登录页.html`（带一段内联脚本与一张同目录图片）→ 树里出现、
   点开是页面、脚本生效、图片显示；
2. 锁按钮是锁定的、点不动，hover 有说明；切到 Markdown 笔记后一切照旧；
3. 点全屏 → 页面铺满 → 按 **Esc** → 回到原来的位置（滚动位置没丢）；
4. 把 `.opennote/sync.json` 写成 `<img src="opennote-page://page/.opennote/sync.json">`
   放进一个页面 → 图裂（403）。

---

## 附：改动清单

| 文件 | 作用 |
| --- | --- |
| `shared/paths.ts` | `isHtmlPagePath()` / `isPagePath()`；`isMaterializable()` 认页面 |
| `src/data/types.ts` | `PageKind` + `Note.kind` |
| `src/lib/htmlPage.ts` | 纯函数：类型判定、标题、空页面、摘要 |
| `src/data/library.ts` | 扫描与增量刷新认页面；`makeNote` / `refresh` / `createNote` 按 kind 分流 |
| `src/components/HtmlPageView.tsx` | 双通道 + 三态 + 全屏按钮 |
| `src/components/PageFullscreen.tsx` | 全屏 hook（`fullscreenchange` 为真相） |
| `electron/pageProtocol.cjs` | 协议纯函数：URL ⇄ 路径、CSP、MIME、`.opennote/` 规则 |
| `electron/main.cjs` | `registerPageScheme` / `installPageProtocol` / `opennote:page:urlFor` |
| `electron/preload.cjs`、`src/desktop/bridge.ts` | `page.urlFor()` |
| `src/sw.ts` + `vite.config.ts` + `tsconfig.sw.json` | 网页版：`injectManifest` 的 SW，合成 `/__page/<token>` |
| `src/lib/pageStage.ts` | 网页版 page 载体：等 controller、stage / 释放、手机壳如实拒绝 |
| `src/components/TabBar.tsx`、`StatusBar.tsx`、`Sidebar.tsx`、`App.tsx` | 只读合成、图标与摘要、字数让位、命令闸门 |
| `src/lib/import.ts` | 导入按源扩展名落盘 |
| `scripts/page-protocol-probe.cjs`、`scripts/run-page-probe.mjs` | 真实 Electron 的端到端探针（`pnpm probe:page`） |
