## 光球：首页的中心。多层径向渐变（加色混合）叠出柔光，外加断续光环与浮游光点。
##
## 它只负责「好看」和三个动作：
##   pulse(power)      —— 吸一口光（有东西钻进来了）
##   ripple(power)     —— 向外散一圈涟漪
##   expand(sec, cb)   —— 整团光胀开吞掉屏幕（进对局用）
## 本体还叠了一层 shader（assets/orb.gdshader）：能量流 + 边缘环光。
## fx_level: 0 = 关（纯渐变，最省电）、1 = 省电（单层噪声）、2 = 全质量。
## 位置、大小由调用方摆：orb.position = center - orb.size * 0.5
class_name KPOrb
extends Control

const U := preload("res://scripts/ui/kp_ui.gd")

## 断续光环 + 浮游光点（单独一层，画在光晕上面）
class RingLayer extends Control:
	var tint := Color.WHITE
	var rad := 96.0
	var spin := 0.0
	var clock := 0.0
	var power := 1.0

	func _draw() -> void:
		var c := size * 0.5
		var k := clampf(rad / 96.0, 0.4, 3.0)
		var pw := clampf(power, 0.0, 3.0)
		for i in 3:
			var r := rad * (1.24 + 0.30 * float(i))
			var w := (2.4 - 0.55 * float(i)) * k
			var a := (0.34 - 0.09 * float(i)) * pw
			var span := TAU * (0.40 - 0.07 * float(i))
			var s0 := spin * (1.0 + 0.6 * float(i)) + float(i) * 2.1
			draw_arc(c, r, s0, s0 + span, 72, Color(tint, a), w, true)
			draw_arc(c, r, s0 + PI * 0.75, s0 + PI * 0.75 + span * 0.6, 48,
				Color(tint, a * 0.6), w * 0.8, true)
		for i in 12:
			var fi := float(i)
			var ang := spin * (0.5 + 0.08 * fi) + TAU * fi / 12.0
			var rr := rad * (1.12 + 0.36 * fmod(fi * 0.37 + 0.11, 1.0))
			var p := c + Vector2(cos(ang), sin(ang)) * rr
			var tw := 0.5 + 0.5 * sin(clock * 2.1 + fi * 1.7)
			draw_circle(p, 3.2 * k, Color(tint.lightened(0.35), 0.09 * tw * pw))
			draw_circle(p, 1.3 * k, Color(1, 1, 1, 0.55 * tw * pw))


## 一圈向外扩散的涟漪（自己淡掉、自己销毁）
class Ripple extends Control:
	var col := Color.WHITE
	var radius := 100.0
	var fade := 1.0
	var thick := 3.0

	func _process(_delta: float) -> void:
		queue_redraw()

	func _draw() -> void:
		if fade <= 0.01:
			return
		draw_arc(size * 0.5, radius, 0.0, TAU, 96, Color(col, fade * 0.55), thick, true)


var tint: Color = U.GOLD
var rad := 96.0
var anim := 1.0        # 0 = 静止（自检/截图）
var power := 1.0       # 亮度倍率
var fx_level := 0      # 0 纯色实心（作者 2026-11-08 定的默认）/ 1 省电 / 2 全质量（shader 能量流）

var _body: Control
var _halo2: TextureRect
var _halo: TextureRect
var _core: TextureRect
var _flash: TextureRect
var _ring: RingLayer
var _fx: ColorRect
var _fx_mat: ShaderMaterial
var _t := 0.0
var _spin := 0.0
var _energy := 1.0
var _glow := 1.0
var _pulse_tw: Tween = null


func _ready() -> void:
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	mouse_filter = Control.MOUSE_FILTER_IGNORE
	size = Vector2(rad, rad) * 2.0
	pivot_offset = size * 0.5
	_build()
	set_process(true)


func _build() -> void:
	_body = Control.new()
	_body.size = size
	_body.pivot_offset = size * 0.5
	_body.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_body.set_meta("decor", true)
	add_child(_body)

	_halo2 = _tex(U.radial([[0.0, Color(tint, 0.20)], [0.32, Color(tint.darkened(0.12), 0.11)],
		[0.62, Color(tint, 0.035)], [1.0, Color(tint, 0.0)]]), 5.6, true)
	_halo = _tex(U.radial([[0.0, Color(tint, 0.70)], [0.34, Color(tint, 0.26)],
		[0.66, Color(tint, 0.06)], [1.0, Color(tint, 0.0)]]), 2.9, true)
	_core = _tex(U.radial(_core_stops()), 1.06, false)
	_flash = _tex(U.radial([[0.0, Color(1, 1, 1, 0.95)], [0.45, Color(1, 1, 1, 0.30)],
		[1.0, Color(1, 1, 1, 0.0)]]), 2.6, true)
	_flash.modulate.a = 0.0

	_build_fx()

	_ring = RingLayer.new()
	_ring.tint = tint
	_ring.rad = rad
	_ring.size = size
	_ring.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_ring.set_meta("decor", true)
	add_child(_ring)


## 核心渐变的色标。开 shader 时压薄（原来中心 α0.98 直接推到近白，
## 会把上面那层加色流丝整个冲掉），关 shader 时恢复厚度，否则球会发灰。
func _core_stops() -> Array:
	if fx_level <= 0:
		# 纯色球：整个球面就一个颜色，只有最外沿 6% 收边（当抗锯齿用），
		# 不再有中心白斑和双色渐变 —— 作者要求「光球要是纯色的」。
		var c := tint
		return [[0.0, c], [0.88, c], [0.94, Color(c, 0.85)], [1.0, Color(c, 0.0)]]
	return [[0.0, Color(1, 1, 1, 0.60)], [0.20, Color(tint.lightened(0.55), 0.46)],
		[0.44, Color(tint, 0.28)], [0.72, Color(tint.darkened(0.10), 0.08)],
		[1.0, Color(tint, 0.0)]]


## 能量流 shader 层：铺在核心之上、光环之下，跟着 _body 一起脉动/胀开
func _build_fx() -> void:
	_fx = null
	if fx_level <= 0:
		return
	var sh: Shader = load("res://assets/orb.gdshader")
	if sh == null:
		return
	_fx_mat = ShaderMaterial.new()
	_fx_mat.shader = sh
	_fx = ColorRect.new()
	_fx.color = Color(1, 1, 1, 1)
	_fx.size = size * 2.0
	_fx.position = (size - _fx.size) * 0.5
	_fx.pivot_offset = _fx.size * 0.5
	_fx.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fx.material = _fx_mat
	_fx.set_meta("decor", true)
	_body.add_child(_fx)
	_sync_fx()


## 运行中切换特效档位（设置页用）
func set_fx(level: int) -> void:
	if level == fx_level:
		return
	fx_level = level
	if _fx != null and is_instance_valid(_fx):
		_fx.queue_free()
		_fx = null
		_fx_mat = null
	if _core != null and is_instance_valid(_core):
		_core.texture = U.radial(_core_stops())
	if level > 0:
		_build_fx()


func _sync_fx() -> void:
	if _fx_mat == null:
		return
	_fx_mat.set_shader_parameter("core_color", Color(1, 0.96, 0.86))
	_fx_mat.set_shader_parameter("rim_color", tint)
	_fx_mat.set_shader_parameter("time", _t)
	_fx_mat.set_shader_parameter("energy", clampf(_energy, 0.0, 3.0) * power)
	_fx_mat.set_shader_parameter("glow", _glow)
	_fx_mat.set_shader_parameter("quality", 1.0 if fx_level >= 2 else 0.0)


func _tex(tex: Texture2D, k: float, add: bool) -> TextureRect:
	var t := TextureRect.new()
	t.texture = tex
	t.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	t.stretch_mode = TextureRect.STRETCH_SCALE
	t.size = size * k
	t.position = (size - t.size) * 0.5
	t.pivot_offset = t.size * 0.5
	t.mouse_filter = Control.MOUSE_FILTER_IGNORE
	t.set_meta("decor", true)
	if add:
		U.additive(t)
	_body.add_child(t)
	return t


func _process(delta: float) -> void:
	_t += delta
	if anim > 0.001:
		_spin += delta * 0.30
		var b := sin(_t * 1.45)
		var b2 := sin(_t * 0.83 + 1.1)
		_halo.modulate = Color(1, 1, 1, (0.76 + 0.10 * b) * power)
		_halo.scale = Vector2.ONE * (1.0 + 0.035 * b)
		_halo2.modulate = Color(1, 1, 1, (0.60 + 0.10 * b2) * power)
		_halo2.scale = Vector2.ONE * (1.0 + 0.06 * b2)
		_halo2.rotation += delta * 0.05
		_core.modulate = Color(1, 1, 1, (0.94 + 0.06 * b) * power)
	_energy = lerpf(_energy, 1.0, minf(1.0, delta * 3.2))
	_glow = lerpf(_glow, 1.0, minf(1.0, delta * 2.4))
	_sync_fx()
	_ring.spin = _spin
	_ring.clock = _t
	_ring.power = power
	_ring.queue_redraw()


## 吸一口气：整团光胀一下再弹回，同时闪一下
func pulse(strength: float = 1.0) -> void:
	if not is_inside_tree():
		return
	if _pulse_tw != null and _pulse_tw.is_valid():
		_pulse_tw.kill()
	_pulse_tw = create_tween()
	_pulse_tw.tween_property(_body, "scale", Vector2.ONE * (1.0 + 0.17 * strength), _T(0.11)) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	_pulse_tw.tween_property(_body, "scale", Vector2.ONE, _T(0.44)) \
		.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_energy = 1.0 + 1.25 * strength
	var f := create_tween()
	f.tween_property(_flash, "modulate:a", clampf(0.8 * strength, 0.0, 1.0), _T(0.06))
	f.tween_property(_flash, "modulate:a", 0.0, _T(0.42)).set_trans(Tween.TRANS_CUBIC)


## 向外散一圈涟漪
func ripple(strength: float = 1.0) -> void:
	if not is_inside_tree():
		return
	var rp := Ripple.new()
	rp.col = tint
	rp.radius = rad * 1.05
	rp.fade = 1.0
	rp.thick = 2.0 + 1.6 * strength
	rp.size = size
	rp.mouse_filter = Control.MOUSE_FILTER_IGNORE
	rp.set_meta("decor", true)
	add_child(rp)
	var tw := rp.create_tween()
	tw.set_parallel(true)
	tw.tween_property(rp, "radius", rad * (2.6 + 1.1 * strength), _T(0.62)) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
	tw.tween_property(rp, "fade", 0.0, _T(0.62)).set_trans(Tween.TRANS_CUBIC)
	tw.chain().tween_callback(func(): rp.queue_free())


## 整团光胀开吞掉屏幕，胀满时回调
func expand(sec: float, cb: Callable) -> void:
	if not is_inside_tree():
		cb.call()
		return
	var tw := create_tween()
	tw.set_parallel(true)
	tw.tween_property(_body, "scale", Vector2.ONE * 11.0, sec).set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
	tw.tween_property(_halo, "modulate:a", 1.0, sec * 0.9)
	tw.tween_property(_halo2, "modulate:a", 0.95, sec * 0.9)
	tw.tween_property(_core, "modulate:a", 1.0, sec * 0.7)
	tw.tween_property(_flash, "modulate:a", 0.9, sec * 0.85)
	tw.tween_property(self, "_glow", 1.9, sec).set_trans(Tween.TRANS_CUBIC)
	tw.chain().tween_callback(cb)


func _T(sec: float) -> float:
	return maxf(0.001, sec * maxf(anim, 0.02))