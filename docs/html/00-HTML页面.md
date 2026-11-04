# HTML 页面：设计与交付说明

> 分支 `feat/html2`。本文是这次交付的单一说明：需求怎么落地、改了哪些文件、安全模型、
> 三端兼容、风险与边界、测试与验收。代码里的注释是细节的权威出处，本文只给全景。

## 1. 需求 → 落地

| # | 需求 | 落地 |
| --- | --- | --- |
| 1 | HTML 成为可打开的页面类型，与 Markdown 并列 | `NoteKind` 增加 `"html"`；`.html` / `.htm` 与 `.md`、`.canvas` 同一条扫描 / 外部变更 / 树 / 标签 / 搜索 / 同步链路 |
| 2 | 打开即渲染，不是源码、不是编辑器 | `src/html/HtmlView.tsx`：沙箱 iframe 渲染整页；`EditorPane` 只收 Markdown 标签，HTML 标签不建 CodeMirror 实例 |
| 3 | 应用内不可修改；锁显示「锁定」、不能解锁 | 标签栏锁按钮 `locked && disabled`（`.tabbar__lock--fixed`，强调色、不可点，悬浮说明「HTML 页面只读，不能解锁编辑」）；数据层 `updateNoteContent()` 拒收（双保险）；历史版本「恢复」禁用 |
| 4 | 右上角悬浮全屏按钮，退出回到原页面 | Fullscreen API 放大整个面板（iframe 不换父节点、不重载，页面状态保留）；不支持的环境退回铺满窗口的伪全屏，Esc / 再点退出 |
| 5 | 复用打开 / 路由 / 权限 / 状态机制，不影响 Markdown | 复用 `openNote` / 标签 / `ui.lockedNotes` 之外的全部既有机制；Markdown 分支逻辑零改动（`noteKind === "note"` 的路径不变，2341 条既有测试全绿） |
| 6 | 安全与兼容：网页版、桌面版尽量兼容 | 独立宿主页 + 不透明源沙箱 + 独立 CSP；应用本体 CSP 不放宽。网页 / 桌面 / Android 同一套机制（§4） |
| 7 | Skill 入库 HTML（含 JS、CSS、静态资源），默认收件箱，支持预览 | 信封扩展 `format: "html"` + `resources[]`；Skill 自动收集资源；收件箱「预览」即入库后的那一页；入库时内联成单个 `.html` |

## 2. 核心设计决策

### 2.1 磁盘形态：一个页面 = 一个自包含的 `.html`

入库 / 导入时，页面引用的 CSS / JS / 图片 / 字体 / 音视频**内联进同一个文件**
（`<link rel=stylesheet>` → `<style>`；其余 → `data:` URL）。理由：

- **同步只需认一个扩展名**。`isMaterializable()` 加 `isHtmlPath` 即可；散落的 `.css` / `.js` 若进物化判据，
  就是那个已知事故（把仓库源码写进笔记本再推回去）。
- **任何设备、任何浏览器双击即完整**；导出就是原样下载这个文件。
- 用户手工拷进笔记本的散装目录（`report/index.html + style.css`）也能看：渲染时对工作区再跑一次同一个内联器
  （只认页面目录下、白名单格式的文件）。但这类散装资源**不会同步**到其他设备 —— 想跨设备，请走导入 / 入库。

内联规则只有一份：`src/html/bundle.ts` 的 `inlineHtmlResources()`，被入库、导入、渲染、收件箱预览四处共用。
它是一个只认标签边界与属性的小扫描器（不是 DOM 往返），不认识的内容原样拷贝，对已内联的页面再跑一遍是幂等的。

### 2.2 渲染：独立宿主页，而不是 `srcdoc`

`srcdoc` / `blob:` / `data:` 文档会**继承父页面 CSP**，而应用 CSP 不放行内联脚本 —— 页面 JS 一行都跑不起来。
给应用放开 `'unsafe-inline'` 等于拆掉整个应用的 XSS 防线，不可接受。

所以页面渲染在 `public/html-sandbox.html`（随包分发的静态文件）里：它以普通导航加载（不继承父 CSP），
自带一份**只给页面内容用**的宽松策略；父页面经 `postMessage` 把文档交给它，它 `document.write` 进去。
协议：宿主页 → `opennote:html:ready` → 父页面 → `opennote:html:render {html}`。换文档 = 重建 iframe。

## 3. 安全模型

| 威胁 | 防线 |
| --- | --- |
| 页面读应用数据（localStorage / IndexedDB / OPFS / Cookie / 父 DOM） | `sandbox="allow-scripts"`，**没有** `allow-same-origin` → 不透明源（实测 `origin=null`、localStorage 抛错、读父页面抛错） |
| 页面调用桌面能力 | preload 桥只注入主框架；沙箱页里没有 `window.opennote` |
| 页面把应用导航走 / 弹窗 / 提交表单 | 无 `allow-top-navigation` / `allow-popups` / `allow-forms`；CSP `form-action 'none'` |
| 页面把数据发出去 | CSP `connect-src data: blob:`（实测远端 `fetch` 被拦）。注意：页面可经 https 加载图片/脚本（为了 CDN 图表库与字体），所以「页面自己的内容」理论上可经图片 URL 带出 —— 页面能读到的只有它自己（见下一行） |
| 恶意页面借相对引用读别的笔记 | 内联器只认页面目录**之下**、**白名单扩展名**（无 `.md` / `.canvas` / `.html`）、**无点开头段**的路径；`../`、`.opennote/` 一律不读 |
| 外链 | 注入的点击拦截把 `http(s)` / `mailto` 交给父页面；父页面仅在**真实用户点击**（`navigator.userActivation.isActive`）时打开（桌面版 → 系统浏览器，网页版 → 新标签）。页面脚本自发的消息拿不到用户激活 |
| 页面脚本把子框架导航到别处 | 桌面版：`will-frame-navigate` 只放行宿主页 / `about:blank`；网页版：框架仍在沙箱里，无害（与浏览器打开任意网页同级） |
| 应用本体 CSP 被削弱 | 网页版只显式加 `frame-src 'self'`（本来就由 `default-src 'self'` 覆盖）；桌面版加 `frame-src file:`，宿主页的宽松策略**只**按精确文件路径（`dist/html-sandbox.html`）下发 |

CSP 唯一产地：`src/html/sandbox.ts` 的 `HTML_SANDBOX_CSP`；`public/html-sandbox.html` 的 meta 与 `electron/main.cjs`
的同名常量是副本，由 `src/html/sandbox.test.ts` 逐字钉住。

## 4. 三端兼容

| 能力 | 网页版（PWA） | 桌面版（Electron） | Android（Capacitor） |
| --- | --- | --- | --- |
| 宿主页加载 | 同源静态文件，进 SW 预缓存（离线可用） | `file://…/dist/html-sandbox.html`，主进程按路径下发沙箱 CSP | 随包分发 |
| 脚本运行 | ✅（已在 Chrome 实测） | ✅（机制同网页版，**未在真机跑过**，见 §8） | ✅（无 meta CSP，机制同上） |
| 全屏 | Fullscreen API | HTML 全屏 → 窗口全屏 | 伪全屏兜底（多数 WebView 不给元素全屏） |
| 外链 | 新标签 | `shell.openExternal`（仅 http(s)） | `window.open` |
| 散装资源渲染 | FSA / OPFS 后端均可读 | ✅ | ✅ |

**自托管部署注意**：反向代理不能给 `html-sandbox.html` 加 `X-Frame-Options: DENY` 或
`frame-ancestors 'none'`（同源 `SAMEORIGIN` 可以）。宿主页 8 秒没报到时，界面会如实提示这一点。

## 5. 涉及文件

**新增**

| 文件 | 作用 |
| --- | --- |
| `src/html/bundle.ts` | 资源内联器、路径判据（`resolveLocalRef` / `normalizeResourcePath`）、MIME 白名单、`<title>` 与纯文本提取 |
| `src/html/sandbox.ts` | 沙箱协议、令牌、`HTML_SANDBOX_CSP`、文档注入（CSP meta + 外链拦截） |
| `src/html/HtmlFrame.tsx` | 沙箱 iframe（页面视图与收件箱预览共用） |
| `src/html/HtmlView.tsx` | 页面标签内容区 + 悬浮全屏按钮 |
| `src/html/workspace.ts` | 渲染前对工作区散装资源的内联 |
| `public/html-sandbox.html` | 沙箱宿主页 |
| `src/html/*.test.ts`、`src/data/library.html.test.ts`、`src/lib/clip/envelope.html.test.ts` | 测试（§7） |

**修改**

| 文件 | 改动 |
| --- | --- |
| `shared/paths.ts`、`src/fs/paths.ts` | `isHtmlPath`；并入 `isMaterializable`（同步 / GitHub / 导入共用） |
| `src/data/types.ts` | `NoteKind` 加 `"html"`；`isReadOnlyKind()` |
| `src/data/library.ts` | 扫描 / 外部变更收编；`makeNote` / `refresh` 的 html 分支；`updateNoteContent` 拒收；不参与自动改名；副本保留扩展名（`createFileNote`）；附件重算跳过；搜索用页面纯文本 |
| `src/App.tsx` | 标签分发到 `HtmlView`；锁固定锁定；大纲 / 阅读视图 / 正文宽度对 html 关闭；导出 = 原样下载、打印给提示、复制提示「HTML 源码」；命令面板「创建副本」改走数据层（顺带修了画布副本会变成 `.md` 的旧问题）；导入接受 `.html,.htm` |
| `src/components/TabBar.tsx` | `lockHint`；`locked && disabled` 的固定锁定样式 |
| `src/components/StatusBar.tsx` | html 标签显示「HTML 页面 · 只读」，隐藏行列 |
| `src/components/AppDialogs.tsx` | 历史版本：html 可看不可恢复 |
| `src/components/InboxPanel.tsx` | html 条目预览走沙箱；落点文件名 `.html`；不给「追加」提示 |
| `src/components/Icons.tsx` | `expand` / `shrink` 两个图标（同一套 1.7 描边） |
| `src/styles/app.css` | `.html-pane`、全屏按钮、`.tabbar__lock--fixed`、收件箱预览框 |
| `src/lib/clip/envelope.ts` | `format` / `resources[]` 校验与序列化（Markdown 信封逐字节不变） |
| `src/lib/clip/receive.ts` | 外置资源读盘、去重哈希算上资源、`commitHtmlPage` / `createNewHtml` |
| `src/lib/clip/landing.ts` | `requestedNotePath(…, ext)` |
| `src/data/inbox.ts` | `body.html` + `resources/` 暂存、提交时转 `dataBase64`、`readInboxHtmlPreview()`、入库后清暂存 |
| `src/desktop/bridge.ts` | 信封类型加 `format` / `resources` |
| `src/lib/import.ts` | `.html` 导入；zip 与文件夹导入内联同批资源 |
| `src/lib/export.ts` | `exportHtmlPage()` |
| `electron/main.cjs` | `frame-src file:`；宿主页专属 CSP；`will-frame-navigate` 守卫 |
| `vite.config.ts` | 网页版 CSP 显式 `frame-src 'self'` |
| `.agents/skills/opennote-ingest/**` | 脚本支持 `.html`（资源收集、`--include`、`body.html` + `resources/`）；SKILL.md 与契约速查 |

## 6. 边界情况

| 情况 | 行为 |
| --- | --- |
| 页面引用了但没随附的本地资源 | 入库警告「N 个本地资源没有随附」，原引用保留（打开时缺失，与浏览器 404 一致）；Skill JSON 里 `missingResources` 提前报出 |
| 随附了但页面没直接引用（脚本 `fetch` 的数据） | 不写进页面，入库警告；**运行时 `fetch` 相对路径不可用**（已知边界） |
| ES 模块相对 `import` | 入口模块变 `data:` 后相对 `import` 无法解析（已知边界） |
| `<base href>` | 不参与解析（沙箱里相对的是宿主页 URL） |
| `../` 越出页面目录、`.hidden/` | 不收、不读、不内联 |
| 已内联页面再次导入 / 渲染 | 幂等，一字节不变 |
| 同一页面只改了 CSS 再投递 | 去重哈希算上资源 → 新建 `X 2.html`，不会被判 duplicate 丢掉 |
| `conflict: append / overwrite` | 降级为新建 + 警告（HTML 没有追加语义） |
| 外部工具改了磁盘上的 `.html` | 照常读进来并重渲染（只读的是「应用内」） |
| 回收站里的页面 | 照常打开渲染，仍只读 |
| 页面切走时处于全屏 | 卸载时退出全屏 |
| 深色主题 | 页面保持白底（页面自带版式，不强行套主题） |
| 大页面 | 单页内联后上限 24 MiB；页面全文常驻内存（与画布同口径） |
| 旧版应用收到 `format: "html"` | 不认识扩展字段，会当 Markdown 入库 —— 扩展字段的固有代价，记在契约速查里 |
| 沙箱宿主页加载失败 | 8 秒后显示原因与自托管排查提示，不留白屏 |

## 7. 测试

```bash
pnpm typecheck && pnpm check:boundaries && pnpm test
```

本次结果：三套类型检查（client / shared / server）与边界检查通过；**144 个测试文件、2341 条用例通过**，其中新增 5 个文件 47 条（另在 `shared/paths.test.ts` 补 2 条）。全量并行时 `src/editor/livePreview.test.ts` 的随机化性能用例偶发 5 秒超时，单独运行通过，与本次改动无关。

| 文件 | 钉住什么 |
| --- | --- |
| `src/html/bundle.test.ts` | 路径判据的安全边界；link/script/img/srcset/poster/style/SVG 改写；CSS `url()`/`@import` 递归与循环；`</style>` 转义；缺失 / 越界 / 非白名单 / 超限；幂等；纯文本提取 |
| `src/html/sandbox.test.ts` | 沙箱令牌不含 same-origin/top-navigation/popups/forms；CSP 内容；**三份 CSP 副本逐字一致**；注入位置 |
| `src/html/ingest.e2e.test.ts` | Skill 条目 → 收件箱识别 → 预览已内联 → 真实接收端入库成单文件 → kind=html、只读、副本、搜索；信封直传、降级警告、资源去重哈希 |
| `src/data/library.html.test.ts` | 扫描收编、CRLF 原样、外部改动读入、写入拒收、改名保留扩展名、不参与自动改名、搜索口径 |
| `src/lib/clip/envelope.html.test.ts` | `format` 缺省 / 非法；资源归一与拒绝项；上限；Markdown 信封序列化不变 |
| `shared/paths.test.ts` | `isHtmlPath`；`isMaterializable` 认 `.html` 不认 css/js |

**真机验证（Chrome，`vite build` + `vite preview`，即生产 CSP）**：浏览器笔记本里放入 `交互演示.html`
+ `demo/style.css` + `demo/app.js` → 打开即渲染、外部 CSS 生效、内联与外部脚本都运行、按钮交互正常；
页内探测「localStorage 被拒 / 父页面隔离 / origin=null / 远端 fetch 被拦」全部符合预期；锁为锁定且禁用；
全屏按钮进入元素全屏、退出后页面状态（计数器）保留；外链在新标签打开、沙箱本身不跳走；收件箱 HTML 条目预览
CSS / JS 生效，点入库后落成单个 `.html`（无 `<link>`、脚本已内联）。Skill 脚本对一个含 `@import`、
`srcset`、`../` 越界与缺失引用的目录做了 dry-run 与真实投递，收集结果正确。

## 8. 验收标准

1. 笔记本里任意 `.html` / `.htm` 出现在文件树中，点击打开为渲染后的页面（不是源码、不是编辑器）。
2. 页面里的 CSS、内联脚本、外部脚本（入库 / 导入后已内联）正常生效，交互可用。
3. 标签栏的锁显示为「锁定」，不可点击；命令面板的编辑类命令不可用；历史版本不能「恢复」；磁盘文件不会被应用改写。
4. 右上角悬浮全屏按钮：进入全屏后整页铺满；Esc 或再次点击退出，回到原标签，页面状态不丢。
5. 页面无法读取应用存储与父页面、无法发起远端请求、无法导航应用；外链只在用户点击后在外部打开。
6. Markdown 笔记的编辑、阅读视图、锁、大纲、导出、同步行为与改动前一致（既有测试全绿）。
7. `node opennote-ingest.mjs <页面.html>` 默认进收件箱；收件箱「预览」显示完整页面（含 CSS / JS / 图片）；点入库后得到单个 `.html` 页面；`missingResources` 与入库警告如实报告缺失资源。
8. 网页版（生产构建）与桌面版均可渲染；宿主页加载失败时有明确提示。

## 9. 风险与未完成

- **桌面版没有在 Electron 真机里跑过**。机制与网页版相同、`node --check` 与 CSP 副本一致性测试通过，但
  `file://` 子框架 + `will-frame-navigate` 守卫 + 按路径下发 CSP 这三处需要一次 `pnpm dev:electron`
  与打包版的手测（打开页面、全屏、点外链）。**建议合并前补测。**
- `will-frame-navigate` 若在某个 Electron 版本对子框架的**首次加载**也触发且判定失误，会表现为白屏 + 8 秒后的失败提示；判据见 `isHtmlSandboxUrl()`。
- 允许页面经 https 加载远端脚本 / 样式 / 图片 / 字体是为兼容 CDN 图表库的取舍；代价是打开页面会向这些站点发请求（IP / 时间可被记录）。若要收紧为纯离线，只需把 `HTML_SANDBOX_CSP` 里的 `https:` 去掉（三份副本一起改，测试会提醒）。
- 渲染在 Claude 桌面应用的内置预览面板里会被面板自身拦截（不透明源子框架请求 `ERR_BLOCKED_BY_CLIENT`），与真实浏览器无关；验证请用 Chrome / 桌面版。
- 既有问题（**非本次引入**）：收件箱在信封目录不存在时提示「入库时会存到根目录」，但实际会按信封目录新建并落盘。Markdown 条目同样如此，Skill 推荐的 `--folder "Agent 产出"` 首次入库必然遇到。
