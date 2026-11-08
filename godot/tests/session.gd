## 界面会话层（scripts/ui/kp_session.gd）的回归测试
##
## 干什么：
##   不开窗口、不画界面，只用 KPSession 打完整局 —— 模拟一个「乱点的玩家」：
##   轮到自己就出一张能出的牌，没牌可出就结束阶段；引擎挂起提问就选第一个选项。
##   要求每局都能走到终局、不卡在挂起、不报错。
##
## 为什么值得单独测：
##   界面（kp_battle.gd）只是把 KPSession 的状态画出来，真正会「卡死」的是这一层：
##   协程没有推进、提问没人答、AI 回合结束后没有 advance —— 这些在无头模式里
##   能立刻暴露，比开窗口点半天快得多。
##
## 用法：
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/session.gd
extends SceneTree

const KPSession := preload("res://scripts/ui/kp_session.gd")

const SEEDS := [2001, 2002, 2003, 2004, 2005, 2006]

var failures := 0


func _initialize() -> void:
	_run_all()


func _run_all() -> void:
	print("── 会话层：%d 局（人类侧自动乱点） ──" % SEEDS.size())
	var t0 := Time.get_ticks_msec()
	for seed_v in SEEDS:
		await _run_one(int(seed_v))
	print("── 完成，用时 %d ms，失败 %d 局 ──" % [Time.get_ticks_msec() - t0, failures])
	quit(1 if failures > 0 else 0)


func _run_one(seed_v: int) -> void:
	var sess := KPSession.new()
	sess.pace = 0.0
	await sess.start({
		"seed": seed_v,
		"difficulty": "normal",
		"humanFaction": "demon" if seed_v % 2 == 0 else "",
		"aiFaction": "frost" if seed_v % 3 == 0 else "",
	})

	var steps := 0
	var plays := 0
	var questions := 0
	var idle := 0
	while not sess.is_over() and steps < 4000:
		steps += 1
		await process_frame
		if sess.game == null:
			continue
		var pending = sess.pending()
		if pending != null:
			questions += 1
			idle = 0
			var opts: Array = pending.get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
			continue
		if sess.busy:
			idle = 0
			continue
		if not sess.is_my_turn():
			idle += 1
			if idle > 600:
				break
			await create_timer(0.005).timeout
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
		# 注意：不能 await，否则引擎在里面挂起提问时没人能回答（界面也是这个道理）
		sess.play_card(int(pick.iid), opts2)
		plays += 1

	var st: Dictionary = sess.game.state
	var ok_end: bool = sess.is_over()
	if not ok_end:
		failures += 1
		print("✗ seed=%d 没走到终局（%d 步 / %d 次出牌 / %d 次提问，阶段 %s）" % [
			seed_v, steps, plays, questions, str(st.get("phase", "?"))])
	else:
		print("✓ seed=%d 回合 %d · 出牌 %d · 提问 %d · 胜者 %s（%s）" % [
			seed_v, int(st.turn), plays, questions, str(st.get("winner", "?")), str(st.get("winReason", ""))])
