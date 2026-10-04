# 编译并运行联机服务端的桌面集成测试
#
# 为什么要有这个脚本：
#   net/ 包是"纯 Java"的 —— 不碰任何 Android 类，就是为了能在开发机上
#   直接跑真 socket / 真并发的测试。没有它，长轮询、seq、peer-left 这些
#   最容易出错的逻辑就只能靠两台手机试。
#
# 为什么要用绝对路径的 JDK：
#   PATH 上的 java 可能是 Zulu 8。JDK 8 编译带 lambda/新 API 的代码会报错，
#   而且报出来的错和代码本身无关，很容易查错方向。
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools\netserver\run-test.ps1
#
# 注意：本文件必须是 UTF-8 with BOM。PowerShell 5.1 会把无 BOM 的 UTF-8
# 按系统 ANSI 代码页解码，里面的中文注释会变成乱码甚至导致语法错误。

$ErrorActionPreference = 'Continue'

$ROOT   = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
# 资产目录显式传给测试：它的默认值按工作目录推导，在 tools/netserver 下会指错。
$assets = Join-Path $ROOT 'app'
$JDK    = 'C:\Program Files\Java\jdk-21'
$SRC    = Join-Path $ROOT 'android\app\java'
$TESTSRC = Join-Path $ROOT 'tools\netserver'
$OUT    = Join-Path $ROOT '.tmp-nettest\classes'

if (-not (Test-Path "$JDK\bin\javac.exe")) {
  Write-Host "找不到 JDK: $JDK" -ForegroundColor Red
  exit 1
}

if (Test-Path $OUT) { Remove-Item $OUT -Recurse -Force }
New-Item -ItemType Directory -Force -Path $OUT | Out-Null

# net/ 包 + 桌面测试代码一起编译。
# 关键：只编译 net/ 下的文件，不碰 NativeBridge/MainActivity ——
# 那两个需要 android.jar，桌面测试故意不带它，用来反向证明 net/ 真的不依赖 Android。
$files = @()
$files += @(Get-ChildItem (Join-Path $SRC 'com\kaipai\prototype\net') -Filter *.java |
            ForEach-Object { $_.FullName })
$files += @(Get-ChildItem $TESTSRC -Filter *.java | ForEach-Object { $_.FullName })

Write-Host "=== 编译（$($files.Count) 个文件，无 android.jar） ===" -ForegroundColor Cyan
# -J-Duser.language=en 让 javac 报英文，避免控制台代码页把中文错误信息糊掉
& "$JDK\bin\javac.exe" '-J-Duser.language=en' -encoding UTF-8 -d $OUT $files 2>&1 |
  ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) {
  Write-Host "编译失败" -ForegroundColor Red
  exit 1
}
Write-Host "  编译通过" -ForegroundColor Green

Write-Host ''
Write-Host "=== 运行 DesktopTest ===" -ForegroundColor Cyan
# 子进程的 stdout 走的是控制台代码页（本机默认 GBK），而测试输出是 UTF-8。
# 不显式指定就会满屏乱码 —— 连断言名字都看不出来的话，跑测试就失去意义了。
$prevEnc = [Console]::OutputEncoding
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
  # stdout.encoding 必须显式指定：JDK 18+ 的 java 默认按控制台代码页（本机 GBK）
  # 写 stdout，只设置 [Console]::OutputEncoding 不够，中文断言名照样是乱码。
  & "$JDK\bin\java.exe" '-Dfile.encoding=UTF-8' '-Dstdout.encoding=UTF-8' '-Dstderr.encoding=UTF-8' "-Dassets=$assets" -cp $OUT DesktopTest
  $code = $LASTEXITCODE
} finally {
  [Console]::OutputEncoding = $prevEnc
}

Write-Host ''
if ($code -eq 0) {
  Write-Host "DesktopTest 全部通过" -ForegroundColor Green
} else {
  Write-Host "DesktopTest 有断言失败（exit $code）" -ForegroundColor Red
}
exit $code
