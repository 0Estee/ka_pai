## 玩家设置：user://settings.cfg（ConfigFile）。
##
## 只存「界面与体验」层面的开关，不存对局状态（对局回放见 kp_replay.gd）。
## 界面各处读它：光球特效档、动画时长倍率、AI 停顿、默认难度、牌库张数。
class_name KPSettings
extends RefCounted

const PATH := "user://settings.cfg"
const SECTION := "player"

## 键
const FX_LEVEL := "fx_level"        # 0 关 / 1 省电 / 2 全效
const ANIM_SPEED := "anim_speed"    # 0 慢 / 1 标准 / 2 快
const AI_PACE := "ai_pace"          # 0 无停顿 / 1 短 / 2 标准
const DIFFICULTY := "difficulty"
const DECK_SIZE := "deck_size"

const DEFAULTS := {
	"fx_level": 0,
	"anim_speed": 1,
	"ai_pace": 2,
	"difficulty": "normal",
	"deck_size": 80,
}

## 动画时长倍率（越大越慢）：慢 1.35 / 标准 1.0 / 快 0.7
const ANIM_SCALE := [1.35, 1.0, 0.7]
## AI 每步停顿秒数
const PACE_SEC := [0.0, 0.05, 0.09]
const DECK_CHOICES := [60, 80, 100]

static var _data: Dictionary = {}
static var _loaded := false


static func _ensure() -> void:
	if _loaded:
		return
	_loaded = true
	_data = DEFAULTS.duplicate()
	var cf := ConfigFile.new()
	if cf.load(PATH) == OK:
		for k in DEFAULTS.keys():
			_data[k] = cf.get_value(SECTION, k, DEFAULTS[k])


static func save() -> void:
	_ensure()
	var cf := ConfigFile.new()
	for k in _data.keys():
		cf.set_value(SECTION, k, _data[k])
	cf.save(PATH)


static func get_int(key: String) -> int:
	_ensure()
	return int(_data.get(key, DEFAULTS.get(key, 0)))


static func get_str(key: String) -> String:
	_ensure()
	return str(_data.get(key, DEFAULTS.get(key, "")))


static func set_v(key: String, value) -> void:
	_ensure()
	_data[key] = value
	save()


static func reset() -> void:
	_data = DEFAULTS.duplicate()
	_loaded = true
	save()


# ── 派生值（界面直接用这几个） ───────────────────────────────────────────────

static func fx_level() -> int:
	return clampi(get_int(FX_LEVEL), 0, 2)


static func anim_speed() -> int:
	return clampi(get_int(ANIM_SPEED), 0, 2)


## 动画时长倍率（给 KPBattle.anim / KPHome.anim / KPPage.anim 用）
static func anim_scale() -> float:
	return float(ANIM_SCALE[anim_speed()])


static func ai_pace() -> float:
	return float(PACE_SEC[clampi(get_int(AI_PACE), 0, 2)])


static func difficulty() -> String:
	return get_str(DIFFICULTY)


static func deck_size() -> int:
	var v := get_int(DECK_SIZE)
	return v if DECK_CHOICES.has(v) else 80
