#!/usr/bin/env bash
# 在**手机容器里**构建 APK（PC 上用 tools/build-apk.ps1，或带官方 aapt2 的 tools/build-apk.sh）。
#
# 容器里唯一缺的是「官方 aapt2」（Google 只发 x86_64）。但 Debian/Ubuntu 源里的
# aapt2 2.19 是 arm64 的，而且**认 android-34 的 android.jar**（认不了 android-36，
# 会报 RES_TABLE_TYPE_TYPE entry offsets overlap actual entry data）。
# 所以这里把 Debian 那套工具解到 /root/tmp 下，用环境变量交给 build-apk.sh。
#
# 首次准备（一次性，不需要 root；2026-10-23 实测可用的版本）：
#   mkdir -p /root/tmp/apt1 && cd /root/tmp/apt1
#   apt-get download aapt zipalign zip unzip \
#     libprotobuf32t64=3.21.12-8.2build1 \
#     android-libaapt android-libandroidfw android-libbase android-libbacktrace \
#     android-libcutils android-liblog android-libutils android-libziparchive libzopfli1
#   for d in *.deb; do dpkg -x "$d" root; done
#   # JDK 21（aarch64 glibc）解在 /root/tmp/jdk-21.0.12.1+1
#   # ⚠ libprotobuf32t64 要显式钉到 noble/main 的 3.21.12-8.2build1：
#   #   镜像索引里 noble-updates 那个 3.21.12-8.2ubuntu0.3 实际返回 404。
#
# 之后每次只要：
#   bash tools/build-apk-container.sh              # 完整跑（含网页门禁）
#   bash tools/build-apk-container.sh --skip-web   # 门禁已经跑过，只重打包
set -o pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"

export JAVA_HOME="${JAVA_HOME:-/root/tmp/jdk-21.0.12.1+1}"
TOOLS="${APK_TOOLS:-/root/tmp/apt1/root}"
export PATH="$JAVA_HOME/bin:/opt/node-v22.23.2-linux-arm64/bin:$TOOLS/usr/bin:$PATH"
# Debian 的 aapt2 / zipalign 是动态链接的，库在解出来的 usr/lib 下
export LD_LIBRARY_PATH="$TOOLS/usr/lib/aarch64-linux-gnu/android:$TOOLS/usr/lib/aarch64-linux-gnu:$TOOLS/usr/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
export AAPT2="${AAPT2:-$TOOLS/usr/lib/android-sdk/build-tools/debian/aapt2}"
export ZIPALIGN="${ZIPALIGN:-$TOOLS/usr/lib/android-sdk/build-tools/debian/zipalign}"

[ -f "$AAPT2" ] || { echo "找不到 aapt2: $AAPT2（见本文件顶部的准备步骤）" >&2; exit 1; }
cd "$ROOT" || exit 1
exec bash tools/build-apk.sh "$@"
