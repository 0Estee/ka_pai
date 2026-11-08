## 联机锁步自检（作者 m01990 第 18 条）。
##
## 联机不传棋盘，只传操作；两端各跑一遍引擎。所以「能不能联机」等价于
## 「同一串操作喂给两个不同座位的会话，是否始终得到同一个棋盘」。
## 这个脚本就在一个进程里造两个 KPSession（一个当房主 side 0、一个当客人 side 1），
## 把同一串操作同时喂给两边，每步比对状态指纹，直到双方都终局。
##
## 全程不碰网络：网络层（kp_room/kp_net）另有 tests/net_wire.gd 用本地假服务器跑。
extends SceneTree

const NET := preload("res://scripts/ui/kp_net.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")
const KPForge := preload("res://scripts/ui/kp_forge.gd")

var checks := 0
var problems := 0


class FakeNet:
	var my_side := 0
	var submits: Array = []

	func submit(a: Dictionary) -> bool:
		submits.append(a)
		return true

	func submit_nowait(a: Dictionary) -> void:
		submits.append(a)


func _initialize() -> void:
	_run()


func _fail(msg: String) -> void:
	problems += 1
	print("[net] PROBLEM ", msg)


func _ok(cond: bool, msg: String) -> void:
	checks += 1
	if not cond:
		_fail(msg)


func _answer_for(req: Dictionary) -> Variant:
	var choose = req.get("choose", null)
	if choose != null and choose is Callable:
		var picked = choose.call()
		if picked != null:
			return picked
	var opts: Array = req.get("options", [])
	return opts[0] if not opts.is_empty() else {}


func _make_session(side: int, cfg: Dictionary) -> KPSession:
	var s := KPSession.new()
	var f := FakeNet.new()
	f.my_side = side
	s.net = f
	s.pace = 0.0
	s.combat_line_pause = 0.0
	s.start(cfg)
	return s


func _play_one(seed_v: int, deck_n: int, factions: Array, enhance: Array) -> void:
	var cfg := {
		"seed": seed_v,
		"firstPlayer": seed_v % 2,
		"deck": DATA.build_deck(deck_n, seed_v),
		"factions": factions,
		"enhance": enhance,
		"hostFaction": factions[0],
		"guestFaction": factions[1],
		"pace": 0.0,
	}
	var a: KPSession = _make_session(0, cfg)
	var b: KPSession = _make_session(1, cfg)
	await a.game.start_game() if false else null
	var sa = a.game
	var sb = b.game
	_ok(NET.state_hash(sa.state) == NET.state_hash(sb.state), "seed %d 开局指纹应一致" % seed_v)

	var steps := 0
	var play_i := 0
	while steps < 3000:
		var act := {}
		if sa.has_pending():
			var req: Dictionary = sa.pending_request
			act = {"k": "c", "v": _answer_for(req)}
		else:
			var actor = sa.get_actor()
			if actor == null:
				act = {"k": "a"}
			else:
				var plays: Array = sa.get_legal_plays(int(actor))
				if plays.is_empty():
					act = {"k": "a"}
				else:
					var pick: Dictionary = plays[(seed_v + play_i) % plays.size()]
					play_i += 1
					var opts := {}
					var places: Array = pick.get("places", [])
					if not places.is_empty() and places[0] is Dictionary:
						opts = {"lane": places[0].lane, "row": places[0].row}
					act = {"k": "p", "s": int(actor), "i": int(pick.iid), "o": opts}
		var ok_a: bool = await a.net_apply(act)
		var ok_b: bool = await b.net_apply(act)
		steps += 1
		if ok_a != ok_b:
			_fail("seed %d 第 %d 步两端执行结果不同：%s / %s（%s）" % [seed_v, steps, str(ok_a), str(ok_b), str(act)])
			break
		var ha := NET.state_hash(sa.state)
		var hb := NET.state_hash(sb.state)
		if ha != hb:
			_fail("seed %d 第 %d 步指纹分叉：%s vs %s（动作 %s）" % [seed_v, steps, ha, hb, str(act)])
			print("  sig A=", NET.state_signature(sa.state))
			print("  sig B=", NET.state_signature(sb.state))
			break
		if sa.is_over() and sb.is_over():
			break
	checks += 1
	var winner_a = sa.state.get("winner", null)
	var winner_b = sb.state.get("winner", null)
	if str(winner_a) != str(winner_b):
		_fail("seed %d 终局胜者不同：%s / %s" % [seed_v, str(winner_a), str(winner_b)])
	if not sa.is_over():
		_fail("seed %d 跑满 %d 步仍未终局" % [seed_v, steps])
	print("[net] seed=%d 步数=%d 胜者=%s 国王=%.0f/%.0f 指纹=%s" % [
		seed_v, steps, str(winner_a), float(sa.state.players[0].kingHp), float(sa.state.players[1].kingHp), NET.state_hash(sa.state)])


func _run() -> void:
	var t0 := Time.get_ticks_msec()
	# 种子 / 牌库 / 阵营 / 强化 各挑几种组合
	var cases := [
		[3001, 40, ["demon", "god"], []],
		[3002, 40, ["sword", "music"], []],
		[3003, 60, ["science", "divine"], []],
		[3004, 60, ["frost", "inferno"], []],
	]
	# 带强化的组合：双方各有一张 +攻 +血，验证增量表也走同一套
	var lib = DATA.lib()
	var enh := KPForge.build_enhance_pair(lib, {"gold": 0, "dust": 0, "forge": {"cards": {"U01": {"lvl": 4, "masteries": ["w_temper"]}}}}, {})
	cases.append([3005, 40, ["party", "flame"], enh])
	for c in cases:
		await _play_one(int(c[0]), int(c[1]), c[2], c[3])
	print("[net] 完成，用时 %d ms" % (Time.get_ticks_msec() - t0))
	print("[net] checks=%d problems=%d" % [checks, problems])
	quit(1 if problems > 0 else 0)
