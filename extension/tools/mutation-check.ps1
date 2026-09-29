# 反向验证（变异 → 红；恢复 → 绿）。每个变异都先备份、跑断言、再恢复，最后核对 git 干净。
param([string]$Which = "all")
$ErrorActionPreference = "Stop"
Set-Location E:\repo\opennote\extension
$report = @()

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

$results = @()
# ① V13：把反引号抄回用户文案（Lead 裁定 ①）
$results += Mutate "src/lib/errors.js" `
  '"目标目录不合法：不能使用 ..、绝对路径或系统保留字符。"' `
  '"目标目录不合法：不能使用 ``..``、绝对路径或系统保留字符。"' `
  "① V13 反引号（把 Markdown 内联代码标记抄进文案）" `
  "用户可见文案里有反引号"

# ② V11：把高亮小节退回旧形态（逐行加 >，批注不加空行）
$results += Mutate "src/lib/highlights.js" `
  'return normalized.note ? `${quoted}\n\n— ${normalized.note}` : quoted;' `
  'return normalized.note ? `${"> " + normalized.text.split("\n").join("\n> ")}\n— ${normalized.note}` : quoted;' `
  "② V11 高亮形态（退回 0.2.0 的逐行引用 + 批注不空行）" `
  "有批注时必须写成"

# ③ V10：把不在白名单里的 capturedAt 加回内置「视频」模板
$results += Mutate "src/lib/templates.js" `
  '      author: "{{author}}",
      "source.site": "{{site}}",
    },' `
  '      author: "{{author}}",
      "source.site": "{{site}}",
      capturedAt: "{{date}}",
    },' `
  "③ V10 模板字段白名单（加回 properties.capturedAt）" `
  "capturedAt"

# ④ V12：⋯ 菜单多加第 7 项
$results += Mutate "src/popup/popup.html" `
  '<button type="button" role="menuitem" data-action="forget">清除本地令牌</button>' `
  '<button type="button" role="menuitem" data-action="forget">清除本地令牌</button>
    <button type="button" role="menuitem" data-action="inbox">剪藏到收件箱</button>' `
  "④ V12 ⋯ 菜单回到 7 项（加回 disabled 的「剪藏到收件箱」）" `
  "⋯ 菜单应恰好是 C63 的 6 项"

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

"================= 恢复后复跑 ================="
$v = Run-Verify
$t = Run-Tests
$report += "verify exit=$($v.code) → $(($v.text -split "`n" | Select-Object -Last 1))"
$report += "tests: $($t.text -replace "`n", ' | ')"
$report += "git status src/（应为空）:"
$report += ((& git status --short -- src) -join "`n")

$report -join "`n"
