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
	_expect(home._items.size() == 4, "一级应有 4 项，实得 %d" % home._items.size())
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
	_expect(home._items.size() == 14, "阵营层应有 14 项，实得 %d" % home._items.size())
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

	# 种子层
	await _click(_find("level", "seed"))
	await _wait_ready(300)
	_expect(home._items.size() == 4, "种子层应 4 项，实得 %d" % home._items.size())
	_report_ring("种子层", 226.0)
	await _click(_find("pick_seed", "1001"))
	await _wait_ready(400)
	_expect(home._seed_v == 1001, "种子应为 1001，实得 %d" % home._seed_v)

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
		_expect(int(cfg.get("seed", -1)) == 1001, "种子应传 1001，实得 %s" % str(cfg.get("seed")))
		_expect(str(cfg.get("difficulty", "")) == "hard", "难度应传 hard")
		_expect(str(cfg.get("humanFaction", "")) == "sword", "人方阵营应传 sword")
		_expect(str(cfg.get("aiFaction", "")) != "sword", "对手阵营不该和玩家一样")
		_expect(int(cfg.get("deckSize", 0)) == 80, "牌库应 80 张")
		_expect(int(cfg.get("humanSide", -1)) == 0, "人类应坐 0 号位")

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
