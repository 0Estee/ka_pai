## 联机页：先把「能用什么、还缺什么」摆清楚，顺便把本机地址亮出来。
##
## 局域网同步还没实装。这个页面不装样子：它显示真实的本机地址与端口、
## 真实的对战模式状态，并说明为什么这件事现在只差一层同步壳（引擎确定性）。
class_name KPOnlinePage
extends "res://scripts/ui/kp_page.gd"


const PORT := 7842

var _addr_label: Label
var _addr_note: Label
var _copy_btn: Button


func _init() -> void:
	title_text = "联 机"
	crumb_text = "局域网对战 · 本机信息"


func _fill() -> void:
	anim = SET.anim_scale()

	# 本机地址卡
	var card := _row(0, 150, "本机地址", "同一 Wi-Fi 下，对手用这个地址连你", U.GOOD)
	_reveal(card)
	_addr_label = U.label(_local_ip_text(), 26, U.GOLD)
	_addr_label.position = Vector2(18, 64)
	_addr_label.size = Vector2(620, 34)
	_addr_label.clip_text = false
	card.add_child(_addr_label)
	_addr_note = U.label("端口 %d（预留）" % PORT, 12, U.DIM)
	_addr_note.position = Vector2(18, 104)
	_addr_note.size = Vector2(620, 20)
	_addr_note.clip_text = false
	card.add_child(_addr_note)

	# 对战模式
	var modes := _row(166, 178, "对战模式", "现在只有第一种是真能打的", U.FACTION)
	_reveal(modes)
	_mode_line(modes, 58, "单人 vs AI", "可用", U.GOOD)
	_mode_line(modes, 100, "同机双人（热座）", "排期中", U.DIM)
	_mode_line(modes, 142, "局域网对战", "未实装", U.BAD)

	# 差什么
	var gap := _row(360, 190, "还差什么", "同步层要做的三件事", U.MANA)
	_reveal(gap)
	_plain(gap, "① 动作收发：双方只交换「出哪张牌、放哪一格」与「结束阶段」", 62)
	_plain(gap, "② 裁决校验：收到动作先用 engine 的 get_legal_plays 复核再落地", 94)
	_plain(gap, "③ 断线重连：把从开局起的动作序列重放一遍就能回到当前局面", 126)
	_plain(gap, "引擎是确定性的（同种子同动作 ⇒ 同结果），所以不需要同步整张棋盘。", 158, U.DIM)

	var copy := _button("复 制 地 址", Vector2(220, 50), Vector2(30, 574), _on_copy, U.GOOD)
	_reveal(copy)
	_copy_btn = copy
	var refresh := _button("刷 新", Vector2(180, 50), Vector2(270, 574), _on_refresh, U.LINE)
	_reveal(refresh)
	var back := _button("回 首 页", Vector2(180, 50), Vector2(470, 574), func(): close_requested.emit(), U.LINE)
	_reveal(back)

	_note("热座与局域网都要在会话层加「第二个人」的座位，这部分排在下一次", 650, U.DIM, 12, 22)


func _mode_line(parent: Control, y: float, name: String, status: String, col: Color) -> void:
	var n := U.label(name, 16, U.TEXT)
	n.position = Vector2(18, y)
	n.size = Vector2(360, 26)
	n.clip_text = false
	parent.add_child(n)
	var pill := Panel.new()
	pill.position = Vector2(430, y + 1)
	pill.size = Vector2(96, 26)
	pill.mouse_filter = Control.MOUSE_FILTER_IGNORE
	pill.add_theme_stylebox_override("panel", U.box(Color(col, 0.18), 13, col, 1))
	parent.add_child(pill)
	var s := U.label(status, 13, col, HORIZONTAL_ALIGNMENT_CENTER)
	s.position = Vector2(0, 3)
	s.size = Vector2(96, 20)
	s.clip_text = false
	pill.add_child(s)


func _plain(parent: Control, text: String, y: float, col: Color = U.TEXT) -> void:
	var l := U.label(text, 13, col)
	l.position = Vector2(18, y)
	l.size = Vector2(620, 24)
	l.clip_text = true
	parent.add_child(l)


func _local_addresses() -> Array:
	var out: Array = []
	for a in IP.get_local_addresses():
		var s := str(a)
		if s.contains(":") or s.begins_with("127.") or s == "0.0.0.0":
			continue
		out.append(s)
	return out


func _local_ip_text() -> String:
	var addrs := _local_addresses()
	if addrs.is_empty():
		return "没找到局域网地址（没连 Wi-Fi？）"
	return str(addrs[0]) + ("  等 %d 个" % addrs.size() if addrs.size() > 1 else "")


func _on_copy() -> void:
	var addrs := _local_addresses()
	if addrs.is_empty():
		_toast_note("没有可复制的地址")
		return
	DisplayServer.clipboard_set(str(addrs[0]) + ":" + str(PORT))
	_toast_note("已复制 %s:%d" % [str(addrs[0]), PORT])
	if _orb != null and is_instance_valid(_orb):
		_orb.pulse(1.0)
		_orb.ripple(0.8)


func _on_refresh() -> void:
	if _addr_label != null and is_instance_valid(_addr_label):
		_addr_label.text = _local_ip_text()
	if _paste_note != null and is_instance_valid(_paste_note):
		_paste_note.text = ""
	if _orb != null and is_instance_valid(_orb):
		_orb.pulse(0.9)
		_orb.ripple(0.7)


var _paste_note: Label


func _toast_note(text: String) -> void:
	if _paste_note == null or not is_instance_valid(_paste_note):
		_paste_note = _note("", 620, U.GOOD, 13, 22)
		_reveal(_paste_note)
	_paste_note.text = text
	_paste_note.add_theme_color_override("font_color", U.GOOD)
	if anim > 0.001:
		var tw: Tween = _paste_note.create_tween()
		tw.tween_interval(1.2 * anim)
		tw.tween_callback(func():
			if is_instance_valid(_paste_note):
				_paste_note.add_theme_color_override("font_color", Color(U.GOOD, 0.5)))
