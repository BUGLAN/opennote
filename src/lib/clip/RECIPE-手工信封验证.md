# 手工信封验证配方（CLI / 脚本通道）

> 目标：**不写任何产品代码**，用手写的一段信封 JSON 走**真实本地桥**，然后把落盘的字节读回来逐条断言。
> 这是最终验收里「CLI / 脚本通道」那条的直接证据。
> 维护者：C1（L2 接收端）。本文件在 `src/lib/clip/` 内，不被任何模块 import，纯文档。

---

## 0. 准备（30 秒）

1. 打开 Opennote 桌面版，打开一个**临时工作区**（别用真笔记库）。
2. 进 `设置 · 文件 · 导入与接口`，点「启用本地接口」，把**端口**和**令牌**复制出来。
3. PowerShell 里设三个环境变量（令牌形如 `opn_xxx`）：

```powershell
$env:OPNN_PORT  = '8737'                      # 设置面板里显示的端口
$env:OPNN_TOKEN = 'opn_你的令牌'               # 设置面板里复制的那串
$env:OPNN_WS    = 'C:\Users\me\opennote-临时'  # 上面打开的那个工作区目录（绝对路径）
```

---

## 1. 方式 A（推荐）：一段完整命令，直接跑

**把下面整块复制进 PowerShell 回车即可**（`@'` … `'@` 是 PowerShell here-string，不需要转义引号）：

```powershell
node --input-type=module -e @'
import { existsSync, readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";

const port = process.env.OPNN_PORT, token = process.env.OPNN_TOKEN, ws = process.env.OPNN_WS;
const die = (m) => { console.error("FAIL " + m); process.exit(1); };
const ok = (m) => console.log("PASS " + m);
if (!port || !token || !ws) die("先设置 OPNN_PORT / OPNN_TOKEN / OPNN_WS");

// ── 手写信封（字段名逐字来自 docs/import/02-接口契约-导入信封与通道.md §2）──
const envelope = {
  spec: "opennote.import/v1",
  importId: randomUUID(),
  title: "手工信封验证",
  body: "# 手工信封验证正文 H1 应被降级\n\n第二段。\n",
  source: {
    url: "https://example.com/manual-recipe",
    title: "手工信封 · 来源标题",
    site: "example.com",
    author: "验证者",
    publishedAt: "2026-09-29T12:00:00+08:00",
    capturedAt: new Date().toISOString(),
    selection: false,
  },
  target: { folder: "剪藏/手工", notePath: null },
  conflict: "new",
  tags: ["剪藏", "手工"],
  client: { name: "cli", version: "0.2.0" },
};

const res = await fetch(`http://127.0.0.1:${port}/v1/import`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
  body: JSON.stringify(envelope),
});
const raw = await res.text();
let payload = null;
try { payload = JSON.parse(raw); } catch { die(`响应不是 JSON（HTTP ${res.status}）：${raw.slice(0, 200)}`); }
if (res.status !== 201) die(`HTTP ${res.status}（期望 201）：${raw.slice(0, 300)}`);
const receipt = payload.ok === true && payload.result ? payload.result : payload;
if (receipt.status !== "created") die(`status=${receipt.status}（期望 created）`);
if (receipt.path === null) die("created 的 path 不能是 null");
if (receipt.revertible !== true) die("created 必须 revertible=true");
ok(`HTTP 201 · status=created · path=${receipt.path} · importId=${receipt.importId}`);

// ── 落盘字节断言 ──
const file = path.join(ws, receipt.path);
if (!existsSync(file)) die(`文件不存在：${receipt.path}`);
const buf = readFileSync(file);
if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) die("文件带 BOM");
const text = buf.toString("utf8");
if (text.includes("\r")) die("文件里有 CR（必须 LF only）");
if (!text.endsWith("\n")) die("末尾没有换行");
if (text.endsWith("\n\n")) die("末尾多于一个换行");
if (!text.startsWith("---\n")) die("首字节不是 front-matter 起始 `---\\n`");

const end = text.indexOf("\n---\n", 4);
if (end < 0) die("front-matter 没有闭合的 `---`");
const keys = text.slice(4, end).split("\n").map((line) => line.slice(0, line.indexOf(":")));
const expected = ["source", "source_title", "source_site", "author", "published_at", "captured_at", "tags", "opennote_import_id"];
if (keys.join(",") !== expected.join(",")) die(`front-matter 键顺序不对：${keys.join(",")}（期望 ${expected.join(",")}）`);
ok(`front-matter 8 键顺序逐字正确：${keys.join(", ")}`);

const after = text.slice(end + 5);
if (!after.startsWith("\n# 手工信封验证\n")) die(`正文块起始不对：${JSON.stringify(after.slice(0, 40))}`);
if (!after.includes("## 手工信封验证正文 H1 应被降级")) die("正文首行 H1 没有被降级为 H2");
if (!text.endsWith("第二段。\n")) die("正文末尾不对（应恰好一个换行）");
if (!text.includes(`opennote_import_id: ${envelope.importId}`)) die("front-matter 里的 importId 不对");
if (!/^tags: \[剪藏, 手工\]$/m.test(text)) die("tags 行不是 `tags: [剪藏, 手工]`");
ok(`正文：空行 + \`# <title>\` + H1 降级 + 末尾一个换行；文件 ${buf.length} 字节`);
console.log("== 手工信封验证通过 ==");
'@
```

期望输出：

```text
PASS HTTP 201 · status=created · path=剪藏/手工/手工信封验证.md · importId=…
PASS front-matter 8 键顺序逐字正确：source, source_title, source_site, author, published_at, captured_at, tags, opennote_import_id
PASS 正文：空行 + `# <title>` + H1 降级 + 末尾一个换行；文件 NNN 字节
== 手工信封验证通过 ==
```

### 想存成文件重复跑（可选）

```powershell
@'
把上面 @' … '@ 之间的 JS 原样贴进来
'@ | Set-Content -Encoding utf8 "$env:TEMP\recipe-import.mjs"
node "$env:TEMP\recipe-import.mjs"
```

---

## 2. 方式 B（无 Electron / 离线兜底）

没有桌面版可跑时，用仓库自带的测试当驱动（同一套字节断言，内存后端）：

```powershell
npx vitest run src/lib/clip/ src/data/importLog.test.ts
```

⚠️ 这条路是**实现者自证**，不是独立验证 —— 最终验收请用方式 A（真桥 + 真磁盘）。

---

## 3. 变体：手写更多信封（改 `envelope` 里的字段即可）

| 想验什么 | 改哪里 | 期望 |
|---|---|---|
| 幂等（同一次导入重投） | `importId` 不变，其余照旧 | HTTP **200**、`status=deduped`、`dedupedBy="importId"`、`path` 是**首次**落点、文件字节不变 |
| 重复内容（新 id、同 URL 同正文） | `importId=randomUUID()`，`body` 不变 | HTTP **200**、`status=duplicate`、`deduped=true`、`dedupedBy="contentHash"`、**零写入** |
| 选区二次剪藏（追加） | `source.selection=true`、`body` 改一段 | HTTP **200**、`status=appended`、`revertible=true`、`preimage{path,bytes,sha256}` 齐备、原文逐字节保留为前缀 |
| 整页二次剪藏（进收件箱） | `selection=false`（缺省）、`body` 改一段 | HTTP **202**、`status=pending`、`path=null`、`inboxId` 是**收件箱目录名**（`20260929T132929-<importId 前 8>`） |
| 没有工作区 | 关掉笔记本再投 | HTTP **409**、`code=IMP-4007`、`retryable=true`、**磁盘零残留** |
| 信封不是 JSON 对象 | 把 `JSON.stringify(envelope)` 换成 `"[]"` | HTTP **400**、`code=IMP-4001` |
| 目录写不进去 | `target.folder = "..\\..\\etc"` | HTTP **422**、`code=IMP-4008` |

> 每个变体都建议先 `importId=randomUUID()`，避免幂等命中把结果吃掉。

---

## 4. 断言清单（为什么是这几条）

| 断言 | 依据 |
|---|---|
| HTTP 201 / 202 / 200 | `02` §4.1 判定链的 HTTP 列（桥优先用回执里的数字 `status`） |
| `status` 六值逐字 | `02` §4.5 |
| front-matter **8 键顺序** | `02` §3.2（`source → source_title → source_site → author → published_at → captured_at → tags → opennote_import_id`） |
| 首字节是 `---\n`、无 BOM | `02` §3.2 字节模板 |
| 末尾恰好一个 `\n`、全文无 `\r` | `02` §3.2 / §3.5 |
| 正文 H1 降级为 H2 | `02` §3.2（避免同一文件两个 H1） |
| `tags: [剪藏, 手工]` 行内数组 | `02` §3.2 规则 9（不匹配 `[\p{L}\p{N}_\-/]` 才加引号） |

## 5. 已验证到什么程度（如实）

- 上面那段 JS 是**从本文件里原样抽出来**跑的（不是另抄一份），结果：
  - 正常桩（响应形状 `{ok:true,result:{…}}` + 按契约字节写盘）→ 三行 PASS，退出码 0；
  - 故意把 `tags` 放到 `author` 之前 → `FAIL front-matter 键顺序不对：…（期望 …）`，退出码 1；
  - 故意在末尾多一个换行 → `FAIL 末尾多于一个换行`，退出码 1。
  - 也就是说：这段脚本的断言**确实会红**，不是摆设。
- **桩只替代「Electron 窗口 + 真接收端」这一层**；真通道的等价证据在 `node scripts/verify-e2e.cjs`：`S1.2` 插件侧真发 HTTP、`S1.3~S1.9` 真磁盘字节断言（8 键顺序/首行 H1/末尾一个换行/无 CR）、`S5.x` 收件箱与目录名、`S8.2` 收件箱满。
- 未验证：真机 Chrome 扩展、真实窗口渲染（像素级）—— 见 E2E 里的 UNVERIFIED 项。
