# 构建 APK（Godot 端）

> 旧版（WebView 壳）的打包链是 `tools/build-apk.ps1`，跟这份无关。
> 这份只讲**重构后的 Godot 工程**怎么出 Android 包。

## 0. 一句话

```bash
node tools/build-apk-godot.mjs            # 出调试包 → godot/build/android/ka-pai.apk
node tools/build-apk-godot.mjs --release  # 出正式包（用 debug 签名，见 §4）
```

## 1. 需要什么

| 东西 | 这台机器上的位置 | 说明 |
| --- | --- | --- |
| Godot 4.7.2 | `E:/kapai-tools/godot/Godot_v4.7.2-stable_win64_console.exe` | **自包含模式**（exe 旁有 `_sc_`）：编辑器设置与导出模板都在 `E:/kapai-tools/godot/editor_data/` |
| 导出模板 4.7.2 | `E:/kapai-tools/godot/editor_data/export_templates/4.7.2.stable/` | 只要 `android_debug.apk`、`android_release.apk`、`version.txt` 三个文件（全量 tpz 是 1.28 GB，安卓只要 221 MB，见 §3） |
| JDK 17 | `E:/kapai-tools/jdk17/jdk-17.0.21+9` | apksigner / d8 是 .bat，必须有 java |
| Android SDK | `E:/ka_pai/.toolchain/sdk` | 要 `build-tools/34.0.0`、`platforms/android-34`、**`platform-tools`（adb）** |
| 调试签名 | `E:/kapai-tools/godot/editor_data/keystores/debug.keystore` | 别名 `androiddebugkey`，两个口令都是 `android` |

路径写在 Godot 的编辑器设置里（自包含模式）：

```
export/android/android_sdk_path = "E:/ka_pai/.toolchain/sdk"
export/android/java_sdk_path    = "E:/kapai-tools/jdk17/jdk-17.0.21+9"
export/android/debug_keystore   = "E:/kapai-tools/godot/editor_data/keystores/debug.keystore"
```

## 2. 工程侧的三个开关

1. `godot/export_presets.cfg`：preset 名 `Android`，**只用 arm64-v8a**（`gradle_build/use_gradle_build=false`，走预编译模板，不需要 gradle）、`package/unique_name="com.kaipai.throneclash"`、`screen/immersive_mode=true`。
2. `godot/project.godot` 的 `rendering/textures/vram_compression/import_etc2_astc=true`。**不开这个导出会直接失败**（"导出 Android 版本需要 ETC2/ASTC 纹理压缩格式"）。
3. `godot/project.godot` 里 `display/window/handheld/orientation=1`（竖屏）、分辨率 720×1280 + `stretch/canvas_items`。

## 3. 只下需要的模板（省 1 GB）

`.tpz` 就是个 zip。先取尾部的 EOCD 拿到中央目录，再按 `Range` 只抓 `templates/android_debug.apk`（121 MB）、`templates/android_release.apk`（100 MB）、`templates/version.txt`，inflate 后放进 `export_templates/4.7.2.stable/`。
本仓库的 `tools/build-apk-godot.mjs` 里带了这段逻辑（`--fetch-templates`）。

## 4. 签名

现在用的是 **debug keystore**（`CN=Android Debug`）。所以：

- 能直接装、能覆盖同名同签名的后续 debug 包；
- **不能覆盖安装**旧的 WebView 版（旧版包名 `com.kaipai.prototype`、另一把密钥），两个 App 会并存在桌面上；
- 真要发正式版，得生成一把长期保存的 release keystore，改 `preset.0.options` 的 `keystore/` 系列字段（`keystore/release`、`keystore/release_user`、`keystore/release_password`），**并且备份密钥**——换了密钥就再也盖不上老版本。

## 5. 出包之后

```bash
E:/ka_pai/.toolchain/sdk/build-tools/34.0.0/aapt.exe dump badging godot/build/android/ka-pai.apk
E:/kapai-tools/jdk17/jdk-17.0.21+9/bin/java.exe -jar \
  E:/ka_pai/.toolchain/sdk/build-tools/34.0.0/lib/apksigner.jar verify -v godot/build/android/ka-pai.apk
```

安装：`E:/ka_pai/.toolchain/sdk/platform-tools/adb.exe install -r godot/build/android/ka-pai.apk`

## 6. 已知的坑

- 编辑器设置里 `user://` 目录那条报错（`Could not open 'user://' directory`）是 objectdb profiler 插件在自包含模式下抱怨，**无害**，不影响导出。
- `Could not find version of build tools that matches Target SDK, using 34.0.0` 也是提示：SDK 里只装了 34.0.0，targetSdk 36 会退回 34 的构建工具，能出包。
- **不要在 `--headless` 下截图**：headless 是 dummy 渲染器，截不到图（见 `tests/ui_shots.gd` 的用法）。
- 这台机器没有 `ANDROID_HOME`/`JAVA_HOME` 环境变量也能出包——Godot 只认编辑器设置。
