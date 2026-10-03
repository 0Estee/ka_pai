# 王座交锋（原名：卡牌对战原型）

一个四路线路制手机卡牌游戏。当前状态：**规则引擎完成 + 移动端界面可玩 + 可构建安装的 APK**。

---

## 项目结构

```
ka_pai/
├── docs/                        设计文档
│   ├── 规则书-v0.1.md           原始口述规则（设计档案，不再修改）
│   ├── 规则书-v0.2.md           ★ 当前生效的规则
│   ├── 裁决清单.md              规则漏洞与待裁决项
│   └── 联机协议.md              ★ Java 层与 JS 层之间唯一的契约
│
├── engine/                      ★ 规则引擎（纯 JS，零依赖）
│   ├── README.md                引擎架构 + 卡牌编写指南
│   ├── src/                     19 个模块，按职责拆分：
│   │                            constants / rng / keywords / board / damage / stats /
│   │                            mechanics† / auras / setup / turns / targets / amounts /
│   │                            actions / effects† / choices / combat / play / view / engine†
│   │                            （† = 纯转发的门面，实现已搬到同目录的小模块里）
│   ├── cards/user-cards.js      ★ 作者设计的卡牌 第二批（U01~U17）
│   ├── cards/user-cards-b3.js   ★ 作者设计的卡牌 第三批（U20~U362，由 tools/merge-b3.mjs 从 A~L 十二组片段合并生成）
│   ├── cards/test-cards.js      引擎自检用的演示卡 + 合并后的卡牌库 + 牌库构建（80 张抽样）
│   └── test/smoke.mjs           83 个规则回归测试
│
├── .dsh/skills/card-authoring/  ★ 制作卡牌的流程（给 AI 用的 skill）
│
├── data/
│   ├── 卡牌表.csv               卡牌一览（与 user-cards.js 一一对应）
│   └── 词条表.csv               词条一览
│
├── app/                         网页前端（手机优先）
│   ├── index.html
│   ├── style.css                对局界面的皮肤（深色/浅色/玻璃主题变量都在这）
│   ├── screens.css              首页 / 菜单 / 回放 / 大厅 的样式
│   ├── js/
│   │   ├── main.js              入口：屏幕路由 + DOM 事件绑定 + 调试钩子（__game 等）
│   │   ├── app-state.js         全部共享可变状态（screen / state / view / session …）
│   │   ├── render.js            渲染、主题、屏幕切换、菜单与战报
│   │   ├── game-flow.js         建局、回合驱动、对局结束与金币结算
│   │   ├── play-input.js        选牌与点击处理（含 NO_CHOICE_TARGET_KINDS 登记表）
│   │   ├── lan.js               局域网：大厅、开房、扫描、手动连接、退出
│   │   ├── replay-ui.js         回放播放器 + 回放档案增删改
│   │   ├── ui.js                对局棋盘渲染
│   │   ├── screens.js           各屏幕的 HTML
│   │   ├── ai.js                对手 AI + 4 个难度
│   │   ├── store.js             本地存档（localStorage + 内存降级）
│   │   ├── economy.js           金币奖励规则 + 等级曲线（可调表）
│   │   ├── replay.js            对局录制与回放
│   │   └── multiplayer.js       局域网：传输层 + 锁步会话
│   └── dist/
│       ├── bundle.js            加载器（自动生成，勿手改）：按顺序插入下面那些脚本
│       └── modules/             真正的代码：一个源文件一个脚本（36 个，按依赖顺序编号）
│
├── android/                     APK 外壳工程
│   ├── app/                     Manifest / res / java / assets
│   └── keystore.jks             自签名密钥库（构建时自动生成）
│
├── tools/
│   ├── build-web.mjs            ESM → 单文件传统脚本
│   ├── check-bundle.mjs         打包产物集成测试入口（无浏览器）
│   ├── checks/                  集成测试的分组：harness.mjs（DOM 桩）+ 每个 § 一个文件
│   ├── build-apk.ps1            ★ 手工构建 APK
│   ├── verify-apk.ps1           ★ APK 产物验证
│   ├── setup-android-sdk.ps1    下载 Android SDK build-tools
│   ├── make-icon.mjs            生成应用图标
│   └── screenshot.ps1           无头截图（开发验证用）
│
└── dist/                        APK 产物
```

> **拆文件时的两条规矩**（不遵守会构建失败或藏 bug）：
> 1. `tools/build-web.mjs` 把所有模块**拍平进同一个作用域**，所以任意两个模块
>    不能有同名的顶层 `function`/`const`/`let`/`class` —— 重名会让打包**直接报错**（这是刻意的，
>    以前重名会静默覆盖，害得定位了很久）。
> 2. `app/js/*.js` 之间**共享同一个作用域**：`app-state.js` 里声明的 `screen` / `state` / `session`
>    等状态，其它文件直接用裸名字读写，**不写 import**。这是既定约定，新拆出来的文件照做即可。
>    （`engine/src/*.js` 相反，它们必须写真正的 ESM import —— 因为 Node 测试直接按 ESM 加载它们。）
>
> 什么时候必须重新打包：改完 `app/js`、`engine/src`、`engine/cards` 里任何文件后都要跑
> `node tools/build-web.mjs`，否则手机里跑的（`app/dist/` 下的加载器与模块脚本）还是旧的。

---

## 快速开始

### 跑规则测试

```bash
node engine/test/smoke.mjs
```

### 在电脑浏览器里试玩

直接打开 `app/index.html` 即可（无需服务器）。

### 构建 APK

```bash
# 首次需要先装构建链（约 121 MB，约 20 秒）
powershell -ExecutionPolicy Bypass -File tools/setup-android-sdk.ps1

# 构建并签名（会自动跑规则测试 + 打包产物集成测试，任一失败即中止）
powershell -ExecutionPolicy Bypass -File tools/build-apk.ps1
```

产物：`dist/ka-pai-0.24.0.apk`

### 验证 APK 产物

```bash
powershell -ExecutionPolicy Bypass -File tools/verify-apk.ps1
```

不传参数时验 `dist` 里**最新**的那个 APK（以前这里写死了版本号，
出了新版本之后还在验旧包，一路 PASS 什么也没拦住）。

做五件事：
1. 检查 zip 条目名里没有反斜杠（aapt2 在 Windows 上的坑，会导致设备上资源 404 白屏）
2. 把 assets 从 APK 解出来，与源文件做 SHA256 比对
3. 用无头 Chrome **渲染 APK 内的资源**，证明实际装进手机的字节能跑
4. 用 APK 内的字节跑三条交互路径并**断言**（AI 开局 / 场上卡牌详情 / 冷启动回放）——
   这三类都是「界面画得出来、但点了没反应」的 bug，只看截图抓不到
5. 输出截图到 `shots/`

### 安装到手机

```bash
adb install -r dist/ka-pai-0.24.0.apk
```

或把 APK 传到手机上直接点击安装（需在系统设置里允许「安装未知来源应用」）。

首次安装后如果系统提示风险，属于**自签名 APK 的正常现象** —— 没有经过应用商店的签名链。

**兼容性**：最低 Android 7.0（API 24），目标 API 34。不申请任何权限（完全离线）。

---

## 环境要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 18 | 引擎、打包、测试都用它。**无 npm 依赖** |
| JDK | 17 或 21 | 构建 APK 用。本机用的是 `C:\Program Files\Java\jdk-21` |
| Android SDK build-tools | 34.0.0 | 由 `setup-android-sdk.ps1` 下载 |
| Android platform | android-34 | 提供 `android.jar` |

**不需要 Gradle，不需要 Android Studio，不需要任何 npm 包。**

---

## 为什么不用 Gradle

本机网络环境里 `services.gradle.org` 与 `registry.npmjs.org` 不可达，而 `dl.google.com` 可达。
由于本工程是纯 WebView 外壳、零第三方依赖，所以直接用 SDK 的 build-tools 手工构建：

```
aapt2 compile → aapt2 link → javac → d8 → 塞入 classes.dex → zipalign → apksigner
```

这比 Gradle 链路更短、更快，也更容易排查问题。

---

## 已知的坑（都踩过，记下来）

1. **PowerShell 5.1 的 `Invoke-WebRequest` 极慢**
   默认会为每个数据块渲染进度条，实测把下载从 6.9 MB/s 拖到 175 KB/s。
   所有下载脚本都要先设 `$ProgressPreference = 'SilentlyContinue'`。

2. **Windows 上 Chrome headless 的最小窗口宽度约 500px**
   `--window-size=412,915` 实际得到 `innerWidth ≈ 500`，截图只抓 412px，右侧会被裁掉，
   看起来像"布局溢出"，其实是截图工具的问题。
   验证手机布局要用 `app/_frame.html`（iframe 固定 390px 宽）。

3. **`targetSdk >= 30` 时 `resources.arsc` 必须不压缩，否则设备拒绝安装**
   症状：手机上弹出 `Failure [-124: ... requires the resources.arsc of installed APKs
   to be stored uncompressed and aligned on a 4-byte boundary]`。
   aapt2 本来已正确输出 STORED，但如果构建流程里**重建过 zip**
   （比如为了修 aapt2 在 Windows 上写出的反斜杠条目名），就会被重新压缩 ——
   .NET 的 `CompressionLevel.NoCompression` 实测并不可靠，写出来的仍是 deflate。
   本工程的做法是**字节级就地改名**（`\` → `/`，长度相同，zip 结构不变），
   并在构建流程里硬性校验 `resources.arsc` 的 STORED 状态与 `zipalign -c`。

4. **版本号有三处，`aapt2` 的 `--version-name` 不是后写的赢**
   `aapt2 link --version-code/--version-name` **只在 manifest 没写这两个属性时才生效**。
   三处要同步：`tools/build-apk.ps1` 的参数、`android/app/AndroidManifest.xml`、
   `app/js/screens.js` 的 `APP_VERSION`。一旦不同步，会安静地打出
   「文件名是 0.5.2、包内 versionCode 还是 5」的 APK，覆盖安装还会失败。
   `build-apk.ps1` 的 `[0]` 步现在会直接断言这三处一致。

5. **`$x = & chrome ... --dump-dom $url 2>$null` 拿到的是空字符串**
   Chrome 的 stdout 在「赋值 + 重定向」这个组合下会被丢掉，
   于是基于它的断言**全部静默通过或静默失败**。必须写
   `$x = (& chrome ... 2>&1 | Out-String)`。
   顺带一个：PowerShell 里 `?` 是**合法的变量名字符**，
   `"$base?demo=nav"` 会被解析成变量 `$base?demo`（空串），URL 退化成 `=nav`，
   Chrome 就跑去做搜索了 —— 要写 `"${base}?demo=nav"`。

6. **`__go('play')` 这类自检钩子绕过路由表**
   它直接改 `screen`，所以「按钮点了没反应 / 进不去下一级」这类 bug 它一条都测不到。
   门禁里走真实路由的断言要用 `__nav(act, dataset)`。

7. **改过 `tools/*.ps1` 之后，必须先跑一次 `node tools/build-web.mjs` 再构建**
   编辑工具保存时会**吃掉 UTF-8 BOM**，而 PowerShell 5.1 把无 BOM 的 .ps1 当 ANSI 读，
   中文注释会变成乱码并报 `MissingEndCurlyBrace`（报错位置完全对不上真正的原因）。
   `build-web.mjs` 每次都会自动补回 BOM（这一步不能靠 `build-apk.ps1` 自己救 ——
   它是解析期就失败了，代码根本没开始跑）。

8. **打包产物是「1 个加载器 + 一个源文件一个脚本」，不要手改 `app/dist/`**
   改代码只改 `engine/`、`app/js/`，然后 `node tools/build-web.mjs` 重新生成
   `app/dist/modules/`（36 个脚本，按依赖顺序编号）和加载器 `app/dist/bundle.js`。
   为什么要拆：打成一个文件时设备上出错只报 `bundle.js:29000`，跟源码对不上；
   拆开之后报错行号直接落在 `engine/src/actions.js` 这种真实文件上。
   ⚠ 这些脚本**不是** ESM（file:// 下 `type="module"` 被 CORS 挡掉），
   它们靠**全局作用域**互相引用 —— 所以模块之间**不能重名**，打包器会拦下来。

---

## 设计要点

规则的核心结构（详见 `docs/规则书-v0.2.md`）：

- **共享牌库** —— 双方抽同一个牌库，"我抽到强牌" = "对手少一张强牌"
- **4 路线路** —— 山地 / 平地(左) / 平地(右) / 水路，地形限制放置
- **5 排战场** —— 敌后排 / 敌前排 / 陷阱 / 我前排 / 我后排
- **前排阻挡，后排需先清前排** —— 交战目标优先级是 前排 → 后排 → 国王（裁决 D17）；
  只有 `溅射` 和 `穿透` 能越过前排直接碰到后排
- **费用上限 = 回合数** —— 节奏曲线自带
- **一回合内双方各行动两次** —— 先手放置 → 后手放置 → 先手锦囊 → 后手锦囊 → 开战

---

## 制作新卡（skill）

`.dsh/skills/card-authoring/` 是一份给 AI 用的流程说明书：作者发来手绘卡照片或口述效果时，
AI 会自动加载它，按固定步骤走完「辨认卡面 → 判断引擎缺什么机制 → 录入 → 补测试 →
重建 APK → 更新文档」。

手工查阅：

```
.dsh/skills/card-authoring/SKILL.md                     主流程
.dsh/skills/card-authoring/reference/引擎扩展指南.md      每种新机制改哪个文件
.dsh/skills/card-authoring/reference/踩坑与检查清单.md    踩过的坑 + 交付前自检清单
```

这份 skill 是**项目级**的（只在 `E:\ka_pai` 下生效）。想在别的项目里用，
把整个 `card-authoring` 目录复制到 `C:\Users\Administrator\.dsh\skills\` 即可。

---

## 首页与元系统

启动后先进首页，再选进对局：

```
首页 ──┬── 开始游戏 ──┬── AI 对决 ──→ 选难度（简单 / 普通 / 困难 / 噩梦）
       │              │                    └──「开始对战」──→ 对局
       │              └── 局域网对决 ──┬── 创建房间（我当主机）
       │                              └── 加入房间（扫描同一 Wi-Fi）──→ 联机大厅
       ├── 回放对局 ──→ 回放列表 ──→ 播放器（进度条 / 播放 / 倍速）
       └── 设置 ─────→ 深色 / 浅色 / 玻璃主题
```

**选难度页上的「开始对战」是必须的**：难度行只负责「选中」，
开局是它的职责。少了这个出口，选完难度就会绕回二级菜单 ——
一级级都进得去，却永远开不了局（这个 bug 修过一次，见踩坑 A21）。

对局里**点场上的任意卡牌**会弹出详情面板：有效攻击力（含光环修正）、生命、
词条全文、**卡面效果文字**，以及开战时这一击会打向谁。
棋盘格子放不下卡面文字，所以这张牌「在场上到底干什么」只能靠这个面板看。

### AI 的 4 个难度

定义在 [`app/js/ai.js`](app/js/ai.js) 的 `DIFFICULTIES` 表，**调难度只改这张表**。

| 难度 | 决策水平 | 额外优势 | 实测强度 |
|---|---|---|---|
| 简单 | **不会用锦囊**，只会下单位 | — | 被普通打 **67.3%** |
| 普通 | 加难度系统之前的老 AI | — | 基准 |
| 困难 | 和普通同级，但**不掷骰子**（去掉随机性） | 起手多 1 张 + 国王 +6 生命上限 | 打普通 **65.7%**（300 局；同侧对照 54.7%，高约 11 个百分点） |
| 噩梦 | 和困难同级 | 起手多 1 张 + 每回合多 1 费 + 国王 +8 生命上限 | 打普通 **90.0%**、打困难 **83.0%**（300 局；同侧对照 54.7%） |

**判断难度时不能拿 50% 当基准**：这套对打脚本有同侧座位偏置，两边参数完全一样时
实测会在 39%~54% 之间漂（取决于卡池）。所以上表所有比较都相对**同侧对照组**。
实测口径：125 张卡池、卡组 80 张抽样、每档 150 局。

⚠️ **困难和噩梦会给 AI 额外优势**，并且**在选难度界面逐条写明**，不偷偷作弊。

**关于「困难」的诚实说明**：这一档换过三次口径，前两次都是被实测推翻的 ——
最早是「永不跳过」（旧卡池 +2.3 个百分点，卡池变大后失效），
后来改成「一步预判」（当时 +6.6），**125 张卡池下再量反而比普通低 7 个百分点**。
完整扫描的结论是：**这个启发式 AI 在决策层面已经没有可调空间**，
换任何决策参数都不比普通强（多给起手牌也没用），唯一能真正拉开差距的是**资源优势**。
所以作者 2026-10 把两档定为：**困难** = 普通级的决策 + 起手多 1 张 + 国王 +6 生命上限（不加费）；
**噩梦** = 在困难基础上再加 **每回合多 1 费** + 国王再 +2（共 +8）。
新口径实测（各 300 局，同侧对照 54.7%）：困难打普通 **65.7%**，噩梦打普通 **90.0%**、打困难 **83.0%**。
两档的优势都逐条写在选难度界面上。要做出「决策上明显更强」的困难，
得给它一步真正的搜索（模拟自己出手后对手的最优应对），那是另一块工作。

### 局域网联机

协议见 [docs/联机协议.md](docs/联机协议.md)（**v2**）。

核心：**引擎完全确定性，所以只同步操作，不同步棋盘。**
双方各自跑同一个引擎，收到同一条操作各执行一次，状态自然一致 ——
这跟「回放」是同一件事，只是传输层换成了网络。

```
主机：开 HTTP(8765) + UDP 发现(8766)
      两端都从主机的 HTTP 服务加载页面（所以是同源，没有跨域问题）
      主机推进自动阶段并广播；任何一方轮到自己时报出操作
      每 8 步互发一次状态指纹，对不上就停下并提示

收消息：WebSocket /ws（常连接推送，20 秒一次心跳保活）
        连不上就自动回落到原来的长轮询 /api/poll ——
        因为客人是从主机的服务加载页面的，而主机可能还是旧版 APK
发消息：仍然走 HTTP POST /api/send（这条路径没动过）
```

| 文件 | 职责 |
|---|---|
| `docs/联机协议.md` | **Java 与 JS 之间唯一的契约**，改协议先改它 |
| `android/.../net/HttpGameServer.java` | 纯 Java：HTTP 服务 + 消息中继 + WebSocket 推送 + 长轮询 |
| `android/.../net/WebSocketPeer.java` | 纯 Java：手写 RFC 6455（握手 / 帧 / ping-pong），零依赖 |
| `android/.../net/WsReader.java` | WebSocket 读线程（顶层类：d8 会挂在匿名内部类上） |
| `android/.../net/RoomDiscovery.java` | 纯 Java：UDP 房间发现（应答器 + 探测器） |
| `android/.../NativeBridge.java` | `@JavascriptInterface`，给 JS 调的原生能力 |
| `app/js/multiplayer.js` | JS 侧：传输层（WS 优先 / 轮询回落）+ 锁步会话 + 状态指纹 |
| `tools/netserver/` | 桌面集成测试：真 socket 跑长轮询、seq、peer-left、**WebSocket 帧协议** |

**搜不到房间怎么办**：UDP 广播会被路由器的 AP 隔离 / 访客网络拦掉，
这时扫描永远是空的。加入房间的界面上**一直有一个手动输入框** ——
把主机大厅里显示的那串地址（`192.168.1.7:8765`）填进去即可，
端口不写就按默认 8765。
| `tools/netserver/` | 桌面测试：用真 socket 跑一遍服务端（100 条断言） |

**掉线处理**：暂停并等待重连，上限 60 秒；超时才判负。**主机掉线 = 房间消失**，
所以主机不能中途退出。

⚠️ **这套东西我没法在这里端到端验证**（没有两台手机、没有真实 Wi-Fi）。
已验证的是：服务端的桌面测试 100/100、锁步一致性（真实操作流灌进两个引擎全程一致）、
Java 能编进 APK。**跨设备能不能连上，只能你实测。**

### 金币与等级

规则全部集中在 [`app/js/economy.js`](app/js/economy.js)，**调平衡只改这一个文件**。

| 项 | 当前值 |
|---|---|
| 初始金币 | 100（**不计入累计**，不然白送一级） |
| 胜利 / 平局 / 战败 | +30 / +15 / +5（输也有保底，避免连败毫无进度感） |
| 表现加分 | 每剩 1 点国王生命 +1；第 8 回合内取胜额外 +10 |
| 模式系数 | **AI ×1.0，联机 ×2.0**（`MODE_MULTIPLIER`） |
| 等级 | 按**累计获得过的金币**算（花掉也不掉级），曲线 `200n + 25n(n-1)` |

等级看的是「累计」而不是余额，是为了以后接商店 —— 花钱买卡不该掉级。

### 回放

`app/js/replay.js`。**记的是「操作日志」，不是棋盘快照。**

引擎完全确定性（随机数全部来自 `state.rng`，AI 唯一的随机项也是它，
没有用 `Math.random`），所以「初始牌库 + 种子 + 每一步操作」就足以精确复现整局。

| | 操作日志（当前做法） | 棋盘快照（备选） |
|---|---|---|
| 体积 | 约 **5 KB / 局** | 约 150 KB / 局 |
| 5 MB 能存 | 几百局 | 三十几局 |

作者要求「存所有的」，所以只能走操作日志。

代价：操作里记的是手牌实例 id，**卡牌库一变旧回放就失效**。
所以每条回放都存了卡牌库指纹，对不上会标记成「卡牌库已变动，无法复现」，
只允许删除、不允许播放 —— 而不是播到一半崩掉。

回放是**只读**的：`refresh()` 会单独拼一份 `replayView`（合法落点、可出牌高亮全部清空），
**不碰实时对局的 `state`**。原因见踩坑 A22 —— 冷启动（这一节还没打过任何一局）
时实时对局的 `state` 是 `null`，一旦去读它就会抛异常，
界面会停在回放列表上，看着就是「点了回放没反应」。
门禁里有一条专门覆盖这条路径：`__dropLiveGame()` → 进列表 → 点回放 → 断言控制条渲染出来了。

### 本地存档

`app/js/store.js`。所有读写都兜在 try/catch 里，localStorage 不可用时**自动降级到内存**
（顶多丢进度，不会把游戏搞崩）。真机侧 `MainActivity` 已开 `setDomStorageEnabled(true)`。

---

## 阵营与超能力

（作者 2026-10-03）普通牌是中立的；**超能力**带阵营归属，不进普通牌库。难度页里选阵营（目前只有**恶魔**）：
开局抽 1 张超能力（令牌不进池），自己的国王血量掉到 **15 / 9 / 3** 以下时各再抽一张（不会重复）。
恶魔阵营在结束阶段按钮左边多一个**献祭**按钮：献祭场上自己的一名单位（**算作被消灭**，会触发被消灭效果）。
卡表见 `data/卡牌表.csv` 的 U397~U402，完整口径见 `docs/规则书-v0.2.md` 的 D72。

## 下一步

1. **只剩 1 张卡在等作者一个数字**：`坚韧`（2 费道具锦囊「一名队友获得装甲 X，并 +2♥」，X 目前按 1 录入）。
   其余 141 张手绘照片 + 6 张超能力/新卡已全部落地：**153 张卡**（含 23 张令牌、4 张阵营专属超能力；**126 张可入牌库**），缺机制/缺语义的卡都清了。
   历史清单（多数条目已作废）见 `data/_transcribe/第三批剩余待办.md`，最新能力速查见 `引擎DSL速查.md`。
2. **平衡数据**（800 局、卡组 80 张、可抽卡池 126 张；基准局不带超能力）：
   先手胜率 **50.4%**（403 胜 394 负，σ≈1.8% —— 0.2 个标准差，**在噪声范围内，不需要先手补偿**）、
   平均 **7.1 回合**、**牌库抽空收场 0%**、卡池覆盖 **126/126**。
   ⚠️ 之前几轮报过 46.7% / 52.3% / 54.0%，那是 300 局的抽样波动；判趋势请用 ≥800 局。
3. 决定正式游戏名（改 `android/app/res/values/strings.xml` 后重新构建 APK）
