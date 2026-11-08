## 王座交锋 · 规则引擎（GDScript 移植版）
##
## 移植自 E:/ka_pai/engine/src/*.js（约 7000 行 JS → 本文件）。
## 与 JS 版的对应关系：
##   constants.js → kp_constants.gd      rng.js → kp_rng.gd
##   其余全部在本文件里，按下面的分节顺序排列：
##
##   §1 建局与基础查询      §2 词条与光环        §3 场地操作
##   §4 伤害管线            §5 属性与牌库        §6 目标选择（DSL）
##   §7 效果动作（DSL）     §8 触发队列与挂起    §9 开战结算
##   §10 出牌与合法性       §11 回合与阶段       §12 阵营 / 靶场 / 视图
##
## ⚠ 为什么全在一个类里：JS 版的模块之间存在环（board ←→ damage、
##   choices ←→ combat）。GDScript 的脚本级循环引用会直接报错，
##   所以这里合成**一个类**，用分节注释保持可读性。
##
## ⚠ generator → 协程：JS 用 generator 让效果「结算到一半停下来问人」，
##   GDScript 没有 generator，这里改用 await + 信号实现（见 §8）。
##   凡是可能挂起的函数都是协程，调用方必须 await。
class_name KPGame
extends RefCounted

const KPC := preload("res://scripts/engine/kp_constants.gd")
const RNG := preload("res://scripts/engine/kp_rng.gd")

# ══════════════════════════════════════════════════════════
# 信号：交互挂起
# ══════════════════════════════════════════════════════════

## 引擎需要玩家做选择时发出。界面收到后渲染选项，玩家点完调 resolve_choice。
signal choice_needed(request: Dictionary)
## 选择被回答（内部用，别直接 emit）
signal _choice_answered()
## 对局状态有变化（界面据此重绘）
signal state_changed()

# ══════════════════════════════════════════════════════════
# §1 建局与基础查询
# ══════════════════════════════════════════════════════════

var state: Dictionary = {}
## 当前挂起的交互请求（null = 没有挂起）
var pending_request: Variant = null
## 最近一次操作失败的原因（界面显示用）
var last_error: String = ""

var _choice_answer: Variant = null


static func make_player(side: int, faction: Variant = null) -> Dictionary:
	return {
		"side": side,
		"kingHp": float(KPC.KING_MAX_HP),
		"kingMaxHp": float(KPC.KING_MAX_HP),
		"mana": 0,
		"manaCap": 0,
		"manaCapBonus": 0,
		"hand": [],
		"kingEffects": [],
		"kingMarks": [],
		"entries": {},
		"faction": faction,
		"superpowers": [],
		"spThresholds": {},
		"usedCount": {},
		"handCostDelta": 0,
		"lastSpell": null,
		"currentSpell": null,
		"kingDamageReduce": null,
	}


static func make_board() -> Dictionary:
	var board := {}
	for lane in KPC.LANES:
		board[lane] = {
			"units": [
				{"front": null, "back": null},
				{"front": null, "back": null},
			],
			"traps": [null, null],
		}
	return board


## 建局。cfg: { seed, firstPlayer, deck, cardLib, shuffleDeck, factions, enhance }
static func create_game(cfg: Dictionary = {}) -> Dictionary:
	var seed_v: int = cfg.get("seed", 20240501)
	var first_player: int = cfg.get("firstPlayer", 0)
	var deck: Array = cfg.get("deck", []).duplicate()
	var card_lib: Dictionary = cfg.get("cardLib", {})
	var shuffle_deck: bool = cfg.get("shuffleDeck", true)
	var factions: Array = cfg.get("factions", [])
	var enhance = cfg.get("enhance", null)

	var rng := RNG.new(seed_v)
	if shuffle_deck:
		rng.shuffle(deck)

	return {
		"seed": seed_v,
		"turn": 0,
		"phase": null,
		"firstPlayer": first_player,
		"players": [
			make_player(0, factions[0] if factions.size() > 0 else null),
			make_player(1, factions[1] if factions.size() > 1 else null),
		],
		"deck": deck,
		"discard": [],
		"board": make_board(),
		"rng": rng,
		"log": [],
		"triggerQueue": [],
		"autoResolveChoices": true,
		"humanSide": 0,
		"targetPicker": null,
		"winner": null,
		"winReason": null,
		"deckEmpty": false,
		"cardLib": card_lib,
		"enhance": normalize_enhance(enhance),
		"stats": {"cardsPlayed": 0, "unitsDestroyed": 0, "killsBySide": [0, 0]},
		"nextUid": 1,
		"nextIid": 1,
		"extraAttackUsed": {},
		"damageCaps": [],
		"delayedSummons": [],
		"delayedDraws": [],
		"combatPlans": {},
		"combatTargetAsked": {},
		"laneLocks": {},
		"_pendingDeaths": [],
	}


## 创建并返回一个绑定好 state 的引擎实例
static func create(cfg: Dictionary = {}) -> KPGame:
	var g := KPGame.new()
	g.state = create_game(cfg)
	return g


# ── 日志 ──────────────────────────────────────────────────

func log_event(entry: Dictionary) -> void:
	var e := entry.duplicate()
	e["turn"] = state.turn
	e["phase"] = state.phase
	state.log.append(e)


## 判断两个对象是不是**同一个**（GDScript 的 == 对字典是深比较，这里要的是引用相等）
static func same(a: Variant, b: Variant) -> bool:
	if a == null or b == null:
		return a == null and b == null
	return is_same(a, b)


static func idx_of_ident(arr: Array, item: Variant) -> int:
	for i in arr.size():
		if same(arr[i], item):
			return i
	return -1


static func has_ident(arr: Array, item: Variant) -> bool:
	return idx_of_ident(arr, item) >= 0


# ── 单位查询 ──────────────────────────────────────────────

func find_unit(uid: int) -> Variant:
	for lane in KPC.LANES:
		for side in 2:
			for row in KPC.ROWS:
				var u = state.board[lane].units[side][row]
				if u != null and int(u.uid) == uid:
					return u
	return null


## 某条线路上某一方的全部单位，顺序固定为 前排 → 后排
func lane_units(lane: String, side: int) -> Array:
	var slot: Dictionary = state.board[lane].units[side]
	var out: Array = []
	for row in KPC.ROWS:
		if slot[row] != null:
			out.append(slot[row])
	return out


func all_units_in_lane(lane: String) -> Array:
	var out: Array = lane_units(lane, 0)
	out.append_array(lane_units(lane, 1))
	return out


func all_units() -> Array:
	var out: Array = []
	for lane in KPC.LANES:
		out.append_array(all_units_in_lane(lane))
	return out


func king_hp(side: int) -> float:
	return state.players[side].kingHp


# ══════════════════════════════════════════════════════════
# §2 词条与光环
# ══════════════════════════════════════════════════════════

const KEYWORD_DEFS := {
	"doubleStrike": {"name": "双重打击", "params": false, "kind": "trigger", "note": "交战且未被消灭后，额外再攻击一次"},
	"frenzy": {"name": "狂热", "params": false, "kind": "trigger", "note": "交战并消灭敌方单位且自身存活后，额外再攻击一次"},
	"disease": {"name": "疾病", "params": false, "kind": "trigger", "note": "造成>0伤害后，目标下回合开始时被消灭"},
	"armor": {"name": "装甲", "params": true, "kind": "replace", "note": "受到伤害时减少X"},
	"thorns": {"name": "荆棘", "params": true, "kind": "trigger", "note": "受到伤害时对来源造成X点伤害"},
	"blessing": {"name": "祝福", "params": true, "kind": "replace", "note": "受到伤害时若伤害>X则设为X"},
	"aquatic": {"name": "水生", "params": false, "kind": "restrict", "note": "只能在水路打出"},
	"amphibious": {"name": "两栖", "params": false, "kind": "restrict", "note": "可在水路打出"},
	"nimble": {"name": "轻灵", "params": false, "kind": "static", "note": "生命≥生命上限一半时获得两栖，否则失去两栖；失去时若在水路则被消灭"},
	"spellImmune": {"name": "锦囊免疫", "params": false, "kind": "static", "note": "无法作为锦囊牌的目标"},
	"crit": {"name": "暴击", "params": true, "kind": "trigger", "note": "造成伤害时50%几率额外造成X点"},
	"rooted": {"name": "扎根", "params": false, "kind": "static", "note": "无法被移动，无法被弹射"},
	"invincible": {"name": "无敌", "params": false, "kind": "static", "note": "无法受到伤害或被弹射；但不免疫「消灭」"},
	"combo": {"name": "组合", "params": false, "kind": "static", "note": "解锁该线路第2个身位（前排1+后排1）"},
	"splash": {"name": "溅射", "params": true, "kind": "trigger", "note": "发动攻击时，对相邻左右各一条线路上的所有敌方单位(含后排)造成X点伤害"},
	"poison": {"name": "淬毒", "params": true, "kind": "trigger", "note": "造成>0伤害时，目标下回合开始时受X点伤害，无视机制（无敌除外）"},
	"burn": {"name": "灼烧", "params": true, "kind": "trigger", "note": "造成>0伤害时，目标下回合开始时受X点伤害（普通伤害）；标记结算一次即消费"},
	"pierce": {"name": "穿透", "params": true, "kind": "trigger", "note": "攻击时额外对本线路X个敌方单位(含后排)造成伤害；不足则溢出打国王"},
	"firstStrike": {"name": "先制", "params": false, "kind": "static", "note": "开战时本单位的伤害先于同线路其他单位结算；被它打死的敌人当回合不反击"},
	"freeze": {"name": "冻结", "params": false, "kind": "static", "note": "被冻结的单位下一次攻击时不进行此次攻击，然后解除冻结。状态型"},
	"hunt": {"name": "捕猎", "params": false, "kind": "trigger", "note": "有敌方单位被打出时，若可能则移动至该单位的线路"},
	"trueStrike": {"name": "必中", "params": false, "kind": "static", "note": "攻击时忽略阻挡，仅攻击国王，且不可被免疫"},
	"rebirth": {"name": "复生", "params": false, "kind": "trigger", "note": "被消灭后，在原处复活一次并失去复生"},
	"fuse": {"name": "融合", "params": false, "kind": "restrict", "note": "可打在友方单位现在的位置上（融合牌自己被消灭、队友留下）"},
	"evolve": {"name": "融合进化", "params": false, "kind": "restrict", "note": "在一个友方单位现在的位置上打出：该友方单位消失，新单位占据这个位置"},
	"cannotAttack": {"name": "无法攻击", "params": false, "kind": "static", "note": "开战时不出手"},
	"trap": {"name": "陷阱", "params": false, "kind": "static", "note": "这张牌是埋伏/反制型"},
}

## 中文名 → 词条 id
static var KEYWORD_BY_NAME: Dictionary = {}


static func _static_init() -> void:
	for id in KEYWORD_DEFS:
		KEYWORD_BY_NAME[KEYWORD_DEFS[id].name] = id


## 「选择词条给队友」这类效果**默认不能选**的词条（作者 2026-11-01）
const KEYWORDS_NOT_GRANTABLE := [
	"invincible", "blessing", "aquatic", "firstStrike", "freeze",
	"fuse", "evolve", "cannotAttack", "trap",
]


## 解析词条写法：{ id, x } / "armor:1" / "armor"
func parse_keyword(raw: Variant) -> Dictionary:
	if raw is Dictionary:
		var id := resolve_keyword_id(str(raw.get("id", "")))
		return {"id": id, "x": float(raw.get("x", 0))}
	var s := str(raw).strip_edges()
	var parts := s.split(":")
	var id2 := resolve_keyword_id(parts[0])
	var x := 0.0
	if parts.size() > 1 and parts[1] != "":
		x = float(parts[1])
	return {"id": id2, "x": x}


func resolve_keyword_id(raw_id: String) -> String:
	var key := raw_id.strip_edges()
	if KEYWORD_DEFS.has(key):
		return key
	if KEYWORD_BY_NAME.has(key):
		return KEYWORD_BY_NAME[key]
	push_error("未知词条: %s" % raw_id)
	return key


func get_kw(unit: Variant, id: String) -> Variant:
	if unit == null:
		return null
	var list = unit.get("keywords", [])
	for k in list:
		if k.id == id:
			return k
	return null


func has_kw(unit: Variant, id: String) -> bool:
	return get_kw(unit, id) != null


## 单位当前是否具有「两栖」（自带 amphibious，或 nimble 且生命 ≥ 上限一半）
func has_amphibious(unit: Variant) -> bool:
	if unit == null or float(unit.hp) <= 0:
		return false
	if has_kw(unit, "amphibious"):
		return true
	if has_kw(unit, "nimble"):
		return float(unit.hp) >= ceilf(float(unit.maxHp) / 2.0)
	return false


func nimble_should_drown(unit: Variant) -> bool:
	return has_kw(unit, "nimble") and unit.lane == "water" and not has_amphibious(unit)


## 放置合法性（规则书 §5.3）
func can_place_in_lane(unit: Variant, lane: String) -> bool:
	if not KPC.LANES.has(lane):
		return false
	if has_kw(unit, "aquatic"):
		return lane == "water"
	if has_amphibious(unit):
		return true
	return not KPC.DEFAULT_FORBIDDEN_LANES.has(lane)


func is_frozen(unit: Variant) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	for m in unit.get("marks", []):
		if m.type == "freeze":
			return true
	return false


func is_untargetable(unit: Variant) -> bool:
	if unit == null:
		return false
	for m in unit.get("marks", []):
		if m.type == "untargetable":
			return true
	return false


## 结算「受到伤害」的替代式修正：无敌 → 0；祝福 X 封顶；装甲 X 减伤。
## opts: ignoreMechanisms / unpreventable / sealed / spellReduce
func compute_final_damage(target: Dictionary, raw: float, opts: Dictionary = {}) -> float:
	if raw <= 0.0:
		return 0.0
	if opts.get("unpreventable", false):
		return raw
	if opts.get("sealed", false):
		return raw
	if has_kw(target, "invincible"):
		return 0.0
	if opts.get("ignoreMechanisms", false):
		return raw

	var amount := raw
	var blessing = get_kw(target, "blessing")
	if blessing != null and amount > float(blessing.x):
		amount = float(blessing.x)
	var armor = get_kw(target, "armor")
	if armor != null:
		amount = maxf(0.0, amount - float(armor.x))
	var spell_reduce: float = opts.get("spellReduce", 0.0)
	if spell_reduce > 0.0:
		amount = maxf(0.0, amount - spell_reduce)
	return amount


## 目标限定条件。ctx 可注入 atkOf / isRooted / costOf / source
func matches_target_filter(unit: Variant, filter: Variant, ctx: Dictionary = {}) -> bool:
	if unit == null:
		return false
	# 「无法选中」：来源必须是它自己才放行
	if is_untargetable(unit) and not same(ctx.get("source", null), unit):
		return false
	if filter == null:
		return true

	if filter is String:
		if filter == "spellTargetable":
			return not has_kw(unit, "spellImmune")
		return true

	if filter.get("spellTargetable", false) and has_kw(unit, "spellImmune"):
		return false

	var atk: float = unit.atk
	if ctx.has("atkOf"):
		atk = ctx.atkOf.call(unit)

	if filter.has("maxAtk") and atk > float(filter.maxAtk):
		return false
	if filter.has("maxCost"):
		var cost := 0.0
		if ctx.has("costOf"):
			cost = ctx.costOf.call(unit)
		if cost > float(filter.maxCost):
			return false
	if filter.has("minAtk") and atk < float(filter.minAtk):
		return false
	if filter.has("maxHp") and float(unit.hp) > float(filter.maxHp):
		return false
	if filter.has("minHp") and float(unit.hp) < float(filter.minHp):
		return false
	if filter.has("row") and unit.row != filter.row:
		return false
	if filter.has("lane") and unit.lane != filter.lane:
		return false
	if filter.has("laneIn") and not filter.laneIn.has(unit.lane):
		return false
	if filter.has("keyword") and not has_kw(unit, str(filter.keyword)):
		return false

	var hurt: bool = float(unit.hp) < float(unit.maxHp)
	if filter.has("damaged") and hurt != bool(filter.damaged):
		return false
	if filter.has("undamaged") and hurt == bool(filter.undamaged):
		return false

	if filter.has("rooted"):
		var is_rooted := has_kw(unit, "rooted")
		if ctx.has("isRooted"):
			is_rooted = ctx.isRooted.call(unit)
		if is_rooted != bool(filter.rooted):
			return false

	return true


# ── 光环 ──────────────────────────────────────────────────

func live_auras() -> Array:
	var out: Array = []
	for source in all_units():
		if source.get("removed", false):
			continue
		if source.get("sealed", false):
			continue
		var def = state.cardLib.get(source.cardId, null)
		if def == null or not def.has("auras"):
			continue
		for aura in def.auras:
			out.append({"source": source, "aura": aura})
	return out


func condition_met(source: Dictionary, condition: Variant) -> bool:
	if condition == null:
		return true
	if condition is String and condition == "noOtherAllies":
		for u in all_units():
			if not same(u, source) and u.side == source.side:
				return false
		return true
	if condition is Dictionary:
		if condition.has("hpAbove"):
			return float(source.hp) > float(condition.hpAbove)
		if condition.has("hpAtLeast"):
			return float(source.hp) >= float(condition.hpAtLeast)
	push_error("未知的光环条件: %s" % str(condition))
	return false


func adjacent_of(lane: String) -> Array:
	return KPC.ADJACENT_LANES.get(lane, [])


func self_and_adjacent_lanes(lane: String) -> Array:
	var out := [lane]
	out.append_array(adjacent_of(lane))
	return out


func applies_to(source: Dictionary, aura: Dictionary, target: Dictionary) -> bool:
	if target.get("removed", false):
		return false
	if not condition_met(source, aura.get("condition", null)):
		return false
	match str(aura.get("to", "")):
		"self":
			return same(target, source)
		"laneEnemies":
			return target.side != source.side and target.lane == source.lane
		"allEnemies":
			return target.side != source.side
		"selfAndAdjacentLaneAllies":
			return target.side == source.side and self_and_adjacent_lanes(source.lane).has(target.lane)
		"laneAllies":
			return target.side == source.side and target.lane == source.lane
		"laneBackRowAllies":
			return target.side == source.side and target.lane == source.lane \
				and target.row == "back" and not same(target, source)
		"rootedEnemies":
			return target.side != source.side and has_ident(rooted_set(), target)
		_:
			push_error("未知的光环作用对象 to: %s" % str(aura.get("to", "")))
			return false


func aura_target_hit(source: Dictionary, aura: Dictionary, target: Dictionary) -> bool:
	match str(aura.get("to", "")):
		"self":
			return same(target, source)
		"laneEnemies":
			return target.side != source.side and target.lane == source.lane
		"allEnemies":
			return target.side != source.side
		"laneAllies":
			return target.side == source.side and target.lane == source.lane
		"laneBackRowAllies":
			return target.side == source.side and target.lane == source.lane \
				and target.row == "back" and not same(target, source)
		"selfAndAdjacentLaneAllies":
			return target.side == source.side and self_and_adjacent_lanes(source.lane).has(target.lane)
		_:
			return false


## 光环授予的词条：返回 [{ unit, kws: [{id,x}] }]
func granted_keyword_map() -> Array:
	var out: Array = []
	for entry in live_auras():
		var source: Dictionary = entry.source
		var aura: Dictionary = entry.aura
		if aura.get("kind", "") != "grantKeyword":
			continue
		if aura.get("to", "") == "rootedEnemies":
			push_error("授予类光环不能以 rootedEnemies 为对象（会无限递归）")
			continue
		if not condition_met(source, aura.get("condition", null)):
			continue
		for target in all_units():
			if target.get("removed", false):
				continue
			if not aura_target_hit(source, aura, target):
				continue
			var rec = _find_map_entry(out, target)
			if rec == null:
				rec = {"unit": target, "kws": []}
				out.append(rec)
			var has := false
			for k in rec.kws:
				if k.id == aura.get("keyword", ""):
					has = true
					break
			if not has:
				rec.kws.append({"id": aura.get("keyword", ""), "x": float(aura.get("x", 0))})
	return out


func _find_map_entry(list: Array, unit: Variant) -> Variant:
	for e in list:
		if same(e.unit, unit):
			return e
	return null


## 单位身上的**全部有效词条** = 自带的 + 光环授予的
func all_keywords_of(unit: Variant) -> Array:
	if unit == null or unit.get("removed", false):
		return []
	if unit.get("sealed", false) or is_sealed_by_aura(unit):
		return []
	var own: Array = unit.get("keywords", []).duplicate(true)
	var rec = _find_map_entry(granted_keyword_map(), unit)
	if rec != null:
		for g in rec.kws:
			var dup := false
			for k in own:
				if k.id == g.id:
					dup = true
					break
			if not dup:
				own.append(g)
	return own


func has_keyword(unit: Variant, id: String) -> bool:
	for k in all_keywords_of(unit):
		if k.id == id:
			return true
	return false


func get_keyword(unit: Variant, id: String) -> Variant:
	for k in all_keywords_of(unit):
		if k.id == id:
			return k
	return null


func aura_sealed_set() -> Array:
	if state.get("_sealedComputing", false):
		return state.get("_sealedCache", [])
	state["_sealedComputing"] = true
	var out: Array = []
	for entry in live_auras():
		var source: Dictionary = entry.source
		var aura: Dictionary = entry.aura
		if aura.get("kind", "") != "seal":
			continue
		if not condition_met(source, aura.get("condition", null)):
			continue
		for target in all_units():
			if target.get("removed", false) or same(target, source):
				continue
			if aura_target_hit(source, aura, target):
				if not has_ident(out, target):
					out.append(target)
	state["_sealedCache"] = out
	state["_sealedComputing"] = false
	return out


func is_sealed_by_aura(unit: Variant) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	return has_ident(aura_sealed_set(), unit)


func rooted_set() -> Array:
	var out: Array = []
	for u in all_units():
		if not u.get("removed", false) and has_kw(u, "rooted"):
			if not has_ident(out, u):
				out.append(u)
	for rec in granted_keyword_map():
		for k in rec.kws:
			if k.id == "rooted":
				if not has_ident(out, rec.unit):
					out.append(rec.unit)
	return out


func has_rooted(unit: Variant) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	if has_kw(unit, "rooted"):
		return true
	return has_ident(rooted_set(), unit)


func aura_atk_delta(unit: Variant) -> float:
	if unit == null or unit.get("removed", false):
		return 0.0
	if unit.get("sealed", false) or is_sealed_by_aura(unit):
		return 0.0
	var delta := 0.0
	for entry in live_auras():
		if entry.aura.get("kind", "") != "buffAtk":
			continue
		if not applies_to(entry.source, entry.aura, unit):
			continue
		delta += float(entry.aura.get("amount", 0))
	return delta


## 单位的**有效攻击力** = 永久值 + 光环修正，且不低于 0。
## 交战、伤害计算、界面显示、AI 评估都必须走这里。
func effective_atk(unit: Variant) -> float:
	if unit == null:
		return 0.0
	if state.get("atkZeroTurn", -1) == state.turn:
		return 0.0
	return maxf(0.0, float(unit.atk) + aura_atk_delta(unit))


## 一个单位这一击的伤害基数（「此攻击使用♥」的单位用当前生命）
func attack_power(unit: Variant) -> float:
	if unit == null:
		return 0.0
	if unit.get("attackWithHp", false):
		return maxf(0.0, float(unit.hp))
	return effective_atk(unit)


## 供 matches_target_filter 用的上下文
func filter_ctx(source: Variant = null) -> Dictionary:
	return {
		"atkOf": func(u): return effective_atk(u),
		"isRooted": func(u): return has_rooted(u),
		"costOf": func(u):
			var def = state.cardLib.get(u.cardId, null) if u != null else null
			return float(def.get("cost", 0)) if def != null else 0.0,
		"source": source,
	}


## 「在场」式属性光环的物化同步（幂等对账）
func sync_stat_auras() -> void:
	if state.get("_syncingAuras", false):
		return
	state["_syncingAuras"] = true
	for unit in all_units():
		if unit.get("removed", false):
			continue
		var want := 0.0
		if not unit.get("sealed", false) and not is_sealed_by_aura(unit):
			for entry in live_auras():
				if entry.aura.get("kind", "") != "buffMaxHp":
					continue
				if not applies_to(entry.source, entry.aura, unit):
					continue
				want += float(entry.aura.get("amount", 0))
		var have := float(unit.get("auraMaxHp", 0.0))
		var diff := want - have
		if diff == 0.0:
			continue
		if diff > 0.0:
			buff_max_hp(unit, diff)
		else:
			debuff_max_hp(unit, -diff)
		if unit.get("removed", false):
			continue
		unit["auraMaxHp"] = want
	state["_syncingAuras"] = false


# ══════════════════════════════════════════════════════════
# §3 场地操作（board.js）
# ══════════════════════════════════════════════════════════

## 普通交战的攻击目标：**前排 → 后排 → 国王**
func enemy_combat_target(lane: String, side: int) -> Variant:
	var foe: Dictionary = state.board[lane].units[1 - side]
	for row in KPC.ROWS:
		var u = foe[row]
		if u == null:
			continue
		if u.get("bypassInCombat", false) or is_untargetable(u):
			continue
		return u
	return null


## 「这张牌将为后方的单位承受伤害」：同线路前排的代收者
func find_bodyguard(unit: Variant) -> Variant:
	if unit == null or unit.get("removed", false) or unit.row != "back":
		return null
	var front = state.board[unit.lane].units[unit.side]["front"]
	if front != null and not same(front, unit) and front.get("bodyguard", false) \
			and not front.get("removed", false):
		return front
	return null


func remove_unit_from_board(unit: Dictionary) -> void:
	var slot: Dictionary = state.board[unit.lane].units[unit.side]
	if slot[unit.row] != null and int(slot[unit.row].uid) == int(unit.uid):
		slot[unit.row] = null


## 「消灭」一个单位（不是伤害，因此可以消灭无敌单位）
func destroy_unit(unit: Variant, reason: String = "destroy") -> void:
	if unit == null or unit.get("removed", false):
		return

	# ── 复生：原处复活、回满血、失去复生，且不触发任何「被消灭」效果
	if has_kw(unit, "rebirth"):
		var kept: Array = []
		for k in unit.keywords:
			if k.id != "rebirth":
				kept.append(k)
		unit["keywords"] = kept
		unit["hp"] = KPC.fix_num(minf(KPC.REBIRTH_HP, float(unit.maxHp)))
		unit["marks"] = []
		unit["lastDamageSource"] = null
		log_event({
			"type": "rebirth", "uid": unit.uid, "cardId": unit.cardId,
			"lane": unit.lane, "row": unit.row, "side": unit.side, "hp": unit.hp, "reason": reason,
		})
		return

	unit["removed"] = true
	remove_unit_from_board(unit)
	state.discard.append(unit.cardId)
	state.stats["unitsDestroyed"] = int(state.stats.get("unitsDestroyed", 0)) + 1
	if not state.stats.has("killsBySide") or state.stats.killsBySide.size() < 2:
		state.stats["killsBySide"] = [0, 0]
	state.stats.killsBySide[1 - int(unit.side)] += 1
	var destroy_name: String = state.cardLib.get(unit.cardId, {}).get("name", unit.cardId)
	log_event({
		"type": "destroy", "uid": unit.uid, "cardId": unit.cardId, "name": destroy_name,
		"lane": unit.lane, "row": unit.row, "side": unit.side, "reason": reason,
	})
	queue_trigger(unit, "onDeath", {"reason": reason})

	# 国王附着的被动
	var owner: Dictionary = state.players[unit.side]
	for eff in owner.get("kingEffects", []):
		if eff.get("trigger", "") == "onFriendlyUnitDestroyed":
			queue_king_trigger(unit.side, "onFriendlyUnitDestroyed", {"unit": unit, "reason": reason})
		if eff.get("trigger", "") == "onAnyUnitDestroyed":
			queue_king_trigger(unit.side, "onAnyUnitDestroyed", {"unit": unit, "reason": reason})
	for side in 2:
		if side == int(unit.side):
			continue
		for eff in state.players[side].get("kingEffects", []):
			if eff.get("trigger", "") == "onAnyUnitDestroyed":
				queue_king_trigger(side, "onAnyUnitDestroyed", {"unit": unit, "reason": reason})

	# 「全场有单位被消灭时」的观察者
	for watcher in all_units():
		if watcher.get("removed", false):
			continue
		if not _has_effect_trigger(watcher, "onAnyUnitDestroyed"):
			continue
		queue_trigger(watcher, "onAnyUnitDestroyed", {"victim": unit, "reason": reason})

	# 献祭：同侧带 onAllySacrificed 的单位也排一个触发
	if reason == "sacrifice":
		for watcher in all_units():
			if watcher.get("removed", false) or watcher.side != unit.side:
				continue
			if not _has_effect_trigger(watcher, "onAllySacrificed"):
				continue
			queue_trigger(watcher, "onAllySacrificed", {"victim": unit})


func _has_effect_trigger(unit: Dictionary, trigger_name: String) -> bool:
	for e in unit.get("effects", []):
		if e.get("trigger", "") == trigger_name:
			return true
	return false


## 主动献祭一名己方单位
func sacrifice_unit_on_board(side: int, uid: int) -> bool:
	var unit = find_unit(uid)
	if unit == null or unit.get("removed", false) or int(unit.side) != side:
		return false
	destroy_unit(unit, "sacrifice")
	return true


## 「使其消失」：离场但**不触发任何被消灭效果**
func vanish_unit(unit: Variant, reason: String = "fuse") -> void:
	if unit == null or unit.get("removed", false):
		return
	unit["removed"] = true
	remove_unit_from_board(unit)
	state.discard.append(unit.cardId)
	log_event({
		"type": "vanish", "uid": unit.uid, "cardId": unit.cardId,
		"lane": unit.lane, "row": unit.row, "side": unit.side, "reason": reason,
	})


## 能不能把 unit 移到 lane（只判定，不改状态）
func can_move_to(unit: Variant, lane: String, opts: Dictionary = {}) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	if not KPC.LANES.has(lane):
		return false
	if unit.lane == lane:
		return false
	if not can_place_in_lane(unit, lane):
		return false

	var rooted: bool = opts.isRooted.call(unit) if opts.has("isRooted") else has_kw(unit, "rooted")
	if rooted:
		return false

	var slot: Dictionary = state.board[lane].units[unit.side]
	if slot[unit.row] != null:
		return false
	var existing: Array = []
	for r in KPC.ROWS:
		if slot[r] != null:
			existing.append(slot[r])
	if existing.size() >= 1:
		var ok := false
		for u in existing:
			if has_kw(u, "combo"):
				ok = true
				break
		if not ok and has_kw(unit, "combo"):
			ok = true
		if not ok:
			return false
	return true


func move_unit_to_lane(unit: Variant, lane: String, opts: Dictionary = {}) -> bool:
	if not can_move_to(unit, lane, opts):
		return false
	var from: String = unit.lane
	remove_unit_from_board(unit)
	unit["lane"] = lane
	state.board[lane].units[unit.side][unit.row] = unit
	log_event({"type": "move", "uid": unit.uid, "from": from, "to": lane, "row": unit.row})
	queue_trigger(unit, "onEnterLane", {"from": from, "lane": lane})
	return true


## 「弹射」——把单位退回其拥有者的手牌（不是消灭）
func bounce_unit(unit: Variant, opts: Dictionary = {}) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	var rooted: bool = opts.isRooted.call(unit) if opts.has("isRooted") else has_kw(unit, "rooted")
	if rooted:
		return false

	var owner: Dictionary = state.players[unit.side]
	var card_id: String = unit.cardId
	var from := {"lane": unit.lane, "row": unit.row}
	var def: Dictionary = state.cardLib.get(card_id, {})
	var keep := {}
	if opts.get("keepStats", false):
		var d_atk: float = float(unit.atk) - float(def.get("atk", 0))
		var d_hp: float = float(unit.maxHp) - float(def.get("hp", 0))
		if d_atk != 0.0:
			keep["atk"] = d_atk
		if d_hp != 0.0:
			keep["maxHp"] = d_hp

	vanish_unit(unit, "bounce")
	var hand_card := {"iid": _next_iid(), "cardId": card_id}
	if keep.has("atk") or keep.has("maxHp"):
		hand_card["statDelta"] = keep
	owner.hand.append(hand_card)
	log_event({"type": "bounce", "cardId": card_id, "side": unit.side, "lane": from.lane, "row": from.row, "keep": keep})
	notify_bounce_watchers(unit)
	return true


func notify_bounce_watchers(bounced: Variant) -> void:
	if bounced == null:
		return
	for watcher in all_units():
		if watcher.get("removed", false):
			continue
		if not _has_effect_trigger(watcher, "onUnitBounced"):
			continue
		queue_trigger(watcher, "onUnitBounced", {"bounced": bounced, "bouncedSide": bounced.side})


## 被控制的单位该落到**控制者**的哪一格
func find_control_spot(unit: Variant, side: int) -> Variant:
	if unit == null or unit.get("removed", false):
		return null
	if not state.board.has(unit.lane):
		return null
	var mine: Dictionary = state.board[unit.lane].units[side]
	var rows: Array = [unit.row]
	for r in KPC.ROWS:
		if r != unit.row:
			rows.append(r)
	if can_place_in_lane(unit, unit.lane):
		for row in rows:
			if mine[row] == null:
				return {"lane": unit.lane, "row": row}
	for lane in KPC.LANES:
		if lane == unit.lane:
			continue
		if not can_place_in_lane(unit, lane):
			continue
		for row in KPC.ROWS:
			if state.board[lane].units[side][row] == null:
				return {"lane": lane, "row": row}
	return null


## 把一名单位「控制」到另一侧（换主人 + 搬过去）
func control_unit(unit: Variant, side: int, opts: Dictionary = {}) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	if int(unit.side) == side:
		return false
	var rooted: bool = opts.isRooted.call(unit) if opts.has("isRooted") else has_kw(unit, "rooted")
	if rooted:
		return false
	var spot = find_control_spot(unit, side)
	if spot == null:
		return false

	var from := {"side": unit.side, "lane": unit.lane, "row": unit.row}
	remove_unit_from_board(unit)
	if not unit.has("charmOrigin"):
		unit["charmOrigin"] = from.side
	unit["side"] = side
	unit["lane"] = spot.lane
	unit["row"] = spot.row
	unit["charmed"] = {"by": side, "cardId": opts.get("cardId", null), "turn": state.turn}
	state.board[spot.lane].units[side][spot.row] = unit
	log_event({
		"type": "control", "uid": unit.uid, "name": unit.name, "cardId": opts.get("cardId", null),
		"from": from, "to": {"lane": spot.lane, "row": spot.row},
	})
	queue_trigger(unit, "onEnterLane", {"from": from.lane, "lane": spot.lane})
	return true


## 把被控制的单位还给**原主人**
func return_controlled_unit(unit: Variant) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	var owner: int = int(unit.get("charmOrigin", unit.side))
	var card_id: String = unit.cardId
	var from := {"lane": unit.lane, "row": unit.row}
	vanish_unit(unit, "control-return")
	state.players[owner].hand.append({"iid": _next_iid(), "cardId": card_id})
	log_event({"type": "control-return", "cardId": card_id, "side": owner, "lane": from.lane, "row": from.row})
	return true


# ── 陷阱 ──────────────────────────────────────────────────

const TRAP_MAX := 2


func is_trap_card(def: Variant) -> bool:
	if def == null:
		return false
	if def.get("type", "") == "trap":
		return true
	for k in def.get("keywords", []):
		var id := ""
		if k is String:
			id = k.split(":")[0]
		elif k is Dictionary:
			id = str(k.get("id", ""))
		if id == "trap":
			return true
	return false


func traps_of(side: int) -> Array:
	var out: Array = []
	for lane in KPC.LANES:
		var t = state.board[lane].traps[side]
		if t != null:
			out.append({"lane": lane, "trap": t})
	return out


func place_trap(side: int, card_id: String, paid: float) -> Variant:
	if traps_of(side).size() >= TRAP_MAX:
		return null
	for lane in KPC.LANES:
		if state.board[lane].traps[side] != null:
			continue
		state.board[lane].traps[side] = {
			"cardId": card_id, "owner": side, "paid": paid,
			"placedTurn": state.turn,
			"phaseKind": "deploy" if str(state.phase).begins_with("DEPLOY") else "spell",
			"revealed": false, "expiresTurn": null,
		}
		log_event({"type": "trap-placed", "side": side, "lane": lane, "cardId": card_id})
		return lane
	return null


func hidden_trap_mana(side: int) -> float:
	var total := 0.0
	for entry in traps_of(side):
		if not entry.trap.get("revealed", false):
			total += float(entry.trap.get("paid", 0))
	return total


## 某个玩家**在敌方视角下**的费用（只给界面显示用）
func visible_mana(side: int) -> float:
	return float(state.players[side].mana) + hidden_trap_mana(side)


## 阶段开始：没触发过的陷阱，到了下一回合的同类型阶段就回手
func return_expired_traps(kind: String) -> void:
	for side in 2:
		for entry in traps_of(side):
			var trap: Dictionary = entry.trap
			if trap.get("revealed", false):
				continue
			if trap.get("phaseKind", "") != kind:
				continue
			if state.turn <= int(trap.get("placedTurn", 0)):
				continue
			state.board[entry.lane].traps[side] = null
			state.players[side].hand.append({"iid": _next_iid(), "cardId": trap.cardId})
			log_event({"type": "trap-returned", "side": side, "lane": entry.lane, "cardId": trap.cardId})


## 回合结束：已经触发过（本回合生效）的陷阱消失
func expire_revealed_traps() -> void:
	for side in 2:
		for entry in traps_of(side):
			var trap: Dictionary = entry.trap
			if not trap.get("revealed", false):
				continue
			if trap.get("expiresTurn", null) != null and state.turn >= int(trap.expiresTurn):
				state.board[entry.lane].traps[side] = null
				log_event({"type": "trap-gone", "side": side, "lane": entry.lane, "cardId": trap.cardId})


## 靶场：把陷阱埋伏到**指定的线路**
func sandbox_plant_trap(side: int, lane: String, card_id: String) -> Variant:
	var p: Dictionary = state.players[side]
	var def = state.cardLib.get(card_id, null)
	if def == null or not state.board.has(lane):
		return null
	var traps: Array = state.board[lane].traps
	traps[side] = {
		"cardId": card_id, "owner": side, "paid": 0,
		"placedTurn": state.turn,
		"phaseKind": "deploy" if str(state.phase).begins_with("DEPLOY") else "spell",
		"revealed": false, "expiresTurn": null,
	}
	log_event({"type": "trap-placed", "side": side, "lane": lane, "cardId": card_id, "sandbox": true})
	return lane


# ══════════════════════════════════════════════════════════
# §4 伤害管线（damage.js）
# ══════════════════════════════════════════════════════════

var _damage_depth: int = 0


func _next_iid() -> int:
	var iid: int = int(state.nextIid)
	state["nextIid"] = iid + 1
	return iid


func _next_uid() -> int:
	var uid: int = int(state.nextUid)
	state["nextUid"] = uid + 1
	return uid


## 冻结一个单位（状态型、不叠加）
func freeze_unit(unit: Variant) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	if is_frozen(unit):
		return false
	unit.marks.append({"type": "freeze", "appliedTurn": state.turn})
	log_event({"type": "freeze", "uid": unit.uid})
	notify_freeze_watchers(unit)
	return true


func notify_freeze_watchers(frozen: Dictionary) -> void:
	for u in all_units():
		if u.side == frozen.side or u.get("removed", false):
			continue
		if not _has_effect_trigger(u, "onEnemyFrozen"):
			continue
		queue_trigger(u, "onEnemyFrozen", {"victim": frozen})


## 开战时结算冻结：摘掉标记、这一批不出手
func consume_freeze(units: Array) -> Array:
	var ready: Array = []
	for u in units:
		if is_frozen(u):
			var kept: Array = []
			for m in u.marks:
				if m.type != "freeze":
					kept.append(m)
			u["marks"] = kept
			log_event({"type": "freeze-skip", "uid": u.uid, "lane": u.lane})
			continue
		ready.append(u)
	return ready


## 造成伤害的对外入口：包一层 depth 计数，最外层退出时同步一次光环数值
func deal_damage(source: Variant, target: Dictionary, raw: float, opts: Dictionary = {}) -> float:
	_damage_depth += 1
	var result := _deal_damage_core(source, target, raw, opts)
	_damage_depth -= 1
	if _damage_depth == 0:
		sync_stat_auras()
	return result


func _deal_damage_core(source: Variant, target: Dictionary, raw: float, opts: Dictionary = {}) -> float:
	if raw <= 0.0:
		return 0.0

	# 「为后方的单位承受伤害」：伤害改由同线路前排的代收者吃下
	if target.get("kind", "") == "unit" and not opts.get("noRedirect", false):
		var bg = find_bodyguard(target.unit)
		if bg != null:
			log_event({"type": "damage-redirect", "from": target.unit.uid, "to": bg.uid, "amount": raw})
			target = {"kind": "unit", "unit": bg}

	# 「无法选中」：不可被敌方锦囊和单位的效果影响
	if target.get("kind", "") == "unit" and is_untargetable(target.unit) \
			and not same(source, target.unit):
		log_event({
			"type": "untargetable-block", "uid": target.unit.uid,
			"from": source.side if source != null else null, "amount": raw,
		})
		return 0.0

	# 陷阱触发
	trigger_trap_on_damage(source, target)

	# 本回合的伤害封顶
	var incoming := raw
	if source != null and not opts.get("noCap", false):
		var cap = damage_cap_for(int(source.side))
		if cap != null and incoming > float(cap):
			log_event({"type": "damage-capped", "from": incoming, "to": cap, "side": source.side})
			incoming = float(cap)

	# 暴击：进入修正链之前加伤
	var amount := incoming
	if source != null and not opts.get("noCrit", false) and not opts.get("noKeywords", false):
		var crit = get_kw(source, "crit")
		var crit_x := float(crit.x) if crit != null else 0.0
		var after = source.get("critAfterTurn", null)
		if after != null and state.turn >= int(after.get("turn", 0)):
			crit_x += float(after.get("x", 0))
		if crit_x > 0.0:
			var p := 1.0 if source.get("critAlways", false) else float(source.get("critChance", 0.5))
			if state.rng.chance(p):
				amount += crit_x
				log_event({"type": "crit", "uid": source.uid, "x": crit_x, "lane": source.lane})

	var is_king: bool = target.get("kind", "") == "king"
	var sealed := false
	var spell_reduce := 0.0
	var final_amount := amount
	if is_king:
		final_amount = amount
	else:
		sealed = bool(target.unit.get("sealed", false)) or is_sealed_by_aura(target.unit)
		if opts.get("fromSpell", false):
			spell_reduce = float(target.unit.get("spellDamageReduce", 0.0))
		var copts := opts.duplicate()
		copts["sealed"] = sealed
		copts["spellReduce"] = spell_reduce
		final_amount = compute_final_damage(target.unit, amount, copts)

	if final_amount <= 0.0:
		log_event({
			"type": "damage-blocked",
			"target": ("king%d" % int(target.side)) if is_king else target.unit.uid,
			"raw": amount,
		})
		return 0.0

	if is_king:
		var p: Dictionary = state.players[target.side]
		# 本回合国王无敌
		if int(p.get("kingInvincibleTurn", -1)) == state.turn and not opts.get("unpreventable", false):
			log_event({"type": "damage-blocked", "target": "king%d" % int(target.side), "raw": amount})
			return 0.0

		# 巫毒娃娃：整笔转移给敌方国王
		var doll = null if opts.get("noRedirect", false) else find_voodoo_doll(int(target.side))
		if doll != null and int(doll.get("voodooTurn", -1)) != state.turn:
			doll["voodooTurn"] = state.turn
			log_event({"type": "voodoo-redirect", "side": target.side, "uid": doll.uid, "amount": final_amount})
			var sub := opts.duplicate()
			sub["noRedirect"] = true
			sub["reason"] = opts.get("reason", "巫毒娃娃转移")
			deal_damage(source, {"kind": "king", "side": 1 - int(target.side)}, final_amount, sub)
			return 0.0

		var king_amount := final_amount
		# 「在场:友方国王获祝福 X」
		var aura := king_aura_for(int(target.side))
		if aura.blessing != null and not opts.get("unpreventable", false) and king_amount > float(aura.blessing):
			log_event({"type": "king-blessing", "side": target.side, "from": king_amount, "to": aura.blessing})
			king_amount = float(aura.blessing)
		# 「友方国王本回合每次受伤-N」
		var reduce = p.get("kingDamageReduce", null)
		if reduce != null and int(reduce.get("turn", -1)) == state.turn and not opts.get("unpreventable", false):
			var reduced := maxf(0.0, king_amount - float(reduce.get("amount", 0)))
			if reduced != king_amount:
				log_event({"type": "king-damage-reduced", "side": target.side, "from": king_amount, "to": reduced})
				king_amount = reduced
		# 「替友方国王承受伤害」
		var guard = null if opts.get("noRedirect", false) else find_king_guard(int(target.side))
		if guard != null and king_amount > 0.0:
			log_event({"type": "king-guard", "side": target.side, "uid": guard.uid, "amount": king_amount})
			var sub2 := opts.duplicate()
			sub2["noRedirect"] = true
			sub2["reason"] = opts.get("reason", "神使替伤")
			deal_damage(source, {"kind": "unit", "unit": guard}, king_amount, sub2)
			return 0.0
		# 一次性护盾
		if p.get("kingShieldOnce", false) and not opts.get("unpreventable", false) and king_amount > 0.0:
			p["kingShieldOnce"] = false
			log_event({"type": "king-shield", "side": target.side, "blocked": king_amount})
			return 0.0
		# 「在场:友方国王生命至少为 X」
		if float(aura.hpFloor) > 0.0 and not opts.get("unpreventable", false) and king_amount > 0.0:
			var room := float(p.kingHp) - float(aura.hpFloor)
			if king_amount > room:
				log_event({"type": "king-hpfloor", "side": target.side, "from": king_amount, "to": maxf(0.0, room), "floor": aura.hpFloor})
				king_amount = maxf(0.0, room)
		# 陷阱「生灵之焱」：致命伤害免除
		if not opts.get("unpreventable", false) and king_amount > 0.0 and float(p.kingHp) - king_amount <= 0.0:
			var fatal = find_fat_king_trap(int(target.side))
			if fatal != null:
				fatal.trap["revealed"] = true
				fatal.trap["expiresTurn"] = state.turn
				log_event({"type": "trap-triggered", "side": target.side, "lane": fatal.lane, "cardId": fatal.trap.cardId, "kingLethal": true})
				queue_card_actions(int(target.side), fatal.trap.cardId)
				return 0.0

		p["kingHp"] = KPC.fix_num(float(p.kingHp) - king_amount)
		log_event({
			"type": "king-damage", "side": target.side, "amount": king_amount, "hp": p.kingHp,
			"source": source.uid if source != null else null,
			"reason": damage_reason(source, opts),
		})
		if source != null and not opts.get("noKeywords", false):
			on_dealt_damage(source, null, king_amount, {"kingSide": int(target.side)})
		check_superpower_thresholds(int(target.side))
	else:
		var unit: Dictionary = target.unit
		if unit.get("removed", false):
			return 0.0
		unit["hp"] = KPC.fix_num(float(unit.hp) - final_amount)
		unit["lastDamageSource"] = source.uid if source != null else null
		log_event({
			"type": "damage", "uid": unit.uid, "amount": final_amount, "hp": unit.hp,
			"source": source.uid if source != null else null,
			"lane": unit.lane, "side": unit.side, "row": unit.row,
			"reason": damage_reason(source, opts),
		})

		# 荆棘反弹
		var thorns = get_kw(unit, "thorns")
		if thorns != null and float(thorns.x) > 0.0 and source != null \
				and not opts.get("noThorns", false) and not source.get("virtual", false):
			log_event({"type": "thorns", "uid": unit.uid, "x": thorns.x, "source": source.uid})
			deal_damage(unit, {"kind": "unit", "unit": source}, float(thorns.x), {
				"noThorns": true, "noCrit": true, "noKeywords": true,
				"reason": "荆棘反弹（%s）" % state.cardLib.get(unit.cardId, {}).get("name", "单位"),
			})

		if source != null and not opts.get("noKeywords", false):
			on_dealt_damage(source, unit, final_amount)

		if not opts.get("noDamagedTrigger", false):
			queue_trigger(unit, "onDamaged", {
				"amount": final_amount, "sourceUid": source.uid if source != null else null,
			})
			queue_trigger(unit, "onHpLost", {
				"amount": final_amount, "sourceUid": source.uid if source != null else null,
			})

		if not opts.get("noWatchers", false):
			notify_damage_watchers(unit)

		if float(unit.hp) <= 0.0:
			if opts.get("deferDeath", false):
				if not has_ident(state._pendingDeaths, unit):
					state._pendingDeaths.append(unit)
			else:
				destroy_unit(unit, "lethal-damage")

	return final_amount


## 「造成伤害:」异能 与 淬毒 / 疾病 / 灼烧 的共同入口
func on_dealt_damage(source: Variant, victim: Variant, amount: float, opts: Dictionary = {}) -> void:
	if amount <= 0.0:
		return
	var king_side = null if victim != null else opts.get("kingSide", null)

	if victim != null or king_side != null:
		var poison = get_kw(source, "poison")
		if poison != null and float(poison.x) > 0.0:
			var mark := {"type": "poison", "x": float(poison.x), "sourceUid": source.uid, "appliedTurn": state.turn}
			if victim != null:
				victim.marks.append(mark)
				log_event({"type": "poison-applied", "uid": victim.uid, "x": poison.x})
			else:
				state.players[int(king_side)].kingMarks.append(mark)
				log_event({"type": "poison-applied", "kingSide": king_side, "x": poison.x})

		if victim != null and has_kw(source, "disease"):
			victim.marks.append({"type": "disease", "sourceUid": source.uid, "appliedTurn": state.turn})
			log_event({"type": "disease-applied", "uid": victim.uid})

		if victim != null and has_kw(source, "burn"):
			var burn = get_kw(source, "burn")
			if burn != null and float(burn.x) > 0.0:
				victim.marks.append({"type": "burn", "x": float(burn.x), "sourceUid": source.uid, "appliedTurn": state.turn})
				log_event({"type": "burn-applied", "uid": victim.uid, "x": burn.x})

	queue_trigger(source, "onDealDamage", {
		"victimUid": victim.uid if victim != null else null,
		"victim": victim,
		"toKing": victim == null,
		"amount": amount,
	})


## 「有敌人受到伤害时」的观察者（鲨鱼 / 怨魂）
func notify_damage_watchers(victim: Variant) -> void:
	if victim == null or victim.get("removed", false):
		return
	for watcher in all_units():
		if watcher.get("removed", false):
			continue
		if watcher.side == victim.side:
			continue
		if not _has_effect_trigger(watcher, "onEnemyDamaged"):
			continue
		queue_trigger(watcher, "onEnemyDamaged", {"victim": victim})


## 把单位的某个异能放进触发队列
func queue_trigger(unit: Variant, trigger_name: String, payload: Dictionary = {}, opts: Variant = null) -> void:
	state.triggerQueue.append({
		"unit": unit, "triggerName": trigger_name, "payload": payload,
		"effects": opts.get("effects", null) if opts is Dictionary else null,
		"cardId": opts.get("cardId", null) if opts is Dictionary else null,
	})


## 国王附着的异能入队
func queue_king_trigger(side: int, trigger_name: String, payload: Dictionary = {}) -> void:
	state.triggerQueue.append({"kingSide": side, "triggerName": trigger_name, "payload": payload})


func heal_unit(unit: Variant, amount: float) -> void:
	if unit == null or unit.get("removed", false) or amount <= 0.0:
		return
	var before := float(unit.hp)
	unit["hp"] = KPC.fix_num(minf(float(unit.maxHp), float(unit.hp) + amount))
	log_event({"type": "heal", "uid": unit.uid, "from": before, "to": unit.hp})
	check_nimble(unit)


func heal_king(side: int, amount: float) -> void:
	if amount <= 0.0:
		return
	var p: Dictionary = state.players[side]
	if float(p.kingHp) <= 0.0:
		return
	var before := float(p.kingHp)
	p["kingHp"] = KPC.fix_num(minf(float(p.kingMaxHp), float(p.kingHp) + amount))
	log_event({"type": "king-heal", "side": side, "from": before, "to": p.kingHp, "amount": float(p.kingHp) - before})


## 降低生命上限并同时扣掉等量当前生命（数值修改，不是伤害）
func debuff_max_hp(unit: Variant, amount: float) -> void:
	if unit == null or unit.get("removed", false) or amount <= 0.0:
		return
	unit["maxHp"] = KPC.fix_num(maxf(0.0, float(unit.maxHp) - amount))
	unit["hp"] = KPC.fix_num(float(unit.hp) - amount)
	log_event({"type": "debuff-maxhp", "uid": unit.uid, "amount": amount, "maxHp": unit.maxHp, "hp": unit.hp})
	if float(unit.hp) <= 0.0:
		destroy_unit(unit, "stat-loss")
		return
	check_nimble(unit)


## 把单位数值**设为固定值**（不是加减）
func set_unit_stats(unit: Variant, vals: Dictionary) -> void:
	if unit == null or unit.get("removed", false):
		return
	if vals.has("atk") and vals.atk != null:
		if not unit.has("atkLocked"):
			unit["atk"] = KPC.fix_num(maxf(0.0, float(vals.atk)))
		else:
			unit["atk"] = KPC.fix_num(float(unit.atkLocked))
	if vals.has("maxHp") and vals.maxHp != null:
		unit["maxHp"] = KPC.fix_num(maxf(0.0, float(vals.maxHp)))
	if vals.has("hp") and vals.hp != null:
		unit["hp"] = KPC.fix_num(float(vals.hp))
	if float(unit.hp) > float(unit.maxHp):
		unit["hp"] = unit.maxHp
	log_event({"type": "set-stats", "uid": unit.uid, "hp": unit.hp, "maxHp": unit.maxHp, "atk": unit.atk})
	if float(unit.hp) <= 0.0:
		destroy_unit(unit, "stat-set")
		return
	check_nimble(unit)


## 「依次变为」：每次触发往后走一格
func advance_stat_step(unit: Variant, steps: Array) -> void:
	if unit == null or unit.get("removed", false) or steps.is_empty():
		return
	var cur: int = int(unit.get("statStep", -1))
	unit["statStep"] = mini(cur + 1, steps.size() - 1)
	var s: Dictionary = steps[int(unit.statStep)]
	set_unit_stats(unit, {"atk": s.atk, "hp": s.hp, "maxHp": s.hp})
	log_event({"type": "stat-step", "uid": unit.uid, "step": unit.statStep, "atk": s.atk, "hp": s.hp})


func damage_cap_for(source_side: int) -> Variant:
	for cap in state.get("damageCaps", []):
		if int(cap.get("turn", -1)) != state.turn:
			continue
		if int(cap.get("side", -1)) != source_side:
			continue
		return cap.value
	return null


func add_damage_cap(side: int, value: float, turns: int = 1) -> void:
	if not state.has("damageCaps"):
		state["damageCaps"] = []
	state.damageCaps.append({"side": side, "value": value, "turn": state.turn + turns - 1})
	log_event({"type": "damage-cap", "side": side, "value": value, "untilTurn": state.turn + turns - 1})


## 轻灵的状态检查：失去两栖且在水路 → 消灭
func check_nimble(unit: Variant) -> void:
	if unit == null or unit.get("removed", false):
		return
	if nimble_should_drown(unit):
		log_event({
			"type": "nimble-drown", "uid": unit.uid, "cardId": unit.cardId,
			"name": state.cardLib.get(unit.cardId, {}).get("name", unit.cardId),
		})
		destroy_unit(unit, "nimble-drown")


func check_all_nimble() -> void:
	for unit in all_units():
		check_nimble(unit)


## 陷阱的触发点：伤害要落到某一方身上时，先看有没有没触发的陷阱
func trigger_trap_on_damage(source: Variant, target: Dictionary) -> Variant:
	if source == null or target == null:
		return null
	var victim_side = null
	if target.get("kind", "") == "king":
		victim_side = int(target.side)
	elif target.get("unit", null) != null:
		victim_side = int(target.unit.side)
	else:
		return null
	if int(source.side) == int(victim_side):
		return null
	for entry in traps_of(int(victim_side)):
		var trap: Dictionary = entry.trap
		if trap.get("revealed", false):
			continue
		if trap.cardId != "U371":
			continue
		trap["revealed"] = true
		trap["expiresTurn"] = state.turn
		add_damage_cap(int(source.side), 2.0, 1)
		log_event({"type": "trap-triggered", "side": victim_side, "lane": entry.lane, "cardId": trap.cardId, "cap": 2})
		return trap
	return null


## 「替友方国王承受伤害」：找生命最低的神使
func find_king_guard(side: int) -> Variant:
	var best = null
	for u in all_units():
		if u.get("removed", false) or int(u.side) != side:
			continue
		var def = state.cardLib.get(u.cardId, null)
		if def == null or not def.get("kingGuard", false):
			continue
		if best == null or float(u.hp) < float(best.hp) \
				or (float(u.hp) == float(best.hp) and int(u.uid) < int(best.uid)):
			best = u
	return best


## 「在场:友方国王…」：blessing 取最小、hpFloor 取最大
func king_aura_for(side: int) -> Dictionary:
	var blessing = null
	var hp_floor := 0.0
	for u in all_units():
		if u == null or u.get("removed", false) or int(u.side) != side:
			continue
		var ka = u.get("kingAura", null)
		if ka == null:
			continue
		if ka.has("blessing"):
			blessing = float(ka.blessing) if blessing == null else minf(float(blessing), float(ka.blessing))
		if ka.has("hpFloor"):
			hp_floor = maxf(hp_floor, float(ka.hpFloor))
	return {"blessing": blessing, "hpFloor": hp_floor}


func damage_reason(source: Variant, opts: Dictionary) -> String:
	if opts.get("reason", null) != null:
		return str(opts.reason)
	if source != null:
		var nm := str(source.get("name", ""))
		if nm == "":
			nm = str(state.cardLib.get(source.cardId, {}).get("name", ""))
		if nm != "":
			return nm if source.get("virtual", false) else (nm + " 攻击")
	return "未知来源"


## 找出这一方还没揭示的、「国王受到致命伤害时」触发的陷阱
func find_fat_king_trap(side: int) -> Variant:
	for entry in traps_of(side):
		if entry.trap.get("revealed", false):
			continue
		var def: Dictionary = state.cardLib.get(entry.trap.cardId, {})
		if def.get("kingLethal", false):
			return entry
	return null


## 把一张牌（通常是被揭示的陷阱）的卡面效果排进触发队列
func queue_card_actions(side: int, card_id: String, payload: Dictionary = {}) -> void:
	var def: Dictionary = state.cardLib.get(card_id, {})
	var actions: Array = def.get("actions", [])
	if actions.is_empty():
		return
	if not state.has("triggerQueue"):
		state["triggerQueue"] = []
	state.triggerQueue.append({"cardSide": side, "cardId": card_id, "actions": actions, "triggerName": "cardActions", "payload": payload})


# ══════════════════════════════════════════════════════════
# §5 属性与牌库（stats.js）
# ══════════════════════════════════════════════════════════

## 永久授予一个词条（同名词条不叠加）
func grant_keyword(unit: Variant, keyword_id: String, x: float = 0.0, opts: Dictionary = {}) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	var parsed := parse_keyword(keyword_id)
	var existing = get_kw(unit, parsed.id)
	if existing != null:
		if opts.get("untilTurn", null) != null and not existing.has("untilTurn"):
			existing["untilTurn"] = opts.untilTurn
		return false
	var kw := {"id": parsed.id, "x": float(parsed.x) if float(parsed.x) != 0.0 else x}
	if opts.get("untilTurn", null) != null:
		kw["untilTurn"] = opts.untilTurn
	unit.keywords.append(kw)
	log_event({
		"type": "grant-keyword", "uid": unit.uid, "keyword": parsed.id,
		"x": kw.x, "untilTurn": kw.get("untilTurn", null),
	})
	return true


## 清掉所有到期的「有时限词条」
func expire_timed_keywords() -> void:
	for unit in all_units():
		if unit.get("removed", false):
			continue
		var before: int = unit.keywords.size()
		var kept: Array = []
		for k in unit.keywords:
			if k.get("untilTurn", null) != null and state.turn >= int(k.untilTurn):
				continue
			kept.append(k)
		unit["keywords"] = kept
		if unit.keywords.size() != before:
			log_event({"type": "keyword-expired", "uid": unit.uid, "n": before - unit.keywords.size()})


## 封印一个单位（除攻击力与生命之外的一切特殊效果全部失效）
func seal_unit(unit: Variant, reason: String = "seal") -> bool:
	if unit == null or unit.get("removed", false):
		return false
	if unit.get("sealed", false):
		return false
	unit["sealed"] = true
	log_event({"type": "seal", "uid": unit.uid, "cardId": unit.cardId, "reason": reason})
	return true


func is_sealed(unit: Variant) -> bool:
	return unit != null and unit.get("sealed", false)


## 把若干张卡放回牌库
func return_cards_to_deck(card_ids: Array, to: String = "top") -> int:
	if card_ids.is_empty():
		return 0
	if to == "shuffle":
		state.deck.append_array(card_ids)
		state.rng.shuffle(state.deck)
	else:
		for i in range(card_ids.size() - 1, -1, -1):
			state.deck.push_front(card_ids[i])
	log_event({"type": "return-to-deck", "to": to, "count": card_ids.size(), "deckLeft": state.deck.size()})
	return card_ids.size()


func revoke_keyword(unit: Variant, keyword_id: String) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	var before: int = unit.keywords.size()
	var kept: Array = []
	for k in unit.keywords:
		if k.id != keyword_id:
			kept.append(k)
	unit["keywords"] = kept
	if unit.keywords.size() == before:
		return false
	log_event({"type": "revoke-keyword", "uid": unit.uid, "keyword": keyword_id})
	return true


## 把一只单位的攻击力**永久锁死**
func lock_atk(unit: Variant, value: float = 0.0) -> void:
	if unit == null or unit.get("removed", false):
		return
	unit["atk"] = KPC.fix_num(maxf(0.0, value))
	unit["atkLocked"] = maxf(0.0, value)
	log_event({"type": "atk-locked", "uid": unit.uid, "atk": unit.atk})


## 调整某个已有词条的数量 x，没有就新加一个
func buff_keyword_x(unit: Variant, keyword_id: String, delta: float = 1.0) -> void:
	if unit == null or unit.get("removed", false) or delta == 0.0:
		return
	var existing = null
	for k in unit.get("keywords", []):
		if k.id == keyword_id:
			existing = k
			break
	if existing != null:
		existing["x"] = maxf(0.0, float(existing.get("x", 0.0)) + delta)
	else:
		unit.keywords.append({"id": keyword_id, "x": maxf(0.0, delta)})
	log_event({
		"type": "buff-keyword-x", "uid": unit.uid, "keyword": keyword_id, "delta": delta,
		"x": float(existing.x) if existing != null else maxf(0.0, delta),
	})


func buff_atk(unit: Variant, amount: float) -> void:
	if unit == null or unit.get("removed", false):
		return
	if unit.get("atkLocked", null) != null:
		return
	unit["atk"] = KPC.fix_num(maxf(0.0, float(unit.atk) + amount))
	log_event({"type": "buff-atk", "uid": unit.uid, "amount": amount, "atk": unit.atk})


## 提升生命上限并同时治疗等量生命
func buff_max_hp(unit: Variant, amount: float) -> void:
	if unit == null or unit.get("removed", false):
		return
	unit["maxHp"] = KPC.fix_num(float(unit.maxHp) + amount)
	unit["hp"] = KPC.fix_num(float(unit.hp) + amount)
	log_event({"type": "buff-maxhp", "uid": unit.uid, "amount": amount, "maxHp": unit.maxHp, "hp": unit.hp})
	check_nimble(unit)


## 从共享牌库抽牌。opts.raw === false 时不发原料（开局起手用）
func draw_cards(side: int, n: int, opts: Dictionary = {}) -> int:
	var p: Dictionary = state.players[side]
	var drawn: Array = []
	for i in n:
		if state.deck.is_empty():
			state["deckEmpty"] = true
			break
		var card_id = state.deck.pop_front()
		p.hand.append({"iid": _next_iid(), "cardId": card_id})
		drawn.append(card_id)
	log_event({"type": "draw", "side": side, "count": drawn.size(), "deckLeft": state.deck.size()})

	if not drawn.is_empty():
		for watcher in all_units():
			if watcher.get("removed", false) or int(watcher.side) == side:
				continue
			if not _has_effect_trigger(watcher, "onOpponentDraw"):
				continue
			queue_trigger(watcher, "onOpponentDraw", {"drawerSide": side, "cards": drawn})
	if opts.get("raw", true) != false:
		alchemy_on_draw(side, drawn.size())
	return drawn.size()


func gain_mana_cap(side: int, amount: int) -> void:
	var p: Dictionary = state.players[side]
	p["manaCapBonus"] = int(p.get("manaCapBonus", 0)) + amount
	p["manaCap"] = int(p.manaCap) + amount
	p["mana"] = int(p.mana) + amount
	log_event({"type": "mana-cap", "side": side, "amount": amount, "manaCap": p.manaCap, "mana": p.mana})


func gain_mana(side: int, amount: int) -> void:
	var p: Dictionary = state.players[side]
	p["mana"] = int(p.mana) + amount
	log_event({"type": "mana", "side": side, "amount": amount, "mana": p.mana})


## 把一只场上的单位**就地变成另一张牌**
func transform_unit(unit: Variant, new_card_id: String) -> bool:
	if unit == null or unit.get("removed", false):
		return false
	var def = state.cardLib.get(new_card_id, null)
	if def == null:
		return false

	var from := {"cardId": unit.cardId, "name": unit.name, "atk": unit.atk, "hp": unit.hp}
	unit["cardId"] = def.get("id", new_card_id)
	unit["name"] = def.get("name", new_card_id)
	unit["atk"] = float(def.get("atk", 0))
	unit["hp"] = float(def.get("hp", 0))
	unit["maxHp"] = float(def.get("hp", 0))
	var kws: Array = []
	for k in def.get("keywords", []):
		kws.append(parse_keyword(k))
	unit["keywords"] = kws
	var effs: Array = []
	for e in def.get("effects", []):
		effs.append(e.duplicate(true))
	unit["effects"] = effs
	unit["attackWithHp"] = bool(def.get("attackWithHp", false))
	unit["bypassInCombat"] = bool(def.get("bypassInCombat", false))
	unit["bodyguard"] = bool(def.get("bodyguard", false))
	unit["choosesTarget"] = bool(def.get("choosesTarget", false))
	unit["marks"] = []
	unit["lastDamageSource"] = null

	log_event({
		"type": "transform", "uid": unit.uid, "side": unit.side, "lane": unit.lane, "row": unit.row,
		"fromCardId": from.cardId, "fromName": from.name, "fromAtk": from.atk, "fromHp": from.hp,
		"toCardId": def.get("id", new_card_id), "toName": def.get("name", new_card_id),
		"atk": unit.atk, "hp": unit.hp,
	})
	return true


# ══════════════════════════════════════════════════════════
# §6 建局细节：强化增量与单位实例（setup.js）
# ══════════════════════════════════════════════════════════

const NO_ENHANCE := {"atk": 0.0, "hp": 0.0, "cost": 0.0, "kw": [], "fx": [], "flags": {}, "kingAura": null}
const FLAG_KEYS := ["critAlways", "critChance", "swapStats", "spellDamageReduce", "costPerAlly", "comboStrike"]


static func normalize_enhance(raw: Variant) -> Array:
	var out: Array = [{}, {}]
	if not (raw is Array):
		return out
	for side in 2:
		if side >= raw.size():
			continue
		var src = raw[side]
		if not (src is Dictionary):
			continue
		for card_id in src.keys():
			var v = src[card_id]
			if not (v is Dictionary):
				continue
			var atk := float(v.get("atk", 0))
			var hp := float(v.get("hp", 0))
			var cost := float(v.get("cost", 0))
			var kw: Array = []
			if v.get("kw", null) is Array:
				for k in v.kw:
					if k is Dictionary and k.get("id", null) is String:
						kw.append({"id": k.id, "x": float(k.get("x", 0))})
			var fx: Array = []
			if v.get("fx", null) is Array:
				for e in v.fx:
					if e is Dictionary and e.get("trigger", null) is String:
						fx.append(e.duplicate(true))
			var flags = null
			if v.get("flags", null) is Dictionary:
				flags = _sanitize_flags(v.flags)
			var king_aura = null
			if v.get("kingAura", null) is Dictionary:
				king_aura = _sanitize_king_aura(v.kingAura)
			if atk == 0.0 and hp == 0.0 and cost == 0.0 and kw.is_empty() \
					and fx.is_empty() and flags == null and king_aura == null:
				continue
			out[side][card_id] = {
				"atk": atk, "hp": hp, "cost": cost, "kw": kw,
				"fx": fx, "flags": flags, "kingAura": king_aura,
			}
	return out


static func _sanitize_flags(src: Dictionary) -> Variant:
	var out := {}
	for k in FLAG_KEYS:
		if not src.has(k):
			continue
		if k == "critAlways" or k == "swapStats" or k == "comboStrike":
			out[k] = bool(src[k])
		else:
			out[k] = float(src[k])
	if src.get("critAfterTurn", null) is Dictionary:
		out["critAfterTurn"] = {
			"turn": float(src.critAfterTurn.get("turn", 0)),
			"x": float(src.critAfterTurn.get("x", 0)),
		}
	return out if not out.is_empty() else null


static func _sanitize_king_aura(src: Dictionary) -> Variant:
	var out := {}
	if src.has("blessing"):
		out["blessing"] = float(src.blessing)
	if src.has("hpFloor"):
		out["hpFloor"] = float(src.hpFloor)
	return out if not out.is_empty() else null


func enhance_for(side: int, card_id: String) -> Dictionary:
	var table: Dictionary = state.enhance[side] if state.enhance.size() > side else {}
	return table.get(card_id, NO_ENHANCE)


## 合并词条：同 id 的 x 相加
func merge_keywords(base: Array, extra: Array) -> Array:
	var out: Array = []
	for k in base:
		out.append({"id": k.id, "x": k.x})
	if extra.is_empty():
		return out
	for k in extra:
		var hit = null
		for o in out:
			if o.id == k.id:
				hit = o
				break
		if hit != null:
			hit["x"] = float(hit.x) + float(k.get("x", 0))
		else:
			out.append({"id": k.id, "x": float(k.get("x", 0))})
	return out


## 卡面定义 → 落点探针（只带放置需要的字段）
func probe_from_def(def: Dictionary) -> Dictionary:
	var kws: Array = []
	for k in def.get("keywords", []):
		kws.append(parse_keyword(k))
	return {"keywords": kws, "hp": float(def.get("hp", 0)), "maxHp": float(def.get("hp", 0))}


func instantiate_unit(def: Dictionary, side: int, lane: String, row: String) -> Dictionary:
	var owner: Dictionary = state.players[side]
	if not owner.has("entries"):
		owner["entries"] = {}
	var cid: String = def.get("id", "")
	owner.entries[cid] = int(owner.entries.get(cid, 0)) + 1

	var enh := enhance_for(side, cid)
	var hp := KPC.fix_num(float(def.get("hp", 0)) + float(enh.hp))
	var atk := KPC.fix_num(float(def.get("atk", 0)) + float(enh.atk))
	var max_hp := hp
	var cur_hp := hp
	var flags: Dictionary = enh.get("flags", {}) if enh.get("flags", null) != null else {}
	if flags.get("swapStats", false):
		var t := atk
		atk = cur_hp
		cur_hp = t
		max_hp = t

	var base_kws: Array = []
	for k in def.get("keywords", []):
		base_kws.append(parse_keyword(k))

	var effects: Array = []
	for e in def.get("effects", []):
		effects.append(e.duplicate(true))
	for e in enh.get("fx", []):
		effects.append(e.duplicate(true))

	var unit := {
		"uid": _next_uid(),
		"cardId": cid,
		"name": def.get("name", cid),
		"side": side, "lane": lane, "row": row,
		"atk": atk,
		"hp": cur_hp,
		"maxHp": max_hp,
		"keywords": merge_keywords(base_kws, enh.get("kw", [])),
		"effects": effects,
		"marks": [],
		"removed": false,
		"lastDamageSource": null,
		"attackWithHp": bool(def.get("attackWithHp", false)),
		"bypassInCombat": bool(def.get("bypassInCombat", false)),
		"bodyguard": bool(def.get("bodyguard", false)),
		"choosesTarget": bool(def.get("choosesTarget", false)),
		"voodooDoll": bool(def.get("voodooDoll", false)),
	}

	if flags.get("critAlways", false):
		unit["critAlways"] = true
	if flags.has("critChance"):
		unit["critChance"] = float(flags.critChance)
	if flags.has("critAfterTurn"):
		unit["critAfterTurn"] = flags.critAfterTurn
	if flags.has("spellDamageReduce"):
		unit["spellDamageReduce"] = float(flags.spellDamageReduce)
	if flags.has("costPerAlly"):
		unit["costPerAlly"] = float(flags.costPerAlly)
	if flags.get("comboStrike", false):
		unit["comboStrike"] = true
	if enh.get("kingAura", null) != null:
		unit["kingAura"] = enh.kingAura
	return unit


# ══════════════════════════════════════════════════════════
# §7 阵营与超能力（factions.js）
# ══════════════════════════════════════════════════════════

const FACTIONS := {
	"demon": {"key": "demon", "name": "恶魔"},
	"god": {"key": "god", "name": "上帝"},
	"sword": {"key": "sword", "name": "剑道"},
	"music": {"key": "music", "name": "音乐"},
	"science": {"key": "science", "name": "科学"},
	"divine": {"key": "divine", "name": "神佑"},
	"alchemy": {"key": "alchemy", "name": "炼金"},
	"inferno": {"key": "inferno", "name": "炼狱"},
	"frost": {"key": "frost", "name": "极寒"},
	"sin": {"key": "sin", "name": "罪恶"},
	"party": {"key": "party", "name": "派对"},
	"flame": {"key": "flame", "name": "炎帝"},
	"heart": {"key": "heart", "name": "心驭"},
}

const SUPERPOWER_THRESHOLDS := [15, 9, 3]

const RAW_MATERIAL_IDS := ["U426", "U427", "U428", "U429"]
const RAW_PILE_MAKEUP := [
	{"cardId": "U426", "count": 3}, {"cardId": "U427", "count": 3},
	{"cardId": "U428", "count": 4}, {"cardId": "U429", "count": 4},
]
const RAW_COMBOS := {
	"U426+U426": "U435", "U427+U427": "U437", "U428+U428": "U434", "U429+U429": "U439",
	"U426+U427": "U442", "U426+U428": "U441", "U426+U429": "U440",
	"U427+U428": "U438", "U427+U429": "U443", "U428+U429": "U444",
	"U426+U427+U428+U429": "U436",
}

const FLAME_IDS := ["U467", "U468", "U469", "U470", "U471"]
const FLAME_LOTUS_ID := "U477"


func superpower_pool(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) == null:
		return []
	var drawn: Array = p.get("superpowers", [])
	var out: Array = []
	for id in state.cardLib.keys():
		var c: Dictionary = state.cardLib[id]
		if c.get("faction", null) == p.faction and not c.get("token", false) and not drawn.has(id):
			out.append(id)
	out.sort()
	return out


func draw_superpower(side: int, opts: Dictionary = {}) -> Variant:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) == null:
		return null
	var pool := superpower_pool(side)
	if pool.is_empty():
		return null
	var card_id: String = pool[state.rng.next_int(pool.size())]
	p.superpowers.append(card_id)
	p.hand.append({"iid": _next_iid(), "cardId": card_id})
	log_event({
		"type": "superpower-draw", "side": side, "cardId": card_id,
		"left": pool.size() - 1, "starting": bool(opts.get("starting", false)),
	})
	return card_id


func give_starting_superpowers() -> Array:
	var got: Array = []
	for p in state.players:
		if p.get("faction", null) == null:
			continue
		got.append(draw_superpower(int(p.side), {"starting": true}))
	return got


func check_superpower_thresholds(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) == null:
		return []
	var got: Array = []
	for t in SUPERPOWER_THRESHOLDS:
		if float(p.kingHp) < float(t) and not p.spThresholds.get(str(t), false):
			p.spThresholds[str(t)] = true
			got.append(draw_superpower(side))
	return got


func queue_delayed_summon(side: int, card_id: String, delay: int, spot: Variant) -> void:
	if not state.has("delayedSummons"):
		state["delayedSummons"] = []
	var d := maxi(1, delay)
	var lane = spot.lane if (spot != null and spot.get("lane", null) != null) else null
	var row = spot.row if (spot != null and spot.get("row", null) != null) else "front"
	state.delayedSummons.append({"side": side, "cardId": card_id, "atTurn": state.turn + d, "lane": lane, "row": row})
	log_event({"type": "delayed-summon", "side": side, "cardId": card_id, "atTurn": state.turn + d, "lane": lane, "row": row})


# ── 炼金 ──────────────────────────────────────────────────

func is_raw_material(def: Variant) -> bool:
	return def != null and def.get("rawMaterial", false)


func _make_raw_pile() -> Array:
	var pile: Array = []
	for m in RAW_PILE_MAKEUP:
		for i in int(m.count):
			pile.append(m.cardId)
	return pile


func ensure_raw_pile(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "alchemy":
		return []
	if not (p.get("rawPile", null) is Array):
		p["rawPile"] = _make_raw_pile()
	return p.rawPile


func raw_pile_of(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if not (p.get("rawPile", null) is Array):
		return []
	return p.rawPile


func draw_raw_material(side: int) -> Variant:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "alchemy":
		return null
	var pile := ensure_raw_pile(side)
	if pile.is_empty():
		log_event({"type": "raw-material-empty", "side": side})
		return null
	var idx: int = state.rng.next_int(pile.size())
	var card_id = pile[idx]
	pile.remove_at(idx)
	p.hand.append({"iid": _next_iid(), "cardId": card_id})
	log_event({"type": "raw-material", "side": side, "cardId": card_id, "left": pile.size()})
	return card_id


func take_raw_material(side: int, card_id: String, opts: Dictionary = {}) -> Variant:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return null
	var pile := ensure_raw_pile(side)
	var idx: int = pile.find(card_id)
	if idx < 0:
		return null
	pile.remove_at(idx)
	var hc := {"iid": _next_iid(), "cardId": card_id}
	if opts.get("free", false):
		var def: Dictionary = state.cardLib.get(card_id, {})
		hc["costDelta"] = -float(def.get("cost", 0))
	p.hand.append(hc)
	log_event({"type": "raw-material", "side": side, "cardId": card_id, "left": pile.size()})
	return hc


func return_raw_materials(side: int, card_ids: Array) -> Array:
	var pile := ensure_raw_pile(side)
	for id in card_ids:
		pile.append(id)
	return pile


func alchemy_on_draw(side: int, n: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "alchemy":
		return []
	var got: Array = []
	for i in n:
		var id = draw_raw_material(side)
		if id == null:
			break
		got.append(id)
	return got


func combo_token_for(card_ids: Array) -> Variant:
	var sorted := card_ids.duplicate()
	sorted.sort()
	var key := "+".join(sorted)
	return RAW_COMBOS.get(key, null)


func alchemy_unlock(side: int) -> bool:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return false
	if p.get("alchemyUnlock", false) == true:
		return true
	for e in p.get("kingEffects", []):
		if e is Dictionary and e.get("kind", "") == "alchemyUnlock":
			return true
	return false


func alchemy_tide_on(side: int) -> bool:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return false
	return int(p.get("alchemyTideTurn", -1)) == state.turn


func find_voodoo_doll(side: int) -> Variant:
	for lane in KPC.LANES:
		if not state.board.has(lane):
			continue
		var row = state.board[lane].units[side]
		for key in row.keys():
			var u = row[key]
			if u != null and u.get("voodooDoll", false):
				return u
	return null


# ── 炎帝：异火 ────────────────────────────────────────────

func is_flame_card(def: Variant) -> bool:
	if def == null:
		return false
	if def.get("flame", false) == true:
		return true
	return FLAME_IDS.has(def.get("id", ""))


func _make_flame_pile() -> Array:
	var pile: Array = []
	for id in FLAME_IDS:
		pile.append(id)
	return pile


func ensure_flame_pile(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "flame":
		return []
	if not (p.get("flamePile", null) is Array):
		p["flamePile"] = _make_flame_pile()
	return p.flamePile


func flame_pile_of(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if not (p.get("flamePile", null) is Array):
		return []
	return p.flamePile


func draw_flame(side: int) -> Variant:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "flame":
		return null
	var pile := ensure_flame_pile(side)
	if pile.is_empty():
		log_event({"type": "flame-empty", "side": side})
		return null
	var idx: int = state.rng.next_int(pile.size())
	var card_id = pile[idx]
	pile.remove_at(idx)
	p.hand.append({"iid": _next_iid(), "cardId": card_id})
	log_event({"type": "flame-draw", "side": side, "cardId": card_id, "left": pile.size()})
	return card_id


func reset_flame_pile(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return []
	p["flamePile"] = _make_flame_pile()
	log_event({"type": "flame-pile-reset", "side": side, "left": p.flamePile.size()})
	return p.flamePile


func no_flame_anywhere(side: int) -> bool:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return false
	if ensure_flame_pile(side).size() > 0:
		return false
	for c in p.hand:
		if is_flame_card(state.cardLib.get(c.cardId, null)):
			return false
	return true


func check_flame_lotus(side: int) -> Variant:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "flame":
		return null
	if not state.cardLib.has(FLAME_LOTUS_ID):
		return null
	if not no_flame_anywhere(side):
		return null
	p.hand.append({"iid": _next_iid(), "cardId": FLAME_LOTUS_ID})
	log_event({"type": "flame-lotus", "side": side, "cardId": FLAME_LOTUS_ID})
	return FLAME_LOTUS_ID


# ══════════════════════════════════════════════════════════
# §8 目标选择与动态数值（targets.js / amounts.js）
# ══════════════════════════════════════════════════════════

## 「需要向玩家提问」的哨兵：chooser 返回它就表示「这一问要挂起等人」
const PENDING := {"__pending__": true}


func as_unit(u: Variant) -> Variant:
	return null if u == null else {"kind": "unit", "unit": u}


func as_king(side: int) -> Dictionary:
	return {"kind": "king", "side": side}


func describe_target(t: Variant) -> String:
	if t == null:
		return "无"
	if t.get("kind", "") == "king":
		return "%s国王" % KPC.SIDE_NAME.get(int(t.side), "玩家")
	return "%s#%d" % [t.unit.name, int(t.unit.uid)]


## 这次选择要不要**真的问真人**（而不是被自动代答）
func ask_human_for(ctx: Dictionary, selector: Variant) -> bool:
	if not (selector is Dictionary) or selector.get("askHuman", false) != true:
		return false
	var human: int = int(state.get("humanSide", 0))
	return int(ctx.get("controller", 0)) == human


## AI 自己挑「一个敌方目标」时的口径：挑当前生命最低的（同血取 uid 最小的）
func pick_fragile_target(options: Array) -> Variant:
	var units := all_units()
	var best = null
	for o in options:
		if o == null or o.get("king", false):
			continue
		var u = null
		for x in units:
			if int(x.uid) == int(o.get("uid", -1)):
				u = x
				break
		if u == null:
			continue
		if best == null or float(u.hp) < float(best.hp) \
				or (float(u.hp) == float(best.hp) and int(u.uid) < int(best.uid)):
			best = u
	if best != null:
		return {"uid": int(best.uid)}
	for o in options:
		if o != null and o.get("king", false):
			return {"king": true, "side": int(o.side)}
	return options[0] if not options.is_empty() else null


## 解析目标选择器，返回目标引用数组。需要玩家选择时会挂起等答案。
func resolve_targets(ctx: Dictionary, selector: Variant) -> Array:
	var out: Array = await resolve_targets_inner(ctx, selector)
	if ctx.get("spellTargets", null) is Array:
		for t in out:
			if t.get("kind", "") == "unit" and int(t.unit.side) != int(ctx.get("controller", 0)):
				ctx.spellTargets.append(t.unit)
	return out


func _unit_label(u: Dictionary) -> String:
	return "%s (%s/%s) %s-%s" % [
		u.name, _num_s(u.atk), _num_s(u.hp),
		KPC.LANE_NAME.get(u.lane, u.lane),
		"前排" if u.row == "front" else "后排",
	]


func _num_s(v: Variant) -> String:
	var f := float(v)
	if is_equal_approx(f, roundf(f)):
		return str(int(roundf(f)))
	return str(f)


func resolve_targets_inner(ctx: Dictionary, selector: Variant) -> Array:
	if selector == null:
		return []
	var me: int = int(ctx.get("controller", 0))
	var source = ctx.get("source", null)
	var foe := 1 - me

	# 批量选择器统一过过滤器（「无法选中」也在这层排除）
	var batch := func(list: Array) -> Array:
		var out: Array = []
		var fctx := filter_ctx(source)
		for u in list:
			if matches_target_filter(u, selector.get("filter", null), fctx):
				out.append(as_unit(u))
		return out

	match str(selector.get("kind", "")):
		"self":
			return [as_unit(source)] if source != null else []
		"ownKing":
			return [as_king(me)]
		"enemyKing":
			return [as_king(foe)]
		"allOwnUnits":
			var own: Array = []
			for u in all_units():
				if int(u.side) == me:
					own.append(u)
			return batch.call(own)
		"allEnemyUnits":
			var foes: Array = []
			for u in all_units():
				if int(u.side) == foe:
					foes.append(u)
			return batch.call(foes)
		"allUnits":
			return batch.call(all_units())
		"triggerVictim":
			var victim = ctx.get("payload", {}).get("victim", null)
			return [as_unit(victim)] if (victim != null and not victim.get("removed", false)) else []
		"allEnemyUnitsInLane":
			if ctx.get("chosenLane", null) == null:
				await require_lane(ctx, selector)
			return batch.call(lane_units(str(ctx.chosenLane), foe))
		"adjacentEnemyUnits":
			if ctx.get("chosenLane", null) == null:
				await require_lane(ctx, selector)
			var out2: Array = []
			if selector.get("includeSelf", false):
				out2.append_array(lane_units(str(ctx.chosenLane), foe))
			for adj in adjacent_of(str(ctx.chosenLane)):
				out2.append_array(lane_units(adj, foe))
			return batch.call(out2)
		"allUnitsInLane":
			if ctx.get("chosenLane", null) == null:
				await require_lane(ctx, selector)
			return batch.call(all_units_in_lane(str(ctx.chosenLane)))
		"allLanesEnemyUnitsInLane":
			var out3: Array = []
			for lane in KPC.LANES:
				out3.append_array(lane_units(lane, foe))
			return batch.call(out3)
		"randomEnemyUnits":
			var pool: Array = []
			var fctx2 := filter_ctx(source)
			for u in all_units():
				if int(u.side) != foe:
					continue
				if matches_target_filter(u, selector.get("filter", null), fctx2):
					pool.append(u)
			var n := maxi(1, int(selector.get("count", 1)))
			var picked: Array = []
			while picked.size() < n and not pool.is_empty():
				var idx: int = state.rng.next_int(pool.size())
				picked.append(pool[idx])
				pool.remove_at(idx)
			return batch.call(picked)
		"lowestHpEnemyUnit":
			var pool2: Array = []
			var fctx3 := filter_ctx(source)
			for u in all_units():
				if int(u.side) != foe:
					continue
				if matches_target_filter(u, selector.get("filter", null), fctx3):
					pool2.append(u)
			if pool2.is_empty():
				return []
			var min_hp := INF
			for u in pool2:
				min_hp = minf(min_hp, float(u.hp))
			var ties: Array = []
			for u in pool2:
				if float(u.hp) == min_hp:
					ties.append(u)
			ties.sort_custom(func(a, b): return int(a.uid) < int(b.uid))
			return await choose_among_ties(ctx, selector, ties, "♥最低")
		"highestAtkEnemyUnit":
			var pool3: Array = []
			var fctx4 := filter_ctx(source)
			for u in all_units():
				if int(u.side) != foe:
					continue
				if matches_target_filter(u, selector.get("filter", null), fctx4):
					pool3.append(u)
			if pool3.is_empty():
				return []
			var max_atk := -INF
			for u in pool3:
				max_atk = maxf(max_atk, float(u.atk))
			var ties2: Array = []
			for u in pool3:
				if float(u.atk) == max_atk:
					ties2.append(u)
			ties2.sort_custom(func(a, b): return int(a.uid) < int(b.uid))
			return await choose_among_ties(ctx, selector, ties2, "⚔最高")
		"compoundTarget":
			if ctx.get("chosenTargetIsKing", false):
				return [] if ctx.get("chosenTargetKingSide", null) == null else [as_king(int(ctx.chosenTargetKingSide))]
			if ctx.get("chosenTargetUid", null) == null:
				return []
			var picked2 = find_unit(int(ctx.chosenTargetUid))
			return [as_unit(picked2)] if (picked2 != null and not picked2.get("removed", false)) else []
		"chosenEnemyUnit", "chosenOwnUnit", "chosenAnyUnit", "chosenEnemyFront":
			return await _resolve_chosen_unit(ctx, selector, me, foe)
		"chosenEnemyTarget":
			return await _resolve_chosen_enemy_target(ctx, selector, me, foe)
		"payloadUnit":
			var pl: Dictionary = ctx.get("payload", {})
			var u2 = pl.get("unit", pl.get("played", pl.get("victim", null)))
			return [as_unit(u2)] if (u2 != null and not u2.get("removed", false)) else []
		"allFrozenEnemyUnits":
			var frozen: Array = []
			for u in all_units():
				if int(u.side) == foe and is_frozen(u):
					frozen.append(u)
			return batch.call(frozen)
		"chosenLanesEnemyUnits":
			var out4: Array = []
			for lane in ctx.get("chosenLanes", []):
				out4.append_array(lane_units(lane, foe))
			return batch.call(out4)
		_:
			push_error("未知的目标选择器: %s" % str(selector))
			return []


func _resolve_chosen_unit(ctx: Dictionary, selector: Dictionary, me: int, foe: int) -> Array:
	var any_side: bool = str(selector.kind) == "chosenAnyUnit"
	var want_side: int = me if str(selector.kind) == "chosenOwnUnit" else foe
	var want_enemy: bool = str(selector.kind) != "chosenOwnUnit" and str(selector.kind) != "chosenAnyUnit"
	var source = ctx.get("source", null)

	# 调用方已直接指定目标 —— 优先使用（仍要过一遍过滤器）
	if ctx.get("chosenTargetUid", null) != null:
		var picked = find_unit(int(ctx.chosenTargetUid))
		if picked == null:
			return []
		if not matches_target_filter(picked, selector.get("filter", null), filter_ctx(source)):
			return []
		if selector.get("excludeUid", null) != null and int(picked.uid) == int(selector.excludeUid):
			return []
		if selector.get("controlRoom", false) and find_control_spot(picked, me) == null:
			return []
		return [as_unit(picked)]

	var options: Array = []
	for u in all_units():
		if not any_side and int(u.side) != want_side:
			continue
		if str(selector.kind) == "chosenEnemyFront":
			if ctx.get("chosenLane", null) != null:
				if u.lane != ctx.chosenLane or u.row != "front":
					continue
			else:
				continue
		options.append(u)
	if selector.get("filter", null) != null:
		var fctx := filter_ctx(source)
		var kept: Array = []
		for u in options:
			if matches_target_filter(u, selector.filter, fctx):
				kept.append(u)
		options = kept
	if selector.get("excludeSource", false) and source != null:
		var kept2: Array = []
		for u in options:
			if not same(u, source):
				kept2.append(u)
		options = kept2
	if selector.get("excludeUid", null) != null:
		var kept3: Array = []
		for u in options:
			if int(u.uid) != int(selector.excludeUid):
				kept3.append(u)
		options = kept3
	if selector.get("controlRoom", false):
		var kept4: Array = []
		for u in options:
			if find_control_spot(u, me) != null:
				kept4.append(u)
		options = kept4
	if options.is_empty():
		return []

	var labels: Array = []
	for u in options:
		labels.append({"uid": int(u.uid), "label": _unit_label(u)})
	var prompt: String = selector.get("prompt", "")
	if prompt == "":
		prompt = "选择一个单位" if any_side else ("选择一个%s单位" % KPC.SIDE_NAME.get(want_side, "玩家"))
	var request := {
		"type": "chooseUnit",
		"side": me,
		"prompt": prompt,
		"options": labels,
	}
	if want_enemy:
		request["choose"] = func(): return pick_fragile_target(labels)
	if ask_human_for(ctx, selector):
		request["noAuto"] = true
	var answer = await take_choice(request)
	var picked2 = null
	if answer is Dictionary:
		for u in options:
			if int(u.uid) == int(answer.get("uid", -1)):
				picked2 = u
				break
	return [as_unit(picked2)] if picked2 != null else []


func _resolve_chosen_enemy_target(ctx: Dictionary, selector: Dictionary, me: int, foe: int) -> Array:
	var allow_king: bool = selector.get("allowKing", true) != false
	var source = ctx.get("source", null)

	if ctx.get("chosenTargetIsKing", false):
		return [as_king(foe)] if allow_king else []
	if ctx.get("chosenTargetUid", null) != null:
		var picked = find_unit(int(ctx.chosenTargetUid))
		if picked == null:
			return []
		if not matches_target_filter(picked, selector.get("filter", null), filter_ctx(source)):
			return []
		return [as_unit(picked)]

	var options: Array = []
	for u in all_units():
		if int(u.side) != foe:
			continue
		if not matches_target_filter(u, selector.get("filter", null), filter_ctx(source)):
			continue
		options.append({"uid": int(u.uid), "label": _unit_label(u)})
	if allow_king:
		options.append({
			"king": true, "side": foe,
			"label": "%s的国王（♥ %s）" % [KPC.SIDE_NAME.get(foe, "玩家"), _num_s(state.players[foe].kingHp)],
		})
	if options.is_empty():
		return []

	var request := {
		"type": "chooseEnemyTarget",
		"side": me,
		"prompt": selector.get("prompt", "选择敌方单位或敌方国王"),
		"options": options,
		"choose": func(): return pick_fragile_target(options),
	}
	if ask_human_for(ctx, selector):
		request["noAuto"] = true
	var answer = await take_choice(request)
	if answer is Dictionary and answer.get("king", false):
		return [as_king(int(answer.side))]
	var uid: int = int(answer.get("uid", -1)) if answer is Dictionary else -1
	var hit = find_unit(uid)
	return [as_unit(hit)] if hit != null else []


## 需要一个线路选择时，向驱动器请求
func require_lane(ctx: Dictionary, selector: Variant) -> void:
	var opts: Array = []
	for l in KPC.LANES:
		opts.append({"lane": l, "label": KPC.LANE_NAME.get(l, l)})
	var prompt: String = selector.get("prompt", "选择一条线路") if selector is Dictionary else "选择一条线路"
	var answer = await take_choice({
		"type": "chooseLane",
		"side": int(ctx.get("controller", 0)),
		"prompt": prompt,
		"options": opts,
	})
	if answer is Dictionary:
		ctx["chosenLane"] = answer.get("lane", null)


## 「生命最低 / 攻击最高」这类唯一极值选择器在**平手**时的处理
func choose_among_ties(ctx: Dictionary, selector: Dictionary, ties: Array, what: String) -> Array:
	if ties.is_empty():
		return []
	if ties.size() == 1:
		return [as_unit(ties[0])]
	var options: Array = []
	for u in ties:
		options.append({"uid": int(u.uid), "label": _unit_label(u)})
	var human: int = int(state.get("humanSide", 0))
	var prompt: String = selector.get("prompt", "")
	if prompt == "":
		prompt = "有 %d 名%s的敌人并列，选择一名" % [ties.size(), what]
	var request := {
		"type": "chooseUnit",
		"side": int(ctx.get("controller", 0)),
		"prompt": prompt,
		"options": options,
		"choose": func(): return {"uid": int(ties[0].uid)},
	}
	if int(ctx.get("controller", 0)) == human:
		request["noAuto"] = true
	var answer = await take_choice(request)
	var uid: int = int(answer.get("uid", -1)) if answer is Dictionary else -1
	for u in ties:
		if int(u.uid) == uid:
			return [as_unit(u)]
	return []


# ── 动态数值 ──────────────────────────────────────────────

func resolve_amount(ctx: Dictionary, amount: Variant, target: Variant = null) -> float:
	if amount is int or amount is float:
		return float(amount)
	if amount == null:
		return 0.0
	if not (amount is Dictionary):
		push_error("未知的 amount: %s" % str(amount))
		return 0.0
	return resolve_amount_base(ctx, amount, target) + float(amount.get("plus", 0))


func resolve_amount_base(ctx: Dictionary, amount: Dictionary, target: Variant) -> float:
	var me: int = int(ctx.get("controller", 0))
	if amount.has("perOwnUnit"):
		var own := 0
		for u in all_units():
			if int(u.side) == me:
				own += 1
		return float(amount.perOwnUnit) * float(own)
	if amount.has("perEnemyUnit"):
		var foes := 0
		for u in all_units():
			if int(u.side) != me:
				foes += 1
		return float(amount.perEnemyUnit) * float(foes)
	if amount.has("perAllUnits"):
		return float(amount.perAllUnits) * float(all_units().size())
	if amount.has("perKeywordOfTarget"):
		var u2 = target.unit if (target != null and target is Dictionary and target.get("unit", null) != null) else null
		if u2 == null:
			return 0.0
		var spec = amount.perKeywordOfTarget
		var kws: Array = u2.get("keywords", [])
		if spec is Dictionary:
			var n := 0
			for k in kws:
				if k.id == spec.get("id", ""):
					n += 1
			return float(spec.get("per", 1)) * float(n)
		return float(spec) * float(kws.size())
	if amount.has("perOwnEntry"):
		var src = ctx.get("source", null)
		var owner: Dictionary = state.players[me]
		var n2 := 0
		if src != null and owner.get("entries", null) != null:
			n2 = int(owner.entries.get(src.cardId, 0))
		return float(amount.perOwnEntry) * float(n2)
	if amount.get("sourceCostDelta", false):
		var src2 = ctx.get("source", null)
		return float(src2.get("paidCostDelta", 0)) if src2 != null else 0.0
	if amount.has("perSelfAtk"):
		var src3 = ctx.get("source", null)
		return float(amount.perSelfAtk) * (float(src3.atk) if src3 != null else 0.0)
	if amount.has("fixed"):
		return float(amount.fixed)
	if amount.get("sacrificedAtk", false):
		var sac = ctx.get("sacrificed", null)
		return float(sac.get("atk", 0)) if sac != null else 0.0
	push_error("未知的动态数值表达式: %s" % str(amount))
	return 0.0


func resolve_side(side: Variant, controller: int) -> int:
	if side == null or side == "controller":
		return controller
	if side == "opponent":
		return 1 - controller
	if side == "first":
		return int(state.firstPlayer)
	if side == "second":
		return 1 - int(state.firstPlayer)
	if side is int or side is float:
		return int(side)
	push_error("未知的 side: %s" % str(side))
	return controller


# ══════════════════════════════════════════════════════════
# §9 效果动作（actions.js 的 execActions / execAction）
# ══════════════════════════════════════════════════════════

## 「每扣除 1♥，便…」——数值修改扣掉的生命也算「扣除♥」
func queue_hp_lost(unit: Variant, hp_before: float) -> void:
	if unit == null or unit.get("removed", false) or float(unit.hp) >= hp_before:
		return
	var lost := KPC.fix_num(hp_before - float(unit.hp))
	if lost <= 0.0:
		return
	queue_trigger(unit, "onHpLost", {"amount": lost, "hpLoss": true})


## 召唤落点的询问：合法格只有一个就直接用
func ask_summon_cell(ctx: Dictionary, side: int, card_id: String, prompt: String) -> Variant:
	var cells := legal_summon_cells(side, card_id)
	if cells.is_empty():
		return null
	if cells.size() == 1:
		return cells[0]
	var human: int = int(state.get("humanSide", 0))
	var request := {
		"type": "summonCell",
		"side": side,
		"prompt": prompt if prompt != "" else "选择召唤位置",
		"options": cells,
	}
	if side == human:
		request["noAuto"] = true
	var answer = await take_choice(request)
	if answer is Dictionary and answer.get("lane", null) != null:
		return answer
	return cells[0]


## 「两个单位打一架」：两边伤害先各自算出来，再依次落地
func duel_units(ctx: Dictionary, a: Dictionary, b: Dictionary) -> void:
	var power_of := func(u: Dictionary) -> float:
		return maxf(0.0, float(u.hp)) if u.get("attackWithHp", false) else effective_atk(u)
	var to_b: float = maxf(0.0, power_of.call(a))
	var to_a: float = maxf(0.0, power_of.call(b))
	log_event({
		"type": "duel", "a": a.uid, "b": b.uid, "toA": to_a, "toB": to_b,
		"cardId": ctx.get("card", {}).get("id", null) if ctx.get("card", null) != null else null,
	})
	if to_b > 0.0 and not b.get("removed", false):
		deal_damage(a, {"kind": "unit", "unit": b}, to_b, {"reason": "「%s」交战" % a.name})
	if to_a > 0.0 and not a.get("removed", false):
		deal_damage(b, {"kind": "unit", "unit": a}, to_a, {"reason": "「%s」交战" % b.name})


## 执行一组效果动作
func exec_actions(ctx: Dictionary, actions: Array) -> void:
	for action in actions:
		await exec_action(ctx, action)


func _ctx_card_name(ctx: Dictionary) -> String:
	var card = ctx.get("card", null)
	if card is Dictionary:
		return str(card.get("name", ""))
	return ""


## 执行单个效果动作
func exec_action(ctx: Dictionary, action: Dictionary) -> void:
	var me: int = int(ctx.get("controller", 0))
	var foe := 1 - me
	var source = ctx.get("source", null)

	match str(action.get("op", "")):
		"choose":
			var all: Array = action.get("options", [])
			if all.is_empty():
				return
			var options: Array = []
			for o in all:
				if o.get("if", null) != null and not eval_condition(ctx, o.if):
					continue
				options.append(o)
			if options.is_empty():
				return
			var labels: Array = []
			for i in options.size():
				labels.append({"index": i, "label": str(options[i].get("label", "选项%d" % (i + 1)))})
			var answer = await take_choice({
				"type": "chooseOption",
				"side": me,
				"prompt": action.get("prompt", "选择一项"),
				"options": labels,
			})
			var idx := 0
			if answer is Dictionary and (answer.get("index", null) is int or answer.get("index", null) is float):
				idx = int(answer.index)
			if idx < 0 or idx >= options.size():
				idx = 0
			await exec_actions(ctx, options[idx].get("actions", []))

		"untargetable":
			var targets = await resolve_targets(ctx, action.get("target", {"kind": "chosenOwnUnit"}))
			var turns := 1
			if action.has("turns"):
				turns = int(resolve_amount(ctx, action.turns))
			for t in targets:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				t.unit.marks.append({"type": "untargetable", "untilTurn": state.turn + turns - 1})
				log_event({"type": "untargetable", "uid": t.unit.uid, "untilTurn": state.turn + turns - 1})

		"revokeKeyword":
			var targets2 = await resolve_targets(ctx, action.get("target", {"kind": "self"}))
			for t in targets2:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				revoke_keyword(t.unit, str(action.get("keyword", "")))

		"cycleStats":
			var targets3 = await resolve_targets(ctx, action.get("target", {"kind": "self"}))
			for t in targets3:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				advance_stat_step(t.unit, action.get("steps", []))

		"capDamage":
			var cap_side := resolve_side(action.get("side", "opponent"), me)
			add_damage_cap(cap_side, resolve_amount(ctx, action.get("value", 0)), int(action.get("turns", 1)))

		"conditional":
			var ok := eval_condition(ctx, action.get("if", null))
			await exec_actions(ctx, action.get("then", []) if ok else action.get("else", []))

		"taxMana":
			var tax_side := resolve_side(action.get("side", "opponent"), me)
			var tax_amount := resolve_amount(ctx, action.get("amount", 1))
			var tp: Dictionary = state.players[tax_side]
			tp["manaPenalty"] = float(tp.get("manaPenalty", 0)) + tax_amount
			log_event({"type": "mana-tax", "side": tax_side, "amount": tax_amount, "total": tp.manaPenalty})

		"damage":
			var targets4 = await resolve_targets(ctx, action.get("target", null))
			var reason := ("「%s」" % _ctx_card_name(ctx)) if _ctx_card_name(ctx) != "" else str(action.get("reason", "效果伤害"))
			var card = ctx.get("card", null)
			for t in targets4:
				if t.get("kind", "") == "unit" and t.unit.get("removed", false):
					continue
				deal_damage(source, t, resolve_amount(ctx, action.get("amount", 0), t), {
					"ignoreMechanisms": bool(action.get("ignoreMechanisms", false)),
					"noKeywords": bool(action.get("noKeywords", false)) or bool(ctx.get("noKeywordsForDamage", false)),
					"noWatchers": bool(action.get("noWatchers", false)) or bool(ctx.get("noWatchersForDamage", false)),
					"noDamagedTrigger": bool(action.get("noDamagedTrigger", false)) or bool(ctx.get("noDamagedTriggerForDamage", false)),
					"reason": reason,
					"fromSpell": card is Dictionary and card.get("type", "") == "spell",
				})
				# 「视为攻击」（锦囊带溅射）
				if action.get("asAttack", false) and source != null and t.get("kind", "") == "unit" \
						and not t.unit.get("removed", false):
					var splash = get_keyword(source, "splash")
					if splash != null and float(splash.x) > 0.0:
						var foe_side := 1 - int(source.side)
						for adj in adjacent_of(str(t.unit.lane)):
							for e in lane_units(adj, foe_side):
								if e.get("removed", false):
									continue
								deal_damage(source, {"kind": "unit", "unit": e}, float(splash.x), {
									"noCap": true,
									"reason": "溅射（%s）" % (_ctx_card_name(ctx) if _ctx_card_name(ctx) != "" else "效果"),
								})

		"destroy":
			var targets5 = await resolve_targets(ctx, action.get("target", null))
			for t in targets5:
				if t.get("kind", "") == "unit":
					destroy_unit(t.unit, str(action.get("reason", "effect")))
				elif action.get("allowKing", false):
					state.players[int(t.side)]["kingHp"] = 0.0

		"sacrifice":
			var targets6 = await resolve_targets(ctx, action.get("target", {"kind": "chosenOwnUnit"}))
			for t in targets6:
				if t.get("kind", "") != "unit" or same(t.unit, source):
					continue
				ctx["sacrificed"] = {
					"uid": t.unit.uid, "cardId": t.unit.cardId,
					"atk": float(t.unit.atk), "hp": float(t.unit.hp), "side": t.unit.side,
				}
				destroy_unit(t.unit, "sacrifice")

		"draw":
			var draw_side := resolve_side(action.get("side", null), me)
			var n := 0
			if action.get("target", null) != null:
				var tlist = await resolve_targets(ctx, action.target)
				n = int(resolve_amount(ctx, action.get("amount", 0), tlist[0] if not tlist.is_empty() else null))
			else:
				n = int(resolve_amount(ctx, action.get("amount", 0)))
			draw_cards(draw_side, n)

		"gainMana":
			gain_mana(resolve_side(action.get("side", null), me), int(action.get("amount", 0)))

		"gainManaCap":
			gain_mana_cap(resolve_side(action.get("side", null), me), int(action.get("amount", 0)))

		"heal":
			var targets7 = await resolve_targets(ctx, action.get("target", null))
			for t in targets7:
				if t.get("kind", "") == "unit":
					heal_unit(t.unit, resolve_amount(ctx, action.get("amount", 0), t))
				elif t.get("kind", "") == "king":
					var amount := resolve_amount(ctx, action.get("amount", 0), t)
					if action.get("mode", "") == "halfLost":
						var p: Dictionary = state.players[int(t.side)]
						amount = ceilf(maxf(0.0, float(p.kingMaxHp) - float(p.kingHp)) / 2.0)
					heal_king(int(t.side), amount)

		"buffAtk":
			var targets8 = await resolve_targets(ctx, action.get("target", null))
			for t in targets8:
				if t.get("kind", "") == "unit":
					buff_atk(t.unit, resolve_amount(ctx, action.get("amount", 0), t))

		"buffMaxHp":
			var targets9 = await resolve_targets(ctx, action.get("target", null))
			for t in targets9:
				if t.get("kind", "") == "unit":
					buff_max_hp(t.unit, resolve_amount(ctx, action.get("amount", 0), t))

		"modifyStats":
			var targets10 = await resolve_targets(ctx, action.get("target", null))
			for t in targets10:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				var atk_v := resolve_amount(ctx, action.get("atk", 0), t)
				var max_hp_v := resolve_amount(ctx, action.get("maxHp", 0), t)
				var hp_before := float(t.unit.hp)
				if atk_v != 0.0:
					buff_atk(t.unit, atk_v)
				if max_hp_v > 0.0:
					buff_max_hp(t.unit, max_hp_v)
				elif max_hp_v < 0.0:
					debuff_max_hp(t.unit, -max_hp_v)
				queue_hp_lost(t.unit, hp_before)

		"setStats":
			var targets11 = await resolve_targets(ctx, action.get("target", null))
			for t in targets11:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				var hp_before2 := float(t.unit.hp)
				var vals := {}
				if action.has("hp"):
					vals["hp"] = resolve_amount(ctx, action.hp, t)
				if action.has("maxHp"):
					vals["maxHp"] = resolve_amount(ctx, action.maxHp, t)
				if action.has("atk"):
					vals["atk"] = resolve_amount(ctx, action.atk, t)
				set_unit_stats(t.unit, vals)
				queue_hp_lost(t.unit, hp_before2)

		"transform":
			var targets12 = await resolve_targets(ctx, action.get("target", null))
			for t in targets12:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				transform_unit(t.unit, str(action.get("cardId", "")))

		"attachKingEffect":
			var kside := resolve_side(action.get("side", null), me)
			var kp: Dictionary = state.players[kside]
			if not (kp.get("kingEffects", null) is Array):
				kp["kingEffects"] = []
			for e in action.get("effects", []):
				kp.kingEffects.append(e.duplicate(true))
			log_event({"type": "king-effect-attached", "side": kside, "effects": _triggers_of(action.get("effects", []))})

		"kingInvincible":
			var iside := resolve_side(action.get("side", null), me)
			state.players[iside]["kingInvincibleTurn"] = state.turn
			log_event({"type": "king-invincible", "side": iside, "turn": state.turn})

		"kingShield":
			var sside := resolve_side(action.get("side", "controller"), me)
			state.players[sside]["kingShieldOnce"] = true
			log_event({"type": "king-shield-armed", "side": sside})

		"spellLock":
			var lside := resolve_side(action.get("side", "opponent"), me)
			state.players[lside]["spellLockTurn"] = state.turn + 1
			log_event({"type": "spell-lock", "side": lside, "turn": state.turn + 1})

		"drawFlame":
			var fside := resolve_side(action.get("side", "controller"), me)
			var fn := int(resolve_amount(ctx, action.get("count", 1)))
			for i in fn:
				if draw_flame(fside) == null:
					break

		"resetFlamePile":
			reset_flame_pile(resolve_side(action.get("side", "controller"), me))

		"checkFlameLotus":
			check_flame_lotus(resolve_side(action.get("side", "controller"), me))

		"freeze":
			var targets13 = await resolve_targets(ctx, action.get("target", null))
			for t in targets13:
				if t.get("kind", "") == "unit" and not t.unit.get("removed", false):
					freeze_unit(t.unit)

		"control":
			var targets14 = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
			for t in targets14:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				var card = ctx.get("card", null)
				var moved := control_unit(t.unit, me, {"cardId": card.get("id", null) if card is Dictionary else null})
				if not moved:
					log_event({"type": "control-failed", "uid": t.unit.uid, "name": t.unit.name, "reason": "no-slot-or-rooted"})
					continue
				if action.get("freeze", false):
					freeze_unit(t.unit)
				if action.get("returnAtTurnStart", false):
					if not (state.get("controlReturns", null) is Array):
						state["controlReturns"] = []
					state.controlReturns.append({
						"uid": t.unit.uid, "atTurn": state.turn + 1,
						"owner": t.unit.get("charmOrigin", null),
					})

		"duel":
			var first = await resolve_targets(ctx, action.get("target", {"kind": "chosenAnyUnit"}))
			var a = first[0].unit if (not first.is_empty() and first[0].get("kind", "") == "unit") else null
			if a == null or a.get("removed", false):
				return
			var sub := ctx.duplicate()
			sub["chosenTargetUid"] = null
			sub["chosenTargetIsKing"] = false
			sub["chosenTargetKingSide"] = null
			var second_spec: Dictionary = {"kind": "chosenAnyUnit"}
			for k in action.get("second", {}).keys():
				second_spec[k] = action.second[k]
			second_spec["excludeUid"] = int(a.uid)
			second_spec["prompt"] = action.get("prompt", "让谁和「%s」战斗" % a.name)
			var second = await resolve_targets(sub, second_spec)
			var b = second[0].unit if (not second.is_empty() and second[0].get("kind", "") == "unit") else null
			if b == null or b.get("removed", false) or int(b.uid) == int(a.uid):
				return
			duel_units(ctx, a, b)

		"extraAttack":
			var targets15 = await resolve_targets(ctx, action.get("target", {"kind": "chosenOwnUnit"}))
			for t in targets15:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				await api_extra_attack(t.unit)

		"seal":
			var targets16 = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
			for t in targets16:
				if t.get("kind", "") == "unit":
					seal_unit(t.unit, str(action.get("reason", "seal")))

		"lockLane":
			var lanes: Array = action.get("lanes", [action.lane] if action.has("lane") else [])
			if lanes.is_empty():
				push_error("lockLane 需要 lane 或 lanes")
				return
			var turns := 1
			if action.has("turns"):
				turns = int(resolve_amount(ctx, action.turns))
			for l in lanes:
				if not KPC.LANES.has(str(l)):
					push_error("lockLane: 未知线路 %s" % str(l))
					continue
				state.laneLocks[str(l)] = state.turn + turns
			log_event({"type": "lane-lock", "lanes": lanes, "until": state.turn + turns})

		"discardDrawn":
			var dside := resolve_side(action.get("side", "opponent"), me)
			var cards: Array = ctx.get("payload", {}).get("cards", [])
			var dp: Dictionary = state.players[dside]
			var count := 0
			for card_id in cards:
				var i := _find_hand_index(dp.hand, "-", int(card_id) if card_id is int else -1, str(card_id))
				if i < 0:
					continue
				var gone = dp.hand[i]
				dp.hand.remove_at(i)
				state.discard.append(gone.cardId)
				count += 1
			log_event({"type": "discard-drawn", "side": dside, "count": count})

		"returnToDeck":
			await _op_return_to_deck(ctx, action, me)

		"modifyHandCost":
			var mside := resolve_side(action.get("side", null), me)
			var mp: Dictionary = state.players[mside]
			var delta := resolve_amount(ctx, action.get("amount", 0))
			var mcount := 0
			for c in mp.hand:
				var d: Dictionary = state.cardLib.get(c.cardId, {})
				if d.is_empty():
					continue
				var filt = action.get("cardFilter", null)
				if filt is Dictionary:
					if filt.has("type") and d.get("type", "") != filt.type:
						continue
					if filt.has("spellKind") and d.get("spellKind", "") != filt.spellKind:
						continue
				c["costDelta"] = float(c.get("costDelta", 0)) + delta
				mcount += 1
			log_event({"type": "hand-cost", "side": mside, "delta": delta, "count": mcount})

		"summon":
			var sside2 := resolve_side(action.get("side", null), me)
			var lane = action.get("lane", ctx.get("chosenLane", null))
			var row := str(action.get("row", "front"))
			if lane == null:
				var pick = await ask_summon_cell(ctx, sside2, str(action.get("cardId", "")), str(action.get("prompt", "")))
				if pick != null:
					lane = pick.lane
					row = pick.row
			summon_token(sside2, str(action.get("cardId", "")), str(lane) if lane != null else "", row, action.get("modify", null))

		"delayedSummon":
			var dside2 := resolve_side(action.get("side", null), me)
			var spot = await ask_summon_cell(ctx, dside2, str(action.get("cardId", "")), str(action.get("prompt", "")))
			queue_delayed_summon(dside2, str(action.get("cardId", "")), int(resolve_amount(ctx, action.get("delay", 1))), spot)

		"summonToHand":
			var hside := resolve_side(action.get("side", null), me)
			var hn := int(resolve_amount(ctx, action.get("count", 1)))
			var modify = resolve_summon_modify(ctx, action.get("modify", null))
			for i in hn:
				give_card_to_hand(hside, str(action.get("cardId", "")), modify)

		"endTurnNow":
			await end_turn_now()

		"summonRandomToken":
			var rside := resolve_side(action.get("side", null), me)
			var rn := int(resolve_amount(ctx, action.get("count", 1)))
			var my_faction = state.players[rside].get("faction", null)
			var pool: Array = []
			for id in state.cardLib.keys():
				var c: Dictionary = state.cardLib[id]
				if not c.get("token", false) or c.get("rawMaterial", false) or c.get("noRandomSummon", false):
					continue
				if c.get("faction", null) != null and c.get("faction", null) != my_faction:
					continue
				pool.append(id)
			pool.sort()
			if pool.is_empty():
				return
			var rmodify = resolve_summon_modify(ctx, action.get("modify", null))
			for i in rn:
				give_card_to_hand(rside, str(pool[state.rng.next_int(pool.size())]), rmodify)

		"move":
			var targets17 = await resolve_targets(ctx, action.get("target", {"kind": "chosenOwnUnit"}))
			for t in targets17:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				var rooted_fn := func(u): return has_rooted(u)
				if action.get("lane", null) != null:
					move_unit_to_lane(t.unit, str(action.lane), {"isRooted": rooted_fn})
					continue
				var lanes2: Array = []
				for l in KPC.LANES:
					if can_move_to(t.unit, l, {"isRooted": rooted_fn}):
						lanes2.append(l)
				if lanes2.is_empty():
					continue
				var lopts: Array = []
				for l in lanes2:
					lopts.append({"lane": l, "label": KPC.LANE_NAME.get(l, l)})
				var answer2 = await take_choice({
					"type": "chooseLane",
					"side": me,
					"prompt": action.get("prompt", "把「%s」移到哪条线路" % t.unit.name),
					"options": lopts,
				})
				if answer2 is Dictionary and answer2.get("lane", null) != null:
					move_unit_to_lane(t.unit, str(answer2.lane), {"isRooted": rooted_fn})

		"discard":
			await _op_discard(ctx, action, me)

		"chooseLanes":
			var want := maxi(1, int(action.get("count", 1)))
			var picked_lanes: Array = []
			for i in want:
				var cands: Array = []
				for l in KPC.LANES:
					if picked_lanes.has(l):
						continue
					if action.get("adjacent", false) and not picked_lanes.is_empty():
						var all_adj := true
						for p in picked_lanes:
							if not adjacent_of(p).has(l):
								all_adj = false
								break
						if not all_adj:
							continue
					cands.append(l)
				if cands.is_empty():
					break
				if cands.size() == 1:
					picked_lanes.append(cands[0])
					continue
				var copts: Array = []
				for l in cands:
					copts.append({"lane": l, "label": KPC.LANE_NAME.get(l, l)})
				var answer3 = await take_choice({
					"type": "chooseLane",
					"side": me,
					"prompt": action.get("prompt", "选择一条线路"),
					"options": copts,
				})
				if not (answer3 is Dictionary) or answer3.get("lane", null) == null:
					break
				picked_lanes.append(str(answer3.lane))
			ctx["chosenLanes"] = picked_lanes

		"clearFreeze":
			var cleared := 0
			for u in all_units():
				if not is_frozen(u):
					continue
				var kept: Array = []
				for m in u.marks:
					if m.type != "freeze":
						kept.append(m)
				u["marks"] = kept
				cleared += 1
			if cleared > 0:
				log_event({"type": "clear-freeze", "count": cleared})

		"attachEffect":
			var targets18 = await resolve_targets(ctx, action.get("target", {"kind": "compoundTarget"}))
			for t in targets18:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				if not (t.unit.get("effects", null) is Array):
					t.unit["effects"] = []
				for e in action.get("effects", []):
					t.unit.effects.append(e.duplicate(true))
				log_event({"type": "effect-attached", "uid": t.unit.uid, "effects": _triggers_of(action.get("effects", []))})

		"stealRandomHand":
			var from_side := resolve_side(action.get("from", null), me) if action.has("from") else foe
			var to_side := resolve_side(action.get("to", null), me) if action.has("to") else me
			var src: Dictionary = state.players[from_side]
			if src.hand.is_empty():
				return
			var ridx: int = state.rng.next_int(src.hand.size())
			var gone2 = src.hand[ridx]
			src.hand.remove_at(ridx)
			state.discard.append(gone2.cardId)
			log_event({"type": "discard", "side": from_side, "cardId": gone2.cardId, "iid": gone2.iid, "stolen": true})
			state.players[to_side].hand.append({"iid": _next_iid(), "cardId": gone2.cardId})
			log_event({"type": "steal-hand", "side": to_side, "from": from_side, "cardId": gone2.cardId})

		"grantKeyword":
			var targets19 = await resolve_targets(ctx, action.get("target", null))
			for t in targets19:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				grant_keyword(t.unit, str(action.get("keyword", "")), float(action.get("x", 0)),
					{"untilTurn": state.turn} if action.get("untilTurnEnd", false) else {})

		"chooseKeywords":
			var targets20 = await resolve_targets(ctx, action.get("target", null))
			var unit = null
			for t in targets20:
				if t.get("kind", "") == "unit" and t.unit != null and not t.unit.get("removed", false):
					unit = t.unit
					break
			var kn := int(action.get("count", 1))
			var kx := float(action.get("x", 0))
			var exclude: Array = KEYWORDS_NOT_GRANTABLE.duplicate()
			for e in action.get("exclude", []):
				exclude.append(e)
			var chosen: Array = []
			for i in kn:
				var kopts: Array = []
				for id in KEYWORD_DEFS.keys():
					if exclude.has(id) or chosen.has(id):
						continue
					kopts.append({"id": id, "label": str(KEYWORD_DEFS[id].get("name", id))})
				if kopts.is_empty():
					break
				var answer4 = await take_choice({
					"type": "chooseKeyword",
					"side": me,
					"prompt": action.get("prompt", "选择第 %d 个词条" % (i + 1)),
					"options": kopts,
				})
				var kid := str(kopts[0].id)
				if answer4 is Dictionary:
					for o in kopts:
						if o.id == answer4.get("id", ""):
							kid = str(o.id)
							break
				chosen.append(kid)
			if unit != null:
				for id in chosen:
					grant_keyword(unit, id, kx)
			log_event({
				"type": "keyword-granted", "side": me,
				"uid": unit.uid if unit != null else null, "keywords": chosen, "x": kx,
			})

		"grantKeywordBuff":
			var targets21 = await resolve_targets(ctx, action.get("target", null))
			for t in targets21:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				if action.get("keyword", "") != "":
					grant_keyword(t.unit, str(action.keyword), float(action.get("x", 0)),
						{"untilTurn": state.turn} if action.get("untilTurnEnd", false) else {})
				if action.get("maxHp", null) != null:
					buff_max_hp(t.unit, resolve_amount(ctx, action.maxHp, t))
				if action.get("atk", null) != null:
					buff_atk(t.unit, resolve_amount(ctx, action.atk, t))

		"stealToHand":
			var targets22 = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
			for t in targets22:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				var stolen_id: String = t.unit.cardId
				vanish_unit(t.unit, "steal")
				state.players[me].hand.append({"iid": _next_iid(), "cardId": stolen_id})
				log_event({"type": "steal-to-hand", "cardId": stolen_id, "side": me})

		"bounce":
			var targets23 = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
			for t in targets23:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				bounce_unit(t.unit, {
					"isRooted": func(u): return has_rooted(u),
					"keepStats": bool(action.get("preserveStats", false)),
				})

		"repeatLastSpell":
			var pp: Dictionary = state.players[me]
			var prev_id = pp.get("lastSpell", null)
			if prev_id == null or prev_id == pp.get("currentSpell", null):
				return
			var prev_def: Dictionary = state.cardLib.get(prev_id, {})
			if prev_def.is_empty() or prev_def.get("type", "") == "unit":
				return
			if JSON.stringify(prev_def.get("actions", [])).contains("repeatLastSpell"):
				return
			var sub2 := ctx.duplicate()
			sub2["source"] = null
			sub2["chosenTargetUid"] = null
			sub2["chosenTargetIsKing"] = false
			sub2["card"] = prev_def
			await exec_actions(sub2, prev_def.get("actions", []))

		"compound":
			var picked_c = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyTarget"}))
			if picked_c.is_empty():
				return
			var first_c: Dictionary = picked_c[0]
			var sub3 := ctx.duplicate()
			sub3["chosenTargetUid"] = int(first_c.unit.uid) if first_c.get("kind", "") == "unit" else null
			sub3["chosenTargetIsKing"] = first_c.get("kind", "") == "king"
			sub3["chosenTargetKingSide"] = int(first_c.side) if first_c.get("kind", "") == "king" else null
			await exec_actions(sub3, action.get("actions", []))

		"delayedDraw":
			var dd_side := resolve_side(action.get("side", null), me)
			var dd_n := int(action.get("n", 1))
			var dd_delay := int(action.get("delay", 1))
			if not (state.get("delayedDraws", null) is Array):
				state["delayedDraws"] = []
			state.delayedDraws.append({"side": dd_side, "n": dd_n, "atTurn": state.turn + dd_delay})

		"randomOne":
			var ropts: Array = action.get("options", [])
			if ropts.is_empty():
				return
			var pick_o = ropts[state.rng.next_int(ropts.size())]
			await exec_actions(ctx, pick_o.get("actions", pick_o))

		"permanentHandCost":
			var ph_side := resolve_side(action.get("side", null), me)
			var ph_amount := float(action.get("amount", -1))
			var php: Dictionary = state.players[ph_side]
			php["handCostDelta"] = float(php.get("handCostDelta", 0)) + ph_amount

		"buffKeywordX":
			var targets24 = await resolve_targets(ctx, action.get("target", {"kind": "self"}))
			for t in targets24:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				buff_keyword_x(t.unit, str(action.get("keyword", "")), float(action.get("x", 1)))

		"lockAtk":
			if action.get("untilTurnEnd", false):
				state["atkZeroTurn"] = state.turn
				log_event({"type": "atk-zero-turn", "turn": state.turn})
				return
			var targets25 = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
			for t in targets25:
				if t.get("kind", "") != "unit" or t.unit.get("removed", false):
					continue
				lock_atk(t.unit, float(action.get("value", 0)))

		"kingDamageReduce":
			var kr_side := resolve_side(action.get("side", null), me)
			state.players[kr_side]["kingDamageReduce"] = {"amount": float(action.get("amount", 0)), "turn": state.turn}

		"unlockAlchemySpells":
			var ua_side := resolve_side(action.get("side", null), me)
			state.players[ua_side]["alchemyUnlock"] = true
			log_event({"type": "alchemy-unlock", "side": ua_side})

		"alchemyTide":
			var at_side := resolve_side(action.get("side", null), me)
			state.players[at_side]["alchemyTideTurn"] = state.turn
			log_event({"type": "alchemy-tide-start", "side": at_side, "turn": state.turn})

		"addRawMaterials":
			var ar_side := resolve_side(action.get("side", null), me)
			var ar_n := int(action.get("amount", 2))
			for i in ar_n:
				var pile: Array = state.players[ar_side].get("rawPile", [])
				var kinds: Array = []
				for id in RAW_MATERIAL_IDS:
					if pile.has(id) and not kinds.has(id):
						kinds.append(id)
				if kinds.is_empty():
					log_event({"type": "raw-material-empty", "side": ar_side})
					break
				var picked_rm: String = kinds[0]
				if kinds.size() > 1:
					var rm_opts: Array = []
					for id in kinds:
						var cnt := 0
						for x in pile:
							if x == id:
								cnt += 1
						rm_opts.append({
							"cardId": id,
							"label": "%s x%d" % [state.cardLib.get(id, {}).get("name", id), cnt],
						})
					var answer5 = await take_choice({
						"type": "chooseRawMaterial",
						"side": ar_side,
						"prompt": action.get("prompt", "选择一张原料"),
						"options": rm_opts,
					})
					if answer5 is Dictionary and answer5.get("cardId", null) != null:
						picked_rm = str(answer5.cardId)
				take_raw_material(ar_side, picked_rm, {"free": action.get("free", true) != false})

		"summonSelf":
			if source == null or source.get("removed", false):
				return
			var ss_side := resolve_side(action.get("side", "controller"), me)
			var made = summon_token(ss_side, source.cardId, source.lane, source.row, null, true)
			log_event({"type": "summon-self", "side": ss_side, "cardId": source.cardId, "uid": made.get("uid", null) if made != null else null})

		"setKingHp":
			var sk_side := resolve_side(action.get("side", "controller"), me)
			var skp: Dictionary = state.players[sk_side]
			var sv := resolve_amount(ctx, action.get("amount", 1))
			skp["kingHp"] = maxf(0.0, minf(float(skp.get("kingMaxHp", 20)), sv))
			log_event({"type": "set-king-hp", "side": sk_side, "hp": skp.kingHp})

		"discardHandUnits":
			var du_side := resolve_side(action.get("side", "opponent"), me)
			var dup: Dictionary = state.players[du_side]
			var keep: Array = []
			var dn := 0
			for c in dup.hand:
				var d2: Dictionary = state.cardLib.get(c.cardId, {})
				if d2.get("type", "") == "unit":
					state.discard.append(c.cardId)
					dn += 1
					log_event({"type": "discard", "side": du_side, "cardId": c.cardId, "iid": c.iid, "from": "fuse-hand"})
				else:
					keep.append(c)
			dup["hand"] = keep
			log_event({"type": "discard-hand-units", "side": du_side, "count": dn})

		_:
			push_error("未知的效果 op: %s" % str(action.get("op", "")))


func _triggers_of(effects: Array) -> Array:
	var out: Array = []
	for e in effects:
		out.append(e.get("trigger", ""))
	return out


func _find_hand_index(hand: Array, _unused: String, iid: int, card_id: String) -> int:
	if iid >= 0:
		for i in hand.size():
			if int(hand[i].iid) == iid:
				return i
	for i in hand.size():
		if str(hand[i].cardId) == card_id:
			return i
	return -1


## `returnToDeck` op（手牌 / 场面 → 牌库）
func _op_return_to_deck(ctx: Dictionary, action: Dictionary, me: int) -> void:
	var side := resolve_side(action.get("side", null), me)
	var p: Dictionary = state.players[side]
	var from := str(action.get("from", "hand"))
	var to := str(action.get("to", "top"))
	var filt = action.get("cardFilter", null)
	var match_fn := func(c: Dictionary) -> bool:
		var d: Dictionary = state.cardLib.get(c.cardId, {})
		if filt is Dictionary:
			if filt.has("type") and d.get("type", "") != filt.type:
				return false
			if filt.has("spellKind") and d.get("spellKind", "") != filt.spellKind:
				return false
		return true

	if from == "hand":
		var pool: Array = []
		for c in p.hand:
			if match_fn.call(c):
				pool.append(c)
		var want: int = pool.size()
		if action.has("count"):
			want = clampi(int(resolve_amount(ctx, action.count)), 0, pool.size())
		var picked: Array = []
		while picked.size() < want and not pool.is_empty():
			if pool.size() == 1 or want == pool.size():
				picked.append(pool.pop_front())
				continue
			var h_opts: Array = []
			for c in pool:
				h_opts.append({"iid": int(c.iid), "label": str(state.cardLib.get(c.cardId, {}).get("name", c.cardId))})
			var answer = await take_choice({
				"type": "chooseHandCard",
				"side": side,
				"prompt": action.get("prompt", "选择要放回牌组的牌"),
				"options": h_opts,
			})
			var idx := 0
			if answer is Dictionary:
				for i in pool.size():
					if int(pool[i].iid) == int(answer.get("iid", -1)):
						idx = i
						break
			picked.append(pool[idx])
			pool.remove_at(idx)
		var drop_ids: Array = []
		for c in picked:
			drop_ids.append(int(c.iid))
		var kept: Array = []
		for c in p.hand:
			if not drop_ids.has(int(c.iid)):
				kept.append(c)
		p["hand"] = kept
		var card_ids: Array = []
		for c in picked:
			card_ids.append(c.cardId)
		return_cards_to_deck(card_ids, to)
	elif from == "board":
		var targets = await resolve_targets(ctx, action.get("target", {"kind": "chosenEnemyUnit"}))
		for t in targets:
			if t.get("kind", "") != "unit" or t.unit.get("removed", false):
				continue
			var cid: String = t.unit.cardId
			vanish_unit(t.unit, "return-to-deck")
			return_cards_to_deck([cid], to)


## `discard` op
func _op_discard(ctx: Dictionary, action: Dictionary, me: int) -> void:
	var side := resolve_side(action.get("side", null), me)
	var n := int(action.get("amount", 1))
	for i in n:
		var p: Dictionary = state.players[side]
		if p.hand.is_empty():
			break
		var picked_iid := -1
		if p.hand.size() > 1:
			var human: int = int(state.get("humanSide", 0))
			var h_opts: Array = []
			for c in p.hand:
				h_opts.append({"iid": int(c.iid), "label": str(state.cardLib.get(c.cardId, {}).get("name", c.cardId))})
			var request := {
				"type": "chooseHandCard",
				"side": side,
				"prompt": action.get("prompt", "选择要弃置的手牌"),
				"options": h_opts,
			}
			if side == human:
				request["noAuto"] = true
			var answer = await take_choice(request)
			if answer is Dictionary:
				picked_iid = int(answer.get("iid", -1))
		var idx := 0
		for j in p.hand.size():
			if int(p.hand[j].iid) == picked_iid:
				idx = j
				break
		var gone = p.hand[idx]
		p.hand.remove_at(idx)
		state.discard.append(gone.cardId)
		log_event({"type": "discard", "side": side, "cardId": gone.cardId, "iid": gone.iid})


## 召唤物的数值修正里，动态字段在这里解析
func resolve_summon_modify(ctx: Dictionary, modify: Variant) -> Variant:
	if modify == null:
		return null
	if not (modify is Dictionary):
		return modify
	if not modify.has("costDelta") or modify.costDelta == null:
		return modify
	if modify.costDelta is int or modify.costDelta is float:
		return modify
	var out: Dictionary = modify.duplicate()
	out["costDelta"] = resolve_amount(ctx, modify.costDelta)
	return out


## `conditional` op 的条件求值
func eval_condition(ctx: Dictionary, cond: Variant) -> bool:
	if cond == null:
		return false
	if cond is Callable:
		return bool(cond.call(state, ctx))
	var me: int = int(ctx.get("controller", 0))
	var own := 0
	var foes := 0
	for u in all_units():
		if int(u.side) == me:
			own += 1
		else:
			foes += 1
	if cond is Dictionary:
		if cond.has("turnAtLeast"):
			return state.turn >= int(cond.turnAtLeast)
		if cond.has("ownKingHpAtMost"):
			return float(state.players[me].kingHp) <= float(cond.ownKingHpAtMost)
		match str(cond.get("compare", "")):
			"ownUnitsGE":
				var list: Array = []
				for u in all_units():
					if int(u.side) == me and not (cond.get("excludeSource", false) and same(u, ctx.get("source", null))):
						list.append(u)
				return list.size() >= int(cond.get("n", 1))
			"foeUnitsGE":
				var list2: Array = []
				for u in all_units():
					if int(u.side) != me and not (cond.get("excludeSource", false) and same(u, ctx.get("source", null))):
						list2.append(u)
				return list2.size() >= int(cond.get("n", 1))
			"enemiesLEAllies":
				return foes <= own
			"enemiesLTAllies":
				return foes < own
			"enemiesGEAllies":
				return foes >= own
			"enemiesGTAllies":
				return foes > own
			"handCountLE":
				return state.players[me].hand.size() <= int(cond.get("n", 7))
			"turnAtLeast":
				return state.turn >= int(cond.get("n", 1))
			"ownKingHpAtMost":
				return float(state.players[me].kingHp) <= float(cond.get("n", 1))
			_:
				push_error("未知的 conditional 条件: %s" % str(cond))
				return false
	return false


# ══════════════════════════════════════════════════════════
# §10 触发队列与交互挂起（choices.js）
# ══════════════════════════════════════════════════════════

## 「每回合只发动一次」的判定
func once_per_turn_blocked(unit: Dictionary, key: String) -> bool:
	if not (unit.get("onceTurn", null) is Dictionary):
		unit["onceTurn"] = {}
	if int(unit.onceTurn.get(key, -1)) == state.turn:
		return true
	unit.onceTurn[key] = state.turn
	return false


func _answered_by_ai(request: Dictionary) -> bool:
	var ai = state.get("aiSides", null)
	if not (ai is Array) or ai.is_empty():
		return false
	if not request.has("side"):
		return false
	return ai.has(int(request.side))


func _first_option(request: Dictionary) -> Variant:
	var opts: Array = request.get("options", [])
	return opts[0] if not opts.is_empty() else {}


func _hold(request: Dictionary, answer: Variant) -> Variant:
	if state.get("choiceLog", null) is Array:
		state.choiceLog.append({"type": request.get("type", ""), "v": answer})
	if state.get("qTrace", null) is Array:
		state.qTrace.append("A@%s:%s" % [state.stats.get("cardsPlayed", 0), request.get("type", "")])
	return answer


func _hold_hang(request: Dictionary) -> void:
	if state.get("choiceLog", null) is Array:
		state.choiceLog.append({"type": request.get("type", ""), "hang": true})
	if state.get("qTrace", null) is Array:
		state.qTrace.append("H@%s:%s" % [state.stats.get("cardsPlayed", 0), request.get("type", "")])


## 挂起：等界面把答案喂回来。这是 JS 版 generator 挂起在 GDScript 里的等价物。
func _hang(request: Dictionary) -> Variant:
	_hold_hang(request)
	pending_request = request
	choice_needed.emit(request)
	await _choice_answered
	pending_request = null
	var ans: Variant = _choice_answer
	_choice_answer = null
	return ans


## 一问的最后裁定：优先 chooser → AI 侧自答 → noAuto 挂起 → 自动代答 → 挂起
func take_choice(request: Dictionary) -> Variant:
	var chooser = state.get("chooser", null)
	if chooser != null and chooser is Callable:
		var via = chooser.call(request)
		if via != null:
			if same(via, PENDING):
				return await _hang(request)
			if state.get("chooserRecords", false) and state.get("choiceLog", null) is Array:
				state.choiceLog.append({"type": request.get("type", ""), "v": via})
			return via

	if _answered_by_ai(request):
		var choose = request.get("choose", null)
		if choose != null and choose is Callable:
			var picked = choose.call()
			if picked != null:
				return _hold(request, picked)
		return _hold(request, _first_option(request))

	if request.get("noAuto", false):
		return await _hang(request)

	if state.get("autoResolveChoices", true):
		var choose2 = request.get("choose", null)
		if choose2 != null and choose2 is Callable:
			var picked2 = choose2.call()
			if picked2 != null:
				return _hold(request, picked2)
		return _hold(request, _first_option(request))

	return await _hang(request)


## 界面把答案喂回来，恢复被挂起的结算
func resolve_choice(answer: Variant) -> void:
	if pending_request == null:
		push_error("当前没有待处理的交互请求")
		return
	_choice_answer = answer
	_choice_answered.emit()


func has_pending() -> bool:
	return pending_request != null


func when_met(when: Variant, payload: Dictionary) -> bool:
	if when == null:
		return true
	if when is String and when == "fused":
		return bool(payload.get("fused", false))
	if when is Dictionary:
		if when.has("lane") and payload.get("lane", null) != when.lane:
			return false
		if when.has("deathsAtLeast") and int(state.stats.get("unitsDestroyed", 0)) < int(when.deathsAtLeast):
			return false
		if when.has("turnAtLeast") and state.turn < int(when.turnAtLeast):
			return false
		return true
	push_error("未知的 effect.when: %s" % str(when))
	return false


func run_triggered_effects(unit: Dictionary, trigger_name: String, payload: Dictionary = {}, override: Variant = null) -> void:
	if is_sealed(unit) or is_sealed_by_aura(unit):
		return
	var source_effects: Array = unit.get("effects", [])
	if override is Dictionary and override.get("effects", null) != null:
		source_effects = override.effects
	var list: Array = []
	for e in source_effects:
		if e.get("trigger", "") == trigger_name:
			list.append(e)

	for ei in list.size():
		var effect: Dictionary = list[ei]
		if not when_met(effect.get("when", null), payload):
			continue
		if effect.get("oncePerTurn", false) and once_per_turn_blocked(unit, "%s:%d" % [trigger_name, ei]):
			continue
		var card = state.cardLib.get(unit.cardId, null)
		if override is Dictionary and override.get("cardId", null) != null:
			card = state.cardLib.get(override.cardId, card)
		var ctx := {
			"source": unit,
			"controller": int(unit.side),
			"card": card,
			"chosenLane": unit.lane,
			"chosenTargetUid": null,
			"payload": payload,
			"noKeywordsForDamage": trigger_name == "onDealDamage",
			"noWatchersForDamage": trigger_name == "onEnemyDamaged",
			"noDamagedTriggerForDamage": trigger_name == "onDamaged",
		}
		var times := 1
		if effect.get("repeat", "") == "damageAmount":
			times = maxi(1, int(payload.get("amount", 1)))
		for i in times:
			await exec_actions(ctx, effect.get("actions", []))


func run_king_triggered_effects(side: int, trigger_name: String, payload: Dictionary = {}) -> void:
	var list: Array = []
	for e in state.players[side].get("kingEffects", []):
		if e.get("trigger", "") == trigger_name:
			list.append(e)
	for effect in list:
		var ctx := {
			"source": null,
			"controller": side,
			"card": null,
			"chosenLane": null,
			"chosenTargetUid": null,
			"payload": payload,
		}
		await exec_actions(ctx, effect.get("actions", []))


## 一张牌自己的卡面效果（不是单位异能，也不是国王附着异能）
func run_card_triggered_actions(side: int, card_id: String, actions: Array, payload: Dictionary = {}) -> void:
	var def: Dictionary = state.cardLib.get(card_id, {})
	var ctx := {
		"controller": side,
		"card": def,
		"source": null,
		"chosenLane": null,
		"chosenTargetUid": null,
		"chosenTargetIsKing": false,
		"payload": payload,
	}
	var kws: Array = def.get("keywords", [])
	if not kws.is_empty():
		var parsed: Array = []
		for k in kws:
			parsed.append(parse_keyword(k))
		ctx["source"] = {
			"uid": -_next_uid(), "cardId": def.get("id", card_id), "name": def.get("name", card_id),
			"side": side, "lane": null, "row": "front",
			"atk": 0.0, "hp": 0.0, "maxHp": 0.0,
			"keywords": parsed, "effects": [], "marks": [], "removed": false, "virtual": true,
		}
	await exec_actions(ctx, actions)


## 把触发队列清空（协程版：挂起会一路传回最外层）
func flush_triggers() -> void:
	var guard := 0
	while not state.triggerQueue.is_empty():
		guard += 1
		if guard > 1000:
			push_error("触发链超过 1000 步，可能存在无限循环")
			return
		var t: Dictionary = state.triggerQueue.pop_front()
		if t.has("cardSide"):
			await run_card_triggered_actions(int(t.cardSide), str(t.cardId), t.get("actions", []), t.get("payload", {}))
		elif t.has("kingSide"):
			await run_king_triggered_effects(int(t.kingSide), str(t.triggerName), t.get("payload", {}))
		else:
			var override = null
			if t.get("effects", null) != null:
				override = {"effects": t.effects, "cardId": t.get("cardId", null)}
			await run_triggered_effects(t.unit, str(t.triggerName), t.get("payload", {}), override)


# ══════════════════════════════════════════════════════════
# §11 开战结算（combat.js）
# ══════════════════════════════════════════════════════════

func run_combat() -> void:
	log_event({"type": "combat-start", "turn": state.turn})
	for lane in KPC.LANES:
		if is_over():
			return
		queue_combat_start_triggers(lane)
		await flush_triggers()
		if is_over():
			return
		await resolve_lane(lane)
		check_game_over()
	log_event({"type": "combat-end"})
	sync_stat_auras()


func queue_combat_start_triggers(lane: String) -> void:
	var list: Array = lane_units(lane, 0)
	list.append_array(lane_units(lane, 1))
	for u in list:
		if u.get("removed", false):
			continue
		if _has_effect_trigger(u, "onCombatStart"):
			queue_trigger(u, "onCombatStart", {"lane": lane})


## 「拟定目标攻击」：轮到它出手的那一刻问一次（真人挂起，AI 自答）
func pick_combat_target(unit: Dictionary) -> void:
	if unit.get("removed", false) or not unit.get("choosesTarget", false):
		return
	if state.combatPlans.has(str(unit.uid)):
		return
	if state.combatTargetAsked.get(str(unit.uid), false):
		return
	state.combatTargetAsked[str(unit.uid)] = true

	var foe := 1 - int(unit.side)
	var options: Array = []
	for u in all_units():
		if u.get("removed", false) or int(u.side) != foe:
			continue
		options.append({
			"uid": int(u.uid), "side": int(u.side), "hp": float(u.hp), "atk": attack_power(u),
			"label": "%s（%s/%s）· %s%s" % [
				u.name, _num_s(attack_power(u)), _num_s(u.hp),
				KPC.LANE_NAME.get(u.lane, u.lane), "前排" if u.row == "front" else "后排",
			],
		})
	options.append({
		"king": true, "side": foe,
		"label": "敌方国王（%s 血）" % _num_s(state.players[foe].kingHp),
	})

	var human: int = int(state.get("humanSide", 0))
	var request := {
		"type": "combatTarget",
		"side": int(unit.side),
		"uid": int(unit.uid),
		"prompt": "%s 要打谁？" % unit.name,
		"options": options,
		"choose": func(): return auto_combat_target(unit, foe, options),
	}
	if int(unit.side) == human:
		request["noAuto"] = true

	var answer = await take_choice(request)
	if answer is Dictionary and answer.get("king", false):
		state.combatPlans[str(unit.uid)] = {"king": true, "side": foe}
		log_event({"type": "combat-target", "uid": unit.uid, "name": unit.name, "king": true, "side": foe})
	elif answer is Dictionary and answer.get("uid", null) != null:
		var uid := int(answer.uid)
		state.combatPlans[str(unit.uid)] = {"uid": uid}
		var picked = find_unit(uid)
		log_event({
			"type": "combat-target", "uid": unit.uid, "name": unit.name,
			"targetUid": uid, "targetName": picked.name if picked != null else "#%d" % uid,
		})


## 自动结算（AI 侧 / 没有界面）时挑一个目标
func auto_combat_target(unit: Dictionary, foe: int, options: Array) -> Variant:
	var picker = state.get("targetPicker", null)
	if picker != null and picker is Callable:
		var r = picker.call(unit, foe, options)
		if r != null:
			return r
	return combat_target_picker(unit, options)


## 「拟定目标攻击」在自动结算下怎么挑：能一击打死就打，否则打国王
func combat_target_picker(unit: Dictionary, options: Array) -> Variant:
	var atk := attack_power(unit)
	var best = null
	for o in options:
		if o.get("king", false) or o.get("uid", null) == null:
			continue
		var u = find_unit(int(o.uid))
		if u == null or u.get("removed", false):
			continue
		var hp: float = float(o.get("hp", u.hp))
		if atk >= hp and (best == null or hp > float(best.hp)):
			best = {"uid": int(o.uid), "hp": hp}
	if best != null:
		for o in options:
			if int(o.get("uid", -1)) == int(best.uid):
				return o
	for o in options:
		if o.get("king", false):
			return o
	return null


## 开战结算时这只单位实际打谁（undefined 语义用 null + has 标记）
func combat_plan_primary(unit: Dictionary) -> Variant:
	if not unit.get("choosesTarget", false):
		return null
	var plan = state.combatPlans.get(str(unit.uid), null)
	if plan == null:
		return null
	if plan.get("king", false):
		return {"kind": "king", "side": 1 - int(unit.side)}
	var picked = find_unit(int(plan.get("uid", -1)))
	if picked != null and not picked.get("removed", false) and int(picked.side) != int(unit.side):
		return {"kind": "unit", "unit": picked}
	return null


func ask_combat_targets(attackers: Array) -> void:
	for u in attackers:
		if u.get("removed", false):
			continue
		await pick_combat_target(u)


func resolve_lane(lane: String) -> void:
	var would_attack: Array = []
	for u in lane_units(lane, 0) + lane_units(lane, 1):
		if attack_power(u) > 0.0 and not u.get("removed", false) and not has_keyword(u, "cannotAttack"):
			would_attack.append(u)
	if would_attack.is_empty():
		return

	var attackers := consume_freeze(would_attack)
	if attackers.is_empty():
		return

	var uids: Array = []
	for u in attackers:
		uids.append(int(u.uid))
	log_event({"type": "lane-combat", "lane": lane, "name": KPC.LANE_NAME.get(lane, lane), "attackers": uids})

	var first_strikers: Array = []
	var normal: Array = []
	for u in attackers:
		if has_keyword(u, "firstStrike"):
			first_strikers.append(u)
		else:
			normal.append(u)

	await ask_combat_targets(first_strikers)
	var alive_normal: Array = []
	for u in normal:
		if not u.get("removed", false):
			alive_normal.append(u)
	await ask_combat_targets(alive_normal)

	var kills: Array = []
	if not first_strikers.is_empty():
		var fs_uids: Array = []
		for u in first_strikers:
			fs_uids.append(int(u.uid))
		log_event({"type": "first-strike", "lane": lane, "uids": fs_uids})
		kills.append_array(await apply_attack_batch(lane, first_strikers))
	var survivors: Array = []
	for u in normal:
		if not u.get("removed", false):
			survivors.append(u)
	if not survivors.is_empty():
		kills.append_array(await apply_attack_batch(lane, survivors))

	# ── 额外攻击（双重打击 / 狂热）
	const MAX_EXTRA_PER_TURN := 8
	var killed_by: Array = []
	for k in kills:
		if not killed_by.has(int(k.killerUid)):
			killed_by.append(int(k.killerUid))

	for u in attackers:
		if u.get("removed", false) or is_over():
			continue
		if state.extraAttackUsed.get(str(u.uid), false):
			continue
		var double_strike := has_keyword(u, "doubleStrike")
		var frenzy := has_keyword(u, "frenzy")
		var quota := 0
		if double_strike:
			quota = 1
		elif frenzy and killed_by.has(int(u.uid)):
			quota = 1
		if quota == 0:
			continue

		state.extraAttackUsed[str(u.uid)] = true
		var extra_done := 0
		while quota > 0 and not u.get("removed", false) and not is_over():
			if extra_done >= MAX_EXTRA_PER_TURN:
				log_event({"type": "extra-attack-capped", "uid": u.uid, "note": "额外攻击达到防呆上限 %d 次，停止连锁" % MAX_EXTRA_PER_TURN})
				break
			log_event({"type": "extra-attack", "uid": u.uid, "lane": lane, "chain": extra_done > 0})
			var more_kills: Array = await apply_attack_batch(lane, [u])
			quota -= 1
			extra_done += 1
			notify_ally_extra_attack(u)
			if frenzy:
				for k in more_kills:
					if int(k.killerUid) == int(u.uid):
						quota += 1
						break

		# 「连击」（精通技能）
		if double_strike and u.get("comboStrike", false) and not u.get("removed", false) and not is_over() \
				and int(state.get("comboStrikeUsed", {}).get(str(u.uid), -1)) != state.turn:
			var spells: int = int(state.players[int(u.side)].get("spellsThisTurn", 0))
			if spells >= 2:
				if not (state.get("comboStrikeUsed", null) is Dictionary):
					state["comboStrikeUsed"] = {}
				state.comboStrikeUsed[str(u.uid)] = state.turn
				log_event({"type": "combo-strike", "uid": u.uid, "lane": lane, "spells": spells})
				await apply_attack_batch(lane, [u])
				notify_ally_extra_attack(u)


## 执行一批攻击：先收集全部伤害事件，再「同时」结算
func apply_attack_batch(lane: String, attackers: Array) -> Array:
	var events: Array = []
	for u in attackers:
		collect_attack_events(lane, u, events)

	for u in attackers:
		queue_trigger(u, "onAttack", {"lane": lane})

	for ev in events:
		if ev.target.get("kind", "") == "unit" and ev.target.unit.get("removed", false):
			continue
		var src = ev.source
		var nm := "单位"
		if src != null:
			nm = str(src.get("name", ""))
			if nm == "":
				nm = str(state.cardLib.get(src.cardId, {}).get("name", "单位"))
		deal_damage(src, ev.target, ev.amount, {
			"deferDeath": true,
			"reason": nm + " 交战",
			"unpreventable": bool(ev.get("unpreventable", false)),
		})

	var pending: Array = state._pendingDeaths.duplicate()
	state["_pendingDeaths"] = []
	var kills: Array = []
	for unit in pending:
		if unit.get("removed", false) or float(unit.hp) > 0.0:
			continue
		kills.append({"unit": unit, "killerUid": int(unit.get("lastDamageSource", -1))})
		destroy_unit(unit, "combat")

	for k in kills:
		var killer = find_unit(int(k.killerUid)) if int(k.killerUid) >= 0 else null
		if killer != null and not killer.get("removed", false):
			queue_trigger(killer, "onKill", {"victim": k.unit})

	for unit in all_units():
		check_nimble(unit)

	await flush_triggers()
	return kills


## 收集一次攻击产生的全部伤害事件
func collect_attack_events(lane: String, unit: Dictionary, events: Array) -> void:
	var foe := 1 - int(unit.side)
	var atk := attack_power(unit)

	var sweep_def = state.cardLib.get(unit.cardId, null)
	if sweep_def != null and sweep_def.get("sweepAllEnemies", false):
		for enemy in all_units():
			if int(enemy.side) != foe:
				continue
			events.append({"source": unit, "target": {"kind": "unit", "unit": enemy}, "amount": atk, "tag": "sweep"})
		events.append({"source": unit, "target": {"kind": "king", "side": foe}, "amount": atk, "tag": "sweep"})
		var sweep_splash = get_keyword(unit, "splash")
		if sweep_splash != null and float(sweep_splash.x) > 0.0:
			for adj in adjacent_of(lane):
				for enemy in lane_units(adj, foe):
					events.append({"source": unit, "target": {"kind": "unit", "unit": enemy}, "amount": float(sweep_splash.x), "tag": "splash"})
		return

	# 「必中」：忽略阻挡，仅攻击国王，且不可被免疫
	if has_keyword(unit, "trueStrike"):
		events.append({
			"source": unit, "target": {"kind": "king", "side": foe}, "amount": atk,
			"tag": "true-strike", "unpreventable": true,
		})
		return

	var primary = enemy_combat_target(lane, int(unit.side))
	var planned = combat_plan_primary(unit)
	if planned != null:
		primary = null if planned.get("kind", "") == "king" else planned.unit

	if primary != null:
		events.append({"source": unit, "target": {"kind": "unit", "unit": primary}, "amount": atk, "tag": "attack"})
	else:
		events.append({"source": unit, "target": {"kind": "king", "side": foe}, "amount": atk, "tag": "attack"})

	var splash = get_keyword(unit, "splash")
	if splash != null and float(splash.x) > 0.0:
		for adj in adjacent_of(lane):
			for enemy in lane_units(adj, foe):
				events.append({"source": unit, "target": {"kind": "unit", "unit": enemy}, "amount": float(splash.x), "tag": "splash"})

	# 穿透 X：主要目标之外再命中 X 个本线路敌方单位，不足则溢出打国王
	var pierce = get_keyword(unit, "pierce")
	if pierce != null and float(pierce.x) > 0.0 and primary != null:
		var rest: Array = []
		for e in lane_units(lane, foe):
			if not same(e, primary):
				rest.append(e)
		var extra: Array = rest.slice(0, int(pierce.x))
		for e in extra:
			events.append({"source": unit, "target": {"kind": "unit", "unit": e}, "amount": atk, "tag": "pierce"})
		var shortfall := int(pierce.x) - extra.size()
		if shortfall > 0:
			events.append({"source": unit, "target": {"kind": "king", "side": foe}, "amount": atk, "tag": "pierce-overflow"})


# ── 召唤 / 手牌接口 ───────────────────────────────────────

func legal_summon_cells(side: int, card_id: String) -> Array:
	var def = state.cardLib.get(card_id, null)
	if def == null:
		return []
	var out: Array = []
	for p in legal_placements(side, def):
		out.append({
			"lane": p.lane, "row": p.row,
			"label": "%s-%s" % [KPC.LANE_NAME.get(p.lane, p.lane), "前排" if p.row == "front" else "后排"],
		})
	return out


func summon_token(side: int, card_id: String, lane: String, row: String, modify: Variant = null, silent: bool = false) -> Variant:
	var def = state.cardLib.get(card_id, null)
	if def == null:
		push_error("召唤失败：卡牌库缺少 %s" % card_id)
		return null
	var probe := probe_from_def(def)
	var spot = find_summon_spot(side, probe, lane, row)
	if spot == null:
		log_event({"type": "summon-failed", "cardId": card_id, "side": side, "lane": lane, "row": row, "reason": "no-legal-cell"})
		return null
	var unit := instantiate_unit(def, side, spot.lane, spot.row)
	apply_summon_modify(unit, modify)
	state.board[spot.lane].units[side][spot.row] = unit
	log_event({"type": "summon", "uid": unit.uid, "cardId": card_id, "side": side, "lane": spot.lane, "row": spot.row})
	if not silent:
		queue_trigger(unit, "onPlay", {})
	queue_trigger(unit, "onEnterLane", {"from": null, "lane": spot.lane})
	resolve_hunt(unit)
	sync_stat_auras()
	return unit


func give_card_to_hand(side: int, card_id: String, modify: Variant = null) -> void:
	var def = state.cardLib.get(card_id, null)
	if def == null:
		push_error("召唤失败：卡牌库缺少 %s" % card_id)
		return
	var hc := {"iid": _next_iid(), "cardId": card_id}
	if modify is Dictionary and float(modify.get("costDelta", 0)) != 0.0:
		hc["costDelta"] = float(modify.costDelta)
	state.players[side].hand.append(hc)
	log_event({"type": "summon-to-hand", "cardId": card_id, "side": side, "costDelta": float(hc.get("costDelta", 0))})


## 「额外攻击一次」——立刻用这个单位打一次
func api_extra_attack(unit: Dictionary) -> bool:
	if unit.get("removed", false):
		return false
	if state.extraAttackUsed.get(str(unit.uid), false):
		return false
	state.extraAttackUsed[str(unit.uid)] = true
	log_event({"type": "extra-attack", "uid": unit.uid, "lane": unit.lane, "source": "effect"})
	await apply_attack_batch(str(unit.lane), [unit])
	notify_ally_extra_attack(unit)
	check_game_over()
	return true


func find_summon_spot(side: int, probe: Dictionary, lane: String, row: String) -> Variant:
	var rows: Array = ["front", "back"] if row == "front" else ["back", "front"]
	var first: Variant = lane if KPC.LANES.has(lane) else null
	if first != null:
		for r in rows:
			if can_place_unit(side, probe, str(first), r):
				return {"lane": first, "row": r}
	for l in KPC.LANES:
		if l == first:
			continue
		for r in ["front", "back"]:
			if can_place_unit(side, probe, l, r):
				return {"lane": l, "row": r}
	return null


func apply_summon_modify(unit: Dictionary, modify: Variant) -> void:
	if not (modify is Dictionary):
		return
	if float(modify.get("atk", 0)) != 0.0:
		buff_atk(unit, float(modify.atk))
	if float(modify.get("maxHp", 0)) != 0.0:
		if float(modify.maxHp) > 0.0:
			buff_max_hp(unit, float(modify.maxHp))
		else:
			debuff_max_hp(unit, -float(modify.maxHp))
	for kw in modify.get("keywords", []):
		grant_keyword(unit, str(kw))


## 「有队友额外攻击时:」的观察者
func notify_ally_extra_attack(attacker: Dictionary) -> void:
	for u in all_units():
		if u.get("removed", false) or int(u.side) != int(attacker.side):
			continue
		if not _has_effect_trigger(u, "onAllyExtraAttack"):
			continue
		queue_trigger(u, "onAllyExtraAttack", {"attacker": attacker})


# ══════════════════════════════════════════════════════════
# §12 出牌与合法性（play.js）
# ══════════════════════════════════════════════════════════

## 只挑出**融合后效果**（when: 'fused' 的那几条），并摘掉 when
func fused_only(def: Dictionary) -> Array:
	var out: Array = []
	for e in def.get("effects", []):
		if e.get("trigger", "") == "onPlay" and e.get("when", null) == "fused":
			var c: Dictionary = e.duplicate(true)
			c.erase("when")
			out.append(c)
	return out


func _hand_index_by_iid(hand: Array, iid: int) -> int:
	for i in hand.size():
		if int(hand[i].iid) == iid:
			return i
	return -1


## 一张手牌的**实际费用**
func cost_of(hand_card: Variant) -> float:
	if not (hand_card is Dictionary):
		return 0.0
	var def = state.cardLib.get(hand_card.cardId, null)
	if def == null:
		return 0.0
	var owner = null
	for p in state.players:
		if p.has("hand") and _hand_index_by_iid(p.hand, int(hand_card.iid)) >= 0:
			owner = p
			break
	var hand_delta := float(owner.get("handCostDelta", 0)) if owner != null else 0.0
	var per_use := 0.0
	if def.get("perUseCost", null) != null and owner != null:
		per_use = float(owner.get("usedCount", {}).get(def.get("id", ""), 0)) * float(def.perUseCost)
	var enhance_cost := float(enhance_for(int(owner.side), str(def.get("id", ""))).cost) if owner != null else 0.0
	var per_ally := 0.0
	if owner != null:
		var enh := enhance_for(int(owner.side), str(def.get("id", "")))
		var flags = enh.get("flags", null)
		if flags is Dictionary and float(flags.get("costPerAlly", 0)) != 0.0:
			var allies := 0
			for u in all_units():
				if not u.get("removed", false) and int(u.side) == int(owner.side):
					allies += 1
			per_ally = -float(mini(allies, maxi(0, int(float(def.get("cost", 0)))))) * float(flags.costPerAlly)
	return maxf(0.0, float(def.get("cost", 0)) + enhance_cost + per_ally
		+ float(hand_card.get("costDelta", 0)) + hand_delta + per_use)


## 这一方本回合是否被「无法使用锦囊牌」锁住
func spell_locked(side: int) -> bool:
	var p: Dictionary = state.players[side]
	return int(p.get("spellLockTurn", -1)) == state.turn


## 某方当前可以打出的所有牌及合法位置
## ── 指向性锦囊：没有合法目标就不能打 ─────────────────────────────────────
## 作者 2026-11-08：「指向性锦囊没有目标的时候应该不能使用」。
## 以前锦囊一律 places=[null]，于是「滚石」在对面没有 ⚔≤2 单位时照样能点，
## 点完卡在一个没有选项的提问上 —— 现在是既不进 legal_plays，play_card 也拒绝。
const TARGET_SELECTOR_KINDS := ["chosenEnemyUnit", "chosenOwnUnit", "chosenAnyUnit",
	"chosenEnemyTarget", "chosenEnemyFront"]


## 递归求出「打完这张牌要满足哪些选择器」，按抉择分支展开：
## 返回 [ 方案… ]，每个方案是「必须全部有候选」的选择器数组。
## 「抉择」的每个选项是并列方案 —— 只要有一条方案能满足，这张牌就能打。
func target_requirements(node: Variant) -> Array:
	if node is Array:
		var acc: Array = [[]]
		for v in node:
			acc = _req_cross(acc, target_requirements(v))
		return acc
	if node is Dictionary:
		var own: Array = []
		var sel = node.get("target", null)
		if sel is Dictionary and TARGET_SELECTOR_KINDS.has(str(sel.get("kind", ""))):
			own.append(sel)
		var body: Array = []
		var opts = node.get("options", null)
		if opts is Array and not opts.is_empty():
			for o in opts:
				body.append_array(target_requirements(o.get("actions", []) if o is Dictionary else []))
		else:
			body = [[]]
			for key in node.keys():
				if str(key) == "target":
					continue
				var v2 = node[key]
				if v2 is Array or v2 is Dictionary:
					body = _req_cross(body, target_requirements(v2))
		var out: Array = []
		for b in body:
			out.append(own + b)
		return out
	return [[]]


## 只问「场上有没有可选的」，不发起交互
func selector_has_candidate(side: int, sel: Dictionary) -> bool:
	var kind := str(sel.get("kind", ""))
	if kind == "chosenEnemyTarget" and sel.get("allowKing", true) != false:
		return true                      # 敌方国王永远可点
	if kind == "chosenEnemyFront" and sel.get("lane", null) == null:
		return true                      # 得先选线路才知道，交给下游
	var fctx := filter_ctx(null)
	var any_side: bool = kind == "chosenAnyUnit"
	var want_side: int = side if kind == "chosenOwnUnit" else (1 - side)
	for u in all_units():
		if u.get("removed", false):
			continue
		if not any_side and int(u.side) != want_side:
			continue
		if kind == "chosenEnemyFront" and str(u.row) != "front":
			continue
		if sel.get("excludeUid", null) != null and int(u.uid) == int(sel.excludeUid):
			continue
		if not matches_target_filter(u, sel.get("filter", null), fctx):
			continue
		return true
	return false


func _req_cross(a: Array, b: Array) -> Array:
	if a.is_empty() or b.is_empty():
		return []
	var out: Array = []
	for x in a:
		for y in b:
			out.append((x as Array) + (y as Array))
			if out.size() > 64:
				return out
	return out


func spell_target_ok(side: int, def: Variant) -> bool:
	if def == null or str(def.get("type", "")) != str(KPC.CARD_TYPE.SPELL):
		return true
	if is_trap_card(def):
		return true
	var plans := target_requirements(def.get("actions", []))
	if plans.is_empty():
		return true
	for plan in plans:
		var ok := true
		for sel in plan:
			if not selector_has_candidate(side, sel):
				ok = false
				break
		if ok:
			return true
	return false


func get_legal_plays(side: int) -> Array:
	if is_over() or has_pending():
		return []
	if get_actor() != side:
		return []

	var allowed_type = KPC.PHASE_ALLOWED_CARD_TYPE.get(str(state.phase), null)
	var p: Dictionary = state.players[side]
	var out: Array = []

	for hand_card in p.hand:
		var def = state.cardLib.get(hand_card.cardId, null)
		if def == null:
			continue
		if is_raw_material(def):
			continue
		if def.get("type", "") == KPC.CARD_TYPE.SPELL and spell_locked(side):
			continue
		var unlocked_spell: bool = def.get("faction", "") == "alchemy" and alchemy_unlock(side)
		if def.get("type", "") != allowed_type and not unlocked_spell:
			continue
		var cost := cost_of(hand_card)
		if cost > float(p.mana):
			continue

		var places: Array = []
		if def.get("type", "") == KPC.CARD_TYPE.UNIT:
			places = legal_placements(side, def)
		else:
			if not spell_target_ok(side, def):
				continue
			places = [null]
		if places.is_empty():
			continue

		out.append({"iid": int(hand_card.iid), "cardId": hand_card.cardId, "cost": cost, "places": places})
	return out


func legal_placements(side: int, def: Dictionary) -> Array:
	var probe := probe_from_def(def)
	var fuse: bool = has_kw(probe, "fuse") or has_kw(probe, "evolve")
	var places: Array = []
	for lane in KPC.LANES:
		if not can_place_in_lane(probe, lane):
			continue
		for row in KPC.ROWS:
			if can_place_unit(side, probe, lane, row, {"allowFuse": fuse}):
				places.append({"lane": lane, "row": row})
	return places


## 占位规则（裁决 D4）
func can_place_unit(side: int, probe: Variant, lane: String, row: String, opts: Dictionary = {}) -> bool:
	var lock = state.get("laneLocks", {}).get(lane, null)
	if lock != null and state.turn <= int(lock):
		return false

	var slot: Dictionary = state.board[lane].units[side]
	if slot[row] != null:
		if opts.get("allowFuse", false) == true:
			return true
		return has_keyword(slot[row], "fuse")
	var existing: Array = []
	for r in KPC.ROWS:
		if slot[r] != null:
			existing.append(slot[r])
	if existing.is_empty():
		return true
	if existing.size() >= 2:
		return false
	var existing_has_combo := false
	for u in existing:
		if has_keyword(u, "combo"):
			existing_has_combo = true
			break
	return existing_has_combo or has_keyword(probe, "combo")


func _fail(msg: String) -> bool:
	last_error = msg
	push_warning(msg)
	return false


## 出牌。成功返回 true（失败原因在 last_error 里）
func play_card(side: int, iid: int, opts: Dictionary = {}) -> bool:
	last_error = ""
	var sandbox: bool = state.get("sandbox", false) == true
	if not sandbox:
		if is_over():
			return _fail("对局已结束")
		if has_pending():
			return _fail("存在待处理的交互请求，请先 resolve_choice")
		var actor: Variant = get_actor()
		if actor != side:
			return _fail("现在是「%s」阶段，应由%s行动" % [state.phase, KPC.role_name(state, actor)])

	var allowed_type = KPC.PHASE_ALLOWED_CARD_TYPE.get(str(state.phase), null)
	var p: Dictionary = state.players[side]
	var idx := _hand_index_by_iid(p.hand, iid)
	if not sandbox and idx >= 0 and is_raw_material(state.cardLib.get(p.hand[idx].cardId, null)):
		return _fail("原料牌只能用炼药消耗，不能直接打出")
	var unlocked_spell: bool = idx >= 0 and alchemy_unlock(side) \
		and state.cardLib.get(p.hand[idx].cardId, {}).get("faction", "") == "alchemy"
	if idx < 0:
		return _fail("手牌中没有 iid=%d" % iid)

	var hand_card: Dictionary = p.hand[idx]
	var def = state.cardLib.get(hand_card.cardId, null)
	if def == null:
		return _fail("卡牌库缺少卡牌定义: %s" % hand_card.cardId)
	if not sandbox and def.get("type", "") != allowed_type and not is_trap_card(def) and not unlocked_spell:
		return _fail("本阶段只能打出「%s」，不能打出「%s」" % [allowed_type, def.get("type", "")])
	if not sandbox and def.get("type", "") == KPC.CARD_TYPE.SPELL and spell_locked(side):
		return _fail("本回合无法使用锦囊牌")
	var cost := 0.0 if sandbox else cost_of(hand_card)
	if not sandbox and cost > float(p.mana):
		return _fail("费用不足：需要 %s，剩余 %s" % [_num_s(cost), _num_s(p.mana)])
	if not sandbox and not spell_target_ok(side, def):
		return _fail("这张锦囊没有可选目标")

	# 陷阱：埋伏进陷阱格（不算「打出卡牌」）
	if is_trap_card(def):
		var lane_out = null
		if sandbox and opts.get("lane", null) != null:
			lane_out = sandbox_plant_trap(side, str(opts.lane), hand_card.cardId)
		else:
			lane_out = place_trap(side, hand_card.cardId, cost)
		if lane_out == null:
			return _fail("陷阱格已满（每方最多 %d 个），不能再用陷阱" % TRAP_MAX)
		p.hand.remove_at(idx)
		p["mana"] = float(p.mana) - cost
		return true

	p.hand.remove_at(idx)
	p["mana"] = float(p.mana) - cost
	state.stats["cardsPlayed"] = int(state.stats.get("cardsPlayed", 0)) + 1
	if not (p.get("usedCount", null) is Dictionary):
		p["usedCount"] = {}
	p.usedCount[def.get("id", "")] = int(p.usedCount.get(def.get("id", ""), 0)) + 1

	trigger_in_hand_effects(side)

	var ctx := {
		"controller": side,
		"card": def,
		"source": null,
		"chosenLane": opts.get("lane", null),
		"chosenTargetUid": opts.get("targetUid", null),
		"chosenTargetIsKing": opts.get("targetKing", false) == true,
		"chosenTargetKingSide": null,
	}
	if opts.get("targetKingSide", null) != null:
		ctx["chosenTargetKingSide"] = 1 if int(opts.targetKingSide) != 0 else 0

	if def.get("type", "") == KPC.CARD_TYPE.UNIT:
		var lane := str(opts.get("lane", ""))
		var row := str(opts.get("row", ""))
		if lane == "" or row == "":
			p.hand.insert(idx, hand_card)
			p["mana"] = float(p.mana) + cost
			state.stats["cardsPlayed"] = int(state.stats.cardsPlayed) - 1
			return _fail("放置单位必须指定 lane 与 row")

		var place_side := side
		if sandbox and opts.get("placeSide", null) != null:
			place_side = 1 if int(opts.placeSide) != 0 else 0
		var probe := probe_from_def(def)
		var legal_terrain: bool = sandbox or can_place_in_lane(probe, lane)
		var fuse: bool = has_kw(probe, "fuse")
		var evolve: bool = has_kw(probe, "evolve")
		var occupant = state.board[lane].units[place_side][row]
		var legal_row: bool = row == "front" or row == "back"
		var legal_slot: bool
		if sandbox:
			legal_slot = legal_row
		else:
			legal_slot = legal_terrain and can_place_unit(side, probe, lane, row, {"allowFuse": fuse or evolve})
		if not legal_slot:
			p.hand.insert(idx, hand_card)
			p["mana"] = float(p.mana) + cost
			state.stats["cardsPlayed"] = int(state.stats.cardsPlayed) - 1
			if sandbox:
				return _fail("这一格放不下单位：位置只能是前排或后排")
			if legal_terrain:
				return _fail("无法将「%s」放置在 %s-%s（该位置已被占用或线路已满）" % [
					def.get("name", ""), KPC.LANE_NAME.get(lane, lane), row])
			return _fail("无法将「%s」放置在 %s（地形限制）" % [def.get("name", ""), KPC.LANE_NAME.get(lane, lane)])

		var fusing_played: bool = fuse and occupant != null and not occupant.get("removed", false)
		var fusing_occ: bool = (not fusing_played) and occupant != null and not occupant.get("removed", false) \
			and place_side == side and has_keyword(occupant, "fuse")
		var evolving_played: bool = (not fusing_played) and (not fusing_occ) and evolve \
			and occupant != null and not occupant.get("removed", false)
		var replaced: bool = sandbox and occupant != null and not occupant.get("removed", false) \
			and not fusing_played and not fusing_occ and not evolving_played
		if replaced:
			vanish_unit(occupant, "sandbox-replace")

		if fusing_played:
			ctx["source"] = occupant
			log_event({
				"type": "fuse", "side": place_side, "cardId": def.get("id", ""), "name": def.get("name", ""),
				"into": occupant.cardId, "intoUid": occupant.uid, "direction": "card-into-ally",
			})
			var gone := instantiate_unit(def, place_side, lane, row)
			destroy_unit(gone, "fuse-by-%s" % def.get("id", ""))
			queue_trigger(occupant, "onPlay", {"fused": true, "lane": lane},
				{"effects": fused_only(def), "cardId": def.get("id", "")})
		elif fusing_occ:
			var fuse_def: Dictionary = state.cardLib.get(occupant.cardId, {})
			var unit := instantiate_unit(def, place_side, lane, row)
			apply_hand_stat_delta(unit, hand_card)
			unit["paidCostDelta"] = float(hand_card.get("costDelta", 0))
			state.board[lane].units[place_side][row] = unit
			ctx["source"] = unit
			log_event({
				"type": "deploy", "uid": unit.uid, "cardId": def.get("id", ""), "name": def.get("name", ""),
				"side": place_side, "lane": lane, "row": row, "fused": true,
			})
			log_event({
				"type": "fuse", "side": place_side,
				"cardId": fuse_def.get("id", occupant.cardId), "name": fuse_def.get("name", ""),
				"into": unit.cardId, "intoUid": unit.uid, "direction": "ally-into-card",
			})
			destroy_unit(occupant, "fuse-into-%s" % def.get("id", ""))
			queue_trigger(unit, "onPlay", {"fused": false, "lane": lane})
			queue_trigger(unit, "onEnterLane", {"from": null, "lane": lane})
			queue_trigger(unit, "onPlay", {"fused": true, "lane": lane},
				{"effects": fused_only(fuse_def), "cardId": fuse_def.get("id", occupant.cardId)})
			notify_ally_played(unit, side)
			resolve_hunt(unit)
		else:
			if evolving_played:
				vanish_unit(occupant, "evolve-by-%s" % def.get("id", ""))
				log_event({
					"type": "fuse", "side": place_side, "cardId": def.get("id", ""), "name": def.get("name", ""),
					"into": occupant.cardId, "intoUid": occupant.uid, "direction": "evolve",
				})
			var unit2 := instantiate_unit(def, place_side, lane, row)
			apply_hand_stat_delta(unit2, hand_card)
			unit2["paidCostDelta"] = float(hand_card.get("costDelta", 0))
			state.board[lane].units[place_side][row] = unit2
			ctx["source"] = unit2
			log_event({
				"type": "deploy", "uid": unit2.uid, "cardId": def.get("id", ""), "name": def.get("name", ""),
				"side": place_side, "lane": lane, "row": row, "fused": evolving_played,
			})
			queue_trigger(unit2, "onPlay", {"fused": evolving_played, "lane": lane})
			queue_trigger(unit2, "onEnterLane", {"from": null, "lane": lane})
			notify_ally_played(unit2, side)
			resolve_hunt(unit2)
	else:
		# 锦囊：带词条时造一个「虚拟来源」
		var kws: Array = def.get("keywords", [])
		if not kws.is_empty():
			var parsed: Array = []
			for k in kws:
				parsed.append(parse_keyword(k))
			ctx["source"] = {
				"uid": -_next_uid(), "cardId": def.get("id", ""), "name": def.get("name", ""),
				"side": side, "lane": ctx.get("chosenLane", null), "row": "front",
				"atk": 0.0, "hp": 0.0, "maxHp": 0.0,
				"keywords": parsed, "effects": [], "marks": [], "removed": false, "virtual": true,
			}
		log_event({"type": "cast", "cardId": def.get("id", ""), "name": def.get("name", ""), "side": side, "lane": ctx.get("chosenLane", null)})
		p["spellsThisTurn"] = int(p.get("spellsThisTurn", 0)) + 1
		notify_enemy_cast_spell(def, side)
		p["currentSpell"] = def.get("id", "")
		await run_spell_with_watchers(ctx, def)
		p["lastSpell"] = def.get("id", "")
		p["currentSpell"] = null

	await flush_triggers()
	if def.get("type", "") != KPC.CARD_TYPE.UNIT:
		state.discard.append(def.get("id", ""))
	if def.get("flame", false) == true:
		check_flame_lotus(side)
	check_all_nimble()
	await flush_triggers()
	sync_stat_auras()
	check_game_over()
	return true


## 锦囊的结算入口：锦囊效果 + 在手牌响应串在同一条协程链上
func run_spell_with_watchers(ctx: Dictionary, def: Dictionary) -> void:
	ctx["spellTargets"] = []
	await exec_actions(ctx, def.get("actions", []))
	await apply_in_hand_spell_watchers(ctx)
	var side: int = int(ctx.get("controller", 0))
	if alchemy_tide_on(side) and not is_raw_material(def):
		log_event({"type": "alchemy-tide", "side": side, "cardId": def.get("id", "")})
		draw_cards(side, 1)


## 「在手牌中时:有敌方单位成为锦囊牌的目标，则使其-1攻-1生命」
func apply_in_hand_spell_watchers(ctx: Dictionary) -> void:
	var side: int = int(ctx.get("controller", 0))
	var hit: Array = []
	for u in ctx.get("spellTargets", []):
		if u != null and not u.get("removed", false) and not has_ident(hit, u):
			hit.append(u)
	if hit.is_empty():
		return
	for hand_card in state.players[side].hand.duplicate():
		var wdef = state.cardLib.get(hand_card.cardId, null)
		if wdef == null or wdef.get("inHandSpellTarget", null) == null:
			continue
		var watk := float(wdef.inHandSpellTarget.get("atk", 0))
		var wmax := float(wdef.inHandSpellTarget.get("maxHp", 0))
		for u in hit:
			if u.get("removed", false):
				continue
			if watk != 0.0:
				buff_atk(u, watk)
			if wmax != 0.0:
				debuff_max_hp(u, -wmax)
		var uids: Array = []
		for u in hit:
			uids.append(int(u.uid))
		log_event({"type": "in-hand-trigger", "cardId": wdef.get("id", ""), "name": wdef.get("name", ""), "side": side, "uids": uids})


func notify_ally_played(played: Dictionary, side: int) -> void:
	for u in all_units():
		if u.get("removed", false) or same(u, played) or int(u.side) != side:
			continue
		if not _has_effect_trigger(u, "onAllyPlayed"):
			continue
		queue_trigger(u, "onAllyPlayed", {"played": played})
	queue_king_trigger(side, "onAllyPlayed", {"played": played})


func notify_enemy_cast_spell(def: Dictionary, caster_side: int) -> void:
	for u in all_units():
		if u.get("removed", false) or int(u.side) == caster_side:
			continue
		if not _has_effect_trigger(u, "onEnemyCastSpell"):
			continue
		queue_trigger(u, "onEnemyCastSpell", {
			"cardId": def.get("id", ""), "cardName": def.get("name", ""), "casterSide": caster_side,
		})


## 「捕猎」：敌方有单位被打出时移动过去
func resolve_hunt(deployed: Variant) -> void:
	if deployed == null or deployed.get("removed", false):
		return
	var hunters: Array = []
	for u in all_units():
		if u.get("removed", false) or int(u.side) == int(deployed.side):
			continue
		if has_keyword(u, "hunt"):
			hunters.append(u)
	hunters.sort_custom(func(a, b):
		return KPC.LANES.find(str(a.lane)) < KPC.LANES.find(str(b.lane)))
	for hunter in hunters:
		if hunter.get("removed", false):
			continue
		move_unit_to_lane(hunter, str(deployed.lane), {"isRooted": func(u): return has_rooted(u)})


## 炼药
func brew(side: int, iids: Array) -> Dictionary:
	if is_over():
		return {"error": "对局已经结束了"}
	if has_pending():
		return {"error": "存在待处理的交互请求，请先 resolve_choice"}
	if get_actor() != side:
		return {"error": "现在不是你的出牌阶段"}
	var p: Dictionary = state.players[side]
	if p.get("faction", null) != "alchemy":
		return {"error": "只有炼金阵营能炼药"}
	var uniq: Array = []
	for id in iids:
		if not uniq.has(id):
			uniq.append(id)
	if uniq.size() < 2:
		return {"error": "炼药至少要消耗两张原料"}

	var picked: Array = []
	for id in uniq:
		var idx := _hand_index_by_iid(p.hand, int(id))
		if idx < 0:
			return {"error": "手牌里没有这张原料"}
		var hc: Dictionary = p.hand[idx]
		if not is_raw_material(state.cardLib.get(hc.cardId, null)):
			return {"error": "只能消耗原料"}
		picked.append({"idx": idx, "hc": hc})
	var cost := 0.0
	for it in picked:
		cost += cost_of(it.hc)
	if cost > float(p.mana):
		return {"error": "费用不足：需要 %s，剩余 %s" % [_num_s(cost), _num_s(p.mana)]}

	var consumed: Array = []
	for it in picked:
		consumed.append(it.hc.cardId)
	picked.sort_custom(func(a, b): return int(b.idx) < int(a.idx))
	for it in picked:
		p.hand.remove_at(int(it.idx))
	p["mana"] = float(p.mana) - cost
	return_raw_materials(side, consumed)

	var token = combo_token_for(consumed)
	log_event({"type": "brew", "side": side, "cost": cost, "consumed": consumed.duplicate(), "token": token})
	if token == null:
		return {"cost": cost, "consumed": consumed, "token": null}

	var card := {"iid": _next_iid(), "cardId": token}
	p.hand.append(card)
	log_event({"type": "brew-token", "side": side, "cardId": token})
	var tdef = state.cardLib.get(token, null)
	if tdef != null and tdef.get("autoUseOnAdd", false):
		await auto_use_token(side, card, tdef)
	return {"cost": cost, "consumed": consumed, "token": token}


## 「这张牌加入手中时：自动使用，然后结束当前出牌回合」
func auto_use_token(side: int, hand_card: Dictionary, def: Dictionary) -> void:
	var p: Dictionary = state.players[side]
	var idx := _hand_index_by_iid(p.hand, int(hand_card.iid))
	if idx >= 0:
		p.hand.remove_at(idx)
	var ctx := {
		"controller": side, "card": def, "source": null,
		"chosenLane": null, "chosenTargetUid": null, "chosenTargetIsKing": false,
	}
	var kws: Array = def.get("keywords", [])
	if not kws.is_empty():
		var parsed: Array = []
		for k in kws:
			parsed.append(parse_keyword(k))
		ctx["source"] = {
			"uid": -_next_uid(), "cardId": def.get("id", ""), "name": def.get("name", ""),
			"side": side, "lane": null, "row": "front",
			"atk": 0.0, "hp": 0.0, "maxHp": 0.0,
			"keywords": parsed, "effects": [], "marks": [], "removed": false, "virtual": true,
		}
	log_event({"type": "cast", "cardId": def.get("id", ""), "name": def.get("name", ""), "side": side, "lane": null, "auto": true})
	notify_enemy_cast_spell(def, side)
	p["currentSpell"] = def.get("id", "")
	await run_spell_with_watchers(ctx, def)
	p["lastSpell"] = def.get("id", "")
	p["currentSpell"] = null
	await flush_triggers()
	if def.get("type", "") != KPC.CARD_TYPE.UNIT:
		state.discard.append(def.get("id", ""))
	check_all_nimble()
	await flush_triggers()
	sync_stat_auras()
	check_game_over()
	if not has_pending() and not is_over():
		await advance()


# ══════════════════════════════════════════════════════════
# §13 回合与阶段（turns.js）
# ══════════════════════════════════════════════════════════

func get_actor() -> Variant:
	match str(state.phase):
		"DEPLOY_FIRST", "SPELL_FIRST":
			return int(state.firstPlayer)
		"DEPLOY_SECOND", "SPELL_SECOND":
			return 1 - int(state.firstPlayer)
		_:
			return null


func is_over() -> bool:
	return state.get("winner", null) != null


func enter_phase(phase: String) -> void:
	if is_over():
		return
	state["phase"] = phase
	if phase == "DEPLOY_FIRST" or phase == "DEPLOY_SECOND":
		return_expired_traps("deploy")
	elif phase == "SPELL_FIRST" or phase == "SPELL_SECOND":
		return_expired_traps("spell")

	if phase == "TURN_START":
		on_turn_start()
	elif phase == "COMBAT":
		await run_combat()
	elif phase == "TURN_END":
		on_turn_end()
	await flush_triggers()
	check_game_over()
	state_changed.emit()


## 推进到下一阶段；TURN_END 之后进入下一回合
func advance() -> void:
	if is_over():
		return
	if has_pending():
		push_warning("存在待处理的交互请求，无法推进")
		return

	if str(state.phase) == "TURN_END":
		if state.turn >= KPC.MAX_TURNS:
			resolve_by_turn_limit()
			return
		state["turn"] = int(state.turn) + 1
		await enter_phase("TURN_START")
		return

	var idx := KPC.PHASES.find(str(state.phase))
	if idx < 0:
		push_error("未知阶段: %s" % str(state.phase))
		return
	if idx + 1 >= KPC.PHASES.size():
		return
	await enter_phase(KPC.PHASES[idx + 1])


func on_turn_start() -> void:
	state["extraAttackUsed"] = {}
	state["_pendingDeaths"] = []
	state["comboStrikeUsed"] = {}

	for p in state.players:
		p["manaCapBonus"] = 0
		p["spellsThisTurn"] = 0
		var penalty := float(p.get("manaPenalty", 0))
		p["manaPenalty"] = 0
		p["manaCap"] = maxi(0, KPC.mana_cap_for_turn(int(state.turn)) + int(p.get("flatManaBonus", 0)) - int(penalty))
		p["mana"] = int(p.manaCap)
	state["combatPlans"] = {}
	state["combatTargetAsked"] = {}
	log_event({"type": "turn-start", "turn": state.turn})

	# 延迟召唤
	if state.get("delayedSummons", null) is Array and not state.delayedSummons.is_empty():
		var due: Array = []
		var keep: Array = []
		for d in state.delayedSummons:
			if int(d.get("atTurn", 0)) <= int(state.turn):
				due.append(d)
			else:
				keep.append(d)
		state["delayedSummons"] = keep
		for d in due:
			summon_token(int(d.side), str(d.cardId), str(d.get("lane", "")), str(d.get("row", "front")), null)

	# 延迟抽牌
	if state.get("delayedDraws", null) is Array and not state.delayedDraws.is_empty():
		var due_d: Array = []
		var keep_d: Array = []
		for d in state.delayedDraws:
			if int(d.get("atTurn", 0)) <= int(state.turn):
				due_d.append(d)
			else:
				keep_d.append(d)
		state["delayedDraws"] = keep_d
		for d in due_d:
			draw_cards(int(d.side), int(d.get("n", 1)))

	# 控制到期
	if state.get("controlReturns", null) is Array and not state.controlReturns.is_empty():
		var due_c: Array = []
		var keep_c: Array = []
		for c in state.controlReturns:
			if int(c.get("atTurn", 0)) <= int(state.turn):
				due_c.append(c)
			else:
				keep_c.append(c)
		state["controlReturns"] = keep_c
		for c in due_c:
			var u = find_unit(int(c.get("uid", -1)))
			if u == null or u.get("removed", false):
				continue
			return_controlled_unit(u)

	resolve_marks()

	# 抽牌：后手先抽、先手后抽
	if not (int(state.turn) == 1 and not KPC.DRAW_ON_FIRST_TURN):
		draw_cards(1 - int(state.firstPlayer), 1)
		draw_cards(int(state.firstPlayer), 1)

	# 「回合开始:」异能
	for unit in all_units():
		if unit.get("removed", false):
			continue
		if _has_effect_trigger(unit, "onTurnStart"):
			queue_trigger(unit, "onTurnStart", {"turn": state.turn})

	sync_stat_auras()


func on_turn_end() -> void:
	log_event({"type": "turn-end", "turn": state.turn})
	expire_revealed_traps()
	expire_timed_keywords()

	for unit in all_units():
		if unit.get("removed", false):
			continue
		var kept: Array = []
		for m in unit.get("marks", []):
			if m.get("untilTurn", null) != null and state.turn >= int(m.untilTurn):
				continue
			kept.append(m)
		unit["marks"] = kept

	if state.get("damageCaps", null) is Array:
		var caps: Array = []
		for c in state.damageCaps:
			if int(c.get("turn", 0)) >= int(state.turn):
				caps.append(c)
		state["damageCaps"] = caps

	for lane in state.get("laneLocks", {}).keys():
		if int(state.turn) > int(state.laneLocks[lane]):
			state.laneLocks.erase(lane)

	if state.get("deckEmpty", false):
		resolve_by_deck_out()


func resolve_by_deck_out() -> void:
	var a: Dictionary = state.players[0]
	var b: Dictionary = state.players[1]
	if float(a.kingHp) == float(b.kingHp):
		state["winner"] = "draw"
		state["winReason"] = "牌库抽空，双方国王生命相同（%s）" % _num_s(a.kingHp)
	else:
		state["winner"] = 0 if float(a.kingHp) > float(b.kingHp) else 1
		state["winReason"] = "牌库抽空，国王生命更高（%s vs %s）" % [_num_s(a.kingHp), _num_s(b.kingHp)]
	log_event({"type": "game-over", "winner": state.winner, "reason": state.winReason})


func resolve_marks() -> void:
	for unit in all_units():
		if unit.get("removed", false):
			continue
		var marks: Array = unit.marks.duplicate()
		unit["marks"] = []
		for mark in marks:
			if unit.get("removed", false):
				break
			if mark.type == "poison":
				log_event({
					"type": "poison-tick", "uid": unit.uid, "x": mark.x, "cardId": unit.cardId,
					"name": state.cardLib.get(unit.cardId, {}).get("name", unit.cardId),
				})
				deal_damage(null, {"kind": "unit", "unit": unit}, float(mark.x),
					{"ignoreMechanisms": true, "noKeywords": true, "reason": "中毒"})
			elif mark.type == "disease":
				log_event({
					"type": "disease-tick", "uid": unit.uid, "cardId": unit.cardId,
					"name": state.cardLib.get(unit.cardId, {}).get("name", unit.cardId),
				})
				destroy_unit(unit, "disease")
			elif mark.type == "burn":
				log_event({
					"type": "burn-tick", "uid": unit.uid, "x": mark.x, "cardId": unit.cardId,
					"name": state.cardLib.get(unit.cardId, {}).get("name", unit.cardId),
				})
				deal_damage(null, {"kind": "unit", "unit": unit}, float(mark.x),
					{"noKeywords": true, "reason": "灼烧"})
		check_nimble(unit)

	for p in state.players:
		var king_marks: Array = p.get("kingMarks", []).duplicate()
		p["kingMarks"] = []
		for mark in king_marks:
			if mark.type != "poison":
				continue
			log_event({"type": "poison-tick", "kingSide": p.side, "x": mark.x})
			deal_damage(null, {"kind": "king", "side": int(p.side)}, float(mark.x),
				{"ignoreMechanisms": true, "noKeywords": true, "reason": "国王中毒"})


func resolve_by_turn_limit() -> void:
	var a: Dictionary = state.players[0]
	var b: Dictionary = state.players[1]
	if float(a.kingHp) == float(b.kingHp):
		state["winner"] = "draw"
		state["winReason"] = "第 %d 回合结束，国王生命相同（%s）" % [KPC.MAX_TURNS, _num_s(a.kingHp)]
	else:
		state["winner"] = 0 if float(a.kingHp) > float(b.kingHp) else 1
		state["winReason"] = "第 %d 回合结束，国王生命更高（%s vs %s）" % [KPC.MAX_TURNS, _num_s(a.kingHp), _num_s(b.kingHp)]
	log_event({"type": "game-over", "winner": state.winner, "reason": state.winReason})


func check_game_over() -> bool:
	if state.get("winner", null) != null:
		return true
	# 靶场：不判胜负
	if state.get("sandbox", false) == true:
		for p in state.players:
			if float(p.kingHp) < 0.0:
				p["kingHp"] = 0.0
		return false
	var a: Dictionary = state.players[0]
	var b: Dictionary = state.players[1]
	if float(a.kingHp) <= 0.0 and float(b.kingHp) <= 0.0:
		state["winner"] = "draw"
		state["winReason"] = "双方国王同时归零（裁决 A3：判平局）"
	elif float(a.kingHp) <= 0.0:
		state["winner"] = 1
		state["winReason"] = "先手国王被击破"
	elif float(b.kingHp) <= 0.0:
		state["winner"] = 0
		state["winReason"] = "后手国王被击破"
	if state.get("winner", null) != null:
		log_event({"type": "game-over", "winner": state.winner, "reason": state.winReason})
	return state.get("winner", null) != null


func surrender(side: int) -> Variant:
	if state.get("winner", null) != null:
		return state.winner
	var loser := side if (side == 0 or side == 1) else 0
	state["winner"] = 1 - loser
	state["winReason"] = "一方认输"
	log_event({"type": "game-over", "winner": state.winner, "reason": state.winReason})
	return state.winner


func sacrifice_unit(side: int, uid: int) -> bool:
	var ok := sacrifice_unit_on_board(side, uid)
	if ok:
		await flush_triggers()
		sync_stat_auras()
	return ok


## 开局：发起始手牌并进入第 1 回合
func start_game() -> void:
	state["turn"] = 1
	ensure_raw_pile(0)
	ensure_raw_pile(1)
	ensure_flame_pile(0)
	ensure_flame_pile(1)
	draw_cards(int(state.firstPlayer), 5, {"raw": false})
	draw_cards(1 - int(state.firstPlayer), 4, {"raw": false})
	give_starting_superpowers()
	await enter_phase("TURN_START")


## 「在手牌中:在你出牌时…」的累积
func trigger_in_hand_effects(side: int) -> void:
	var p: Dictionary = state.players[side]
	for hc in p.hand:
		var def = state.cardLib.get(hc.cardId, null)
		if def == null or not (def.get("inHand", null) is Array):
			continue
		for eff in def.inHand:
			if not (hc.get("statDelta", null) is Dictionary):
				hc["statDelta"] = {"atk": 0.0, "maxHp": 0.0}
			var delta: Dictionary = hc.statDelta
			var atk_now := float(def.get("atk", 0)) + float(delta.get("atk", 0))
			if eff.get("ifAtkAbove", null) != null and atk_now > float(eff.ifAtkAbove) and eff.get("thenInstead", null) != null:
				hc["costDelta"] = float(hc.get("costDelta", 0)) + float(eff.thenInstead.get("costDelta", 0))
				log_event({"type": "in-hand", "cardId": hc.cardId, "branch": "cost", "costDelta": hc.costDelta})
			elif eff.get("buff", null) != null:
				delta["atk"] = float(delta.get("atk", 0)) + float(eff.buff.get("atk", 0))
				delta["maxHp"] = float(delta.get("maxHp", 0)) + float(eff.buff.get("maxHp", 0))
				log_event({"type": "in-hand", "cardId": hc.cardId, "branch": "stats", "atk": delta.atk, "maxHp": delta.maxHp})


func apply_hand_stat_delta(unit: Dictionary, hand_card: Dictionary) -> void:
	var d = hand_card.get("statDelta", null)
	if not (d is Dictionary):
		return
	if float(d.get("atk", 0)) != 0.0:
		buff_atk(unit, float(d.atk))
	if float(d.get("maxHp", 0)) != 0.0:
		buff_max_hp(unit, float(d.maxHp))


## 「立即进入下个回合」（派对「小丑」）——本回合不开战
func end_turn_now() -> bool:
	if is_over():
		return false
	for i in 12:
		if has_pending():
			return true
		if str(state.phase) == "TURN_START":
			return true
		if str(state.phase) == "COMBAT":
			await enter_phase("TURN_END")
			continue
		var idx := KPC.PHASES.find(str(state.phase))
		if idx < 0:
			return true
		if idx + 1 < KPC.PHASES.size() and KPC.PHASES[idx + 1] == "COMBAT":
			await enter_phase("TURN_END")
			if has_pending():
				return true
			continue
		await advance()
	return true


# ══════════════════════════════════════════════════════════
# §14 靶场（sandbox.js）
# ══════════════════════════════════════════════════════════

func _pickable(def: Variant) -> bool:
	return def != null and not def.get("legacy", false)


func sandbox_enable() -> void:
	state["sandbox"] = true


func sandbox_faction_cards(faction: String) -> Array:
	var out: Array = []
	for id in state.cardLib.keys():
		var c: Dictionary = state.cardLib[id]
		if _pickable(c) and c.get("faction", "") == faction and not c.get("token", false):
			out.append(id)
	out.sort()
	return out


func sandbox_grant_faction(side: int) -> Array:
	var p: Dictionary = state.players[side]
	if p.get("faction", null) == null:
		return []
	var ids := sandbox_faction_cards(str(p.faction))
	var added: Array = []
	for id in ids:
		if p.get("superpowers", []).has(id):
			continue
		p.superpowers.append(id)
		p.hand.append({"iid": _next_iid(), "cardId": id})
		added.append(id)
	if not added.is_empty():
		log_event({"type": "sandbox-grant", "side": side, "count": added.size(), "faction": p.faction})
	return added


func sandbox_set_faction(side: int, key: Variant) -> Dictionary:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return {"added": [], "removed": []}
	var old = p.get("faction", null)
	p["faction"] = key
	p["superpowers"] = []
	p["spThresholds"] = {}
	var removed: Array = []
	if old != null and old != key:
		removed = _drop_faction_hand(side, str(old))
	var added := sandbox_grant_faction(side)
	return {"added": added, "removed": removed}


func _drop_faction_hand(side: int, faction: String) -> Array:
	var p: Dictionary = state.players[side]
	var removed: Array = []
	for i in range(p.hand.size() - 1, -1, -1):
		var def = state.cardLib.get(p.hand[i].cardId, null)
		if def != null and def.get("faction", "") == faction:
			removed.push_front(p.hand[i].cardId)
			p.hand.remove_at(i)
	if not removed.is_empty():
		log_event({"type": "sandbox-drop", "side": side, "faction": faction, "count": removed.size()})
	return removed


func sandbox_add_card(side: int, card_id: String) -> Variant:
	var p: Dictionary = state.players[side]
	var def = state.cardLib.get(card_id, null)
	if not _pickable(def):
		return null
	var hc := {"iid": _next_iid(), "cardId": card_id}
	p.hand.append(hc)
	log_event({"type": "sandbox-add", "side": side, "cardId": card_id})
	return hc


func sandbox_refill_mana(side: int) -> void:
	var p: Dictionary = state.players[side]
	if p.is_empty():
		return
	p["mana"] = 99
	p["manaCap"] = 99
	p["manaPenalty"] = 0


func sandbox_clear_board() -> void:
	for lane in KPC.LANES:
		for side in 2:
			for row in KPC.ROWS:
				state.board[lane].units[side][row] = null
			if state.board[lane].traps is Array:
				state.board[lane].traps[side] = null
	log_event({"type": "sandbox-clear"})


# ══════════════════════════════════════════════════════════
# §15 视图（view.js）
# ══════════════════════════════════════════════════════════

func describe_unit(u: Variant) -> Variant:
	if u == null:
		return null
	var kws: Array = []
	for k in u.keywords:
		kws.append("%s:%s" % [k.id, _num_s(k.x)] if float(k.get("x", 0)) != 0.0 else k.id)
	if has_rooted(u) and not kws.has("rooted"):
		kws.append("rooted:aura")
	var marks: Array = []
	for m in u.get("marks", []):
		marks.append(m.type)
	return {
		"uid": int(u.uid), "name": u.name,
		"atk": effective_atk(u), "baseAtk": float(u.atk),
		"hp": float(u.hp), "maxHp": float(u.maxHp),
		"keywords": kws, "marks": marks,
		"cardId": u.cardId, "lane": u.lane, "row": u.row, "side": int(u.side),
	}


## 某一方视角的状态摘要（隐藏对手手牌）
func view_for(side: int) -> Dictionary:
	var me: Dictionary = state.players[side]
	var foe: Dictionary = state.players[1 - side]
	var board := {}
	for lane in KPC.LANES:
		var mine: Array = []
		var foes: Array = []
		for row in KPC.ROWS:
			mine.append(describe_unit(state.board[lane].units[side][row]))
			foes.append(describe_unit(state.board[lane].units[1 - side][row]))
		board[lane] = {"mine": mine, "foe": foes}

	var my_hand: Array = []
	for c in me.hand:
		my_hand.append(c.cardId)

	return {
		"turn": int(state.turn),
		"phase": state.phase,
		"actor": get_actor(),
		"deckLeft": state.deck.size(),
		"me": {
			"kingHp": float(me.kingHp), "mana": float(me.mana), "manaCap": float(me.manaCap),
			"hand": my_hand,
		},
		"foe": {
			"kingHp": float(foe.kingHp), "mana": float(foe.mana), "manaCap": float(foe.manaCap),
			"handCount": foe.hand.size(),
		},
		"board": board,
		"pending": ({"type": pending_request.get("type", ""), "prompt": pending_request.get("prompt", "")}
			if pending_request != null else null),
		"winner": state.get("winner", null),
	}


## 打印一张可读的战场图（调试用）
func render_board() -> String:
	var lines: Array = []
	lines.append("回合 %d · 阶段 %s · 牌库 %d · 先手=%s" % [
		int(state.turn), str(state.phase), state.deck.size(), KPC.SIDE_NAME.get(int(state.firstPlayer), "?")])
	lines.append("国王0 %s 费用 %s/%s 手牌 %d" % [
		_num_s(state.players[0].kingHp), _num_s(state.players[0].mana), _num_s(state.players[0].manaCap), state.players[0].hand.size()])
	lines.append("国王1 %s 费用 %s/%s 手牌 %d" % [
		_num_s(state.players[1].kingHp), _num_s(state.players[1].mana), _num_s(state.players[1].manaCap), state.players[1].hand.size()])
	lines.append("")
	for row in ["back", "front"]:
		var cells: Array = []
		for lane in KPC.LANES:
			cells.append(_cell_str(state.board[lane].units[1][row]))
		lines.append("敌%s | %s" % [KPC.ROW_NAME.get(row, row), " | ".join(cells)])
	lines.append("─────────")
	for row in ["front", "back"]:
		var cells2: Array = []
		for lane in KPC.LANES:
			cells2.append(_cell_str(state.board[lane].units[0][row]))
		lines.append("我%s | %s" % [KPC.ROW_NAME.get(row, row), " | ".join(cells2)])
	return "\n".join(lines)


func _cell_str(u: Variant) -> String:
	if u == null:
		return "····"
	var kws: Array = []
	for k in u.keywords:
		kws.append(k.id)
		if kws.size() >= 2:
			break
	return "%s/%s %s" % [_num_s(effective_atk(u)), _num_s(u.hp), ",".join(kws)]
