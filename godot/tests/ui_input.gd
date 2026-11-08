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
	await _test_spell()
	quit(0)


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
	var hand: Array = sess.my_hand()
	for i in hand.size():
		if int(hand[i].iid) == iid:
			if i < battle._hand_row.get_child_count():
				return battle._hand_row.get_child(i)
	return null


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
