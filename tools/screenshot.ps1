# 带重试的无头截图工具。
#
# 为什么要重试：Windows 上 Chrome headless=new 会创建真实窗口，偶发不写文件
# （首次启动 / profile 竞争）。重试 3 次基本稳定。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools\screenshot.ps1 -Url "<url>" -Out "<png>"
#
# 注意：Windows 会把真实窗口宽度钳制到约 500px，
# 所以 -Width 小于 500 时页面仍按 ~500 布局、截图只抓 Width 宽，右侧会被裁。
# 要验证手机布局请用 app\_frame.html（iframe 固定 390px）。

param(
  [Parameter(Mandatory = $true)][string]$Url,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 460,
  [int]$Height = 900,
  [int]$Budget = 3000,
  [int]$Retries = 3
)

$ErrorActionPreference = 'Continue'
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { throw "找不到 Chrome: $chrome" }

$outDir = Split-Path $Out -Parent
if ($outDir -and -not (Test-Path $outDir)) { New-Item -ItemType Directory -Force -Path $outDir | Out-Null }
if (Test-Path $Out) { Remove-Item $Out -Force }

for ($i = 1; $i -le $Retries; $i++) {
  $prof = Join-Path $env:TEMP ("dsh-shot-" + [guid]::NewGuid().ToString('N').Substring(0, 8))

  & $chrome --headless=new --disable-gpu --no-sandbox --no-first-run --hide-scrollbars `
    --disable-extensions --disable-background-networking --disable-sync `
    --virtual-time-budget=$Budget --window-size="$Width,$Height" `
    --screenshot="$Out" --user-data-dir="$prof" "$Url" 2>&1 | Out-Null

  Start-Sleep -Milliseconds 700
  Remove-Item $prof -Recurse -Force -ErrorAction SilentlyContinue

  if ((Test-Path $Out) -and ((Get-Item $Out).Length -gt 1000)) {
    Write-Host ("OK   {0}  ({1:N1} KB)" -f (Split-Path $Out -Leaf), ((Get-Item $Out).Length / 1KB))
    exit 0
  }
  Write-Host ("重试 {0}/{1} ..." -f $i, $Retries)
  Start-Sleep -Milliseconds 600
}

Write-Host "FAIL $Out"
exit 1
