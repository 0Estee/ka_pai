## 界面自检：矩形越界、文字被截断、手牌溢出——不靠眼睛，靠量
extends SceneTree

const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")

var problems: Array = []
var checks := 0


func _initialize() -> void:
	await process_frame
	_check_home()
	await _check_battle()
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
			# 越界（允许 1px 误差）；ScrollContainer 里的东西由滚动负责，跳过
			if not (ctl.get_parent() is ScrollContainer) and not (ctl.get_parent().get_parent() is ScrollContainer):
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
	root.add_child(home)
	home.size = home.DESIGN
	home._fit()
	_walk(home._frame, home.DESIGN, "首页")
	print("HOME frame children=%d" % home._frame.get_child_count())
	root.remove_child(home)
	home.queue_free()


func _check_battle() -> void:
	var sess = KPSession.new()
	sess.pace = 0.0
	var battle = KPBattle.new()
	battle.session = sess
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
