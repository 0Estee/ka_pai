## 设置页：所有开关即时生效并存进 user://settings.cfg。
## 视觉语言跟首页一致（星云 + 小光球），每行是一块「光板」，右边一排药丸。
class_name KPSettingsPage
extends "res://scripts/ui/kp_page.gd"

const DATA := preload("res://scripts/ui/kp_data.gd")

var _pills_fx: Array = []
var _pills_anim: Array = []
var _pills_pace: Array = []
var _pills_diff: Array = []
var _pills_deck: Array = []
var _save_note: Label


func _init() -> void:
	title_text = "设 置"
	crumb_text = "即时生效 · 存在本机"


func _fill() -> void:
	anim = SET.anim_scale()

	# 1 光球特效
	var r1 := _row(0, 108, "光球特效", "光球里流的能量丝；省电档只算一层噪声", U.GOLD)
	_reveal(r1)
	_pills_fx = _pills(r1, 62, ["关", "省电", "全效"], _on_fx)
	_paint_pills(_pills_fx, SET.fx_level(), U.GOLD)

	# 2 动画速度
	var r2 := _row(120, 108, "动画速度", "出牌飞行、进场、飘字的快慢", U.MANA)
	_reveal(r2)
	_pills_anim = _pills(r2, 62, ["慢", "标准", "快"], _on_anim)
	_paint_pills(_pills_anim, SET.anim_speed(), U.MANA)

	# 3 AI 停顿
	var r3 := _row(240, 108, "AI 思考停顿", "AI 每步之间的呼吸，关掉就是秒速对局", U.FACTION)
	_reveal(r3)
	_pills_pace = _pills(r3, 62, ["无", "短", "标准"], _on_pace)
	_paint_pills(_pills_pace, SET.get_int(SET.AI_PACE), U.FACTION)

	# 4 默认难度
	var r4 := _row(360, 108, "默认难度", "回首页后预设的 AI 档位", U.BAD)
	_reveal(r4)
	var names: Array = []
	for d in DATA.difficulties():
		names.append(str(d.name))
	_pills_diff = _pills(r4, 62, names, _on_diff, 96.0, 34.0, 8.0)
	_paint_pills(_pills_diff, _diff_index(), U.BAD)

	# 5 牌库张数
	var r5 := _row(480, 108, "牌库张数", "每局双方共用的抽牌堆点数", U.GOOD)
	_reveal(r5)
	var decks: Array = []
	for d in SET.DECK_CHOICES:
		decks.append(str(d))
	_pills_deck = _pills(r5, 62, decks, _on_deck)
	_paint_pills(_pills_deck, SET.DECK_CHOICES.find(SET.deck_size()), U.GOOD)

	_save_note = _note("改动即写入 %s" % ProjectSettings.globalize_path(SET.PATH), 610, U.DIM, 12, 20)
	_reveal(_save_note)

	var reset := _button("恢 复 默 认", Vector2(240, 52), Vector2(30, 660), _on_reset, U.LINE)
	_reveal(reset)


func _diff_index() -> int:
	var keys: Array = []
	for d in DATA.difficulties():
		keys.append(str(d.key))
	return maxi(0, keys.find(SET.difficulty()))


func _flash_saved() -> void:
	if _save_note == null or not is_instance_valid(_save_note):
		return
	_save_note.text = "已保存 · %s" % Time.get_time_string_from_system()
	_save_note.add_theme_color_override("font_color", U.GOOD)
	if anim > 0.001:
		var tw: Tween = _save_note.create_tween()
		tw.tween_interval(1.1 * anim)
		tw.tween_callback(func():
			if is_instance_valid(_save_note):
				_save_note.add_theme_color_override("font_color", U.DIM))


# ── 点药丸 ───────────────────────────────────────────────────────────────────

func _on_fx(i: int) -> void:
	SET.set_v(SET.FX_LEVEL, i)
	_paint_pills(_pills_fx, i, U.GOLD)
	if _orb != null and is_instance_valid(_orb):
		_orb.set_fx(i)
		_orb.pulse(0.8)
		_orb.ripple(0.6)
	_flash_saved()


func _on_anim(i: int) -> void:
	SET.set_v(SET.ANIM_SPEED, i)
	_paint_pills(_pills_anim, i, U.MANA)
	anim = SET.anim_scale()
	if _orb != null and is_instance_valid(_orb):
		_orb.anim = anim
		_orb.pulse(0.7)
		_orb.ripple(0.5)
	_flash_saved()


func _on_pace(i: int) -> void:
	SET.set_v(SET.AI_PACE, i)
	_paint_pills(_pills_pace, i, U.FACTION)
	if _orb != null and is_instance_valid(_orb):
		_orb.pulse(0.6)
	_flash_saved()


func _on_diff(i: int) -> void:
	var ds: Array = DATA.difficulties()
	if i < 0 or i >= ds.size():
		return
	SET.set_v(SET.DIFFICULTY, str(ds[i].key))
	_paint_pills(_pills_diff, i, U.BAD)
	_flash_saved()


func _on_deck(i: int) -> void:
	if i < 0 or i >= SET.DECK_CHOICES.size():
		return
	SET.set_v(SET.DECK_SIZE, int(SET.DECK_CHOICES[i]))
	_paint_pills(_pills_deck, i, U.GOOD)
	_flash_saved()


func _on_reset() -> void:
	SET.reset()
	_paint_pills(_pills_fx, SET.fx_level(), U.GOLD)
	_paint_pills(_pills_anim, SET.anim_speed(), U.MANA)
	_paint_pills(_pills_pace, SET.get_int(SET.AI_PACE), U.FACTION)
	_paint_pills(_pills_diff, _diff_index(), U.BAD)
	_paint_pills(_pills_deck, SET.DECK_CHOICES.find(SET.deck_size()), U.GOOD)
	anim = SET.anim_scale()
	if _orb != null and is_instance_valid(_orb):
		_orb.set_fx(SET.fx_level())
		_orb.pulse(1.4)
		_orb.ripple(1.4)
	_flash_saved()
