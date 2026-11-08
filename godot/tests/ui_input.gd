## 交互自检：真的往界面上「点」，看有没有走通 手牌 → 选中 → 地块 → 出牌
extends SceneTree

const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")

var battle
var sess


func _initialize() -> void:
	await process_frame
	_build()
	await _wait_my_turn()
	if not await _ensure_playable_unit():
		print("BLOCKED: 没有可打的单位牌，无法测放置流程")
		quit(2)
		return
	await _test_place()
	await _test_drag_place()
	await _test_drag_spell()
	await _test_spell()
	await _test_fold()
	quit(0)


func _build() -> void:
	sess = KPSession.new()
	sess.pace = 0.0
	battle = KPBattle.new()
	battle.session = sess
	battle.anim = 0.0   # 截图/自检要静态画面：动画全关
	root.add_child(battle)
	battle.size = battle.DESIGN
	battle._fit()
	sess.start({"seed": 2001, "difficulty": "normal", "humanFaction": "demon", "aiFaction": "frost", "humanSide": 0})


func _wait_my_turn() -> void:
	for i in 900:
		await process_frame
		if sess.is_over():
			return
		if sess.pending():          # 提问一律选第一项，别卡住
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


func _ensure_playable_unit():
	for i in 40:
		var entry := _first_unit_legal()
		if not entry.is_empty():
			return true
		if sess.is_over():
			return false
		if sess.pending():
			var opts: Array = sess.pending().get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
			await process_frame
			continue
		if sess.is_my_turn():
			sess.end_phase()
		await _wait_my_turn()
		await process_frame
	return false


## 点一个控件：走它自己的 gui_input（和真机触摸同一条路），坐标给全局矩形中心
func _click(node: Control) -> void:
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = node.get_global_rect().get_center()
	node.gui_input.emit(ev)
	await process_frame
	# 点击常常会触发重绘，旧节点可能已经被释放
	if not is_instance_valid(node):
		return
	var up := InputEventMouseButton.new()
	up.button_index = MOUSE_BUTTON_LEFT
	up.pressed = false
	up.position = ev.position
	node.gui_input.emit(up)
	await process_frame


func _hand_node_for(iid: int):
	for c in battle._hand_row.get_children():
		if c.has_meta("iid") and int(c.get_meta("iid", -1)) == iid:
			return c
	return null


## 设计稿坐标 → 某个手牌节点的本地坐标（拖拽松手事件要按节点的 position 传）
func _frame_to_local(node: Control, p: Vector2) -> Vector2:
	return node.get_global_transform().affine_inverse() * (_battle_frame_xform() * p)


func _battle_frame_xform() -> Transform2D:
	return battle._frame.get_global_transform()


func _cell_center(lane: String, row: String, side: int) -> Vector2:
	var half := ("my_" if side == int(sess.human_side) else "foe_") + row
	var lanes: Array = battle.KPC.LANES
	for i in lanes.size():
		if str(lanes[i]) == lane:
			return battle._board.position + battle._cell_rect(i, battle.HALVES.find(half)).get_center()
	return Vector2.ZERO


## 拖拽：按住 → 拖出 18px 进入拖拽 → 松手落在自家空地
func _test_drag_place() -> void:
	if not await _ensure_playable_unit():
		return
	var entry := _first_unit_legal()
	var iid := int(entry.iid)
	var node = _hand_node_for(iid)
	if node == null:
		print("FAIL 拖拽：找不到手牌节点 iid=%d" % iid)
		return
	var before: int = sess.my_hand().size()
	var cp0: int = int(sess.game.state.stats.cardsPlayed)
	var pl: Dictionary = entry.places[0]
	var target := _cell_center(str(pl.lane), str(pl.row), int(sess.human_side))
	_press(node)
	await process_frame
	var mid := _frame_to_local(node, target)
	var mv := InputEventMouseMotion.new()
	mv.position = mid
	node.gui_input.emit(mv)
	for i in 3:
		await process_frame
	var dragging: int = int(battle._drag_iid)
	_release(node, mid)
	for i in 90:
		await process_frame
		if sess.pending() == null and not sess.busy:
			break
	var u = sess.game.state.board[str(pl.lane)].units[int(sess.human_side)][str(pl.row)]
	var after: int = sess.my_hand().size()
	# 出牌后 AI 会立刻接着走（pace=0），单位可能已经被打掉、手牌也可能补回 6 张，
	# 所以判定看「出牌计数 +1」，不看场面
	var played: int = int(sess.game.state.stats.cardsPlayed) - cp0
	var ok: bool = dragging == iid and played >= 1
	print("DRAG_PLACE drag_iid=%d expect=%d lane=%s row=%s cardsPlayed+%d %s" % [int(dragging), iid, pl.lane, pl.row, played, "OK" if ok else "FAIL"])


## 拖拽：指向性锦囊拖到敌方单位 / 敌方国王（会自己把阶段推到锦囊阶段）
func _test_drag_spell() -> void:
	for i in 14:
		if sess.is_over():
			return
		if sess.pending():
			var opts: Array = sess.pending().get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
		elif sess.is_my_turn():
			if await _try_drag_spell():
				return
			sess.end_phase()
		await _wait_my_turn()
	var probe: Dictionary = sess.drag_targets("U01")
	print("DRAG_SPELL 本轮没有可拖的指向性锦囊；查询 U01 king=%s" % str(probe.get("king", false)))


func _try_drag_spell() -> bool:
	for iid in battle._legal.keys():
		var card_id: String = battle._card_id_of(int(iid))
		if str(battle.DATA.card(card_id).get("type", "")) != "spell":
			continue
		var tgt: Dictionary = sess.drag_targets(card_id)
		var uids: Array = tgt.get("uids", [])
		var king := bool(tgt.get("king", false))
		if uids.is_empty() and not king:
			continue
		var node = _hand_node_for(int(iid))
		if node == null:
			continue
		var target := Vector2(595, 56)   # 敌方国王（顶部右侧）
		var want := "国王"
		if not uids.is_empty():
			var uid := int(uids[0])
			for lane in battle.KPC.LANES:
				for side in [0, 1]:
					for row in ["front", "back"]:
						var u = sess.game.state.board[str(lane)].units[int(side)][str(row)]
						if u != null and int(u.uid) == uid:
							target = _cell_center(str(lane), str(row), int(side))
							want = "uid=%d %s/%s" % [uid, lane, row]
		var cp0: int = int(sess.game.state.stats.cardsPlayed)
		_press(node)
		await process_frame
		var mid := _frame_to_local(node, target)
		var mv := InputEventMouseMotion.new()
		mv.position = mid
		node.gui_input.emit(mv)
		for k in 3:
			await process_frame
		_release(node, mid)
		for k in 90:
			await process_frame
			if sess.pending() == null and not sess.busy:
				break
		var played: int = int(sess.game.state.stats.cardsPlayed) - cp0
		print("DRAG_SPELL card=%s → %s cardsPlayed+%d %s" % [card_id, want, played, "OK" if played >= 1 else "FAIL"])
		if sess.pending() != null:
			var o: Array = sess.pending().get("options", [])
			sess.answer_choice(o[0] if o.size() > 0 else {})
		return true
	return false


func _press(node: Control) -> void:
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = node.size * 0.5
	node.gui_input.emit(ev)


func _release(node: Control, local: Vector2) -> void:
	if not is_instance_valid(node):
		return
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = false
	ev.position = local
	node.gui_input.emit(ev)


func _test_place() -> void:
	var entry := _first_unit_legal()
	var iid := int(entry.iid)
	var card_node = _hand_node_for(iid)
	if card_node == null:
		print("FAIL 找不到手牌节点 iid=%d" % iid)
		return
	var before_hand: int = sess.my_hand().size()
	await _click(card_node)
	print("CLICK_CARD selected=%d expect=%d" % [int(battle._selected_iid), iid])
	var pl: Dictionary = entry.places[0]
	var half := "my_%s" % str(pl.row)
	var cell = battle._cell_nodes.get("%s:%s" % [str(pl.lane), half], null)
	if cell == null:
		print("FAIL 找不到地块 %s:%s" % [pl.lane, half])
		return
	await _click(cell)
	for i in 60:
		await process_frame
		if sess.pending() == null and not sess.busy:
			break
	var u = sess.game.state.board[str(pl.lane)].units[sess.human_side][str(pl.row)]
	var after_hand: int = sess.my_hand().size()
	print("PLACE lane=%s row=%s unit=%s hand %d→%d" % [pl.lane, pl.row, "有" if u != null else "无", before_hand, after_hand])
	if u == null or after_hand != before_hand - 1:
		print("FAIL 放置没生效")


func _test_spell() -> void:
	# 按「结束阶段」把阶段推到锦囊阶段，然后点一张锦囊
	for i in 12:
		if sess.is_over():
			return
		for iid in battle._legal.keys():
			var card_id: String = battle._card_id_of(int(iid))
			if str(battle.DATA.card(card_id).get("type", "")) == "spell":
				var node = _hand_node_for(int(iid))
				if node == null:
					continue
				var hand_before: int = sess.my_hand().size()
				var pile_before: int = int(sess.game.state.discard.size())
				await _click(node)
				for j in 90:
					await process_frame
					if sess.pending() == null and not sess.busy:
						break
				var hand_after: int = sess.my_hand().size()
				print("SPELL card=%s hand %d→%d 弃牌 %d→%d %s" % [card_id, hand_before, hand_after,
					pile_before, int(sess.game.state.discard.size()),
					"OK" if hand_after == hand_before - 1 or pile_before != int(sess.game.state.discard.size()) else "FAIL"])
				if sess.pending() != null:
					var o: Array = sess.pending().get("options", [])
					sess.answer_choice(o[0] if o.size() > 0 else {})
				return
		if sess.pending():
			var opts: Array = sess.pending().get("options", [])
			sess.answer_choice(opts[0] if opts.size() > 0 else {})
		elif sess.is_my_turn():
			sess.end_phase()
		await _wait_my_turn()
	print("NOTE 本轮没遇到可打出的锦囊，跳过")

## 手牌折叠（作者第 9 条）：>6 张时正排 6 张 + 「+N」堆，点开能展开、再点收起
func _test_fold() -> void:
	for i in 30:
		if sess.my_hand().size() > 6:
			break
		if sess.is_over():
			break
		if sess.pending():
			var o: Array = sess.pending().get("options", [])
			sess.answer_choice(o[0] if o.size() > 0 else {})
		elif sess.is_my_turn():
			sess.end_phase()
		await _wait_my_turn()
	var hand_n: int = sess.my_hand().size()
	if hand_n <= 6:
		print("FOLD 手牌只有 %d 张，跳过" % hand_n)
		return
	var folded_children: int = battle._hand_row.get_child_count()
	var chip = battle._fold_chip
	if chip == null or not is_instance_valid(chip):
		print("FOLD hand=%d 没有折叠堆 FAIL" % hand_n)
		return
	await _click(chip)
	await process_frame
	var expanded_children: int = battle._hand_row.get_child_count()
	var chip2 = battle._fold_chip
	var ok_expand: bool = battle._hand_expanded and expanded_children == hand_n + 1
	if chip2 != null and is_instance_valid(chip2):
		await _click(chip2)
		await process_frame
	var back_children: int = battle._hand_row.get_child_count()
	var ok_fold: bool = not battle._hand_expanded and back_children == 7 and folded_children == 7
	print("FOLD hand=%d 折叠 %d 子 / 展开 %d 子 / 收回 %d 子 %s" % [hand_n, folded_children, expanded_children, back_children, "OK" if (ok_expand and ok_fold) else "FAIL"])
