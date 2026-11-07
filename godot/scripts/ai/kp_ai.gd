## 对手 AI（启发式）与 5 个难度 —— 移植自 app/js/ai.js
##
## ── 移植口径 ──────────────────────────────────────────────
## 决策逻辑与 JS 版**逐条对应**：同一份难度参数、同一套评分、同一套答题口径。
## 差别只在于 GDScript 侧引擎是协程（play_card / advance 都是 await），
## 所以「打一回合」是个协程，必须 await 调用。
##
## ── 难度靠什么拉开（与 JS 版一致）────────────────────────
##   defense / wHp / passThreshold / jitter / lookahead / bonus / planner / insight
##   前四档只改决策水平，不碰规则；噩梦与「不可能」的优势都会写在界面上。
##
## ── 用法 ─────────────────────────────────────────────────
##   var ai := KPAi.new(g, "normal")
##   ai.install_target_picker()          # 建局时调一次（「拟定目标攻击」由 AI 自己挑）
##   var res = await ai.take_turn(side)  # 打完这一方的行动阶段
class_name KPAi
extends RefCounted

const KPC := preload("res://scripts/engine/kp_constants.gd")
const RNG := preload("res://scripts/engine/kp_rng.gd")

## 五个难度的公共评分权重（调难度只改难度表）
const BASE := {
	"wHp": 0.7,
	"wFront": 2.0,
	"wBlockUrgent": 5.0,
	"wTradeKill": 3.0,
	"wThreat": 0.5,
	"wChip": 0.3,
	"wBackOpen": 1.5,
	"wZeroBack": -6.0,
	"wSquishyBack": 1.0,
	"wFragile": -2.0,
	"wLookahead": 0.8,
	"wSpread": 1.5,
}

## 「不可能」的推演档位：只加广、不加深（越深越被评估函数的偏差放大）
const PLAN_LEVELS: Array = [
	{"k": 8, "steps": 20},
	{"k": 12, "steps": 20},
	{"k": 16, "steps": 20},
	{"k": 20, "steps": 20},
	{"k": 24, "steps": 20},
]

## 推演克隆里只增不减的流水账：克隆体给空数组就够（不共享，否则假事件会写回真对局）
const JOURNAL_KEYS := ["log", "choiceLog", "qTrace"]

var g: KPGame = null
var key: String = "normal"
var P: Dictionary = {}


func _init(game: KPGame = null, difficulty_key: String = "normal", params: Dictionary = {}) -> void:
	g = game
	key = difficulty_key
	var p: Dictionary = difficulty_by_key(difficulty_key).duplicate()
	if params != null:
		for k in params.keys():
			p[k] = params[k]
	P = p


# ══════════════════════════════════════════════════════════
# 难度表
# ══════════════════════════════════════════════════════════

static func _merge(base: Dictionary, over: Dictionary) -> Dictionary:
	var d: Dictionary = base.duplicate(true)
	for k in over.keys():
		d[k] = over[k]
	return d


static func difficulties() -> Array:
	return [
		# 简单：只会下单位，不会用锦囊
		_merge(BASE, {
			"key": "easy", "name": "简单", "tagline": "只会下单位，不会用锦囊",
			"noSpells": true, "passThreshold": 1.5, "jitter": 1.0,
			"lookahead": false, "bonus": null,
		}),
		# 普通：会防守、会用锦囊，但算不到下一步（老 AI 的手感）
		_merge(BASE, {
			"key": "normal", "name": "普通", "tagline": "会防守、会用锦囊，但算不到下一步",
			"passThreshold": -1.0, "jitter": 0.1,
			"lookahead": false, "bonus": null,
		}),
		# 困难：普通级决策 + 去掉随机性 + 资源小优势（起手多 1 张、国王 +6）
		_merge(BASE, {
			"key": "hard", "name": "困难", "tagline": "出牌不靠运气，每一步都算",
			"passThreshold": -1.0, "jitter": 0.0, "lookahead": false,
			"bonus": {"hand": 1, "kingHp": 6},
		}),
		# 噩梦：唯一给每回合多 1 费的难度（界面上逐条写明）
		_merge(BASE, {
			"key": "nightmare", "name": "噩梦", "tagline": "和你同级地打，看得比你远一点",
			"passThreshold": -1.0, "jitter": 0.0, "lookahead": false,
			"bonus": {"hand": 1, "manaPerTurn": 1, "kingHp": 8},
		}),
		# 不可能：不加任何数值优势，只把后面几步真的推演一遍 + 看得到对手手牌与下一抽
		_merge(BASE, {
			"key": "impossible", "name": "不可能", "tagline": "每一步都在脑子里试打几遍，算完才落子",
			"passThreshold": -1.0, "jitter": 0.0, "lookahead": false,
			"bonus": null,
			"insight": {"hand": true, "deck": true},
			"planner": "rollout",
			"smartChoices": true,
			"rolloutPass": true,
			"planBudgetMs": 6000,
		}),
	]


static func default_difficulty_key() -> String:
	return "normal"


static func difficulty_by_key(k: String) -> Dictionary:
	for d in difficulties():
		if str(d.key) == k:
			return d
	var all := difficulties()
	return all[1]


## 难度对 AI 那一边的增益（开局时调一次）。回放要原样重放同一份加成。
func apply_bonus_object(side: int, b: Variant) -> void:
	if not (b is Dictionary) or b == null:
		return
	var st: Dictionary = g.state
	var p: Dictionary = st.players[side]
	if int(b.get("hand", 0)) > 0:
		g.draw_cards(side, int(b.get("hand", 0)))
	if int(b.get("manaPerTurn", 0)) > 0:
		p["flatManaBonus"] = int(p.get("flatManaBonus", 0)) + int(b.get("manaPerTurn", 0))
	if float(b.get("kingHp", 0)) > 0:
		p["kingMaxHp"] = float(p.kingMaxHp) + float(b.kingHp)
		p["kingHp"] = float(p.kingHp) + float(b.kingHp)
	# 立刻生效：费用上限要在本回合就体现出来
	p["manaCap"] = int(p.get("manaCap", 0)) + int(b.get("manaPerTurn", 0))
	p["mana"] = int(p.get("mana", 0)) + int(b.get("manaPerTurn", 0))


func apply_difficulty_bonus(side: int, difficulty_key: String) -> void:
	apply_bonus_object(side, difficulty_by_key(difficulty_key).get("bonus", null))


# ══════════════════════════════════════════════════════════
# 基础估算
# ══════════════════════════════════════════════════════════

func _st() -> Dictionary:
	return g.state


## 取词条的数值参数
func kw_x(unit: Variant, id: String) -> float:
	if unit == null:
		return 0.0
	var k = g.get_kw(unit, id)
	if k == null:
		return 0.0
	return float(k.get("x", 0.0))


## 估算 def 打 unit 实际能造成多少伤害（粗略计入装甲 / 祝福）
func effective_damage(def: Dictionary, unit: Variant) -> float:
	var dmg := float(def.get("atk", 0))
	var blessing := kw_x(unit, "blessing")
	if blessing > 0.0 and dmg > blessing:
		dmg = blessing
	dmg = maxf(0.0, dmg - kw_x(unit, "armor"))
	return dmg


## 估算 unit 反击会掉多少血（用有效攻击力，计入光环）
func threat_of(unit: Variant) -> float:
	return g.effective_atk(unit)


## 我把这个单位放上去，对面这条线路最狠的一下会让我亏多少
func opponent_best_reply(side: int, lane: String, def: Dictionary) -> float:
	var foe := 1 - side
	var worst := 0.0
	for u in g.all_units():
		if int(u.side) != foe or str(u.lane) != lane:
			continue
		var dmg := g.effective_atk(u)
		if dmg <= 0.0:
			continue
		var would_die: bool = dmg >= float(def.get("hp", 0))
		var loss: float = (float(def.get("atk", 0)) * 1.0 + float(def.get("hp", 0)) * 0.7) if would_die else dmg * 0.35
		if loss > worst:
			worst = loss
	return worst


func insight_on() -> bool:
	return P.get("insight", null) != null


## 一张手牌「大概值多少」—— 只看卡面
func card_hand_value(def: Variant) -> float:
	if not (def is Dictionary):
		return 0.0
	var cost := float(def.get("cost", 0))
	if str(def.get("type", "")) == "unit":
		return float(def.get("atk", 0)) * 0.9 + float(def.get("hp", 0)) * 0.5 + cost * 0.2
	var v := cost * 0.2
	for a in def.get("actions", []):
		var amt := float(a.amount) if (a.get("amount", null) is float or a.get("amount", null) is int) else 2.0
		match str(a.get("op", "")):
			"damage": v += amt * 0.7
			"destroy": v += 4.0
			"control": v += 4.5
			"stealToHand": v += 4.0
			"draw": v += amt * 1.8
			"heal": v += amt * 0.4
			"buffAtk", "buffMaxHp", "modifyStats": v += amt * 0.9
			"summon", "summonRandomToken": v += 2.2
			"seal", "freeze", "bounce": v += 1.6
			_: v += 0.6
	return v


## 对手手上的「解牌」：能打到最大多少血的单位，有没有硬解 / 控制
func removal_in_hand(foe: int) -> Dictionary:
	var st: Dictionary = g.state
	var hand: Array = st.players[foe].get("hand", [])
	var max_dmg := 0.0
	var has_hard := false
	for hc in hand:
		var def = st.cardLib.get(hc.cardId, null)
		if def == null or str(def.get("type", "")) != "spell":
			continue
		for a in def.get("actions", []):
			var op := str(a.get("op", ""))
			if op == "damage":
				var spec: Dictionary = a.get("target", {}) if a.get("target", null) is Dictionary else {}
				var kind := str(spec.get("kind", ""))
				if kind == "chosenKing" or kind == "enemyKing":
					continue
				var amt := float(a.amount) if (a.get("amount", null) is float or a.get("amount", null) is int) else 2.0
				if amt > max_dmg:
					max_dmg = amt
			elif op == "destroy" or op == "control" or op == "stealToHand":
				has_hard = true
	return {"maxDmg": max_dmg, "hasHard": has_hard}


## 这一方**下一次**抽牌会抽到的卡面（后手先抽、先手后抽）
func next_draw_card(side: int) -> Variant:
	var st: Dictionary = g.state
	var deck: Array = st.get("deck", [])
	if deck.is_empty():
		return null
	var first: int = 0 if int(st.get("firstPlayer", 0)) == 0 else 1
	var idx: int = 0 if side == 1 - first else 1
	if idx >= deck.size():
		return null
	return st.cardLib.get(str(deck[idx]), null)


func hand_value(side: int) -> float:
	var hand: Array = g.state.players[side].get("hand", [])
	var v := 0.0
	for hc in hand:
		v += card_hand_value(g.state.cardLib.get(hc.cardId, null))
	return v


## 某一方手牌里能直接打到对方国王的伤害合计（只数锦囊）
func king_damage_in_hand(side: int) -> float:
	var hand: Array = g.state.players[side].get("hand", [])
	var sum := 0.0
	for hc in hand:
		var def = g.state.cardLib.get(hc.cardId, null)
		if def == null or str(def.get("type", "")) != "spell":
			continue
		for a in def.get("actions", []):
			if str(a.get("op", "")) != "damage":
				continue
			var spec: Dictionary = a.get("target", {}) if a.get("target", null) is Dictionary else {}
			var kind := str(spec.get("kind", ""))
			var can_hit_king: bool = kind == "enemyKing" or kind == "chosenKing" or kind == "king" \
				or (kind == "chosenEnemyTarget" and spec.get("allowKing", true) != false)
			if not can_hit_king:
				continue
			sum += float(a.amount) if (a.get("amount", null) is float or a.get("amount", null) is int) else 2.0
	return sum


## 对面下一回合能打掉我多少国王血 = 他手上的直伤 + 他空线白打脸的攻击力
func incoming_threat(side: int) -> Dictionary:
	var foe := 1 - side
	var burst := king_damage_in_hand(foe) + free_lane_damage(foe)
	var king_hp := maxf(1.0, float(g.state.players[side].get("kingHp", 1)))
	return {"burst": burst, "lethal": burst >= king_hp, "half": burst * 2.0 >= king_hp}


## 我这一回合能打掉对面多少国王血
func my_burst(side: int) -> float:
	return king_damage_in_hand(side) + free_lane_damage(side)


# ══════════════════════════════════════════════════════════
# 单位落点评分
# ══════════════════════════════════════════════════════════

func score_unit_placement(side: int, def: Dictionary, lane: String, row: String) -> float:
	var st: Dictionary = g.state
	var foe := 1 - side
	var foe_front = st.board[lane].units[foe].front
	var my_front = st.board[lane].units[side].front
	var def_atk := float(def.get("atk", 0))
	var def_hp := float(def.get("hp", 0))
	var score := def_atk * 1.0 + def_hp * float(P.wHp) - float(def.get("cost", 0)) * 0.25

	if row == "front":
		score += float(P.wFront)
		if foe_front != null and my_front == null:
			score += float(P.wBlockUrgent)
		if foe_front != null:
			var dmg := effective_damage(def, foe_front)
			if dmg >= float(foe_front.hp):
				score += float(P.wTradeKill) + threat_of(foe_front) * float(P.wThreat)
			elif dmg > 0.0:
				score += threat_of(foe_front) * float(P.wChip)
	else:
		if foe_front == null:
			score += float(P.wBackOpen)
		if def_atk == 0.0:
			score += float(P.wZeroBack)
		if def_hp <= 2.0:
			score += float(P.wSquishyBack)

	if row == "front" and foe_front != null and def_hp <= threat_of(foe_front):
		score += float(P.wFragile)

	if P.get("lookahead", false):
		score -= opponent_best_reply(side, lane, def) * float(P.wLookahead)

	if insight_on():
		var rm := removal_in_hand(1 - side)
		if row == "front":
			if def_hp <= float(rm.maxDmg):
				score -= 2.4
			elif float(rm.maxDmg) > 0.0:
				score += 1.2
			if bool(rm.hasHard) and def_hp <= 3.0:
				score -= 1.4
		elif bool(rm.hasHard) and def_hp >= 5.0:
			score -= 1.0

		var threat := {"lethal": false, "half": false}
		if P.get("insightBlock", true) != false:
			threat = incoming_threat(side)
		if bool(threat.lethal) or bool(threat.half):
			var free := lane_free_damage(1 - side, lane)
			if row == "front" and free > 0.0:
				score += free * (0.8 if bool(threat.lethal) else 0.3) + (2.0 if bool(threat.lethal) else 0.6)

	# 尽量均匀分布，避免一路堆满
	var fill := 0
	for r in KPC.ROWS:
		if st.board[lane].units[side][r] != null:
			fill += 1
	score -= float(fill) * float(P.wSpread)
	return score


# ══════════════════════════════════════════════════════════
# 锦囊目标选择与评分
# ══════════════════════════════════════════════════════════

## 选出这张锦囊的最佳目标。
##   {"skip": true}            → AI 不处理（需要选线路），跳过这张牌
##   {"none": true}            → 无需目标，直接打
##   {"uid": n}                → 指定单位目标
##   {"king": true, "side":n}  → 指定国王
func best_spell_target(side: int, def: Dictionary) -> Dictionary:
	var actions: Array = def.get("actions", [])
	var specs: Array = []
	for a in actions:
		if a.get("target", null) is Dictionary:
			specs.append(a.target)
	if specs.is_empty():
		return {"none": true}
	var needs_lane := false
	for t in specs:
		var k := str(t.get("kind", ""))
		if k == "allEnemyUnitsInLane" or k == "adjacentEnemyUnits":
			needs_lane = true
	if needs_lane:
		return {"skip": true}

	var units: Array = g.all_units()
	var spec: Dictionary = specs[0]
	var foe := 1 - side
	var st: Dictionary = g.state

	var wants_destroy := false
	var damage_amount := 0.0
	var wants_heal := false
	var wants_sacrifice := false
	for a in actions:
		var op := str(a.get("op", ""))
		if op == "destroy":
			wants_destroy = true
		elif op == "damage" and damage_amount == 0.0:
			if a.get("amount", null) is float or a.get("amount", null) is int:
				damage_amount = float(a.amount)
		elif op == "heal":
			wants_heal = true
		elif op == "sacrifice":
			wants_sacrifice = true

	var kind := str(spec.get("kind", ""))
	if kind == "chosenEnemyUnit" or kind == "chosenEnemyFront" or kind == "chosenEnemyTarget":
		var allow_king: bool = kind == "chosenEnemyTarget" and spec.get("allowKing", true) != false
		var cands: Array = []
		for u in units:
			if u.get("removed", false) or int(u.side) != foe:
				continue
			if kind == "chosenEnemyFront" and str(u.row) != "front":
				continue
			if not g.matches_target_filter(u, spec.get("filter", null), g.filter_ctx()):
				continue
			if spec.get("controlRoom", null) != null and g.find_control_spot(u, side) == null:
				continue
			cands.append(u)

		var scored: Array = []
		for u in cands:
			var s := threat_of(u) * 1.0 + float(u.hp) * 0.4 * float(P.get("defense", 1.0))
			if wants_destroy:
				s += 6.0
			if damage_amount > 0.0:
				if damage_amount >= float(u.hp):
					s += 5.0
				else:
					s -= (float(u.hp) - damage_amount) * 1.2
			if str(u.row) == "back":
				s += 0.8
			scored.append({"target": {"uid": int(u.uid)}, "score": s})

		if allow_king and damage_amount > 0.0:
			var king_hp := float(st.players[foe].kingHp)
			var s2 := damage_amount * 0.9
			if damage_amount >= king_hp:
				s2 += 25.0
			elif king_hp - damage_amount <= 3.0:
				s2 += 5.0
			if insight_on() and P.get("insightBurst", true) != false:
				var burst := my_burst(side)
				if burst >= king_hp:
					s2 += 16.0
				elif burst + 3.0 >= king_hp:
					s2 += 4.0
			scored.append({"target": {"king": true, "side": foe}, "score": s2})

		if scored.is_empty():
			return {"none": true}
		scored.sort_custom(func(a, b): return float(a.score) > float(b.score))
		if float(scored[0].score) > 0.0:
			return scored[0].target
		return {"none": true}

	if kind == "chosenOwnUnit":
		var mine: Array = []
		for u in units:
			if u.get("removed", false) or int(u.side) != side:
				continue
			mine.append(u)
		if mine.is_empty():
			return {"skip": true} if wants_sacrifice else {"none": true}
		var best = null
		var best_score := -INF
		for u in mine:
			var s := 0.0
			if wants_heal:
				s = (float(u.maxHp) - float(u.hp)) * 2.0 - float(u.hp) * 0.1
			elif wants_sacrifice:
				s = -(float(u.atk) * 1.0 + float(u.hp) * 0.6)
			else:
				s = float(u.atk) * 1.0 + float(u.hp) * 0.5
			if insight_on() and not wants_sacrifice:
				var rm_foe := removal_in_hand(foe)
				if bool(rm_foe.hasHard) and float(u.hp) >= 4.0:
					s -= 3.0
				elif float(rm_foe.maxDmg) >= float(u.hp):
					s -= 1.5
			if s > best_score:
				best_score = s
				best = u
		return {"uid": int(best.uid)}

	return {"none": true}


## 锦囊整体价值评分（target 是 best_spell_target 的返回值）
func score_spell(side: int, def: Dictionary, target: Variant) -> float:
	var st: Dictionary = g.state
	var units: Array = g.all_units()
	var score := -float(def.get("cost", 0)) * 0.35
	var threat = null
	if insight_on() and P.get("insightSpell", true) != false:
		threat = incoming_threat(side)
	var t_king: bool = target is Dictionary and target.get("king", false)
	var t_uid: int = int(target.uid) if (target is Dictionary and target.get("uid", null) != null) else -1

	for a in def.get("actions", []):
		var op := str(a.get("op", ""))
		var amt := float(a.amount) if (a.get("amount", null) is float or a.get("amount", null) is int) else 2.0
		match op:
			"damage":
				score += amt * 0.85
				if t_king:
					var king_hp := float(st.players[int(target.side)].kingHp)
					if amt >= king_hp:
						score += 14.0
					elif king_hp - amt <= 3.0:
						score += 3.0
				elif t_uid >= 0:
					var t = null
					for u in units:
						if int(u.uid) == t_uid:
							t = u
							break
					if t != null and amt >= float(t.hp):
						score += 4.0
					if threat != null and bool(threat.lethal):
						score += 2.0
					elif threat != null and bool(threat.half):
						score += 0.8
			"destroy":
				score += 6.5
				if threat != null and bool(threat.lethal):
					score += 2.5
				elif threat != null and bool(threat.half):
					score += 1.0
			"draw": score += amt * 2.6
			"gainManaCap": score += amt * 3.2
			"gainMana": score += amt * 1.5
			"heal": score += amt * 0.5
			"sacrifice": score -= 3.5
			"control":
				score += 5.5
				if t_uid >= 0:
					for u in units:
						if int(u.uid) == t_uid:
							score += threat_of(u) * 0.55
							break
			"duel": score += 3.2
			"summonToHand": score += 1.6
			"buffAtk", "buffMaxHp": score += amt * 1.2
			"modifyStats":
				score += (absf(float(a.get("atk", 0))) + absf(float(a.get("maxHp", 0)))) * 1.1
			"attachKingEffect": score += 3.0
			"extraAttack", "summonRandomToken": score += 2.6
			"endTurnNow": pass
			"setStats": score += 1.0
			"seal": score += 1.8
			"grantKeyword":
				var good := ["invincible", "rebirth", "pierce", "frenzy", "doubleStrike", "firstStrike", "splash"]
				var bad := ["disease", "rooted"]
				var kwid := str(a.get("keyword", ""))
				if good.has(kwid):
					score += 3.2
				elif bad.has(kwid):
					score += 2.4
				else:
					score += 1.6
			"bounce": score += 3.4
			"freeze": score += 2.2
			"move": score += 0.8
			"discard": score -= amt * 1.2
			"returnToDeck": score += 0.6
			"discardDrawn": score += 1.4
			"lockLane": score += 2.0
			"summon": score += 2.6
			"stealToHand": score += 5.0
			"modifyHandCost": score -= amt * 0.8
			_: pass
	return score


# ══════════════════════════════════════════════════════════
# 「拟定目标攻击」：AI 自己挑打谁
# ══════════════════════════════════════════════════════════

func _target_picker(unit: Variant, _foe: int, options: Array) -> Variant:
	if unit == null or options.is_empty():
		return null
	var atk := g.effective_atk(unit)
	var best = null
	var best_hp := -1.0
	for o in options:
		if o.get("king", false) or o.get("uid", null) == null:
			continue
		if o.get("hp", null) == null:
			continue
		var hp := float(o.hp)
		if atk >= hp and hp > best_hp:
			best_hp = hp
			best = o
	if best != null:
		return best
	for o in options:
		if o.get("king", false):
			return o
	return options[0] if not options.is_empty() else null


## 把 AI 的挑目标策略装到这一局上（建局时调一次）
func install_target_picker() -> void:
	if g != null:
		g.state["targetPicker"] = Callable(self, "_target_picker")


# ══════════════════════════════════════════════════════════
# 引擎中途反问的每一问
# ══════════════════════════════════════════════════════════

func unit_atk(u: Variant) -> float:
	return g.effective_atk(u) if u != null else 0.0


func unit_threat(u: Variant) -> float:
	if u == null:
		return 0.0
	return unit_atk(u) + float(u.hp) * 0.4 + (0.8 if str(u.row) == "back" else 0.0)


func hand_card_worth(hc: Dictionary) -> float:
	return card_hand_value(g.state.cardLib.get(hc.cardId, null))


## 我方这一条线上「对面一根毛都没有」= 放上去就能白打脸
func lane_open_for(lane: String, side: int) -> bool:
	return lane_free_damage(side, lane) > 0.0


## 一条线上敌方单位的威胁合计
func lane_enemy_weight(lane: String, side: int) -> float:
	var foe := 1 - side
	var row: Dictionary = g.state.board[lane].units
	var theirs: Dictionary = row[foe]
	var sum := 0.0
	for r in ["front", "back"]:
		var u = theirs[r]
		if u != null and not u.get("removed", false):
			sum += unit_threat(u)
	return sum


func _unit_by_uid(units: Array, uid: int) -> Variant:
	for u in units:
		if int(u.uid) == uid:
			return u
	return null


## chooseUnit：我方目标挑最不心疼的（多半是代价），敌方挑威胁最大的
func choose_unit_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var units: Array = g.all_units()
	var mine: Array = []
	var theirs: Array = []
	for o in options:
		var u = _unit_by_uid(units, int(o.get("uid", -1)))
		if u == null or u.get("removed", false):
			continue
		if int(u.side) == side:
			mine.append(o)
		else:
			theirs.append(o)
	if not mine.is_empty() and not theirs.is_empty():
		return _pick_threat(units, theirs, true) if not theirs.is_empty() else options[0]
	if not theirs.is_empty():
		return _pick_threat(units, theirs, true)
	if not mine.is_empty():
		return _pick_threat(units, mine, false)
	return options[0]


func _pick_threat(units: Array, list: Array, want_max: bool) -> Variant:
	var best = null
	var best_score := -INF if want_max else INF
	for o in list:
		var u = _unit_by_uid(units, int(o.get("uid", -1)))
		if u == null or u.get("removed", false):
			continue
		var s := unit_threat(u)
		if (want_max and s > best_score) or (not want_max and s < best_score):
			best = o
			best_score = s
	return best


## chooseEnemyTarget：能一刀打死国王就先打脸，否则按单位威胁挑
func choose_enemy_target_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var foe := 1 - side
	var units: Array = g.all_units()
	var best = null
	var best_score := -INF
	for o in options:
		var s := 0.0
		if o.get("king", false):
			var hp := float(g.state.players[foe].kingHp)
			s = 6.0 + maxf(0.0, 12.0 - hp) * 0.8
		else:
			s = unit_threat(_unit_by_uid(units, int(o.get("uid", -1))))
		if s > best_score:
			best_score = s
			best = o
	return best if best != null else options[0]


## chooseLane：范围效果选敌方单位最多的线；「移到」选能白打脸的线
func choose_lane_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var prompt := str(request.get("prompt", ""))
	var moving := prompt.find("移到") >= 0
	var best = null
	var best_score := -INF
	for o in options:
		var lane := str(o.get("lane", ""))
		var s := 0.0
		if moving:
			s = lane_free_damage(side, lane) * 1.2 + lane_free_damage(1 - side, lane) * 1.0
		else:
			s = lane_enemy_weight(lane, side)
			if s == 0.0:
				s = 0.2
		if s > best_score:
			best_score = s
			best = o
	return best if best != null else options[0]


## chooseHandCard：弃 / 洗回最不值钱的那张
func choose_hand_card_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var hand: Array = g.state.players[side].get("hand", [])
	var best = null
	var best_worth := INF
	for o in options:
		var hc = null
		for c in hand:
			if int(c.iid) == int(o.get("iid", -1)):
				hc = c
				break
		var w := hand_card_worth(hc) if hc != null else 0.0
		if w < best_worth:
			best_worth = w
			best = o
	return best if best != null else options[0]


## 「抉择」：把每个分支的成本算出来，挑净收益最高的
func option_branch_value(actions: Array, side: int, depth: int) -> float:
	if depth > 3:
		return 0.0
	var v := 0.0
	for a in actions:
		var op := str(a.get("op", ""))
		var raw = a.get("amount", null)
		var is_num: bool = raw is float or raw is int
		match op:
			"damage":
				var amount := float(raw) if is_num else 2.0
				var spec: Dictionary = a.get("target", {}) if a.get("target", null) is Dictionary else {}
				var kind := str(spec.get("kind", ""))
				if kind == "ownKing":
					v -= amount * 3.2
				elif kind == "enemyKing":
					v += amount * 1.4
					if amount >= float(g.state.players[1 - side].kingHp):
						v += 20.0
				elif kind == "allEnemyUnits":
					v += amount * 1.1
				elif kind == "allOwnUnits":
					v -= amount * 1.1
				else:
					v += amount * 0.9
			"destroy": v += 5.0
			"control": v += 5.5
			"draw": v += (float(raw) if is_num else 1.0) * 2.2
			"heal": v += (float(raw) if is_num else 2.0) * 0.5
			"summon": v += 2.6
			"summonToHand": v += 1.6
			"delayedSummon": v += 1.8
			"taxMana": v -= float(a.get("amount", 1)) * 2.6
			"sacrifice": v -= 3.5
			"buffAtk", "buffMaxHp": v += (float(raw) if is_num else 1.0) * 1.0
			"grantKeyword", "grantKeywordBuff": v += 2.2
			"chooseKeywords": v += 3.0
			"freeze": v += 2.2
			"spellLock": v += 2.0
			"kingInvincible", "kingShield": v += 2.6
			"kingDamageReduce": v += float(a.get("amount", 1)) * 0.8
			"discard": v -= float(a.get("amount", 1)) * 1.2
			"compound", "conditional":
				var sub: Array = []
				if a.get("actions", null) is Array:
					sub = a.actions
				elif a.get("then", null) is Array:
					sub = a.then
				v += option_branch_value(sub, side, depth + 1)
			_: v += 0.2
	return v


func choose_option_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var cur = g.state.players[side].get("currentSpell", null)
	var def = g.state.cardLib.get(str(cur), null) if cur != null else null
	var branches: Array = []
	if def != null:
		_collect_branches(def.get("actions", []), branches)
	var best = options[0]
	var best_score := -INF
	for o in options:
		var br = null
		for b in branches:
			if str(b.get("label", "")) == str(o.get("label", "")):
				br = b
				break
		var s := option_branch_value(br.get("actions", []), side, 0) if br != null else 0.3
		if s > best_score:
			best_score = s
			best = o
	return best


func _collect_branches(acts: Array, out: Array) -> void:
	for a in acts:
		var op := str(a.get("op", ""))
		if op == "choose":
			for o in a.get("options", []):
				out.append(o)
		elif op == "compound":
			if a.get("actions", null) is Array:
				_collect_branches(a.actions, out)
		elif op == "conditional":
			if a.get("then", null) is Array:
				_collect_branches(a.then, out)
			if a.get("else", null) is Array:
				_collect_branches(a.else, out)


## summonCell：优先「对面这条线没单位」的格子，其次对面这条线最弱的
func choose_summon_cell_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var best = null
	var best_score := -INF
	for o in options:
		if o.get("lane", null) == null:
			continue
		var lane := str(o.lane)
		var open_bonus := 3.0 if lane_open_for(lane, side) else 0.0
		var bias := 0.15 if str(o.get("label", "")).find("前排") >= 0 else 0.0
		var s := open_bonus - lane_enemy_weight(lane, side) * 0.5 + bias
		if s > best_score:
			best_score = s
			best = o
	return best if best != null else options[0]


## chooseRawMaterial：挑「手里已经有同一张」的原料（能立刻成对）
func choose_raw_material_answer(request: Dictionary) -> Variant:
	var options: Array = request.get("options", [])
	if options.is_empty():
		return null
	if options.size() == 1:
		return options[0]
	var side: int = 1 if int(request.get("side", 0)) == 1 else 0
	var hand: Array = g.state.players[side].get("hand", [])
	var in_hand: Array = []
	for c in hand:
		in_hand.append(str(c.cardId))
	var best = options[0]
	var best_score := -INF
	for o in options:
		var s := 3.0 if in_hand.has(str(o.get("cardId", ""))) else 0.0
		for combo_key in KPGame.RAW_COMBOS.keys():
			if str(combo_key).split("+").has(str(o.get("cardId", ""))):
				s += 0.2
		if s > best_score:
			best_score = s
			best = o
	return best


## 统一入口：遇到不认识的问题返回 null（引擎会退回自己的兜底口径）
func ai_choose(request: Dictionary) -> Variant:
	if request == null:
		return null
	if request.get("choose", null) is Callable:
		return null
	match str(request.get("type", "")):
		"chooseUnit":
			return choose_unit_answer(request)
		"chooseEnemyTarget":
			return choose_enemy_target_answer(request)
		"chooseLane":
			return choose_lane_answer(request)
		"chooseHandCard":
			return choose_hand_card_answer(request)
		"chooseOption":
			return choose_option_answer(request)
		"summonCell":
			return choose_summon_cell_answer(request)
		"chooseRawMaterial":
			return choose_raw_material_answer(request)
		_:
			return null


func _chooser(request: Dictionary) -> Variant:
	return ai_choose(request)


# ══════════════════════════════════════════════════════════
# 炼金阵营的炼药
# ══════════════════════════════════════════════════════════

## 返回这次真正消耗掉的 iid 列表（没炼就返回 null）
func try_alchemy_brew(side: int) -> Variant:
	var st: Dictionary = g.state
	var p: Dictionary = st.players[side]
	if str(p.get("faction", "")) != "alchemy":
		return null
	var mats: Array = []
	for hc in p.get("hand", []):
		var def = st.cardLib.get(hc.cardId, null)
		if def != null and g.is_raw_material(def):
			mats.append(hc)
	var n := mats.size()
	if n < 2 or n > 12:
		return null
	var best = null
	for mask in range(1, 1 << n):
		var picked: Array = []
		for i in n:
			if mask & (1 << i) != 0:
				picked.append(mats[i])
		if picked.size() < 2 or picked.size() > 4:
			continue
		var ids: Array = []
		for it in picked:
			ids.append(str(it.cardId))
		var token = g.combo_token_for(ids)
		if token == null:
			continue
		var cost := 0.0
		for it in picked:
			cost += g.cost_of(it)
		if cost > float(p.get("mana", 0)):
			continue
		var tdef: Dictionary = st.cardLib.get(str(token), {})
		var score := float(tdef.get("cost", 0)) * 2.0 + float(tdef.get("actions", []).size())
		if best == null or score > float(best.score):
			var iids: Array = []
			for it in picked:
				iids.append(int(it.iid))
			best = {"score": score, "iids": iids}
	if best == null:
		return null
	var res = await g.brew(side, best.iids)
	if res is Dictionary and res.get("error", null) != null:
		return null
	return best.iids


# ══════════════════════════════════════════════════════════
# 白打脸 / 局面评估
# ══════════════════════════════════════════════════════════

## 单条线「对面没有阻挡」时，att_side 能直接打到国王的攻击力
func lane_free_damage(att_side: int, lane: String) -> float:
	var board: Dictionary = g.state.get("board", {})
	if not board.has(lane):
		return 0.0
	var row: Array = board[lane].units
	var mine: Dictionary = row[att_side]
	var theirs: Dictionary = row[1 - att_side]
	if theirs.get("front", null) != null or theirs.get("back", null) != null:
		return 0.0
	var sum := 0.0
	for r in ["front", "back"]:
		var u = mine.get(r, null)
		if u != null and not u.get("removed", false):
			sum += g.effective_atk(u)
	return sum


func free_lane_damage(att_side: int) -> float:
	var sum := 0.0
	for lane in KPC.LANES:
		sum += lane_free_damage(att_side, lane)
	return sum


## 局面评估：从 side 的角度看，正数代表优势
func eval_position(side: int, W: Dictionary = {}) -> float:
	var st: Dictionary = g.state
	var weights: Dictionary = P if W.is_empty() else W
	var foe := 1 - side
	if st.get("winner", null) != null:
		if int(st.winner) == side:
			return 1000.0
		if int(st.winner) == foe:
			return -1000.0
	var mine: Dictionary = st.players[side]
	var theirs: Dictionary = st.players[foe]
	var v := (float(mine.kingHp) - float(theirs.kingHp)) * float(weights.get("wKing", 2.4))
	v += (float(mine.get("hand", []).size()) - float(theirs.get("hand", []).size())) * float(weights.get("wHand", 0.6))
	v += (float(mine.get("mana", 0)) - float(theirs.get("mana", 0))) * 0.3
	var w_atk := float(weights.get("wAtk", 1.0))
	var w_hp := float(weights.get("wHpEval", 0.6))
	for u in g.all_units():
		if u.get("removed", false):
			continue
		var val := g.effective_atk(u) * w_atk + float(u.hp) * w_hp + (0.8 if str(u.row) == "front" else 0.2)
		v += val if int(u.side) == side else -val
	v += free_lane_damage(side) * float(weights.get("wFreeMine", 1.0))
	v -= free_lane_damage(foe) * float(weights.get("wFreeFoe", 1.6))
	if weights.get("insight", null) != null and weights.get("insightEval", true) != false:
		v += (hand_value(side) - hand_value(foe)) * float(weights.get("wHandValue", 0.5))
		v += (card_hand_value(next_draw_card(side)) - card_hand_value(next_draw_card(foe))) * float(weights.get("wNextDraw", 0.4))
	return v


# ══════════════════════════════════════════════════════════
# 「不可能」：模拟前瞻
# ══════════════════════════════════════════════════════════

## 深拷贝一份 state 用来推演
func _clone_state() -> Dictionary:
	var src: Dictionary = g.state
	var c: Dictionary = {}
	for k in src.keys():
		var v = src[k]
		if k == "cardLib" or k == "targetPicker":
			c[k] = v
		elif k == "chooser" or k == "chooserRecords":
			continue
		elif JOURNAL_KEYS.has(k):
			c[k] = [] if v is Array else v
		elif k == "rng":
			var r := RNG.new(0)
			r.state = int(src.rng.state)
			c[k] = r
		elif k == "pending":
			c[k] = v
		else:
			c[k] = _clone_value(v)
	c["humanSide"] = -1
	c["autoResolveChoices"] = true
	return c


static func _clone_value(v: Variant) -> Variant:
	if v == null:
		return null
	if v is Dictionary:
		var o: Dictionary = {}
		for k in v.keys():
			var x = v[k]
			o[k] = x if x is Callable else _clone_value(x)
		return o
	if v is Array:
		var a: Array = []
		a.resize(v.size())
		for i in v.size():
			var x = v[i]
			a[i] = x if x is Callable else _clone_value(x)
		return a
	return v


## 造一个推演用的克隆 AI（克隆体自己那份 chooser，绝不拿真棋盘判）
func _make_sim():
	var g2 := KPGame.create({})
	g2.state = _clone_state()
	var ai2 = get_script().new(g2, "hard", {})
	if P.get("smartChoices", false):
		g2.state["chooser"] = Callable(ai2, "_chooser")
	return ai2


## 在克隆体上往下推 steps 步（含双方回合与开战结算）
func sim_forward(steps: int) -> void:
	for n in steps:
		if g.state.get("winner", null) != null:
			break
		if g.has_pending():
			break
		var actor = g.get_actor()
		if actor == null:
			await g.advance()
			continue
		await take_turn(int(actor), 6)
		await g.advance()


## 推演「打出这个候选」之后的局面分
func rollout_score(side: int, cand: Dictionary, steps: int) -> float:
	var ai2 = _make_sim()
	var ok: bool = await ai2.g.play_card(side, int(cand.iid), cand.opts)
	if not ok:
		return -INF
	await ai2.sim_forward(steps)
	return ai2.eval_position(side, P)


## 推演「这一手先不出（留手）」之后的局面分
func rollout_pass_score(side: int, steps: int) -> float:
	var ai2 = _make_sim()
	await ai2.sim_forward(steps)
	return ai2.eval_position(side, P)


## 用某一档把前 K 个候选各推演一遍
func rollout_at_level(side: int, candidates: Array, lv_idx: int, cache: Variant = null) -> Dictionary:
	var lv: Dictionary = PLAN_LEVELS[lv_idx]
	var k: int = mini(int(lv.k), candidates.size())
	var usable = null
	if cache is Dictionary and int(cache.get("steps", -1)) == int(lv.steps):
		usable = cache
	var best = candidates[0]
	var best_score := -INF
	for i in k:
		var c = candidates[i]
		var s := 0.0
		if usable != null and i < usable.scores.size():
			s = float(usable.scores[i])
		else:
			s = await rollout_score(side, c, int(lv.steps))
			if usable != null:
				usable.scores.append(s)
		# 推演分相同时取贪心分更高的那个（候选已按贪心分降序）
		if s > best_score + 1e-9:
			best_score = s
			best = c
	return {"best": best, "bestScore": best_score}


## 在贪心评分最高的前几个候选里，挑推演后局面最好的那个
func plan_rollout(side: int, candidates: Array, deadline_ms: int) -> Dictionary:
	if P.get("planLevel", null) != null:
		var idx: int = clampi(int(P.planLevel), 0, PLAN_LEVELS.size() - 1)
		var r := await rollout_at_level(side, candidates, idx)
		r["level"] = idx
		return r

	var budget := int(P.get("planBudgetMs", 0))
	if budget <= 0 or deadline_ms <= 0:
		var r0 := await rollout_at_level(side, candidates, 0)
		r0["level"] = 0
		return r0

	# 第一档既出结果、也量一下这台机器有多快，再按「算力 ≈ K × 步数」预估更高的档
	var t0 := Time.get_ticks_msec()
	var cache: Dictionary = {"steps": int(PLAN_LEVELS[0].steps), "scores": []}
	var base := await rollout_at_level(side, candidates, 0, cache)
	var dt0 := maxi(Time.get_ticks_msec() - t0, 1)
	var unit0 := int(PLAN_LEVELS[0].k) * int(PLAN_LEVELS[0].steps)
	var pick := 0
	for i in range(1, PLAN_LEVELS.size()):
		var est := int(float(dt0) * float(int(PLAN_LEVELS[i].k) * int(PLAN_LEVELS[i].steps)) / float(unit0))
		if Time.get_ticks_msec() + est > deadline_ms:
			break
		pick = i
	if pick == 0:
		base["level"] = 0
		return base
	var r2 := await rollout_at_level(side, candidates, pick, cache)
	r2["level"] = pick
	return r2


# ══════════════════════════════════════════════════════════
# 主入口
# ══════════════════════════════════════════════════════════

## 打完这一方的行动阶段。返回 {count, actions}
func take_turn(side: int, max_plays: int = 8) -> Dictionary:
	var deadline := 0
	if int(P.get("planBudgetMs", 0)) > 0:
		deadline = Time.get_ticks_msec() + int(P.get("planBudgetMs", 0))

	var use_chooser: bool = bool(P.get("smartChoices", false)) and P.get("chooser", true) != false
	if not use_chooser:
		return await _run_turn(side, max_plays, deadline)

	# 只在这一回合里装上 AI 自己的 chooser，走时原样还原
	var st: Dictionary = g.state
	var had_chooser: bool = st.has("chooser")
	var prev_chooser = st.get("chooser", null)
	var had_rec: bool = st.has("chooserRecords")
	var prev_rec = st.get("chooserRecords", false)
	st["chooser"] = Callable(self, "_chooser")
	st["chooserRecords"] = true
	var res = await _run_turn(side, max_plays, deadline)
	if had_chooser:
		st["chooser"] = prev_chooser
	else:
		st.erase("chooser")
	if had_rec:
		st["chooserRecords"] = prev_rec
	else:
		st.erase("chooserRecords")
	return res


func _run_turn(side: int, max_plays: int, plan_deadline: int) -> Dictionary:
	var st: Dictionary = g.state
	var played := 0
	var actions: Array = []
	var brews := 0

	while played < max_plays:
		# 炼金：能凑出组合就先把原料炼掉（一回合最多两次）
		if brews < 2:
			var used = await try_alchemy_brew(side)
			if used != null:
				brews += 1
				actions.append({"brew": used})
				continue

		var plays: Array = g.get_legal_plays(side)
		if plays.is_empty():
			break

		var candidates: Array = []
		var ci := 0
		for play in plays:
			var def = st.cardLib.get(play.cardId, null)
			if def == null:
				continue
			if str(def.get("type", "")) == "unit":
				for place in play.places:
					candidates.append({
						"iid": int(play.iid),
						"opts": {"lane": place.lane, "row": place.row},
						"score": score_unit_placement(side, def, str(place.lane), str(place.row)),
						"idx": ci,
					})
					ci += 1
			else:
				if bool(P.get("noSpells", false)):
					continue
				var target := best_spell_target(side, def)
				if bool(target.get("skip", false)):
					continue
				var opts: Dictionary = {}
				if bool(target.get("king", false)):
					opts = {"targetKing": true}
				elif target.get("uid", null) != null:
					opts = {"targetUid": int(target.uid)}
				candidates.append({
					"iid": int(play.iid),
					"opts": opts,
					"score": score_spell(side, def, target),
					"idx": ci,
				})
				ci += 1

		if candidates.is_empty():
			break

		# 加一点随机，避免每局完全一样（难度越高噪声越小）
		var jitter := float(P.get("jitter", 0.0))
		if jitter > 0.0:
			var noise := float(int(st.rng.state) % 100) / 1000.0 * jitter
			for c in candidates:
				c["score"] = float(c.score) + noise
		candidates.sort_custom(func(a, b):
			if absf(float(a.score) - float(b.score)) < 1e-12:
				return int(a.idx) < int(b.idx)
			return float(a.score) > float(b.score))

		var pick = candidates[0]
		var plan = null
		if str(P.get("planner", "")) == "rollout":
			plan = await plan_rollout(side, candidates, plan_deadline)
		if plan != null:
			pick = plan.best
			if bool(P.get("rolloutPass", false)):
				var steps: int = int(PLAN_LEVELS[int(plan.level)].steps)
				var pass_score := await rollout_pass_score(side, steps)
				if pass_score > float(plan.bestScore) + float(P.get("passMargin", 0.0)):
					break
		elif float(pick.score) < float(P.get("passThreshold", -1.0)):
			break

		var ok: bool = await g.play_card(side, int(pick.iid), pick.opts)
		if not ok:
			break
		played += 1
		actions.append({"iid": int(pick.iid), "opts": pick.opts})

	return {"count": played, "actions": actions}
