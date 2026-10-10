# 探针工程 · 编辑器「位置跳动」实测

这是 [`证据-浏览器实测报告-位置跳动.md`](../证据-浏览器实测报告-位置跳动.md) 的**可运行工程**，原样归档自 `.tmp-verify/jump-probe/`（该目录在 `.gitignore` 里，会被清理）。

## 怎么重跑

`run.sh` 里的路径是按 `.tmp-verify/jump-probe/` **硬编码**的（`ROOT` 靠 `../../` 推仓库根、`URL` 指向 `.tmp-verify/jump-probe/index.html`）。所以先把它放回去：

```bash
cd /e/repo/opennote
mkdir -p .tmp-verify/jump-probe
cp -r docs/editor-ux/probe/. .tmp-verify/jump-probe/

bash .tmp-verify/jump-probe/run.sh          # 全部场景 A–E
bash .tmp-verify/jump-probe/run.sh A D      # 只跑指定场景
bash .tmp-verify/jump-probe/run.sh stop     # 收工（Chrome 会留在后台）
```

**前提**：仓库根目录已 `pnpm install`；Chrome 在 `/c/Program Files/Google/Chrome/Application/chrome.exe`；端口 5199（vite）与 9222（CDP）空闲。

**产物**：`.tmp-verify/jump-probe/out/*.json`（原始 JSON）+ 终端摘要。已归档的终端摘要见 [`SUMMARY.txt`](SUMMARY.txt)。

## 文件

| 文件 | 作用 |
|---|---|
| `probe.ts` | 探针主体：挂载**真实的** `livePreviewField` / `markdownSupport` / `editorTheme` / `editor.css`，暴露 `PROBE.runA()…runE()` |
| `index.html` | 探针页面（vite 入口） |
| `vite.config.mts` | 独立 vite 配置（端口 5199） |
| `run.sh` | 一键：起 vite → 起 Chrome headless → 跑场景 → 打印摘要 |
| `cdp.mjs` | CDP 驱动（`scripts/cdp-eval.mjs --file` 有既有 bug：`readFile` 没 `await`，页面收到 `[object Promise]`。这里自带修好的版本，**没有改共享脚本**） |
| `summary.mjs` | 把 `out/*.json` 汇总成终端摘要 |
| `measure/` | 针对特定问题的临时测量脚本（`trace-scrolltop.js` 用 setter 拦截抓 `scrollTop` 的写入者、`trace-anchor.js` 给 `lineBlockAt`/`scrollAnchorAt` 打桩） |

## 注意

- 探针是「真实编辑器模块 + 真实样式 + 真实字体」的**独立页面**，没有 React 外壳、没有标签栏/大纲栏、没有桌面端的 `devicePixelRatio` 差异。**位移的方向与机制可直接外推，绝对像素值会随字号/行宽/DPI 变化**（实测用的是默认 `--doc-fs: 16.5px`、`--doc-lh: 1.78`、`--measure: 46rem`）。
- `run.sh` 会 `taskkill //F //IM chrome.exe`（第 42 行）—— **它会杀掉你正在用的 Chrome**。跑之前先存好手头的东西。
- 键入触发的跳动（在表格/代码块里打字、回车、粘贴）**没有测**，报告 §7 已如实写明。
