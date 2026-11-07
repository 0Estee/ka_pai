## JS ↔ GDScript 移植对拍
##
## 干什么：
##   tools/parity/js-run.mjs 用固定种子 + 固定牌库把 JS 引擎打完，把每一步的
##   「动作」和「状态摘要」写进 godot/data/parity/js-seed*.json。
##   本脚本读那些文件，用**同一副牌库**重放**同一串动作**，逐步比对摘要。
##   全部逐行相等 ⇒ GDScript 移植在规则上与 JS 原版等价（5489 行没抄错）。
##
## 为什么值得这么做：
##   engine/test/smoke.mjs 的 229 条断言守的是 JS 版；Godot 侧只有「能跑完」
##   这种弱验证。规则细节（光环叠加、结算顺序、触发器时机）抄错一个数，
##   「能跑完」是发现不了的，对拍能。
##
## 用法：
##   node tools/parity/js-run.mjs                     # 先生成 js 侧数据
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/parity.gd
##
## 摘要格式与 tools/parity/js-run.mjs 的 digest() 必须逐字符一致。
extends SceneTree

const KPC := preload("res://scripts/engine/kp_constants.gd")
const DIR := "res://data/parity"

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
func _diff(expected: String, got: String) -> String:
	var a := expected.split("\n")
	var b := got.split("\n")
	var n := mini(a.size(), b.size())
	for i in n:
		if a[i] != b[i]:
			return "第 %d 行：期望 [%s] 实际 [%s]" % [i + 1, a[i], b[i]]
	if a.size() != b.size():
		return "行数不同：期望 %d 行，实际 %d 行" % [a.size(), b.size()]
	return ""


func _run_all() -> void:
	var dir := DirAccess.open(DIR)
	if dir == null:
		print("[parity] 找不到 %s —— 先跑 node tools/parity/js-run.mjs" % DIR)
		quit(1)
		return

	var names: Array[String] = []
	for f in dir.get_files():
		if f.begins_with("js-seed") and f.ends_with(".json"):
			names.append(f)
	names.sort()
	if names.is_empty():
		print("[parity] %s 里没有 js-seed*.json —— 先跑 node tools/parity/js-run.mjs" % DIR)
		quit(1)
		return

	# Godot 侧的卡库就是 JS 导出的那份（tools/export-rules-json.mjs 的产物）
	var lib := _load_lib()
	for name in names:
		await _check_one(DIR + "/" + name, lib)

	print("[parity] %d 局 / %d 步，失败 %d 局" % [_files, _steps, _failures])
	quit(1 if _failures > 0 else 0)


func _load_lib() -> Dictionary:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://data/cards.json"))
	var lib := {}
	for c in data["cards"]:
		lib[str(c["id"])] = c
	return lib


func _check_one(path_name: String, lib: Dictionary) -> void:
	_files += 1
	var text := FileAccess.get_file_as_string(path_name)
	if text.is_empty():
		print("  ✗ 读不到 %s" % path_name)
		_failures += 1
		return
	var run: Dictionary = JSON.parse_string(text)
	var cfg: Dictionary = run["cfg"]

	var faction0: Variant = cfg["factions"][0] if cfg["factions"].size() > 0 else null
	var faction1: Variant = cfg["factions"][1] if cfg["factions"].size() > 1 else null
	var g := KPGame.create({
		"seed": int(cfg["seed"]),
		"firstPlayer": int(cfg["firstPlayer"]),
		"deck": cfg["deck"],
		"cardLib": lib,
		"factions": [faction0, faction1],
	})
	g.state["humanSide"] = -1
	g.state["autoResolveChoices"] = true
	# JS 侧是 createGame→startGame 之间设的这两个开关，这里必须完全对齐
	await g.start_game()

	var steps: Array = run["steps"]
	var bad := ""
	var bad_at := -1
	for i in steps.size():
		var step: Dictionary = steps[i]
		var d := ""
		match str(step["a"]):
			"init":
				d = ""  # 开局摘要用下面统一比对
			"advance":
				if g.has_pending():
					bad = "在第 %d 步要 advance，但引擎还挂着 %s" % [i, str(g.pending_request.get("type", "?"))]
					bad_at = i
					break
				await g.advance()
			"play":
				if g.has_pending():
					bad = "在第 %d 步要出牌，但引擎还挂着 %s" % [i, str(g.pending_request.get("type", "?"))]
					bad_at = i
					break
				var side := int(step["side"])
				var card_id := str(step["cardId"])
				var iid := _find_iid(g.state["players"][side]["hand"], card_id)
				if iid < 0:
					bad = "在第 %d 步手牌里找不到 %s（手牌：%s）" % [
						i, card_id, _hand_ids(g.state["players"][side]["hand"])]
					bad_at = i
					break
				var opts := {}
				if step.get("lane") != null:
					opts["lane"] = str(step["lane"])
					opts["row"] = str(step["row"])
				var ok: bool = await g.play_card(side, iid, opts)
				if not ok:
					bad = "在第 %d 步 JS 打出 %s 成功，Godot 失败：%s" % [i, card_id, g.last_error]
					bad_at = i
					break
			_:
				bad = "第 %d 步未知动作 %s" % [i, str(step["a"])]
				bad_at = i
				break

		if bad != "":
			break
		_steps += 1
		var expected := str(step["digest"])
		d = _digest(g)
		var line := _diff(expected, d)
		if line != "":
			bad = "第 %d 步（%s %s）摘要不一致 —— %s" % [
				i, str(step["a"]), str(step.get("cardId", "")), line]
			bad_at = i
			break

	var seed_v := int(cfg["seed"])
	if bad != "":
		_failures += 1
		print("  ✗ seed=%d 对拍失败于第 %d 步：%s" % [seed_v, bad_at, bad])
		return

	var w = g.state.get("winner")
	print("  ✓ seed=%d 阵营=%s/%s 步数=%d 终局=%s 胜者=%s 国王=%s/%s 原因=%s" % [
		seed_v, str(faction0), str(faction1), steps.size() - 1,
		str(g.is_over()), str(w),
		g._num_s(float(g.state["players"][0]["kingHp"])),
		g._num_s(float(g.state["players"][1]["kingHp"])),
		str(g.state.get("winReason")),
	])


func _find_iid(hand: Array, card_id: String) -> int:
	for h in hand:
		if str(h.get("cardId", "")) == card_id:
			return int(h["iid"])
	return -1


func _hand_ids(hand: Array) -> String:
	var out: Array[String] = []
	for h in hand:
		out.append(str(h.get("cardId", "")))
	return ",".join(out)
