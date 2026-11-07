## 无头规则自检：建局 → 随机出牌 → 打到终局
##
## 用法：
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/smoke.gd
extends SceneTree

var _games := 0
var _failures := 0


func _initialize() -> void:
	_run_all()


func _load_lib() -> Dictionary:
	var text := FileAccess.get_file_as_string("res://data/cards.json")
	var data = JSON.parse_string(text)
	var lib := {}
	for c in data["cards"]:
		lib[str(c["id"])] = c
	return lib


func _deck_from(lib: Dictionary) -> Array:
	var deck: Array = []
	for id in lib.keys():
		var c: Dictionary = lib[id]
		if c.get("token", false) or c.get("legacy", false) or c.get("rawMaterial", false):
			continue
		deck.append(id)
	deck.sort()
	return deck


func _run_all() -> void:
	var lib := _load_lib()
	var deck := _deck_from(lib)
	print("[smoke] 卡库 %d 张，可入牌库 %d 张" % [lib.size(), deck.size()])

	var factions := ["", "demon", "god", "sword", "music", "science", "divine",
		"alchemy", "inferno", "frost", "sin", "party", "flame", "heart"]

	for i in 12:
		var f0: Variant = null if factions[i % factions.size()] == "" else factions[i % factions.size()]
		var f1: Variant = null if factions[(i + 5) % factions.size()] == "" else factions[(i + 5) % factions.size()]
		await _play_one(lib, deck, 1000 + i, i % 2, [f0, f1])

	print("[smoke] 完成 %d 局，失败 %d 局" % [_games, _failures])
	quit(1 if _failures > 0 else 0)


func _play_one(lib: Dictionary, deck: Array, seed_v: int, first: int, factions: Array) -> void:
	_games += 1
	var g := KPGame.create({
		"seed": seed_v, "firstPlayer": first, "deck": deck,
		"cardLib": lib, "factions": factions,
	})
	# 无头模拟：没有真人，所有提问都自动代答
	g.state["humanSide"] = -1
	g.state["autoResolveChoices"] = true

	await g.start_game()

	var steps := 0
	while not g.is_over() and steps < 4000:
		steps += 1
		if g.has_pending():
			print("  ✗ seed=%d 出现未处理的挂起：%s" % [seed_v, str(g.pending_request.get("type", "?"))])
			_failures += 1
			return
		var actor = g.get_actor()
		if actor == null:
			await g.advance()
			continue
		var plays := g.get_legal_plays(int(actor))
		if plays.is_empty():
			await g.advance()
			continue
		# 按种子做确定性选择（不依赖 RandomNumberGenerator，方便复现）
		var pick: Dictionary = plays[(seed_v + steps) % plays.size()]
		var opts := {}
		var places: Array = pick.places
		if not places.is_empty() and places[0] != null:
			opts["lane"] = places[0].lane
			opts["row"] = places[0].row
		var ok: bool = await g.play_card(int(actor), int(pick.iid), opts)
		if not ok:
			print("  ✗ seed=%d 出牌失败：%s" % [seed_v, g.last_error])
			_failures += 1
			return

	if not g.is_over():
		print("  ✗ seed=%d 跑满 %d 步仍未终局" % [seed_v, steps])
		_failures += 1
		return

	var w = g.state.get("winner")
	var hp0: float = float(g.state.players[0].kingHp)
	var hp1: float = float(g.state.players[1].kingHp)
	print("  ✓ seed=%d 阵营=%s/%s 步数=%d 胜者=%s 国王=%s/%s 原因=%s" % [
		seed_v, str(factions[0]), str(factions[1]), steps, str(w),
		g._num_s(hp0), g._num_s(hp1), str(g.state.get("winReason"))])
