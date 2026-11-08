## 界面自检：矩形越界、文字被截断、手牌溢出——不靠眼睛，靠量
extends SceneTree

const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")
const PAGE_SET := preload("res://scripts/ui/kp_settings_page.gd")
const PAGE_REPLAY := preload("res://scripts/ui/kp_replay_page.gd")
const PAGE_ONLINE := preload("res://scripts/ui/kp_online_page.gd")
const REPLAY := preload("res://scripts/ui/kp_replay.gd")
const SETTINGS := preload("res://scripts/ui/kp_settings.gd")

var problems: Array = []
var checks := 0


func _initialize() -> void:
	await process_frame
	await _check_home()
	await _check_battle()
	await _check_pages()
	print("QA checks=%d problems=%d" % [checks, problems.size()])
	for p in problems:
		print("  ✗ " + str(p))
	quit(0 if problems.is_empty() else 1)


func _text_width(l: Label) -> float:
	var f := l.get_theme_font("font")
	var fs := l.get_theme_font_size("font_size")
	return f.get_string_size(l.text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x


func _walk(node: Node, design: Vector2, region: String) -> void:
	for c in node.get_children():
		checks += 1
		if c is Control:
			var ctl: Control = c
			var r := Rect2(ctl.position, ctl.size)
			# 光晕/星云/暗角/碎光这类装饰节点故意画到画面外，不算越界
			var decor := ctl.has_meta("decor")
			# 越界（允许 1px 误差）；ScrollContainer 里的东西由滚动负责，跳过
			if not decor and not (ctl.get_parent() is ScrollContainer) and not (ctl.get_parent().get_parent() is ScrollContainer):
				if r.position.x < -1 or r.position.y < -1 or r.end.x > design.x + 1 or r.end.y > design.y + 1:
					problems.append("%s: %s 越界 rect=%s (设计稿 %s)" % [region, ctl.name, r, design])
			if ctl is Label:
				var l: Label = ctl
				if not l.autowrap_mode and l.clip_text and l.text != "":
					var tw := _text_width(l)
					if tw > l.size.x + 2.0:
						problems.append("%s: 文字被截断「%s」需要 %.0fpx 只有 %.0fpx" % [region, l.text, tw, l.size.x])
			if ctl is Button:
				var b: Button = ctl
				if b.text != "" and not b.clip_text:
					var f := b.get_theme_font("font")
					var fs := b.get_theme_font_size("font_size")
					var tw2 := f.get_string_size(b.text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
					if tw2 > b.size.x + 2.0:
						problems.append("%s: 按钮文字溢出「%s」需要 %.0fpx 只有 %.0fpx" % [region, b.text, tw2, b.size.x])
		_walk(c, design, region)


func _check_home() -> void:
	var home := KPHome.new()
	home.anim = 0.0          # 自检要看静态画面：选项直接落在环上
	root.add_child(home)
	home.size = home.DESIGN
	home._fit()
	_walk(home._frame, home.DESIGN, "首页:一级")
	print("HOME frame children=%d level=%s items=%d" % [
		home._frame.get_child_count(), home._level, home._items.size()])
	for lv in ["faction", "difficulty", "seed"]:
		home._enter_level(lv)
		for i in 4:
			await process_frame
		_walk(home._items_root, home.DESIGN, "首页:" + lv)
		var max_r := 0.0
		for it in home._items:
			if is_instance_valid(it):
				max_r = maxf(max_r, (it.position + it.size * 0.5 - home.ORB_CENTER).length())
		print("HOME level=%s items=%d 最远半径=%.1f" % [lv, home._items.size(), max_r])
	home._enter_level("root")
	for i in 4:
		await process_frame
	root.remove_child(home)
	home.queue_free()


func _check_battle() -> void:
	var sess = KPSession.new()
	sess.pace = 0.0
	var battle = KPBattle.new()
	battle.session = sess
	battle.anim = 0.0   # 截图/自检要静态画面：动画全关
	root.add_child(battle)
	battle.size = battle.DESIGN
	battle._fit()
	sess.start({"seed": 2001, "difficulty": "normal", "humanFaction": "demon", "aiFaction": "frost", "humanSide": 0})
	for i in 600:
		await process_frame
		if sess.is_my_turn():
			break
	await process_frame
	_walk(battle._frame, battle.DESIGN, "对局屏")
	print("BATTLE hand_cards=%d hand_row_size=%s hand_rect=%s" % [
		battle._hand_row.get_child_count(), battle._hand_row.size, battle.HAND_RECT.size])
	if battle._hand_row.get_child_count() <= 8 and battle._hand_row.size.x > battle.HAND_RECT.size.x + 1.0:
		problems.append("对局屏: 手牌横向溢出 %.0f > %.0f" % [battle._hand_row.size.x, battle.HAND_RECT.size.x])
	# 提问面板
	sess.game.take_choice({"type": "chooseOption", "side": sess.human_side,
		"prompt": "「铁匠」的进场效果：选择一项",
		"options": [{"index": 0, "label": "抽一张牌"}, {"index": 1, "label": "全体友方 +1 攻击"},
			{"index": 2, "label": "对敌方国王造成 2 点伤害"}]})
	for i in 60:
		await process_frame
		if sess.pending() != null:
			break
	await process_frame
	print("BATTLE choice_overlay_children=%d" % battle._overlay.get_child_count())
	_walk(battle._overlay, battle.DESIGN, "提问面板")
	sess.answer_choice({"index": 0})
	for i in 5:
		await process_frame


## 设置 / 回放 / 联机三页：越界、截断、区块高度
func _check_pages() -> void:
	var rec := {"version": 1, "savedAt": 1762490000, "seed": 2077, "difficulty": "hard",
		"humanFaction": "sword", "aiFaction": "frost", "deckSize": 80, "humanSide": 0,
		"actions": [],
		"result": {"winner": 0, "winReason": "后手国王被击破", "turns": 8,
			"cardsPlayed": 14, "kingHp": [20, -2]}}
	var saved := REPLAY.save(rec)

	var pages := [["设置", PAGE_SET.new()], ["联机", PAGE_ONLINE.new()], ["回放", PAGE_REPLAY.new()]]
	for pair in pages:
		var page = pair[1]
		root.add_child(page)
		page.size = page.DESIGN
		page._fit()
		for i in 90:
			await process_frame
		_walk(page._frame, page.DESIGN, "页面:" + str(pair[0]))
		# 内容不许越过 BODY_BOTTOM，也不许压到左上返回钮
		for c in page.body.get_children():
			checks += 1
			if c is Control:
				var r := Rect2(c.position + page.body.position, c.size)
				if r.end.y > page.BODY_BOTTOM + 1.0:
					problems.append("页面:%s: %s 超出内容区下沿 %.0f > %.0f" % [pair[0], c.name, r.end.y, page.BODY_BOTTOM])
		print("PAGE %s body_children=%d" % [str(pair[0]), page.body.get_child_count()])
		root.remove_child(page)
		page.queue_free()
		await process_frame

	# 设置页药丸总数与选中态
	var sp = PAGE_SET.new()
	root.add_child(sp)
	sp.size = sp.DESIGN
	sp._fit()
	for i in 40:
		await process_frame
	var total: int = sp._pills_fx.size() + sp._pills_anim.size() + sp._pills_pace.size() + sp._pills_diff.size() + sp._pills_deck.size()
	print("PAGE 设置 pills=%d fx=%d anim=%d pace=%d diff=%d deck=%d" % [total,
		sp._pills_fx.size(), sp._pills_anim.size(), sp._pills_pace.size(), sp._pills_diff.size(), sp._pills_deck.size()])
	if total != 17:
		problems.append("设置页药丸应 17 颗，实得 %d" % total)
	root.remove_child(sp)
	sp.queue_free()
	await process_frame

	REPLAY.remove(saved)
