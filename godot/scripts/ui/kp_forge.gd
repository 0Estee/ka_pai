extends RefCounted
class_name KPForge

## 强化 / 精通：卡牌成长系统的全部数值与规则（app/js/enhance.js 的 GDScript 移植）。
##
## 纯函数，不碰界面也不碰文件：档案由 KPProfile 读写，这里只算。
## 口径与旧版逐字一致（见 tools/parity/forge-run.mjs 的对拍数据）。

const ENHANCE_MAX := 9
const MASTERY_MAX := 2
const ENHANCE_STEP := 0.1
const ENHANCE_LAST_STEP := 0.2
const REFRESH_DUST_COST := 10

const RARITY := {
	"white": {"key": "white", "name": "白", "label": "普通", "weight": 50.0},
	"green": {"key": "green", "name": "绿", "label": "优秀", "weight": 30.0},
	"orange": {"key": "orange", "name": "橙", "label": "稀有", "weight": 15.0},
	"purple": {"key": "purple", "name": "紫", "label": "史诗", "weight": 4.5},
	"rainbow": {"key": "rainbow", "name": "彩", "label": "传说", "weight": 0.5},
}

const SKILLS := [
	{"id": "w_temper", "rarity": "white", "name": "淬身", "text": "+1 攻击 +1 生命", "atk": 1.0, "hp": 1.0},
	{"id": "w_fury", "rarity": "white", "name": "狂暴", "text": "暴击 2", "kw": [{"id": "crit", "x": 2}]},
	{"id": "w_precise", "rarity": "white", "name": "精准", "text": "若有暴击效果，则必定触发", "flags": {"critAlways": true}},
	{"id": "w_tough", "rarity": "white", "name": "强体", "text": "+2.4 生命", "hp": 2.4},
	{"id": "w_venom", "rarity": "white", "name": "恶毒", "text": "淬毒 1", "kw": [{"id": "poison", "x": 1}]},
	{"id": "w_holy", "rarity": "white", "name": "圣光", "text": "祝福 3", "kw": [{"id": "blessing", "x": 3}]},
	{"id": "g_plenty", "rarity": "green", "name": "富足", "text": "打出:抽一张牌",
		"fx": [{"trigger": "onPlay", "actions": [{"op": "draw", "amount": 1}]}]},
	{"id": "g_bloodthirst", "rarity": "green", "name": "嗜血", "text": "造成伤害:友方国王回复 1.5 生命",
		"fx": [{"trigger": "onDealDamage", "actions": [{"op": "heal", "amount": 1.5, "target": {"kind": "ownKing"}}]}]},
	{"id": "g_evolve", "rarity": "green", "name": "进化", "text": "两栖，+1 生命", "hp": 1.0, "kw": [{"id": "amphibious", "x": 0}]},
	{"id": "g_unyielding", "rarity": "green", "name": "不屈", "text": "装甲 1，受到的来自锦囊的伤害 -1",
		"kw": [{"id": "armor", "x": 1}], "flags": {"spellDamageReduce": 1.0}},
	{"id": "g_twist", "rarity": "green", "name": "扭曲", "text": "+1 攻击 +1 生命，交换攻击数值和生命数值",
		"atk": 1.0, "hp": 1.0, "flags": {"swapStats": true}},
	{"id": "g_brutal", "rarity": "green", "name": "残暴", "text": "暴击 3，暴击触发概率设为 65%",
		"kw": [{"id": "crit", "x": 3}], "flags": {"critChance": 0.65}},
	{"id": "o_stealth", "rarity": "orange", "name": "隐蔽", "text": "锦囊免疫", "kw": [{"id": "spellImmune", "x": 0}]},
	{"id": "o_teamwork", "rarity": "orange", "name": "协作", "text": "减少等同于场上队友数的费用", "flags": {"costPerAlly": 1.0}},
	{"id": "o_sacred", "rarity": "orange", "name": "圣洁", "text": "祝福 2。在场:友方国王获祝福 2",
		"kw": [{"id": "blessing", "x": 2}], "kingAura": {"blessing": 2.0}},
	{"id": "o_arcane", "rarity": "orange", "name": "奥义",
		"text": "回合开始:若回合数≥4，随机对两名敌人造成 3 点伤害，对敌方国王造成 2 点伤害",
		"fx": [{"trigger": "onTurnStart", "when": {"turnAtLeast": 4}, "actions": [
			{"op": "damage", "amount": 3, "target": {"kind": "randomEnemyUnits", "count": 2}},
			{"op": "damage", "amount": 2, "target": {"kind": "enemyKing"}}]}]},
	{"id": "o_almighty", "rarity": "orange", "name": "全能",
		"text": "随机获得[穿透1][疾病][暴击1][祝福3][溅射1]中的两个，增加等同于词条数的攻击", "expand": "almighty"},
	{"id": "p_eternal", "rarity": "purple", "name": "永恒", "text": "-2 攻击。开战回合:获得无敌。锦囊牌回合:获得锦囊免疫",
		"atk": -2.0, "fx": [
			{"trigger": "onCombatStart", "actions": [{"op": "grantKeyword", "keyword": "invincible", "untilTurnEnd": true}]},
			{"trigger": "onEnemyCastSpell", "actions": [{"op": "grantKeyword", "keyword": "spellImmune", "untilTurnEnd": true}]}]},
	{"id": "p_combo", "rarity": "purple", "name": "连击",
		"text": "-1 攻击，双重打击。[双重打击]触发后，若本回合友方打出过 2 张锦囊，额外攻击一次",
		"atk": -1.0, "kw": [{"id": "doubleStrike", "x": 0}], "flags": {"comboStrike": true}},
	{"id": "p_undying", "rarity": "purple", "name": "不灭", "text": "装甲 2。在场:友方国王生命至少为 1",
		"kw": [{"id": "armor", "x": 2}], "kingAura": {"hpFloor": 1.0}},
	{"id": "p_focus", "rarity": "purple", "name": "会心", "text": "穿透 2。若回合数≥9，获得暴击 20。暴击触发概率设为 10%",
		"kw": [{"id": "pierce", "x": 2}], "flags": {"critChance": 0.1, "critAfterTurn": {"turn": 9.0, "x": 20.0}}},
	{"id": "p_devour", "rarity": "purple", "name": "吞噬", "text": "打出:消灭一名敌人",
		"fx": [{"trigger": "onPlay", "actions": [{"op": "destroy", "reason": "吞噬", "target": {"kind": "lowestHpEnemyUnit"}}]}]},
	{"id": "p_trick", "rarity": "purple", "name": "戏法", "text": "打出:把所有敌人变为兔子",
		"fx": [{"trigger": "onPlay", "actions": [{"op": "transform", "cardId": "U329", "target": {"kind": "allEnemyUnits"}}]}]},
	{"id": "p_clone", "rarity": "purple", "name": "复制", "text": "打出:在场上召唤本单位的同名卡牌",
		"fx": [{"trigger": "onPlay", "actions": [{"op": "summonSelf"}]}]},
	{"id": "p_universal", "rarity": "purple", "name": "兼爱", "text": "开战回合开始前，双方国王和所有单位回复 10 点生命",
		"fx": [{"trigger": "onCombatStart", "oncePerTurn": true, "actions": [
			{"op": "heal", "amount": 10, "target": {"kind": "allUnits"}},
			{"op": "heal", "amount": 10, "target": {"kind": "ownKing"}},
			{"op": "heal", "amount": 10, "target": {"kind": "enemyKing"}}]}]},
	{"id": "u_annihilate", "rarity": "rainbow", "name": "湮灭", "text": "打出:弃置敌方手中的单位牌，消灭所有敌人",
		"fx": [{"trigger": "onPlay", "actions": [
			{"op": "discardHandUnits", "target": {"kind": "opponentHand"}},
			{"op": "destroy", "reason": "湮灭", "target": {"kind": "allEnemyUnits"}}]}]},
	{"id": "u_heatDeath", "rarity": "rainbow", "name": "热寂", "text": "打出:若回合数≥12，消灭敌方国王",
		"fx": [{"trigger": "onPlay", "actions": [
			{"op": "conditional", "if": {"turnAtLeast": 12},
				"then": [{"op": "destroy", "allowKing": true, "reason": "热寂", "target": {"kind": "enemyKing"}}]}]}]},
	{"id": "u_endless", "rarity": "rainbow", "name": "无尽", "text": "打出:若友方国王生命为 1，将友方国王生命设为 99",
		"fx": [{"trigger": "onPlay", "actions": [
			{"op": "conditional", "if": {"ownKingHpAtMost": 1},
				"then": [{"op": "setKingHp", "amount": 99, "target": {"kind": "ownKing"}}]}]}]},
]

const ALMIGHTY_POOL := [
	{"id": "pierce", "x": 1},
	{"id": "disease", "x": 0},
	{"id": "crit", "x": 1},
	{"id": "blessing", "x": 3},
	{"id": "splash", "x": 1},
]

const EMPTY_REC := {"lvl": 0, "masteries": []}

static var _by_id: Dictionary = {}


static func skill_by_id(id: String) -> Variant:
	if _by_id.is_empty():
		for s in SKILLS:
			_by_id[s.id] = s
	return _by_id.get(id, null)


static func rarity_of(id: String) -> Dictionary:
	return RARITY.get(id, RARITY["white"])


# ── 数值 ────────────────────────────────────────────────

static func enhance_gold_cost(lvl: int) -> int:
	var n := clampi(lvl, 0, ENHANCE_MAX - 1)
	return 12 + 4 * n


static func mastery_dust_cost(used: int) -> int:
	return 20 * (clampi(used, 0, MASTERY_MAX - 1) + 1)


static func round1(v: float) -> float:
	return roundf(v * 10.0) / 10.0


static func round2(v: float) -> float:
	return roundf(v * 100.0) / 100.0


static func enhance_value(lvl: int) -> float:
	var n := clampi(lvl, 0, ENHANCE_MAX)
	var v := 0.0
	for i in range(1, n + 1):
		v += ENHANCE_LAST_STEP if i == ENHANCE_MAX else ENHANCE_STEP
	return round1(v)


static func is_spell(def: Variant) -> bool:
	return def is Dictionary and str(def.get("type", "")) == "spell"


## 这张牌能不能进强化工坊：令牌 / 阵营专属 / 白板测试卡都不进。
static func is_forgeable(def: Variant) -> bool:
	if not (def is Dictionary):
		return false
	var id := str(def.get("id", ""))
	if id.is_empty():
		return false
	if bool(def.get("token", false)):
		return false
	if def.get("faction", null) != null and str(def.faction) != "":
		return false
	if bool(def.get("legacy", false)):
		return false
	# 白板测试卡（W / K / E 前缀，作者 2026-11-08 要求从玩家可见处清干净）
	if id.begins_with("W") or id.begins_with("K") or id.begins_with("E"):
		return false
	return true


static func record_for(profile: Variant, card_id: String) -> Dictionary:
	var cards = null
	if profile is Dictionary and profile.get("forge", null) is Dictionary:
		cards = profile.forge.get("cards", null)
	if cards is Dictionary and cards.get(card_id, null) is Dictionary:
		return cards[card_id]
	return EMPTY_REC


static func _with_record(profile: Dictionary, card_id: String, rec: Dictionary) -> Dictionary:
	var next := profile.duplicate(true)
	var forge: Dictionary = next.get("forge", {"v": 1, "cards": {}})
	if not (forge.get("cards", null) is Dictionary):
		forge = {"v": 1, "cards": {}}
	var cards: Dictionary = forge.cards.duplicate(true)
	var masteries: Array = rec.get("masteries", [])
	if int(rec.get("lvl", 0)) == 0 and masteries.is_empty():
		cards.erase(card_id)
	else:
		cards[card_id] = {"lvl": int(rec.get("lvl", 0)), "masteries": masteries.duplicate()}
	next["forge"] = {"v": 1, "cards": cards}
	return next


static func stats_for(def: Dictionary, rec: Variant) -> Dictionary:
	var r: Dictionary = rec if rec is Dictionary else EMPTY_REC
	var masteries: Array = r.get("masteries", []) if r.get("masteries", null) is Array else []
	if is_spell(def):
		var base_cost := float(def.get("cost", 0))
		var per := 0.25 if base_cost <= 2.0 else 1.0
		return {
			"atk": null, "hp": null,
			"cost": round2(maxf(0.0, base_cost - masteries.size() * per)),
			"keywords": [], "fx": [], "flags": {}, "kingAura": null,
			"masteries": masteries.size(), "lvl": int(r.get("lvl", 0)),
		}
	var add := enhance_value(int(r.get("lvl", 0)))
	var atk := float(def.get("atk", 0)) + add
	var hp := float(def.get("hp", 0)) + add
	var keywords: Array = []
	var fx: Array = []
	var flags := {}
	var king_aura = null
	for id in masteries:
		var s = skill_by_id(str(id))
		if s == null:
			continue
		atk += float(s.get("atk", 0))
		hp += float(s.get("hp", 0))
		for k in s.get("kw", []):
			keywords.append({"id": k.id, "x": k.get("x", 0)})
		for e in s.get("fx", []):
			fx.append(e.duplicate(true))
		if s.get("flags", null) is Dictionary:
			for k in s.flags.keys():
				flags[k] = s.flags[k]
		if s.get("kingAura", null) is Dictionary:
			if king_aura == null:
				king_aura = {}
			for k in s.kingAura.keys():
				king_aura[k] = s.kingAura[k]
		if str(s.get("expand", "")) == "almighty":
			var ex := expand_almighty(str(def.get("id", "")))
			atk += float(ex.atk)
			for k in ex.kw:
				keywords.append(k)
	return {
		"atk": round1(atk), "hp": round1(hp), "cost": float(def.get("cost", 0)),
		"keywords": keywords, "fx": fx, "flags": flags, "kingAura": king_aura,
		"masteries": masteries.size(), "lvl": int(r.get("lvl", 0)),
	}


static func fmt_num(v: Variant) -> String:
	if v == null:
		return "—"
	var n := float(v)
	if is_equal_approx(n, roundf(n)):
		return str(int(roundf(n)))
	return "%.1f" % n


# ── 三个动作 ─────────────────────────────────────────────

static func can_enhance(profile: Dictionary, def: Variant, card_id: String) -> Dictionary:
	if not is_forgeable(def):
		return {"ok": false, "reason": "这张牌不能强化"}
	var rec := record_for(profile, card_id)
	if int(rec.get("lvl", 0)) >= ENHANCE_MAX:
		return {"ok": false, "reason": "已经练满，去精通它" if is_spell(def) else "已经练满，去精通或洗掉"}
	var cost := enhance_gold_cost(int(rec.get("lvl", 0)))
	if float(profile.get("gold", 0)) < cost:
		return {"ok": false, "reason": "金币不足（需要 %d）" % cost, "cost": cost}
	return {"ok": true, "cost": cost}


static func apply_enhance(profile: Dictionary, def: Variant, card_id: String) -> Dictionary:
	var gate := can_enhance(profile, def, card_id)
	if not bool(gate.get("ok", false)):
		return gate
	var rec := record_for(profile, card_id)
	var lvl := int(rec.get("lvl", 0)) + 1
	var next := _with_record(profile, card_id, {"lvl": lvl, "masteries": (rec.get("masteries", []) as Array).duplicate()})
	next["gold"] = float(profile.get("gold", 0)) - float(gate.cost)
	return {"ok": true, "profile": next, "cost": gate.cost, "lvl": lvl}


static func can_master(profile: Dictionary, def: Variant, card_id: String) -> Dictionary:
	if not is_forgeable(def):
		return {"ok": false, "reason": "这张牌不能精通"}
	var rec := record_for(profile, card_id)
	var masteries: Array = rec.get("masteries", [])
	if masteries.size() >= MASTERY_MAX:
		return {"ok": false, "reason": "已经精通 %d 次（上限）" % MASTERY_MAX}
	if int(rec.get("lvl", 0)) < ENHANCE_MAX:
		return {"ok": false, "reason": "还要强化 %d 次" % (ENHANCE_MAX - int(rec.get("lvl", 0)))}
	var cost := mastery_dust_cost(masteries.size())
	if float(profile.get("dust", 0)) < cost:
		return {"ok": false, "reason": "星尘不足（需要 %d）" % cost, "cost": cost}
	return {"ok": true, "cost": cost}


static func apply_mastery(profile: Dictionary, def: Variant, card_id: String, skill_id: String) -> Dictionary:
	var gate := can_master(profile, def, card_id)
	if not bool(gate.get("ok", false)):
		return gate
	var rec := record_for(profile, card_id)
	var masteries: Array = (rec.get("masteries", []) as Array).duplicate()
	if is_spell(def):
		masteries.append("spell_cost")
	else:
		if skill_by_id(skill_id) == null:
			return {"ok": false, "reason": "没有选择技能"}
		if masteries.has(skill_id):
			return {"ok": false, "reason": "这个技能已经挂过了"}
		masteries.append(skill_id)
	var next := _with_record(profile, card_id, {"lvl": 0, "masteries": masteries})
	next["dust"] = maxf(0.0, float(profile.get("dust", 0)) - float(gate.cost))
	return {"ok": true, "profile": next, "cost": gate.cost, "skillId": null if is_spell(def) else skill_id}


static func can_wash(profile: Dictionary, def: Variant, card_id: String) -> Dictionary:
	var rec := record_for(profile, card_id)
	if (rec.get("masteries", []) as Array).is_empty():
		return {"ok": false, "reason": "没有可洗掉的精通"}
	return {"ok": true}


static func apply_wash(profile: Dictionary, def: Variant, card_id: String) -> Dictionary:
	var gate := can_wash(profile, def, card_id)
	if not bool(gate.get("ok", false)):
		return gate
	var rec := record_for(profile, card_id)
	var masteries: Array = (rec.get("masteries", []) as Array).duplicate()
	masteries.resize(maxi(0, masteries.size() - 1))
	return {"ok": true, "profile": _with_record(profile, card_id, {"lvl": 0, "masteries": masteries})}


# ── 给引擎的增量表 ───────────────────────────────────────

static func build_side_enhance(lib: Dictionary, profile: Variant) -> Dictionary:
	var out := {}
	var cards = null
	if profile is Dictionary and profile.get("forge", null) is Dictionary:
		cards = profile.forge.get("cards", null)
	if not (cards is Dictionary):
		return out
	for card_id in cards.keys():
		var def = lib.get(card_id, null)
		if not is_forgeable(def):
			continue
		var st := stats_for(def, cards[card_id])
		var delta := {
			"atk": round1(0.0 if st.atk == null else float(st.atk) - float(def.get("atk", 0))),
			"hp": round1(0.0 if st.hp == null else float(st.hp) - float(def.get("hp", 0))),
			"cost": round2(float(st.cost) - float(def.get("cost", 0))),
			"kw": st.keywords,
		}
		if not (st.fx as Array).is_empty():
			delta["fx"] = st.fx
		if st.flags is Dictionary and not (st.flags as Dictionary).is_empty():
			delta["flags"] = st.flags
		if st.kingAura != null:
			delta["kingAura"] = st.kingAura
		if float(delta.atk) != 0.0 or float(delta.hp) != 0.0 or float(delta.cost) != 0.0 \
				or not (delta.kw as Array).is_empty() or delta.has("fx") or delta.has("flags") or delta.has("kingAura"):
			out[card_id] = delta
	return out


static func build_enhance_pair(lib: Dictionary, human_profile: Dictionary, foe_enhance: Variant) -> Array:
	return [build_side_enhance(lib, human_profile), foe_enhance if foe_enhance is Dictionary else {}]


# ── AI 的强化（按难度、按种子确定性生成）─────────────────

const AI_TUNE := {
	"easy": {"chance": 0.0, "mastery": 0.0},
	"normal": {"chance": 0.15, "mastery": 0.15},
	"hard": {"chance": 0.35, "mastery": 0.35},
	"nightmare": {"chance": 0.6, "mastery": 0.55},
	"impossible": {"chance": 0.85, "mastery": 0.8},
}


static func hash32(s: String) -> int:
	var h := 0x811c9dc5
	for i in s.length():
		h = (h ^ (s.unicode_at(i) & 0xffff)) & 0xffffffff
		h = _imul(h, 0x01000193)
	return h & 0xffffffff


static func _imul(a: int, b: int) -> int:
	const M := 0xffffffff
	var ah := (a >> 16) & 0xffff
	var al := a & 0xffff
	var bh := (b >> 16) & 0xffff
	var bl := b & 0xffff
	var lo := al * bl
	var mid := ((ah * bl) + (al * bh)) & 0xffff
	return ((mid << 16) + lo) & M


static func frac(h: int, k: int) -> float:
	var x := (h ^ _imul(k + 1, 0x9e3779b1)) & 0xffffffff
	x = _imul(x ^ (x >> 16), 0x85ebca6b)
	x = _imul(x ^ (x >> 13), 0xc2b2ae35)
	x = (x ^ (x >> 16)) & 0xffffffff
	return float(x) / 4294967296.0


static func pick_weighted(pool: Array, r: float) -> int:
	var total := 0.0
	for s in pool:
		total += float(rarity_of(str(s.rarity)).weight)
	var hit := clampf(r, 0.0, 0.999999) * total
	for i in pool.size():
		hit -= float(rarity_of(str(pool[i].rarity)).weight)
		if hit < 0.0:
			return i
	return pool.size() - 1


static func draw_skills(rand: Callable, n: int = 3) -> Array:
	var pool: Array = SKILLS.duplicate()
	var out: Array = []
	var count := mini(n, pool.size())
	for i in count:
		var idx := pick_weighted(pool, float(rand.call()))
		out.append(pool[idx])
		pool.remove_at(idx)
	return out


static func expand_almighty(card_id: String) -> Dictionary:
	var pool: Array = ALMIGHTY_POOL.duplicate(true)
	var picked: Array = []
	var h := hash32("almighty:" + card_id)
	for i in 2:
		if pool.is_empty():
			break
		var idx := int(floor(frac(h, i) * pool.size())) % pool.size()
		picked.append(pool[idx])
		pool.remove_at(idx)
	return {"kw": picked, "atk": picked.size()}


static func ai_forge(lib: Dictionary, seed_v: int, difficulty: String) -> Dictionary:
	var tune: Dictionary = AI_TUNE.get(difficulty, AI_TUNE["normal"])
	var cards := {}
	if float(tune.chance) <= 0.0:
		return {"forge": {"v": 1, "cards": cards}}
	for id in lib.keys():
		var def = lib[id]
		if not is_forgeable(def):
			continue
		var h := hash32("%d:%s:%s" % [seed_v & 0xffffffff, difficulty, str(id)])
		if frac(h, 0) >= float(tune.chance):
			continue
		var lvl := 1 + int(floor(frac(h, 1) * ENHANCE_MAX))
		var masteries: Array = []
		if lvl == ENHANCE_MAX and frac(h, 2) < float(tune.mastery):
			if is_spell(def):
				masteries.append("spell_cost")
				if frac(h, 3) < float(tune.mastery) * 0.5:
					masteries.append("spell_cost")
			else:
				var count := 2 if frac(h, 3) < float(tune.mastery) * 0.4 else 1
				var pool: Array = SKILLS.duplicate()
				for i in count:
					if pool.is_empty():
						break
					var idx := pick_weighted(pool, frac(h, 4 + i))
					masteries.append(pool[idx].id)
					pool.remove_at(idx)
		cards[id] = {"lvl": lvl, "masteries": masteries}
	return {"forge": {"v": 1, "cards": cards}}


# ── 工坊列表 ─────────────────────────────────────────────

static func workshop_cards(lib: Dictionary, profile: Dictionary, group_by: String = "type") -> Dictionary:
	var cards: Array = []
	for id in lib.keys():
		var def = lib[id]
		if not is_forgeable(def):
			continue
		var rec := record_for(profile, str(id))
		cards.append({
			"id": str(id), "def": def, "rec": rec, "stats": stats_for(def, rec),
			"type": "spell" if is_spell(def) else "unit",
		})
	cards.sort_custom(func(a, b): return str(a.def.get("name", "")) < str(b.def.get("name", "")))
	var groups: Array = []
	if group_by == "type":
		var units: Array = []
		var spells: Array = []
		for c in cards:
			if str(c.type) == "unit":
				units.append(c)
			else:
				spells.append(c)
		if not units.is_empty():
			groups.append({"key": "unit", "label": "基础卡（单位）", "cards": units})
		if not spells.is_empty():
			groups.append({"key": "spell", "label": "锦囊卡", "cards": spells})
	else:
		var cur = null
		for c in cards:
			var initial := _initial_of(str(c.def.get("name", "")))
			if cur == null or str(cur.key) != initial:
				cur = {"key": initial, "label": "其他" if initial == "#" else initial.to_upper(), "cards": []}
				groups.append(cur)
			cur.cards.append(c)
	return {"groups": groups, "cards": cards}


static func _initial_of(name: String) -> String:
	if name.is_empty():
		return "#"
	var ch := name.substr(0, 1)
	var u := ch.unicode_at(0)
	if (u >= 65 and u <= 90) or (u >= 97 and u <= 122):
		return ch.to_upper()
	if u >= 0x4e00 and u <= 0x9fff:
		return ch
	return "#"


static func mastery_hint(def: Dictionary) -> String:
	if is_spell(def):
		var base := float(def.get("cost", 0))
		var per := 0.25 if base <= 2.0 else 1.0
		return "费用 %s → %s（原费 ≤2 时每次只 −0.25）" % [fmt_num(base), fmt_num(maxf(0.0, base - per))]
	return "失去全部强化数值，从 3 个随机技能中选 1 个永久挂上"


static func mastery_name(id: String) -> String:
	if id == "spell_cost":
		return "精通：锦囊减费"
	var s = skill_by_id(id)
	return str(s.name) if s != null else id
