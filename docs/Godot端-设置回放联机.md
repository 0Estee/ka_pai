# Godot 端：设置 / 回放 / 联机三页

> 首页光球环形菜单的一级环现在有 7 个入口：阵营、难度、**设置**、**联机**、开始对局、**回放**、种子。
> 三个新页共用外壳 `scripts/ui/kp_page.gd`（KPPage），语言与首页一致：星云底 + 暗角 + 标题下一颗小光球，内容错峰从光球方向长出来。

## 1. 外壳 KPPage

| 常量 | 值 | 说明 |
| --- | --- | --- |
| `DESIGN` | 720×1280 | 设计稿尺寸，与首页/对局屏同一套 |
| `ORB_CENTER` / `ORB_RAD` | (360,214) / 44 | 标题下方的小光球 |
| `BODY_TOP` / `BODY_BOTTOM` | 296 / 1120 | 子类只往这个区间里放东西 |

子类实现 `_fill()`，用 `_row()`（色条 + 标题 + 说明）、`_pills()`（药丸单选组）、`_button()`、`_note()` 拼内容，`_reveal(ctrl)` 做错峰入场。
左上「‹ 返回」发 `close_requested`，由 `main.gd` 换回首页。

## 2. 设置页（kp_settings_page.gd，一行一个 `_row`）

| 行 | 选项 | 落库键 |
| --- | --- | --- |
| 光球特效 | 关 / 省电 / 全效 | `fx_level` |
| 动画速度 | 慢 / 标准 / 快 | `anim_speed` |
| AI 思考停顿 | 无 / 短 / 标准 | `ai_pace` |
| 默认难度 | 简单…不可能（5 档，取 `KPData.difficulties()`） | `difficulty` |
| 牌库张数 | 60 / 80 / 100 | `deck_size` |

落盘：`user://settings.cfg`（`[player]` 段），实现见 `scripts/ui/kp_settings.gd`（KPSettings，全 static，带内存缓存）。
派生值：`fx_level()`、`anim_speed()`、`anim_scale()`（[1.35, 1.0, 0.7]，越大越慢）、`ai_pace()`、`difficulty()`、`deck_size()`。
首页与对局屏在开场时读一次：`home.anim = KPSettings.anim_scale()`、`battle.anim = …`、`_build_cfg()` 里带 `deckSize` 与 `pace`。改特效档会立刻作用到当前页的小光球（`_orb.set_fx(i)`）。
底部「恢复默认」一键回 2 / 标准 / 标准 / 普通 / 80。

## 3. 回放页（kp_replay_page.gd + kp_replay.gd）

**不录像。** 录的只有「种子 + 人类那侧的动作序列」——因为引擎是确定性的（`tests/parity.gd` 与 JS 版 12 局 / 901 步逐字节对拍过），同一份种子 + 同一串动作必然复现同一局。一份回放几 KB。

- 录制：`KPSession` 里 `recording := true`（默认开），`play_card` / `end_phase` / `answer_choice` / `surrender` 各记一条 `{t, iid, opts, answer}`。
  **关键：动作必须在执行前入账**（`_rec_begin()` 返回下标，失败时 `_rec_abort()`）——否则一手牌中途弹出提问时，录下来的顺序会变成「play, play, choice, play」，重放时消费到 choice 引擎却没有 pending，直接卡死。
- 存盘：`user://replays/<时间戳>_seed<种子>_<易读>.json`，最多留 24 份，超出按 `savedAt` 删旧。`KPReplay.list()` 按时间倒序。
  **坑**：这个 Godot 4.7.2 构建里 `DirAccess.open("user://…")` 恒为 null（`FileAccess` 却正常）⇒ 所有 `DirAccess` 调用改走 `ProjectSettings.globalize_path()`。
- 重放：`KPSession.start_replay(rec)` 用同一份种子/阵营/难度/牌库重开一局，然后 `_replay_drive()` 按录下的动作逐条喂回去。出牌在这里必须**点火不 await**（跟界面一样），await 会把驱动器挂死。
- 对局屏进入回放态后：横幅写「回放中 · 第 N 回合 · 阶段」，行动区换成「退出回放 / 自动播放中 / 返回首页」，点手牌与结束阶段都不生效（只能看单位详情）。
- 页面上每条回放显示「种子 X · 难度 · N 回合 · 胜负」+「我方/对手阵营 · N 手操作 · 结束原因 · 时间」，右侧「播放」「删除」，底部「清空全部」「回首页」。

## 4. 联机页（kp_online_page.gd）

刻意**不做假功能**：

- 本机地址卡：真实 IPv4（过滤 IPv6 与 127.*）+ 端口 **7842**，带「复制地址」（`DisplayServer.clipboard_set`）与「刷新」。
- 对战模式卡：单人 vs AI **可用**；同机双人 **排期中**；局域网 **未实装**。
- 「还差什么」卡：同步层要做的三件事（棋盘状态同步、提问裁决归属、断线重连）。
- 底下三颗按钮：开始单人 / 复制地址 / 刷新。

## 5. 自检覆盖

`tests/ui_pages.gd`（54 项）：设置页药丸数 17、逐项点击后落盘值与内存值一致、重开读回、恢复默认；联机页地址非空且形如 IPv4、端口 7842、返回钮发 `close_requested`；回放页「直播一局 → 存 → 列表可见 → 重放结果一致 → 带界面重放（横幅/按钮/点牌不推进引擎）」。
`tests/ui_qa.gd`（451 项）把三页也纳入越界/文字截断扫描，并检查内容不越过 `BODY_BOTTOM`。
截图：`--only-pages` 参数只出这三页 → `shots/refactor-godot-page-{settings,online,replay}.png`。
