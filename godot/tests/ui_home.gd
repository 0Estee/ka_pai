## 首页自检：光球环形菜单走完整链路（点进二级 → 选一项 → 回一级 → 最后开始对局）
##
## 检查项：环上半径、越界、动画时序（_busy/_ready_level）、cfg 内容、交接时是否整屏刷白。
extends SceneTree

const KPHome := preload("res://scripts/ui/kp_home.gd")
const U := preload("res://scripts/ui/kp_ui.gd")

var home
var started: Array = []
var problems: Array = []


func _initialize() -> void:
	await process_frame
	home = KPHome.new()
	home.start_requested.connect(_on_start)
	root.add_child(home)
	home.size = home.DESIGN
	home._fit()

	print("== 首页：光球环形菜单")
	var f0 := Engine.get_process_frames()
	await _wait_ready(300)
	print("  开场 %d 帧后稳定；选项 %d 个；光球中心 %s" %
		[Engine.get_process_frames() - f0, home._items.size(), str(home.ORB_CENTER)])
	_expect(home._items.size() == 6, "一级应有 6 项（阵营/难度/设置/开始/回放/联机），实得 %d" % home._items.size())
	_expect(_find("level", "seed") == null, "一级里不该再有「种子」（作者 2026-11-08：前面不要有种子）")
	_report_ring("一级", 250.0)

	# 进「阵营」层
	var it = _find("level", "faction")
	_expect(it != null, "找不到「阵营」选项")
	await _click(it)
	var t1 := Engine.get_process_frames()
	var ms1 := Time.get_ticks_msec()
	await _wait_ready(300)
	print("  进二级用了 %d 帧 / %d ms；level=%s；选项 %d 个" % [Engine.get_process_frames() - t1, Time.get_ticks_msec() - ms1, home._level, home._items.size()])
	_expect(home._level == "faction", "点「阵营」后应在 faction 层，实得 %s" % home._level)
	_expect(home._items.size() == 13, "阵营层应有 13 项（没有中立了），实得 %d" % home._items.size())
	var has_neutral := false
	for x in home._items:
		if str(x.payload) == "":
			has_neutral = true
	_expect(not has_neutral, "阵营层里不该再有「中立」")
	_report_ring("阵营层", 268.0)
	_expect(home._back_btn.visible, "二级里应显示返回按钮")

	# 选「剑道」→ 回到一级，副标题跟着变
	var f = _find("pick_faction", "sword")
	_expect(f != null, "阵营层里找不到 sword")
	await _click(f)
	await _wait_ready(400)
	_expect(home._level == "root", "选完阵营应回一级，实得 %s" % home._level)
	_expect(home._faction_key == "sword", "阵营应为 sword，实得 %s" % home._faction_key)
	var sub := _subtitle("level", "faction")
	print("  选完阵营：_faction_key=%s；一级「阵营」副标题=%s" % [home._faction_key, sub])
	_expect(sub == "剑道", "一级副标题应显示「剑道」，实得 %s" % sub)

	# 难度层
	await _click(_find("level", "difficulty"))
	await _wait_ready(300)
	_expect(home._level == "difficulty" and home._items.size() == 5, "难度层应 5 项，实得 %d" % home._items.size())
	_report_ring("难度层", 236.0)
	await _click(_find("pick_difficulty", "hard"))
	await _wait_ready(400)
	_expect(home._difficulty_key == "hard", "难度应为 hard，实得 %s" % home._difficulty_key)
	print("  选完难度：副标题=%s" % _subtitle("level", "difficulty"))

	# 种子：首页不再露出，默认随机（0 表示每局随机）
	_expect(home._seed_v == 0, "默认种子应为 0（随机），实得 %d" % home._seed_v)

	# 空白处回退：再进阵营层，然后点空白
	await _click(_find("level", "faction"))
	await _wait_ready(300)
	_expect(home._level == "faction", "再进阵营层失败")
	home._back()
	await _wait_ready(400)
	_expect(home._level == "root", "点空白应回一级，实得 %s" % home._level)
	_expect(not home._back_btn.visible, "一级里不该显示返回按钮")
	print("  空白回退 OK")

	# 开始对局
	var s = _find("start", "")
	_expect(s != null, "一级里找不到「开始对局」")
	var t2 := Engine.get_process_frames()
	var ms2 := Time.get_ticks_msec()
	await _click(s)
	for i in 400:
		await process_frame
		if started.size() > 0:
			break
	print("  开始对局用了 %d 帧 / %d ms；收到 %d 次 start_requested" % [Engine.get_process_frames() - t2, Time.get_ticks_msec() - ms2, started.size()])
	_expect(started.size() == 1, "应只发 1 次 start_requested，实得 %d" % started.size())
	if started.size() > 0:
		var rec: Dictionary = started[0]
		var cfg: Dictionary = rec.cfg
		print("  cfg=%s" % str(cfg))
		print("  交接时白光 alpha=%.2f" % float(rec.flash))
		_expect(float(rec.flash) > 0.95, "交接时整屏应已刷白，实际 alpha=%.2f" % float(rec.flash))
		_expect(int(cfg.get("seed", 0)) > 0, "随机种子应已落地（>0），实得 %s" % str(cfg.get("seed")))
		_expect(str(cfg.get("difficulty", "")) == "hard", "难度应传 hard")
		_expect(str(cfg.get("humanFaction", "")) == "sword", "人方阵营应传 sword")
		_expect(str(cfg.get("aiFaction", "")) != "sword", "对手阵营不该和玩家一样")
		_expect(int(cfg.get("deckSize", 0)) == 80, "牌库应 80 张")
		_expect(int(cfg.get("humanSide", -1)) == 0, "人类应坐 0 号位")

	# 按压动效（作者 2026-11-08）：按下瞬间缩、松开弹回
	var hp = KPHome.new()
	hp.anim = 0.0
	root.add_child(hp)
	hp.size = hp.DESIGN
	hp._fit()
	await process_frame
	await process_frame
	var pit = null
	for x in hp._items:
		if str(x.action) == "level" and str(x.payload) == "difficulty":
			pit = x
	_expect(pit != null, "按压自检找不到「难度」")
	if pit != null:
		hp._busy = true      # 只测按压，不让它真的进二级（进了会把节点 free 掉）
		var down := InputEventMouseButton.new()
		down.button_index = MOUSE_BUTTON_LEFT
		down.pressed = true
		down.position = pit.get_global_rect().get_center()
		pit.gui_input.emit(down)
		for i in 6:
			await process_frame
		var sx := 1.0
		if not is_instance_valid(pit):
			problems.append("按压自检：控件在按下后就被销毁了")
		else:
			sx = pit.scale.x
		var up2 := InputEventMouseButton.new()
		up2.button_index = MOUSE_BUTTON_LEFT
		up2.pressed = false
		up2.position = down.position
		if is_instance_valid(pit):
			pit.gui_input.emit(up2)
		for i in 24:
			await process_frame
		var sx2: float = pit.scale.x if is_instance_valid(pit) else 1.0
		print("  按压动效：按下 scale=%.3f / 松开后 scale=%.3f" % [sx, sx2])
		_expect(sx < 0.99, "按下应缩到 1.0 以下，实得 %.3f" % sx)
		if is_instance_valid(pit):
			_expect(pit.scale.x > 0.99, "松开应弹回 1.0，实得 %.3f" % pit.scale.x)
	hp.queue_free()
	await process_frame

	# 选择后所有选项一起进球（作者 2026-11-08）
	var hb = KPHome.new()
	hb.anim = 1.0
	root.add_child(hb)
	hb.size = hb.DESIGN
	hb._fit()
	await _wait_ready_of(hb, 300)
	var nodes: Array = []
	var d0: Array = []
	for x in hb._items:
		nodes.append(x)
		d0.append((x.position + x.size * 0.5).distance_to(hb.ORB_CENTER))
	var pick = null
	for x in hb._items:
		if str(x.action) == "level" and str(x.payload) == "faction":
			pick = x
	_expect(pick != null, "进球自检找不到「阵营」")
	if pick != null:
		hb._on_item_picked(pick)
		var peak := 0
		var left := nodes.size()
		for step in 40:
			for i in 6:
				await process_frame
			var moving := 0
			var alive := 0
			for i in nodes.size():
				var nd = nodes[i]
				if nd != null and is_instance_valid(nd):
					alive += 1
					var d1: float = (nd.position + nd.size * 0.5).distance_to(hb.ORB_CENTER)
					if d1 < d0[i] - 0.5:
						moving += 1
			peak = maxi(peak, moving)
			left = alive
			if alive == 0:
				break
		print("  进球动效：同屏最多 %d/%d 个选项一起朝球心飞，收尾剩余 %d" % [peak, nodes.size(), left])
		_expect(peak >= 3, "点一项后其余选项应一起飞向光球，同屏最多只有 %d 个在动" % peak)
		_expect(left == 0, "所有选项最后都该被光球吸掉，还剩 %d 个" % left)
	hb.queue_free()
	await process_frame

	# 三个二级页面入口：点后面板换页，首页只负责发 open_page
	for pair in [["settings", "设 置"], ["online", "联 机"], ["replay", "回 放"]]:
		var h = KPHome.new()
		h.anim = 0.0
		var got: Array = []
		h.open_page.connect(func(page_name: String): got.append(page_name))
		root.add_child(h)
		h.size = h.DESIGN
		h._fit()
		await process_frame
		var ent = null
		for x in h._items:
			if str(x.action) == "page" and str(x.payload) == pair[0]:
				ent = x
		_expect(ent != null, "一级应有「%s」入口" % pair[1])
		if ent != null:
			_expect(str(ent.title) == pair[1], "「%s」标题应为 %s，实得 %s" % [pair[1], pair[1], str(ent.title)])
			await _click(ent)
			_expect(got.size() == 1 and str(got[0]) == pair[0],
				"点「%s」应发 1 次 open_page(%s)，实得 %s" % [pair[1], pair[0], str(got)])
		h.queue_free()
		await process_frame
	print("  三个二级页面入口 OK")

	if problems.is_empty():
		print("首页动画自检：problems=0")
		quit(0)
	else:
		for p in problems:
			print("  PROBLEM %s" % p)
		print("首页动画自检：problems=%d" % problems.size())
		quit(1)


func _on_start(cfg: Dictionary) -> void:
	started.append({"cfg": cfg, "flash": home._flash.modulate.a})


func _expect(ok: bool, msg: String) -> void:
	if not ok:
		problems.append(msg)


func _wait_ready_of(h, max_frames: int) -> void:
	for i in max_frames:
		await process_frame
		if is_instance_valid(h) and h._ready_level and not h._busy:
			return
	problems.append("等不到 _ready_level（level=%s busy=%s）" % [h._level, str(h._busy)])


func _wait_ready(max_frames: int) -> void:
	for i in max_frames:
		await process_frame
		if is_instance_valid(home) and home._ready_level and not home._busy:
			return
	problems.append("等不到 _ready_level（level=%s busy=%s）" % [home._level, str(home._busy)])


func _find(action: String, payload: String):
	for it in home._items:
		if it == null or not is_instance_valid(it):
			continue
		if str(it.action) == action and str(it.payload) == payload:
			return it
	return null


func _subtitle(action: String, payload: String) -> String:
	var it = _find(action, payload)
	return "" if it == null else str(it.subtitle)


func _report_ring(name: String, want: float) -> void:
	var lo := 100000.0
	var hi := -100000.0
	for it in home._items:
		if it == null or not is_instance_valid(it):
			continue
		var c: Vector2 = it.position + it.size * 0.5
		var d: float = c.distance_to(home.ORB_CENTER)
		lo = minf(lo, d)
		hi = maxf(hi, d)
		var r: Rect2 = Rect2(it.position, it.size)
		_expect(r.position.x >= -1.0 and r.position.y >= -1.0
			and r.end.x <= home.DESIGN.x + 1.0 and r.end.y <= home.DESIGN.y + 1.0,
			"%s 有选项越界：%s" % [name, str(r)])
	print("  %s：半径 %.1f..%.1f（目标 %.0f）；越界 0" % [name, lo, hi, want])
	_expect(absf(lo - want) < 40.0 and absf(hi - want) < 40.0, "%s 半径不对：%.1f..%.1f 目标 %.0f" % [name, lo, hi, want])


## 真点：走控件自己的 gui_input（和真机触摸同一条路）
func _click(node) -> void:
	if node == null or not is_instance_valid(node):
		problems.append("点了个空控件")
		return
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = node.get_global_rect().get_center()
	node.gui_input.emit(ev)
	await process_frame
	if not is_instance_valid(node):
		return
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.pressed = false
	up.position = ev.position
	node.gui_input.emit(up)
	await process_frame
