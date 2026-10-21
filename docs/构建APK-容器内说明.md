# 在容器里构建 APK：现在卡在哪一步

> 这份文件是 0.65.0 这轮实测出来的，写给下次接手的人看：
> **不需要再从头试一遍**，缺的就一样东西。

## 一句话

`bash tools/build-apk.sh` 在手机容器里现在只卡在 **`aapt2`** 上。JDK 已经不是问题了。

```
=== [0] 检查工具链 ===
  ERR 找不到 aapt2: .toolchain/sdk/build-tools/36.0.0/aapt2
```

## 已经解决的部分

| 件 | 状态 |
|---|---|
| `javac` / `java` / `keytool` | ✅ 这轮装好了：Temurin JDK 21（aarch64 glibc） |
| `android.jar` | ✅ `.toolchain/sdk/platforms/android-34/android.jar` |
| `d8` / `apksigner` | ✅ `.toolchain/sdk/build-tools/36.0.0/`（都是 jar，有 JDK 就能跑） |
| `zipalign` | ✅ 可用 Ubuntu 的 arm64 包：`apt-get download zipalign && dpkg -x …` |
| `aapt2` | ❌ **缺** |

JDK 的装法（不需要 root，也别放进仓库）：

```bash
python3 - <<'PY'
import urllib.request
urllib.request.urlretrieve(
  'https://mirrors.tuna.tsinghua.edu.cn/Adoptium/21/jdk/aarch64/linux/'
  'OpenJDK21U-jdk_aarch64_linux_hotspot_21.0.12.1_1.tar.gz', '/root/tmp/jdk.tar.gz')
PY
cd /root/tmp && tar xzf jdk.tar.gz         # → /root/tmp/jdk-21.0.12.1+1
```

## 为什么 aapt2 拿不到（三条路都试过了）

1. **官方 build-tools（`build-tools_r34-linux.zip` 等）只有 x86_64 的 `aapt2`** ——
   本机是 aarch64，跑起来是 `cannot execute: required file not found`（缺 64 位 x86 加载器）。
   容器里也没有 qemu / box64。
2. **Ubuntu arm64 源里没有 `aapt2`**：`apt-cache search aapt` 只有 `aapt`（v1）和
   `android-libaapt`；`android-sdk-build-tools` 是 2.9KB 的元包。
3. **Termux 的 `aapt` 包（aarch64）跑不了**：它是 Bionic 二进制，要靠
   `/system/bin/linker64` 加载，而 proot 容器里看不到 `/system`。

## 有 aapt2 之后的完整命令

```bash
JDK=/root/tmp/jdk-21.0.12.1+1
cd /sdcard/ka_pai
JAVA_HOME=$JDK PATH=$JDK/bin:$PATH \
  AAPT2=/path/to/aapt2 ZIPALIGN=/path/to/zipalign \
  bash tools/build-apk.sh            # → dist/ka-pai-0.65.0.apk
```

（`build-apk.sh` 会用 `AAPT2=` / `ZIPALIGN=` 覆盖默认路径，这是它本来就支持的。）

## 还没验的那条路：改用 aapt（v1）

Ubuntu 的 `aapt` 是 arm64 + glibc，能跑。aapt v1 用一条 `aapt package` 同时完成
compile + link，所以理论上能把第 4 步换掉。但：

* v1 不支持 aapt2 的 `--auto-add-overlay` / 资源命名空间那套；
* 资源表格式和老版本一致（`android-34` 的 `android.jar` 得用对应版本的 aapt）；
* 换完必须重新验一遍「装得上、资源解析正确」，不能只看构建成功。

结论：**能用电脑打就在电脑上打**（`tools/build-apk.ps1`，工具链脚本也在那儿）；
真要在容器里打，先解决 aapt2。
