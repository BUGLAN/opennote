# 反向验证（变异 → 红；恢复 → 绿）。每个变异都先备份、跑断言、再恢复，最后核对 git 干净。
#
# 8 个变异 + 1 个协议检查（构建进行中 → verify 必须 exit 2）。M2 起不再有模板/高亮模块，
# 那两个变异点换成了 V19（产物指纹）与 V18（令牌回显）；`Mutate` 遇到不存在的文件会 SKIP 而不是整轮崩。
#
# ⚠ 协调警告：本脚本在运行期间会把 `src/` 与 `dist/` 短暂改成「故意坏的」状态（含 `node build.mjs` 重建），
#   别人此时跑 `node verify.mjs` 会看到**假红**（例如 V1 报「缺少 commands：pick-element / clip-page」）。
#   跑之前先在群里说一声，或等其他人验完再跑；跑完一轮约 2–3 分钟。
param([string]$Which = "all")
$ErrorActionPreference = "Stop"
Set-Location E:\repo\opennote\extension

# 机器可见的信号（Lead 0.3.1 追加规则）：「有变异在跑 → 此刻的 verify 结果不可信」必须与
# 「结果可信但失败」区分开。verify.mjs 发现这个标记会**以退出码 2 中止**，不打印任何红绿。
# 变异脚本自己的 verify 要看到真实红 → 用环境变量声明身份（别人的 verify 没有它，仍会被标记挡住并 exit 2）
$env:OPENNOTE_MUTATION_SELF = "1"
$marker = Join-Path (Get-Location) ".mutation-running"
New-Item -ItemType File -Path $marker -Force | Out-Null
$report = @()
try {

function Run-Verify {
  $out = & node verify.mjs 2>&1
  $code = $LASTEXITCODE
  return @{ code = $code; text = ($out -join "`n") }
}
function Run-Tests {
  $out = & node --test "tests/**/*.test.mjs" 2>&1
  $code = $LASTEXITCODE
  $tail = ($out | Select-String -Pattern "^(not ok|# (tests|pass|fail))") -join "`n"
  return @{ code = $code; text = $tail }
}

function Mutate([string]$file, [string]$find, [string]$replace, [string]$label, [string]$expect) {
  $full = Join-Path (Get-Location) $file
  if (-not (Test-Path $full)) { return "SKIP $label：文件不存在（$file）—— 已随 M2 删除？" }
  $backup = "$full.bak-mutation"
  Copy-Item $full $backup -Force
  try {
    $text = Get-Content $full -Raw
    if (-not $text.Contains($find)) { return "SKIP $label：src 里找不到锚点 $find" }
    ($text -replace [regex]::Escape($find), $replace) | Set-Content $full -NoNewline
    & node build.mjs | Out-Null
    $v = Run-Verify
    $t = Run-Tests
    $hit = if ($v.text -match [regex]::Escape($expect)) { "命中" } else { "未命中" }
    $line = @()
    $line += "── 变异：$label"
    $line += "   verify exit=$($v.code)（期望非 0）· 期望文案 $hit：$expect"
    ($v.text -split "`n" | Where-Object { $_ -match [regex]::Escape($expect) } | Select-Object -First 3) | ForEach-Object { $line += "     $_" }
    $line += "   tests: $($t.text -replace "`n", ' | ')"
    return ($line -join "`n")
  } finally {
    Move-Item $backup $full -Force
    & node build.mjs | Out-Null
  }
}

# 产物侧变异：**故意不重建** —— 变异的就是「构建之后 dist 被改过」这件事（V19 的判据）。
function MutateDist([string]$file, [string]$append, [string]$label, [string]$expect) {
  $full = Join-Path (Get-Location) $file
  if (-not (Test-Path $full)) { return "SKIP $label：文件不存在（$file）—— 先跑 node build.mjs" }
  $backup = "$full.bak-mutation"
  Copy-Item $full $backup -Force
  try {
    Add-Content -Path $full -Value $append
    $v = Run-Verify
    $t = Run-Tests
    $hit = if ($v.text -match [regex]::Escape($expect)) { "命中" } else { "未命中" }
    $line = @()
    $line += "── 变异：$label"
    $line += "   verify exit=$($v.code)（期望非 0）· 期望文案 $hit：$expect"
    ($v.text -split "`n" | Where-Object { $_ -match [regex]::Escape($expect) } | Select-Object -First 3) | ForEach-Object { $line += "     $_" }
    $line += "   tests: $($t.text -replace "`n", ' | ')"
    return ($line -join "`n")
  } finally {
    Move-Item $backup $full -Force
  }
}

$results = @()
# ① V13：把反引号抄回用户文案（Lead 裁定 ①）
$results += Mutate "src/lib/errors.js" `
  '"目标目录不合法：不能使用 ..、绝对路径或系统保留字符。"' `
  '"目标目录不合法：不能使用 ``..``、绝对路径或系统保留字符。"' `
  "① V13 反引号（把 Markdown 内联代码标记抄进文案）" `
  "用户可见文案里有反引号"

# ② V19：构建之后手改产物（指纹对不上）——M2 收尾新增，测「读一个被改过的产物」必须红
$results += MutateDist "dist/lib/queue.js" "// mutation: 构建之后手改产物" `
  "② V19 产物一致性（构建之后改 dist 一个字节）" `
  "产物指纹对不上"

# ③ V18：令牌尾号不再从唯一真源推导（刚粘贴完的只读回显会退回假尾号）
$results += Mutate "src/background.js" `
  'tokenTail: probed.stored.token ? String(probed.stored.token).slice(-4) : null,' `
  'tokenTail: null,' `
  "③ V18 令牌回显（tokenTail 退回空值）" `
  "background 必须从已保存的令牌推导 tokenTail"

# ④ V12：⋯ 菜单多加第 7 项
$results += Mutate "src/popup/popup.html" `
  '<button type="button" role="menuitem" data-action="forget">清除本地令牌</button>' `
  '<button type="button" role="menuitem" data-action="forget">清除本地令牌</button>
    <button type="button" role="menuitem" data-action="inbox">剪藏到收件箱</button>' `
  "④ V12 ⋯ 菜单多出一项（加回 disabled 的「剪藏到收件箱」）" `
  "⋯ 菜单应恰好是 M1 的 5 项"

# ⑤ V14：元素选择器退回「改宿主页面 DOM」的写法（去掉影子根 + 加回 selectionchange）
$results += Mutate "src/content/picker.js" `
  'attachShadow({ mode: "closed" })' `
  'attachShadow({ mode: "open" })' `
  "⑤ V14 元素选择覆盖层（影子根改成 open）" `
  "覆盖层必须是 closed 影子根"

# ⑥ V15：把配对码路径加回 background（元素选择 + 令牌之外再留一条死路）
$results += Mutate "src/background.js" `
  '    case "opennote:pick":' `
  '    case "opennote:pair":
      return { ok: true, reply: { ok: false, code: "IMP-2004" } };
    case "opennote:pick":' `
  "⑥ V15 去配对（把 opennote:pair 分支加回来）" `
  "background 还留着 opennote:pair"

# ⑦ V15：令牌本地校验放宽成 6 位数字（配对码的形状）
$results += Mutate "src/background.js" `
  'export const TOKEN_RE = /^opn_[A-Za-z0-9_-]{43}$/;' `
  'export const TOKEN_RE = /^[0-9]{6}$/;' `
  "⑦ V15 令牌格式（把 47 字符令牌放宽成 6 位码）" `
  "令牌本地校验必须是 opn_ + 43 位 base64url"

# ⑧ V1：把 Alt+Shift+S 退回「剪藏选区」命令
$results += Mutate "src/manifest.json" `
  '"pick-element": {' `
  '"clip-selection": {' `
  "⑧ V1 快捷键语义（Alt+Shift+S 退回 clip-selection）" `
  "缺少 commands：pick-element / clip-page"

$results | ForEach-Object { $report += $_; $report += "" }

"================= 协议检查：构建进行中 → verify 必须 exit 2（结果不可信）================="
# `.building` 存在 = 有构建正在写 dist。此刻的 verify 既不是红也不是绿：必须 exit 2 并说清原因。
# 注意：这个标记**不**被 OPENNOTE_MUTATION_SELF 豁免（两者是独立的不可信来源）。
$buildMarker = Join-Path (Get-Location) ".building"
'{ "pid": 1, "at": "protocol-check" }' | Set-Content $buildMarker -NoNewline
$vb = Run-Verify
$bh = if ($vb.text -match "有构建正在运行") { "命中" } else { "未命中" }
$report += "有 .building 时 verify exit=$($vb.code)（期望 2 = 结果不可信，不算红也不算绿）· 期望文案 $bh：有构建正在运行"
Remove-Item $buildMarker -Force -ErrorAction SilentlyContinue

"================= 恢复后复跑 ================="
# 复跑前必须先摘掉标记（否则 verify 会以退出码 2 中止，这是**设计**）
Remove-Item $marker -Force -ErrorAction SilentlyContinue
$v = Run-Verify
$t = Run-Tests
$report += "verify exit=$($v.code) → $(($v.text -split "`n" | Select-Object -Last 1))"
$report += "tests: $($t.text -replace "`n", ' | ')"
$report += "git status src/（应为空）:"
$report += ((& git status --short -- src) -join "`n")

$report -join "`n"
} finally {
  # 无论中途怎么退出（包括 Ctrl+C / 抛错），标记都必须被摘掉
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  Remove-Item (Join-Path (Get-Location) ".building") -Force -ErrorAction SilentlyContinue
  Remove-Item Env:\OPENNOTE_MUTATION_SELF -ErrorAction SilentlyContinue
}
