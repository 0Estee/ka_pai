## 首页：选阵营、选难度、定种子，然后开始对局
class_name KPHome
extends Control

signal start_requested(cfg: Dictionary)

const U := preload("res://scripts/ui/kp_ui.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

const DESIGN := Vector2(720, 1280)

var _frame: Control
var _faction_key := ""
var _difficulty_key := "normal"
var _seed_edit: LineEdit
var _faction_buttons: Array = []
var _difficulty_buttons: Array = []


func _ready() -> void:
	# 自己管尺寸：不靠父节点的布局通知（顶层 Control 挂在 Window 下时它不一定来）
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	var vp := get_viewport_rect().size
	if vp.x > 0.0 and vp.y > 0.0:
		size = vp
	resized.connect(_fit)
	if not get_viewport().size_changed.is_connected(_fit):
		get_viewport().size_changed.connect(_fit)
	_build()


func _fit() -> void:
	if _frame == null:
		return
	var avail := size
	if avail.x <= 0.0 or avail.y <= 0.0:
		avail = get_viewport_rect().size
	if avail.x <= 0.0 or avail.y <= 0.0:
		avail = DESIGN
	var s := minf(avail.x / DESIGN.x, avail.y / DESIGN.y)
	if s <= 0.0 or not is_finite(s):
		s = 1.0
	_frame.scale = Vector2(s, s)
	_frame.position = (avail - DESIGN * s) * 0.5


func _build() -> void:
	var bg := ColorRect.new()
	bg.color = U.BG
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	_frame = Control.new()
	_frame.size = DESIGN
	add_child(_frame)

	_lab("王座交锋", Rect2(0, 54, 720, 74), 52, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	_lab("重构版 · Godot 手机端", Rect2(0, 128, 720, 28), 16, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)

	_lab("选择阵营（决定本局能抽到的超能力）", Rect2(24, 178, 672, 26), 17, U.FACTION)
	var factions: Array = DATA.factions()
	for i in factions.size():
		var f: Dictionary = factions[i]
		var col := i % 3
		var row := i / 3
		var rect := Rect2(24 + col * 228, 212 + row * 68, 216, 60)
		var b := _tile(str(f.name), rect, func(): _pick_faction(str(f.key)))
		b.tooltip_text = str(f.note)
		_faction_buttons.append({"key": str(f.key), "button": b})

	var dy := 212 + ((factions.size() + 2) / 3) * 68 + 16
	_lab("选择难度", Rect2(24, dy, 672, 26), 17, U.FACTION)
	var diffs: Array = DATA.difficulties()
	for j in diffs.size():
		var d: Dictionary = diffs[j]
		var rect2 := Rect2(24, dy + 34 + j * 62, 672, 56)
		var b2 := _tile("%s —— %s" % [str(d.name), str(d.tagline)], rect2, func(): _pick_difficulty(str(d.key)))
		_difficulty_buttons.append({"key": str(d.key), "button": b2})

	var sy := dy + 34 + diffs.size() * 62 + 12
	_lab("种子（留空=随机）", Rect2(24, sy + 10, 200, 26), 15, U.DIM)
	_seed_edit = LineEdit.new()
	_seed_edit.position = Vector2(232, sy)
	_seed_edit.size = Vector2(300, 52)
	_seed_edit.placeholder_text = "随机"
	_seed_edit.add_theme_font_size_override("font_size", 18)
	_seed_edit.add_theme_stylebox_override("normal", U.box(U.PANEL, 10, U.LINE))
	_seed_edit.add_theme_stylebox_override("focus", U.box(U.PANEL_HI, 10, U.GOLD))
	_frame.add_child(_seed_edit)

	var dice := Button.new()
	dice.text = "随机"
	dice.position = Vector2(544, sy)
	dice.size = Vector2(152, 52)
	dice.add_theme_font_size_override("font_size", 18)
	dice.add_theme_stylebox_override("normal", U.box(U.PANEL_HI, 10, U.LINE))
	dice.add_theme_stylebox_override("hover", U.box(U.PANEL_HI, 10, U.GOLD))
	dice.pressed.connect(func(): _seed_edit.text = str(randi() % 1000000000))
	_frame.add_child(dice)

	var start := Button.new()
	start.text = "开 始 对 局"
	start.position = Vector2(84, sy + 74)
	start.size = Vector2(552, 96)
	start.add_theme_font_size_override("font_size", 30)
	start.add_theme_color_override("font_color", Color("1a1405"))
	start.add_theme_stylebox_override("normal", U.box(U.GOLD, 16))
	start.add_theme_stylebox_override("hover", U.box(U.GOLD.lightened(0.12), 16))
	start.add_theme_stylebox_override("pressed", U.box(U.GOLD.darkened(0.15), 16))
	start.pressed.connect(_start)
	_frame.add_child(start)

	_lab("对手阵营随机；对局中长按/再点卡牌可看详情", Rect2(0, sy + 182, 720, 24), 13, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_lab("v0.80.0 · 规则引擎 scripts/engine/kp_game.gd", Rect2(0, 1216, 720, 24), 12, Color("5d677d"), HORIZONTAL_ALIGNMENT_CENTER)

	_pick_faction("")
	_pick_difficulty("normal")


func _lab(text: String, rect: Rect2, fs: int, col: Color, align: int = HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := U.label(text, fs, col, align)
	l.position = rect.position
	l.size = rect.size
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(l)
	return l


func _tile(text: String, rect: Rect2, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.position = rect.position
	b.size = rect.size
	b.alignment = HORIZONTAL_ALIGNMENT_LEFT
	b.add_theme_font_size_override("font_size", 17)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_stylebox_override("normal", U.pad(U.box(U.PANEL, 12, U.LINE), 12, 6, 12, 6))
	b.add_theme_stylebox_override("hover", U.pad(U.box(U.PANEL_HI, 12, U.GOLD), 12, 6, 12, 6))
	b.add_theme_stylebox_override("pressed", U.pad(U.box(U.BG_SOFT, 12, U.GOLD), 12, 6, 12, 6))
	b.set_meta("base_style", "normal")
	b.pressed.connect(cb)
	_frame.add_child(b)
	return b


func _pick_faction(key: String) -> void:
	_faction_key = key
	for entry in _faction_buttons:
		_mark_tile(entry, str(entry.key) == key)


func _pick_difficulty(key: String) -> void:
	_difficulty_key = key
	for entry in _difficulty_buttons:
		_mark_tile(entry, str(entry.key) == key)


func _mark_tile(entry: Dictionary, on: bool) -> void:
	var b: Button = entry.button
	if on:
		b.add_theme_stylebox_override("normal", U.pad(U.box(Color("26313f"), 12, U.GOLD, 2), 12, 6, 12, 6))
		b.add_theme_color_override("font_color", U.GOLD)
	else:
		b.add_theme_stylebox_override("normal", U.pad(U.box(U.PANEL, 12, U.LINE), 12, 6, 12, 6))
		b.add_theme_color_override("font_color", U.TEXT)


func _start() -> void:
	var seed_text := _seed_edit.text.strip_edges()
	var seed_v := 0
	if seed_text.is_valid_int():
		seed_v = int(seed_text)
	else:
		seed_v = randi() % 1000000000
	var factions: Array = DATA.factions()
	var ai_key := ""
	if factions.size() > 1:
		var idx := randi() % factions.size()
		ai_key = str(factions[idx].key)
	start_requested.emit({
		"seed": seed_v,
		"difficulty": _difficulty_key,
		"humanFaction": _faction_key,
		"aiFaction": ai_key,
		"deckSize": 80,
		"humanSide": 0,
	})
