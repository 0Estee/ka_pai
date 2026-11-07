## 交互挂起自检：真人侧提问会挂起，resolve_choice 能恢复结算。
##
## 目的：smoke.gd 用 humanSide=-1 / autoResolveChoices=true 跑，全程不经过
##       挂起路径（GDScript 用 await + 信号替代 JS 的 generator）。
##       本测试把真人侧设为 0、autoResolveChoices=false，专门走挂起。
##
## 用法：
##   Godot_v4.7.2-stable_win64_console.exe --headless --path godot --script res://tests/choices.gd
extends SceneTree

var _games := 0
var _fails := 0
var _hangs := 0
var _types := {}


func _initialize() -> void:
	_run_all()


func _load_lib() -> Dictionary:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://data/cards.json"))
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


func _answer_pending(g) -> void:
	var guard := 0
	while g.has_pending() and guard < 50:
		guard += 1
		var req: Dictionary = g.pending_request
		var t := str(req.get("type", "?"))
		_types[t] = int(_types.get(t, 0)) + 1
		_hangs += 1
		var opts: Array = req.get("options", [])
		g.resolve_choice(opts[0] if not opts.is_empty() else {})


func _run_all() -> void:
	var lib := _load_lib()
	var deck := _deck_from(lib)
	print("[choices] 卡库 %d 张，可入牌库 %d 张" % [lib.size(), deck.size()])
	var factions := ["demon", "god", "sword", "frost", "heart", "inferno"]
	for i in 6:
		await _play_one(lib, deck, 2000 + i, i % 2, [factions[i % factions.size()], factions[(i + 2) % factions.size()]])
	print("[choices] 完成 %d 局，失败 %d 局，挂起次数 %d，类型 %s" % [_games, _fails, _hangs, str(_types)])
	quit(1 if _fails > 0 or _hangs == 0 else 0)


func _play_one(lib: Dictionary, deck: Array, seed_v: int, first: int, factions: Array) -> void:
	_games += 1
	var g := KPGame.create({
		"seed": seed_v, "firstPlayer": first, "deck": deck,
		"cardLib": lib, "factions": factions,
	})
	# 真人侧 = 0：它的提问必须挂起等人答；对面由引擎自答
	g.state["humanSide"] = 0
	g.state["aiSides"] = [1]
	g.state["autoResolveChoices"] = false
	g.start_game()

	var steps := 0
	while not g.is_over() and steps < 4000:
		steps += 1
		_answer_pending(g)
		if g.is_over():
			break
		var actor = g.get_actor()
		if actor == null:
			g.advance()
			continue
		var plays := g.get_legal_plays(int(actor))
		if plays.is_empty():
			g.advance()
			continue
		var pick: Dictionary = plays[(seed_v + steps) % plays.size()]
		var opts := {}
		var places: Array = pick.places
		if not places.is_empty() and places[0] != null:
			opts["lane"] = places[0].lane
			opts["row"] = places[0].row
		g.play_card(int(actor), int(pick.iid), opts)

	_answer_pending(g)
	if not g.is_over():
		print("  ✗ seed=%d 跑满 %d 步仍未终局（挂起=%s）" % [seed_v, steps, str(g.has_pending())])
		_fails += 1
		return
	print("  ✓ seed=%d 胜者=%s 原因=%s 步数=%d" % [seed_v, str(g.state.get("winner")), str(g.state.get("winReason")), steps])
