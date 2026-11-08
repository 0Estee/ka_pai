## 应用外壳：首页 ↔ 对局屏
##
## 只做切换与生命周期管理。界面细节在 scripts/ui/ 里，
## 规则与 AI 在 scripts/engine/ 与 scripts/ai/ 里 —— 这里不认识它们。
##
## 切屏时盖一层「帘子」(_fade)：首页会把整屏刷白再交给对局，对局回首页则从深色里浮出来。
extends Control

const KPSession := preload("res://scripts/ui/kp_session.gd")
const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")

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
	home.start_requested.connect(_on_start)
	add_child(home)
	_screen = home
	_veil(Color(0.045, 0.055, 0.08, 1.0), 0.55)


func _on_start(cfg: Dictionary) -> void:
	_last_cfg = cfg.duplicate()
	start_battle(cfg)
	_veil(Color(1, 1, 1, 1), 0.55)   # 接住首页最后那一片白光再化开


## 开一局。会话与界面同时建，会话的 changed 信号驱动界面重绘。
func start_battle(cfg: Dictionary) -> void:
	_clear_screen()
	var sess := KPSession.new()
	var battle := KPBattle.new()
	battle.session = sess       # 先挂好会话，_ready 里要连它的信号
	battle.back_to_home.connect(show_home)
	battle.restart_requested.connect(_on_restart)
	add_child(battle)
	_screen = battle
	if _fade != null:
		move_child(_fade, get_child_count() - 1)
	sess.start(cfg)             # 不 await：协程自己跑，状态通过 changed 回来


func _on_restart() -> void:
	start_battle(_last_cfg)
	_veil(Color(1, 1, 1, 1), 0.45)
