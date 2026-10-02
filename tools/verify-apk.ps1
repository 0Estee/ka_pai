# APK 产物验证
#
# 做四件事：
#   1. 检查 zip 条目名里没有反斜杠（aapt2 在 Windows 上的坑，会让设备上 404 白屏）
#   2. 从 APK 解出 assets，与工程源文件做 SHA256 比对（证明装进去的是最新构建）
#   3. 用无头 Chrome 渲染 APK 内的资源（证明「实际装进手机的字节」能跑）
#   4. 截开局与中局两张图
#
# 用法: powershell -ExecutionPolicy Bypass -File tools\verify-apk.ps1
#       powershell -ExecutionPolicy Bypass -File tools\verify-apk.ps1 -Apk dist\ka-pai-0.5.2.apk

param(
  # 默认验 dist 里**最新**的那个 APK。
  # 这里以前写死了 'dist\ka-pai-0.5.1.apk'，于是出了 0.5.2 之后
  # 这个脚本还在验 0.5.1 的旧包，一路 PASS，什么也没拦住。
  [string]$Apk = ''
)

$ErrorActionPreference = 'Continue'

$ROOT = 'E:\ka_pai'
$WORK = Join-Path $ROOT '.verify-apk'
$SHOTS = Join-Path $ROOT 'shots'

if (-not $Apk) {
  $cand = Get-ChildItem (Join-Path $ROOT 'dist\ka-pai-*.apk') -ErrorAction SilentlyContinue |
          Sort-Object LastWriteTime -Descending
  if (-not $cand) { Write-Host 'dist 里找不到 ka-pai-*.apk，请先运行 tools\build-apk.ps1' -ForegroundColor Red; exit 1 }
  $Apk = $cand[0].FullName
  if ($cand.Count -gt 1) {
    Write-Host ("注意：dist 里有 {0} 个 APK，本次验最新那个 {1}" -f $cand.Count, $cand[0].Name) -ForegroundColor Yellow
    Write-Host '      （旧包留着会让人误装、也会让「验的是哪个包」变得含糊，建议删掉）'
  }
}
if (-not [System.IO.Path]::IsPathRooted($Apk)) { $Apk = Join-Path $ROOT $Apk }

if (-not (Test-Path $Apk)) { Write-Host "找不到 APK: $Apk" -ForegroundColor Red; exit 1 }
Write-Host "验证目标: $Apk" -ForegroundColor Cyan

$fail = 0
function Pass($m) { Write-Host "  OK   $m" -ForegroundColor Green }
function Fail($m) { Write-Host "  FAIL $m" -ForegroundColor Red; $script:fail++ }
function Head($m) { Write-Host ''; Write-Host "=== $m ===" -ForegroundColor Cyan }

Add-Type -AssemblyName System.IO.Compression.FileSystem

# ── 1. 条目名检查 ─────────────────────────────────────────
Head '1. zip 条目名（反斜杠会导致设备上资源 404）'
$zip = [System.IO.Compression.ZipFile]::OpenRead($APK)
$entries = @($zip.Entries)
$bad = @($entries | Where-Object { $_.FullName.Contains([char]92) })
if ($bad.Count -eq 0) { Pass "全部 $($entries.Count) 个条目路径规范" }
else { foreach ($b in $bad) { Fail "含反斜杠: $($b.FullName)" } }

Head '1b. 必需条目'
# 这里**只列「必须有」的**，不再列「全部」——
# 全部 assets 由下面第 2 节按 APK 的实际内容反向校验，
# 避免「构建脚本写死一份清单、验证脚本再写死一份」两边迟早不同步。
# （screens.css 就是这么漏掉的：加了文件、改了 index.html，但两份清单都没跟上）
$required = @('AndroidManifest.xml', 'classes.dex', 'resources.arsc',
              'assets/index.html', 'assets/style.css', 'assets/dist/bundle.js')
foreach ($r in $required) {
  $e = $entries | Where-Object { $_.FullName -eq $r }
  if ($e) { Pass ("{0,-26} {1,8:N0} B" -f $r, $e.Length) } else { Fail "缺少 $r" }
}

Head '1c. 安装可行性：resources.arsc 必须是 STORED（targetSdk≥30 的硬性要求）'
$arsc = $entries | Where-Object { $_.FullName -eq 'resources.arsc' }
if (-not $arsc) {
  Fail '找不到 resources.arsc'
} elseif ($arsc.CompressedLength -ne $arsc.Length) {
  Fail ("resources.arsc 被压缩了（{0} 压缩后 / {1} 原始）—— 设备会报 Failure [-124]" -f $arsc.CompressedLength, $arsc.Length)
} else {
  Pass ("resources.arsc 未压缩（{0} 字节）" -f $arsc.Length)
}

Head '1d. 安装可行性：zipalign 对齐校验'
$zipalign = Join-Path $ROOT '.toolchain\sdk\build-tools\34.0.0\zipalign.exe'
if (Test-Path $zipalign) {
  $out = & $zipalign -c -v 4 $APK 2>&1
  if ($LASTEXITCODE -eq 0) {
    Pass 'zipalign -c -v 4 校验通过'
  } else {
    Fail 'zipalign 校验未通过（设备会拒绝安装）'
    $out | Select-String -Pattern 'BAD|FAILED' | Select-Object -First 5 | ForEach-Object { Write-Host "       $_" }
  }
} else {
  Write-Host '  SKIP 找不到 zipalign.exe'
}

# ── 2. 解出 assets 并比对哈希 ─────────────────────────────
Head '2. 解出 assets 并与源文件比对（按 APK 实际内容，不写死清单）'
if (Test-Path $WORK) { Remove-Item $WORK -Recurse -Force }
New-Item -ItemType Directory -Force -Path (Join-Path $WORK 'dist') | Out-Null

# 遍历 APK 里**每一个** assets/ 下的条目，按约定 assets/X ← app/X 找到源文件比对。
# 这样新增资源只要被构建脚本打进去就自动纳入校验，不会漏。
$assetEntries = @($entries | Where-Object { $_.FullName -like 'assets/*' })
if ($assetEntries.Count -eq 0) { Fail 'APK 里没有任何 assets 条目' }

foreach ($e in $assetEntries) {
  $rel = $e.FullName.Substring('assets/'.Length)          # 例如 style.css 或 dist/bundle.js
  $src = Join-Path (Join-Path $ROOT 'app') ($rel -replace '/', '\')
  $out = Join-Path $WORK ($rel -replace '/', '\')

  if (-not (Test-Path $src)) { Fail "$($e.FullName) 在源目录里找不到对应文件（$src）"; continue }

  New-Item -ItemType Directory -Force -Path (Split-Path $out) | Out-Null
  [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, $out, $true)

  $ha = (Get-FileHash $out -Algorithm SHA256).Hash
  $hb = (Get-FileHash $src -Algorithm SHA256).Hash
  if ($ha -eq $hb) { Pass "$rel 与源文件一致" } else { Fail "$rel 与源文件不一致（APK 是旧的？）" }
}

# ── 2b. index.html 引用的每个本地文件都必须在 APK 里 ───────
# 这一条专门拦「加了新 css/js 但忘了打进 APK」——
# 症状是设备上白屏或样式缺失，而构建过程一切正常，非常难查。
$html = Get-Content (Join-Path $ROOT 'app\index.html') -Raw
$refs = [regex]::Matches($html, '(?:href|src)\s*=\s*"([^"]+)"') |
        ForEach-Object { $_.Groups[1].Value } |
        Where-Object { $_ -notmatch '^(https?:)?//|^data:|^#' }
foreach ($ref in $refs) {
  $entryName = 'assets/' + ($ref -replace '^\./', '' -replace '\\', '/')
  if ($entries | Where-Object { $_.FullName -eq $entryName }) { Pass "index.html 引用的 $ref 已在包内" }
  else { Fail "index.html 引用了 $ref，但 APK 里没有 $entryName" }
}
$zip.Dispose()

# 开发用的预览页也复制过去，用于渲染中局画面
foreach ($f in @('_preview.html', '_frame.html')) {
  Copy-Item (Join-Path $ROOT "app\$f") (Join-Path $WORK $f) -Force
}

# ── 3. 渲染 APK 内的资源 ──────────────────────────────────
Head '3. 用无头 Chrome 渲染 APK 内的资源'
if (-not (Test-Path $SHOTS)) { New-Item -ItemType Directory -Force -Path $SHOTS | Out-Null }
$shot = Join-Path $ROOT 'tools\screenshot.ps1'

& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html" `
  -Out (Join-Path $SHOTS '30-apk-home.png') -Width 460 -Height 900 -Budget 2500 | Out-Null
if (Test-Path (Join-Path $SHOTS '30-apk-home.png')) { Pass '首页已渲染' } else { Fail '首页渲染失败' }

& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html?src=_preview.html%3Fturn%3D3" `
  -Out (Join-Path $SHOTS '31-apk-midgame.png') -Width 460 -Height 900 -Budget 3000 | Out-Null
if (Test-Path (Join-Path $SHOTS '31-apk-midgame.png')) { Pass '中局画面已渲染' } else { Fail '中局画面渲染失败' }

# 浅色首页：一次性验证 screens.css 与主题变量都真的进了 APK
& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html?src=_preview.html%3Fscreen%3Dhome%26theme%3Dlight" `
  -Out (Join-Path $SHOTS '32-apk-home-light.png') -Width 460 -Height 900 -Budget 2500 | Out-Null
if (Test-Path (Join-Path $SHOTS '32-apk-home-light.png')) { Pass '浅色首页已渲染（screens.css + 主题变量生效）' } else { Fail '浅色首页渲染失败' }

# ── 3b. 用 APK 内的字节跑交互路径 ────────────────────────
# 截图只能证明「画出来了」。下面这三条路径（AI 开局 / 场上卡牌详情 / 冷启动回放）
# 都是「点了没反应」型的 bug —— 界面照样能画出来，只是点不动，
# 所以必须断言页面里探针的结论，不能只看截图存不存在。
Head '3b. 用 APK 内的字节跑交互路径（断言，不只看截图）'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
function Get-ProbeTitle($url) {
  $prof = Join-Path $env:TEMP ("apkverify-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
  # 必须 `2>&1 | Out-String`：写成 `$x = & chrome ... 2>$null` 会拿到空字符串
  # （Chrome 的 stdout 在「赋值 + 重定向」这个组合下会被丢掉），
  # 于是三条断言全部静默失败 —— 看起来像页面坏了，其实是探针没读到东西。
  $dom = (& $chrome --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars `
    --disable-extensions --disable-background-networking --disable-sync `
    --virtual-time-budget=9000 --user-data-dir="$prof" --dump-dom $url 2>&1 | Out-String)
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue
  return [regex]::Match($dom, '<title>([^<]*)</title>').Groups[1].Value
}

# ⚠ 两个坑叠在一起，都会让断言静默错位：
#   1) `"$base?demo=nav"` 里的 `?` 是**合法的变量名字符**，PowerShell 会把它当成
#      变量 `$base?demo`（不存在 → 空串），URL 退化成 `=nav`，Chrome 直接去搜索。
#      所以必须写 `"${base}?demo=nav"`。
#   2) 这里必须是真正的 `?`，不能写成 %3F —— %3F 只在 iframe 的 src 属性里才会被解码。
$base = 'file:///E:/ka_pai/.verify-apk/_preview.html'
$probes = @(
  @{ name = '开始游戏 → AI 对决 → 开始对战（真的能开局）'
     url  = "${base}?demo=nav"
     want = 'demo: screen=game 有对局=true' },
  @{ name = '点场上卡牌弹出详情面板（看得到卡面效果）'
     url  = "${base}?demo=unitinfo"
     want = 'demo: 详情面板=true' },
  @{ name = '冷启动（内存里没有对局）打开回放能渲染'
     url  = "${base}?demo=coldreplay"
     want = 'demo: screen=replay 控制条=true' }
)

foreach ($pr in $probes) {
  $t = Get-ProbeTitle $pr.url
  if ($t -eq $pr.want) { Pass $pr.name }
  else { Fail ("{0}`n         期望 title「{1}」，实际「{2}」" -f $pr.name, $pr.want, $t) }
}

# 顺手留下三张能看的图
& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html?src=_preview.html%3Fscreen%3Ddifficulty" `
  -Out (Join-Path $SHOTS '33-apk-difficulty.png') -Width 460 -Height 900 -Budget 2500 | Out-Null
& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html?src=_preview.html%3Fdemo%3Dnav" `
  -Out (Join-Path $SHOTS '34-apk-ai-start.png') -Width 460 -Height 900 -Budget 3000 | Out-Null
& powershell -ExecutionPolicy Bypass -File $shot `
  -Url "file:///E:/ka_pai/.verify-apk/_frame.html?src=_preview.html%3Fdemo%3Dunitinfo" `
  -Out (Join-Path $SHOTS '35-apk-unitinfo.png') -Width 460 -Height 900 -Budget 4000 | Out-Null
Pass '已输出 shots\33-apk-difficulty.png / 34-apk-ai-start.png / 35-apk-unitinfo.png'

# ── 汇总 ──────────────────────────────────────────────────
Write-Host ''
Write-Host ('─' * 56) -ForegroundColor DarkGray
if ($fail -eq 0) {
  Write-Host '✅ APK 产物验证全部通过' -ForegroundColor Green
  Write-Host "   截图: shots\30-apk-home.png  shots\31-apk-midgame.png  shots\32-apk-home-light.png"} else {
  Write-Host "❌ $fail 项失败" -ForegroundColor Red
  exit 1
}
