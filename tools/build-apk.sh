#!/usr/bin/env bash
# 手工构建 APK（不使用 Gradle / AndroidX / 任何 Maven 依赖）
# —— tools/build-apk.ps1 的 Linux 移植版。
#
# 为什么手工构建：
#   本机 Gradle 官方发行源不可达，AndroidX 所在的 maven.google.com 也未必可用。
#   本工程是纯 WebView 外壳、零第三方依赖，所以只需要一套命令行工具：
#     aapt2 (编译资源) → javac (编译 Java) → d8 (生成 dex) → zipalign → apksigner
#
# 用法:
#   bash tools/build-apk.sh
#   bash tools/build-apk.sh --skip-web
#   bash tools/build-apk.sh --skip-web --skip-icon
#
# 产物: dist/ka-pai-<version>.apk
#
# 本机（Debian / aarch64）的两个环境约束，脚本处处按它们写：
#   · 文件系统**不支持符号链接**，`chmod` 也**不生效** —— 从 Windows 拷过来的
#     脚本常没有可执行位，所以本脚本一律用 `bash <path>` 调用，也绝不建软链。
#     同理，本文件自身也不需要可执行位，用 `bash tools/build-apk.sh` 运行即可。
#   · PATH 上的 aapt2 是 Debian 包 2.19-debian，它**读不了** android-36 的
#     android.jar（资源表格式太新，报 `RES_TABLE_TYPE_TYPE entry offsets overlap
#     actual entry data`），必须固定用 android-34 那个。

set -o pipefail

# ── 路径推导 ──────────────────────────────────────────────
# 仓库根按脚本自身位置推导（tools/ 的上一级），不写死绝对路径 ——
# 写死的话别人克隆下来构建会指到不存在的目录。
# 这里不用 readlink，因为本机不支持符号链接，$0 一定就是真实路径。
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$SCRIPT_DIR")"

APP="$ROOT/app"
ANDROID="$ROOT/android"
APPROOT="$ANDROID/app"
BUILD="$ANDROID/build"
DIST="$ROOT/dist"

# 工具链默认装在仓库下的 .toolchain（tools/setup-android-sdk.ps1 就装在那里）。
SDK_ROOT="${SDK_ROOT:-$ROOT/.toolchain/sdk}"
BUILD_TOOLS_VERSION="${BUILD_TOOLS_VERSION:-36.0.0}"
SDK_BUILD_TOOLS="$SDK_ROOT/build-tools/$BUILD_TOOLS_VERSION"
PLATFORM="${PLATFORM:-android-34}"

# ── 默认参数 ──────────────────────────────────────────────
# 这两个值必须和 android/app/AndroidManifest.xml 里的 versionCode/versionName、
# 以及 app/js/screens.js 里的 APP_VERSION 保持一致，[0] 会做三处对账。
VERSION_NAME="0.71.0"
VERSION_CODE=76
MIN_SDK=24
TARGET_SDK=34
KEYSTORE_PASS="kapai123"
KEYSTORE_ALIAS="kapai"
SKIP_WEB=0
SKIP_ICON=0

# ── 输出helper ────────────────────────────────────────────
step() { printf '\n=== [%s] %s ===\n' "$1" "$2"; }
ok()   { printf '  OK  %s\n' "$1"; }
die()  { printf '  ERR %s\n' "$1" >&2; exit 1; }

usage() {
  cat <<'EOF'
用法: bash tools/build-apk.sh [选项]

  --skip-web            跳过网页打包与门禁（node build-web / check-bundle / engine smoke）
  --skip-icon           跳过图标生成（tools/make-icon.mjs）
  --version-name <值>   版本名，默认 0.65.0
  --version-code <值>   版本号，默认 64
  -h, --help            显示本帮助

可用环境变量覆盖工具路径：
  AAPT2 ZIPALIGN APKSIGNER D8 ANDROID_JAR SDK_ROOT BUILD_TOOLS_VERSION PLATFORM
  JAVA JAVAC KEYTOOL
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --skip-web)       SKIP_WEB=1 ;;
    --skip-icon)      SKIP_ICON=1 ;;
    --version-name)   [ -n "${2:-}" ] || die '--version-name 缺少值'; VERSION_NAME="$2"; shift ;;
    --version-name=*) VERSION_NAME="${1#*=}" ;;
    --version-code)   [ -n "${2:-}" ] || die '--version-code 缺少值'; VERSION_CODE="$2"; shift ;;
    --version-code=*) VERSION_CODE="${1#*=}" ;;
    -h|--help)        usage; exit 0 ;;
    *)                die "未知参数: $1（-h 看用法）" ;;
  esac
  shift
done

# ── 工具解析（环境变量 > PATH > SDK 目录）─────────────────
# 找不到就留空，交给 [0] 报一句人话，而不是在几十行之后报 command not found。
pick() {
  # pick <环境变量当前值> <PATH 上的命令名> <兜底绝对路径>
  if [ -n "$1" ]; then printf '%s' "$1"; return; fi
  local c; c="$(command -v "$2" 2>/dev/null || true)"
  if [ -n "$c" ]; then printf '%s' "$c"; return; fi
  printf '%s' "$3"
}

AAPT2="$(pick "${AAPT2:-}"     aapt2     "$SDK_BUILD_TOOLS/aapt2")"
ZIPALIGN="$(pick "${ZIPALIGN:-}" zipalign "$SDK_BUILD_TOOLS/zipalign")"
APKSIGNER="$(pick "${APKSIGNER:-}" apksigner "$SDK_BUILD_TOOLS/apksigner")"
JAVA="$(pick "${JAVA:-}"       java      /usr/bin/java)"
JAVAC="$(pick "${JAVAC:-}"     javac     /usr/bin/javac)"
KEYTOOL="$(pick "${KEYTOOL:-}" keytool   /usr/bin/keytool)"
NODE="$(pick "${NODE:-}"       node      /usr/bin/node)"

# d8：本机用的是 Google 官方 SDK 里的 bash 启动脚本（它会自己去找同目录的
# lib/d8.jar 并把堆开到 2G）。它没有可执行位，所以下面统一走 `bash <path>`；
# 若显式指定成 .jar，则退回 `java -cp <jar> com.android.tools.r8.D8`。
D8="${D8:-}"
if [ -z "$D8" ]; then
  if [ -f "$SDK_BUILD_TOOLS/d8" ]; then D8="$SDK_BUILD_TOOLS/d8"
  else D8="$SDK_BUILD_TOOLS/lib/d8.jar"; fi
fi
ANDROID_JAR="${ANDROID_JAR:-$SDK_ROOT/platforms/$PLATFORM/android.jar}"

# 统一的"调用外部工具"入口。
# 不可执行时退回 `bash <脚本>`：本机 chmod 无效，脚本多半没有可执行位。
run_tool() {
  local tool="$1"; shift
  if [ -x "$tool" ]; then
    "$tool" "$@"
  else
    bash "$tool" "$@"
  fi
}

run_d8() {
  case "$D8" in
    *.jar) "$JAVA" -Xmx2G -cp "$D8" com.android.tools.r8.D8 "$@" ;;
    *)     run_tool "$D8" "$@" ;;
  esac
}

# ── [0] 前置检查 ──────────────────────────────────────────
step 0 '检查工具链'
[ -f "$JAVAC" ]       || die "找不到 javac: $JAVAC"
[ -f "$KEYTOOL" ]     || die "找不到 keytool: $KEYTOOL"
[ -f "$AAPT2" ]       || die "找不到 aapt2: $AAPT2 —— 先装 aapt2，或用 AAPT2=/path 指定"
[ -f "$ZIPALIGN" ]    || die "找不到 zipalign: $ZIPALIGN —— 或用 ZIPALIGN=/path 指定"
[ -f "$APKSIGNER" ]   || die "找不到 apksigner: $APKSIGNER —— 或用 APKSIGNER=/path 指定"
[ -f "$D8" ]          || die "找不到 d8: $D8 —— 先运行 tools/setup-android-sdk.ps1，或用 D8=/path 指定"
[ -f "$ANDROID_JAR" ] || die "找不到 android.jar: $ANDROID_JAR"
[ -d "$APPROOT/res" ] || die "找不到资源目录: $APPROOT/res"

ok "javac      $JAVAC"
ok "aapt2      $AAPT2  ($("$AAPT2" version 2>&1 | head -1))"
ok "zipalign   $ZIPALIGN"
ok "apksigner  $APKSIGNER"
ok "d8         $D8"
ok "android.jar $ANDROID_JAR  (platform $PLATFORM)"

[ "$NODE" ] || die '找不到 node（打包网页资源需要）'

rm -rf "$BUILD"
mkdir -p "$DIST" "$BUILD/gen" "$BUILD/classes" "$BUILD/dex"

# ── [0] 版本号一致性 ──────────────────────────────────────
# aapt2 的 --version-code / --version-name **只在 manifest 没写这两个属性时才生效**，
# manifest 里写了就以 manifest 为准。所以两者一旦不同步，就会安静地打出一个
# 文件名是 0.5.2、包内 versionCode 还是 5 的 APK —— 手机上「覆盖安装」还会失败。
step 0 '版本号一致性（build-apk.sh ↔ AndroidManifest.xml ↔ screens.js）'
MF="$APPROOT/AndroidManifest.xml"
[ -f "$MF" ] || die "找不到 $MF"
mfCode="$(sed -n 's/.*android:versionCode="\([0-9][0-9]*\)".*/\1/p' "$MF" | head -1)"
mfName="$(sed -n 's/.*android:versionName="\([^"]*\)".*/\1/p' "$MF" | head -1)"
[ -n "$mfCode" ] && [ -n "$mfName" ] || die "manifest 里没解析出 versionCode/versionName: $MF"
if [ "$mfCode" != "$VERSION_CODE" ] || [ "$mfName" != "$VERSION_NAME" ]; then
  die "版本号不同步：脚本是 $VERSION_NAME($VERSION_CODE)，manifest 是 $mfName($mfCode)。"\
"请同时改 tools/build-apk.sh 与 android/app/AndroidManifest.xml"
fi
ok "manifest  versionName $mfName  versionCode $mfCode"

# 界面里显示的版本号也要跟上，否则会出现「设置页写着 0.5.1、装的却是 0.5.2」
UI_JS="$APP/js/screens.js"
[ -f "$UI_JS" ] || die "找不到 $UI_JS"
uiVer="$(sed -n "s/.*APP_VERSION[[:space:]]*=[[:space:]]*'\([^']*\)'.*/\1/p" "$UI_JS" | head -1)"
[ "$uiVer" = "$VERSION_NAME" ] || die "app/js/screens.js 的 APP_VERSION 是 $uiVer，和 $VERSION_NAME 对不上"
ok "界面 APP_VERSION $uiVer"

# ── [1] 图标 ──────────────────────────────────────────────
if [ "$SKIP_ICON" -eq 0 ]; then
  step 1 '生成应用图标'
  "$NODE" "$ROOT/tools/make-icon.mjs" || die '图标生成失败'
else
  step 1 '生成应用图标（已跳过）'
fi

# ── [2] 打包网页资源 ──────────────────────────────────────
# 这三条是门禁，红了不许出包：网页打包失败 / 打包产物集成测试不过 / 规则回归测试不过，
# 任何一条失败都直接中止 —— 宁可不发版，也不能把白屏或者规则跑偏的包发出去。
if [ "$SKIP_WEB" -eq 0 ]; then
  step 2 '打包网页资源为单文件脚本'
  "$NODE" "$ROOT/tools/build-web.mjs" || die '网页打包失败'

  step 2b '校验打包产物'
  "$NODE" "$ROOT/tools/check-bundle.mjs" || die '打包产物集成测试未通过，已中止构建'

  step 2c '规则回归测试'
  "$NODE" "$ROOT/engine/test/smoke.mjs" || die '规则回归测试未通过，已中止构建'
else
  step 2 '打包网页资源（已跳过）'
fi

# ── [3] 组装 assets ───────────────────────────────────────
step 3 '组装 assets（只放正式文件，开发用的 _preview/_diag/_frame 不进包）'
ASSETS="$BUILD/assets"
mkdir -p "$ASSETS/dist"
# 只放正式文件，开发用的 _preview/_diag/_frame 不进包。
# 新增一个网页资源时，除了这里，还要记得加进 app/index.html 的引用；
# verify-apk.ps1 会按 APK 实际内容 + index.html 的引用双向校验，漏了会直接报错。
for f in index.html style.css screens.css; do
  [ -f "$APP/$f" ] || die "缺少网页资源: app/$f"
  cp -f "$APP/$f" "$ASSETS/$f" || die "复制 $f 失败"
done

# 图片资源（属性徽记等）：源码里按 `img/xxx.png` 的相对路径引用。
# 漏打进去的症状是「设备上该处一片空白」，而构建过程完全正常，
# 所以 verify-apk.ps1 会按源码里的引用反向校验。
if [ -d "$APP/img" ]; then
  mkdir -p "$ASSETS/img"
  cp -R "$APP/img/." "$ASSETS/img/" || die '复制 img/ 失败'
else
  die "找不到图片目录: app/img"
fi

# dist/ 下现在是「加载器 bundle.js + modules/ 里一个源文件一个脚本」，整目录复制。
# （打成一个文件是以前的方案：设备上出错只会报 bundle.js:29000，跟源码对不上。）
[ -d "$APP/dist" ] || die "找不到 app/dist（先跑 tools/build-web.mjs，或去掉 --skip-web）"
mkdir -p "$ASSETS/dist"
cp -R "$APP/dist/." "$ASSETS/dist/" || die '复制 app/dist/ 失败'

while IFS= read -r f; do
  rel="${f#"$ASSETS"/}"
  size=$(stat -c %s "$f")
  ok "$rel  $(awk -v s="$size" 'BEGIN{printf "%.1f", s/1024}') KB"
done < <(find "$ASSETS" -type f | sort)

# ── [4] 编译资源 ──────────────────────────────────────────
step 4 'aapt2 编译资源'
RES_ZIP="$BUILD/res.zip"
run_tool "$AAPT2" compile --dir "$APPROOT/res" -o "$RES_ZIP" || die 'aapt2 compile 失败'
ok 'res.zip 生成'

step 4b 'aapt2 链接资源并打包基础 APK'
BASE_APK="$BUILD/base.apk"
run_tool "$AAPT2" link \
  -o "$BASE_APK" \
  -I "$ANDROID_JAR" \
  --manifest "$MF" \
  -R "$RES_ZIP" \
  -A "$ASSETS" \
  --java "$BUILD/gen" \
  --min-sdk-version "$MIN_SDK" \
  --target-sdk-version "$TARGET_SDK" \
  --version-code "$VERSION_CODE" \
  --version-name "$VERSION_NAME" \
  --auto-add-overlay || die 'aapt2 link 失败'
ok "base.apk  $(awk -v s="$(stat -c %s "$BASE_APK")" 'BEGIN{printf "%.1f", s/1024}') KB"

# 校验资源表是否未压缩。比对 zip 里的"压缩后大小"和"原始大小"：
# 二者相等才说明这一条是 STORED。
# 为什么必须 STORED：targetSdk >= 30 时 Android 强制要求 resources.arsc 不压缩，
# 否则设备直接拒绝安装：
#   Failure [-124: Failed parse during installPackageLI: Targeting R+ (version 30
#   and above) requires the resources.arsc of installed APKs to be stored
#   uncompressed and aligned on a 4-byte boundary]
check_arsc() {
  local apk="$1" line len method size
  line="$(unzip -lv "$apk" 2>/dev/null | awk '$NF=="resources.arsc" {print $1, $2, $3}')"
  [ -n "$line" ] || die "APK 里没有 resources.arsc：$apk"
  set -- $line
  len="$1"; method="$2"; size="$3"
  if [ "$method" != "Stored" ] || [ "$len" != "$size" ]; then
    die "resources.arsc 被压缩了（原始 $len / 压缩 $size / 方式 $method），targetSdk>=30 的设备会拒绝安装"
  fi
  ok "resources.arsc 未压缩（$size/$len）"
}

step 4c '校验 zip 条目名与 resources.arsc（不重建 zip）'
# Windows 上 aapt2 会把嵌套 assets 写成反斜杠分隔的条目名（assets/dist\bundle.js），
# 而 ZIP 规范与 Android AssetManager 都要求正斜杠，结果是网页引用 dist/bundle.js 时
# 在设备上 404、界面直接白屏。原脚本为此做「字节级就地替换」。
#
# Linux 版 aapt2 本来就输出正斜杠，所以这一步从「修复」改成「校验」：
# 一旦发现反斜杠条目就报错退出，告诉你去查 aapt2 的行为。
#
# 为什么绝不在这里重建 zip：targetSdk >= 30 时 resources.arsc 必须 STORED，
# 而任何"重建 zip"的做法都可能把它重新压缩，于是设备拒绝安装。所以这里一行字节都不改。
badNames="$(unzip -Z1 "$BASE_APK" | grep '\\' || true)"
if [ -n "$badNames" ]; then
  printf '%s\n' "$badNames" | head -10 >&2
  die "base.apk 里有条目名含反斜杠（共 $(printf '%s\n' "$badNames" | wc -l) 个），ZIP 规范要求正斜杠"
fi
ok '条目名本来就是规范的'
check_arsc "$BASE_APK"

# ── [5] 编译 Java ─────────────────────────────────────────
step 5 'javac 编译 Java 源码'
# 只编译 android/app/java 下的源码。
#
# 刻意**不编译** aapt2 生成的 build/gen/R.java：
#   · 它只为资源 ID 提供 Java 常量，而本工程没有任何 Java 代码引用 R
#     （AndroidManifest 里的 @mipmap / @string 由 aapt2 link 直接解析进 resources.arsc）；
#   · 它的嵌套类型会生成 R$mipmap / R$string / R$style 三个带 '$' 的 class 名，
#     而本工程要求 android/build/classes 下不出现任何带 '$' 的产物
#     （d8 处理内部类会崩，详见下面 [6] 的注释）。
# 将来真要在 Java 里用 R，就把 gen 目录加进来 —— 但那时「零 $ 产物」这条就不再成立。
mapfile -t javaFiles < <(find "$APPROOT/java" -name '*.java' -type f | sort)
[ "${#javaFiles[@]}" -gt 0 ] || die '没有找到任何 .java 文件'

# 注意不能用 javac 的 @argfile：它会把路径里的反斜杠当转义符；直接用数组传参。
# 先落到日志文件再看退出码 —— 走管道的话 javac 的退出码会被下游 sed 吃掉。
JAVAC_LOG="$BUILD/javac.log"
run_tool "$JAVAC" \
  -J-Duser.language=en \
  -encoding UTF-8 \
  -source 8 -target 8 \
  -bootclasspath "$ANDROID_JAR" \
  -cp "$ANDROID_JAR" \
  -d "$BUILD/classes" \
  -nowarn \
  "${javaFiles[@]}" >"$JAVAC_LOG" 2>&1
javacRc=$?
if [ "$javacRc" -ne 0 ]; then
  sed 's/^/  /' "$JAVAC_LOG" >&2
  die 'javac 编译失败'
fi

# 过滤掉这几类噪声，只把真正的问题打出来：
#   · bootstrap class path 未设置 的老生常谈（我们已经显式给了 -bootclasspath）
#   · source value 8 / target value 8 的 obsolete 警告
#   · deprecation 提示
grep -Ev 'bootstrap class path|source value 8|target value 8|deprecat' "$JAVAC_LOG" | sed 's/^/  /' || true

mapfile -t classFiles < <(find "$BUILD/classes" -name '*.class' -type f | sort)
[ "${#classFiles[@]}" -gt 0 ] || die 'javac 没有产出任何 .class'
ok "编译出 ${#classFiles[@]} 个 .class"

# ── [6] d8 生成 dex ───────────────────────────────────────
step 6 'd8 生成 classes.dex'
# d8 用的是 build-tools 里的 R8。它的已知坑：
#   解析**匿名内部类**（class 文件里带 EnclosingMethod 属性的那些）时会内部 NPE ——
#     Error in .../Xxx$1.class:
#     java.lang.NullPointerException: Cannot invoke "String.length()" because "<parameter1>" is null
#   于是构建必然失败，且报的类随源码改动而变（哪个匿名类先被解析到就报哪个）。
# 对策不是绕开 d8，而是从源头不产生这类 class：android/app/java 下所有内部类
# （匿名类、具名嵌套类）都已提成顶层类，class 名里不再出现 '$'。
# 具名嵌套类其实不会触发这个 NPE（实测），一并提成顶层类是为了统一风格、
# 并保证 android/build/classes 下零 '$' 产物。
dollarClasses="$(printf '%s\n' "${classFiles[@]}" | grep '\$' || true)"
if [ -n "$dollarClasses" ]; then
  printf '%s\n' "$dollarClasses" | head -10 >&2
  die 'android/build/classes 下出现了类名带 $ 的产物（内部类）。请把它提成顶层类，d8 处理内部类会崩'
fi

DEX_DIR="$BUILD/dex"
run_d8 --release --lib "$ANDROID_JAR" --min-api "$MIN_SDK" --output "$DEX_DIR" "${classFiles[@]}" || die 'd8 失败'
DEX_FILE="$DEX_DIR/classes.dex"
[ -f "$DEX_FILE" ] || die 'd8 没有产出 classes.dex'
ok "classes.dex  $(awk -v s="$(stat -c %s "$DEX_FILE")" 'BEGIN{printf "%.1f", s/1024}') KB"

# ── [7] 把 dex 塞进 APK ───────────────────────────────────
step 7 '把 classes.dex 写入 APK'
# 用 zip 追加而不是重建：Info-ZIP 会原样搬运其余条目（连同压缩方式），
# 所以 resources.arsc 的 STORED 得以保留 —— 重建 zip 正是踩过的那个坑（见 [4c]）。
WITH_DEX="$BUILD/with-dex.apk"
cp -f "$BASE_APK" "$WITH_DEX" || die '复制 base.apk 失败'
zip -q -X -j "$WITH_DEX" "$DEX_FILE" || die '把 classes.dex 写进 APK 失败'
unzip -Z1 "$WITH_DEX" | grep -qx 'classes.dex' || die 'APK 里没有 classes.dex'
ok '已写入'
# 写入 dex 之后再复核一次资源表，防止 zip 那一步把它改了压缩方式
check_arsc "$WITH_DEX"

# ── [8] zipalign ──────────────────────────────────────────
step 8 'zipalign 对齐'
ALIGNED="$BUILD/aligned.apk"
# -p 让未压缩的 .so 按页对齐；4 是其余未压缩条目的对齐字节数。
# targetSdk>=30 时 resources.arsc 必须未压缩且 4 字节对齐，靠这一步保证。
run_tool "$ZIPALIGN" -f -p 4 "$WITH_DEX" "$ALIGNED" || die 'zipalign 失败'

# 用 zipalign -c 真正校验，而不是只看命令退出码
ALIGN_LOG="$BUILD/zipalign.log"
run_tool "$ZIPALIGN" -c -v 4 "$ALIGNED" >"$ALIGN_LOG" 2>&1
alignRc=$?
grep -E 'Verification|resources.arsc|classes.dex' "$ALIGN_LOG" | sed 's/^/  /' || true
[ "$alignRc" -eq 0 ] || die 'zipalign 校验未通过（对齐有问题，设备会拒绝安装）'
ok '已对齐并通过 zipalign -c 校验'

# ── [9] 签名 ──────────────────────────────────────────────
step 9 '签名'
KEYSTORE="$ANDROID/keystore.jks"
# 已存在就复用：换密钥会导致签名不同，手机上的「覆盖安装」会直接失败，
# 用户得先卸载再装、本地存档全丢。
if [ ! -f "$KEYSTORE" ]; then
  printf '  首次构建，生成自签名密钥库…\n'
  run_tool "$KEYTOOL" -genkeypair -v \
    -keystore "$KEYSTORE" \
    -alias "$KEYSTORE_ALIAS" \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$KEYSTORE_PASS" -keypass "$KEYSTORE_PASS" \
    -dname 'CN=KaPai Prototype, OU=Game, O=KaPai, L=Unknown, ST=Unknown, C=CN' >"$BUILD/keytool.log" 2>&1
  keytoolRc=$?
  grep -v '^$' "$BUILD/keytool.log" | sed 's/^/  /' || true
  [ "$keytoolRc" -eq 0 ] && [ -f "$KEYSTORE" ] || die 'keytool 生成密钥库失败'
  ok 'keystore.jks 已生成'
else
  ok 'keystore.jks 已存在（复用，保证升级安装可用）'
fi

OUT_APK="$DIST/ka-pai-$VERSION_NAME.apk"
rm -f "$OUT_APK"

run_tool "$APKSIGNER" sign \
  --ks "$KEYSTORE" \
  --ks-key-alias "$KEYSTORE_ALIAS" \
  --ks-pass "pass:$KEYSTORE_PASS" \
  --key-pass "pass:$KEYSTORE_PASS" \
  --v1-signing-enabled true \
  --v2-signing-enabled true \
  --v3-signing-enabled true \
  --out "$OUT_APK" \
  "$ALIGNED" || die 'apksigner 签名失败'
ok "已签名 -> $OUT_APK"

# ── [10] 验证 ─────────────────────────────────────────────
step 10 '验证 APK'
run_tool "$APKSIGNER" verify --verbose "$OUT_APK" >"$BUILD/verify.log" 2>&1
verifyRc=$?
sed 's/^/  /' "$BUILD/verify.log"
[ "$verifyRc" -eq 0 ] || die 'APK 签名验证失败'

printf '\n'
"$AAPT2" dump badging "$OUT_APK" 2>&1 \
  | grep -E '^(package|application-label|launchable-activity|sdkVersion|targetSdkVersion|uses-permission)' \
  | sed 's/^/  /'

size=$(stat -c %s "$OUT_APK")
printf '\n'
printf '%s\n' '──────────────────────────────────────────────────────────'
printf '✅ APK 构建成功\n'
printf '   %s\n' "$OUT_APK"
printf '   %s KB\n' "$(awk -v s="$size" 'BEGIN{printf "%.1f", s/1024}')"
printf '   sha256 %s\n' "$(sha256sum "$OUT_APK" | cut -d' ' -f1)"
printf '\n'
printf '   安装到手机（需开启 USB 调试）:\n'
printf '     adb install -r "%s"\n' "$OUT_APK"
printf '%s\n' '──────────────────────────────────────────────────────────'