## 界面用的数据仓库：卡库、词条表、阵营表、牌库构造。
##
## 与 tests/ai.gd 的 buildTestDeck 是同一套算法（同种子同牌库），
## 所以手机端自测用的牌库和 JS 版对得上，出问题好排查。
class_name KPData
extends RefCounted

const KPRng := preload("res://scripts/engine/kp_rng.gd")
const KPAi := preload("res://scripts/ai/kp_ai.gd")

const CARDS_PATH := "res://data/cards.json"
const KEYWORDS_PATH := "res://data/keywords.json"

static var _lib: Dictionary = {}
static var _kw: Dictionary = {}
static var _loaded := false


static func ensure_loaded() -> void:
	if _loaded:
		return
	_loaded = true
	var data = JSON.parse_string(FileAccess.get_file_as_string(CARDS_PATH))
	if data is Dictionary:
		for c in data.get("cards", []):
			_lib[str(c.get("id", ""))] = c
	var kd = JSON.parse_string(FileAccess.get_file_as_string(KEYWORDS_PATH))
	if kd is Dictionary:
		_kw = kd.get("keywords", {})


static func lib() -> Dictionary:
	ensure_loaded()
	return _lib


static func card(card_id) -> Dictionary:
	ensure_loaded()
	return _lib.get(str(card_id), {})


static func keyword(kw_id) -> Dictionary:
	ensure_loaded()
	return _kw.get(str(kw_id), {})


## "crit:2" → "暴击 2"；没有参数就是 "荆棘"
static func keyword_name(kw_id) -> String:
	var raw := str(kw_id)
	var parts := raw.split(":")
	var base := str(keyword(parts[0]).get("name", parts[0]))
	if parts.size() > 1 and parts[1] != "":
		return "%s %s" % [base, parts[1]]
	return base


static func keyword_note(kw_id) -> String:
	var raw := str(kw_id)
	var base := raw.split(":")[0]
	return str(keyword(base).get("note", ""))


# ── 阵营 ────────────────────────────────────────────────────────────────────
## 与 engine/src/factions.js 的 FACTIONS 一致（key 原样存进卡牌定义的 faction 字段）
const FACTIONS := [
	{"key": "", "name": "中立", "note": "不选阵营，没有超能力"},
	{"key": "demon", "name": "恶魔", "note": "以伤害换取资源"},
	{"key": "god", "name": "上帝", "note": "治疗与庇护"},
	{"key": "sword", "name": "剑道", "note": "单体爆发与连击"},
	{"key": "music", "name": "音乐", "note": "节奏与增益"},
	{"key": "science", "name": "科学", "note": "抽牌与控费"},
	{"key": "divine", "name": "神佑", "note": "护盾与复活"},
	{"key": "alchemy", "name": "炼金", "note": "原料与炼药成令牌"},
	{"key": "inferno", "name": "炼狱", "note": "灼烧与自损"},
	{"key": "frost", "name": "极寒", "note": "冻结与减速"},
	{"key": "sin", "name": "罪恶", "note": "牺牲与献祭"},
	{"key": "party", "name": "派对", "note": "铺场与群聚"},
	{"key": "flame", "name": "炎帝", "note": "异火与持续伤害"},
	{"key": "heart", "name": "心驭", "note": "夺取与控制敌方单位"},
]


static func factions() -> Array:
	return FACTIONS


static func faction_name(key) -> String:
	var k := str(key)
	if k == "" or k == "null":
		return "中立"
	for f in FACTIONS:
		if str(f.key) == k:
			return str(f.name)
	return k


static func difficulties() -> Array:
	return KPAi.difficulties()


# ── 牌库：与 engine/cards/test-cards.js 的 buildTestDeck 同一算法 ────────────
static func _imul32(a: int, b: int) -> int:
	var lo: int = (a & 0xFFFF) * b
	var hi: int = ((a >> 16) & 0xFFFF) * b
	return ((hi << 16) + lo) & 0xFFFFFFFF


static func _mix_seed(x: int) -> int:
	var v: int = x & 0xFFFFFFFF
	if v == 0:
		v = 0x9e3779b9
	for i in 2:
		v = _imul32(v ^ (v >> 16), 0x45d9f3b)
	return (v ^ (v >> 16)) & 0xFFFFFFFF


## 178 张可入牌库的中立牌（去掉令牌与阵营超能力）
static func build_deck(size: int, seed_v: int) -> Array:
	ensure_loaded()
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
	var rng = KPRng.new(_mix_seed(seed_v))
	rng.shuffle(pool)
	var deck: Array = []
	while deck.size() < size:
		deck.append(pool[deck.size() % pool.size()])
	return deck.slice(0, size)
