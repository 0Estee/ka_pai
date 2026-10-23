# 在容器里构建 APK（0.68.0 起可行）

> 这份文件 0.65.0 时写的是「卡在 aapt2」；0.68.0 这轮找到可行解，**在容器里真的构建出来了**。
> 下面是结论 + 复现步骤，别再从头试。

## 一句话

用 **Debian/Ubuntu 源里的 `aapt2 2.19`（arm64）+ `android-34` 的 android.jar**，其余工具照旧。
一条命令：`bash tools/build-apk-container.sh`（它把下面这些环境变量固定住了）。

```
✅ APK 构建成功
   dist/ka-pai-0.68.0.apk   545.9 KB   versionCode 73 / versionName 0.68.0
```

## 为什么以前不行，现在行

| 结论 | 说明 |
|---|---|
| Google 的 build-tools 只有 **x86_64** 的 `aapt2` | 本机 aarch64，跑起来报 `cannot execute`；容器里没 qemu/box64 |
| Ubuntu ports 里**没有** `aapt2` 这个包名 | 但 `aapt` 包里带了它：`usr/lib/android-sdk/build-tools/debian/aapt2` |
| 它认不了 **android-36** 的 jar | 报 `RES_TABLE_TYPE_TYPE entry offsets overlap actual entry data` |
| 它**认 android-34** 的 jar | 本工程本来就用 `PLATFORM=android-34`，正好对上 |
| 它是动态链接的 | 要一起解出 `libaapt2.so.0` 等库并设 `LD_LIBRARY_PATH` |

## 一次性准备（不需要 root）

```bash
mkdir -p /root/tmp/apt1 && cd /root/tmp/apt1
apt-get download aapt zipalign zip unzip \
  libprotobuf32t64=3.21.12-8.2build1 \
  android-libaapt android-libandroidfw android-libbase android-libbacktrace \
  android-libcutils android-liblog android-libutils android-libziparchive libzopfli1
for d in *.deb; do dpkg -x "$d" root; done
```

⚠ 两个坑：

* `libprotobuf32t64` 必须**钉版本** `3.21.12-8.2build1`（noble/main）。
  镜像索引里 noble-updates 的 `3.21.12-8.2ubuntu0.3` 实际返回 404。
* 容器里**没有** `curl` / `wget`，所以用 `apt-get download`（它有网）或 python3 的 urllib。

JDK 21（aarch64 glibc）解在 `/root/tmp/jdk-21.0.12.1+1`（0.65.0 那轮就装好了）：

```bash
python3 - <<'PY'
import urllib.request
urllib.request.urlretrieve(
  'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/aarch64/linux/'
  'OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz', '/root/tmp/jdk.tar.gz')
PY
cd /root/tmp && tar xzf jdk.tar.gz
```

## 构建

```bash
cd /sdcard/ka_pai
bash tools/build-apk-container.sh              # 完整（含网页门禁：build-web / check-bundle / smoke）
bash tools/build-apk-container.sh --skip-web   # 门禁已经跑过，只重打包
```

它做的事就是把这几件事交给 `tools/build-apk.sh`：

```bash
export JAVA_HOME=/root/tmp/jdk-21.0.12.1+1
export PATH="$JAVA_HOME/bin:/opt/node-v22.23.2-linux-arm64/bin:/root/tmp/apt1/root/usr/bin:$PATH"
export LD_LIBRARY_PATH=/root/tmp/apt1/root/usr/lib/aarch64-linux-gnu/android:/root/tmp/apt1/root/usr/lib/aarch64-linux-gnu:/root/tmp/apt1/root/usr/lib
export AAPT2=/root/tmp/apt1/root/usr/lib/android-sdk/build-tools/debian/aapt2
export ZIPALIGN=/root/tmp/apt1/root/usr/lib/android-sdk/build-tools/debian/zipalign
```

`d8` / `apksigner` 用仓库自带的 `.toolchain/sdk/build-tools/36.0.0/`（都是 jar，有 JDK 就能跑），
`zip` / `unzip` 用上面解出来的 Debian 版。

## 构建完自查

```bash
python3 - <<'PY'
import zipfile
z = zipfile.ZipFile('dist/ka-pai-0.68.0.apk')
n = z.namelist()
for k in ['AndroidManifest.xml', 'classes.dex', 'resources.arsc', 'assets/index.html']:
    print('OK ' if k in n else 'MISSING ', k)
print('modules', len([x for x in n if x.startswith('assets/dist/modules/')]))
print('arsc stored?', z.getinfo('resources.arsc').compress_type == 0)   # targetSdk>=30 必须 Stored
PY
```

## 手机上装

```bash
adb install -r dist/ka-pai-0.68.0.apk
```

签名用的是 `android/keystore.jks`（已存在就复用，**别换** —— 换了密钥覆盖安装会失败）。
签出来的 APK 用 v2 + v3 方案签名（minSdk 24，v1/JAR 签名不需要，`apksigner` 也会自动跳过）。
