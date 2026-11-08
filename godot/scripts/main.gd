## 应用外壳：首页 ↔ 二级页面（设置/回放/联机）↔ 对局屏
##
## 只做切换与生命周期管理。界面细节在 scripts/ui/ 里，
## 规则与 AI 在 scripts/engine/ 与 scripts/ai/ 里 —— 这里不认识它们。
##
## 切屏时盖一层「帘子」(_fade)：首页会把整屏刷白再交给对局，对局回首页则从深色里浮出来。
extends Control

const KPSession := preload("res://scripts/ui/kp_session.gd")
const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSettings := preload("res://scripts/ui/kp_settings.gd")
const KPReplayData := preload("res://scripts/ui/kp_replay.gd")
const KPPageSettings := preload("res://scripts/ui/kp_settings_page.gd")
const KPPageReplay := preload("res://scripts/ui/kp_replay_page.gd")
const KPPageOnline := preload("res://scripts/ui/kp_online_page.gd")
const KPPageTodo := preload("res://scripts/ui/kp_todo_page.gd")
const KPForgePage := preload("res://scripts/ui/kp_forge_page.gd")
const KPForge := preload("res://scripts/ui/kp_forge.gd")
const KPProfile := preload("res://scripts/ui/kp_profile.gd")
const KPData := preload("res://scripts/ui/kp_data.gd")

var _screen: Control = null
var _fade: ColorRect = null
var _last_cfg: Dictionary = {}


func _ready() -> void:
	print("[王座交锋] main ready")
	_fade = ColorRect.new()
	_fade.name = "Fade"
	_fade.set_anchors_preset(Control.PRESET_FULL_RECT)
	_fade.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fade.color = Color(0.045, 0.055, 0.08, 1.0)
	add_child(_fade)
	show_home()


func _clear_screen() -> void:
	if _screen == null:
		return
	remove_child(_screen)
	_screen.queue_free()
	_screen = null


## 帘子盖到最上层，然后从 col 化开到透明
func _veil(col: Color, sec: float) -> void:
	if _fade == null:
		return
	move_child(_fade, get_child_count() - 1)
	_fade.color = col
	var tw := create_tween()
	tw.tween_property(_fade, "color", Color(col.r, col.g, col.b, 0.0), maxf(0.05, sec)) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)


func show_home() -> void:
	_clear_screen()
	var home := KPHome.new()
	home.anim = KPSettings.anim_scale()
	home.start_requested.connect(_on_start)
	home.open_page.connect(show_page)
	add_child(home)
	_screen = home
	_veil(Color(0.045, 0.055, 0.08, 1.0), 0.55)


## 二级页面：设置 / 回放 / 联机
func show_page(page_name: String) -> void:
	_clear_screen()
	var page: Control = null
	match page_name:
		"settings":
			page = KPPageSettings.new()
		"replay":
			var rp := KPPageReplay.new()
			rp.play_requested.connect(start_replay)
			page = rp
		"online":
			page = KPPageOnline.new()
		"forge":
			page = KPForgePage.new()
		"login", "range", "spectate":
			page = _todo_page(page_name)
		_:
			show_home()
			return
	page.anim = KPSettings.anim_scale()
	page.close_requested.connect(show_home)
	add_child(page)
	_screen = page
	_veil(Color(0.045, 0.055, 0.08, 0.92), 0.42)


## 还没做的四个入口：先把「要做什么」摆出来，功能排在后面的批次里
func _todo_page(which: String) -> Control:
	var tp := KPPageTodo.new()
	match which:
		"login":
			tp.head_text = "登 录"
			tp.crumb_line = "账号 · 云存档"
			tp.lines = [
				{"text": "手机号 + 验证码登录，把金币、卡组、强化进度存到云端。", "h": 26},
				{"text": "旧版 app/js/cloud.js 里有现成的账号与云存档逻辑。", "h": 24},
				{"text": "缺口：新的服务端要重写；本机还没有登录界面与令牌存储。", "h": 24, "col": Color(0.94, 0.42, 0.42)},
			]
			tp.when_text = "排期：批次 F"
			tp.note_text = "作者 m01990 第 17 条"
		"range":
			tp.head_text = "靶 场"
			tp.crumb_line = "随便摆牌试效果"
			tp.lines = [
				{"text": "自己摆双方场面，无限法力，随时检查一张牌到底怎么结算。", "h": 26},
				{"text": "引擎已经有 sandbox 模式（play_card 的 sandbox 分支），缺的只是界面。", "h": 24},
				{"text": "缺口：摆牌界面、单位拖放、数值手改。", "h": 24, "col": Color(0.94, 0.42, 0.42)},
			]
			tp.when_text = "排期：功能批次之后"
		_:
			tp.head_text = "观 战"
			tp.crumb_line = "看别人打"
			tp.lines = [
				{"text": "接进正在进行的对局，只看不打。", "h": 26},
				{"text": "引擎是确定性的：拿到「种子 + 动作序列」就能还原整局，", "h": 24},
				{"text": "所以观战本质是跟着别人的动作流重放。", "h": 24},
				{"text": "缺口：联机同步层还没实装。", "h": 24, "col": Color(0.94, 0.42, 0.42)},
			]
			tp.when_text = "排期：联机之后"
	tp.title_text = tp.head_text
	tp.close_requested.connect(show_home)
	return tp


func _on_start(cfg: Dictionary) -> void:
	var c := cfg.duplicate()
	# 我方带上工坊里练出来的增量；对手按难度与种子自己练（不消耗对局 rng）
	var lib: Dictionary = KPData.lib()
	var foe: Dictionary = KPForge.ai_forge(lib, int(c.get("seed", 0)), str(c.get("difficulty", "normal")))
	c["enhance"] = KPForge.build_enhance_pair(lib, KPProfile.load_profile(), foe)
	_last_cfg = c.duplicate()
	start_battle(c)
	_veil(Color(1, 1, 1, 1), 0.55)   # 接住首页最后那一片白光再化开


## 开一局。会话与界面同时建，会话的 changed 信号驱动界面重绘。
## 打完（或投降）自动把「种子 + 动作序列」存成回放。
func start_battle(cfg: Dictionary) -> void:
	_clear_screen()
	var sess := KPSession.new()
	var battle := KPBattle.new()
	battle.session = sess       # 先挂好会话，_ready 里要连它的信号
	battle.anim = KPSettings.anim_scale()
	battle.back_to_home.connect(show_home)
	battle.restart_requested.connect(_on_restart)
	add_child(battle)
	_screen = battle
	if _fade != null:
		move_child(_fade, get_child_count() - 1)
	sess.finished.connect(func():
		_save_record(sess)
		_settle_profile(sess))
	sess.start(cfg)             # 不 await：协程自己跑，状态通过 changed 回来


## 放一份回放：同种子同动作重演一遍
func start_replay(rec: Dictionary) -> void:
	_clear_screen()
	var sess := KPSession.new()
	var battle := KPBattle.new()
	battle.session = sess
	battle.anim = KPSettings.anim_scale()
	battle.back_to_home.connect(show_home)
	battle.restart_requested.connect(func(): start_replay(rec))
	add_child(battle)
	_screen = battle
	if _fade != null:
		move_child(_fade, get_child_count() - 1)
	sess.start_replay(rec)
	_veil(Color(0.045, 0.055, 0.08, 0.9), 0.4)


func _save_record(sess) -> void:
	if sess == null or sess.replay_mode or sess.record.is_empty():
		return
	KPReplayData.save(sess.make_record())


## 一局打完：算奖励、写档案、把结算塞进结果面板（重放不算战绩）
func _settle_profile(sess) -> void:
	if sess == null or sess.replay_mode or sess.rewarded:
		return
	if sess.game == null or not sess.game.is_over():
		return
	sess.rewarded = true
	var st: Dictionary = sess.game.state
	var human := int(sess.human_side)
	var kills := int((st.stats.get("killsBySide", [0, 0]) as Array)[human])
	var res := KPProfile.apply_result(KPProfile.load_profile(), st.get("winner", null), human,
		int(st.turn), float(st.players[human].kingHp), kills, "ai")
	KPProfile.save_profile(res.profile)
	var reward: Dictionary = res.reward
	var info := {
		"lines": reward.get("lines", []), "gold": int(reward.get("total", 0)),
		"dust": int(reward.get("dust", 0)), "perf": int(reward.get("perf", 0)),
		"goldAfter": int(res.profile.gold), "dustAfter": int(res.profile.dust),
		"levelAfter": int(res.levelAfter), "leveledUp": bool(res.leveledUp),
	}
	if _screen != null and _screen.has_method("show_reward"):
		_screen.show_reward(info)


func _on_restart() -> void:
	start_battle(_last_cfg)
	_veil(Color(1, 1, 1, 1), 0.45)
