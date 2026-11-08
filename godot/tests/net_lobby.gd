## 联机大厅自检（第 18 条）：真页面 + 真 KPNet + 假服务器（tools/room-mock.mjs）。
##
## 跑法：spawn mock 到 8797，然后
##   node tools/godot.mjs --headless --path godot --script res://tests/net_lobby.gd
extends SceneTree

const NET := preload("res://scripts/ui/kp_net.gd")
const PAGEO := preload("res://scripts/ui/kp_online_page.gd")
const BATTLE := preload("res://scripts/ui/kp_battle.gd")
const SET := preload("res://scripts/ui/kp_settings.gd")

var base := "http://127.0.0.1:8797"
var checks := 0
var problems: Array = []


func _initialize() -> void:
	for a in OS.get_cmdline_user_args():
		if str(a).begins_with("--base="):
			base = str(a).substr(7)
	var t0 := Time.get_ticks_msec()
	var old_base := SET.cloud_base()
	SET.set_v("cloud_base", base)

	# ── 房主：创建房间 ──
	var hn = NET.new()
	var hp = PAGEO.new()
	hp.net = hn
	root.add_child(hn)
	root.add_child(hp)
	await _frames(4)
	hp.size = hp.DESIGN
	hp._fit()
	_check(hp._view == "form", "进联机页先看到表单")
	_check(hp._nick_edit != null and hp._code_edit != null, "表单有昵称与房号两栏")
	_check(hp._srv_edit != null and str(hp._srv_edit.text).begins_with("http"), "表单里服务器地址预填")

	hp._nick_edit.text = "甲"
	hp._srv_edit.text = base
	hp._do_create()
	await _frames(6)
	_check(hp._view == "lobby", "创建房间后切到房间视图")
	_check(str(hp._code).length() == 6, "房号是 6 位（实得 %d）" % str(hp._code).length())
	_check(str(hp._code).to_upper() == str(hp._code), "房号是大写字母数字")
	print("[lobby] 房间号 %s" % str(hp._code))

	# ── 客人：加入同一间房 ──
	var gn = NET.new()
	var gp = PAGEO.new()
	gp.net = gn
	root.add_child(gn)
	root.add_child(gp)
	await _frames(4)
	gp.size = gp.DESIGN
	gp._fit()
	gp._nick_edit.text = "乙"
	gp._srv_edit.text = base
	gp._code_edit.text = str(hp._code)
	gp._do_join()
	await _frames(6)
	_check(gp._view == "lobby", "加入房间后也切到房间视图")

	# ── 互相看见 ──
	var seen := await _wait_until(func(): return hp._peer_ready and gp._peer_ready, 900)
	_check(seen, "两端互相看见对手（房主 %s / 客人 %s）" % [str(hp._peer), str(gp._peer)])
	_check(hp._peer.contains("乙") or gp._peer.contains("甲"), "对手名字传过去了：%s / %s" % [str(hp._peer), str(gp._peer)])
	_check(hp._peer_ready and gp._peer_ready, "两端都进入可开局状态")

	# 房主的开局按钮此时应可用
	var start_btn_ok := _find_enabled_button(hp, "开 始 对 局")
	_check(start_btn_ok, "有对手之后房主的「开始对局」可点")

	# ── 开局 ──
	hp._do_start()
	var up := await _wait_until(func():
		return hn.session != null and gn.session != null and hn.started and gn.started, 1200)
	_check(up, "两端都建起了会话")
	if up:
		var hs: Dictionary = hn.session.game.state
		var gs: Dictionary = gn.session.game.state
		_check(int(hs.get("seed", 0)) == int(gs.get("seed", 0)) and int(hs.get("seed", 0)) > 0, "两端同一颗种子 %d/%d" % [int(hs.get("seed", 0)), int(gs.get("seed", 0))])
		_check(int(hn.session.human_side) == 0 and int(gn.session.human_side) == 1, "座位：房主 0 / 客人 1")
		_check(hs.players[0].hand.size() == gs.players[0].hand.size(), "双方手牌数一致 %d/%d" % [hs.players[0].hand.size(), gs.players[0].hand.size()])
		_check(int(hs.get("turn", 0)) == int(gs.get("turn", 0)), "回合数一致 %d/%d" % [int(hs.get("turn", 0)), int(gs.get("turn", 0))])
		var h1: String = NET.state_hash(hs)
		var h2: String = NET.state_hash(gs)
		print("[lobby] 开局指纹 %s / %s" % [h1, h2])
		# 房主开局后会自己推一步自动阶段，所以允许先后差一步，比流水
		# 对齐 = 两端步数相同、都至少走了一步、且两边队列都空（没有在途操作）
		var same := [false]
		var i := 0
		while i < 900:
			i += 1
			if hn.step == gn.step and hn.step >= 1 and hn._queue.is_empty() and gn._queue.is_empty():
				var a1: String = NET.state_hash(hn.session.game.state)
				var a2: String = NET.state_hash(gn.session.game.state)
				if a1 == a2:
					same[0] = true
					break
			await process_frame
		_check(same[0], "对齐后状态指纹一致（%d/%d 步）" % [int(hn.step), int(gn.step)])

	# ── 对局屏：轮到对手答的时候只显示等待 ──
	var b = BATTLE.new()
	b.session = gn.session
	b.online = true
	b.anim = 0.0
	root.add_child(b)
	await _frames(4)
	b.size = b.DESIGN
	b._fit()
	await _frames(4)
	var before_wait: int = b._overlay.get_child_count()
	b._build_choice({"side": 0, "type": "chooseUnit", "prompt": "挑一个单位", "options": [{"label": "甲"}, {"label": "乙"}]})
	var wait_labels := _labels_with(b._overlay, "等 待 对 手 选 择")
	_check(wait_labels > 0, "对手侧的提问显示「等待对手选择」")
	_check(_button_count(b._overlay) == 0, "等待时不给任何可点选项")
	var after_wait: int = b._overlay.get_child_count()
	# 自己的提问照旧给选项
	b._build_choice({"side": 1, "type": "chooseUnit", "prompt": "挑一个单位", "options": [{"label": "甲"}, {"label": "乙"}]})
	_check(_button_count(b._overlay) >= 2, "自己侧的提问照常给选项（实得 %d）" % _button_count(b._overlay))
	print("[lobby] 等待面板子节点 %d → %d" % [before_wait, after_wait])
	root.remove_child(b)
	b.queue_free()
	await _frames(2)

	# ── 对手离开 ──
	var left_seen := [false]
	hn.sig_left.connect(func(): left_seen[0] = true)
	gp._do_leave()
	var got_left := await _wait_until(func(): return left_seen[0], 900)
	_check(got_left, "对手离开后房主收到提示")
	_check(not hp._peer_ready, "对手离开后房主回到「等人」状态")

	# 收尾
	hp._do_leave()
	await _frames(4)
	SET.set_v("cloud_base", old_base)
	root.remove_child(hp)
	hp.queue_free()
	root.remove_child(gp)
	gp.queue_free()
	await _frames(4)
	if is_instance_valid(hn):
		hn.queue_free()
	if is_instance_valid(gn):
		gn.queue_free()
	print("[lobby] 完成，用时 %d ms" % (Time.get_ticks_msec() - t0))
	print("[lobby] checks=%d problems=%d" % [checks, problems.size()])
	for p in problems:
		print("[lobby] PROBLEM %s" % str(p))
	quit(1 if problems.size() > 0 else 0)


func _check(ok: bool, what: String) -> void:
	checks += 1
	if not ok:
		problems.append(what)


func _frames(n: int) -> void:
	for i in n:
		await process_frame


func _wait_until(cond: Callable, max_frames: int) -> bool:
	var i := 0
	while i < max_frames:
		if bool(cond.call()):
			return true
		i += 1
		await process_frame
	return bool(cond.call())


func _find_enabled_button(page: Control, text: String) -> bool:
	for c in page.body.get_children():
		if c is Button and str(c.text) == text and not c.disabled:
			return true
	return false


func _labels_with(node: Node, text: String) -> int:
	var n := 0
	if node is Label and str(node.text).contains(text):
		n += 1
	for c in node.get_children():
		n += _labels_with(c, text)
	return n


func _button_count(node: Node) -> int:
	var n := 0
	if node is Button:
		n += 1
	for c in node.get_children():
		n += _button_count(c)
	return n
