## 动画自检：出牌飞行真的从手牌飞到格子、落地后才进引擎；进场/受击/阵亡都有过渡
##
## anim=1.0（真机默认），不是 0 —— 这里要量的是动画本身，不是交互。
extends SceneTree

const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")

var battle
var sess
var problems := 0


func _initialize() -> void:
	await process_frame
	_build()
	await _wait_my_turn()
	# 无头机帧率会抖（一次飞行可能只采到 19 帧、也可能 56 帧），
	# 用 0.25 倍时钟把同一段动画摊到 4 倍帧数上，采样才稳定。
	Engine.time_scale = 0.25
	await _test_fly_and_land()
	await _test_ai_turn_anim()
	Engine.time_scale = 1.0
	print("[anim] 完成，问题 %d 个" % problems)
	quit(0 if problems == 0 else 1)


func _fail(msg: String) -> void:
	problems += 1
	print("  ✗ " + msg)


func _build() -> void:
	sess = KPSession.new()
	sess.pace = 0.0
	battle = KPBattle.new()
	battle.session = sess
	root.add_child(battle)
	battle.size = battle.DESIGN
	battle._fit()
	sess.start({"seed": 2001, "difficulty": "normal", "humanFaction": "demon", "aiFaction": "frost", "humanSide": 0})


func _wait_my_turn() -> void:
	for i in 900:
		await process_frame
		if sess.is_over():
			return
		if sess.pending():
			var opts: Array = sess.pending().get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
			continue
		if sess.is_my_turn() and not battle._legal.is_empty():
			return


func _first_unit_legal() -> Dictionary:
	for iid in battle._legal.keys():
		var entry: Dictionary = battle._legal[iid]
		var places: Array = entry.get("places", [])
		if places.size() > 0 and places[0] != null:
			return entry
	return {}


func _click(node: Control) -> void:
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


func _n_fx_children() -> int:
	return battle._fx_layer.get_child_count()


## 找出正在飞的那张牌：_fx_layer 里唯一一个带 iid 元数据的控件
func _flying_card():
	for c in battle._fx_layer.get_children():
		if c.has_meta("iid"):
			return c
	return null


func _test_fly_and_land() -> void:
	print("== 出牌飞行")
	var entry := _first_unit_legal()
	if entry.is_empty():
		_fail("没有可打的单位牌，跳过")
		return
	var iid := int(entry.iid)
	var card_node = battle._hand_node_of(iid)
	if card_node == null:
		_fail("找不到手牌节点 iid=%d" % iid)
		return

	var hand_before: int = sess.my_hand().size()
	var src: Rect2 = battle._node_rect_in_fx(card_node)
	await _click(card_node)          # 选中
	var pl: Dictionary = entry.places[0]
	var cell = battle._cell_nodes.get("%s:my_%s" % [str(pl.lane), str(pl.row)], null)
	if cell == null:
		_fail("找不到地块")
		return

	# 出手：这一刻动画应当已经接管，引擎还没动
	var hand_now: int = sess.my_hand().size()
	await _click(cell)
	if not battle._busy_anim:
		_fail("点下地块后没有进入「飞行中」状态")
	if _flying_card() == null:
		_fail("_fx_layer 里没有飞行中的卡牌")
	var p0 := (_flying_card() as Control).position if _flying_card() != null else Vector2.ZERO

	# 飞行途中逐帧采样，看它真的在从手牌往格子移动
	var moved := 0.0
	var max_y_arc := 0.0
	var frames := 0
	var saw := 0
	while battle._busy_anim and frames < 3000:
		await process_frame
		frames += 1
		var fc = _flying_card()
		if fc != null and is_instance_valid(fc):
			saw += 1
			var p: Vector2 = (fc as Control).position
			moved = maxf(moved, (p - p0).length())
			max_y_arc = maxf(max_y_arc, p0.y - p.y)
	if saw < 3:
		_fail("飞行中的卡牌只被采到 %d 帧，动画可能被跳过了" % saw)

	print("  飞行帧数=%d 位移=%.0fpx 抛物线最高=%.0fpx" % [frames, moved, max_y_arc])
	if moved < 100.0:
		_fail("飞行位移只有 %.0fpx（手牌→格子应当是几百像素）" % moved)
	if max_y_arc < 20.0:
		_fail("没有抛物线起手（最高只抬了 %.0fpx）" % max_y_arc)

	# 落地之后：引擎才收到这张牌，同时单位应当带着缩放动画进场
	var cell_key := "%s:my_%s" % [str(pl.lane), str(pl.row)]
	var min_scale := 9.0
	var max_scale := 0.0
	for i in 900:
		await process_frame
		var c = battle._cell_nodes.get(cell_key, null)
		if c != null and is_instance_valid(c):
			min_scale = minf(min_scale, (c as Control).scale.x)
			max_scale = maxf(max_scale, (c as Control).scale.x)
		if sess.pending() == null and not sess.busy and i > 6:
			break
	var hand_after: int = sess.my_hand().size()
	var u = sess.game.state.board[str(pl.lane)].units[sess.human_side][str(pl.row)]
	print("  落地：手牌 %d→%d 单位=%s 进场 scale %.2f→%.2f" % [hand_now, hand_after,
		"有" if u != null else "无", min_scale, max_scale])
	if u == null or hand_after != hand_before - 1:
		_fail("落地后单位没上场 / 手牌没减少")
	if min_scale > 0.95:
		_fail("单位是「直接满尺寸」出现的，没有进场动画")

	var cell2 = battle._cell_nodes.get(cell_key, null)
	# 等动画彻底收尾，格子应当回到原尺寸
	for i in 900:
		await process_frame
		if cell2 != null and is_instance_valid(cell2) and absf((cell2 as Control).scale.x - 1.0) < 0.01:
			break
	if cell2 != null and is_instance_valid(cell2) and absf((cell2 as Control).scale.x - 1.0) > 0.02:
		_fail("进场动画没有收回到 1.0（现在是 %.2f）" % (cell2 as Control).scale.x)


## 对手行动时：出牌应该带来受击/阵亡/上阵的过渡，而不是整屏闪一下
func _test_ai_turn_anim() -> void:
	print("== 对手回合演出")
	var foe_seen := 0
	for step in 1600:
		await process_frame
		for ch in battle._fx_layer.get_children():
			if ch.has_meta("foe"):
				foe_seen += 1
				break
		if sess.pending():
			var opts: Array = sess.pending().get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
			continue
		if sess.is_over():
			break
		if sess.is_my_turn() and not sess.busy:
			sess.end_phase()
	for i in 120:
		await process_frame
	if not battle._pending_fx.is_empty():
		_fail("演出事件没被消化（积压 %d 条）" % battle._pending_fx.size())
	print("  残留特效节点=%d 积压事件=%d 对手飞牌帧数=%d" % [_n_fx_children(), battle._pending_fx.size(), foe_seen])
