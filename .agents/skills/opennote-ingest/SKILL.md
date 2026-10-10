---
name: opennote-ingest
description: 把 Agent 生成的 Markdown 文档入库到本机 Opennote 笔记本。当用户说「入库」「存进我的笔记」「存进 Opennote」「把这些文档归档到笔记」「剪藏到 Opennote」时使用。默认投递到 Opennote 收件箱等用户确认，绝不改写或覆盖既有笔记。
whenToUse: 用户要求把本次会话产出的文档、报告、分析、笔记片段存进 Opennote 时；也包括「刚才那几份文档都入库」这类批量请求。
---

# 把生成的文档入库到 Opennote

把文档送进用户本机的 Opennote 笔记本。走的是仓库里已经冻结的导入契约
`opennote.import/v1`（`docs/import/02-接口契约-导入信封与通道.md`），
**不自己发明写盘格式**。

**默认通道 = 收件箱（`.opennote/inbox/`）**：文档先变成收件箱里的一条**待确认**条目，
用户在 Opennote 里点「导入」才成为笔记。这是本 Skill 的默认行为——
Agent 不该在用户没看过的前提下，把内容直接变成正笔记。
投递**不要求 Opennote 正在运行**：应用没开也能投，下次打开就会出现（已经开着则立刻出现）。

## 何时使用 / 不使用

用：用户明确要求把产出的文档存进笔记 / 入库 / 归档 / 剪藏。
不用：用户只是让你写文件（那就写在仓库里）、或要**读取/搜索/删除**笔记
（Opennote 的导入能力只写不读，读笔记不在本 Skill 范围）。

## 一条命令

脚本随本 Skill 提供，位于 `scripts/opennote-ingest.mjs`（零依赖，Node ≥ 20）。
先解析出它的绝对路径，再用它入库：

```powershell
# 全局安装时在 ~/.agents/skills/opennote-ingest/；本仓库内是 E:\repo\opennote\.agents\skills\opennote-ingest\
$script = "$env:USERPROFILE\.agents\skills\opennote-ingest\scripts\opennote-ingest.mjs"
if (-not (Test-Path $script)) { $script = "E:\repo\opennote\.agents\skills\opennote-ingest\scripts\opennote-ingest.mjs" }

# 0) 前置检查（只读，不写盘）
node $script --check --json

# 1) 单篇入库（默认进收件箱）
node $script "docs\我的报告.md" --folder "Agent 产出" --tags "agent产出" --json

# 2) 批量入库：一个文档一条条目，绝不合并成一篇
node $script --dir "docs\产出\2026-10" --recursive --folder "Agent 产出" --tags "agent产出" --json
```

- 路径用引号包住（中文路径、空格都要）。`--json` 输出机器可读结果，**优先用它**。
- `--folder` 是**入库后的落点目录**（笔记建在哪个子目录）；不传就是笔记本根目录。
  没有特别理由就用 `--folder "Agent 产出"`（与人工笔记分开，便于回看与清理）；
  用户已经指定过目录名/目录结构时，按用户的来，不要另起一个。
- `--dry-run` 只打印将要提交的信封，不写盘；不确定内容先用它看一眼。

## 例外：用户明确要求「直接入库」

只有用户明确说「直接入库 / 别走收件箱 / 马上变成笔记」时才换通道。这条通道需要
**Opennote 桌面版正在运行 + 已打开笔记本 + 本地接口已开启 + 已配置令牌**，缺一不可：

```powershell
node $script "docs\我的报告.md" --channel bridge --folder "Agent 产出" --json
```

它把信封 `POST` 给本机桥。**端口不是写死的 8787** —— 桥可能绑在别的端口上
（用户显式指定，或 `8787–8796` 整段被 Windows 保留端口段占用时启用其持久化偏好）。
脚本按 **`--endpoint` > `bridge.json` 的 `port` > 扫 `8787–8796`** 的顺序找桥，
`--check --json` 的 `bridge.how` 会告诉你这次是**怎么找到的**。
**`ok: true` 不等于写成了笔记** —— 必须看 JSON 里的 `action`，它是从回执 `result.status` 归一的：

| 回执 `result.status` | 含义 | JSON `action` |
| --- | --- | --- |
| `created` / `appended` | 真的写成 / 追加了笔记 | `imported`（`notePath` 是落点） |
| `pending` | **只进了收件箱**，`notePath` 为 null，等用户确认 | `queued` |
| `deduped` / `duplicate` / `skipped` | 没写盘，返回的是既有落点 | `skipped`（看 `reason`） |
| 其它 | 版本不匹配 | 按失败处理（exit 9） |

**为什么会出现 `pending`**：应用侧默认设置是「先进入收件箱」，且它只作用于
**没有指明落点**的外部投递。所以桥通道**要么带 `--folder`，要么预期拿 `pending`**。
拿不到 `created` 就别说「已经存进笔记了」——说「已进入收件箱，等你在 Opennote 里确认」。

## 标题、front-matter、标签怎么处理（确定性规则）

| 项 | 规则 |
| --- | --- |
| 标题 | `--title` > 源文档 front-matter 的 `title:` > 正文首个 `# H1` > 首个非空行 > 文件名 |
| H1 | 若正文首个 H1 与最终标题同名，**这一行会被去掉**：应用会自己写 `# 标题`，留着会变成两层重复标题 |
| H1（不同名） | 若正文首个 H1 与最终标题**不同**，应用会把它**降级成 H2**（`downgradeLeadingH1()`）——这是应用侧行为，脚本不改写源文件；想让正文保持原样就别用 `--title` 覆盖 |
| front-matter | 默认**剥掉**（应用会重新生成它自己那 8 个键）；其中 `tags` 会被继承。要原样保留用 `--keep-front-matter` |
| 标签 | 合并 front-matter 的 `tags` 与 `--tags`；按契约清洗（去逗号/方括号/引号、去纯数字、截到 32 字、收紧字符集），被改动的原标签在 `adjustedTags` 里，超过 32 个时 `truncatedTags` 报数 |
| 来源 | `source.url` 默认 `null`（生成物通常没有来源页），`source.title` 默认写**源文件绝对路径**，便于回溯；可用 `--url` / `--source-title` 覆盖 |
| 幂等键 | `importId = agent-` + `sha256(标题 \n 落点 \n url \n 正文)` 前 16 位十六进制。同一份内容（含同样的标题与落点）重复投递会自动跳过，不产生第二条 |
| 附件 | 正文里 `./assets/<名>` 引用的图片用 `--attach <文件>` 显式附带，或 `--auto-assets` 自动收集同目录下真实存在的图片 |

## 硬性约束（不许违反）

1. **不改写原文**：不补写结论、摘要、段落；只允许原样搬运（或按用户要求先改源文件）。
2. **不覆盖**：`conflict` 恒为 `new`，不传 `append` / `overwrite`，不动既有笔记。
3. **一篇一条**：多篇文档逐篇入库，不合并、不拆分正文。
4. **不猜笔记本**：解析不出当前笔记本就如实失败并问用户（`--workspace`），不要随便挑一个目录投。
5. **不假成功**：只看脚本的 JSON / 退出码。收件箱通道的成功是
   `action: "queued"`（**待确认**，还不是笔记），绝不能对用户说「已经存进笔记了」。
6. **不替用户改设置**：不开接口、不换令牌、不动 Opennote 的配置。

## 失败怎么办（对用户说实话，给下一步动作）

| 现象 | 含义 | 你该做什么 |
| --- | --- | --- |
| 退出码 0 · `action: queued` | **进了收件箱，还不是笔记**（收件箱通道必然是它；桥通道带 `--folder` 时一般不是） | 告诉用户「已进收件箱，共 N 条，去 Opennote 收件箱逐条点导入」；**不许说已存进笔记** |
| 退出码 0 · `action: imported` | 桥通道**真的写成了笔记** | 报 `notePath` |
| 退出码 0 · `action: skipped` · `reason: already-imported` | 同 `importId` 已入库过，正常 | 别重复投；把既有落点告诉用户 |
| 退出码 0 · `action: skipped` · `reason: already-in-inbox` | 同一份内容已在收件箱等确认，正常 | 提醒用户去收件箱确认那一条 |
| 退出码 0 · `action: skipped` · `reason: failed-in-inbox` | **收件箱里那条上一次入库失败过**（不是正常跳过） | 按 JSON 的 `nextStep`：让用户在收件箱里丢弃它，再用 `--force` 重投（`--force` 换新 importId，不会产生重复死条目） |
| 退出码 3 · `IMP-1001/1004/4006` | 桥连不上或应用没运行 | 逐字说：「Opennote 没有在运行。请先打开 Opennote，再试一次。」或改用默认收件箱通道 |
| 退出码 4 · `IMP-2001/2002` | 令牌缺失/失效 | 让用户到「设置 · 文件 · 导入与接口」点「复制令牌」，再用 `--token` 或 `OPENNOTE_TOKEN` 传进来；**不要重试** |
| 退出码 5 · `IMP-4007` | 笔记本没打开 / 定不了是哪一个 | 逐字说：「Opennote 里还没有打开笔记本文件夹。请在 Opennote 左侧选一个文件夹，或新建一个，再试一次。」；或让用户给出 `--workspace <路径>`（桥不可用时脚本**不会**自己挑 recent-workspaces 里的候选，除非显式给 `--allow-recent`） |
| 退出码 2 · `IMP-4003/4004/4008/4012/4013` | 参数或内容不合契约（缺标题、正文 > 8 MiB、落点含 `..`、附件不合规、收件箱满 500） | 按 `message`（脚本自检）或 `userMessage`（桥回执）修正后**重试一次**；收件箱满就让用户先清收件箱 |
| 退出码 9 · `IMP-5001` | 写盘失败 / 回执状态无法识别 | 可重试一次；仍失败就把原文告诉用户 |

**找到笔记本的规则（不猜）**：桥**故意不返回绝对路径**，脚本用「桥给的笔记本名 +
`recent-workspaces.json` 同名匹配」来定位。以下四种情况**默认都会失败（exit 5 + `IMP-4007`）**，
而不是随便挑一个目录：① 应用在运行但没打开笔记本；② 桥不可用；③ 找到多个同名候选；
④ 应用打开的笔记本名在 `recent-workspaces.json` 里找不到。这时必须问用户，或让用户显式给
`--workspace`；只有用户确认「就用最近打开的那本」时才加 `--allow-recent`。

## 完成后怎么跟用户说

一句话结论 + 落点 + 条目数，并说清「还在收件箱里等确认」：

> 已把 3 篇文档投进 Opennote 收件箱（落点 `Agent 产出`）：
> `V7-独立验证.md`、`A1-作者证据.md`、`交接说明.md`。
> 打开 Opennote 的收件箱，逐条点「导入」就会落成笔记；不想要的可以丢弃。

桥通道拿到 `action: imported` 时才说「已写成笔记：`<notePath>`」；
拿到 `queued` 就照上面那句说收件箱。

## 自检（证明真的入库了）

- **收件箱通道**：脚本落盘后会把 `entry.json` **读回来解析**并核对 `importId`/标题/正文字节数
  （写后回读校验，不是只看文件在不在），对不上会以 `IMP-5001` 失败。
- 再确认应用**确实读到了**：`node $script --check --json` 看 `inbox.pending` / `inbox.total`
  是否按预期增加；或在 Opennote 收件箱界面上看到条目（标题、来源、落点）。
- **桥通道**：只看 JSON 的 `action` —— 只有 `imported` 才是「写成了笔记」（`notePath` 为落点）；
  `queued` = 只进了收件箱；`skipped` = 没写盘（看 `reason`）。
- 详细字段、错误码、磁盘形状：见 `references/导入契约速查.md`；
  本技能交付时的实测证据与「未验证项」清单：见 `references/验证记录.md`。

## 兜底（没有 Node / 找不到脚本时）

- 没有 Node：请用户手动把 `.md` 拖进 Opennote 窗口，或放到笔记本目录里。
- 找不到脚本：在 `~/.agents/skills/opennote-ingest/` 与仓库的 `.agents/skills/opennote-ingest/`
  下找 `scripts/opennote-ingest.mjs`；确实没有就如实说明，不要手写 JSON 硬凑（格式错了应用会
  静默忽略或标 `failed`）。
