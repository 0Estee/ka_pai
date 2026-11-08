extends RefCounted
class_name KPProfile

const KPForge := preload("res://scripts/ui/kp_forge.gd")

## 玩家档案：金币 / 星尘 / 表现分 / 战绩 / 强化记录（app/js/economy.js + profile 的 GDScript 移植）。
##
## 存档落在 user://profile.json，形状与旧版一致：
##   { gold, dust, perf, games, wins, losses, draws, forge: { v:1, cards: { [id]: {lvl, masteries} } } }
## 登录后同一份档案同步到云端（见 kp_cloud.gd）。

const INITIAL_GOLD := 100.0
const INITIAL_DUST := 60.0
const GOLD_CAP := 1000.0
const DUST_CAP := 500.0
const DUST_PER_GOLD := 10

const BASE_REWARD := {"win": 30.0, "draw": 15.0, "lose": 5.0}
const DUST_REWARD := {"win": 8.0, "draw": 5.0, "lose": 3.0}
const MODE_MULTIPLIER := {"ai": 1.0, "pvp": 2.0}
const PVP := {"winBonus": 30.0, "loseCost": 20.0}

const PERF_POINTS := {
	"win": 100.0, "draw": 60.0, "lose": 30.0,
	"perKingHpLeft": 2.0, "kingHpCap": 40.0,
	"fastWinTurns": 8.0, "fastWinBonus": 40.0,
	"perKill": 10.0, "killCap": 50.0, "pvpMult": 1.5,
}

static var path := "user://profile.json"


static func default_profile() -> Dictionary:
	return {
		"gold": INITIAL_GOLD, "dust": INITIAL_DUST, "perf": 0.0,
		"games": 0, "wins": 0, "losses": 0, "draws": 0,
		"forge": {"v": 1, "cards": {}},
	}


static func load_profile() -> Dictionary:
	var out := default_profile()
	if not FileAccess.file_exists(path):
		return out
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return out
	var txt := f.get_as_text()
	f.close()
	var data = JSON.parse_string(txt)
	if not (data is Dictionary):
		return out
	for k in ["gold", "dust", "perf", "games", "wins", "losses", "draws"]:
		if data.has(k):
			out[k] = float(data[k])
	var forge = data.get("forge", null)
	if forge is Dictionary and forge.get("cards", null) is Dictionary:
		out["forge"] = {"v": 1, "cards": forge.cards}
	return out


static func save_profile(p: Dictionary) -> bool:
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return false
	f.store_string(JSON.stringify(p))
	f.close()
	return true


static func reset_profile() -> Dictionary:
	var p := default_profile()
	save_profile(p)
	return p


# ── 等级 ────────────────────────────────────────────────

static func perf_for_level(level: int) -> float:
	var n := maxf(0.0, float(level - 1))
	return 200.0 * n + 25.0 * n * (n - 1.0)


static func level_for(perf: float) -> int:
	var g := maxf(0.0, perf)
	var level := 1
	while level < 999 and g >= perf_for_level(level + 1):
		level += 1
	return level


static func level_progress(perf: float) -> Dictionary:
	var g := maxf(0.0, perf)
	var level := level_for(g)
	var cur := perf_for_level(level)
	var nxt := perf_for_level(level + 1)
	var span := maxf(1.0, nxt - cur)
	var into := minf(span, maxf(0.0, g - cur))
	return {
		"level": level, "perf": g, "levelStart": cur, "levelEnd": nxt,
		"into": into, "need": span, "remain": maxf(0.0, nxt - g),
		"ratio": into / span, "lifetimeGold": g,
	}


static func can_play_pvp(p: Dictionary) -> bool:
	return float(p.get("gold", 0)) > 0.0


static func cap_gold(gold: float, dust: float) -> Dictionary:
	var g := maxf(0.0, gold)
	var d := maxf(0.0, dust)
	var melted := 0.0
	if g > GOLD_CAP:
		var over := g - GOLD_CAP
		melted = floorf(over / DUST_PER_GOLD)
		g = GOLD_CAP + fmod(over, DUST_PER_GOLD)
	d += melted
	if d > DUST_CAP:
		d = DUST_CAP
	return {"gold": g, "dust": d, "melted": melted}


# ── 结算 ────────────────────────────────────────────────

static func reward_for(winner: Variant, human_side: int, turn: int, human_king_hp: float, kills: int = 0, mode: String = "ai") -> Dictionary:
	var is_win := winner is int and int(winner) == human_side
	var is_draw := winner is String and str(winner) == "draw"
	var lines: Array = []
	var mult := float(MODE_MULTIPLIER.get(mode, 1.0))
	var perf_add := 0.0
	if is_win:
		var hp_bonus := minf(float(PERF_POINTS.kingHpCap), maxf(0.0, human_king_hp) * float(PERF_POINTS.perKingHpLeft))
		if hp_bonus > 0.0:
			perf_add += hp_bonus
			lines.append("剩余国王生命 %s → +%s" % [KPForge.fmt_num(human_king_hp), KPForge.fmt_num(hp_bonus)])
		if float(turn) <= float(PERF_POINTS.fastWinTurns):
			perf_add += float(PERF_POINTS.fastWinBonus)
			lines.append("第 %d 回合内取胜 → +%d" % [turn, int(PERF_POINTS.fastWinBonus)])
	var kill_bonus := minf(float(PERF_POINTS.killCap), maxf(0.0, float(kills)) * float(PERF_POINTS.perKill))
	if kill_bonus > 0.0:
		perf_add += kill_bonus
		lines.append("消灭 %d 个敌方单位 → +%d" % [kills, int(kill_bonus)])

	var total := 0.0
	var dust := 0.0
	if mode == "pvp":
		if is_draw:
			lines.append("联机平局：不奖不扣")
		elif not is_win:
			total = -float(PVP.loseCost)
			lines.append("联机战败 −%d" % int(PVP.loseCost))
		else:
			total = roundf(float(BASE_REWARD.win) * mult) + float(PVP.winBonus)
			dust = float(DUST_REWARD.win)
			lines.append("联机胜利 +%d ×%s +%d" % [int(BASE_REWARD.win), KPForge.fmt_num(mult), int(PVP.winBonus)])
			lines.append("星尘 +%d" % int(dust))
	else:
		var base := float(BASE_REWARD.win) if is_win else (float(BASE_REWARD.draw) if is_draw else float(BASE_REWARD.lose))
		total = roundf(base * mult)
		dust = float(DUST_REWARD.win) if is_win else (float(DUST_REWARD.draw) if is_draw else float(DUST_REWARD.lose))
		lines.append("%s基础 +%d" % ["胜利" if is_win else ("平局" if is_draw else "战败"), int(base)])
		lines.append("星尘 +%d" % int(dust))

	var perf := float(PERF_POINTS.win) if is_win else (float(PERF_POINTS.draw) if is_draw else float(PERF_POINTS.lose))
	perf += perf_add
	if mode == "pvp":
		perf = roundf(perf * float(PERF_POINTS.pvpMult))
	lines.append("表现分 +%d" % int(perf))
	return {"total": total, "dust": dust, "perf": perf, "lines": lines}


static func apply_result(p: Dictionary, winner: Variant, human_side: int, turn: int, human_king_hp: float, kills: int = 0, mode: String = "ai") -> Dictionary:
	var r := reward_for(winner, human_side, turn, human_king_hp, kills, mode)
	var before := level_for(float(p.get("perf", 0)))
	var capped := cap_gold(float(p.get("gold", 0)) + float(r.total), float(p.get("dust", 0)) + float(r.dust))
	if float(capped.melted) > 0.0:
		(r.lines as Array).append("金币超上限，熔炼 +%d 星尘" % int(capped.melted))
	var is_win := winner is int and int(winner) == human_side
	var is_draw := winner is String and str(winner) == "draw"
	var next := p.duplicate(true)
	next["gold"] = capped.gold
	next["dust"] = capped.dust
	next["perf"] = maxf(0.0, float(p.get("perf", 0))) + float(r.perf)
	next["lifetimeGold"] = float(p.get("lifetimeGold", 0)) + maxf(0.0, float(r.total))
	next["games"] = int(p.get("games", 0)) + 1
	next["wins"] = int(p.get("wins", 0)) + (1 if is_win else 0)
	next["losses"] = int(p.get("losses", 0)) + (1 if (not is_win and not is_draw) else 0)
	next["draws"] = int(p.get("draws", 0)) + (1 if is_draw else 0)
	var after := level_for(float(next.perf))
	return {"profile": next, "reward": r, "levelBefore": before, "levelAfter": after, "leveledUp": after > before}


static func buy_dust(p: Dictionary, times: int = 1) -> Dictionary:
	var n := maxi(1, times)
	var cost := n * DUST_PER_GOLD
	var gold := float(p.get("gold", 0))
	var dust := float(p.get("dust", 0))
	if gold < cost:
		return {"ok": false, "reason": "金币不足（需要 %d）" % cost}
	if dust >= DUST_CAP:
		return {"ok": false, "reason": "星尘已满（%d）" % int(DUST_CAP)}
	var next := p.duplicate(true)
	next["gold"] = gold - cost
	next["dust"] = minf(DUST_CAP, dust + n)
	return {"ok": true, "gained": mini(n, int(DUST_CAP - dust)), "profile": next}
