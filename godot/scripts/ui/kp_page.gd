## 二级页面的公共外壳（设置 / 回放 / 联机都继承它）。
##
## 语言跟首页一致：星云底 + 暗角 + 一颗小光球坐在标题下方，内容区块从光球里长出来。
## 子类只要实现 _fill()，把控件加进 body 即可；入场动画用 _reveal()。
class_name KPPage
extends Control

signal close_requested

const U := preload("res://scripts/ui/kp_ui.gd")
const ORB := preload("res://scripts/ui/kp_orb.gd")
const SET := preload("res://scripts/ui/kp_settings.gd")

const DESIGN := Vector2(720, 1280)
const ORB_CENTER := Vector2(360, 214)
const ORB_RAD := 44.0
const BODY_TOP := 296.0
const BODY_BOTTOM := 1120.0

var anim := 1.0
var title_text := "页"
var crumb_text := ""

var body: Control
var _frame: Control
var _orb = null
var _crumbs: Label
var _reveal_i := 0


func _ready() -> void:
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	var vp := get_viewport_rect().size
	if vp.x > 0.0 and vp.y > 0.0:
		size = vp
	resized.connect(_fit)
	if not get_viewport().size_changed.is_connected(_fit):
		get_viewport().size_changed.connect(_fit)
	_build_shell()
	_fit()
	_fill()


func _fit() -> void:
	var avail := size
	if avail.x <= 1.0 or avail.y <= 1.0:
		avail = get_viewport_rect().size
		size = avail
	var s := minf(avail.x / DESIGN.x, avail.y / DESIGN.y)
	_frame.scale = Vector2(s, s)
	_frame.position = (avail - DESIGN * s) * 0.5


func _build_shell() -> void:
	var bg := ColorRect.new()
	bg.color = U.BG
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	_frame = Control.new()
	_frame.size = DESIGN
	_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_frame)

	var neb := TextureRect.new()
	neb.texture = U.radial([[0.0, Color(0.11, 0.16, 0.32, 0.30)], [0.42, Color(0.07, 0.10, 0.20, 0.16)],
		[0.72, Color(0.05, 0.06, 0.11, 0.05)], [1.0, Color(0, 0, 0, 0)]], 128)
	neb.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	neb.stretch_mode = TextureRect.STRETCH_SCALE
	neb.size = DESIGN
	neb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	neb.set_meta("decor", true)
	_frame.add_child(neb)

	var vig := TextureRect.new()
	vig.texture = U.radial([[0.0, Color(0, 0, 0, 0)], [0.52, Color(0, 0, 0, 0)],
		[0.80, Color(0, 0, 0, 0.28)], [1.0, Color(0, 0, 0, 0.60)]], 128)
	vig.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	vig.stretch_mode = TextureRect.STRETCH_SCALE
	vig.size = DESIGN * 1.02
	vig.position = -DESIGN * 0.01
	vig.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vig.set_meta("decor", true)
	_frame.add_child(vig)

	var title := U.label(title_text, 40, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	title.position = Vector2(0, 40)
	title.size = Vector2(720, 56)
	title.clip_text = false
	_frame.add_child(title)

	_crumbs = U.label(crumb_text, 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_crumbs.position = Vector2(0, 100)
	_crumbs.size = Vector2(720, 26)
	_crumbs.clip_text = false
	_frame.add_child(_crumbs)

	# 小光球：内容的「嘴」，也是页面的呼吸点
	_orb = ORB.new()
	_orb.tint = U.GOLD
	_orb.rad = ORB_RAD
	_orb.anim = anim
	_orb.fx_level = SET.fx_level()
	_frame.add_child(_orb)
	_orb.position = ORB_CENTER - Vector2(ORB_RAD, ORB_RAD)

	# 返回
	var back := Control.new()
	back.position = Vector2(24, 30)
	back.size = Vector2(124, 48)
	back.mouse_filter = Control.MOUSE_FILTER_STOP
	U.on_click(back, func(): close_requested.emit())
	_frame.add_child(back)
	var bb := Panel.new()
	bb.size = back.size
	bb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	bb.add_theme_stylebox_override("panel", U.box(Color(0.086, 0.106, 0.149, 0.9), 24, Color(U.LINE, 0.9), 1))
	back.add_child(bb)
	var bl := U.label("‹  返回", 16, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	bl.position = Vector2(0, 6)
	bl.size = Vector2(124, 36)
	bl.clip_text = false
	back.add_child(bl)

	body = Control.new()
	body.position = Vector2(0, BODY_TOP)
	body.size = Vector2(720, BODY_BOTTOM - BODY_TOP)
	body.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(body)

	_reveal_i = 0


## 子类在这里往 body 里塞控件
func _fill() -> void:
	pass


## 内容入场：从光球里飘出来
func _reveal(ctrl: Control, delay_i: int = -1) -> void:
	var i := _reveal_i if delay_i < 0 else delay_i
	_reveal_i += 1
	if anim <= 0.001:
		return
	var base := ctrl.position
	ctrl.position = base + Vector2(0, 26)
	ctrl.modulate.a = 0.0
	var tw: Tween = ctrl.create_tween()
	tw.tween_interval(maxf(0.001, (0.06 + 0.05 * float(i)) * anim))
	tw.tween_property(ctrl, "position", base, 0.34 * anim) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.parallel().tween_property(ctrl, "modulate:a", 1.0, 0.24 * anim)


# ── 复用控件 ─────────────────────────────────────────────────────────────────

## 一行设置：底板 + 标题 + 说明，返回底板（子类往上加药丸）
func _row(y: float, h: float, title: String, note: String, tint: Color = U.MANA) -> Panel:
	var row := Panel.new()
	row.position = Vector2(30, y)
	row.size = Vector2(660, h)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_stylebox_override("panel", U.box(Color(0.106, 0.133, 0.188, 0.86), 16, Color(U.LINE, 0.55), 1))
	body.add_child(row)
	var t := U.label(title, 19, U.TEXT)
	t.position = Vector2(18, 10)
	t.size = Vector2(300, 26)
	t.clip_text = false
	row.add_child(t)
	var n := U.label(note, 12, U.DIM)
	n.position = Vector2(18, 38)
	n.size = Vector2(360, 20)
	n.clip_text = false
	row.add_child(n)
	var dot := ColorRect.new()
	dot.color = Color(tint, 0.85)
	dot.position = Vector2(0, 14)
	dot.size = Vector2(3, h - 28)
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_child(dot)
	return row


## 一排药丸选项，返回药丸数组；点第 i 个调 cb.call(i)
func _pills(parent: Control, y: float, labels: Array, cb: Callable,
		w: float = 96.0, h: float = 34.0, gap: float = 8.0, x0: float = 18.0) -> Array:
	var out: Array = []
	for i in labels.size():
		var p := Control.new()
		p.position = Vector2(x0 + float(i) * (w + gap), y)
		p.size = Vector2(w, h)
		p.mouse_filter = Control.MOUSE_FILTER_STOP
		p.set_meta("idx", i)
		var label := str(labels[i])
		U.on_click(p, func(): cb.call(int(p.get_meta("idx"))))
		parent.add_child(p)
		var bx := Panel.new()
		bx.size = p.size
		bx.mouse_filter = Control.MOUSE_FILTER_IGNORE
		bx.set_meta("body", true)
		bx.add_theme_stylebox_override("panel", U.box(U.PANEL, int(h * 0.5), Color(U.LINE, 0.9), 1))
		p.add_child(bx)
		var lab := U.label(label, 14, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
		lab.position = Vector2(0, (h - 22.0) * 0.5)
		lab.size = Vector2(w, 22)
		lab.clip_text = false
		lab.set_meta("lab", true)
		p.add_child(lab)
		out.append(p)
	return out


## 把一排药丸里第 sel 个点亮
func _paint_pills(pills: Array, sel: int, tint: Color = U.GOLD) -> void:
	for i in pills.size():
		var p = pills[i]
		if p == null or not is_instance_valid(p):
			continue
		var on := i == sel
		var bx = p.get_child(0)
		if bx != null:
			bx.add_theme_stylebox_override("panel", U.box(
				Color(tint, 0.22) if on else U.PANEL, int(p.size.y * 0.5),
				tint if on else Color(U.LINE, 0.9), 2 if on else 1))
		var lab = p.get_child(1)
		if lab != null:
			lab.add_theme_color_override("font_color", tint if on else U.DIM)


## 底部那颗宽按钮（重建列表之类的动作）
func _button(text: String, rect: Vector2, pos: Vector2, cb: Callable, tint: Color = U.GOLD) -> Button:
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = rect
	b.add_theme_font_size_override("font_size", 18)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_stylebox_override("normal", U.box(Color(0.114, 0.145, 0.204, 0.95), int(rect.y * 0.5), Color(tint, 0.7), 1))
	b.add_theme_stylebox_override("hover", U.box(Color(0.145, 0.176, 0.243, 1.0), int(rect.y * 0.5), tint, 2))
	b.add_theme_stylebox_override("pressed", U.box(U.PANEL, int(rect.y * 0.5), tint, 2))
	b.pressed.connect(cb)
	body.add_child(b)
	return b


func _note(text: String, y: float, col: Color = U.DIM, fs: int = 14, h: float = 22.0) -> Label:
	var l := U.label(text, fs, col, HORIZONTAL_ALIGNMENT_CENTER)
	l.position = Vector2(30, y)
	l.size = Vector2(660, h)
	l.clip_text = false
	body.add_child(l)
	return l


func _set_crumb(text: String) -> void:
	crumb_text = text
	if _crumbs != null and is_instance_valid(_crumbs):
		_crumbs.text = text
