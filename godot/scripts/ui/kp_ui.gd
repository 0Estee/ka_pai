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
		if ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_LEFT:
			if ev.pressed:
				ctrl.accept_event()
				press_fx(ctrl, true)
				cb.call()
			else:
				press_fx(ctrl, false)
	)


## 按下缩一点、松开弹回来 —— 所有可点面板共用的按压反馈。
## 没有子节点的空 Control（铺满屏幕的「点空白返回」那种）不缩，缩了也看不出来。
static func press_fx(ctrl: Control, down: bool) -> void:
	if ctrl == null or not is_instance_valid(ctrl) or not ctrl.is_inside_tree():
		return
	if ctrl.get_child_count() == 0 and not (ctrl is Panel):
		return
	if down:
		ctrl.pivot_offset = ctrl.size * 0.5
	var tw := ctrl.create_tween()
	tw.set_ease(Tween.EASE_OUT)
	tw.set_trans(Tween.TRANS_SINE if down else Tween.TRANS_BACK)
	tw.tween_property(ctrl, "scale", Vector2.ONE * (0.96 if down else 1.0), 0.07 if down else 0.12)


## 一排小标签（词条、标记）拼成的一行文字
static func chips_text(kws: Array, marks: Array = []) -> String:
	var parts: Array = []
	for k in kws:
		parts.append(DATA.keyword_name(k))
	for m in marks:
		parts.append(str(m))
	return " · ".join(parts)


# ── 柔光：径向渐变贴图（光球、选项背后的光都用它）────────────────────────────

static var _radial_cache: Dictionary = {}


## stops = [[0.0, Color(...)], [0.4, Color(...)], [1.0, Color(...)]]，必须首 0 尾 1。
## 同一组参数只建一次贴图（14 个阵营选项共用一张）。
static func radial(stops: Array, px: int = 256) -> GradientTexture2D:
	var key := str(px)
	for s in stops:
		key += "|%s:%s" % [str(s[0]), (s[1] as Color).to_html()]
	if _radial_cache.has(key):
		return _radial_cache[key]
	var g := Gradient.new()
	var n := stops.size()
	g.set_offset(0, float(stops[0][0]))
	g.set_color(0, stops[0][1])
	g.set_offset(1, float(stops[n - 1][0]))
	g.set_color(1, stops[n - 1][1])
	for i in range(1, n - 1):
		g.add_point(float(stops[i][0]), stops[i][1])
	var t := GradientTexture2D.new()
	t.gradient = g
	t.fill = GradientTexture2D.FILL_RADIAL
	t.fill_from = Vector2(0.5, 0.5)
	t.fill_to = Vector2(0.5, 0.0)
	t.width = px
	t.height = px
	_radial_cache[key] = t
	return t


## 一团白色柔光（想要颜色就调 modulate）
static func glow_tex() -> GradientTexture2D:
	return radial([[0.0, Color(1, 1, 1, 0.90)], [0.30, Color(1, 1, 1, 0.42)],
		[0.62, Color(1, 1, 1, 0.10)], [1.0, Color(1, 1, 1, 0.0)]])


## 加色混合：光叠光才亮得起来
static func additive(ctrl: CanvasItem) -> CanvasItem:
	var m := CanvasItemMaterial.new()
	m.blend_mode = CanvasItemMaterial.BLEND_MODE_ADD
	ctrl.material = m
	return ctrl


## 一张占满给定尺寸的柔光贴图（居中，可超出父控件，标记为装饰件以便自检跳过）
static func glow_rect(size_v: Vector2, col: Color, alpha: float = 1.0) -> TextureRect:
	var t := TextureRect.new()
	t.texture = glow_tex()
	t.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	t.stretch_mode = TextureRect.STRETCH_SCALE
	t.size = size_v
	t.position = Vector2.ZERO
	t.pivot_offset = size_v * 0.5
	t.mouse_filter = Control.MOUSE_FILTER_IGNORE
	t.modulate = Color(col.r, col.g, col.b, alpha)
	t.set_meta("decor", true)
	additive(t)
	return t
