## AI 移植（scripts/ai/kp_ai.gd）的回归测试
##
## 干什么：
##   把 app/js/ai.js 的 5 档难度各自装到 Godot 引擎上，AI 对 AI 打完整局，
##   要求：每局都能走到终局（winner 非 null）、不卡在问答挂起、不在中途报错。
##
## 为什么值得这么做：
##   规则引擎有 parity.gd（与 JS 逐字节对拍）守；AI 是启发式代码，抄错一个权重
##   不会崩，只会变蠢 —— 唯一能自动发现"崩了/卡死"的方式就是真的让它下完。
##   AI 又是手机端唯一能陪练的对手，它下不完一局，游戏就没法玩。
##
## 用法：
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/ai.gd
extends SceneTree

const KPGame := preload("res://scripts/engine/kp_game.gd")
const KPAi := preload("res://scripts/ai/kp_ai.gd")
const KPRng := preload("res://scripts/engine/kp_rng.gd")

const DECK_SIZE := 80
const MAX_STEPS := 900

var _lib := {}
var _failures := 0
var _games := 0


func _initialize() -> void:
	_lib = _load_lib()
	_run_all()


func _load_lib() -> Dictionary:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://data/cards.json"))
	var lib := {}
	for c in data["cards"]:
		lib[str(c["id"])] = c
	return lib


# ── 牌库：与 engine/cards/test-cards.js 的 buildTestDeck 同算法 ──────────────
## Math.imul 的 32 位截断乘法（GDScript 的 int 是 64 位，直接乘会溢出）
func _imul32(a: int, b: int) -> int:
	var lo: int = (a & 0xFFFF) * b
	var hi: int = ((a >> 16) & 0xFFFF) * b
	return ((hi << 16) + lo) & 0xFFFFFFFF


## 与 test-cards.js 的 mixSeed 逐位相同：xorshift 用相邻种子初始化时头几个
## 输出高度相关，而 Fisher-Yates 的头几轮决定被切掉的尾部卡牌。
func _mix_seed(x: int) -> int:
	var v: int = x & 0xFFFFFFFF
	if v == 0:
		v = 0x9e3779b9
	for i in 2:
		v = _imul32(v ^ (v >> 16), 0x45d9f3b)
	return (v ^ (v >> 16)) & 0xFFFFFFFF


func _make_deck(size: int, seed: int) -> Array:
	var pool: Array = []
	for id in _lib:
		var c: Dictionary = _lib[id]
		if bool(c.get("token", false)):
			continue
		if c.get("faction", null) != null:
			continue
		pool.append(str(id))
	if pool.is_empty():
		return []
	pool.sort()
	var rng = KPRng.new(_mix_seed(seed))
	rng.shuffle(pool)
	var deck: Array = []
	while deck.size() < size:
		deck.append(pool[deck.size() % pool.size()])
	return deck.slice(0, size)


# ── 跑一局 AI 对 AI ────────────────────────────────────────────────────────
func _run_game(key0: String, key1: String, seed: int) -> Dictionary:
	var g = KPGame.create({
		"seed": seed,
		"firstPlayer": seed % 2,
		"deck": _make_deck(DECK_SIZE, seed),
		"cardLib": _lib,
	})
	g.state["humanSide"] = -1
	g.state["autoResolveChoices"] = true
	g.state["aiSides"] = [0, 1]

	var keys: Array = [key0, key1]
	var ais: Array = []
	for s in 2:
		ais.append(KPAi.new(g, keys[s], {}))

	await g.start_game()
	for s in 2:
		ais[s].apply_difficulty_bonus(s, keys[s])
		ais[s].install_target_picker()

	var steps := 0
	var plays := 0
	while not g.is_over() and steps < MAX_STEPS:
		steps += 1
		if g.has_pending():
			return {
				"ok": false,
				"why": "挂起未答 type=%s" % str(g.pending_request.get("type", "?")),
				"steps": steps,
			}
		var actor = g.get_actor()
		if actor == null:
			await g.advance()
			continue
		var res: Dictionary = await ais[int(actor)].take_turn(int(actor))
		plays += int(res.get("count", 0))
		await g.advance()

	if not g.is_over():
		return {"ok": false, "why": "打了 %d 步还没终局" % steps, "steps": steps}

	var winner = g.state.get("winner", null)
	if winner == null:
		return {"ok": false, "why": "is_over 但 winner 为空", "steps": steps}

	return {
		"ok": true,
		"steps": steps,
		"plays": plays,
		"winner": int(winner),
		"turn": int(g.state["turn"]),
		"reason": str(g.state.get("winReason", "")),
		"hp": "%s vs %s" % [
			_trim(float(g.state["players"][0]["kingHp"])),
			_trim(float(g.state["players"][1]["kingHp"])),
		],
	}


func _trim(v: float) -> String:
	if absf(v - roundf(v)) < 0.005:
		return "%d" % int(roundf(v))
	return "%.1f" % v


# ── 主流程：5 档难度各打若干局 ─────────────────────────────────────────────
const PLAN := [
	{"key": "easy", "games": 3, "first": 2001},
	{"key": "normal", "games": 3, "first": 2101},
	{"key": "hard", "games": 3, "first": 2201},
	{"key": "nightmare", "games": 2, "first": 2301},
	{"key": "impossible", "games": 1, "first": 2401},
]


# ── 第二阶段：难度阶梯（高难度该赢低难度）─────────────────────────────────
## 只证明"能下完"是不够的：一个所有档位都乱下的 AI 也能全通。
## 这一阶段让高档位对 easy 打几局，胜率应明显高于 50%，否则说明移植后的
## 评分/推演其实没起作用（比如 bonus 没加上、rollout 恒返回同一手）。
const LADDER := [
	{"strong": "hard", "first": 3001},
	{"strong": "nightmare", "first": 3101},
	{"strong": "impossible", "first": 3201},
]


func _run_ladder() -> void:
	print("")
	print("════ 难度阶梯：高档位 vs easy（每档 4 局，轮流先手）════")
	for step in LADDER:
		var strong := str(step.strong)
		var wins := 0
		var games := 0
		var t0 := Time.get_ticks_msec()
		for i in 4:
			var seed := int(step.first) + i
			# 偶数局强档坐 0 号位，奇数局坐 1 号位 —— 先手优势会被摊平
			var strong_side := i % 2
			var keys: Array = ["easy", "easy"]
			keys[strong_side] = strong
			var r: Dictionary = await _run_game(str(keys[0]), str(keys[1]), seed)
			games += 1
			_games += 1
			if not bool(r.ok):
				_failures += 1
				print("  ✗ %s seed=%d %s" % [strong, seed, str(r.why)])
				continue
			if int(r.winner) == strong_side:
				wins += 1
		var ms := Time.get_ticks_msec() - t0
		var mark := "✓" if wins * 2 > games else "✗"
		if wins * 2 <= games:
			_failures += 1
		print("  %s %-10s 胜 %d/%d 用时 %dms" % [mark, strong, wins, games, ms])


func _run_all() -> void:
	print("")
	print("════ AI 移植回归：5 档难度 × AI 对 AI ════")
	print("牌库 %d 张，卡池 %d 张" % [DECK_SIZE, _lib.size()])

	for plan in PLAN:
		var key := str(plan.key)
		var n := int(plan.games)
		var base := int(plan.first)
		var params: Dictionary = KPAi.difficulty_by_key(key)
		print("")
		print("── %s（%d 局）passThreshold=%s jitter=%s planner=%s" % [
			key, n, str(params.get("passThreshold", "")), str(params.get("jitter", "")),
			str(params.get("planner", "无")),
		])
		for i in n:
			var seed := base + i
			var t0 := Time.get_ticks_msec()
			var r: Dictionary = await _run_game(key, key, seed)
			var ms := Time.get_ticks_msec() - t0
			_games += 1
			if bool(r.ok):
				print("  ✓ seed=%d %d 步 %d 张出手 胜者%d T%d 国王 %s 用时 %dms" % [
					seed, int(r.steps), int(r.plays), int(r.winner), int(r.turn),
					str(r.hp), ms,
				])
			else:
				_failures += 1
				print("  ✗ seed=%d %s（%d 步，%dms）" % [seed, str(r.why), int(r.steps), ms])

	await _run_ladder()

	print("")
	if _failures == 0:
		print("✅ 全部 %d 局终局，0 失败" % _games)
	else:
		print("❌ %d/%d 局失败" % [_failures, _games])
	quit(1 if _failures > 0 else 0)
