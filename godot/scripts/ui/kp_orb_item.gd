## 环形菜单上的一个选项：一枚玻璃药丸，背后一团随状态变亮的光。
##
## 用法（顺序不能反：先配好字段，再 add_child，_ready 里按 w/h 排版）：
##   var it := KPOrbItem.new()
##   it.action = "level"; it.payload = "faction"; it.title = "阵 营"
##   it.tint = U.FACTION; it.subtitle = "中立"; it.w = 176.0; it.h = 76.0
##   add_child(it)                      # 这时才排版
##   it.picked.connect(...)
class_name KPOrbItem
extends Control

signal picked()

const U := preload("res://scripts/ui/kp_ui.gd")

var action := ""        # level / pick_faction / pick_difficulty / pick_seed / start
var payload := ""       # 关卡名、阵营 key、难度 key、种子数字
var title := ""
var subtitle := ""
var tint: Color = U.GOLD
var emphasized := false # 主按钮（开始对局）：金边、更大、光更亮
var w := 150.0
var h := 66.0
var selected := false

var _glow: TextureRect
var _pill: Panel
var _title_lab: Label
var _sub_lab: Label
var _hover := false
var _tw: Tween = null


func _ready() -> void:
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	size = Vector2(w, h)
	pivot_offset = size * 0.5
	mouse_filter = Control.MOUSE_FILTER_STOP
	clip_contents = false

	_glow = U.glow_rect(size * 2.2, tint, 0.50)
	_glow.position = -size * 0.55
	add_child(_glow)

	_pill = Panel.new()
	_pill.size = size
	_pill.position = Vector2.ZERO
	_pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_pill)

	var fts := int(round(clampf(h * 0.36, 15.0, 26.0)))
	if emphasized:
		fts = int(round(clampf(h * 0.30, 20.0, 30.0)))
	var col := tint if emphasized else U.TEXT
	_title_lab = U.label(title, fts, col, HORIZONTAL_ALIGNMENT_CENTER)
	_title_lab.clip_text = false
	add_child(_title_lab)

	if subtitle != "":
		var sts := 13 if h >= 70.0 else 12
		_sub_lab = U.label(subtitle, sts, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
		_sub_lab.clip_text = false
		add_child(_sub_lab)

	U.on_click(self, _on_click)
	mouse_entered.connect(_on_hover.bind(true))
	mouse_exited.connect(_on_hover.bind(false))
	_layout()
	_refresh()


func _layout() -> void:
	var pad := 10.0
	var fh := float(_title_lab.get_theme_font_size("font_size")) * 1.5
	if _sub_lab == null:
		_title_lab.position = Vector2(pad, (h - fh) * 0.5)
		_title_lab.size = Vector2(w - pad * 2.0, fh)
	else:
		var sh := float(_sub_lab.get_theme_font_size("font_size")) * 1.6
		var block := fh + sh
		var y0 := (h - block) * 0.5
		_title_lab.position = Vector2(pad, y0)
		_title_lab.size = Vector2(w - pad * 2.0, fh)
		_sub_lab.position = Vector2(pad, y0 + fh)
		_sub_lab.size = Vector2(w - pad * 2.0, sh)
	for l in [_title_lab, _sub_lab]:
		if l == null:
			continue
		(l as Label).horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		(l as Label).vertical_alignment = VERTICAL_ALIGNMENT_CENTER


func _refresh() -> void:
	if _pill == null:
		return
	var fill := Color(0.114, 0.145, 0.204, 0.97)   # 不透明玻璃，压住背后的光才好读
	var border := Color(tint, 0.80)
	var bw := 2
	var txt := U.TEXT
	if emphasized:
		fill = Color(0.145, 0.125, 0.078, 0.98)
		border = Color(tint, 0.95)
		bw = 3
		txt = tint
	if selected:
		fill = Color(U.PANEL_HI, 0.98)
		border = tint
		bw = 2
		txt = tint
	if _hover:
		fill = Color(U.PANEL_HI.r, U.PANEL_HI.g, U.PANEL_HI.b, 0.98)
		border = Color(tint, 1.0)
		bw = 2
	var rad := int(round(clampf(h * 0.44, 12.0, 40.0)))
	_pill.add_theme_stylebox_override("panel", U.box(fill, rad, border, bw))
	_title_lab.add_theme_color_override("font_color", txt)
	if _sub_lab != null:
		_sub_lab.add_theme_color_override("font_color", Color(tint, 0.85) if (selected or emphasized) else U.DIM)
	var a := 0.50
	if emphasized:
		a = 0.70
	if selected or _hover:
		a = 0.95
	if _hover:
		a = 1.0
	_glow.modulate = Color(tint.r, tint.g, tint.b, a)


func _on_click() -> void:
	if _tw != null and _tw.is_valid():
		return
	picked.emit()


func _on_hover(on: bool) -> void:
	if _hover == on:
		return
	_hover = on
	_refresh()
	var target := Vector2.ONE * (1.06 if on else 1.0)
	if _tw != null and _tw.is_valid():
		_tw.kill()
	_tw = create_tween()
	_tw.set_parallel(true)
	_tw.tween_property(_pill, "scale", target, 0.14).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_tw.tween_property(_glow, "scale", Vector2.ONE * (1.10 if on else 1.0), 0.16)
	_pill.pivot_offset = size * 0.5