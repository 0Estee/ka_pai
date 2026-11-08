## 二级页面自检：设置 / 回放 / 联机 + 对局回放态
##
## 检查什么：
##   设置页 —— 点药丸真的落盘（user://settings.cfg）、重开能读回、恢复默认好用；
##   回放   —— 打完一局存一份，列表能列出来，重放同一份得到同一结果（胜者/回合/出牌数）；
##   联机   —— 页面能把本机地址亮出来，端口/按钮齐全，返回能关页；
##   对局回放态 —— KPBattle 在 replay_mode 下横幅写明「回放中」，且不接受出牌输入。
##
## 用法：
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/ui_pages.gd
extends SceneTree

const SET := preload("res://scripts/ui/kp_settings.gd")
const REPLAY := preload("res://scripts/ui/kp_replay.gd")
const PAGE_SET := preload("res://scripts/ui/kp_settings_page.gd")
const PAGE_REPLAY := preload("res://scripts/ui/kp_replay_page.gd")
const PAGE_ONLINE := preload("res://scripts/ui/kp_online_page.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

var problems: Array = []
var checks := 0


func _initialize() -> void:
	await process_frame
	await _check_settings()
	await _check_online()
	await _check_replay()
	if problems.is_empty():
		print("[ui_pages] checks=%d problems=0" % checks)
		quit(0)
	else:
		for p in problems:
			print("  PROBLEM %s" % p)
		print("[ui_pages] checks=%d problems=%d" % [checks, problems.size()])
		quit(1)


func _expect(ok: bool, msg: String) -> void:
	checks += 1
	if not ok:
		problems.append(msg)


# ── 设置页 ───────────────────────────────────────────────────────────────────

func _check_settings() -> void:
	print("== 设置页")
	SET.reset()
	var page = PAGE_SET.new()
	page.anim = 0.0
	root.add_child(page)
	page.size = page.DESIGN
	page._fit()
	await process_frame

	_expect(page._pills_fx.size() == 3, "特效应有 3 档，实得 %d" % page._pills_fx.size())
	_expect(page._pills_anim.size() == 3, "动画速度应有 3 档，实得 %d" % page._pills_anim.size())
	_expect(page._pills_pace.size() == 3, "AI 停顿应有 3 档，实得 %d" % page._pills_pace.size())
	_expect(page._pills_diff.size() == DATA.difficulties().size(), "难度药丸数应等于难度数")
	_expect(page._pills_deck.size() == 3, "牌库应有 3 档")

	# 点「光球特效 = 关」
	await _click(page._pills_fx[0])
	_expect(SET.fx_level() == 0, "点「关」后 fx_level 应 0，实得 %d" % SET.fx_level())
	if page._orb != null and is_instance_valid(page._orb):
		_expect(page._orb.fx_level == 0, "页面小光球应跟着关特效，实得 %d" % page._orb.fx_level)

	# 点「动画速度 = 快」
	await _click(page._pills_anim[2])
	_expect(SET.anim_speed() == 2, "动画速度应 2，实得 %d" % SET.anim_speed())
	_expect(absf(page.anim - 0.7) < 0.001, "页面 anim 应变成 0.7，实得 %.2f" % page.anim)

	# 点「AI 停顿 = 无」
	await _click(page._pills_pace[0])
	_expect(SET.get_int(SET.AI_PACE) == 0, "AI 停顿应 0，实得 %d" % SET.get_int(SET.AI_PACE))

	# 点「难度 = 第三档之前找 hard」
	var dk := ""
	var ds: Array = DATA.difficulties()
	for i in ds.size():
		if str(ds[i].key) == "hard":
			dk = "hard"
			await _click(page._pills_diff[i])
	_expect(dk == "hard", "难度表里应有 hard")
	_expect(SET.difficulty() == "hard", "难度应落成 hard，实得 %s" % SET.difficulty())

	# 点「牌库 = 100」
	await _click(page._pills_deck[2])
	_expect(SET.deck_size() == 100, "牌库应 100，实得 %d" % SET.deck_size())

	# 落盘了没有：磁盘文件真的存在且写了值
	var cfg_path := ProjectSettings.globalize_path(SET.PATH)
	var f := FileAccess.open(SET.PATH, FileAccess.READ)
	_expect(f != null, "设置文件没写出来：%s" % cfg_path)
	var txt := "" if f == null else f.get_as_text()
	if f != null:
		f.close()
	_expect(txt.contains("fx_level=0"), "文件里应有 fx_level=0：%s" % txt.replace("\n", " "))
	_expect(txt.contains("difficulty=\"hard\""), "文件里应有 difficulty=hard")

	# 假装重开应用：清掉内存缓存，从磁盘读回
	SET._loaded = false
	SET._data = {}
	_expect(SET.fx_level() == 0, "重读后 fx_level 应 0，实得 %d" % SET.fx_level())
	_expect(SET.difficulty() == "hard", "重读后难度应 hard，实得 %s" % SET.difficulty())
	_expect(SET.deck_size() == 100, "重读后牌库应 100，实得 %d" % SET.deck_size())

	# 恢复默认
	page._on_reset()
	_expect(SET.fx_level() == 2, "恢复默认后特效应 2，实得 %d" % SET.fx_level())
	_expect(SET.difficulty() == "normal", "恢复默认后难度应 normal，实得 %s" % SET.difficulty())
	_expect(SET.anim_speed() == 1, "恢复默认后动画应 1")
	_expect(SET.deck_size() == 80, "恢复默认后牌库应 80")
	print("  设置页 OK：药丸 %d 个 · 落盘 %s" % [page._pills_fx.size() + page._pills_anim.size() + page._pills_pace.size() + page._pills_diff.size() + page._pills_deck.size(), cfg_path])

	page.queue_free()
	await process_frame


# ── 联机页 ───────────────────────────────────────────────────────────────────

func _check_online() -> void:
	print("== 联机页")
	var page = PAGE_ONLINE.new()
	page.anim = 0.0
	root.add_child(page)
	page.size = page.DESIGN
	page._fit()
	await process_frame

	var addrs: Array = page._local_addresses()
	_expect(addrs.size() >= 1, "应该能拿到至少一个局域网地址（拿到 %d 个）" % addrs.size())
	if addrs.size() > 0:
		_expect(str(addrs[0]).contains("."), "地址应像 IPv4：%s" % str(addrs[0]))
	_expect(page._addr_label != null and str(page._addr_label.text) != "", "本机地址那一行不能是空的")
	_expect(str(page.crumb_text) != "", "联机页应有副标题")
	_expect(page.PORT == 7842, "端口应为 7842")

	# 「复制地址」不该崩（无头下剪贴板可能不可用，这里只看不报错）
	page._on_copy()
	_expect(page._paste_note != null and str(page._paste_note.text) != "", "复制后应有提示")
	# 「刷新」也不该崩
	page._on_refresh()

	# 返回按钮能关页
	var closed := [0]
	page.close_requested.connect(func(): closed[0] += 1)
	var back = _find_back(page)
	if back != null:
		await _click(back)
	_expect(closed[0] == 1, "点返回应发 1 次 close_requested，实得 %d" % closed[0])
	print("  联机页 OK：地址 %s · 端口 %d" % [str(page._addr_label.text), page.PORT])

	page.queue_free()
	await process_frame


func _find_back(page):
	if page == null or page._frame == null:
		return null
	for c in page._frame.get_children():
		if c is Control and c.position == Vector2(24, 30):
			return c
	return null


# ── 回放：录制 → 落盘 → 列表 → 重放同结果 ─────────────────────────────────────

func _check_replay() -> void:
	print("== 回放")
	var before := REPLAY.count()

	var sess = KPSession.new()
	sess.pace = 0.0
	var cfg := {
		"seed": 3001,
		"difficulty": "normal",
		"humanFaction": "sword",
		"aiFaction": "frost",
		"deckSize": 60,
		"humanSide": 0,
	}
	await sess.start(cfg)
	var played := await _drive(sess)
	_expect(sess.is_over(), "直播那一局应走到终局")
	_expect(not sess.record.is_empty(), "应记下动作序列，实得 %d 条" % sess.record.size())
	var live: Dictionary = sess.game.state
	var live_winner = live.get("winner", null)
	var rec: Dictionary = sess.make_record()
	_expect(int(rec.get("seed", 0)) == 3001, "记录里的种子应 3001")
	_expect(rec.get("actions", []).size() == sess.record.size(), "记录动作数应与录制数一致")
	_expect(rec.get("result", {}).get("winner", null) != null or live_winner == null, "记录里应带结果")

	var path := REPLAY.save(rec)
	_expect(path != "", "回放没写进 user://replays")
	_expect(REPLAY.count() == before + 1, "落盘后回放数应 +1（%d → %d）" % [before, REPLAY.count()])
	var all: Array = REPLAY.list()
	_expect(all.size() > 0, "列表应为空")
	var head := ""
	var det := ""
	if all.size() > 0:
		_expect(int(all[0].rec.get("seed", 0)) == 3001, "最新一份应是刚才那局，实得种子 %d" % int(all[0].rec.get("seed", 0)))
		head = REPLAY.headline(all[0].rec)
		det = REPLAY.detail(all[0].rec)
		_expect(head.contains("种子 3001"), "摘要应写明种子：%s" % head)
		_expect(det.contains("我方"), "详情应写明阵营：%s" % det)

	# 回放页能列出来
	var page = PAGE_REPLAY.new()
	page.anim = 0.0
	root.add_child(page)
	page.size = page.DESIGN
	page._fit()
	await process_frame
	_expect(page.row_count() >= 1, "回放页应至少列出 1 行，实得 %d" % page.row_count())
	page.queue_free()
	await process_frame

	# 重放：同种子同动作 ⇒ 同结果
	var sess2 = KPSession.new()
	sess2.start_replay(rec)
	var frames := 0
	while not sess2.is_over() and frames < 6000:
		frames += 1
		await process_frame
	_expect(sess2.is_over(), "重放应走到终局（跑了 %d 帧，阶段 %s）" % [frames, str(sess2.game.state.get("phase", "?"))])
	_expect(sess2.replay_mode, "重放会话应标 replay_mode")
	_expect(sess2.record.is_empty(), "重放不该再录一遍，实得 %d 条" % sess2.record.size())
	var st2: Dictionary = sess2.game.state
	_expect(st2.get("winner", null) == live_winner, "重放胜者应与直播一致（直播 %s / 重放 %s）" % [str(live_winner), str(st2.get("winner", null))])
	_expect(str(st2.get("winReason", "")) == str(live.get("winReason", "")), "重放胜因应一致")
	_expect(int(st2.get("turn", 0)) == int(live.get("turn", 0)), "重放回合应一致（%d / %d）" % [int(st2.get("turn", 0)), int(live.get("turn", 0))])
	_expect(int(st2.get("cardsPlayed", 0)) == int(live.get("cardsPlayed", 0)), "重放出牌数应一致")

	# 对局屏在回放态：横幅写「回放中」，出牌按钮换成「退出回放」，点手牌不出牌
	var sess3 = KPSession.new()
	var battle = KPBattle.new()
	battle.session = sess3
	battle.anim = 0.0
	root.add_child(battle)
	await process_frame
	sess3.start_replay(rec)
	for i in 6:
		await process_frame
	_expect(battle._replay(), "KPBattle 应认出这是回放")
	var banner_text := _collect_text(battle._banner)
	_expect(banner_text.contains("回放"), "回放态横幅应写「回放中」，实得「%s」" % banner_text)
	var action_text := _collect_text(battle._action)
	_expect(action_text.contains("退出回放"), "回放态行动区应有「退出回放」，实得「%s」" % action_text)
	var hand_iid := -1
	var hand: Array = sess3.my_hand()
	if hand.size() > 0:
		hand_iid = int(hand[0].iid)
	var n_before: int = int(sess3.game.state.log.size())
	if hand_iid >= 0:
		battle._on_card_click(hand_iid)
		await process_frame
	_expect(int(sess3.game.state.log.size()) == n_before, "回放态点手牌不该推进引擎")
	while not sess3.is_over() and frames < 6000:
		frames += 1
		await process_frame
	_expect(sess3.is_over(), "带界面的重放也应走到终局")
	battle.queue_free()
	await process_frame
	print("  回放 OK：直播 %d 手 · 重放 %d 手 · 摘要「%s」" % [played, rec.get("actions", []).size(), head])

	REPLAY.remove(path)
	await process_frame


## 直播一局：轮到自己就出一张能出的牌，没牌可出就结束阶段，挂起就选第一个
func _drive(sess) -> int:
	var steps := 0
	var plays := 0
	var idle := 0
	while not sess.is_over() and steps < 4000:
		steps += 1
		await process_frame
		if sess.game == null:
			continue
		var pending = sess.pending()
		if pending != null:
			idle = 0
			var opts: Array = pending.get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
			continue
		if sess.busy:
			idle = 0
			continue
		if not sess.is_my_turn():
			idle += 1
			if idle > 800:
				break
			await create_timer(0.004).timeout
			continue
		idle = 0
		var legal: Array = sess.legal_plays()
		if legal.is_empty():
			sess.end_phase()
			continue
		var pick: Dictionary = legal[plays % legal.size()]
		var opts2: Dictionary = {}
		var places: Array = pick.get("places", [])
		if places.size() > 0 and places[0] != null:
			opts2 = {"lane": places[0].lane, "row": places[0].row}
		sess.play_card(int(pick.iid), opts2)
		plays += 1
	return plays


func _collect_text(node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	var out := ""
	if node is Label or node is Button:
		out += str(node.text) + " "
	for c in node.get_children():
		out += _collect_text(c)
	return out


## 真点：走控件自己的 gui_input
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
