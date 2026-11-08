## 手机端界面的公共样式与小组件（纯函数，无状态）
class_name KPUi
extends RefCounted

const KPC := preload("res://scripts/engine/kp_constants.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

# ── 调色板（深色底 + 金色强调，和 Web 版一致）────────────────────────────────
const BG := Color("0e1117")
const BG_SOFT := Color("151a23")
const PANEL := Color("1c2330")
const PANEL_HI := Color("26303f")
const LINE := Color("39445c")
const TEXT := Color("e9eef8")
const DIM := Color("8f9cb4")
const GOLD := Color("f0c14b")
const GOOD := Color("5fd08a")
const BAD := Color("ef6b6b")
const MANA := Color("6aa8f2")
const FACTION := Color("b98cf0")


static func box(fill: Color, radius: int = 12, border: Color = Color(0, 0, 0, 0), bw: int = 1) -> StyleBoxFlat:
	var sb := StyleBoxFlat.new()
	sb.bg_color = fill
	sb.set_corner_radius_all(radius)
	if border.a > 0.001:
		sb.border_color = border
		sb.set_border_width_all(bw)
	return sb


static func pad(sb: StyleBoxFlat, l: int, t: int, r: int, b: int) -> StyleBoxFlat:
	sb.content_margin_left = l
	sb.content_margin_top = t
	sb.content_margin_right = r
	sb.content_margin_bottom = b
	return sb


static func label(text: String, size: int, color: Color = TEXT, align: int = HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := Label.new()
	l.text = text
	l.add_theme_font_size_override("font_size", size)
	l.add_theme_color_override("font_color", color)
	l.horizontal_alignment = align
	return l


static func num(v) -> String:
	var f := 0.0
	if v is int or v is float:
		f = float(v)
	elif v is String and str(v).is_valid_float():
		f = float(v)
	f = KPC.fix_num(f)
	if is_equal_approx(f, roundf(f)):
		return str(int(roundf(f)))
	return "%.1f" % f


## 一条血条（ProgressBar 改皮，宽度由外层容器决定）
static func hpbar(ratio: float, color: Color, height: int = 12) -> ProgressBar:
	var pb := ProgressBar.new()
	pb.show_percentage = false
	pb.min_value = 0.0
	pb.max_value = 1.0
	pb.value = clampf(ratio, 0.0, 1.0)
	pb.custom_minimum_size = Vector2(0, height)
	pb.add_theme_stylebox_override("background", box(Color("2b3346"), height / 2))
	pb.add_theme_stylebox_override("fill", box(color, height / 2))
	return pb


## 让任意 Control 响应「点一下」（触屏会模拟鼠标事件，所以只听鼠标就够）
static func on_click(ctrl: Control, cb: Callable) -> void:
	ctrl.mouse_filter = Control.MOUSE_FILTER_STOP
	ctrl.gui_input.connect(func(ev: InputEvent) -> void:
		if ev is InputEventMouseButton and ev.pressed and ev.button_index == MOUSE_BUTTON_LEFT:
			ctrl.accept_event()
			cb.call()
	)


## 一排小标签（词条、标记）拼成的一行文字
static func chips_text(kws: Array, marks: Array = []) -> String:
	var parts: Array = []
	for k in kws:
		parts.append(DATA.keyword_name(k))
	for m in marks:
		parts.append(str(m))
	return " · ".join(parts)
