## 联机大厅（作者 m01990 第 18 条）：开房 / 加入 / 等对手 / 开局。
##
## 传输与锁步在 scripts/ui/kp_net.gd 里；这一页只做三件事：
## 把房间号给出去、把对手状态显示出来、把开局参数凑齐交给 KPNet.begin()。
## 协议见 docs/联机协议.md（房间 /api/send、/api/poll，锁步只同步操作）。
class_name KPOnlinePage
extends "res://scripts/ui/kp_page.gd"

## 开局了：外壳收到后切到对局屏（session 已经由 KPNet 建好）
signal started

const KPData := preload("res://scripts/ui/kp_data.gd")
const KPForge := preload("res://scripts/ui/kp_forge.gd")
const KPProfile := preload("res://scripts/ui/kp_profile.gd")

## 房号字符集：去掉 0/O、1/I 这种念不清的
const CODE_CHARS := "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

## KPNet，由外壳（main.gd）创建并持有；页面只管用，不负责生命周期
var net = null

var _view := "form"          # form | lobby
var _nick := "玩家"
var _code := ""
var _srv := ""
var _peer := ""
var _peer_ready := false
var _faction := ""
var _status_text := ""

var _nick_edit: LineEdit
var _srv_edit: LineEdit
var _code_edit: LineEdit
var _status_label: Label
var _peer_label: Label


func _init() -> void:
	title_text = "联 机"
	crumb_text = "同一个房间，两台手机，各打各的"


func _ready() -> void:
	super()
	_hook_net()


func _hook_net() -> void:
	if net == null:
		return
	if not net.sig_status.is_connected(_on_status):
		net.sig_status.connect(_on_status)
	if not net.sig_peer.is_connected(_on_peer):
		net.sig_peer.connect(_on_peer)
	if not net.sig_started.is_connected(_on_started):
		net.sig_started.connect(_on_started)
	if not net.sig_left.is_connected(_on_left):
		net.sig_left.connect(_on_left)
	if not net.sig_conflict.is_connected(_on_conflict):
		net.sig_conflict.connect(_on_conflict)


func _fill() -> void:
	anim = SET.anim_scale()
	if _faction == "":
		_faction = _random_faction()
	if _srv == "":
		_srv = SET.cloud_base()
	if net != null:
		_status_text = str(net.status)
	if _view == "lobby":
		_fill_lobby()
	else:
		_fill_form()


func _rebuild() -> void:
	for c in body.get_children():
		body.remove_child(c)
		c.queue_free()
	_reveal_i = 0
	_fill()


# ── 视图一：填名字、开房或加入 ───────────────────────────────────────────────

func _fill_form() -> void:
	crumb_text = "填个名字，开房或加入"

	var c1 := _row(0, 132, "昵称", "对手在房间里看到的名字", U.GOLD)
	_reveal(c1)
	_nick_edit = _edit(c1, 58, _nick)

	var c2 := _row(144, 132, "服务器", "房间服务地址（默认就是线上那台）", U.MANA)
	_reveal(c2)
	_srv_edit = _edit(c2, 58, _srv)

	var c3 := _row(288, 132, "房间号", "加入别人的房间时填 4–12 位字母数字", U.FACTION)
	_reveal(c3)
	_code_edit = _edit(c3, 58, "")
	_code_edit.placeholder_text = "例如 7KQ2M9"
	_code_edit.max_length = 12

	var create_b := _button("创 建 房 间", Vector2(318, 56), Vector2(30, 436), func(): _do_create(), U.GOLD)
	_reveal(create_b)
	var join_b := _button("加 入 房 间", Vector2(318, 56), Vector2(372, 436), func(): _do_join(), U.FACTION)
	_reveal(join_b)

	_status_label = U.label(_status_text, 13, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_status_label.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status_label.clip_text = false
	body.add_child(_status_label)
	_status_label.custom_minimum_size = Vector2(660, 44)
	_status_label.position = Vector2(30, 508)
	_status_label.size = Vector2(660, 44)
	_reveal(_status_label)

	var note := U.label("只同步操作不同步棋盘：同种子同操作 ⇒ 同一局。两端每 8 步对一次状态指纹，对不上立刻停下。",
		12, U.DIM)
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	note.clip_text = false
	body.add_child(note)
	# 自动换行的 Label 在有宽度之前算最小高度，会把盒子顶到几百像素高
	note.custom_minimum_size = Vector2(660, 60)
	note.position = Vector2(30, 566)
	note.size = Vector2(660, 60)
	_reveal(note)


func _edit(parent: Control, y: float, value: String) -> LineEdit:
	var e := LineEdit.new()
	e.position = Vector2(18, y)
	e.size = Vector2(624, 44)
	e.text = value
	e.add_theme_font_size_override("font_size", 17)
	e.add_theme_color_override("font_color", U.TEXT)
	e.add_theme_color_override("font_placeholder_color", Color(U.DIM, 0.7))
	e.add_theme_stylebox_override("normal", U.box(Color(0.06, 0.08, 0.12, 0.9), 10, Color(U.LINE, 0.7), 1))
	e.add_theme_stylebox_override("focus", U.box(Color(0.075, 0.10, 0.15, 0.95), 10, U.GOLD, 1))
	parent.add_child(e)
	return e


# ── 视图二：房间里 ──────────────────────────────────────────────────────────

func _fill_lobby() -> void:
	crumb_text = "房间 %s · %s" % [_code, "房主" if _is_host() else "客人"]

	var cc := _row(0, 150, "房号", "念给对手听，或复制给他", U.GOLD)
	_reveal(cc)
	var code_lab := U.label(_code, 40, U.GOLD)
	code_lab.position = Vector2(18, 56)
	code_lab.size = Vector2(430, 54)
	code_lab.clip_text = false
	cc.add_child(code_lab)
	var copy_b := _small_button(cc, "复 制", Vector2(140, 44), Vector2(490, 66), func(): _do_copy(), U.GOLD)

	var pc := _row(162, 118, "对手", "进来了才能开局", U.GOOD)
	_reveal(pc)
	_peer_label = U.label(_peer_text(), 17, U.TEXT)
	_peer_label.position = Vector2(18, 58)
	_peer_label.size = Vector2(624, 30)
	_peer_label.clip_text = false
	pc.add_child(_peer_label)

	var fc := _row(292, 214, "你的阵营", "只影响你自己这半场的牌", U.FACTION)
	_reveal(fc)
	var labels: Array = []
	var keys: Array = []
	for f in KPData.factions():
		labels.append(str(f.get("name", f.get("key", ""))))
		keys.append(str(f.get("key", "")))
	var sel := maxi(0, keys.find(_faction))
	var pills: Array = []
	for row_i in 2:
		var from := row_i * 7
		var take := mini(7, labels.size() - from)
		if take <= 0:
			continue
		var chunk: Array = labels.slice(from, from + take)
		var got := _pills(fc, 62.0 + float(row_i) * 46.0, chunk, func(i: int): _pick_faction(str(keys[from + i])),
			82.0, 36.0, 8.0, 18.0)
		for p in got:
			p.set_meta("faction_idx", from + pills.size())
			pills.append(p)
	_paint_pills(pills, sel, U.FACTION)

	if _is_host():
		var can_start := _peer_ready
		var b := _button("开 始 对 局", Vector2(660, 64), Vector2(30, 526),
			func(): _do_start(), U.GOLD if can_start else U.LINE)
		b.disabled = not can_start
		_reveal(b)
		if not can_start:
			var w := _note("等对手进来……连上之后这个按钮就会亮", 600, U.DIM, 12, 22)
			_reveal(w)
	else:
		var w2 := _note("等房主开局……开局后自动进对局", 536, U.GOLD, 14, 24)
		_reveal(w2)

	var leave := _button("离 开 房 间", Vector2(660, 50), Vector2(30, 620), func(): _do_leave(), U.BAD)
	_reveal(leave)

	_status_label = U.label(_status_text, 12, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_status_label.position = Vector2(30, 684)
	_status_label.size = Vector2(660, 24)
	_status_label.clip_text = false
	body.add_child(_status_label)
	_reveal(_status_label)


func _small_button(parent: Control, text: String, rect2: Vector2, pos: Vector2, cb: Callable, tint: Color) -> Button:
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = rect2
	b.add_theme_font_size_override("font_size", 15)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_stylebox_override("normal", U.box(Color(0.114, 0.145, 0.204, 0.95), int(rect2.y * 0.5), Color(tint, 0.7), 1))
	b.add_theme_stylebox_override("hover", U.box(Color(0.145, 0.176, 0.243, 1.0), int(rect2.y * 0.5), tint, 2))
	b.add_theme_stylebox_override("pressed", U.box(U.PANEL, int(rect2.y * 0.5), tint, 2))
	b.pressed.connect(cb)
	parent.add_child(b)
	return b


func _peer_text() -> String:
	if _peer != "":
		return _peer
	if _peer_ready:
		return "对手已进房"
	return "还没有人来"


func _is_host() -> bool:
	if net == null:
		return true
	return bool(net.is_host)


# ── 动作 ────────────────────────────────────────────────────────────────────

func _do_create() -> void:
	if net == null:
		_say("联机模块没有挂载（外壳没建 KPNet）", U.BAD)
		return
	_nick = _nick_text()
	_code = _make_code()
	_enter_lobby("host")


func _do_join() -> void:
	if net == null:
		_say("联机模块没有挂载（外壳没建 KPNet）", U.BAD)
		return
	var code := ""
	if _code_edit != null and is_instance_valid(_code_edit):
		code = _code_edit.text.strip_edges().to_upper()
	if code.length() < 4:
		_say("房号至少 4 位，找房主要一下", U.BAD)
		return
	_nick = _nick_text()
	_code = code
	_enter_lobby("guest")


func _enter_lobby(who: String) -> void:
	if _srv_edit != null and is_instance_valid(_srv_edit):
		_srv = _srv_edit.text.strip_edges()
	net.local_faction = _faction
	net.local_enhance = KPForge.build_side_enhance(KPData.lib(), KPProfile.load_profile())
	net.open(who, _code, _nick, _srv)
	net.hello()
	_view = "lobby"
	_peer = ""
	_peer_ready = false
	_status_text = "连接中…"
	_rebuild()


func _do_start() -> void:
	if net == null or not _is_host():
		return
	var seed_v := int(Time.get_ticks_usec() % 1000000000)
	var lib: Dictionary = KPData.lib()
	var mine: Dictionary = net.local_enhance if net.local_enhance is Dictionary else {}
	var theirs: Dictionary = {}
	if net.peer_enhance is Dictionary:
		theirs = net.peer_enhance
	var cfg := {
		"r": 1,
		"seed": seed_v,
		"firstPlayer": 0,
		"deck": KPData.build_deck(40, seed_v),
		"factions": [net.local_faction, net.peer_faction],
		"hostFaction": net.local_faction,
		"guestFaction": net.peer_faction,
		"enhance": [mine, theirs],
		"mode": "normal",
	}
	_say("正在开局……", U.GOLD)
	net.begin(cfg)


func _do_leave() -> void:
	if net != null:
		net.close("leave")
	net = null
	_view = "form"
	_code = ""
	_peer = ""
	_peer_ready = false
	_status_text = "已离开房间"
	_rebuild()


func _do_copy() -> void:
	if _code == "":
		return
	DisplayServer.clipboard_set(_code)
	_say("房号 %s 已复制" % _code, U.GOOD)


func _pick_faction(key: String) -> void:
	if key == _faction:
		return
	_faction = key
	if net != null:
		net.set_faction(key)
	_rebuild()


func _nick_text() -> String:
	if _nick_edit != null and is_instance_valid(_nick_edit):
		var s := _nick_edit.text.strip_edges()
		if s != "":
			return s
	return "玩家"


func _make_code() -> String:
	var out := ""
	for i in 6:
		out += CODE_CHARS[randi() % CODE_CHARS.length()]
	return out


func _random_faction() -> String:
	var keys: Array = []
	for f in KPData.factions():
		keys.append(str(f.get("key", "")))
	if keys.is_empty():
		return ""
	return str(keys[randi() % keys.size()])


func _say(text: String, col: Color = U.DIM) -> void:
	_status_text = text
	if _status_label != null and is_instance_valid(_status_label):
		_status_label.text = text
		_status_label.add_theme_color_override("font_color", col)


# ── 网络回调 ────────────────────────────────────────────────────────────────

func _on_status(text: String) -> void:
	_say(text, U.DIM)


func _on_peer(text: String) -> void:
	_peer = text
	_peer_ready = true
	if _view == "lobby":
		_rebuild()
	else:
		_say("对手进房了：%s" % text, U.GOOD)


func _on_started() -> void:
	started.emit()


func _on_left() -> void:
	_peer = ""
	_peer_ready = false
	if _view == "lobby":
		_rebuild()
	_say("对手离开了房间", U.BAD)


func _on_conflict(text: String) -> void:
	_say("与对手进度不一致：%s" % text, U.BAD)
