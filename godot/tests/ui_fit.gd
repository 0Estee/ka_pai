## 全屏适配自检（作者 m01990 第 8 条）：不同屏幕比例下区域不重叠、不越界
##
## 无头可跑（只量矩形）：
##   node tools/godot.mjs --headless --path godot --script res://tests/ui_fit.gd
## 想看图（窗口模式）：
##   ... --path godot --resolution 720x1280 --script res://tests/ui_fit.gd -- --out E:/ka_pai/shots
extends SceneTree

const KPBattle := preload("res://scripts/ui/kp_battle.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")

var problems := 0
var checks := 0
var out_dir := ""


func _initialize() -> void:
	var args := OS.get_cmdline_user_args()
	for i in args.size():
		if args[i] == "--out" and i + 1 < args.size():
			out_dir = args[i + 1]
	await _run()
	print("[fit] checks=%d problems=%d" % [checks, problems])
	quit(0 if problems == 0 else 1)


func _check(ok: bool, msg: String) -> void:
	checks += 1
	if not ok:
		problems += 1
		print("[fit] FAIL ", msg)


func _run() -> void:
	# 竖屏手机、超长屏、老 iPhone、平板（矮宽）、方一点的折叠屏
	var sizes := [Vector2i(720, 1280), Vector2i(1080, 2400), Vector2i(750, 1334), Vector2i(1024, 768), Vector2i(884, 1104)]
	for sz in sizes:
		var vp := SubViewport.new()
		vp.size = sz
		vp.transparent_bg = false
		vp.render_target_update_mode = SubViewport.UPDATE_ALWAYS
		root.add_child(vp)
		await process_frame
		var sess = KPSession.new()
		sess.pace = 0.0
		sess.combat_line_pause = 0.0
		var battle = KPBattle.new()
		battle.anim = 0.0
		battle.session = sess
		vp.add_child(battle)
		battle.size = Vector2(sz)
		sess.start({"seed": 3001, "difficulty": "normal", "humanFaction": "demon", "aiFaction": "frost",
			"humanSide": 0, "pace": 0.0})
		for i in 8:
			await process_frame
		await _check_layout(battle, sz)
		if out_dir != "":
			DirAccess.make_dir_recursive_absolute(out_dir)
			var img: Image = null
			for i in 3:
				await process_frame
				img = vp.get_texture().get_image()
			var path := out_dir.path_join("fit-%dx%d.png" % [sz.x, sz.y])
			if img != null:
				img.save_png(path)
				print("shot ", path)
		battle.queue_free()
		await process_frame
		vp.queue_free()
		await process_frame


func _check_layout(battle, sz: Vector2i) -> void:
	var tag := "%dx%d" % [sz.x, sz.y]
	var h: float = battle._vh
	var boff: Vector2 = battle._r_board.position
	var s: float = battle._frame.scale.x
	# 至少有一个方向正好铺满（另一方向才允许留边）；两边都留边就是没适配
	var fill_w := absf(DESIGN_W(battle) * s - float(sz.x)) < 2.0
	var fill_h := absf(h * s - float(sz.y)) < 2.0
	_check(fill_w or fill_h, "%s: 两个方向都没铺满（%.1fx%.1f / %dx%d）" % [tag, DESIGN_W(battle) * s, h * s, sz.x, sz.y])
	_check(h * s <= float(sz.y) + 2.0, "%s: 缩放后高度 %.1f 超出窗口 %d" % [tag, h * s, sz.y])
	var rects := {
		"top": battle._r_top, "banner": battle._r_banner, "board": battle._r_board,
		"hint": battle._r_hint, "hand": battle._r_hand, "preview": battle._r_preview, "action": battle._r_action,
	}
	for k in rects:
		var r: Rect2 = rects[k]
		_check(r.size.x > 0.0 and r.size.y > 0.0, "%s: %s 尺寸非正 %s" % [tag, k, str(r.size)])
		_check(r.position.y >= -0.5 and r.end.y <= h + 0.5, "%s: %s 纵向越界 %.1f..%.1f / %.1f" % [tag, k, r.position.y, r.end.y, h])
	# 相邻区域不重叠（按纵向顺序）
	var order := ["top", "banner", "board", "hint", "hand", "preview", "action"]
	for i in range(order.size() - 1):
		var a: Rect2 = rects[order[i]]
		var b: Rect2 = rects[order[i + 1]]
		_check(a.end.y <= b.position.y + 0.5, "%s: %s 与 %s 重叠（%.1f > %.1f）" % [tag, order[i], order[i + 1], a.end.y, b.position.y])
	# 每个战场格与陷阱槽都在战场矩形内
	for li in 4:
		for half in 4:
			var cr: Rect2 = battle._cell_rect(li, half)
			cr.position += boff
			_check(cr.position.y >= battle._r_board.position.y - 0.5 and cr.end.y <= battle._r_board.end.y + 0.5,
				"%s: 格 %d/%d 纵向出界 %.1f..%.1f / %.1f..%.1f" % [tag, li, half, cr.position.y, cr.end.y, battle._r_board.position.y, battle._r_board.end.y])
		for side in 2:
			var tr: Rect2 = battle._trap_rect(li, side)
			tr.position += boff
			_check(tr.position.y >= battle._r_board.position.y - 0.5 and tr.end.y <= battle._r_board.end.y + 0.5,
				"%s: 陷阱槽 %d/%d 出界" % [tag, li, side])
	# 陷阱带必须夹在 foe_front 与 my_front 之间
	var foe_front: Rect2 = battle._cell_rect(0, 1)
	foe_front.position += boff
	var my_front: Rect2 = battle._cell_rect(0, 2)
	my_front.position += boff
	var trap0: Rect2 = battle._trap_rect(0, 0)
	trap0.position += boff
	_check(trap0.position.y >= foe_front.end.y - 0.5 and trap0.end.y <= my_front.position.y + 0.5,
		"%s: 陷阱带没夹在两排前场之间" % tag)
	# 真节点必须跟矩形一致：_build 时若只算了矩形没挪节点，屏幕上就会错位
	_check(battle._hand_scroll.position.distance_to(battle._r_hand.position) < 0.5 and 		absf(battle._hand_scroll.size.y - battle._r_hand.size.y) < 0.5,
		"%s: 手牌容器没跟到 _r_hand（%s vs %s）" % [tag, str(battle._hand_scroll.position), str(battle._r_hand.position)])
	_check(battle._board.position.distance_to(battle._r_board.position) < 0.5 and 		absf(battle._board.size.y - battle._r_board.size.y) < 0.5,
		"%s: 战场容器没跟到 _r_board（%s/%s）" % [tag, str(battle._board.size), str(battle._r_board.size)])
	_check(absf(battle._action.position.y - battle._r_action.position.y) < 0.5,
		"%s: 行动区没跟到 _r_action" % tag)
	_check(battle._board.get_child_count() >= 8, "%s: 战场里没有格子（%d 个子节点）" % [tag, battle._board.get_child_count()])
	# 底部不能留空：行动区必须贴到屏幕下端（留白 <= 10）
	_check(battle._r_action.end.y >= h - 10.0, "%s: 底部留白 %.1f" % [tag, h - battle._r_action.end.y])
	# 手牌不溢出
	var hand_w: float = battle._hand_row.size.x
	_check(hand_w <= battle._r_hand.size.x + 1.0, "%s: 手牌横向溢出 %.0f > %.0f" % [tag, hand_w, battle._r_hand.size.x])
	# 每张手牌都在手牌区内
	for c in battle._hand_row.get_children():
		if c is Control:
			_check((c as Control).size.y <= battle._r_hand.size.y + 1.0, "%s: 手牌高 %.0f 超出区 %.0f" % [tag, (c as Control).size.y, battle._r_hand.size.y])


func DESIGN_W(battle) -> float:
	return battle.DESIGN.x
