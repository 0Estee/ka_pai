## 强化工坊自检（作者 m01990 第 18 条）
##
## 检查什么：
##   列表   —— 单位 / 锦囊 / 已练 三栏张数与规则层一致，行宽不溢出；
##   强化   —— 点一下真扣金币、真涨强化等级、真落盘；
##   精通   —— 没练满时给理由；练满后弹三选一，选中后记进档案；锦囊直接减费；
##   洗掉   —— 去掉最近一次精通；
##   买星尘 —— 10 金币 → 1 星尘；
##   接进对局 —— KPSession 收到 enhance 增量；对局结束后档案加分、结果面板出现「本局结算」。
##
## 用法：node tools/godot.mjs --headless --path godot --script res://tests/ui_forge.gd
extends SceneTree

const KPForgePage := preload("res://scripts/ui/kp_forge_page.gd")
const KPForge := preload("res://scripts/ui/kp_forge.gd")
const KPProfile := preload("res://scripts/ui/kp_profile.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

const TEST_PROFILE := "user://test_forge_profile.json"

var problems: Array = []
var checks := 0
var page = null


func _initialize() -> void:
	await process_frame
	KPProfile.path = TEST_PROFILE
	_rm(TEST_PROFILE)
	KPProfile.save_profile(KPProfile.default_profile())
	await _check_page()
	await _check_actions()
	await _check_mastery()
	await _check_spell_mastery()
	await _check_buy_dust()
	await _check_detail()
	await _check_session_enhance()
	await _check_settlement()
	_rm(TEST_PROFILE)
	KPProfile.path = "user://profile.json"

	if problems.is_empty():
		print("[ui_forge] checks=%d problems=0" % checks)
		quit(0)
	else:
		for p in problems:
			print("  PROBLEM %s" % p)
		print("[ui_forge] checks=%d problems=%d" % [checks, problems.size()])
		quit(1)


func _rm(path: String) -> void:
	var abs := ProjectSettings.globalize_path(path)
	if FileAccess.file_exists(path):
		DirAccess.remove_absolute(abs)


func _expect(ok: bool, msg: String) -> void:
	checks += 1
	if not ok:
		problems.append(msg)


func _click(node) -> void:
	if node == null or not is_instance_valid(node):
		problems.append("点了个空控件")
		checks += 1
		return
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = node.get_global_rect().get_center()
	node.gui_input.emit(ev)
	await process_frame
	if not is_instance_valid(node):
		return
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.pressed = false
	up.position = ev.position
	node.gui_input.emit(up)
	await process_frame


func _text_of(node) -> String:
	if node == null or not is_instance_valid(node):
		return ""
	var out := ""
	if node is Label or node is Button:
		out += str(node.text) + " "
	for c in node.get_children():
		out += _text_of(c)
	return out


func _act(row: Control, prefix: String):
	for c in row.get_children():
		if c.has_meta("act") and str(c.get_meta("act")).begins_with(prefix):
			return c
	return null


func _row_by_cid(cid: String):
	for r in page._list.get_children():
		if r is Control and r.has_meta("cid") and str(r.get_meta("cid")) == cid:
			return r
	return null


func _rows() -> Array:
	var out: Array = []
	for r in page._list.get_children():
		if r is Control and r.has_meta("cid"):
			out.append(r)
	return out


# ── 页面与列表 ──────────────────────────────────────────────────────────────

func _check_page() -> void:
	print("== 工坊列表")
	page = KPForgePage.new()
	page.anim = 0.0
	root.add_child(page)
	page.size = page.DESIGN
	page._fit()
	await process_frame
	await process_frame

	var data: Dictionary = KPForge.workshop_cards(DATA.lib(), page.profile, "type")
	var units := 0
	var spells := 0
	for c in (data.get("cards", []) as Array):
		if str(c["type"]) == "unit":
			units += 1
		else:
			spells += 1
	_expect(units > 40 and spells > 20, "可强化卡应有几十张，实得 单位 %d / 锦囊 %d" % [units, spells])

	_expect(_rows().size() == units, "默认「单位」栏应有 %d 张，实得 %d" % [units, _rows().size()])
	_expect(page._pills_ui.size() == 3, "筛选项应有 3 个，实得 %d" % page._pills_ui.size())
	_expect(page._count.text.contains(str(units)), "右上角张数应写 %d，实得「%s」" % [units, page._count.text])

	# 行宽与内部不溢出
	var overflow := 0
	for r in _rows():
		if absf(r.size.x - 704.0) > 8.0:
			overflow += 1
		for c in r.get_children():
			if c is Label:
				if c.position.x + c.size.x > r.size.x + 1.0:
					overflow += 1
			elif c.has_meta("act"):
				if c.position.x + c.size.x > r.size.x + 1.0:
					overflow += 1
	_expect(overflow == 0, "工坊行里有 %d 处越界" % overflow)

	# 切到锦囊
	await _click(page._pills_ui[1])
	_expect(_rows().size() == spells, "「锦囊」栏应有 %d 张，实得 %d" % [spells, _rows().size()])
	# 切到已练（此时一张没练）
	await _click(page._pills_ui[2])
	_expect(_rows().size() == 0, "「已练」栏开局应为空，实得 %d" % _rows().size())
	# 切回单位
	await _click(page._pills_ui[0])
	_expect(_rows().size() == units, "切回「单位」应还是 %d 张，实得 %d" % [units, _rows().size()])


# ── 强化 ────────────────────────────────────────────────────────────────────

func _check_actions() -> void:
	print("== 强化")
	var row = _rows()[0]
	var cid := str(row.get_meta("cid"))
	var def: Dictionary = DATA.card(cid)
	var gold0 := float(page.profile.gold)
	var res: Dictionary = KPForge.apply_enhance(page.profile, def, cid)
	_expect(bool(res.get("ok", false)), "第一张牌应该能强化：%s" % str(res.get("reason", "")))
	# 从干净档案重来，走界面点
	page.profile = KPProfile.default_profile()
	page._refresh_head()
	page._rebuild_list()
	await process_frame
	row = _row_by_cid(cid)
	var btn = _act(row, "强化")
	_expect(btn != null, "行里找不到「强化」按钮")
	await _click(btn)
	var rec: Dictionary = KPForge.record_for(page.profile, cid)
	_expect(int(rec.get("lvl", 0)) == 1, "点强化后等级应 1，实得 %d" % int(rec.get("lvl", 0)))
	var cost := KPForge.enhance_gold_cost(0)
	_expect(absf(float(page.profile.gold) - (gold0 - float(cost))) < 0.001,
		"金币应 %d → %d，实得 %s" % [int(gold0), int(gold0) - cost, KPForge.fmt_num(page.profile.gold)])

	# 落盘：重新从磁盘读回来也有这条记录
	var disk: Dictionary = KPProfile.load_profile()
	_expect(int(KPForge.record_for(disk, cid).get("lvl", 0)) == 1, "强化记录没写进磁盘")

	# 没练满不能精通：按钮点了只给理由
	await _click(_act(_row_by_cid(cid), "精通"))
	_expect(page._toast.text.contains("还要强化"), "没练满点精通应提示还差几次，实得「%s」" % page._toast.text)
	_expect(page._overlay == null, "没练满不应该弹三选一")


# ── 精通（单位） ────────────────────────────────────────────────────────────

func _check_mastery() -> void:
	print("== 精通")
	var cid := str(_rows()[0].get_meta("cid"))
	var def: Dictionary = DATA.card(cid)
	page.profile["forge"]["cards"][cid] = {"lvl": KPForge.ENHANCE_MAX, "masteries": []}
	page.profile["dust"] = 1000.0
	page._refresh_head()
	page._rebuild_list()
	await process_frame
	var btn = _act(_row_by_cid(cid), "精通")
	_expect(btn != null, "找不到精通按钮")
	await _click(btn)
	_expect(page._overlay != null, "练满后点精通应弹三选一")
	var picks: Array = []
	if page._overlay != null:
		for c in page._overlay.get_children():
			for k in c.get_children():
				if k.has_meta("skill"):
					picks.append(k)
	_expect(picks.size() == 3, "三选一应有 3 个技能，实得 %d" % picks.size())
	var dust0 := float(page.profile.dust)
	if picks.size() > 0:
		var sid := str(picks[0].get_meta("skill"))
		await _click(picks[0])
		var rec: Dictionary = KPForge.record_for(page.profile, cid)
		var ms: Array = rec.get("masteries", [])
		_expect(ms.size() == 1 and str(ms[0]) == sid, "选中的技能应记进档案，实得 %s" % str(ms))
		_expect(int(rec.get("lvl", 0)) == 0, "精通后强化等级应归零，实得 %d" % int(rec.get("lvl", 0)))
		_expect(absf(float(page.profile.dust) - (dust0 - float(KPForge.mastery_dust_cost(0)))) < 0.001,
			"星尘应扣 %d，实得 %s" % [KPForge.mastery_dust_cost(0), KPForge.fmt_num(page.profile.dust)])
		_expect(page._overlay == null, "选完技能浮层应关闭")
		var disk: Dictionary = KPProfile.load_profile()
		_expect((KPForge.record_for(disk, cid).get("masteries", []) as Array).size() == 1, "精通记录没写进磁盘")

	# 洗掉
	await _click(_act(_row_by_cid(cid), "洗"))
	var washed: Array = KPForge.record_for(page.profile, cid).get("masteries", [])
	_expect(washed.is_empty(), "洗掉后精通应为空，实得 %s" % str(washed))
	# 没有精通时洗掉按钮给了理由
	await _click(_act(_row_by_cid(cid), "洗"))
	_expect(page._toast.text.contains("没有可洗") or page._toast.text.contains("洗掉"), "空洗应给提示，实得「%s」" % page._toast.text)


# ── 精通（锦囊直接减费） ────────────────────────────────────────────────────

func _check_spell_mastery() -> void:
	print("== 锦囊精通")
	await _click(page._pills_ui[1])
	var row = _rows()[0]
	var cid := str(row.get_meta("cid"))
	var def: Dictionary = DATA.card(cid)
	page.profile["forge"]["cards"][cid] = {"lvl": KPForge.ENHANCE_MAX, "masteries": []}
	page.profile["dust"] = 1000.0
	page._rebuild_list()
	await process_frame
	await _click(_act(_row_by_cid(cid), "精通"))
	var ms: Array = KPForge.record_for(page.profile, cid).get("masteries", [])
	_expect(ms.size() == 1 and str(ms[0]) == "spell_cost", "锦囊精通应直接记 spell_cost，实得 %s" % str(ms))
	_expect(page._overlay == null, "锦囊精通不该弹三选一")
	var st: Dictionary = KPForge.stats_for(def, KPForge.record_for(page.profile, cid))
	_expect(float(st.cost) < float(def.get("cost", 0)), "锦囊精通后费用应下降：%s → %s" % [str(def.get("cost", 0)), str(st.cost)])
	await _click(page._pills_ui[0])


# ── 买星尘 ──────────────────────────────────────────────────────────────────

func _check_buy_dust() -> void:
	print("== 买星尘")
	page.profile["gold"] = 100.0
	page.profile["dust"] = 10.0
	page._refresh_head()
	var card = page._frame.get_child(0)  # 不需要，直接点页面上的按钮
	var buy = null
	for c in page.body.get_children():
		for k in c.get_children():
			if k.has_meta("act") and str(k.get_meta("act")).begins_with("买"):
				buy = k
	_expect(buy != null, "顶栏找不到「买星尘」按钮")
	if buy != null:
		await _click(buy)
		_expect(absf(float(page.profile.gold) - 90.0) < 0.001, "买星尘后金币应 90，实得 %s" % KPForge.fmt_num(page.profile.gold))
		_expect(absf(float(page.profile.dust) - 11.0) < 0.001, "买星尘后星尘应 11，实得 %s" % KPForge.fmt_num(page.profile.dust))
		var disk: Dictionary = KPProfile.load_profile()
		_expect(absf(float(disk.dust) - 11.0) < 0.001, "买星尘没落盘，磁盘里是 %s" % KPForge.fmt_num(disk.dust))


# ── 详情浮层 ────────────────────────────────────────────────────────────────

func _check_detail() -> void:
	print("== 卡牌详情")
	var row = _rows()[0]
	var cid := str(row.get_meta("cid"))
	var hit = null
	for c in row.get_children():
		if c is Control and not c.has_meta("act") and c.get_child_count() == 0 and c.mouse_filter == Control.MOUSE_FILTER_STOP:
			hit = c
	_expect(hit != null, "行里的「点名字看详情」热区没找到")
	if hit != null:
		await _click(hit)
		_expect(page._overlay != null, "点名字应弹详情浮层")
		var txt := _text_of(page._overlay)
		_expect(txt.contains(str(DATA.card(cid).get("name", ""))), "详情里应有卡名「%s」" % str(DATA.card(cid).get("name", "")))
		_expect(txt.contains("效果"), "详情里应有「效果」一节")
		_expect(txt.contains("当前数值"), "详情里应有「当前数值」一节")
		# 点暗底关掉
		var dim = page._overlay.get_child(0)
		await _click(dim)
		_expect(page._overlay == null, "点暗底应关闭详情")


# ── 接进对局：会话收得到 enhance ────────────────────────────────────────────

func _check_session_enhance() -> void:
	print("== 会话接强化")
	var sess := KPSession.new()
	sess.start({"seed": 1001, "pace": 0.0, "enhance": [{"U03": {"atk": 2.0}}, {}]})
	var guard := 0
	while sess.game == null and guard < 200:
		guard += 1
		await process_frame
	await process_frame
	await process_frame
	_expect(sess.game != null, "会话没建起来")
	if sess.game != null:
		var e0: Dictionary = (sess.game.state.enhance as Array)[0]
		_expect(e0.has("U03"), "我方增量里应有 U03，实得 %s" % str(e0.keys()))
		if e0.has("U03"):
			_expect(absf(float(e0["U03"].atk) - 2.0) < 0.001, "U03 应 +2 攻，实得 %s" % str(e0["U03"].atk))


# ── 打完一局：档案加分 + 结果面板出现结算 ───────────────────────────────────

func _check_settlement() -> void:
	print("== 对局结算写档案")
	KPProfile.save_profile(KPProfile.default_profile())
	var shell = load("res://scripts/main.gd").new()
	root.add_child(shell)
	await process_frame
	shell.start_battle({
		"seed": 4242, "difficulty": "normal", "humanFaction": "demon", "aiFaction": "sword",
		"deckSize": 80, "humanSide": 0, "pace": 0.0,
	})
	await process_frame
	await process_frame
	var battle = shell._screen
	_expect(battle != null and battle.session != null, "外壳没把对局建起来")
	if battle == null or battle.session == null:
		return
	battle.session.surrender()
	await process_frame
	await process_frame
	var after: Dictionary = KPProfile.load_profile()
	_expect(int(after.get("games", 0)) == 1, "打完一局战绩应 +1，实得 %d" % int(after.get("games", 0)))
	_expect(float(after.get("gold", 0)) > 100.0, "战败也应给金币，实得 %s" % KPForge.fmt_num(after.get("gold", 0)))
	_expect(not battle.reward_info.is_empty(), "结果面板没拿到结算信息")
	_expect(battle.reward_info.has("lines"), "结算信息里应有一行行说明")
	var txt := _text_of(battle._overlay)
	_expect(txt.contains("本 局 结 算"), "结果面板上应写「本局结算」，实际文字：%s" % txt)
	# 再来一局不会重复结算：重新进对局但先不再打
	_expect(bool(battle.session.rewarded), "会话应标记已结算，避免重复加分")
	shell.queue_free()
	await process_frame
