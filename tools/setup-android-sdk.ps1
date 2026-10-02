# 搭建 Android 构建链（不经 sdkmanager / 不依赖 Gradle）
#
# 思路：本工程只需要两样东西 —— android.jar 和 build-tools 里的四个命令行工具。
#       直接从 dl.google.com 抓官方 zip 解压到位即可，省掉 sdkmanager 的 Java 启动与
#       许可交互；实测 curl 能跑满 7.4 MB/s，总共约 121 MB / 20 秒。
#
# 用法: powershell -ExecutionPolicy Bypass -File tools\setup-android-sdk.ps1

$ErrorActionPreference = 'Continue'
# PS 5.1 的 Invoke-WebRequest 对大文件极慢，这里统一用 curl.exe
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$root = 'E:\ka_pai\.toolchain'
$sdk  = Join-Path $root 'sdk'
$dl   = Join-Path $root 'downloads'
New-Item -ItemType Directory -Force -Path $sdk, $dl | Out-Null

$BUILD_TOOLS_VERSION = '34.0.0'
$PLATFORM            = 'android-34'

$pkgs = @(
  @{
    Name = 'build-tools 34.0.0'
    Url  = 'https://dl.google.com/android/repository/build-tools_r34-windows.zip'
    Zip  = 'build-tools-34.zip'
    Dest = Join-Path $sdk "build-tools\$BUILD_TOOLS_VERSION"
  },
  @{
    Name = 'platform android-34'
    Url  = 'https://dl.google.com/android/repository/platform-34-ext12_r01.zip'
    Zip  = 'platform-34.zip'
    Dest = Join-Path $sdk "platforms\$PLATFORM"
  }
)

Write-Host '=== Android 构建链安装 ===' -ForegroundColor Cyan
Write-Host "SDK 目录: $sdk"
Write-Host ''

function Get-File($url, $out, $label) {
  if ((Test-Path $out) -and ((Get-Item $out).Length -gt 1MB)) {
    Write-Host ("  [{0}] 已存在，跳过 ({1:N1} MB)" -f $label, ((Get-Item $out).Length / 1MB))
    return $true
  }
  Write-Host ("  [{0}] 下载中…" -f $label)
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  & curl.exe -L --fail --retry 3 --retry-delay 2 -sS -o $out $url
  $code = $LASTEXITCODE
  $sw.Stop()
  if ($code -ne 0 -or -not (Test-Path $out)) {
    Write-Host ("  [{0}] 下载失败 (curl exit {1})" -f $label, $code) -ForegroundColor Red
    return $false
  }
  $mb = (Get-Item $out).Length / 1MB
  Write-Host ("  [{0}] 完成 {1:N1} MB / {2:N1}s ({3:N0} KB/s)" -f `
    $label, $mb, $sw.Elapsed.TotalSeconds, ($mb * 1024 / [Math]::Max($sw.Elapsed.TotalSeconds, 0.01)))
  return $true
}

# tar.exe (bsdtar) 解压 zip 比 Expand-Archive 快得多
$tar = Join-Path $env:SystemRoot 'System32\tar.exe'
$haveTar = Test-Path $tar

foreach ($p in $pkgs) {
  Write-Host ("── {0}" -f $p.Name) -ForegroundColor Yellow

  if (Test-Path $p.Dest) {
    Write-Host ("  目标已存在: {0}" -f $p.Dest)
    continue
  }

  $zipPath = Join-Path $dl $p.Zip
  if (-not (Get-File $p.Url $zipPath $p.Name)) { continue }

  $tmp = Join-Path $dl ("x-" + [IO.Path]::GetFileNameWithoutExtension($p.Zip))
  if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $tmp | Out-Null

  Write-Host "  解压…"
  if ($haveTar) {
    & $tar -xf $zipPath -C $tmp
  } else {
    Expand-Archive -Path $zipPath -DestinationPath $tmp -Force
  }

  # 官方 zip 的顶层目录名不统一（可能是 android-14 / android-34-ext12 等），
  # 所以找出唯一的顶层目录再改名成规范路径。
  $top = @(Get-ChildItem $tmp -Directory)
  if ($top.Count -ne 1) {
    Write-Host ("  顶层目录数异常: {0}" -f $top.Count) -ForegroundColor Red
    continue
  }

  New-Item -ItemType Directory -Force -Path (Split-Path $p.Dest) | Out-Null
  Move-Item $top[0].FullName $p.Dest
  Remove-Item $tmp -Recurse -Force
  Write-Host ("  安装到 {0}" -f $p.Dest)
}

# ── 验证 ──────────────────────────────────────────────────
Write-Host ''
Write-Host '=== 验证 ===' -ForegroundColor Cyan
$bt = Join-Path $sdk "build-tools\$BUILD_TOOLS_VERSION"
$jar = Join-Path $sdk "platforms\$PLATFORM\android.jar"

$missing = 0
foreach ($t in @('aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat')) {
  $ok = Test-Path (Join-Path $bt $t)
  if (-not $ok) { $missing++ }
  Write-Host ("  {0,-16} {1}" -f $t, $(if ($ok) { 'OK' } else { '缺失' })) -ForegroundColor $(if ($ok) { 'Green' } else { 'Red' })
}
$okJar = Test-Path $jar
if (-not $okJar) { $missing++ }
Write-Host ("  {0,-16} {1}" -f 'android.jar', $(if ($okJar) { 'OK' } else { '缺失' })) -ForegroundColor $(if ($okJar) { 'Green' } else { 'Red' })

if ($okJar) {
  Write-Host ("  android.jar 大小 {0:N1} MB" -f ((Get-Item $jar).Length / 1MB))
}

Write-Host ''
if ($missing -eq 0) {
  Write-Host '✅ 构建链就绪。下一步：' -ForegroundColor Green
  Write-Host '   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1'
} else {
  Write-Host "❌ 有 $missing 项缺失，构建会失败" -ForegroundColor Red
  exit 1
}
