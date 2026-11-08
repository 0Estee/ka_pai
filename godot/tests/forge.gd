extends SceneTree

## 强化 / 经济规则与旧版 JS 的对拍（tools/parity/forge-run.mjs → forge-golden.json）。

const KPForge := preload("res://scripts/ui/kp_forge.gd")
const KPProfile := preload("res://scripts/ui/kp_profile.gd")

const GOLDEN := "res://data/parity/forge-golden.json"

var problems: Array = []
var checks := 0


func _initialize() -> void:
	var raw = JSON.parse_string(FileAccess.get_file_as_string(GOLDEN))
	if not (raw is Dictionary):
		print("[forge] 读不到基准数据 %s" % GOLDEN)
		quit(1)
		return
	var golden: Dictionary = raw
	var lib: Dictionary = KPData.lib() if false else _lib()

	_costs(golden)
	_stats(golden, lib)
	_side_enhance(golden, lib)
	_ai_forge(golden, lib)
	_draw_skills(golden)
	_economy(golden)

	print("[forge] checks=%d problems=%d" % [checks, problems.size()])
	for p in problems:
		print("  PROBLEM %s" % p)
	quit(0 if problems.is_empty() else 1)


func _lib() -> Dictionary:
	var data = JSON.parse_string(FileAccess.get_file_as_string("res://data/cards.json"))
	var out := {}
	if data is Dictionary:
		for c in data.get("cards", []):
			out[str(c.get("id", ""))] = c
	return out


func _expect(ok: bool, msg: String) -> void:
	checks += 1
	if not ok:
		problems.append(msg)


func _num_eq(a: Variant, b: Variant, msg: String, tol: float = 1e-9) -> void:
	if a == null or b == null:
		_expect(a == null and b == null, "%s（%s vs %s）" % [msg, str(a), str(b)])
		return
	_expect(absf(float(a) - float(b)) <= tol, "%s（%s vs %s）" % [msg, str(a), str(b)])


func _costs(g: Dictionary) -> void:
	var c: Dictionary = g.costs
	for i in (c.enhanceGold as Array).size():
		_expect(KPForge.enhance_gold_cost(i) == int(c.enhanceGold[i]), "强化价 lvl=%d：%d vs %d" % [i, KPForge.enhance_gold_cost(i), int(c.enhanceGold[i])])
	for i in (c.masteryDust as Array).size():
		_expect(KPForge.mastery_dust_cost(i) == int(c.masteryDust[i]), "精通价 n=%d" % i)
	for i in (c.enhanceValue as Array).size():
		_num_eq(KPForge.enhance_value(i), c.enhanceValue[i], "累计强化值 lvl=%d" % i)


func _stats(g: Dictionary, lib: Dictionary) -> void:
	for row in g.stats:
		var def = lib.get(str(row.id), null)
		if def == null:
			problems.append("基准里的卡 %s 在 cards.json 里不存在" % str(row.id))
			continue
		var st: Dictionary = KPForge.stats_for(def, row.rec)
		var tag := "%s rec=%s" % [str(row.id), str(row.rec)]
		if row.atk == null:
			_expect(st.atk == null, "%s atk 应为 null" % tag)
		else:
			_num_eq(st.atk, row.atk, "%s atk" % tag)
		if row.hp == null:
			_expect(st.hp == null, "%s hp 应为 null" % tag)
		else:
			_num_eq(st.hp, row.hp, "%s hp" % tag)
		_num_eq(st.cost, row.cost, "%s cost" % tag)
		var kw: Array = []
		for k in st.keywords:
			kw.append([str(k.id), float(k.get("x", 0))])
		var want: Array = []
		for k in row.kw:
			want.append([str(k[0]), float(k[1])])
		_expect(str(kw) == str(want), "%s 词条 %s vs %s" % [tag, str(kw), str(want)])
		_expect((st.fx as Array).size() == int(row.fxCount), "%s fx 数量 %d vs %d" % [tag, (st.fx as Array).size(), int(row.fxCount)])
		var flags: Array = (st.flags as Dictionary).keys()
		flags.sort()
		_expect(str(flags) == str(row.flagKeys), "%s flags %s vs %s" % [tag, str(flags), str(row.flagKeys)])
		if row.kingAura == null:
			_expect(st.kingAura == null, "%s kingAura 应为 null" % tag)
		else:
			for k in row.kingAura.keys():
				_num_eq((st.kingAura as Dictionary).get(k, null), row.kingAura[k], "%s kingAura.%s" % [tag, str(k)])


func _deep_num_eq(a: Variant, b: Variant, tag: String) -> void:
	if a is Dictionary and b is Dictionary:
		var ka: Array = (a as Dictionary).keys()
		var kb: Array = (b as Dictionary).keys()
		ka.sort()
		kb.sort()
		if str(ka) != str(kb):
			problems.append("%s 键不同：%s vs %s" % [tag, str(ka), str(kb)])
			return
		for k in ka:
			_deep_num_eq(a[k], b[k], "%s.%s" % [tag, str(k)])
	elif a is Array and b is Array:
		if (a as Array).size() != (b as Array).size():
			problems.append("%s 长度不同：%d vs %d" % [tag, (a as Array).size(), (b as Array).size()])
			return
		for i in (a as Array).size():
			_deep_num_eq(a[i], b[i], "%s[%d]" % [tag, i])
	elif (a is float or a is int) and (b is float or b is int):
		_num_eq(a, b, tag)
	else:
		_expect(str(a) == str(b), "%s：%s vs %s" % [tag, str(a), str(b)])


func _side_enhance(g: Dictionary, lib: Dictionary) -> void:
	var profile: Dictionary = g.forgeProfile
	var mine := KPForge.build_side_enhance(lib, profile)
	_deep_num_eq(mine, g.sideEnhance, "sideEnhance")


func _ai_forge(g: Dictionary, lib: Dictionary) -> void:
	for key in g.aiForge.keys():
		var parts: PackedStringArray = str(key).split(":")
		var difficulty := str(parts[0])
		var seed_v := int(parts[1])
		var got: Dictionary = KPForge.ai_forge(lib, seed_v, difficulty).forge.cards
		var want: Dictionary = g.aiForge[key]
		_expect(got.size() == int(want.count), "aiForge %s 张数 %d vs %d" % [key, got.size(), int(want.count)])
		for row in want.sample:
			var rec = got.get(str(row.id), null)
			if rec == null:
				problems.append("aiForge %s 缺 %s" % [key, str(row.id)])
				continue
			_expect(int(rec.lvl) == int(row.lvl), "aiForge %s %s lvl %d vs %d" % [key, str(row.id), int(rec.lvl), int(row.lvl)])
			_expect(str(rec.masteries) == str(row.masteries), "aiForge %s %s masteries %s vs %s" % [key, str(row.id), str(rec.masteries), str(row.masteries)])


func _draw_skills(g: Dictionary) -> void:
	var seeds := [1, 7, 42, 999]
	for i in (g.drawSkills as Array).size():
		var s := int(seeds[i])
		var state := {"s": s}
		var rand := func() -> float:
			state.s = (KPForge._imul(state.s, 1664525) + 1013904223) & 0xFFFFFFFF
			return float(state.s) / 4294967296.0
		var got: Array = []
		for sk in KPForge.draw_skills(rand, 3):
			got.append(str(sk.id))
		_expect(str(got) == str(g.drawSkills[i]), "抽技能 seed=%d：%s vs %s" % [s, str(got), str(g.drawSkills[i])])


func _economy(g: Dictionary) -> void:
	var e: Dictionary = g.economy
	for i in (e.perfForLevel as Array).size():
		_num_eq(KPProfile.perf_for_level(i + 1), e.perfForLevel[i], "perfForLevel(%d)" % (i + 1))
	var perf_in := [0, 199, 200, 449, 450, 1100, 5000, 123456]
	for i in (e.levelFor as Array).size():
		_expect(KPProfile.level_for(float(perf_in[i])) == int(e.levelFor[i]), "levelFor(%d)" % int(perf_in[i]))

	var cases := [
		{"winner": 0, "humanSide": 0, "turn": 6, "humanKingHp": 12.0, "kills": 3, "mode": "ai"},
		{"winner": 1, "humanSide": 0, "turn": 20, "humanKingHp": 0.0, "kills": 0, "mode": "ai"},
		{"winner": "draw", "humanSide": 0, "turn": 30, "humanKingHp": 4.0, "kills": 2, "mode": "ai"},
		{"winner": 0, "humanSide": 1, "turn": 9, "humanKingHp": 7.0, "kills": 5, "mode": "pvp"},
		{"winner": 1, "humanSide": 1, "turn": 9, "humanKingHp": 7.0, "kills": 1, "mode": "pvp"},
	]
	for i in cases.size():
		var c: Dictionary = cases[i]
		var r: Dictionary = KPProfile.reward_for(c.winner, int(c.humanSide), int(c.turn), float(c.humanKingHp), int(c.kills), str(c.mode))
		var want: Dictionary = (e.rewards as Array)[i]
		_num_eq(r.total, want.total, "reward[%d].total" % i)
		_num_eq(r.dust, want.dust, "reward[%d].dust" % i)
		_num_eq(r.perf, want.perf, "reward[%d].perf" % i)

	var base := {"gold": 990.0, "dust": 490.0, "perf": 380.0, "games": 3, "wins": 1, "losses": 2, "draws": 0, "forge": {"v": 1, "cards": {}}}
	for i in cases.size():
		var c: Dictionary = cases[i]
		var res: Dictionary = KPProfile.apply_result(base, c.winner, int(c.humanSide), int(c.turn), float(c.humanKingHp), int(c.kills), str(c.mode))
		var want: Dictionary = (e.results as Array)[i]
		var p: Dictionary = res.profile
		_num_eq(p.gold, want.gold, "apply[%d].gold" % i)
		_num_eq(p.dust, want.dust, "apply[%d].dust" % i)
		_num_eq(p.perf, want.perf, "apply[%d].perf" % i)
		_expect(int(p.games) == int(want.games) and int(p.wins) == int(want.wins) and int(p.losses) == int(want.losses) and int(p.draws) == int(want.draws), "apply[%d] 战绩" % i)
		_expect(bool(res.leveledUp) == bool(want.leveledUp), "apply[%d].leveledUp" % i)
		_expect(int(res.levelAfter) == int(want.levelAfter), "apply[%d].levelAfter" % i)

	var buys := [{"gold": 100.0, "dust": 60.0}, {"gold": 5.0, "dust": 60.0}, {"gold": 100.0, "dust": 500.0}]
	for i in buys.size():
		var got: Dictionary = KPProfile.buy_dust(buys[i], 1)
		var want: Dictionary = (e.buyDust as Array)[i]
		_expect(bool(got.get("ok", false)) == bool(want.ok), "buyDust[%d].ok" % i)
		if bool(want.ok):
			_num_eq((got.profile as Dictionary).gold, (want.profile as Dictionary).gold, "buyDust[%d].gold" % i)
			_num_eq((got.profile as Dictionary).dust, (want.profile as Dictionary).dust, "buyDust[%d].dust" % i)

	var caps := [[1200.0, 10.0], [1005.0, 500.0], [-5.0, -5.0]]
	for i in caps.size():
		var got: Dictionary = KPProfile.cap_gold(caps[i][0], caps[i][1])
		var want: Dictionary = (e.capGold as Array)[i]
		_num_eq(got.gold, want.gold, "capGold[%d].gold" % i)
		_num_eq(got.dust, want.dust, "capGold[%d].dust" % i)
		_num_eq(got.melted, want.melted, "capGold[%d].melted" % i)
