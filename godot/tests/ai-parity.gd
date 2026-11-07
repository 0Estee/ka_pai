## AI 决策对拍：JS 版 AI ↔ GDScript 版 AI
##
## 干什么：
##   tools/parity/ai-run.mjs 用 app/js/ai.js 把整局打完，逐步记下状态摘要；
##   本脚本用 scripts/ai/kp_ai.gd 跑**同一局**（同种子、同牌库、同档位），
##   逐步比对摘要。全部一致 ⇒ 两边 AI 的决策序列完全相同。
##
## 为什么值得这么做：
##   ai.gd 的回归只能证明"下得完、高档位赢低档位"。评分权重抄错一个系数、
##   候选排序少一层、难度加成加错边 —— 这些都会照样下完，只是变蠢，
##   胜率看不出来。摘要对拍能精确到"第几步开始分叉"。
##
## ⚠ 不含 impossible 档：它用 Date.now() 做推演预算，跑两遍本来就不同。
##
## 用法：
##   node tools/parity/ai-run.mjs                       # 先生成 JS 侧数据
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/ai-parity.gd
extends SceneTree

const KPC := preload("res://scripts/engine/kp_constants.gd")
const KPGame := preload("res://scripts/engine/kp_game.gd")
const KPRng := preload("res://scripts/engine/kp_rng.gd")
const KPAi := preload("res://scripts/ai/kp_ai.gd")

const DIR := "res://data/parity"
const MAX_STEPS := 900

var _files := 0
var _steps := 0
var _failures := 0


func _initialize() -> void:
	_run_all()


func _s2(v: Variant) -> String:
	var n := float(v)
	if absf(n) < 0.005:
		n = 0.0
	return "%.2f" % n


func _digest(g: KPGame) -> String:
	var st: Dictionary = g.state
	var P: Array = st["players"]
	var out: Array[String] = []

	var actor: Variant = g.get_actor() if st.get("phase") != null else null
	out.append("T%d F%s A%s" % [
		int(st["turn"]),
		"-" if st.get("phase") == null else str(st["phase"]),
		"-" if actor == null else str(actor),
	])

	for side in [0, 1]:
		var p: Dictionary = P[side]
		out.append("P%d K%s/%s M%s/%s H%d SP%d" % [
			side, _s2(p["kingHp"]), _s2(p["kingMaxHp"]),
			_s2(p["mana"]), _s2(p["manaCap"]),
			(p["hand"] as Array).size(), (p["superpowers"] as Array).size(),
		])

	var pd := "-"
	if g.pending_request != null:
		pd = str(g.pending_request.get("type", "?"))
	out.append("DK%d DS%d CP%d PD%s" % [
		(st["deck"] as Array).size(), (st["discard"] as Array).size(),
		int(st["stats"]["cardsPlayed"]), pd,
	])

	for side in [0, 1]:
		var ids: Array[String] = []
		for h in P[side]["hand"]:
			ids.append(str(h.get("cardId", "")))
		out.append("H%d %s" % [side, ",".join(ids)])

	var top: Array[String] = []
	var deck: Array = st["deck"]
	for i in mini(3, deck.size()):
		top.append(str(deck[i]))
	out.append("D3 " + ",".join(top))

	out.append("R %d" % int((st["rng"] as KPRng).state))

	var cells: Array[String] = []
	for lane in KPC.LANES:
		for side in [0, 1]:
			for row in ["front", "back"]:
				var u: Variant = st["board"][lane]["units"][side][row]
				if u == null:
					cells.append("%s:%d:%s=-" % [lane, side, row])
				else:
					cells.append("%s:%d:%s=%s %s/%s" % [
						lane, side, row, str(u["cardId"]), _s2(u["atk"]), _s2(u["hp"])])
	out.append("B " + " ".join(cells))
	return "\n".join(out)


## 逐行比对，返回第一条不同的行（相同返回空串）
## 逐行比对，返回第一条不同的行（相同返回空串）
func _diff(expected: String, got: String) -> String:
	if expected == got:
		return ""
	var a := expected.split("\n")
	var b := got.split("\n")
	for i in maxi(a.size(), b.size()):
		var x: String = a[i] if i < a.size() else "<缺行>"
		var y: String = b[i] if i < b.size() else "<缺行>"
		if x != y:
			return "第 %d 行\n      期望 %s\n      实际 %s" % [i + 1, x, y]
	return "长度不同"


func _run_all() -> void:
	print("")
	print("════ AI 决策对拍：JS ↔ GDScript ════")

	var index_text := FileAccess.get_file_as_string(DIR + "/ai-index.json")
	if index_text.is_empty():
		print("  ✗ 没有 %s/ai-index.json —— 先跑 node tools/parity/ai-run.mjs" % DIR)
		quit(1)
		return

	for item in JSON.parse_string(index_text):
		await _check_one(str(item["file"]))

	print("")
	if _failures == 0:
		print("✅ %d 局 / %d 步 AI 决策逐字节一致" % [_files, _steps])
	else:
		print("❌ %d/%d 局分叉" % [_failures, _files])
	quit(1 if _failures > 0 else 0)


func _check_one(file_name: String) -> void:
	_files += 1
	var run: Dictionary = JSON.parse_string(FileAccess.get_file_as_string(DIR + "/" + file_name))
	if run == null:
		print("  ✗ 读不到 %s" % file_name)
		_failures += 1
		return

	var cfg: Dictionary = run["cfg"]
	var key0 := str(cfg["key0"])
	var key1 := str(cfg["key1"])
	var seed := int(cfg["seed"])

	var lib := {}
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://data/cards.json"))
	for c in data["cards"]:
		lib[str(c["id"])] = c

	var g = KPGame.create({
		"seed": seed,
		"firstPlayer": int(cfg["firstPlayer"]),
		"deck": cfg["deck"],
		"cardLib": lib,
		"factions": [],
	})
	g.state["humanSide"] = -1
	g.state["autoResolveChoices"] = true
	g.state["aiSides"] = [0, 1]

	var keys: Array = [key0, key1]
	var ais: Array = []
	for side in 2:
		ais.append(KPAi.new(g, str(keys[side]), {}))

	await g.start_game()
	for side in 2:
		ais[side].apply_difficulty_bonus(side, str(keys[side]))
		ais[side].install_target_picker()

	var expected: Array = run["steps"]
	var idx := 0

	var d := _diff(str(expected[0]["digest"]), _digest(g))
	if d != "":
		print("  ✗ %s 开局就不同：%s" % [file_name, d])
		_failures += 1
		return
	idx = 1

	var n := 0
	while not g.is_over() and n < MAX_STEPS and idx < expected.size():
		n += 1
		if g.has_pending():
			break
		var actor = g.get_actor()
		if actor == null:
			await g.advance()
			d = _diff(str(expected[idx]["digest"]), _digest(g))
			if d != "":
				_report(file_name, key0, key1, seed, idx, "advance", d)
				return
			idx += 1
			continue
		var res: Dictionary = await ais[int(actor)].take_turn(int(actor))
		d = _diff(str(expected[idx]["digest"]), _digest(g))
		if d != "":
			print("  现场单位：\n" + _dump_units(g))
			_report(file_name, key0, key1, seed, idx, "第 %d 回合（side %d, %s）%s" % [
				n, int(actor), str(keys[int(actor)]),
				_actions_diff(str(expected[idx].get("a", "")), expected[idx].get("actions", []), res.get("actions", []))], d)
			return
		idx += 1
		await g.advance()
		d = _diff(str(expected[idx]["digest"]), _digest(g))
		if d != "":
			_report(file_name, key0, key1, seed, idx, "第 %d 回合后 advance" % n, d)
			return
		idx += 1

	_steps += idx
	if not g.is_over():
		print("  ✗ %s 没走到终局（%d 步）" % [file_name, idx])
		_failures += 1
		return
	print("  ✓ %s %s vs %s seed=%d 共 %d 步一致 胜者%d T%d" % [
		file_name, key0, key1, seed, idx, int(g.state["winner"]), int(g.state["turn"])])


## 比对两边这一回合各自出了什么牌，定位第一手不同
func _actions_diff(_kind: String, exp: Array, got: Array) -> String:
	var m := maxi(exp.size(), got.size())
	for i in m:
		var a: String = _act_str(exp[i]) if i < exp.size() else "<无>"
		var b: String = _act_str(got[i]) if i < got.size() else "<无>"
		if a != b:
			var hist: Array[String] = []
			for x in got:
				hist.append(_act_str(x))
			return "\n      JS 出牌=%s\n      GD 出牌=%s\n      GD 全序列=%s" % [
				_json(exp), _json(got), " | ".join(hist)]
	return "出牌序列相同"


func _act_str(a: Variant) -> String:
	if a == null:
		return "<null>"
	if a is Dictionary and a.has("brew"):
		return "brew %s" % str(a["brew"])
	if a is Dictionary:
		return "%s@%s" % [str(a.get("iid", "?")), _json(a.get("opts", {}))]
	return str(a)


func _json(v: Variant) -> String:
	return JSON.stringify(v)


func _report(file_name: String, key0: String, key1: String, seed: int, idx: int, where: String, d: String) -> void:
	_failures += 1
	print("  ✗ %s %s vs %s seed=%d 第 %d 个记录处（%s）分叉：%s" % [
		file_name, key0, key1, seed, idx, where, d])


## 分叉现场：把场上单位按 uid 排出来（含有效攻击力与标记），便于对照 JS 侧
func _dump_units(g) -> String:
	var rows: Array[String] = []
	var units: Array = g.all_units()
	units.sort_custom(func(a, b): return int(a.uid) < int(b.uid))
	for u in units:
		rows.append("uid=%d %s side=%d %s/%s eff=%s marks=%s" % [
			int(u.uid), str(u.cardId), int(u.side),
			_s2(u.atk), _s2(u.hp), _s2(g.effective_atk(u)),
			str(u.get("marks", []))])
	return "\n".join(rows)
