# 手工构建 APK（不使用 Gradle / AndroidX / 任何 Maven 依赖）
#
# 为什么手工构建：
#   本机 Gradle 官方发行源不可达，AndroidX 所在的 maven.google.com 也未必可用。
#   本工程是纯 WebView 外壳、零第三方依赖，所以只需要 SDK 的 build-tools：
#     aapt2 (编译资源) → javac (编译 Java) → d8 (生成 dex) → zipalign → apksigner
#
# 用法:
#   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1
#   powershell -ExecutionPolicy Bypass -File tools\build-apk.ps1 -SkipWeb
#
# 产物: dist\ka-pai-<version>.apk

param(
  [string]$SdkRoot = 'E:\ka_pai\.toolchain\sdk',
  [string]$JdkHome = 'C:\Program Files\Java\jdk-21',
  [string]$BuildToolsVersion = '34.0.0',
  [string]$Platform = 'android-34',
  [string]$VersionName = '0.38.0',
  [int]$VersionCode = 39,
[int]$MinSdk = 24,
  [int]$TargetSdk = 34,
  [string]$KeystorePass = 'kapai123',
  [string]$KeystoreAlias = 'kapai',
  [switch]$SkipWeb,
  [switch]$SkipIcon
)

# 注意：这里必须是 Continue 而不是 Stop。
# javac / d8 / apksigner 都会往 stderr 写正常提示（如 deprecation note），
# 在 Stop 模式下 PowerShell 会把原生命令的 stderr 当成终止性错误，
# 于是脚本会在编译成功之后照样中断。每个外部命令后面都显式检查 $LASTEXITCODE。
$ErrorActionPreference = 'Continue'

$ROOT      = 'E:\ka_pai'
$APP       = Join-Path $ROOT 'app'
$ANDROID   = Join-Path $ROOT 'android'
$APPROOT   = Join-Path $ANDROID 'app'
$BUILD     = Join-Path $ANDROID 'build'
$DIST      = Join-Path $ROOT 'dist'
$BUILDTOOLS = Join-Path $SdkRoot "build-tools\$BuildToolsVersion"
$ANDROID_JAR = Join-Path $SdkRoot "platforms\$Platform\android.jar"

$env:JAVA_HOME = $JdkHome
$env:PATH = "$JdkHome\bin;$env:PATH"

function Step($n, $msg) { Write-Host ''; Write-Host "=== [$n] $msg ===" -ForegroundColor Cyan }
function Ok($msg)       { Write-Host "  OK  $msg" -ForegroundColor Green }
function Die($msg)      { Write-Host "  ERR $msg" -ForegroundColor Red; exit 1 }

<#
  aapt2 在 Windows 上有个坑：嵌套的 assets 会被写成反斜杠分隔的 zip 条目名
  （assets/dist\bundle.js），而 ZIP 规范与 Android AssetManager 都要求正斜杠。
  结果是网页引用 dist/bundle.js 时在设备上 404，界面直接白屏。

  修法：**不重建 zip**，只做字节级就地替换 —— '\' (0x5C) 与 '/' (0x2F) 都是 1 字节，
  替换后 zip 结构完全不变，各条目的压缩方式原样保留。

  ⚠️ 为什么绝不能重建 zip：
     targetSdk >= 30 时 Android 强制要求 resources.arsc **不压缩**（STORED）。
     aapt2 本来已正确输出 STORED，但任何"重建 zip"的做法都会把它重新压缩
     （.NET 的 CompressionLevel.NoCompression 实测不可靠，写出来的仍是 deflate），
     于是设备直接拒绝安装：
       Failure [-124: Failed parse during installPackageLI: Targeting R+ (version 30
       and above) requires the resources.arsc of installed APKs to be stored
       uncompressed and aligned on a 4-byte boundary]
     这个坑踩过一次 —— 第一版 APK 就是这样，装不上。

  只精确匹配"完整条目名"再替换，避免误伤压缩数据里恰好出现的 0x5C 字节。
#>
function Repair-ZipEntryNames {
  param([string]$InApk, [string]$OutApk, [string]$AssetsDir)

  Copy-Item $InApk $OutApk -Force

  # 收集所有"aapt2 会写成反斜杠"的条目名（即位于子目录里的 assets）
  $root = (Resolve-Path $AssetsDir).Path
  $pairs = @()
  Get-ChildItem $AssetsDir -Recurse -File | ForEach-Object {
    $rel = $_.FullName.Substring($root.Length).TrimStart([char]92)
    if ($rel.Contains([char]92)) {
      $pairs += @{
        bad  = 'assets/' + $rel
        good = 'assets/' + ($rel -replace '\\', '/')
      }
    }
  }
  if ($pairs.Count -eq 0) { return 0 }

  $bytes = [System.IO.File]::ReadAllBytes($OutApk)
  $changed = 0

  foreach ($p in $pairs) {
    $badBytes  = [System.Text.Encoding]::ASCII.GetBytes($p.bad)
    $goodBytes = [System.Text.Encoding]::ASCII.GetBytes($p.good)
    if ($badBytes.Length -ne $goodBytes.Length) {
      throw "条目名长度不一致，无法就地替换: $($p.bad)"
    }
    $len = $badBytes.Length
    for ($i = 0; $i -le $bytes.Length - $len; $i++) {
      if ($bytes[$i] -ne $badBytes[0]) { continue }
      $hit = $true
      for ($k = 1; $k -lt $len; $k++) {
        if ($bytes[$i + $k] -ne $badBytes[$k]) { $hit = $false; break }
      }
      if ($hit) {
        for ($k = 0; $k -lt $len; $k++) { $bytes[$i + $k] = $goodBytes[$k] }
        $changed++
        $i += $len - 1
      }
    }
  }

  if ($changed -gt 0) { [System.IO.File]::WriteAllBytes($OutApk, $bytes) }
  return $changed
}

# ── [0] 前置检查 ──────────────────────────────────────────
Step 0 '检查工具链'
if (-not (Test-Path "$JdkHome\bin\javac.exe")) { Die "找不到 JDK: $JdkHome" }
foreach ($t in @('aapt2.exe', 'd8.bat', 'zipalign.exe', 'apksigner.bat')) {
  if (-not (Test-Path (Join-Path $BUILDTOOLS $t))) { Die "找不到 $t（$BUILDTOOLS）—— 先运行 tools\setup-android-sdk.ps1" }
}
if (-not (Test-Path $ANDROID_JAR)) { Die "找不到 android.jar: $ANDROID_JAR" }
Ok "JDK      $JdkHome"
Ok "build-tools $BuildToolsVersion"
Ok "platform $Platform"

if (Test-Path $BUILD) { Remove-Item $BUILD -Recurse -Force }
New-Item -ItemType Directory -Force -Path $BUILD, $DIST | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $BUILD 'gen'), (Join-Path $BUILD 'classes'), (Join-Path $BUILD 'dex') | Out-Null

# ── [0] 版本号一致性 ──────────────────────────────────────
# aapt2 的 --version-code / --version-name **只在 manifest 没写这两个属性时才生效**，
# manifest 里写了就以 manifest 为准。所以两者一旦不同步，就会安静地打出一个
# 文件名是 0.5.2、包内 versionCode 还是 5 的 APK —— 手机上「覆盖安装」还会失败。
Step 0 '版本号一致性（build-apk.ps1 ↔ AndroidManifest.xml ↔ screens.js）'
$mfPath = Join-Path $APPROOT 'AndroidManifest.xml'
$mfText = Get-Content $mfPath -Raw -Encoding UTF8
$mfCode = [regex]::Match($mfText, 'android:versionCode="(\d+)"').Groups[1].Value
$mfName = [regex]::Match($mfText, 'android:versionName="([^"]+)"').Groups[1].Value
if ($mfCode -ne "$VersionCode" -or $mfName -ne $VersionName) {
  Die "版本号不同步：脚本是 $VersionName($VersionCode)，manifest 是 $mfName($mfCode)。" + `
      "请同时改 tools\build-apk.ps1 与 android\app\AndroidManifest.xml"
}
Ok "manifest  versionName $mfName  versionCode $mfCode"

# 界面里显示的版本号也要跟上，否则会出现「设置页写着 0.5.1、装的却是 0.5.2」
$uiText = Get-Content (Join-Path $APP 'js\screens.js') -Raw -Encoding UTF8
$uiVer = [regex]::Match($uiText, "APP_VERSION\s*=\s*'([^']+)'").Groups[1].Value
if ($uiVer -ne $VersionName) {
  Die "app\js\screens.js 的 APP_VERSION 是 $uiVer，和 $VersionName 对不上"
}
Ok "界面 APP_VERSION $uiVer"

# ── [1] 图标 ──────────────────────────────────────────────
if (-not $SkipIcon) {
  Step 1 '生成应用图标'
  & node (Join-Path $ROOT 'tools\make-icon.mjs')
  if ($LASTEXITCODE -ne 0) { Die '图标生成失败' }
} else { Step 1 '生成应用图标（已跳过）' }

# ── [2] 打包网页资源 ──────────────────────────────────────
if (-not $SkipWeb) {
  Step 2 '打包网页资源为单文件脚本'
  & node (Join-Path $ROOT 'tools\build-web.mjs')
  if ($LASTEXITCODE -ne 0) { Die '网页打包失败' }
  Step '2b' '校验打包产物'
  & node (Join-Path $ROOT 'tools\check-bundle.mjs')
  if ($LASTEXITCODE -ne 0) { Die '打包产物集成测试未通过，已中止构建' }

  Step '2c' '规则回归测试'
  & node (Join-Path $ROOT 'engine\test\smoke.mjs')
  if ($LASTEXITCODE -ne 0) { Die '规则回归测试未通过，已中止构建' }
} else { Step 2 '打包网页资源（已跳过）' }

# ── [3] 组装 assets ───────────────────────────────────────
Step 3 '组装 assets（只放正式文件，开发用的 _preview/_diag/_frame 不进包）'
$assets = Join-Path $BUILD 'assets'
New-Item -ItemType Directory -Force -Path (Join-Path $assets 'dist') | Out-Null
# 只放正式文件，开发用的 _preview/_diag/_frame 不进包。
# 新增一个网页资源时，除了这里，还要记得加进 app/index.html 的引用；
# verify-apk.ps1 会按 APK 实际内容 + index.html 的引用双向校验，漏了会直接报错。
foreach ($f in @('index.html', 'style.css', 'screens.css')) {
  Copy-Item (Join-Path $APP $f) (Join-Path $assets $f) -Force
}
# dist/ 下现在是「加载器 bundle.js + modules/ 里一个源文件一个脚本」，整目录复制。
# （打成一个文件是以前的方案：设备上出错只会报 bundle.js:29000，跟源码对不上。）
Copy-Item (Join-Path $APP 'dist\*') (Join-Path $assets 'dist\') -Recurse -Force
Get-ChildItem $assets -Recurse -File | ForEach-Object {
  Ok "$($_.FullName.Replace($assets,'').TrimStart('\'))  $([math]::Round($_.Length/1KB,1)) KB"
}

# ── [4] 编译资源 + 生成 R.java ────────────────────────────
Step 4 'aapt2 编译资源'
$resZip = Join-Path $BUILD 'res.zip'
& (Join-Path $BUILDTOOLS 'aapt2.exe') compile --dir (Join-Path $APPROOT 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { Die 'aapt2 compile 失败' }
Ok "res.zip 生成"

Step '4b' 'aapt2 链接资源并打包基础 APK'
$baseApk = Join-Path $BUILD 'base.apk'
& (Join-Path $BUILDTOOLS 'aapt2.exe') link `
  -o $baseApk `
  -I $ANDROID_JAR `
  --manifest (Join-Path $APPROOT 'AndroidManifest.xml') `
  -R $resZip `
  -A $assets `
  --java (Join-Path $BUILD 'gen') `
  --min-sdk-version $MinSdk `
  --target-sdk-version $TargetSdk `
  --version-code $VersionCode `
  --version-name $VersionName `
  --auto-add-overlay
if ($LASTEXITCODE -ne 0) { Die 'aapt2 link 失败' }
Ok "base.apk  $([math]::Round((Get-Item $baseApk).Length/1KB,1)) KB"

Step '4c' '规范化 zip 条目名（字节级就地替换，不重建 zip）'
$fixedApk = Join-Path $BUILD 'base-fixed.apk'
$renamed = Repair-ZipEntryNames -InApk $baseApk -OutApk $fixedApk -AssetsDir $assets
if ($renamed -gt 0) {
  Ok "就地修正了 $renamed 处条目名（本地文件头 + 中央目录各一处）"
} else {
  Ok '条目名本来就是规范的'
}

# 复核 1：不应再有任何反斜杠条目
# 复核 2：resources.arsc 必须是 STORED，否则 targetSdk>=30 的设备会拒绝安装
Add-Type -AssemblyName System.IO.Compression.FileSystem
$chk = [System.IO.Compression.ZipFile]::OpenRead($fixedApk)
$bad = @($chk.Entries | Where-Object { $_.FullName.Contains([char]92) })
$arsc = $chk.Entries | Where-Object { $_.FullName -eq 'resources.arsc' }
$arscStored = $arsc -and ($arsc.CompressedLength -eq $arsc.Length)
$arscSizes = if ($arsc) { "$($arsc.CompressedLength)/$($arsc.Length)" } else { '缺失' }
$chk.Dispose()

if ($bad.Count -gt 0) { Die "仍有 $($bad.Count) 个条目含反斜杠" }
if (-not $arsc) { Die 'APK 里没有 resources.arsc' }
if (-not $arscStored) { Die "resources.arsc 被压缩了（$arscSizes），targetSdk>=30 的设备会拒绝安装" }
Ok "resources.arsc 未压缩（$arscSizes）"
$baseApk = $fixedApk

# ── [5] 编译 Java ─────────────────────────────────────────
Step 5 'javac 编译 Java 源码'
# 只编译 android/app/java 下的源码。
#
# 刻意**不编译** aapt2 生成的 build/gen/R.java：
#   · 它只为资源 ID 提供 Java 常量，而本工程没有任何 Java 代码引用 R
#     （AndroidManifest 里的 @mipmap / @string 由 aapt2 link 直接解析进 resources.arsc）；
#   · 它的嵌套类型会生成 R$mipmap / R$string / R$style 三个带 '$' 的 class 名，
#     而本工程要求 android/build/classes 下不出现任何带 '$' 的产物
#     （d8 的 R8 8.2.2-dev 处理内部类会崩，详见下面 [6] 的注释）。
# 将来真要在 Java 里用 R，就把下面这行 gen 目录加回来 —— 但那时 '零 $ 产物' 这条就不再成立：
#   $javaFiles += @(Get-ChildItem (Join-Path $BUILD 'gen') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
$javaFiles = @(Get-ChildItem (Join-Path $APPROOT 'java') -Recurse -Filter *.java | ForEach-Object { $_.FullName })
if ($javaFiles.Count -eq 0) { Die '没有找到任何 .java 文件' }

$javaArgs = @(
  '-J-Duser.language=en',          # 让 javac 报英文错误，避免控制台乱码
  '-encoding', 'UTF-8',
  '-source', '8', '-target', '8',
  '-bootclasspath', $ANDROID_JAR,
  '-cp', $ANDROID_JAR,
  '-d', (Join-Path $BUILD 'classes'),
  '-nowarn'
) + $javaFiles

# 注意：不能用 javac 的 @argfile —— 它会把路径里的反斜杠当转义符，
# 导致 "找不到文件: E:ka_paiandroidappjava..."。直接用数组传参。
& "$JdkHome\bin\javac.exe" @javaArgs 2>&1 |
  Where-Object { $_ -notmatch 'bootstrap class path|source value 8|target value 8|deprecat' } |
  ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Die 'javac 编译失败' }
$classCount = (Get-ChildItem (Join-Path $BUILD 'classes') -Recurse -Filter *.class).Count
Ok "编译出 $classCount 个 .class"

# ── [6] d8 生成 dex ───────────────────────────────────────
Step 6 'd8 生成 classes.dex'
# d8 是 build-tools 34.0.0 自带的 R8 8.2.2-dev。它的已知坑：
#   解析**匿名内部类**（class 文件里带 EnclosingMethod 属性的那些）时会内部 NPE ——
#     Error in ...\Xxx$1.class:
#     java.lang.NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
#   于是构建必然失败，且报的类随源码改动而变（哪个匿名类先被解析到就报哪个）。
# 对策不是绕开 d8，而是从源头不产生这类 class：android/app/java 下所有内部类
# （匿名类、具名嵌套类）都已提成顶层类，class 名里不再出现 '$'。
# 具名嵌套类其实不会触发这个 NPE（实测），一并提成顶层类是为了统一风格、
# 并保证 android/build/classes 下零 '$' 产物。
$classFiles = @(Get-ChildItem (Join-Path $BUILD 'classes') -Recurse -Filter *.class | ForEach-Object { $_.FullName })
$dexDir = Join-Path $BUILD 'dex'
& (Join-Path $BUILDTOOLS 'd8.bat') `
  --release `
  --lib $ANDROID_JAR `
  --min-api $MinSdk `
  --output $dexDir `
  @classFiles
if ($LASTEXITCODE -ne 0) { Die 'd8 失败' }
$dexFile = Join-Path $dexDir 'classes.dex'
if (-not (Test-Path $dexFile)) { Die "d8 没有产出 classes.dex" }
Ok "classes.dex  $([math]::Round((Get-Item $dexFile).Length/1KB,1)) KB"

# ── [7] 把 dex 塞进 APK ───────────────────────────────────
Step 7 '把 classes.dex 写入 APK'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$withDex = Join-Path $BUILD 'with-dex.apk'
Copy-Item $baseApk $withDex -Force
$zip = [System.IO.Compression.ZipFile]::Open($withDex, 'Update')
try {
  $existing = $zip.GetEntry('classes.dex')
  if ($existing) { $existing.Delete() }
  [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
    $zip, $dexFile, 'classes.dex', [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
} finally { $zip.Dispose() }
Ok "已写入"

# ── [8] zipalign ──────────────────────────────────────────
Step 8 'zipalign 对齐'
$aligned = Join-Path $BUILD 'aligned.apk'
# -p 让未压缩的 .so 按页对齐；4 是其余未压缩条目的对齐字节数。
# targetSdk>=30 时 resources.arsc 必须未压缩且 4 字节对齐，靠这一步保证。
& (Join-Path $BUILDTOOLS 'zipalign.exe') -f -p 4 $withDex $aligned
if ($LASTEXITCODE -ne 0) { Die 'zipalign 失败' }

# 用 zipalign -c 真正校验，而不是只看命令退出码
& (Join-Path $BUILDTOOLS 'zipalign.exe') -c -v 4 $aligned 2>&1 |
  Select-String -Pattern 'Verification|resources.arsc|classes.dex' |
  ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Die 'zipalign 校验未通过（对齐有问题，设备会拒绝安装）' }
Ok '已对齐并通过 zipalign -c 校验'

# ── [9] 签名 ──────────────────────────────────────────────
Step 9 '签名'
$keystore = Join-Path $ANDROID 'keystore.jks'
if (-not (Test-Path $keystore)) {
  Write-Host '  首次构建，生成自签名密钥库…'
  & "$JdkHome\bin\keytool.exe" -genkeypair -v `
    -keystore $keystore `
    -alias $KeystoreAlias `
    -keyalg RSA -keysize 2048 -validity 10000 `
    -storepass $KeystorePass -keypass $KeystorePass `
    -dname 'CN=KaPai Prototype, OU=Game, O=KaPai, L=Unknown, ST=Unknown, C=CN' 2>&1 |
    Where-Object { $_ -notmatch '^$' } | ForEach-Object { Write-Host "  $_" }
  if ($LASTEXITCODE -ne 0) { Die 'keytool 生成密钥库失败' }
  Ok 'keystore.jks 已生成'
} else {
  Ok 'keystore.jks 已存在（复用，保证升级安装可用）'
}

$outApk = Join-Path $DIST "ka-pai-$VersionName.apk"
if (Test-Path $outApk) { Remove-Item $outApk -Force }

& (Join-Path $BUILDTOOLS 'apksigner.bat') sign `
  --ks $keystore `
  --ks-key-alias $KeystoreAlias `
  --ks-pass "pass:$KeystorePass" `
  --key-pass "pass:$KeystorePass" `
  --v1-signing-enabled true `
  --v2-signing-enabled true `
  --v3-signing-enabled true `
  --out $outApk `
  $aligned
if ($LASTEXITCODE -ne 0) { Die 'apksigner 签名失败' }
Ok "已签名 -> $outApk"

# ── [10] 验证 ─────────────────────────────────────────────
Step 10 '验证 APK'
& (Join-Path $BUILDTOOLS 'apksigner.bat') verify --verbose $outApk 2>&1 | ForEach-Object { Write-Host "  $_" }
if ($LASTEXITCODE -ne 0) { Die 'APK 签名验证失败' }

Write-Host ''
& (Join-Path $BUILDTOOLS 'aapt2.exe') dump badging $outApk 2>&1 |
  Select-String -Pattern "^package|^application-label|^launchable-activity|^sdkVersion|^targetSdkVersion|^uses-permission" |
  ForEach-Object { Write-Host "  $_" }

$size = (Get-Item $outApk).Length
Write-Host ''
Write-Host ('─' * 58) -ForegroundColor DarkGray
Write-Host "✅ APK 构建成功" -ForegroundColor Green
Write-Host "   $outApk"
Write-Host "   $([math]::Round($size/1KB,1)) KB"
Write-Host ''
Write-Host '   安装到手机（需开启 USB 调试）:'
Write-Host "     adb install -r `"$outApk`""
Write-Host '─' * 58