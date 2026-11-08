## 联机端到端自检：两个 KPNet 连本地假服务器，真打一局（作者 m01990 第 18 条）。
##
## 覆盖：进房 hello / 房主开局 start / 锁步 act / 每 8 步指纹 hash / 自动阶段只房主推进 /
##       终局两边一致 / 对端离开。
## 跑法：先 node tools/room-mock.mjs --port 8798，再
##       node tools/godot.mjs --headless --path godot --script res://tests/net_wire.gd
extends SceneTree

const NET := preload("res://scripts/ui/kp_net.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

const PORT := 8798
var base := "http://127.0.0.1:%d" % PORT

var checks := 0
var problems := 0


func _initialize() -> void:
	_run()


func _fail(msg: String) -> void:
	problems += 1
	print("[net_wire] PROBLEM ", msg)


func _ok(cond: bool, msg: String) -> void:
	checks += 1
	if not cond:
		_fail(msg)


func _wait_frames(n: int) -> void:
	for i in n:
		await process_frame


func _wait_until(pred: Callable, max_frames: int, what: String) -> bool:
	var f := 0
	while f < max_frames:
		if pred.call():
			return true
		f += 1
		await process_frame
	_fail("等不到：%s（%d 帧）" % [what, max_frames])
	return false


func _answer_for(req: Dictionary) -> Variant:
	var choose = req.get("choose", null)
	if choose != null and choose is Callable:
		var picked = choose.call()
		if picked != null:
			return picked
	var opts: Array = req.get("options", [])
	return opts[0] if not opts.is_empty() else {}


func _drive(net) -> void:
	if net == null or net.session == null or net.conflict != "":
		return
	# 自检不需要演出节奏：把每步停顿与逐线等待都关掉（真实对局里由界面节奏控制）
	if net.session.combat_line_pause != 0.0:
		net.session.combat_line_pause = 0.0
	if net.session.pace != 0.0:
		net.session.pace = 0.0
	var game = net.session.game
	if game.is_over():
		return
	if net.session.busy:
		return
	if game.has_pending():
		var req: Dictionary = game.pending_request
		if int(req.get("side", net.my_side)) == int(net.my_side):
			net.session.answer_choice(_answer_for(req))
			await _wait_frames(2)
		return
	var actor = game.get_actor()
	if actor == null or int(actor) != int(net.my_side):
		return
	var plays: Array = game.get_legal_plays(int(actor))
	if plays.is_empty():
		await net.submit({"k": "a"})
		return
	var pick: Dictionary = plays[0]
	var opts := {}
	var places: Array = pick.get("places", [])
	if not places.is_empty() and places[0] is Dictionary:
		opts = {"lane": places[0].lane, "row": places[0].row}
	await net.submit({"k": "p", "s": int(net.my_side), "i": int(pick.iid), "o": opts})


func _run() -> void:
	var t0 := Time.get_ticks_msec()
	var host = NET.new()
	var guest = NET.new()
	root.add_child(host)
	root.add_child(guest)

	host.open("host", "NETW1", "甲方", base)
	host.debug_trace = true
	guest.debug_trace = true
	guest.open("guest", "NETW1", "乙方", base)
	await _wait_frames(3)
	host.hello()
	guest.hello()

	var got_peer := await _wait_until(func(): return guest.peer_name != "" and host.peer_name != "", 600, "双方互见")
	_ok(got_peer, "hello 应该让双方看到对手名字")
	if got_peer:
		_ok(guest.peer_name == "甲方" and host.peer_name == "乙方", "对手名字应为 甲方/乙方，实得 %s/%s" % [guest.peer_name, host.peer_name])

	var seed_v := 4101
	var factions := ["demon", "sword"]
	var deck: Array = []
	for c in DATA.build_deck(40, seed_v):
		deck.append(str(c))
	var cfg := {
		"r": 1,
		"seed": seed_v,
		"firstPlayer": seed_v % 2,
		"deck": deck,
		"factions": factions,
		"enhance": [],
		"mode": "normal",
		"hostFaction": factions[0],
		"guestFaction": factions[1],
	}
	host.begin(cfg)
	var both_started := await _wait_until(func(): return host.session != null and guest.session != null, 900, "双方开局")
	_ok(both_started, "房主 start 之后两边都应建好对局")
	if not both_started:
		_cleanup(host, guest)
		return

	_ok(host.started and guest.started, "两边 started 都应为 true")
	_ok(int(host.my_side) == 0 and int(guest.my_side) == 1, "座位：房主 0 / 客人 1")
	# 开局状态比对：等双方都建好局（各建各的，天生机理一致就应相同）
	var hm := NET.state_hash(host.session.game.state)
	var gm := NET.state_hash(guest.session.game.state)
	if hm != gm:
		# 允许「房主已自动推进到下一阶段」这种时间差：以操作流水第 1 条为准
		print("[net_wire] 开局瞬间不同（房主可能已先推进一步），以流水比对为准：", hm, " / ", gm)


	var frames := 0
	var t_start := Time.get_ticks_msec()
	while frames < 20000 and not (host.session.game.is_over() and guest.session.game.is_over()):
		await _drive(host)
		await _drive(guest)
		frames += 1
		if frames % 400 == 0:
			print("[net_wire] 帧=%d 回合=%d 阶段=%s 步=%d/%d 用时=%ds" % [
				frames, int(host.session.game.state.get("turn", 0)), str(host.session.game.state.get("phase", "")),
				int(host.step), int(guest.step), (Time.get_ticks_msec() - t_start) / 1000])
			if Time.get_ticks_msec() - t_start > 150000:
				_fail("跑太久，提前收工（步 %d/%d）" % [int(host.step), int(guest.step)])
				break
		await process_frame

	# 逐条比对两端的操作流水：步号、操作类型、执行后的状态指纹都必须一样
	var ht: Array = host.trace
	var gt: Array = guest.trace
	var common := mini(ht.size(), gt.size())
	var trace_bad := -1
	for i in common:
		if int(ht[i].n) != int(gt[i].n) or str(ht[i].k) != str(gt[i].k) or str(ht[i].h) != str(gt[i].h):
			trace_bad = i
			break
	_ok(trace_bad < 0, "两端操作流水应逐条一致（第 %d 条起不同）" % trace_bad)
	if trace_bad >= 0:
		print("  H:", str(ht.slice(maxi(0, trace_bad - 2), trace_bad + 2)))
		print("  G:", str(gt.slice(maxi(0, trace_bad - 2), trace_bad + 2)))

	var h1 = host.session.game.state
	var h2 = guest.session.game.state
	_ok(host.conflict == "" and guest.conflict == "", "不应出现指纹冲突：%s / %s" % [host.conflict, guest.conflict])
	_ok(host.session.game.is_over() and guest.session.game.is_over(), "两边都应走到终局（帧 %d）" % frames)
	_ok(NET.state_hash(h1) == NET.state_hash(h2), "终局指纹应一致")
	_ok(str(h1.get("winner", null)) == str(h2.get("winner", null)), "终局胜者应一致：%s / %s" % [str(h1.get("winner", null)), str(h2.get("winner", null))])
	_ok(int(h1.get("turn", 0)) == int(h2.get("turn", 0)), "终局回合应一致")
	print("[net_wire] 终局：步数=%d/%d 回合=%d 胜者=%s 指纹=%s" % [
		int(host.step), int(guest.step), int(h1.get("turn", 0)), str(h1.get("winner", null)), NET.state_hash(h1)])

	# 对端离开：客人走，房主应收到 sig_left
	var left := [false]
	host.sig_left.connect(func(): left[0] = true)
	guest.close("bye")
	var got_left := await _wait_until(func(): return left[0], 900, "房主收到对手离开")
	_ok(got_left, "客人离开后房主应收到 sig_left")

	_cleanup(host, guest)
	print("[net_wire] 完成，用时 %d ms" % (Time.get_ticks_msec() - t0))
	print("[net_wire] checks=%d problems=%d" % [checks, problems])
	quit(1 if problems > 0 else 0)


## 等两端步数一致、且都没有在途操作（界面上的「等对手」状态）
func _sync(host, guest, max_frames: int) -> bool:
	var f := 0
	while f < max_frames:
		var idle: bool = host._queue.is_empty() and guest._queue.is_empty()
		if int(host.step) == int(guest.step) and idle and host.session != null and guest.session != null:
			return true
		f += 1
		await process_frame
	return false


func _cleanup(host, guest) -> void:
	host.running = false
	guest.running = false
