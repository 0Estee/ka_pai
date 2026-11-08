## 光球 shader 自检：能量流这层真的画出来了吗？真的在动吗？
##   · fx_level=2 → 本体里应存在带 ShaderMaterial 的 fx 层
##   · fx_level=0 → 该层应被移除，且画面与 fx_level=2 明显不同
##   · 同一位置隔一段时间取两次图，球内像素应发生变化（流丝在走）
## 需要真渲染器（--headless 是 dummy 渲染器截不到图）：
##   Godot_v4.7.2-stable_win64_console.exe --path godot --resolution 460x460 --script res://tests/orb_fx.gd
extends SceneTree

const KPOrbScript := preload("res://scripts/ui/kp_orb.gd")

var problems := 0
var checks := 0


func _check(ok: bool, msg: String) -> void:
	checks += 1
	if not ok:
		problems += 1
		print("[orb_fx] FAIL ", msg)
	else:
		print("[orb_fx] ok   ", msg)


func _initialize() -> void:
	await _run()
	print("[orb_fx] checks=%d problems=%d" % [checks, problems])
	quit(0 if problems == 0 else 1)


func _make_orb(level: int) -> Control:
	var orb: Control = KPOrbScript.new()
	orb.rad = 96.0
	orb.anim = 0.0
	orb.fx_level = level
	orb.size = Vector2(192, 192)
	orb.position = Vector2(134, 134)
	return orb


func _grab(vp: SubViewport) -> Image:
	await process_frame
	await process_frame
	var img: Image = vp.get_texture().get_image()
	return img


func _mean_abs_diff(a: Image, b: Image, cx: float, cy: float, rad: float) -> float:
	var sum := 0.0
	var n := 0
	for y in range(int(cy - rad), int(cy + rad)):
		for x in range(int(cx - rad), int(cx + rad)):
			if Vector2(x - cx, y - cy).length() > rad:
				continue
			var ca := a.get_pixel(x, y)
			var cb := b.get_pixel(x, y)
			sum += absf(ca.r - cb.r) + absf(ca.g - cb.g) + absf(ca.b - cb.b)
			n += 1
	return 0.0 if n == 0 else sum / float(n)


func _luma(img: Image, x: int, y: int) -> float:
	var c: Color = img.get_pixel(x, y)
	return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b


func _angular_sd(img: Image, cx: float, cy: float, r: float) -> float:
	var vals: Array[float] = []
	var a := 0.0
	while a < TAU:
		vals.append(_luma(img, int(cx + cos(a) * r), int(cy + sin(a) * r)))
		a += 0.05
	var m := 0.0
	for v in vals:
		m += v
	m /= float(vals.size())
	var s := 0.0
	for v in vals:
		s += (v - m) * (v - m)
	return sqrt(s / float(vals.size()))


func _run() -> void:
	var vp := SubViewport.new()
	vp.size = Vector2i(460, 460)
	vp.transparent_bg = false
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)

	# 底色：首页那种深蓝黑
	var bg := ColorRect.new()
	bg.color = Color(0.055, 0.063, 0.09, 1.0)
	bg.size = Vector2(460, 460)
	vp.add_child(bg)

	# —— fx_level = 2（全质量） ——
	var orb2 := _make_orb(2)
	vp.add_child(orb2)
	var shot_a: Image = await _grab(vp)
	_check(_has_fx(orb2), "fx_level=2 本体里有 shader 层")
	# 流丝：同一半径转一圈亮度不该是常数（纯径向渐变时 sd < 0.01）
	var sd_full := _angular_sd(shot_a, 230.0, 230.0, 50.0)
	_check(sd_full > 0.01, "球身有非径向结构（r=50 角向 sd=%.4f > 0.01）" % sd_full)
	# 动画：等 1 秒再取一次，球内像素应变化
	for i in 60:
		await process_frame
	var shot_b: Image = await _grab(vp)
	var diff := _mean_abs_diff(shot_a, shot_b, 230.0, 230.0, 96.0)
	_check(diff > 0.004, "能量流在动（1 秒内球内平均变化 %.4f > 0.004）" % diff)

	# —— fx_level = 0（关） ——
	var orb0 := _make_orb(0)
	vp.add_child(orb0)
	await process_frame
	_check(not _has_fx(orb0), "fx_level=0 没有 shader 层")
	# 关特效时应能看出亮度分布差异（平滑渐变 vs 有流丝）
	var shot_c: Image = await _grab(vp)
	var diff0 := _mean_abs_diff(shot_a, shot_c, 230.0, 230.0, 96.0)
	var sd_off := _angular_sd(shot_c, 230.0, 230.0, 50.0)
	print("[orb_fx] fx on/off 差异=%.4f，关特效时角向 sd=%.4f" % [diff0, sd_off])
	_check(sd_full > sd_off * 1.5, "开特效的角向结构明显多于关特效（%.4f vs %.4f）" % [sd_full, sd_off])

	# —— 运行中切档 ——
	orb0.set_fx(1)
	await process_frame
	_check(_has_fx(orb0), "set_fx(1) 后重新建出省电档 shader 层")
	orb2.set_fx(0)
	await process_frame
	_check(not _has_fx(orb2), "set_fx(0) 后移除 shader 层")


func _has_fx(orb: Node) -> bool:
	for c in orb.get_children():
		if c is Control and (c as Control).material is ShaderMaterial:
			return true
		for cc in c.get_children():
			if cc is Control and (cc as Control).material is ShaderMaterial:
				return true
	return false
