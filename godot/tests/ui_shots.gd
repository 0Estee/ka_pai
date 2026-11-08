## 界面截图：把首页与对局屏真的画出来存成 png（窗口模式 + 离屏 720×1280 视口）
##
## --headless 是 dummy 渲染，截不到画面；必须开窗口跑：
##   Godot_v4.7.2-stable_win64_console.exe --path godot --resolution 720x1280 \
##     --script res://tests/ui_shots.gd -- --out E:/ka_pai/shots
## 画面画在一个 720×1280 的 SubViewport 里，所以截图尺寸永远等于设计稿，不受窗口大小影响。
extends SceneTree

const KPHome := preload("res://scripts/ui/kp_home.gd")
const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")

var out_dir := "user://"
var vp: SubViewport
var battle = null
var session = null


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		if args[i] == "--out" and i + 1 < args.size():
			out_dir = args[i + 1]
	DirAccess.make_dir_recursive_absolute(out_dir)
	_run()


func _run() -> void:
	vp = SubViewport.new()
	vp.size = Vector2i(720, 1280)
	vp.transparent_bg = false
	vp.disable_3d = true
	vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
	root.add_child(vp)
	await process_frame

	await _shot_home()
	await _open_battle()
	await _shot("refactor-godot-battle")
	await _select_first_card()
	await _shot("refactor-godot-battle-select")
	await _fake_choice()
	await _shot("refactor-godot-choice")
	await _answer_fake()
	await _open_detail()
	await _shot("refactor-godot-card-detail")
	await _close_detail()
	await _drive_to_end()
	await _shot("refactor-godot-result")
	print("[shots] 完成，输出目录 %s" % out_dir)
	quit(0)


func _shot(name: String) -> void:
	for i in 4:
		await process_frame
	var img: Image = vp.get_texture().get_image()
	if img == null:
		print("!! %s 截不到图" % name)
		return
	var path := out_dir.path_join(name + ".png")
	var err := img.save_png(path)
	print("shot %s → %s (%s) %dx%d" % [name, path, "ok" if err == OK else str(err), img.get_width(), img.get_height()])


func _shot_home() -> void:
	var home := KPHome.new()
	vp.add_child(home)
	await _shot("refactor-godot-home")
	vp.remove_child(home)
	home.queue_free()


func _open_battle() -> void:
	session = KPSession.new()
	session.pace = 0.02
	battle = KPBattle.new()
	battle.session = session
	battle.back_to_home.connect(func(): pass)
	battle.restart_requested.connect(func(): pass)
	vp.add_child(battle)
	session.start({
		"seed": 2001,
		"difficulty": "normal",
		"humanFaction": "demon",
		"aiFaction": "frost",
		"humanSide": 0,
	})
	for i in 900:
		await process_frame
		if session.is_my_turn():
			break


func _first_legal() -> Dictionary:
	for iid in battle._legal.keys():
		return battle._legal[iid]
	return {}


func _hand_node_for(iid: int):
	var hand: Array = session.my_hand()
	for i in hand.size():
		if int(hand[i].iid) == iid and i < battle._hand_row.get_child_count():
			return battle._hand_row.get_child(i)
	return null


func _click(node: Control) -> void:
	var ev := InputEventMouseButton.new()
	ev.button_index = MOUSE_BUTTON_LEFT
	ev.pressed = true
	ev.position = node.get_global_rect().get_center()
	node.gui_input.emit(ev)
	await process_frame


func _select_first_card() -> void:
	var entry := _first_legal()
	if entry.is_empty():
		return
	var node = _hand_node_for(int(entry.iid))
	if node != null:
		await _click(node)


func _fake_choice() -> void:
	session.game.take_choice({
		"type": "chooseOption",
		"side": session.human_side,
		"prompt": "「铁匠」的进场效果：选择一项",
		"options": [
			{"index": 0, "label": "抽一张牌"},
			{"index": 1, "label": "全体友方 +1 攻击"},
			{"index": 2, "label": "对敌方国王造成 2 点伤害"},
		],
	})
	for i in 200:
		await process_frame
		if session.pending() != null:
			break


func _answer_fake() -> void:
	if session.pending() != null:
		session.answer_choice({"index": 0})
	for i in 10:
		await process_frame


func _open_detail() -> void:
	var entry := _first_legal()
	if entry.is_empty():
		return
	battle._open_detail_card(str(entry.cardId))
	await process_frame


func _close_detail() -> void:
	battle._close_detail()
	await process_frame


func _drive_to_end() -> void:
	session.pace = 0.0
	var plays := 0
	for step in 4000:
		await process_frame
		if session.is_over():
			break
		var pending = session.pending()
		if pending != null:
			var opts: Array = pending.get("options", [])
			session.answer_choice(opts[0] if opts.size() > 0 else {})
			continue
		if session.busy or not session.is_my_turn():
			continue
		var legal: Array = session.legal_plays()
		if legal.is_empty():
			session.end_phase()
			continue
		var pick: Dictionary = legal[plays % legal.size()]
		var opts2: Dictionary = {}
		var places: Array = pick.get("places", [])
		if places.size() > 0 and places[0] != null:
			opts2 = {"lane": places[0].lane, "row": places[0].row}
		session.play_card(int(pick.iid), opts2)
		plays += 1
	for i in 6:
		await process_frame
