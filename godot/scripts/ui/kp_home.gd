## 首页：一个光球，选项绕它一圈。
##
## 交互：
##   · 点环上的选项 → 它沿弧线钻进光球，光球吸气发光，然后把下一级选项吐出来
##   · 点空白处（或光球） → 收回去上一层
##   · 点「开始对局」 → 选项钻进光球、光球胀开吞掉屏幕，对局从白光里出现
class_name KPHome
extends Control

signal start_requested(cfg: Dictionary)

const U := preload("res://scripts/ui/kp_ui.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")
const ORB := preload("res://scripts/ui/kp_orb.gd")
const ITEM := preload("res://scripts/ui/kp_orb_item.gd")

const DESIGN := Vector2(720, 1280)
const ORB_CENTER := Vector2(360, 604)
const ORB_RAD := 96.0

## 速度倍率：0 = 全静止（自检/截图用），1 = 正常，2 = 慢放
var anim := 1.0

var _frame: Control
var _orb = null
var _items_root: Control
var _flash: ColorRect
var _crumb: Label
var _hint: Label
var _back_btn: Control
var _items: Array = []
var _level := "root"
var _busy := false
var _ready_level := false
var _t := 0.0
var _faction_key := ""
var _difficulty_key := "normal"
var _seed_v := 0
var _started := false
var _cfg_out: Dictionary = {}


func _ready() -> void:
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	var vp := get_viewport_rect().size
	size = vp
	_build()
	resized.connect(_fit)
	get_viewport().size_changed.connect(_fit)
	_fit()


func _fit() -> void:
	var avail := size
	if avail.x <= 1.0 or avail.y <= 1.0:
		avail = get_viewport_rect().size
		size = avail
	var s := minf(avail.x / DESIGN.x, avail.y / DESIGN.y)
	_frame.scale = Vector2(s, s)
	_frame.position = (avail - DESIGN * s) * 0.5


# ── 搭骨架 ───────────────────────────────────────────────────────────────────

func _build() -> void:
	var bg := ColorRect.new()
	bg.color = U.BG
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	_frame = Control.new()
	_frame.size = DESIGN
	_frame.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(_frame)

	# 背景：一团冷色星云 + 暗角，让光球有地方发光
	var neb := TextureRect.new()
	neb.texture = U.radial([[0.0, Color(0.11, 0.16, 0.32, 0.34)], [0.40, Color(0.07, 0.10, 0.20, 0.18)],
		[0.72, Color(0.05, 0.06, 0.11, 0.05)], [1.0, Color(0, 0, 0, 0)]], 128)
	neb.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	neb.stretch_mode = TextureRect.STRETCH_SCALE
	neb.size = DESIGN
	neb.mouse_filter = Control.MOUSE_FILTER_IGNORE
	neb.set_meta("decor", true)
	_frame.add_child(neb)

	# 暗角：把注意力收到光球上
	var vig := TextureRect.new()
	vig.texture = U.radial([[0.0, Color(0, 0, 0, 0)], [0.50, Color(0, 0, 0, 0)],
		[0.80, Color(0, 0, 0, 0.30)], [1.0, Color(0, 0, 0, 0.62)]], 128)
	vig.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	vig.stretch_mode = TextureRect.STRETCH_SCALE
	vig.size = DESIGN * 1.02
	vig.position = -DESIGN * 0.01
	vig.mouse_filter = Control.MOUSE_FILTER_IGNORE
	vig.set_meta("decor", true)
	_frame.add_child(vig)

	# 点空白处 = 返回上一层（光球本身不拦鼠标，所以点光球也算空白）
	var click_area := Control.new()
	click_area.size = DESIGN
	click_area.mouse_filter = Control.MOUSE_FILTER_STOP
	U.on_click(click_area, _back)
	_frame.add_child(click_area)

	# 标题
	var tglow := U.glow_rect(Vector2(560, 240), U.GOLD, 0.16)
	tglow.position = Vector2(80, -12)
	_frame.add_child(tglow)
	var title := U.label("王座交锋", 56, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	title.position = Vector2(0, 62)
	title.size = Vector2(720, 78)
	title.clip_text = false
	_frame.add_child(title)
	var rule := ColorRect.new()
	rule.color = Color(U.GOLD, 0.30)
	rule.position = Vector2(300, 148)
	rule.size = Vector2(120, 2)
	rule.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(rule)

	_crumb = U.label("选一项，它会钻进光球", 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_crumb.position = Vector2(0, 158)
	_crumb.size = Vector2(720, 26)
	_crumb.clip_text = false
	_frame.add_child(_crumb)

	# 光球
	_orb = ORB.new()
	_orb.tint = U.GOLD
	_orb.rad = ORB_RAD
	_orb.anim = anim
	_frame.add_child(_orb)
	_orb.position = ORB_CENTER - Vector2(ORB_RAD, ORB_RAD)

	# 选项层
	_items_root = Control.new()
	_items_root.size = DESIGN
	_items_root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(_items_root)

	# 返回按钮（只在二级里出现）
	_back_btn = Control.new()
	_back_btn.position = Vector2(24, 186)
	_back_btn.size = Vector2(136, 52)
	_back_btn.mouse_filter = Control.MOUSE_FILTER_STOP
	U.on_click(_back_btn, _back)
	_frame.add_child(_back_btn)
	var back_box := Panel.new()
	back_box.size = _back_btn.size
	back_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	back_box.add_theme_stylebox_override("panel", U.box(Color(0.086, 0.106, 0.149, 0.9), 26, Color(U.LINE, 0.9), 1))
	_back_btn.add_child(back_box)
	var back_lab := U.label("‹  返回", 17, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	back_lab.position = Vector2(0, 8)
	back_lab.size = Vector2(136, 36)
	back_lab.clip_text = false
	_back_btn.add_child(back_lab)
	_back_btn.visible = false

	_hint = U.label("点空白处返回 · 选项会飞进光球里", 14, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_hint.position = Vector2(0, 1150)
	_hint.size = Vector2(720, 30)
	_hint.clip_text = false
	_frame.add_child(_hint)

	var ver := U.label("v%s · 手机端重构预览" % str(ProjectSettings.get_setting("application/config/version", "0.80.0")),
		13, Color(U.DIM, 0.65), HORIZONTAL_ALIGNMENT_CENTER)
	ver.position = Vector2(0, 1196)
	ver.size = Vector2(720, 26)
	ver.clip_text = false
	_frame.add_child(ver)

	# 最后一层：白光（进对局时整屏被吞白）
	_flash = ColorRect.new()
	_flash.color = Color(1, 1, 1, 1)
	_flash.position = Vector2.ZERO
	_flash.size = DESIGN
	_flash.modulate.a = 0.0
	_flash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(_flash)

	_spawn_level("root")


# ── 关卡规格 ─────────────────────────────────────────────────────────────────

func _radius(level: String) -> float:
	match level:
		"faction":
			return 268.0
		"difficulty":
			return 236.0
		"seed":
			return 226.0
	return 250.0


func _spec(level: String) -> Array:
	if level == "faction":
		var out: Array = []
		for f in DATA.factions():
			out.append({
				"action": "pick_faction",
				"payload": str(f.key),
				"title": str(f.name),
				"subtitle": "",
				"tint": U.FACTION,
				"w": 112.0, "h": 54.0,
			})
		return out
	if level == "difficulty":
		var out2: Array = []
		for d in DATA.difficulties():
			out2.append({
				"action": "pick_difficulty",
				"payload": str(d.key),
				"title": str(d.name),
				"subtitle": str(d.get("tagline", "")),
				"tint": U.MANA,
				"w": 224.0, "h": 78.0,
			})
		return out2
	if level == "seed":
		return [
			{"action": "pick_seed", "payload": "0", "title": "随 机", "subtitle": "每局都不一样",
				"tint": U.GOOD, "w": 168.0, "h": 70.0},
			{"action": "pick_seed", "payload": "1001", "title": "1001", "subtitle": "固定种子",
				"tint": U.GOOD, "w": 168.0, "h": 70.0},
			{"action": "pick_seed", "payload": "2001", "title": "2001", "subtitle": "固定种子",
				"tint": U.GOOD, "w": 168.0, "h": 70.0},
			{"action": "pick_seed", "payload": "3001", "title": "3001", "subtitle": "固定种子",
				"tint": U.GOOD, "w": 168.0, "h": 70.0},
		]
	return [
		{"action": "level", "payload": "faction", "title": "阵 营", "subtitle": DATA.faction_name(_faction_key),
			"tint": U.FACTION, "angle": -90.0, "w": 176.0, "h": 76.0},
		{"action": "level", "payload": "difficulty", "title": "难 度", "subtitle": _diff_name(),
			"tint": U.MANA, "angle": 0.0, "w": 176.0, "h": 76.0},
		{"action": "start", "payload": "", "title": "开 始 对 局", "subtitle": "",
			"tint": U.GOLD, "emphasized": true, "angle": 90.0, "w": 232.0, "h": 92.0},
		{"action": "level", "payload": "seed", "title": "种 子", "subtitle": _seed_label(),
			"tint": U.GOOD, "angle": 180.0, "w": 176.0, "h": 76.0},
	]


func _diff_name() -> String:
	for d in DATA.difficulties():
		if str(d.key) == _difficulty_key:
			return str(d.name)
	return _difficulty_key


func _seed_label() -> String:
	return "随机" if _seed_v == 0 else str(_seed_v)


# ── 一级 → 二级 ──────────────────────────────────────────────────────────────

func _spawn_level(level: String) -> void:
	_level = level
	_ready_level = false
	var spec := _spec(level)
	var n := spec.size()
	var radius := _radius(level)
	var span := 0.0
	for i in n:
		var d: Dictionary = spec[i]
		var item := ITEM.new()
		item.action = str(d.get("action", ""))
		item.payload = str(d.get("payload", ""))
		item.title = str(d.get("title", ""))
		item.subtitle = str(d.get("subtitle", ""))
		item.tint = d.get("tint", U.GOLD)
		item.emphasized = bool(d.get("emphasized", false))
		item.w = float(d.get("w", 150.0))
		item.h = float(d.get("h", 66.0))
		_items_root.add_child(item)

		var deg := float(d.get("angle", -90.0 + 360.0 * float(i) / float(n)))
		var a := deg_to_rad(deg)
		var target := ORB_CENTER + Vector2(cos(a), sin(a)) * radius - item.size * 0.5
		item.set_meta("base", target)
		item.picked.connect(_on_item_picked.bind(item))
		_items.append(item)

		if not _anim_on():
			item.position = target
			continue
		item.position = ORB_CENTER - item.size * 0.5
		item.scale = Vector2(0.2, 0.2)
		item.rotation = 0.30 * (1.0 if i % 2 == 0 else -1.0)
		item.modulate.a = 0.0
		var delay := 0.05 + 0.034 * float(i)
		var tw: Tween = item.create_tween()
		tw.tween_interval(_T(delay))
		tw.tween_property(item, "position", target, _T(0.46)) \
			.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		tw.parallel().tween_property(item, "scale", Vector2.ONE, _T(0.42)) \
			.set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
		tw.parallel().tween_property(item, "rotation", 0.0, _T(0.46)) \
			.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		tw.parallel().tween_property(item, "modulate:a", 1.0, _T(0.24))
		span = maxf(span, delay + 0.46)

	_update_crumb()
	if _anim_on():
		_delay(span + 0.02, func():
			_busy = false
			_ready_level = true)
	else:
		_busy = false
		_ready_level = true


## 旧选项一起被吸回光球
func _collapse_items() -> void:
	for it in _items:
		if it == null or not is_instance_valid(it):
			continue
		if _anim_on():
			var tw: Tween = it.create_tween()
			tw.set_parallel(true)
			tw.tween_property(it, "position", ORB_CENTER - it.size * 0.5, _T(0.26)) \
				.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
			tw.tween_property(it, "scale", Vector2(0.2, 0.2), _T(0.24))
			tw.tween_property(it, "modulate:a", 0.0, _T(0.20))
			tw.chain().tween_callback(it.queue_free)
		else:
			it.queue_free()
	_items.clear()


func _on_item_picked(item) -> void:
	if _busy or not _ready_level:
		return
	if item == null or not is_instance_valid(item):
		return
	match str(item.action):
		"level":
			_go_level(str(item.payload), item)
		"pick_faction":
			_faction_key = str(item.payload)
			_pick_and_return(item)
		"pick_difficulty":
			_difficulty_key = str(item.payload)
			_pick_and_return(item)
		"pick_seed":
			_seed_v = int(item.payload)
			_pick_and_return(item)
		"start":
			_launch(item)


func _go_level(level: String, item) -> void:
	_busy = true
	if not _anim_on():
		_enter_level(level)
		return
	_absorb(item, func(): _delay(0.02, func(): _enter_level(level)))


func _pick_and_return(item) -> void:
	_busy = true
	if not _anim_on():
		_enter_level("root")
		return
	_absorb(item, func(): _delay(0.02, func(): _enter_level("root")))


func _enter_level(level: String) -> void:
	_collapse_items()
	_orb.pulse(0.85)
	_orb.ripple(1.0)
	_spawn_level(level)


# ── 动作：吸进光球 / 胀开吞屏 ────────────────────────────────────────────────

## 把一张选项沿弧线送进光球，碎光四散，光球在牌到嘴边时吸一口气
func _absorb(item, cb: Callable) -> void:
	_items.erase(item)
	if item == null or not is_instance_valid(item):
		cb.call()
		return
	var start: Vector2 = item.position
	var dest: Vector2 = ORB_CENTER - item.size * 0.5
	var ctrl: Vector2 = (start + dest) * 0.5 + Vector2(0, -70)
	var dur := 0.32
	_trail(item, 5, dur * 0.9)
	var tw: Tween = item.create_tween()
	tw.tween_method(func(t: float): item.position = _bez(start, ctrl, dest, t), 0.0, 1.0, _T(dur)) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN)
	tw.parallel().tween_property(item, "scale", Vector2(0.14, 0.14), _T(dur)) \
		.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
	tw.parallel().tween_property(item, "rotation", 0.55, _T(dur))
	tw.parallel().tween_property(item, "modulate:a", 0.0, _T(dur * 0.55)).set_delay(_T(dur * 0.42))
	tw.tween_callback(func():
		if is_instance_valid(item):
			item.queue_free()
		cb.call())
	_delay(dur * 0.74, func():
		_orb.pulse(1.0)
		_orb.ripple(1.1))


func _launch(item) -> void:
	_busy = true
	_ready_level = false
	_update_crumb()
	_build_cfg()
	if not _anim_on():
		start_requested.emit(_cfg_out)
		return
	_absorb(item, _blast)
	_collapse_items()


func _blast() -> void:
	_delay(0.04, func(): _orb.pulse(1.7))
	_delay(0.12, func():
		_orb.ripple(2.2)
		_orb.ripple(1.2))
	_burst(10)
	_delay(0.18, func():
		var tw := create_tween()
		tw.set_parallel(true)
		tw.tween_property(_flash, "modulate:a", 1.0, _T(0.46)) \
			.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_IN)
		_orb.expand(_T(0.52), _emit_start))


func _emit_start() -> void:
	if _started:
		return
	_started = true
	start_requested.emit(_cfg_out)


func _build_cfg() -> void:
	var seed_v := _seed_v
	if seed_v == 0:
		seed_v = randi() % 1000000000
	var fs: Array = DATA.factions()
	var ai_key := ""
	if fs.size() > 1:
		var pool: Array = []
		for f in fs:
			if str(f.key) != _faction_key:
				pool.append(str(f.key))
		if pool.size() > 0:
			ai_key = str(pool[randi() % pool.size()])
	_cfg_out = {
		"seed": seed_v,
		"difficulty": _difficulty_key,
		"humanFaction": _faction_key,
		"aiFaction": ai_key,
		"deckSize": 80,
		"humanSide": 0,
	}


func _back() -> void:
	if _busy or not _ready_level or _level == "root":
		return
	_busy = true
	if not _anim_on():
		_enter_level("root")
		return
	_collapse_items()
	_orb.pulse(0.7)
	_delay(0.26, func(): _enter_level("root"))


# ── 小工具 ───────────────────────────────────────────────────────────────────

func _update_crumb() -> void:
	match _level:
		"faction":
			_crumb.text = "阵营 · %d 个可选（决定能抽到哪些超能力）" % DATA.factions().size()
		"difficulty":
			_crumb.text = "难度 · 五档 AI"
		"seed":
			_crumb.text = "种子 · 同一个种子开局一样"
		_:
			_crumb.text = "选一项，它会钻进光球"
	_back_btn.visible = _level != "root"


func _process(delta: float) -> void:
	if not _anim_on() or not _ready_level or _busy:
		return
	_t += delta
	for i in _items.size():
		var it = _items[i]
		if it == null or not is_instance_valid(it):
			continue
		var base: Vector2 = it.get_meta("base", it.position)
		it.position = base + Vector2(0, sin(_t * 1.25 + float(i) * 0.9) * 2.6)


func _trail(item, count: int, span: float) -> void:
	var tw := create_tween()
	for j in count:
		tw.tween_callback(_puff_at_item.bind(item))
		tw.tween_interval(maxf(0.001, _T(span) / float(maxi(count, 1))))


func _puff_at_item(item) -> void:
	if item == null or not is_instance_valid(item):
		return
	_puff(item.position + item.size * 0.5, item.tint)


## 一颗碎光：亮起来、缩没、自己销毁
func _puff(pos: Vector2, col: Color) -> void:
	var dot := TextureRect.new()
	dot.texture = U.glow_tex()
	dot.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
	dot.stretch_mode = TextureRect.STRETCH_SCALE
	dot.size = Vector2(52, 52)
	dot.position = pos - dot.size * 0.5
	dot.pivot_offset = dot.size * 0.5
	dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
	dot.set_meta("decor", true)
	dot.modulate = Color(col.r, col.g, col.b, 0.85)
	U.additive(dot)
	_items_root.add_child(dot)
	var tw := dot.create_tween()
	tw.set_parallel(true)
	tw.tween_property(dot, "scale", Vector2(0.35, 0.35), _T(0.32)).set_trans(Tween.TRANS_CUBIC)
	tw.tween_property(dot, "modulate:a", 0.0, _T(0.32))
	tw.chain().tween_callback(dot.queue_free)


## 光球四周炸开一圈碎光
func _burst(n: int) -> void:
	for i in n:
		var ang := TAU * float(i) / float(n) + randf() * 0.3
		var dir := Vector2(cos(ang), sin(ang))
		var dot := TextureRect.new()
		dot.texture = U.glow_tex()
		dot.expand_mode = TextureRect.EXPAND_IGNORE_SIZE
		dot.stretch_mode = TextureRect.STRETCH_SCALE
		dot.size = Vector2(64, 64)
		dot.pivot_offset = dot.size * 0.5
		dot.position = ORB_CENTER - dot.size * 0.5
		dot.mouse_filter = Control.MOUSE_FILTER_IGNORE
		dot.set_meta("decor", true)
		dot.modulate = Color(U.GOLD.r, U.GOLD.g, U.GOLD.b, 0.9)
		U.additive(dot)
		_items_root.add_child(dot)
		var tw := dot.create_tween()
		tw.set_parallel(true)
		tw.tween_property(dot, "position", dot.position + dir * (150.0 + randf() * 190.0), _T(0.55)) \
			.set_trans(Tween.TRANS_CUBIC).set_ease(Tween.EASE_OUT)
		tw.tween_property(dot, "scale", Vector2(0.4, 0.4), _T(0.55))
		tw.tween_property(dot, "modulate:a", 0.0, _T(0.55)).set_delay(_T(0.12))
		tw.chain().tween_callback(dot.queue_free)


func _bez(a: Vector2, b: Vector2, c: Vector2, t: float) -> Vector2:
	var u := 1.0 - t
	return a * u * u + b * 2.0 * u * t + c * t * t


func _delay(sec: float, cb: Callable) -> void:
	var tw := create_tween()
	tw.tween_interval(maxf(0.001, _T(sec)))
	tw.tween_callback(cb)


func _T(sec: float) -> float:
	return maxf(0.001, sec * maxf(anim, 0.02))


func _anim_on() -> bool:
	return anim > 0.001
