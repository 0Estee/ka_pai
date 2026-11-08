## 回放页：列出本机存过的对局，点一条就重放。
## 回放日志在 user://replays/，每份只有「种子 + 人类那侧的动作」，几 KB。
class_name KPReplayPage
extends "res://scripts/ui/kp_page.gd"

const REPLAY := preload("res://scripts/ui/kp_replay.gd")

signal play_requested(rec: Dictionary)

var _list_root: VBoxContainer
var _empty_note: Label
var _rows: int = 0


func _init() -> void:
	title_text = "回 放"
	crumb_text = "载入中…"


func _fill() -> void:
	anim = SET.anim_scale()
	_set_crumb("同一份种子 + 同一串动作 ⇒ 同一局，逐字节可复现")

	var scroll := ScrollContainer.new()
	scroll.position = Vector2(30, 0)
	scroll.size = Vector2(660, 560)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	body.add_child(scroll)
	_reveal(scroll)

	_list_root = VBoxContainer.new()
	_list_root.add_theme_constant_override("separation", 12)
	_list_root.custom_minimum_size = Vector2(660, 0)
	scroll.add_child(_list_root)

	_empty_note = _note("", 580, U.DIM, 14, 24)
	_reveal(_empty_note)

	var clear := _button("清 空 全 部", Vector2(220, 50), Vector2(30, 620), _on_clear, U.BAD)
	_reveal(clear)
	var back_btn := _button("回 首 页", Vector2(220, 50), Vector2(270, 620), func(): close_requested.emit(), U.LINE)
	_reveal(back_btn)

	_rebuild()


func _rebuild() -> void:
	for c in _list_root.get_children():
		_list_root.remove_child(c)
		c.queue_free()
	var all: Array = REPLAY.list()
	_rows = all.size()
	if all.is_empty():
		_empty_note.text = "还没有回放 —— 打完一局就会自动存一份"
		_set_crumb("同一份种子 + 同一串动作 ⇒ 同一局，逐字节可复现")
		return
	_empty_note.text = "共 %d 份 · 新的在最上面 · 最多留 %d 份" % [all.size(), REPLAY.MAX_KEEP]
	_set_crumb("共 %d 份回放 · 点「播放」重看，点「删除」清掉" % all.size())
	for i in all.size():
		_list_root.add_child(_make_row(all[i], i))


func _make_row(entry: Dictionary, i: int) -> Control:
	var rec: Dictionary = entry.rec
	var row := Panel.new()
	row.custom_minimum_size = Vector2(648, 104)
	row.size = Vector2(648, 104)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_stylebox_override("panel",
		U.box(Color(0.106, 0.133, 0.188, 0.88), 14, Color(U.LINE, 0.55), 1))

	var head := U.label(REPLAY.headline(rec), 17, U.TEXT)
	head.position = Vector2(16, 12)
	head.size = Vector2(460, 24)
	head.clip_text = true
	row.add_child(head)

	var det := U.label(REPLAY.detail(rec), 12, U.DIM)
	det.position = Vector2(16, 40)
	det.size = Vector2(460, 20)
	det.clip_text = true
	row.add_child(det)

	var verdict := _verdict_text(rec)
	var vcol := U.GOOD if verdict == "胜" else U.BAD
	var badge := U.label(verdict, 22, vcol, HORIZONTAL_ALIGNMENT_CENTER)
	badge.position = Vector2(16, 64)
	badge.size = Vector2(60, 28)
	badge.clip_text = false
	row.add_child(badge)

	var play := _row_btn("播放", Vector2(88, 42), Vector2(452, 30), U.GOLD)
	play.pressed.connect(func(): play_requested.emit(rec))
	row.add_child(play)

	var del := _row_btn("删除", Vector2(88, 42), Vector2(548, 30), U.BAD)
	var path := str(entry.path)
	del.pressed.connect(func():
		REPLAY.remove(path)
		_rebuild())
	row.add_child(del)
	return row


func _row_btn(text: String, size_v: Vector2, pos: Vector2, tint: Color) -> Button:
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = size_v
	b.add_theme_font_size_override("font_size", 15)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_stylebox_override("normal", U.box(Color(0.114, 0.145, 0.204, 0.95), 10, Color(tint, 0.6), 1))
	b.add_theme_stylebox_override("hover", U.box(Color(0.145, 0.176, 0.243, 1.0), 10, tint, 2))
	b.add_theme_stylebox_override("pressed", U.box(U.PANEL, 10, tint, 2))
	return b


func _verdict_text(rec: Dictionary) -> String:
	var res: Dictionary = rec.get("result", {})
	if res.get("winner", null) == null:
		return "未完"
	return "胜" if int(res.winner) == int(rec.get("humanSide", 0)) else "负"


func _on_clear() -> void:
	for e in REPLAY.list():
		REPLAY.remove(str(e.path))
	if _orb != null and is_instance_valid(_orb):
		_orb.pulse(1.2)
		_orb.ripple(1.0)
	_rebuild()


## 给测试/调用方用的：列表行数
func row_count() -> int:
	return _rows
