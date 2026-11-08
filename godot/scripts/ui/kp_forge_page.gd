## 强化工坊（作者 m01990 第 18 条）：金币强化、星尘精通、洗掉、买星尘。
##
## 规则全在 scripts/ui/kp_forge.gd（与旧版 app/js/enhance.js 逐项对拍过 3164 项），
## 档案在 scripts/ui/kp_profile.gd（user://profile.json），这里只管把它们画出来。
##
## 手机屏上不做网页那种网格：一屏 6 行竖排，每行右边四个动作键，
## 点左边文字看详情。列表按「单位 / 锦囊 / 已练」筛，省得在一百多张里翻。
class_name KPForgePage
extends "res://scripts/ui/kp_page.gd"

const KPForge := preload("res://scripts/ui/kp_forge.gd")
const KPProfile := preload("res://scripts/ui/kp_profile.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

const ROW_H := 96.0
const RARITY_COLOR := {
	"white": Color("c9d1dc"), "green": Color("5fd39a"), "orange": Color("e8a34a"),
	"purple": Color("b082ff"), "rainbow": Color("ff6fb5"),
}

var profile: Dictionary = {}
var _filter := "unit"
var _pills_ui: Array = []
var _scroll: ScrollContainer
var _list: VBoxContainer
var _gold: Label
var _dust: Label
var _level: Label
var _perf: Label
var _bar: ProgressBar
var _count: Label
var _toast: Label
var _overlay: Control = null


func _init() -> void:
	title_text = "强 化 工 坊"
	crumb_text = "金币强化 · 星尘精通 · 进度存在本机"


func _fill() -> void:
	anim = SET.anim_scale()
	profile = KPProfile.load_profile()
	_build_head()
	_build_tabs()
	_build_list()
	_toast = _note("", 792, U.DIM, 13, 22)
	_reveal(_toast)
	_refresh_head()
	_rebuild_list()


# ── 顶部：金币 / 星尘 / 等级 ────────────────────────────────────────────────

func _build_head() -> void:
	var card := Panel.new()
	card.position = Vector2(30, 0)
	card.size = Vector2(660, 136)
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_theme_stylebox_override("panel", U.box(Color(0.106, 0.133, 0.188, 0.86), 16, Color(U.LINE, 0.55), 1))
	body.add_child(card)
	_reveal(card)

	_cap(card, "金币", 18)
	_gold = _big(card, 18, U.GOLD)
	_cap(card, "星尘", 172)
	_dust = _big(card, 172, U.FACTION)
	_cap(card, "等级", 318)
	_level = U.label("", 24, U.TEXT)
	_level.position = Vector2(318, 24)
	_level.size = Vector2(160, 32)
	_level.clip_text = false
	card.add_child(_level)

	_perf = U.label("", 12, U.DIM)
	_perf.position = Vector2(18, 74)
	_perf.size = Vector2(470, 20)
	_perf.clip_text = false
	card.add_child(_perf)
	_bar = U.hpbar(0.0, U.GOLD, 8)
	_bar.position = Vector2(18, 100)
	_bar.size = Vector2(470, 8)
	card.add_child(_bar)

	_act(card, Vector2(504, 22), Vector2(136, 40), "买 星 尘", func(): _on_buy_dust(), U.MANA, true)
	var note := U.label("10 金币 → 1 星尘", 11, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	note.position = Vector2(504, 66)
	note.size = Vector2(136, 18)
	note.clip_text = false
	card.add_child(note)


func _cap(parent: Control, text: String, x: float) -> void:
	var l := U.label(text, 12, U.DIM)
	l.position = Vector2(x, 6)
	l.size = Vector2(140, 18)
	l.clip_text = false
	parent.add_child(l)


func _big(parent: Control, x: float, col: Color) -> Label:
	var l := U.label("0", 30, col)
	l.position = Vector2(x, 24)
	l.size = Vector2(150, 40)
	l.clip_text = false
	parent.add_child(l)
	return l


func _refresh_head() -> void:
	if _gold == null or not is_instance_valid(_gold):
		return
	_gold.text = KPForge.fmt_num(profile.get("gold", 0))
	_dust.text = KPForge.fmt_num(profile.get("dust", 0))
	var lp := KPProfile.level_progress(float(profile.get("perf", 0)))
	_level.text = "LV %d" % int(lp.level)
	_perf.text = "表现分 %s · 本级还差 %s（%d 战 %d 胜 %d 负）" % [
		KPForge.fmt_num(lp.perf), KPForge.fmt_num(lp.remain),
		int(profile.get("games", 0)), int(profile.get("wins", 0)), int(profile.get("losses", 0))]
	_bar.value = clampf(float(lp.ratio), 0.0, 1.0)


# ── 筛选与列表 ──────────────────────────────────────────────────────────────

func _build_tabs() -> void:
	_pills_ui = _pills(body, 148, ["单位", "锦囊", "已练"], func(i: int):
		_filter = ["unit", "spell", "done"][i]
		_paint_pills(_pills_ui, i)
		_rebuild_list(), 96.0, 34.0, 8.0, 30.0)
	_paint_pills(_pills_ui, 0)
	_count = U.label("", 12, U.DIM, HORIZONTAL_ALIGNMENT_RIGHT)
	_count.position = Vector2(360, 154)
	_count.size = Vector2(330, 22)
	_count.clip_text = false
	body.add_child(_count)
	_reveal(_count)


func _build_list() -> void:
	_scroll = ScrollContainer.new()
	_scroll.position = Vector2(8, 192)
	_scroll.size = Vector2(704, 590)
	_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	body.add_child(_scroll)
	_reveal(_scroll)
	_list = VBoxContainer.new()
	_list.custom_minimum_size = Vector2(704, 0)
	_list.add_theme_constant_override("separation", 8)
	_scroll.add_child(_list)


func _clear_list() -> void:
	for c in _list.get_children():
		_list.remove_child(c)
		c.queue_free()


func _rebuild_list() -> void:
	if _list == null or not is_instance_valid(_list):
		return
	_clear_list()
	var data: Dictionary = KPForge.workshop_cards(DATA.lib(), profile, "type")
	var all: Array = data.get("cards", [])
	var rows: Array = []
	var done := 0
	for c in all:
		var rec: Dictionary = c["rec"]
		var touched := int(rec.get("lvl", 0)) > 0 or not (rec.get("masteries", []) as Array).is_empty()
		if touched:
			done += 1
		if _filter == "done":
			if touched:
				rows.append(c)
		elif str(c["type"]) == _filter:
			rows.append(c)
	for c in rows:
		_make_row(c)
	_count.text = "%d 张 · 已练 %d 张" % [rows.size(), done]
	if rows.is_empty():
		var empty := U.label("这一栏还是空的 —— 打几局攒金币，回来再练。", 14, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
		empty.custom_minimum_size = Vector2(0, 60)
		empty.clip_text = false
		_list.add_child(empty)
	_scroll.scroll_vertical = 0


func _make_row(c: Dictionary) -> void:
	var def: Dictionary = c["def"]
	var rec: Dictionary = c["rec"]
	var st: Dictionary = c["stats"]
	var cid := str(c["id"])
	var spell := KPForge.is_spell(def)
	var lvl := int(rec.get("lvl", 0))
	var masteries: Array = rec.get("masteries", [])
	var touched := lvl > 0 or not masteries.is_empty()

	var row := Panel.new()
	row.set_meta("cid", cid)
	row.custom_minimum_size = Vector2(0, ROW_H)
	row.mouse_filter = Control.MOUSE_FILTER_IGNORE
	row.add_theme_stylebox_override("panel", U.box(
		Color(0.114, 0.145, 0.204, 0.94) if touched else Color(0.086, 0.106, 0.149, 0.74),
		14, Color(U.GOLD, 0.5) if lvl > 0 or not masteries.is_empty() else Color(U.LINE, 0.42), 1))
	_list.add_child(row)

	var name_lab := U.label(str(def.get("name", cid)), 17, U.TEXT)
	name_lab.position = Vector2(16, 10)
	name_lab.size = Vector2(392, 24)
	name_lab.clip_text = true
	row.add_child(name_lab)

	var sub := ""
	if spell:
		sub = "锦囊 · 费用 %s" % KPForge.fmt_num(st.get("cost", 0))
		if float(st.get("cost", 0)) != float(def.get("cost", 0)):
			sub += "（卡面 %s）" % KPForge.fmt_num(def.get("cost", 0))
	else:
		sub = "单位 · ⚔ %s / ♥ %s" % [KPForge.fmt_num(st.get("atk", 0)), KPForge.fmt_num(st.get("hp", 0))]
		if float(st.get("atk", 0)) != float(def.get("atk", 0)) or float(st.get("hp", 0)) != float(def.get("hp", 0)):
			sub += "（卡面 %s/%s）" % [KPForge.fmt_num(def.get("atk", 0)), KPForge.fmt_num(def.get("hp", 0))]
	sub += " · 强化 %d/%d" % [lvl, KPForge.ENHANCE_MAX]
	var sub_lab := U.label(sub, 12, U.DIM)
	sub_lab.position = Vector2(16, 36)
	sub_lab.size = Vector2(392, 20)
	sub_lab.clip_text = true
	row.add_child(sub_lab)

	var mark := ""
	if not masteries.is_empty():
		var names: Array = []
		for m in masteries:
			names.append(KPForge.mastery_name(str(m)))
		mark = "精通：" + " · ".join(names)
	elif lvl >= KPForge.ENHANCE_MAX:
		mark = "已练满 · 可以精通了"
	else:
		mark = "精通：练满 %d 次后可从 3 个技能里挑" % KPForge.ENHANCE_MAX
	var mark_lab := U.label(mark, 11, U.GOLD if not masteries.is_empty() else Color(U.DIM, 0.8))
	mark_lab.position = Vector2(16, 58)
	mark_lab.size = Vector2(392, 18)
	mark_lab.clip_text = true
	row.add_child(mark_lab)

	var lv_bar := U.hpbar(float(lvl) / float(KPForge.ENHANCE_MAX), U.GOLD if lvl > 0 else Color(U.LINE, 0.8), 5)
	lv_bar.position = Vector2(16, 80)
	lv_bar.size = Vector2(392, 5)
	row.add_child(lv_bar)

	var ge: Dictionary = KPForge.can_enhance(profile, def, cid)
	var gm: Dictionary = KPForge.can_master(profile, def, cid)
	var gw: Dictionary = KPForge.can_wash(profile, def, cid)
	var enh_text := "强化 已满" if lvl >= KPForge.ENHANCE_MAX else "强化 %d" % int(ge.get("cost", KPForge.enhance_gold_cost(lvl)))
	var mst_text := "精通 %d" % int(gm.get("cost", KPForge.mastery_dust_cost(masteries.size()))) if bool(gm.get("ok", false)) else "精通"
	_act(row, Vector2(420, 12), Vector2(118, 36), enh_text,
		func(): _on_enhance(cid, def), U.GOLD, bool(ge.get("ok", false)))
	_act(row, Vector2(548, 12), Vector2(118, 36), mst_text,
		func(): _on_master(cid, def), U.FACTION, bool(gm.get("ok", false)))
	_act(row, Vector2(420, 54), Vector2(118, 24), "详 情",
		func(): _open_detail(c), U.MANA, true)
	_act(row, Vector2(548, 54), Vector2(118, 24), "洗 掉",
		func(): _on_wash(cid, def), U.BAD, bool(gw.get("ok", false)))

	# 点左半边看详情（放在最后，盖在文字上）
	var hit := Control.new()
	hit.position = Vector2(8, 6)
	hit.size = Vector2(400, 84)
	U.on_click(hit, func(): _open_detail(c))
	row.add_child(hit)


# ── 动作 ────────────────────────────────────────────────────────────────────

func _on_enhance(cid: String, def: Dictionary) -> void:
	var res: Dictionary = KPForge.apply_enhance(profile, def, cid)
	_commit(res, "强化到 +%d" % int(res.get("lvl", 0)))


func _on_master(cid: String, def: Dictionary) -> void:
	var gate: Dictionary = KPForge.can_master(profile, def, cid)
	if not bool(gate.get("ok", false)):
		_say(str(gate.get("reason", "还不能精通")))
		return
	if KPForge.is_spell(def):
		_commit(KPForge.apply_mastery(profile, def, cid, ""), "精通：锦囊减费")
		return
	_open_skill_pick(cid, def, int(gate.get("cost", 0)))


func _on_wash(cid: String, def: Dictionary) -> void:
	var res: Dictionary = KPForge.apply_wash(profile, def, cid)
	_commit(res, "洗掉了最近一次精通（星尘不退）")


func _on_buy_dust() -> void:
	var res: Dictionary = KPProfile.buy_dust(profile, 1)
	if not bool(res.get("ok", false)):
		_say(str(res.get("reason", "买不了")))
		return
	if res.get("profile") is Dictionary:
		profile = res.profile
		KPProfile.save_profile(profile)
		_refresh_head()
		_say("星尘 +1")


func _commit(res: Dictionary, ok_text: String) -> void:
	if not bool(res.get("ok", false)):
		_say(str(res.get("reason", "不能这么做")))
		return
	if res.get("profile") is Dictionary:
		profile = res.profile
		KPProfile.save_profile(profile)
		_refresh_head()
		_rebuild_list()
		_say(ok_text)
		if _orb != null and is_instance_valid(_orb):
			_orb.pulse(0.9)
			_orb.ripple(0.7)


func _say(text: String) -> void:
	if _toast == null or not is_instance_valid(_toast):
		return
	_toast.text = text
	_toast.add_theme_color_override("font_color", U.GOOD)
	var tw: Tween = _toast.create_tween()
	tw.tween_interval(1.4)
	tw.tween_property(_toast, "modulate:a", 0.0, 0.3)
	tw.tween_callback(func():
		if is_instance_valid(_toast):
			_toast.modulate.a = 1.0)


# ── 小按钮 ──────────────────────────────────────────────────────────────────

func _act(parent: Control, pos: Vector2, size_v: Vector2, text: String, cb: Callable, tint: Color, enabled: bool) -> void:
	var c := Control.new()
	c.position = pos
	c.size = size_v
	c.mouse_filter = Control.MOUSE_FILTER_STOP
	c.set_meta("act", text)
	U.on_click(c, cb)
	parent.add_child(c)
	var p := Panel.new()
	p.size = size_v
	p.mouse_filter = Control.MOUSE_FILTER_IGNORE
	p.add_theme_stylebox_override("panel", U.box(
		Color(tint, 0.18) if enabled else Color(0.09, 0.11, 0.15, 0.85),
		int(size_v.y * 0.5),
		Color(tint, 0.78) if enabled else Color(U.LINE, 0.5), 1))
	c.add_child(p)
	var l := U.label(text, 13 if size_v.y > 28.0 else 12,
		tint if enabled else Color(U.DIM, 0.62), HORIZONTAL_ALIGNMENT_CENTER)
	l.position = Vector2(0, (size_v.y - 18.0) * 0.5)
	l.size = Vector2(size_v.x, 18)
	l.clip_text = false
	c.add_child(l)


# ── 浮层：技能三选一 / 卡牌详情 ─────────────────────────────────────────────

func _open_overlay() -> Control:
	_close_overlay()
	var ov := Control.new()
	ov.position = Vector2.ZERO
	ov.size = DESIGN
	ov.mouse_filter = Control.MOUSE_FILTER_STOP
	_frame.add_child(ov)
	_overlay = ov
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.58)
	dim.size = DESIGN
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	U.on_click(dim, func(): _close_overlay())
	ov.add_child(dim)
	return ov


func _close_overlay() -> void:
	if _overlay != null and is_instance_valid(_overlay):
		_overlay.queue_free()
	_overlay = null


func _panel(ov: Control, h: float) -> Panel:
	var p := Panel.new()
	p.size = Vector2(600, h)
	p.position = Vector2(60, clampf((DESIGN.y - h) * 0.5, 60.0, DESIGN.y - h - 60.0))
	p.mouse_filter = Control.MOUSE_FILTER_STOP
	p.add_theme_stylebox_override("panel", U.box(Color("161c27"), 18, Color(U.LINE, 0.9), 1))
	ov.add_child(p)
	return p


func _open_skill_pick(cid: String, def: Dictionary, cost: int) -> void:
	var ov := _open_overlay()
	var used: Array = KPForge.record_for(profile, cid).get("masteries", [])
	var picks: Array = KPForge.draw_skills(func(): return randf(), 6)
	var shown: Array = []
	for s in picks:
		if used.has(str(s.get("id", ""))):
			continue
		shown.append(s)
		if shown.size() >= 3:
			break
	var ph := 190.0 + float(shown.size()) * 112.0
	var p := _panel(ov, ph)
	_lab(p, "%s · 精通" % str(def.get("name", cid)), Rect2(24, 20, 552, 34), 24, U.GOLD)
	_lab(p, KPForge.mastery_hint(def), Rect2(24, 58, 552, 24), 13, U.DIM)
	_lab(p, "花 %d 星尘，从下面三个里挑一个（选完强化等级归零）" % cost, Rect2(24, 84, 552, 24), 12, U.DIM)
	var y := 120.0
	for s in shown:
		var sid := str(s.get("id", ""))
		var rc: Color = RARITY_COLOR.get(str(s.get("rarity", "white")), RARITY_COLOR["white"])
		var row := Panel.new()
		row.position = Vector2(24, y)
		row.size = Vector2(552, 100)
		row.mouse_filter = Control.MOUSE_FILTER_STOP
		row.set_meta("skill", sid)
		U.on_click(row, func(): _pick_skill(cid, def, sid))
		p.add_child(row)
		row.add_theme_stylebox_override("panel", U.box(Color(0.114, 0.145, 0.204, 0.9), 12, Color(rc, 0.6), 2))
		_lab(row, str(s.get("name", sid)), Rect2(16, 8, 400, 26), 17, rc)
		_lab(row, str(KPForge.RARITY.get(s.get("rarity", "white"), {}).get("label", "")), Rect2(430, 10, 106, 20), 12, rc, HORIZONTAL_ALIGNMENT_RIGHT)
		_lab(row, str(s.get("text", "")), Rect2(16, 38, 520, 52), 12, U.TEXT, true)
		y += 112.0
	var cancel := _wide_btn(p, "取 消", Vector2(220, 48), Vector2(190, ph - 76), false, func(): _close_overlay())
	cancel.add_theme_color_override("font_color", U.DIM)


func _pick_skill(cid: String, def: Dictionary, sid: String) -> void:
	var res: Dictionary = KPForge.apply_mastery(profile, def, cid, sid)
	_close_overlay()
	_commit(res, "挂上了「%s」" % KPForge.mastery_name(sid))


func _open_detail(c: Dictionary) -> void:
	var def: Dictionary = c["def"]
	var rec: Dictionary = c["rec"]
	var st: Dictionary = c["stats"]
	var cid := str(c["id"])
	var spell := KPForge.is_spell(def)

	var body_w := 528.0
	var y := 96.0
	var blocks: Array = []   # [{text, fs, col, wrap}]
	var sub := "锦囊 · 费用 %s" % KPForge.fmt_num(st.get("cost", 0)) if spell \
		else "单位 · ⚔ %s / ♥ %s" % [KPForge.fmt_num(st.get("atk", 0)), KPForge.fmt_num(st.get("hp", 0))]
	if float(st.get("cost", 0)) != float(def.get("cost", 0)) and spell:
		sub += "（卡面 %s）" % KPForge.fmt_num(def.get("cost", 0))
	var eff := str(def.get("text", def.get("effect", "")))
	if eff == "":
		eff = "（这张牌没有额外说明）"
	var kws: Array = []
	for k in (def.get("keywords", []) as Array):
		var kid := str(k) if k is String else str((k as Dictionary).get("id", ""))
		if kid == "":
			continue
		var kn := DATA.keyword_name(kid)
		kws.append(kn if kn != kid else kid)
	var total := y + 30.0 + _th(eff, body_w, 13) + 18.0
	if not kws.is_empty():
		total += 30.0 + _th(" · ".join(kws), body_w, 12)
	total += 96.0
	var ph := clampf(total + 70.0, 320.0, 900.0)

	var ov := _open_overlay()
	var p := _panel(ov, ph)
	_lab(p, str(def.get("name", cid)), Rect2(26, 18, 548, 34), 26, U.TEXT)
	_lab(p, sub, Rect2(26, 54, 548, 22), 13, U.DIM)

	var cy := 92.0
	_lab(p, "效果", Rect2(26, cy, 100, 20), 13, U.GOLD)
	cy += 24.0
	_wrap_lab(p, eff, Rect2(26, cy, body_w, _th(eff, body_w, 13) + 4.0), 13, U.TEXT)
	cy += _th(eff, body_w, 13) + 10.0
	if not kws.is_empty():
		_lab(p, "词条", Rect2(26, cy, 100, 20), 13, U.GOLD)
		cy += 22.0
		_wrap_lab(p, " · ".join(kws), Rect2(26, cy, body_w, _th(" · ".join(kws), body_w, 12) + 4.0), 12, U.GOLD)
		cy += _th(" · ".join(kws), body_w, 12) + 10.0

	var line := ColorRect.new()
	line.color = Color(U.LINE, 0.6)
	line.position = Vector2(26, cy + 2.0)
	line.size = Vector2(548, 1)
	line.mouse_filter = Control.MOUSE_FILTER_IGNORE
	p.add_child(line)
	cy += 12.0
	_lab(p, "当前数值（含强化）", Rect2(26, cy, 300, 20), 13, U.GOLD)
	cy += 24.0
	var cur := "费用 %s" % KPForge.fmt_num(st.get("cost", 0)) if spell \
		else "⚔ %s / ♥ %s" % [KPForge.fmt_num(st.get("atk", 0)), KPForge.fmt_num(st.get("hp", 0))]
	_lab(p, cur, Rect2(26, cy, 548, 22), 15, U.TEXT)
	cy += 28.0
	var rec_line := "强化 %d/%d" % [int(rec.get("lvl", 0)), KPForge.ENHANCE_MAX]
	var ms: Array = rec.get("masteries", [])
	if ms.is_empty():
		rec_line += " · 还没精通"
	else:
		var names: Array = []
		for m in ms:
			names.append(KPForge.mastery_name(str(m)))
		rec_line += " · 精通 " + " · ".join(names)
	_lab(p, rec_line, Rect2(26, cy, 548, 20), 12, U.DIM)
	cy += 26.0
	var tip := "下一档强化 %d 金币" % KPForge.enhance_gold_cost(int(rec.get("lvl", 0))) \
		if int(rec.get("lvl", 0)) < KPForge.ENHANCE_MAX else "已练满，可花 %d 星尘精通" % KPForge.mastery_dust_cost(ms.size())
	_lab(p, tip, Rect2(26, cy, 548, 20), 12, U.DIM)

	_wide_btn(p, "关 闭", Vector2(220, 52), Vector2(190, ph - 72), false, func(): _close_overlay())


# ── 文本工具 ────────────────────────────────────────────────────────────────

func _th(text: String, width: float, fs: int) -> float:
	var f := get_theme_font("font")
	if f == null:
		return float(fs) * 1.7
	var sz := f.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, width, fs)
	return maxf(float(fs) + 6.0, sz.y)


func _lab(parent: Control, text: String, rect: Rect2, fs: int, col: Color,
		align: int = HORIZONTAL_ALIGNMENT_LEFT, wrap: bool = false) -> Label:
	var l := U.label(text, fs, col, align)
	l.position = rect.position
	parent.add_child(l)          # 先入树，否则最小尺寸会把 size 钳回文字原宽
	if wrap:
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.size = rect.size
	l.clip_text = not wrap
	return l


func _wrap_lab(parent: Control, text: String, rect: Rect2, fs: int, col: Color) -> void:
	_lab(parent, text, rect, fs, col, HORIZONTAL_ALIGNMENT_LEFT, true)


func _wide_btn(parent: Control, text: String, size_v: Vector2, pos: Vector2, primary: bool, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.position = pos
	b.size = size_v
	b.add_theme_font_size_override("font_size", 17)
	b.add_theme_color_override("font_color", U.TEXT)
	var tint := U.GOLD if primary else U.LINE
	b.add_theme_stylebox_override("normal", U.box(Color(0.114, 0.145, 0.204, 0.95), int(size_v.y * 0.5), Color(tint, 0.7), 1))
	b.add_theme_stylebox_override("hover", U.box(Color(0.145, 0.176, 0.243, 1.0), int(size_v.y * 0.5), tint, 2))
	b.add_theme_stylebox_override("pressed", U.box(U.PANEL, int(size_v.y * 0.5), tint, 2))
	b.pressed.connect(cb)
	parent.add_child(b)
	return b
