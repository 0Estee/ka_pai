## 应用外壳：首页 ↔ 对局屏
##
## 只做切换与生命周期管理。界面细节在 scripts/ui/ 里，
## 规则与 AI 在 scripts/engine/ 与 scripts/ai/ 里 —— 这里不认识它们。
extends Control

const KPSession := preload("res://scripts/ui/kp_session.gd")
const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")

var _screen: Control = null
var _last_cfg: Dictionary = {}


func _ready() -> void:
	print("[王座交锋] main ready")
	show_home()


func _clear_screen() -> void:
	if _screen == null:
		return
	remove_child(_screen)
	_screen.queue_free()
	_screen = null


func show_home() -> void:
	_clear_screen()
	var home := KPHome.new()
	home.start_requested.connect(_on_start)
	add_child(home)
	_screen = home


func _on_start(cfg: Dictionary) -> void:
	_last_cfg = cfg.duplicate()
	start_battle(cfg)


## 开一局。会话与界面同时建，会话的 changed 信号驱动界面重绘。
func start_battle(cfg: Dictionary) -> void:
	_clear_screen()
	var sess := KPSession.new()
	var battle := KPBattle.new()
	battle.session = sess       # 先挂好会话，_ready 里要连它的信号
	battle.back_to_home.connect(show_home)
	battle.restart_requested.connect(func(): start_battle(_last_cfg))
	add_child(battle)
	_screen = battle
	sess.start(cfg)             # 不 await：协程自己跑，状态通过 changed 回来
