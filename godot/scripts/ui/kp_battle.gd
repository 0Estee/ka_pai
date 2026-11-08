## 对局屏：HUD + 战场 + 手牌 + 提问面板 + 演出 + 终局面板
##
## 设计稿尺寸固定 720×1280（project.godot 的 viewport 就是这个），
## 根节点铺满窗口后按 min(宽比, 高比) 整体缩放居中，所以任何手机屏都不会错位。
##
## 它只做两件事：把 KPSession 的状态画出来；把点击翻译成 KPSession 的动作。
## 规则一条都不在这里 —— 那是 scripts/engine/ 的事。
class_name KPBattle
extends Control

signal back_to_home
signal restart_requested

const KPC := preload("res://scripts/engine/kp_constants.gd")
const U := preload("res://scripts/ui/kp_ui.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

const FOLD_AT := 6                 # 正排最多显示几张手牌（其余折叠）
const DESIGN := Vector2(720, 1280)

const MIN_H := 1180.0              # 设计稿至少要多高（再矮就把界面整体缩小）
const CELL_W := 168.0
const CELL_GAP := 6.0
const BOARD_HEADER := 28.0

# 各区域的实际矩形：按窗口比例在 _layout() 里算，屏幕越高战场与手牌越大。
# （作者 m01990 第 8 条：大小要适配所有屏幕 —— 不再固定 720×1280 留黑边）
var _r_top := Rect2(0, 0, 720, 118)
var _r_banner := Rect2(0, 122, 720, 44)
var _r_board := Rect2(8, 174, 704, 478)
var _r_hint := Rect2(8, 658, 704, 30)
var _r_hand := Rect2(0, 694, 720, 300)
var _r_preview := Rect2(8, 1000, 704, 150)
var _r_action := Rect2(0, 1158, 720, 96)
var _vh := 1280.0                  # 当前设计稿高（宽度恒为 720）
var _cell_h := 106.0               # 战场每排高度
var _rows_y0 := 28.0               # 第一排的 y（四排整体在战场里垂直居中）
var _trap_band := 22.0             # 中间陷阱带的高度
const HALVES := ["foe_back", "foe_front", "my_front", "my_back"]

var session = null

var _frame: Control
var _top: Control
var _top_refs: Dictionary = {}   # HUD 里会被反复改写的节点
var _banner: Control
var _board: Control
var _hint: Label
var _hand_scroll: ScrollContainer
var _hand_row: HBoxContainer
var _preview: Control
var _action: Control
var _fx_layer: Control
var _overlay: Control

var _selected_iid := -1
var _legal: Dictionary = {}        # iid -> legal play entry
var _cell_nodes: Dictionary = {}   # "lane:half" -> Control
var _detail_card := ""             # 详情浮层的卡牌 id
var _detail_uid := -1              # 详情浮层的场上单位 uid
var _result_shown := false

# ── 动画状态 ────────────────────────────────────────────────────────────────
# anim 是全局速度倍率：1.0 正常，0.0 代表整套动画关掉（自检脚本用，点一下就生效）
var anim := 1.0
var _busy_anim := false            # 卡牌还在飞：这段窗口里不接受新的输入
var _pending_fx: Array = []        # _on_fx 先攒着，等 _refresh 把节点建好再放
var _prev_units: Dictionary = {}   # 上一帧场上单位快照 uid -> {lane,row,side,name,atk,hp}
var _prev_hand: Array = []         # 上一帧手牌 iid 顺序
var _first_paint := true
var _cell_sig: Dictionary = {}     # "lane:half" -> 内容签名；签名没变就复用节点，动画不被打断
var _overlay_key := ""             # 浮层内容指纹；没变就不重播弹出动画
var _last_selected := -1
var _hand_added: Array = []        # 本次 _build_hand 新加入的手牌 iid（用来做进场动画）

# ── 拖拽出牌（作者 2026-11-08 第 5 条）──────────────────────────────────────
# 长按手牌 0.26s 或按住拖出 18px 进入拖拽；松手落在哪里就打到哪里。
# 指向性锦囊拖到敌方单位 / 敌方国王上 —— 目标就是拖到的那个。
var _press_iid := -1
var _press_node: Control = null
var _press_at := 0                # Time.get_ticks_msec()
var _press_pos := Vector2.ZERO    # 设计稿坐标
var _pointer := Vector2.ZERO      # 设计稿坐标下的当前指针
var _drag_iid := -1
var _drag_ghost: Control = null
var _drag_src: Control = null
var _drag_grab := Vector2.ZERO
var _drag_uids: Array = []        # 这张牌能指向的单位 uid
var _drag_king := false
var _drag_marks: Array = []
var _hand_expanded := false       # 手牌 >6 张时是否已展开（作者 2026-11-08 第 9 条）
var _fold_chip: Control = null


# ══════════════════════════════════════════════════════════
# 构建
# ══════════════════════════════════════════════════════════

func _ready() -> void:
	# 自己管尺寸：不靠父节点的布局通知（顶层 Control 挂在 Window 下时它不一定来）
	set_anchors_preset(Control.PRESET_TOP_LEFT)
	var vp := get_viewport_rect().size
	if vp.x > 0.0 and vp.y > 0.0:
		size = vp
	resized.connect(_fit)
	if not get_viewport().size_changed.is_connected(_fit):
		get_viewport().size_changed.connect(_fit)
	_build()
	if session != null:
		session.changed.connect(_refresh)
		session.fx.connect(_on_fx)
		session.finished.connect(_on_finished)
		session.notice.connect(_toast)
	_refresh()


func _build() -> void:
	var bg := ColorRect.new()
	bg.color = U.BG
	bg.set_anchors_preset(Control.PRESET_FULL_RECT)
	bg.mouse_filter = Control.MOUSE_FILTER_IGNORE
	add_child(bg)

	_frame = Control.new()
	_frame.size = Vector2(DESIGN.x, _vh)
	add_child(_frame)

	_top = Panel.new()
	_top.position = _r_top.position
	_top.size = _r_top.size
	_frame.add_child(_top)

	_banner = Panel.new()
	_banner.position = _r_banner.position
	_banner.size = _r_banner.size
	_frame.add_child(_banner)

	_board = Control.new()
	_board.position = _r_board.position
	_board.size = _r_board.size
	_frame.add_child(_board)

	# 线路表头是静态的，只建一次：这样每帧只重建格子，格子上的动画不会被顺手清掉
	var inner_w := 4.0 * CELL_W + 3.0 * CELL_GAP
	var hx0 := (_r_board.size.x - inner_w) * 0.5
	for i in KPC.LANES.size():
		var lane_name: String = KPC.LANES[i]
		_lab(_board, str(KPC.LANE_NAME.get(lane_name, lane_name)),
			Rect2(hx0 + i * (CELL_W + CELL_GAP), 2, CELL_W, 24), 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)

	_hint = U.label("", 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_hint.position = _r_hint.position
	_hint.size = _r_hint.size
	_frame.add_child(_hint)

	_hand_scroll = ScrollContainer.new()
	_hand_scroll.position = _r_hand.position
	_hand_scroll.size = _r_hand.size
	_hand_scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	_hand_scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_frame.add_child(_hand_scroll)
	_hand_row = HBoxContainer.new()
	_hand_row.add_theme_constant_override("separation", 10)
	_hand_row.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	_hand_scroll.add_child(_hand_row)

	_preview = Control.new()
	_preview.position = _r_preview.position
	_preview.size = _r_preview.size
	_frame.add_child(_preview)

	_action = Control.new()
	_action.position = _r_action.position
	_action.size = _r_action.size
	_frame.add_child(_action)

	_fx_layer = Control.new()
	_fx_layer.size = Vector2(DESIGN.x, _vh)
	_fx_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(_fx_layer)

	_overlay = Control.new()
	_overlay.size = Vector2(DESIGN.x, _vh)
	_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(_overlay)

	_fit()


func _fit() -> void:
	if _frame == null:
		return
	var avail := size
	if avail.x <= 0.0 or avail.y <= 0.0:
		avail = get_viewport_rect().size
	if avail.x <= 0.0 or avail.y <= 0.0:
		avail = DESIGN
	# 宽度撑满：手机屏越窄，界面等比越小；屏够高时纵向多出来的分给战场和手牌
	var s := avail.x / DESIGN.x
	if s <= 0.0 or not is_finite(s):
		s = 1.0
	var h := avail.y / s
	if h < MIN_H:
		# 平板这种「矮宽」屏：按最小高度缩，横向居中
		s = avail.y / MIN_H
		h = MIN_H
	_frame.scale = Vector2(s, s)
	_frame.position = Vector2((avail.x - DESIGN.x * s) * 0.5, 0.0)
	_layout(h)


## 纵向弹性布局：上下固定件从两端往中间排，剩下的高度给战场和手牌
func _layout(h: float) -> void:
	_vh = maxf(h, MIN_H)
	_r_top = Rect2(0, 0, DESIGN.x, 118)
	_r_banner = Rect2(0, _r_top.size.y + 4.0, DESIGN.x, 44.0)
	var board_y := _r_banner.position.y + _r_banner.size.y + 8.0
	var action_h := 96.0
	_r_action = Rect2(0, _vh - action_h - 8.0, DESIGN.x, action_h)
	var preview_h := clampf(_vh * 0.118, 118.0, 172.0)
	_r_preview = Rect2(8, _r_action.position.y - 10.0 - preview_h, DESIGN.x - 16.0, preview_h)
	var hand_h := clampf(_vh * 0.235, 236.0, 336.0)
	_r_hand = Rect2(0, _r_preview.position.y - 8.0 - hand_h, DESIGN.x, hand_h)
	_r_hint = Rect2(8, _r_hand.position.y - 8.0 - 30.0, DESIGN.x - 16.0, 30.0)
	var board_h := maxf(320.0, _r_hint.position.y - 8.0 - board_y)
	_r_board = Rect2(8, board_y, DESIGN.x - 16.0, board_h)
	# 四排单位 + 中间一条陷阱带；多出来的高度让每排变高，并整体居中
	var rows_h := board_h - BOARD_HEADER - 3.0 * CELL_GAP - _trap_band
	_cell_h = clampf(rows_h / 4.0, 84.0, 152.0)
	_rows_y0 = BOARD_HEADER + maxf(0.0, (rows_h - 4.0 * _cell_h) * 0.5)
	if _frame != null:
		_frame.size = Vector2(DESIGN.x, _vh)
	if _fx_layer != null:
		_fx_layer.size = Vector2(DESIGN.x, _vh)
	if _overlay != null:
		_overlay.size = Vector2(DESIGN.x, _vh)
	_apply_layout()


## 把算好的矩形套到已经建出来的节点上：屏幕旋转 / 改变窗口大小时也要跟着变
func _apply_layout() -> void:
	if _top != null:
		_top.position = _r_top.position
		_top.size = _r_top.size
	if _banner != null:
		_banner.position = _r_banner.position
		_banner.size = _r_banner.size
	if _board != null:
		_board.position = _r_board.position
		_board.size = _r_board.size
	if _hint != null:
		_hint.position = _r_hint.position
		_hint.size = _r_hint.size
	if _hand_scroll != null:
		_hand_scroll.position = _r_hand.position
		_hand_scroll.size = _r_hand.size
	if _preview != null:
		_preview.position = _r_preview.position
		_preview.size = _r_preview.size
	if _action != null:
		_action.position = _r_action.position
		_action.size = _r_action.size
	# 格子是按 _cell_h 摆的：高度变了就重排一遍（内容没变会复用节点）
	if _board != null and not _cell_nodes.is_empty() and session != null and session.game != null:
		_refresh()


# ══════════════════════════════════════════════════════════
# 刷新
# ══════════════════════════════════════════════════════════

func _clear(node: Node) -> void:
	for c in node.get_children():
		node.remove_child(c)
		c.queue_free()


func _refresh() -> void:
	if session == null or session.game == null:
		return
	var g = session.game
	var st: Dictionary = g.state
	var me: Dictionary = st.players[session.human_side]
	var foe: Dictionary = st.players[session.ai_side]

	_legal = {}
	for entry in session.legal_plays():
		_legal[int(entry.iid)] = entry
	if _selected_iid >= 0 and not _legal.has(_selected_iid):
		_selected_iid = -1

	_build_top(st, me, foe)
	_build_banner(st)
	_build_board(st)
	_build_hand(me)
	_build_preview(me)
	_build_action(st)
	_build_overlay(st)
	_hint.text = _hint_text(st)

	_after_refresh(st)


func _lab(parent: Node, text: String, rect: Rect2, fs: int, col: Color,
		align: int = HORIZONTAL_ALIGNMENT_LEFT, clip := true) -> Label:
	var l := U.label(text, fs, col, align)
	l.clip_text = clip
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(l)
	# 先入树再定尺寸：Label 还没算过最小尺寸时设 size 会被「文字原宽」钳住，
	# 于是 88 宽的框变成 109 宽跑出卡面（这就是作者看到的文字出界）
	l.update_minimum_size()
	l.position = rect.position
	l.size = rect.size
	return l


## 用主题字体量一遍文字在给定宽度下的高度，好让面板按内容排版
func _text_h(parent: Control, text: String, width: float, fs: int) -> float:
	var f: Font = parent.get_theme_font("font")
	if f == null:
		return float(fs) * 1.6
	var sz: Vector2 = f.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, width, fs)
	return sz.y


## 把一段文字塞进「宽度 width × 高度 max_h」的框：先试大字号，放不下就降字号，
## 最小字号还放不下就二分找最长能放下的前缀、补省略号。返回 [文字, 字号]。
## wrap=false 按单行量宽（名字那种），wrap=true 按自动换行量高（效果文字）。
func _fit_text(parent: Control, text: String, width: float, sizes: Array, max_h: float,
		wrap: bool) -> Array:
	if text == "":
		return ["", int(sizes[0])]
	var f: Font = parent.get_theme_font("font")
	if f == null or width <= 4.0:
		return [text, int(sizes[0])]
	for sv in sizes:
		var fs := int(sv)
		if wrap:
			if f.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, width, fs).y <= max_h:
				return [text, fs]
		else:
			var w := f.get_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, -1, fs).x
			if w <= width:
				return [text, fs]
	var last := int(sizes[sizes.size() - 1])
	var lo := 0
	var hi := text.length()
	while lo < hi:
		var mid := int((lo + hi + 1) / 2)
		var probe: String = text.substr(0, mid) + "…"
		var ok := false
		if wrap:
			ok = f.get_multiline_string_size(probe, HORIZONTAL_ALIGNMENT_LEFT, width, last).y <= max_h
		else:
			ok = f.get_string_size(probe, HORIZONTAL_ALIGNMENT_LEFT, -1, last).x <= width
		if ok:
			lo = mid
		else:
			hi = mid - 1
	return [text.substr(0, lo) + "…", last]


func _wrap(parent: Node, text: String, rect: Rect2, fs: int, col: Color,
		align: int = HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := U.label(text, fs, col, align)
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(l)
	l.update_minimum_size()
	l.position = rect.position
	l.size = rect.size
	return l


# ── 顶部 HUD ────────────────────────────────────────────────────────────────

## HUD 只在开局建一次，之后原地改文字/血条 —— 每次 _refresh 重建 14 个节点要 6ms，
## 手机上就是「点一下卡半拍」。现在常态刷新降到 0.1ms 级。
func _build_top(st: Dictionary, me: Dictionary, foe: Dictionary) -> void:
	if _top.get_child_count() == 0:
		_top.add_theme_stylebox_override("panel", U.box(U.PANEL, 0))
		_top_refs["me"] = _side_block(_top, 14.0, true)
		_top_refs["foe"] = _side_block(_top, 492.0, false)
		_top_refs["turn"] = _lab(_top, "", Rect2(288, 8, 144, 26), 17, U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
		_top_refs["phase"] = _lab(_top, "", Rect2(288, 34, 144, 34), 22, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
		_top_refs["counts"] = _lab(_top, "", Rect2(288, 70, 144, 20), 12, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
		_top_refs["role"] = _lab(_top, "", Rect2(288, 90, 144, 20), 13, U.FACTION, HORIZONTAL_ALIGNMENT_CENTER)
		var back := Button.new()
		back.text = "‹"
		back.position = Vector2(668, 6)
		back.size = Vector2(44, 44)
		back.add_theme_font_size_override("font_size", 26)
		back.add_theme_stylebox_override("normal", U.box(U.PANEL_HI, 10, U.LINE))
		back.add_theme_stylebox_override("hover", U.box(U.PANEL_HI, 10, U.GOLD))
		back.add_theme_stylebox_override("pressed", U.box(U.PANEL, 10, U.GOLD))
		back.pressed.connect(func(): back_to_home.emit())
		_top.add_child(back)
	_update_side_block(_top_refs["me"], me, true)
	_update_side_block(_top_refs["foe"], foe, false)
	_top_refs["turn"].text = "回合 %d" % int(st.turn)
	_top_refs["phase"].text = _phase_name(str(st.phase))
	_top_refs["counts"].text = "牌库 %d · 弃牌 %d" % [st.deck.size(), st.discard.size()]
	var role := "先手" if int(st.firstPlayer) == session.human_side else "后手"
	_top_refs["role"].text = "你是" + role


func _side_block(parent: Control, x: float, is_me: bool) -> Dictionary:
	var align := HORIZONTAL_ALIGNMENT_LEFT if is_me else HORIZONTAL_ALIGNMENT_RIGHT
	var refs := {}
	refs["align"] = align
	refs["hp_last"] = -999
	refs["name"] = _lab(parent, "", Rect2(x, 8, 206, 24), 16, U.TEXT, align)
	refs["hp"] = _lab(parent, "", Rect2(x, 32, 206, 28), 20, U.GOOD, align)
	refs["bar"] = U.hpbar(1.0, U.GOOD, 12)
	refs["bar"].position = Vector2(x, 64)
	refs["bar"].size = Vector2(206, 12)
	refs["bar"].mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(refs["bar"])
	refs["bits"] = _lab(parent, "", Rect2(x, 82, 206, 22), 13, U.DIM, align)
	return refs


func _update_side_block(refs: Dictionary, p: Dictionary, is_me: bool) -> void:
	var fname := DATA.faction_name(p.get("faction", ""))
	var plain := fname == "中立" or fname == "未选阵营" or fname == ""
	var name_text := "你" if is_me else "对手"
	if not plain:
		name_text += " · " + fname
	if refs["name"].text != name_text:
		refs["name"].text = name_text
		refs["name"].add_theme_color_override("font_color", U.TEXT if plain else U.FACTION)

	var hp := float(p.kingHp)
	var maxhp := maxf(1.0, float(p.kingMaxHp))
	if int(refs["hp_last"]) != int(roundf(hp * 10.0)):
		refs["hp_last"] = int(roundf(hp * 10.0))
		refs["hp"].text = "♥ %s/%s" % [U.num(hp), U.num(maxhp)]
		var col: Color = U.GOOD if hp > maxhp * 0.5 else (U.GOLD if hp > maxhp * 0.2 else U.BAD)
		refs["hp"].add_theme_color_override("font_color", col)
		var bar_col: Color = U.BAD if hp <= maxhp * 0.25 else U.GOOD
		refs["bar"].value = clampf(hp / maxhp, 0.0, 1.0)
		refs["bar"].add_theme_stylebox_override("fill", U.box(bar_col, 6))

	var bits: Array = []
	bits.append("费用 %s/%s" % [U.num(p.mana), U.num(p.manaCap)])
	bits.append("手牌 %d" % p.hand.size())
	if p.get("superpowers", []).size() > 0:
		bits.append("超能力 %d" % p.superpowers.size())
	var bits_text := " · ".join(bits)
	if refs["bits"].text != bits_text:
		refs["bits"].text = bits_text


func _phase_name(phase: String) -> String:
	match phase:
		"TURN_START": return "回合开始"
		"DEPLOY_FIRST": return "先手放置"
		"DEPLOY_SECOND": return "后手放置"
		"SPELL_FIRST": return "先手锦囊"
		"SPELL_SECOND": return "后手锦囊"
		"COMBAT": return "开战结算"
		"TURN_END": return "回合结束"
		_: return "准备中"


func _build_banner(st: Dictionary) -> void:
	_clear(_banner)
	var sb := U.box(U.BG_SOFT, 10, U.LINE)
	_banner.add_theme_stylebox_override("panel", sb)
	var text := ""
	var col := U.DIM
	if _replay() and not session.is_over():
		text = "回放中 · 第 %d 回合 · %s" % [int(st.turn), _phase_name(str(st.phase))]
		col = U.GOLD
	elif session.is_over():
		text = "对局结束 —— %s" % _who_won_text(st)
		col = U.GOLD
	elif session.pending() != null:
		text = "等待你的选择…"
		col = U.FACTION
	elif session.is_my_turn():
		text = "%s · 轮到你行动" % _phase_name(str(st.phase))
		col = U.GOOD
	else:
		text = "%s · 对手行动中" % _phase_name(str(st.phase))
		col = U.DIM
	_lab(_banner, text, Rect2(12, 9, 696, 26), 17, col, HORIZONTAL_ALIGNMENT_CENTER)


func _who_won_text(st: Dictionary) -> String:
	if st.get("winner", null) == null:
		return "尚未结束"
	if int(st.winner) == session.human_side:
		return "你赢了"
	return "你输了"


# ── 战场 ────────────────────────────────────────────────────────────────────

func _cell_rect(lane_i: int, half_i: int) -> Rect2:
	var inner_w := 4.0 * CELL_W + 3.0 * CELL_GAP
	var x0 := (_r_board.size.x - inner_w) * 0.5
	# 前半场两排在上，后半场两排在下，中间留一条陷阱带（作者第 7 条）
	var y := _rows_y0 + half_i * (_cell_h + CELL_GAP)
	if half_i >= 2:
		y += _trap_band
	return Rect2(x0 + lane_i * (CELL_W + CELL_GAP), y, CELL_W, _cell_h)


## 陷阱带里某个槽位的矩形：左半是对手的，右半是自己的
func _trap_rect(lane_i: int, side: int) -> Rect2:
	var inner_w := 4.0 * CELL_W + 3.0 * CELL_GAP
	var x0 := (_r_board.size.x - inner_w) * 0.5
	var slot_w := (CELL_W - 6.0) * 0.5
	var left := side != int(session.human_side)
	var y := _rows_y0 + 2.0 * (_cell_h + CELL_GAP)
	return Rect2(x0 + lane_i * (CELL_W + CELL_GAP) + (0.0 if left else slot_w + 6.0), y, slot_w, _trap_band)


func _build_board(st: Dictionary) -> void:
	var me_side: int = session.human_side
	var my_places: Dictionary = {}
	var picking := _selected_iid >= 0 and _legal.has(_selected_iid)
	if picking:
		for pl in _legal[_selected_iid].get("places", []):
			if pl != null:
				# 键里必须带「哪一方」：front/back 两方同名，只按 lane:row 存会把
				# 对手半场同名的格子也点亮 —— 作者 2026-11-08「只高亮自己方的」。
				my_places["%s:%d:%s" % [pl.lane, me_side, pl.row]] = true

	# 只重建「内容变了」的格子：同一个单位留在同一个格子里时，节点原样保留，
	# 它身上正在跑的补间（进场、受击、抖动）就不会被清空重来。
	var seen: Dictionary = {}
	for i in KPC.LANES.size():
		var lane: String = KPC.LANES[i]
		for h in 4:
			var half: String = HALVES[h]
			var side: int = me_side if half.begins_with("my") else session.ai_side
			var row := "front" if half.ends_with("front") else "back"
			var u = st.board[lane].units[side][row]
			var is_legal := my_places.has("%s:%d:%s" % [lane, side, row])
			var key := "%s:%s" % [lane, half]
			seen[key] = true
			var sig := _cell_signature(u, is_legal)
			var rect := _cell_rect(i, h)
			var node = _cell_nodes.get(key, null)
			if node == null or not is_instance_valid(node) or str(_cell_sig.get(key, "")) != sig:
				if node != null and is_instance_valid(node):
					_board.remove_child(node)
					node.queue_free()
				node = _make_cell(lane, half, row, side, u, is_legal)
				_board.add_child(node)
				_cell_nodes[key] = node
				_cell_sig[key] = sig
			node.position = rect.position
			node.size = rect.size
			node.pivot_offset = rect.size * 0.5
			# 选中手牌时，对方半场整片压暗 —— 不给人「这里也能放」的错觉
			node.modulate = Color(1, 1, 1, 0.55) if picking and side != me_side else Color(1, 1, 1, 1)

	# 陷阱带：4 线 × 2 方 = 8 个槽（作者 m01990 第 7 条「中间有陷阱格子」）
	for i in KPC.LANES.size():
		var lane_t: String = KPC.LANES[i]
		for side in 2:
			var tkey := "trap:%s:%d" % [lane_t, side]
			var trap = st.board[lane_t].traps[side]
			var tsig := "none" if trap == null else "%s|%s" % [str(trap.get("cardId", "")), "1" if trap.get("revealed", false) else "0"]
			seen[tkey] = true
			var tnode = _cell_nodes.get(tkey, null)
			if tnode == null or not is_instance_valid(tnode) or str(_cell_sig.get(tkey, "")) != tsig:
				if tnode != null and is_instance_valid(tnode):
					_board.remove_child(tnode)
					tnode.queue_free()
				tnode = _make_trap_slot(side, trap)
				_board.add_child(tnode)
				_cell_nodes[tkey] = tnode
				_cell_sig[tkey] = tsig
			var trect := _trap_rect(i, side)
			tnode.position = trect.position
			tnode.size = trect.size
			for tc in tnode.get_children():
				if tc is Label:
					tc.size = Vector2(trect.size.x, 14.0)
					tc.position = Vector2(0.0, maxf(1.0, (trect.size.y - 14.0) * 0.5))

	for key in _cell_nodes.keys():
		if not seen.has(key):
			var dead = _cell_nodes[key]
			if is_instance_valid(dead):
				_board.remove_child(dead)
				dead.queue_free()
			_cell_nodes.erase(key)
			_cell_sig.erase(key)


## 格子内容指纹：单位、攻血、词条、是否高亮成绿色可放格 —— 任一项变了才重建
func _cell_signature(u, is_legal: bool) -> String:
	if u == null:
		return "empty|%s" % ("1" if is_legal else "0")
	var desc: Dictionary = session.game.describe_unit(u)
	return "%d|%.2f|%.2f|%.2f|%s|%s|%s" % [int(u.uid), float(desc.atk), float(desc.hp),
		float(desc.maxHp), str(desc.keywords), str(desc.marks), "1" if is_legal else "0"]


func _make_cell(lane: String, half: String, row: String, side: int, u, is_legal: bool) -> Control:
	var cell := Panel.new()
	var mine: bool = side == session.human_side
	var border := U.LINE
	var fill := Color("141a24") if not mine else Color("171d29")
	if is_legal:
		border = U.GOOD
		fill = Color("1b2b23")
	elif u != null:
		border = U.FACTION if mine else Color("5b3b46")
	cell.add_theme_stylebox_override("panel", U.box(fill, 10, border, 2 if is_legal else 1))

	if u == null:
		if is_legal:
			_lab(cell, "+", Rect2(0, 26, CELL_W, 44), 40, U.GOOD, HORIZONTAL_ALIGNMENT_CENTER)
			_lab(cell, "放这里", Rect2(0, 74, CELL_W, 22), 13, U.GOOD, HORIZONTAL_ALIGNMENT_CENTER)
		else:
			_lab(cell, "·", Rect2(0, 40, CELL_W, 26), 18, Color("2c3547"), HORIZONTAL_ALIGNMENT_CENTER)
		U.on_click(cell, func(): _on_cell_click(lane, half))
		return cell

	var desc: Dictionary = session.game.describe_unit(u)
	var atk := float(desc.atk)
	var hp := float(desc.hp)
	var maxhp := maxf(1.0, float(desc.maxHp))
	_lab(cell, str(desc.name), Rect2(8, 4, CELL_W - 16, 22), 14, U.TEXT)
	_lab(cell, "⚔ %s" % U.num(atk), Rect2(8, 28, 78, 30), 20, U.GOLD)
	_lab(cell, "♥ %s" % U.num(hp), Rect2(86, 28, 78, 30), 20,
		U.GOOD if hp >= maxhp else (U.GOLD if hp > maxhp * 0.4 else U.BAD), HORIZONTAL_ALIGNMENT_RIGHT)
	var chips := U.chips_text(desc.keywords, desc.marks)
	if chips != "":
		_wrap(cell, chips, Rect2(8, 60, CELL_W - 16, 42), 11, U.DIM)
	U.on_click(cell, func(): _on_cell_click(lane, half))
	return cell


# ── 手牌 ────────────────────────────────────────────────────────────────────

## 陷阱槽：空槽是一圈虚边，有陷阱时画成盖牌（自己的看得见金边，对手的是「?」）
func _make_trap_slot(side: int, trap) -> Control:
	var p := Panel.new()
	p.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var mine := side == int(session.human_side)
	var has := trap != null
	var fill := (U.PANEL_HI if mine else U.PANEL) if has else Color(0, 0, 0, 0.16)
	var line := (U.GOLD if mine else U.BAD) if has else Color(U.LINE, 0.38)
	p.add_theme_stylebox_override("panel", U.box(fill, 5, line, 1))
	var txt := "陷阱" if not has else ("陷阱" if mine else "?")
	var col := Color(U.DIM, 0.42) if not has else (U.GOLD if mine else U.BAD)
	var l := U.label(txt, 10, col, HORIZONTAL_ALIGNMENT_CENTER)
	p.add_child(l)
	l.update_minimum_size()
	l.position = Vector2(0, 2)
	l.size = Vector2(80, 16)
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	return p


func _build_hand(me: Dictionary) -> void:
	var hand: Array = me.hand
	# 作者第 9 条：正排最多 6 张，多出来的折成右侧「+N」堆，点一下展开。
	if hand.size() <= FOLD_AT:
		_hand_expanded = false
	var folded: bool = hand.size() > FOLD_AT and not _hand_expanded
	var shown: Array = hand
	if folded:
		shown = hand.slice(0, FOLD_AT)
	# 一手牌尽量铺满宽度不出现横向滚动；展开后（或牌很少）交给 ScrollContainer
	var n := maxf(1.0, float(shown.size()))
	var cw := clampf((_r_hand.size.x - 36.0 - 8.0 * (n - 1.0)) / n, 96.0, 152.0)

	# 按 iid 复用旧节点：只是「可不可出 / 有没有选中」变了就重画那一张，
	# 其余牌原样留着 —— 抽牌、出牌时其它牌不会整体闪一下。
	var have: Dictionary = {}
	for c in _hand_row.get_children():
		if not c.has_meta("iid"):
			continue
		have[int(c.get_meta("iid", -1))] = c
	var ordered: Array = []
	_hand_added = []
	for hc in shown:
		var iid := int(hc.iid)
		var card_id := str(hc.cardId)
		var entry = _legal.get(iid, null)
		var cost := float(entry.cost) if entry != null else float(DATA.card(card_id).get("cost", 0))
		var sig := "%s|%s|%s|%s" % [card_id, "1" if entry != null else "0", U.num(cost),
			"1" if iid == _selected_iid else "0"]
		var node = have.get(iid, null)
		if node != null and is_instance_valid(node) and str(node.get_meta("sig", "")) == sig:
			have.erase(iid)
			node.modulate = Color(1, 1, 1, 1) if entry != null else Color(1, 1, 1, 0.62)
			ordered.append(node)
			continue
		if node != null and is_instance_valid(node):
			if node.get_parent() == _hand_row:
				_hand_row.remove_child(node)
			node.queue_free()
			have.erase(iid)
		node = _make_hand_card(iid, card_id, entry, cw)
		node.set_meta("iid", iid)
		node.set_meta("sig", sig)
		if not _prev_hand.has(iid):
			_hand_added.append(iid)
		_hand_row.add_child(node)
		ordered.append(node)

	for iid in have.keys():
		var stale = have[iid]
		if is_instance_valid(stale):
			if stale.get_parent() == _hand_row:
				_hand_row.remove_child(stale)
			stale.queue_free()

	for i in ordered.size():
		_hand_row.move_child(ordered[i], i)

	_refresh_fold_chip(hand.size(), folded, float(ordered.size()), cw)


## 折叠堆：「+N 点开看」/「收起」，永远排在最后。作者第 9 条。
func _refresh_fold_chip(total: int, folded: bool, shown_n: float, cw: float) -> void:
	if _fold_chip != null and is_instance_valid(_fold_chip):
		if _fold_chip.get_parent() == _hand_row:
			_hand_row.remove_child(_fold_chip)
		_fold_chip.queue_free()
	_fold_chip = null
	if total <= FOLD_AT:
		return
	var ch := roundf(cw * 1.4)
	var chip := Panel.new()
	chip.custom_minimum_size = Vector2(64, ch)
	var border: Color = U.GOLD if folded else U.LINE
	chip.add_theme_stylebox_override("panel", U.box(Color("1b2230"), 12, border, 1))
	var head_text := "+%d" % (total - int(shown_n)) if folded else "收起"
	_lab(chip, head_text, Rect2(0, ch * 0.5 - 26.0, 64, 40), 24, U.GOLD if folded else U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(chip, "点开看" if folded else "折回去", Rect2(0, ch * 0.5 + 10.0, 64, 20), 11, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_fold_chip = chip
	_hand_row.add_child(chip)
	U.on_click(chip, func():
		_hand_expanded = folded
		_clear_drag()
		_refresh())


func _make_hand_card(iid: int, card_id: String, legal_entry, cw: float = 152.0) -> Control:
	var def := DATA.card(card_id)
	var ch := roundf(cw * 1.4)
	var card := Panel.new()
	card.custom_minimum_size = Vector2(cw, ch)
	var playable := legal_entry != null
	var selected := iid == _selected_iid
	var border := U.GOLD if selected else (U.GOOD if playable else U.LINE)
	card.add_theme_stylebox_override("panel", U.box(Color("1b2230") if playable else Color("151a23"), 12, border, 3 if selected else 1))
	if not playable:
		card.modulate = Color(1, 1, 1, 0.62)

	var cost := float(legal_entry.cost) if playable else float(def.get("cost", 0))
	var cost_badge := Panel.new()
	cost_badge.position = Vector2(8, 8)
	cost_badge.size = Vector2(34, 34)
	cost_badge.add_theme_stylebox_override("panel", U.box(U.MANA.darkened(0.35), 17, U.MANA))
	cost_badge.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_child(cost_badge)
	_lab(cost_badge, U.num(cost), Rect2(0, 4, 34, 26), 19, Color("dce9ff"), HORIZONTAL_ALIGNMENT_CENTER)

	var inner := cw - 20.0
	# 名字：15px 放不下就降到 14/13/12，再放不下就截断加省略号（原来直接硬裁）
	var name_w := cw - 54.0
	var nf := _fit_text(card, str(def.get("name", card_id)), name_w, [15, 14, 13, 12], 26.0, false)
	_lab(card, str(nf[0]), Rect2(46, 12, name_w, 26), int(nf[1]), U.TEXT)

	var kind := "单位"
	var stat_line := ""
	if str(def.get("type", "")) == "spell":
		kind = "锦囊"
	else:
		stat_line = "  ⚔%s ♥%s" % [U.num(def.get("atk", 0)), U.num(def.get("hp", 0))]
	_lab(card, kind + stat_line, Rect2(10, 46, inner, 22), 12, U.DIM)

	# 词条先量出真实高度占好位置，效果文字只吃剩下的那一段 ——
	# 原来效果框写到 70+133=203、词条又画在 181，两框重叠 22px，字就压到卡面外了。
	var kws: Array = def.get("keywords", [])
	var kw_text := ""
	if kws.size() > 0:
		var names: Array = []
		for k in kws:
			names.append(DATA.keyword_name(k))
		kw_text = " · ".join(names)
	var kw_h := 0.0
	if kw_text != "":
		var kh := _text_h(card, kw_text, inner, 10)
		if kh > 34.0:
			var kf := _fit_text(card, kw_text, inner, [10], 34.0, true)
			kw_text = str(kf[0])
			kh = _text_h(card, kw_text, inner, 10)
		kw_h = clampf(kh + 2.0, 14.0, 36.0)

	var text_top := 70.0
	var text_bottom := ch - 8.0 - (kw_h + 3.0 if kw_text != "" else 0.0)
	var text_max := maxf(24.0, text_bottom - text_top)
	var body := _fit_text(card, str(def.get("text", "")), inner, [11, 10], text_max, true)
	_wrap(card, str(body[0]), Rect2(10, text_top, inner, text_max), int(body[1]), Color("c3cde0"))
	if kw_text != "":
		_wrap(card, kw_text, Rect2(10, ch - 8.0 - kw_h, inner, kw_h), 10, U.GOLD)
	_wire_hand_input(card, iid)
	return card


func _build_preview(me: Dictionary) -> void:
	_clear(_preview)
	var def: Dictionary = {}
	var title := ""
	if _selected_iid >= 0:
		for hc in me.hand:
			if int(hc.iid) == _selected_iid:
				def = DATA.card(str(hc.cardId))
				title = "已选中：%s" % str(def.get("name", ""))
	else:
		_lab(_preview, "点手牌选中，再点发绿光的地块放下；锦囊牌点一下直接打出。", Rect2(4, 44, 696, 24), 14, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
		return
	var box := Panel.new()
	box.position = Vector2(0, 0)
	box.size = _r_preview.size
	box.add_theme_stylebox_override("panel", U.box(U.BG_SOFT, 12, U.GOLD))
	box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_preview.add_child(box)
	_lab(box, title, Rect2(14, 8, 676, 24), 16, U.GOLD)
	_wrap(box, str(def.get("text", "")), Rect2(14, 34, 676, 60), 13, Color("c3cde0"))
	var kws: Array = def.get("keywords", [])
	if kws.size() > 0:
		var names: Array = []
		for k in kws:
			names.append("%s（%s）" % [DATA.keyword_name(k), DATA.keyword_note(k)])
		_wrap(box, " · ".join(names), Rect2(14, 96, 676, 48), 11, U.DIM)


# ── 底部按钮 ────────────────────────────────────────────────────────────────

func _build_action(st: Dictionary) -> void:
	_clear(_action)
	if _replay():
		_action.add_child(_big_button("退出回放", Rect2(12, 12, 236, 72), true, func(): back_to_home.emit()))
		_action.add_child(_big_button("自动播放中", Rect2(260, 12, 200, 72), false, func(): pass))
		_action.add_child(_big_button("返回首页", Rect2(472, 12, 170, 72), true, func(): back_to_home.emit()))
		var rtip := "这一局按录下来的动作重演" if not session.is_over() else "回放结束"
		_lab(_action, rtip, Rect2(12, 84, 640, 22), 12, U.DIM, HORIZONTAL_ALIGNMENT_RIGHT)
		return
	var can_end: bool = session.is_my_turn()
	_action.add_child(_big_button("结束阶段", Rect2(12, 12, 236, 72), can_end, func(): _end_phase()))
	_action.add_child(_big_button("认输", Rect2(260, 12, 150, 72), not session.is_over(), func(): session.surrender()))
	_action.add_child(_big_button("返回首页", Rect2(422, 12, 170, 72), true, func(): back_to_home.emit()))
	var tip := "本轮已出牌 %d 张" % int(st.stats.get("cardsPlayed", 0))
	_lab(_action, tip, Rect2(604, 34, 108, 24), 12, U.DIM, HORIZONTAL_ALIGNMENT_RIGHT)


func _big_button(text: String, rect: Rect2, enabled: bool, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.position = rect.position
	b.size = rect.size
	b.disabled = not enabled
	b.add_theme_font_size_override("font_size", 20)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_color_override("font_disabled_color", Color("5d677d"))
	var fill := U.PANEL_HI if enabled else Color("171c26")
	b.add_theme_stylebox_override("normal", U.box(fill, 12, U.LINE))
	b.add_theme_stylebox_override("hover", U.box(U.PANEL_HI.lightened(0.08), 12, U.GOLD))
	b.add_theme_stylebox_override("pressed", U.box(U.PANEL, 12, U.GOLD))
	b.add_theme_stylebox_override("disabled", U.box(fill, 12, Color("2a3242")))
	b.pressed.connect(cb)
	return b


func _hint_text(st: Dictionary) -> String:
	if session.is_over():
		return str(st.get("winReason", ""))
	if session.pending() != null:
		return "在下面的面板里选一项"
	if not session.is_my_turn():
		return "对手正在行动…"
	var allowed: String = session.phase_allow_type()
	if allowed == "unit":
		return "放置阶段：点手牌选中，再点绿色地块"
	if allowed == "spell":
		return "锦囊阶段：点手牌直接打出"
	return "点「结束阶段」继续"


# ══════════════════════════════════════════════════════════
# 输入
# ══════════════════════════════════════════════════════════

# ── 拖拽出牌 ────────────────────────────────────────────────────────────────

## 手牌自己接管按下/拖动/松开：短按 = 原来的点击，长按或拖出 = 出牌拖拽
func _wire_hand_input(card: Control, iid: int) -> void:
	card.mouse_filter = Control.MOUSE_FILTER_STOP
	card.gui_input.connect(_on_hand_gui_input.bind(iid, card))


func _on_hand_gui_input(ev: InputEvent, iid: int, node: Control) -> void:
	if ev is InputEventMouseButton and ev.button_index == MOUSE_BUTTON_LEFT:
		if ev.pressed:
			node.accept_event()
			if _busy_anim or session.is_over():
				return
			_press_iid = iid
			_press_node = node
			_press_at = Time.get_ticks_msec()
			_press_pos = _to_frame(node, ev.position)
			_pointer = _press_pos
			U.press_fx(node, true)
		else:
			node.accept_event()
			var was_press := _press_iid == iid
			if _drag_iid >= 0 and _drag_iid == iid:
				_end_drag(_to_frame(node, ev.position))
			elif was_press:
				var held := Time.get_ticks_msec() - _press_at
				_press_iid = -1
				_press_node = null
				U.press_fx(node, false)
				if held < 260:
					_on_card_click(iid, node)
		return
	if ev is InputEventMouseMotion and _press_iid == iid:
		_pointer = _to_frame(node, ev.position)
		if _drag_iid < 0 and (Time.get_ticks_msec() - _press_at >= 260 or _pointer.distance_to(_press_pos) > 18.0):
			_begin_drag()


func _process(_dt: float) -> void:
	# 长按计时（按住不动也算）：到点就把牌提起来
	if _press_iid >= 0 and _drag_iid < 0 and Time.get_ticks_msec() - _press_at >= 260:
		_begin_drag()
	if _drag_iid >= 0 and _drag_ghost != null and is_instance_valid(_drag_ghost):
		_drag_ghost.position = _pointer - _drag_grab


func _to_frame(node: Control, local: Vector2) -> Vector2:
	var inv := _frame.get_global_transform().affine_inverse()
	return inv * (node.get_global_transform() * local)


func _begin_drag() -> void:
	var iid := _press_iid
	if iid < 0:
		return
	if not is_instance_valid(_press_node) or _busy_anim or session.is_over() or not session.is_my_turn():
		_press_iid = -1
		_press_node = null
		return
	var entry = _legal.get(iid, null)
	if entry == null:
		_press_iid = -1
		_press_node = null
		return
	_drag_iid = iid
	_drag_src = _press_node
	_press_iid = -1
	var card_id := _card_id_of(iid)
	var t: Dictionary = session.drag_targets(card_id)
	_drag_uids = t.get("uids", [])
	_drag_king = bool(t.get("king", false))

	var src := _node_rect_in_fx(_press_node)
	var ghost: Control = _press_node.duplicate()
	ghost.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ghost.z_index = 30
	ghost.size = src.size
	ghost.pivot_offset = src.size * 0.5
	ghost.scale = Vector2(1.08, 1.08)
	ghost.position = src.position
	ghost.modulate = Color(1, 1, 1, 1)
	_fx_layer.add_child(ghost)
	_drag_ghost = ghost
	_drag_grab = _pointer - src.position
	_press_node.modulate.a = 0.25
	_highlight_targets()


## 拖动时把「能落到的地方」点亮：单位牌 = 合法空格，指向性锦囊 = 可选目标（含敌方国王）
func _highlight_targets() -> void:
	var entry = _legal.get(_drag_iid, null)
	if entry == null:
		return
	for pl in entry.get("places", []):
		if pl == null:
			continue
		var li: int = KPC.LANES.find(str(pl.lane))
		var hi := 2 if str(pl.row) == "front" else 3
		var node = _cell_nodes.get("%s:%s" % [pl.lane, HALVES[hi]], null)
		if node != null and is_instance_valid(node):
			_add_mark(node, Rect2(Vector2.ZERO, node.size))
	for i in KPC.LANES.size():
		for h in [0, 1]:
			var key := "%s:%s" % [KPC.LANES[i], HALVES[h]]
			var node = _cell_nodes.get(key, null)
			if node == null or not is_instance_valid(node):
				continue
			var u = session.game.state.board[KPC.LANES[i]].units[int(session.ai_side)]["front" if h == 1 else "back"]
			if u != null and _drag_uids.has(int(u.uid)):
				_add_mark(node, Rect2(Vector2.ZERO, node.size))
	if _drag_king:
		_add_mark(_top, Rect2(486, 4, 218, 104))


func _add_mark(parent: Control, rect: Rect2) -> void:
	var hi := Panel.new()
	hi.position = rect.position
	hi.size = rect.size
	hi.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hi.add_theme_stylebox_override("panel", U.box(Color(0, 0, 0, 0), 10, U.GOLD, 3))
	hi.modulate.a = 0.0
	parent.add_child(hi)
	var tw := hi.create_tween()
	tw.tween_property(hi, "modulate:a", 0.9 if rect.size != Vector2.ZERO else 0.9, _t(0.1))
	_drag_marks.append(hi)


func _clear_drag() -> void:
	for m in _drag_marks:
		if is_instance_valid(m):
			m.queue_free()
	_drag_marks.clear()
	if _drag_ghost != null and is_instance_valid(_drag_ghost):
		_drag_ghost.queue_free()
	_drag_ghost = null
	if _drag_src != null and is_instance_valid(_drag_src):
		_drag_src.modulate.a = 1.0
	_drag_src = null
	_drag_iid = -1
	_drag_uids = []
	_drag_king = false


## 松手：看落点决定这一手怎么打。返回之前一定要 _clear_drag()
func _end_drag(p: Vector2) -> void:
	var iid := _drag_iid
	if iid < 0:
		return
	var entry = _legal.get(iid, null)
	var hit := _drop_hit(p)
	var opts := {}
	var ok := false
	if entry != null:
		var hit_uid := int(hit.get("uid", -1))
		if hit.get("kind") == "cell" and hit_uid >= 0 and _drag_uids.has(hit_uid):
			opts = {"targetUid": hit_uid}
			ok = true
		elif hit.get("kind") == "king" and _drag_king:
			opts = {"targetKing": true, "targetKingSide": int(session.ai_side)}
			ok = true
		elif hit.get("kind") == "cell" and int(hit.get("side", -1)) == int(session.human_side):
			for pl in entry.get("places", []):
				if pl != null and str(pl.lane) == str(hit.get("lane", "")) and str(pl.row) == str(hit.get("row", "")):
					opts = {"lane": str(pl.lane), "row": str(pl.row)}
					ok = true
		if not ok and _drag_uids.is_empty() and not _drag_king:
			var places: Array = entry.get("places", [])
			if places.size() == 1 and places[0] == null:
				opts = {}
				ok = true
	_clear_drag()
	if not ok:
		_toast("这里放不了这张牌")
		return
	_selected_iid = -1
	_play_with_anim(iid, opts, null)


## 落点：设计稿坐标 → 格子 / 敌方国王 / 空地
func _drop_hit(p: Vector2) -> Dictionary:
	var bp := p - _board.position
	for i in KPC.LANES.size():
		for h in 4:
			if _cell_rect(i, h).has_point(bp):
				var half: String = HALVES[h]
				var side: int = int(session.human_side) if half.begins_with("my") else int(session.ai_side)
				var row := "front" if half.ends_with("front") else "back"
				var u = session.game.state.board[KPC.LANES[i]].units[side][row]
				return {"kind": "cell", "lane": KPC.LANES[i], "row": row, "side": side,
					"uid": int(u.uid) if u != null else -1}
	if Rect2(486, 4, 218, 104).has_point(p):
		return {"kind": "king"}
	return {"kind": "none"}


func _on_card_click(iid: int, from: Control = null) -> void:
	if _busy_anim or _replay():
		return
	if session.is_over():
		return
	if not session.is_my_turn():
		_open_detail_card(_card_id_of(iid))
		return
	var entry = _legal.get(iid, null)
	if entry == null:
		_toast("这张锦囊没有可选目标" if _no_target(iid) else "现在打不出这张牌")
		_open_detail_card(_card_id_of(iid))
		return
	if _selected_iid == iid:
		_open_detail_card(_card_id_of(iid))
		return
	var places: Array = entry.get("places", [])
	if places.size() == 1 and places[0] == null:
		_selected_iid = -1
		_play_with_anim(iid, {}, from)
		return
	_selected_iid = iid
	_refresh()


## 指向性锦囊但场上没有合法目标（作者 2026-11-08：这种牌根本不能打）
func _no_target(iid: int) -> bool:
	var g = session.game
	if g == null:
		return false
	var def = g.state.cardLib.get(_card_id_of(iid), null)
	if def == null:
		return false
	return not g.spell_target_ok(int(session.human_side), def)


func _on_cell_click(lane: String, half: String) -> void:
	if _busy_anim:
		return
	# 手里选着要放的牌时，对方半场不接受落点（作者 2026-11-08：只能选自己方的）
	if _selected_iid >= 0 and _legal.has(_selected_iid) and half.begins_with("foe"):
		return
	if _replay():
		var uu = session.game.state.board[lane].units[int(session.human_side) if half.begins_with("my") else int(session.ai_side)]["front" if half.ends_with("front") else "back"]
		if uu != null:
			_open_detail_unit(int(uu.uid))
		return
	var row := "front" if half.ends_with("front") else "back"
	var side: int = session.human_side if half.begins_with("my") else session.ai_side
	var u = session.game.state.board[lane].units[side][row]

	if _selected_iid >= 0 and _legal.has(_selected_iid):
		for pl in _legal[_selected_iid].get("places", []):
			if pl != null and str(pl.lane) == lane and str(pl.row) == row:
				var iid := _selected_iid
				_selected_iid = -1
				_play_with_anim(iid, {"lane": lane, "row": row}, _hand_node_of(iid))
				return
	if u != null:
		_open_detail_unit(int(u.uid))
	elif _selected_iid >= 0:
		_toast("这张牌放不进这一格")


func _card_id_of(iid: int) -> String:
	for hc in session.my_hand():
		if int(hc.iid) == iid:
			return str(hc.cardId)
	return ""


# ══════════════════════════════════════════════════════════
# 浮层：提问 / 详情 / 终局
# ══════════════════════════════════════════════════════════

func _build_overlay(st: Dictionary) -> void:
	_overlay.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_clear(_overlay)
	var pending = session.pending()
	var key := ""
	if pending != null:
		key = "choice|%s|%s" % [str(pending.get("type", "")), str(pending.get("prompt", ""))]
	elif _detail_card != "":
		key = "detail-card|" + _detail_card
	elif _detail_uid >= 0:
		key = "detail-unit|%d" % _detail_uid
	elif session.is_over():
		key = "result"
	var fresh := key != _overlay_key
	_overlay_key = key
	if pending != null and not _replay():
		_build_choice(pending)
	elif _detail_card != "" or _detail_uid >= 0:
		_build_detail()
	elif session.is_over():
		_build_result(st)
	# 只有内容换了才播弹出：状态刷新导致的重复重建不该让面板抖一下
	if fresh and key != "":
		for c in _overlay.get_children():
			if c is Panel:
				_pop_in(c)


func _dim_full() -> ColorRect:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.5)
	dim.position = Vector2.ZERO
	dim.size = Vector2(DESIGN.x, _vh)
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	if _anim_on():
		dim.modulate.a = 0.0
	_overlay.add_child(dim)
	if _anim_on():
		var tw := dim.create_tween()
		tw.tween_property(dim, "modulate:a", 1.0, _t(0.16))
	_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	return dim


func _build_choice(req: Dictionary) -> void:
	_dim_full()
	var opts: Array = req.get("options", [])
	var shown := maxi(1, mini(opts.size(), 10))
	var h := clampf(78.0 + float(shown) * 66.0 + 16.0, 210.0, 760.0)
	var panel := Panel.new()
	panel.size = Vector2(640, h)
	panel.position = Vector2(40, _vh - h - 30)
	panel.add_theme_stylebox_override("panel", U.box(Color("161c27"), 18, U.GOLD, 2))
	_overlay.add_child(panel)

	var prompt := str(req.get("prompt", ""))
	if prompt == "":
		prompt = _default_prompt(str(req.get("type", "")))
	_lab(panel, prompt, Rect2(20, 16, 600, 30), 19, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	if opts.size() > 1:
		_lab(panel, "共 %d 个选项，点一个确认" % opts.size(), Rect2(20, 48, 600, 22), 12, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)

	var scroll := ScrollContainer.new()
	scroll.position = Vector2(20, 78)
	scroll.size = Vector2(600, h - 100)
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	panel.add_child(scroll)
	var box := VBoxContainer.new()
	box.add_theme_constant_override("separation", 8)
	box.custom_minimum_size = Vector2(586, 0)
	scroll.add_child(box)

	if opts.is_empty():
		box.add_child(_option_button("确定", func(): session.answer_choice({})))
	for i in opts.size():
		var opt: Dictionary = opts[i]
		var text := str(opt.get("label", _option_fallback_label(opt, i)))
		var answer := opt.duplicate()
		answer.erase("label")
		answer.erase("choose")
		box.add_child(_option_button(text, func(): session.answer_choice(answer)))


func _option_button(text: String, cb: Callable) -> Button:
	var b := Button.new()
	b.text = text
	b.custom_minimum_size = Vector2(586, 58)
	b.add_theme_font_size_override("font_size", 17)
	b.add_theme_color_override("font_color", U.TEXT)
	b.add_theme_stylebox_override("normal", U.box(U.PANEL, 10, U.LINE))
	b.add_theme_stylebox_override("hover", U.box(U.PANEL_HI, 10, U.GOLD))
	b.add_theme_stylebox_override("pressed", U.box(U.BG_SOFT, 10, U.GOLD))
	b.pressed.connect(cb)
	return b


func _option_fallback_label(opt: Dictionary, i: int) -> String:
	if opt.has("lane") and opt.has("row"):
		return "%s · %s" % [str(KPC.LANE_NAME.get(str(opt.lane), str(opt.lane))),
			str(KPC.ROW_NAME.get(str(opt.row), str(opt.row)))]
	if opt.has("lane"):
		return str(KPC.LANE_NAME.get(str(opt.lane), str(opt.lane)))
	if opt.has("king"):
		return "敌方国王"
	if opt.has("cardId"):
		return str(DATA.card(opt.cardId).get("name", opt.cardId))
	if opt.has("uid"):
		return "单位 %d" % int(opt.uid)
	return "选项%d" % (i + 1)


func _default_prompt(t: String) -> String:
	match t:
		"chooseUnit": return "选择一个单位"
		"chooseEnemyTarget": return "选择目标"
		"chooseLane": return "选择一条线路"
		"chooseHandCard": return "选择一张手牌"
		"chooseOption": return "选择一项"
		"chooseKeyword": return "选择一个词条"
		"chooseRawMaterial": return "选择一张原料"
		"summonCell": return "选择召唤位置"
		"combatTarget": return "选择攻击目标"
		_: return "请选择"


func _open_detail_card(card_id: String) -> void:
	if card_id == "":
		return
	_detail_card = card_id
	_detail_uid = -1
	_refresh()


func _open_detail_unit(uid: int) -> void:
	_detail_card = ""
	_detail_uid = uid
	_refresh()


func _close_detail() -> void:
	_detail_card = ""
	_detail_uid = -1
	_refresh()


func _build_detail() -> void:
	_dim_full()
	var body: Dictionary = {}
	var title := ""
	var subtitle := ""
	if _detail_uid >= 0:
		var u = session.game.find_unit(_detail_uid)
		if u == null:
			_close_detail()
			return
		var desc: Dictionary = session.game.describe_unit(u)
		body = DATA.card(desc.cardId)
		title = str(desc.name)
		subtitle = "%s · %s · %s" % [
			KPC.LANE_NAME.get(str(desc.lane), str(desc.lane)),
			KPC.ROW_NAME.get(str(desc.row), str(desc.row)),
			"你" if int(desc.side) == session.human_side else "对手"]
	else:
		body = DATA.card(_detail_card)
		title = str(body.get("name", _detail_card))
		var kind := "锦囊" if str(body.get("type", "")) == "spell" else "单位"
		subtitle = "%s · 费用 %s" % [kind, U.num(body.get("cost", 0))]

	var stat := ""
	if str(body.get("type", "")) == "unit":
		stat = "⚔ %s    ♥ %s" % [U.num(body.get("atk", 0)), U.num(body.get("hp", 0))]

	var panel := Panel.new()
	panel.size = Vector2(600, 400)
	panel.position = Vector2(60, 40)
	panel.add_theme_stylebox_override("panel", U.box(Color("161c27"), 18, U.GOLD, 2))
	_overlay.add_child(panel)

	var y := 20.0
	_lab(panel, title, Rect2(24, y, 552, 36), 26, U.GOLD)
	y += 38.0
	_lab(panel, subtitle, Rect2(24, y, 552, 24), 14, U.DIM)
	y += 28.0
	if stat != "":
		_lab(panel, stat, Rect2(24, y, 552, 30), 20, U.TEXT)
		y += 32.0
	y += 10.0

	_lab(panel, "效果", Rect2(24, y, 552, 24), 15, U.FACTION)
	y += 26.0
	var eff := str(body.get("text", ""))
	if eff.strip_edges() == "":
		eff = "（无文本）"
	var eff_h := maxf(26.0, _text_h(panel, eff, 552.0, 15) + 6.0)
	_wrap(panel, eff, Rect2(24, y, 552, eff_h), 15, Color("d3dbeb"))
	y += eff_h + 14.0

	var kws: Array = body.get("keywords", [])
	_lab(panel, "词条", Rect2(24, y, 552, 24), 15, U.FACTION)
	y += 26.0
	if kws.is_empty():
		_lab(panel, "（无）", Rect2(24, y, 552, 22), 13, U.DIM)
		y += 26.0
	else:
		for k in kws:
			var kline := "%s —— %s" % [DATA.keyword_name(k), DATA.keyword_note(k)]
			var kh := maxf(20.0, _text_h(panel, kline, 552.0, 13) + 4.0)
			_wrap(panel, kline, Rect2(24, y, 552, kh), 13, Color("c3cde0"))
			y += kh + 6.0

	if _detail_uid >= 0:
		var u2 = session.game.find_unit(_detail_uid)
		if u2 != null:
			var desc2: Dictionary = session.game.describe_unit(u2)
			y += 6.0
			_lab(panel, "当前战场数值", Rect2(24, y, 552, 24), 15, U.FACTION)
			y += 26.0
			_lab(panel, "攻击 %s（基础 %s）   生命 %s/%s" % [
				U.num(desc2.atk), U.num(desc2.baseAtk), U.num(desc2.hp), U.num(desc2.maxHp)],
				Rect2(24, y, 552, 26), 16, U.TEXT)
			y += 30.0

	var ph := clampf(y + 76.0, 300.0, 900.0)
	panel.size = Vector2(600, ph)
	panel.position = Vector2(60, maxf(40.0, (_vh - ph) * 0.5))
	var close := _big_button("关闭", Rect2(190, ph - 72, 220, 56), true, func(): _close_detail())
	panel.add_child(close)


func _build_result(st: Dictionary) -> void:
	_dim_full()
	var won: bool = int(st.get("winner", -1)) == session.human_side
	var panel := Panel.new()
	panel.size = Vector2(620, 460)
	panel.position = Vector2(50, 340)
	panel.add_theme_stylebox_override("panel", U.box(Color("161c27"), 20, U.GOLD if won else U.BAD, 2))
	_overlay.add_child(panel)

	_lab(panel, "胜利" if won else "败北", Rect2(0, 34, 620, 70), 46,
		U.GOLD if won else U.BAD, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(panel, str(st.get("winReason", "")), Rect2(30, 116, 560, 60), 17, U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(panel, "第 %d 回合结束 · 国王 %s/%s" % [
		int(st.turn), U.num(st.players[session.human_side].kingHp), U.num(st.players[session.human_side].kingMaxHp)],
		Rect2(30, 186, 560, 26), 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(panel, "你出牌 %d 张 · 击破对手单位 %d 个" % [
		int(st.stats.get("cardsPlayed", 0)), int(st.stats.get("killsBySide", [0, 0])[session.human_side])],
		Rect2(30, 214, 560, 26), 14, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)

	var again := _big_button("再来一局", Rect2(60, 300, 240, 76), true, func(): restart_requested.emit())
	panel.add_child(again)
	var home := _big_button("返回首页", Rect2(320, 300, 240, 76), true, func(): back_to_home.emit())
	panel.add_child(home)


func _on_finished() -> void:
	_result_shown = true
	_refresh()


# ══════════════════════════════════════════════════════════
# 演出
# ══════════════════════════════════════════════════════════

## 演出事件先攒着：KPSession 是「fx 先发、changed 后发」，而 changed 会重建节点，
## 所以真正落到界面上的动作要等 _refresh 末尾再做（见 _drain_pending_fx）。
func _on_fx(events: Array) -> void:
	for ev in events:
		_pending_fx.append(ev)


func _half_key(side: int, row: String) -> String:
	var prefix := "my" if side == session.human_side else "foe"
	return "%s_%s" % [prefix, row]


func _cell_center(lane: String, half: String) -> Vector2:
	var node = _cell_nodes.get("%s:%s" % [lane, half], null)
	if node == null:
		return Vector2(DESIGN.x, _vh) * 0.5
	var global_center: Vector2 = node.get_global_rect().get_center()
	return _frame.get_global_transform().affine_inverse() * global_center


func _float_fx(text: String, pos: Vector2, color: Color, fs: int) -> void:
	if text == "":
		return
	var l := U.label(text, fs, color, HORIZONTAL_ALIGNMENT_CENTER)
	l.size = Vector2(200, float(fs + 10))
	l.position = pos - Vector2(100, 20)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	l.modulate = Color(1, 1, 1, 1)
	_fx_layer.add_child(l)
	var tw := l.create_tween()
	tw.set_parallel(true)
	tw.tween_property(l, "position:y", l.position.y - 46.0, 0.75)
	tw.tween_property(l, "modulate:a", 0.0, 0.75).set_delay(0.25)
	tw.chain().tween_callback(func(): l.queue_free())


func _banner_fx(text: String) -> void:
	if text == "":
		return
	var l := U.label(text, 40, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	l.size = Vector2(DESIGN.x, 58)
	l.position = Vector2(0, _vh * 0.42)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	l.pivot_offset = l.size * 0.5
	_fx_layer.add_child(l)
	if not _anim_on():
		l.queue_free()
		return
	# 起手：从 1.18 倍压回原大并淡入；收尾：停 0.4 秒，再上飘淡出
	l.scale = Vector2(1.18, 1.18)
	l.modulate.a = 0.0
	var tw := l.create_tween()
	tw.set_parallel(true)
	tw.tween_property(l, "scale", Vector2.ONE, _t(0.24)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(l, "modulate:a", 1.0, _t(0.18))
	tw.tween_property(l, "position:y", l.position.y - 26.0, _t(1.0)).set_delay(_t(0.35))
	tw.tween_property(l, "modulate:a", 0.0, _t(0.45)).set_delay(_t(0.85))
	tw.chain().tween_callback(func(): l.queue_free())


func _toast(text: String) -> void:
	if text.strip_edges() == "":
		return
	var l := U.label(text, 16, U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
	l.size = Vector2(DESIGN.x - 80, 40)
	l.position = Vector2(40, _vh - 220)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	var bg := U.box(Color(0, 0, 0, 0.75), 12, U.LINE)
	var holder := Panel.new()
	holder.size = l.size
	holder.position = l.position
	holder.mouse_filter = Control.MOUSE_FILTER_IGNORE
	holder.add_theme_stylebox_override("panel", bg)
	holder.add_child(l)
	l.position = Vector2.ZERO
	_fx_layer.add_child(holder)
	var tw := holder.create_tween()
	tw.tween_property(holder, "modulate:a", 0.0, 1.0).set_delay(1.2)
	tw.tween_callback(func(): holder.queue_free())


# ══════════════════════════════════════════════════════════
# 动画：起手、飞行、落地、受击、阵亡
# ══════════════════════════════════════════════════════════
#
# 设计原则：
# 1. 每个动作都要有「起手 → 过程 → 落地」三段，不能凭空出现、凭空消失；
# 2. 规则永远先跑，动画只跟着状态走（唯一的例外是出牌飞行，因为要让牌先飞到
#    格子再落地，玩家看到的是「牌变成单位」，而不是「手牌没了 + 单位冒出来」）；
# 3. 格子与手牌节点按内容签名复用，动画跑一半不会被刷新清掉。

func _replay() -> bool:
	return session != null and session.replay_mode


func _anim_on() -> bool:
	return anim > 0.001


## 动画时长缩放：anim 是速度倍率（0 关掉，1 正常，2 加快速）
func _t(sec: float) -> float:
	return maxf(0.001, sec * anim)


# ── 刷新后：进场 / 阵亡 / 抽牌 / 积压的演出事件 ──────────────────────────────

func _after_refresh(st: Dictionary) -> void:
	var now := _unit_snapshot(st)
	if _first_paint:
		_prev_units = now
		_prev_hand = _hand_iids()
		_first_paint = false
		_pending_fx.clear()
		_last_selected = _selected_iid
		return

	_animate_diff(now)
	_prev_units = now
	_prev_hand = _hand_iids()
	_drain_pending_fx()

	if _selected_iid != _last_selected and _selected_iid >= 0:
		var picked = _hand_node_of(_selected_iid)
		if picked != null:
			_punch(picked, 1.06, 0.16)
	_last_selected = _selected_iid


func _hand_iids() -> Array:
	var out: Array = []
	for hc in session.my_hand():
		out.append(int(hc.iid))
	return out


func _unit_snapshot(st: Dictionary) -> Dictionary:
	var out := {}
	for lane in KPC.LANES:
		for side in 2:
			for row in KPC.ROWS:
				var u = st.board[lane].units[side][row]
				if u == null:
					continue
				var desc: Dictionary = session.game.describe_unit(u)
				out[int(u.uid)] = {
					"lane": lane, "row": row, "side": side,
					"name": str(desc.name), "atk": float(desc.atk), "hp": float(desc.hp),
				}
	return out


func _animate_diff(now: Dictionary) -> void:
	if not _anim_on():
		return
	# 对手即将「飞」过来的那些格子先别急着淡入，交给飞行落地时再亮
	var flying: Dictionary = {}
	for ev in _pending_fx:
		if str(ev.get("kind", "")) == "deploy" and int(ev.get("side", -1)) != session.human_side:
			flying["%s:%s" % [str(ev.get("lane", "")), _half_key(int(ev.get("side", 0)), str(ev.get("row", "front")))]] = true
	# 新上场的、或换了格子的单位：缩放淡入
	for uid in now.keys():
		var info: Dictionary = now[uid]
		var prev = _prev_units.get(uid, null)
		var moved := prev == null
		if prev != null:
			moved = str(prev.lane) != str(info.lane) or str(prev.row) != str(info.row) or int(prev.side) != int(info.side)
		if moved:
			var key := "%s:%s" % [info.lane, _half_key(int(info.side), str(info.row))]
			if not flying.has(key):
				_enter_cell(key)
	# 这一帧消失的单位：留一具残影在原地碎掉
	for uid in _prev_units.keys():
		if not now.has(uid):
			_death_ghost(_prev_units[uid])
	# 新抽到的牌：从 0.72 倍弹出来
	for iid in _hand_added:
		var nd = _hand_node_of(int(iid))
		if nd != null:
			nd.pivot_offset = nd.size * 0.5
			nd.scale = Vector2(0.72, 0.72)
			var tw: Tween = nd.create_tween()
			tw.tween_property(nd, "scale", Vector2.ONE, _t(0.26)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	_hand_added = []


func _enter_cell(key: String) -> void:
	var node = _cell_nodes.get(key, null)
	if node == null or not is_instance_valid(node):
		return
	node.pivot_offset = node.size * 0.5
	node.scale = Vector2(0.62, 0.62)
	node.modulate.a = 0.0
	var tw: Tween = node.create_tween()
	tw.set_parallel(true)
	tw.tween_property(node, "scale", Vector2.ONE, _t(0.3)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "modulate:a", 1.0, _t(0.16))


func _death_ghost(prev: Dictionary) -> void:
	if not _anim_on():
		return
	var half := _half_key(int(prev.get("side", 0)), str(prev.get("row", "front")))
	var rect := _cell_rect_abs(str(prev.get("lane", "")), half)
	var ghost := Panel.new()
	ghost.position = rect.position
	ghost.size = rect.size
	ghost.pivot_offset = rect.size * 0.5
	ghost.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ghost.add_theme_stylebox_override("panel", U.box(Color(0.26, 0.11, 0.13, 0.92), 10, U.BAD, 2))
	_lab(ghost, str(prev.get("name", "")), Rect2(8, 6, rect.size.x - 16, 22), 14, Color(1, 0.78, 0.78))
	_lab(ghost, "⚔ %s  ♥ %s" % [U.num(prev.get("atk", 0)), U.num(prev.get("hp", 0))],
		Rect2(8, 30, rect.size.x - 16, 26), 18, Color(1, 0.82, 0.82))
	_fx_layer.add_child(ghost)
	var tw := ghost.create_tween()
	tw.set_parallel(true)
	tw.tween_property(ghost, "scale", Vector2(1.16, 1.16), _t(0.4)).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw.tween_property(ghost, "rotation", 0.1, _t(0.4))
	tw.tween_property(ghost, "modulate:a", 0.0, _t(0.34)).set_delay(_t(0.08))
	tw.chain().tween_callback(func(): ghost.queue_free())


# ── 积压事件的落地（此时新节点已经建好） ────────────────────────────────────

func _drain_pending_fx() -> void:
	if _pending_fx.is_empty():
		return
	var evs: Array = _pending_fx.duplicate()
	_pending_fx.clear()
	_run_fx_queue(evs)


## 一条线一条线地演：每个事件之间留一点间隔，攻击者先冲一下，再出数字。
## 作者 2026-11-08 第 3 条：开战要逐线进行，不能一下子打完。
func _run_fx_queue(evs: Array) -> void:
	for ev in evs:
		_play_fx(ev)
		var gap := _fx_gap(str(ev.get("kind", "")))
		if gap > 0.0 and _anim_on():
			await Engine.get_main_loop().create_timer(gap).timeout


func _fx_gap(kind: String) -> float:
	match kind:
		"lane": return 0.0
		"deploy": return 0.12
		"cast": return 0.12
		"damage": return 0.16
		"heal": return 0.12
		"destroy": return 0.2
		"king-damage", "king-heal": return 0.26
		"banner": return 0.3
	return 0.1


func _play_fx(ev: Dictionary) -> void:
	var kind := str(ev.get("kind", ""))
	match kind:
		"banner":
			_banner_fx(str(ev.get("text", "")))
		"lane":
			_lane_fx(str(ev.get("lane", "")), str(ev.get("text", "")))
		"king-damage", "king-heal":
			var side: int = int(ev.get("side", session.human_side))
			var x := 120.0 if side == session.human_side else 600.0
			var is_dmg: bool = kind == "king-damage"
			_screen_flash(U.BAD if is_dmg else U.GOOD, 0.14)
			_punch(_top, 0.96 if is_dmg else 1.02, 0.22)
			var src = ev.get("from", null)
			if src != null:
				_lunge_fx(str(src.lane), _half_key(int(src.side), str(src.row)), "king")
			_float_fx(str(ev.get("text", "")), Vector2(x, 96), U.BAD if is_dmg else U.GOOD, 30)
		"cast":
			if int(ev.get("side", -1)) == session.human_side:
				_float_fx("「%s」" % str(ev.get("text", "")), Vector2(DESIGN.x * 0.5, _r_hand.position.y - 12.0), U.FACTION, 22)
			else:
				_foe_cast_fx(ev)
		_:
			var lane := str(ev.get("lane", ""))
			if lane == "":
				return
			var half := _half_key(int(ev.get("side", 0)), str(ev.get("row", "front")))
			var pos := _cell_center(lane, half)
			match kind:
				"deploy":
					if int(ev.get("side", -1)) == session.human_side:
						pass   # 人类打出的牌是自己飞过去的，落地波纹在 _flight_land 里放过了
					else:
						_foe_deploy_fx(ev)
				"destroy":
					_float_fx("消灭", pos, U.BAD, 24)
				"damage":
					var src = ev.get("from", null)
					if src != null:
						_lunge_fx(str(src.lane), _half_key(int(src.side), str(src.row)), "%s:%s" % [lane, half])
					_hit_fx(lane, half, U.BAD)
					_float_fx(str(ev.get("text", "-0")), pos, U.BAD, 28)
				"heal":
					_hit_fx(lane, half, U.GOOD)
					_float_fx(str(ev.get("text", "+0")), pos, U.GOOD, 26)


## 这一线开打：整条线亮一下，左侧标出线路名
func _lane_fx(lane: String, lane_name: String) -> void:
	var r := _lane_rect(lane)
	if r.size == Vector2.ZERO:
		return
	var band := Panel.new()
	band.position = r.position
	band.size = r.size
	band.mouse_filter = Control.MOUSE_FILTER_IGNORE
	band.add_theme_stylebox_override("panel", U.box(Color(U.GOLD, 0.10), 10, U.GOLD, 2))
	band.modulate.a = 0.0
	_fx_layer.add_child(band)
	var tag := U.label(lane_name, 18, U.GOLD, HORIZONTAL_ALIGNMENT_LEFT)
	tag.size = Vector2(120, 26)
	tag.position = Vector2(r.position.x + 8, r.position.y + 4)
	tag.mouse_filter = Control.MOUSE_FILTER_IGNORE
	tag.modulate.a = 0.0
	_fx_layer.add_child(tag)
	if not _anim_on():
		band.queue_free()
		tag.queue_free()
		return
	var tw := band.create_tween()
	tw.set_parallel(true)
	tw.tween_property(band, "modulate:a", 1.0, _t(0.12))
	tw.tween_property(tag, "modulate:a", 1.0, _t(0.12))
	tw.chain().tween_property(band, "modulate:a", 0.0, _t(0.5)).set_delay(_t(0.42))
	tw.parallel().tween_property(tag, "modulate:a", 0.0, _t(0.4)).set_delay(_t(0.5))
	tw.chain().tween_callback(func():
		band.queue_free()
		tag.queue_free())


## 攻击者朝目标冲一下再弹回
func _lunge_fx(lane: String, from_half: String, to_key: String) -> void:
	if not _anim_on():
		return
	var node = _cell_nodes.get("%s:%s" % [lane, from_half], null)
	if node == null or not is_instance_valid(node):
		return
	var to_pos: Vector2 = _cell_center(lane, from_half)
	if to_key == "king":
		# 己方单位打的是右边的敌国国王，反之亦然
		to_pos = Vector2(595, 56) if from_half.begins_with("my") else Vector2(120, 56)
	else:
		var seg := to_key.split(":")
		if seg.size() == 2:
			to_pos = _cell_center(str(seg[0]), str(seg[1]))
	var dir := (to_pos - _cell_center(lane, from_half)).normalized()
	if dir == Vector2.ZERO:
		return
	var home: Vector2 = node.position
	node.z_index = 6
	var tw: Tween = node.create_tween()
	tw.tween_property(node, "position", home + dir * 16.0, _t(0.09)).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw.tween_property(node, "position", home, _t(0.14)).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_IN)
	tw.tween_callback(func():
		if is_instance_valid(node):
			node.position = home
			node.z_index = 0)


## 这一条线在棋盘上的整体矩形（4 排格子合起来）
func _lane_rect(lane: String) -> Rect2:
	var li := KPC.LANES.find(lane)
	if li < 0:
		return Rect2()
	var top := _cell_rect(li, 0)
	var bottom := _cell_rect(li, 3)
	return Rect2(_board.position + top.position,
		Vector2(top.size.x, bottom.position.y + bottom.size.y - top.position.y))


# ── 出牌：手牌 → 战场的飞行 ────────────────────────────────────────────────

func _hand_node_of(iid: int):
	for c in _hand_row.get_children():
		if int(c.get_meta("iid", -1)) == iid:
			return c
	return null


## 落点：单位牌是目标格，锦囊牌是战场中央
func _target_rect(opts: Dictionary) -> Rect2:
	var lane := str(opts.get("lane", ""))
	if lane != "":
		var li := KPC.LANES.find(lane)
		var hi := 2 if str(opts.get("row", "front")) == "front" else 3
		if li >= 0:
			var r := _cell_rect(li, hi)
			r.position += _board.position
			return r
	return Rect2(Vector2(276, 360), Vector2(CELL_W, _cell_h))


## 出牌入口：先让一张牌从手牌飞到落点，落地那一刻才真的把牌打进引擎。
## 这样玩家看到的是「牌飞过去 → 牌变成单位」，而不是「手牌消失 → 单位凭空出现」。
func _play_with_anim(iid: int, opts: Dictionary, from: Control = null) -> void:
	var node := from
	if node == null:
		node = _hand_node_of(iid)
	var card_id := _card_id_of(iid)
	if _busy_anim:
		return
	if not _anim_on() or node == null or card_id == "":
		session.play_card(iid, opts)
		return
	_busy_anim = true
	# 手牌原地淡出，接力给飞行中的那张
	var out := node.create_tween()
	out.tween_property(node, "modulate:a", 0.0, _t(0.1))
	_fly_card(iid, card_id, node, _target_rect(opts), func():
		_busy_anim = false
		# 落地时再核一次：飞行这半秒里局面可能已经变了
		if not _legal.has(iid):
			_toast("这张牌现在打不出了")
			_refresh()
			return
		session.play_card(iid, opts))


func _fly_card(iid: int, card_id: String, from: Control, target: Rect2, on_land: Callable) -> void:
	var src := _node_rect_in_fx(from)
	var card: Control = _make_hand_card(iid, card_id, _legal.get(iid, null), clampf(src.size.x, 96.0, 152.0))
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.custom_minimum_size = Vector2.ZERO
	card.size = src.size
	card.position = src.position
	card.pivot_offset = src.size * 0.5
	card.set_meta("iid", iid)
	card.z_index = 10
	_fx_layer.add_child(card)

	var lift := src.position - Vector2(0, 18)
	var land := target.position + (target.size - src.size) * 0.5
	var tw := card.create_tween()
	# 起手：抬起来、放大一点
	tw.tween_property(card, "position", lift, _t(0.07)).set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_OUT)
	tw.parallel().tween_property(card, "scale", Vector2(1.08, 1.08), _t(0.07))
	# 飞行：抛物线，一路带一点旋转，越飞越正
	tw.tween_method(_flight_step.bind(card, lift, land), 0.0, 1.0, _t(0.22)) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	# 落地：压扁 + 消散 + 地面波纹，然后才把牌交给引擎
	tw.tween_callback(_flight_land.bind(card, target, on_land))


func _flight_step(t: float, card: Control, a: Vector2, b: Vector2) -> void:
	if not is_instance_valid(card):
		return
	var p := a.lerp(b, t)
	p.y -= sin(t * PI) * 74.0
	card.position = p
	card.scale = Vector2.ONE * lerpf(1.08, 1.0, t)
	card.rotation = -sin(t * PI) * 0.1


func _flight_land(card: Control, target: Rect2, on_land: Callable) -> void:
	if is_instance_valid(card):
		var tw := card.create_tween()
		tw.set_parallel(true)
		tw.tween_property(card, "scale", Vector2(1.14, 0.84), _t(0.09))
		tw.tween_property(card, "modulate:a", 0.0, _t(0.16)).set_delay(_t(0.04))
		tw.chain().tween_callback(func(): card.queue_free())
	_land_burst(target)
	on_land.call()


# ── 小零件 ────────────────────────────────────────────────────────────────

## 节点在 _fx_layer 坐标系里的矩形（fx 层和设计稿同尺寸，所以拿它当舞台坐标）
func _node_rect_in_fx(node: Control) -> Rect2:
	var inv := _fx_layer.get_global_transform().affine_inverse()
	var r := node.get_global_rect()
	var p0: Vector2 = inv * r.position
	var p1: Vector2 = inv * r.end
	return Rect2(p0, p1 - p0)


func _cell_rect_abs(lane: String, half: String) -> Rect2:
	var li := KPC.LANES.find(lane)
	var hi := HALVES.find(half)
	if li < 0 or hi < 0:
		return Rect2(_board.position, Vector2(CELL_W, _cell_h))
	var r := _cell_rect(li, hi)
	r.position += _board.position
	return r


## 落地波纹：一圈绿光由小变大散去
func _land_burst(rect: Rect2) -> void:
	if not _anim_on():
		return
	var ring := Panel.new()
	ring.position = rect.position
	ring.size = rect.size
	ring.pivot_offset = rect.size * 0.5
	ring.mouse_filter = Control.MOUSE_FILTER_IGNORE
	ring.add_theme_stylebox_override("panel", U.box(Color(0, 0, 0, 0), 14, U.GOOD, 3))
	_fx_layer.add_child(ring)
	var tw := ring.create_tween()
	tw.set_parallel(true)
	tw.tween_property(ring, "scale", Vector2(1.22, 1.22), _t(0.34)).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw.tween_property(ring, "modulate:a", 0.0, _t(0.34))
	tw.chain().tween_callback(func(): ring.queue_free())


## 受击：格子上闪一圈色 + 抖一下
func _hit_fx(lane: String, half: String, col: Color) -> void:
	if not _anim_on():
		return
	var rect := _cell_rect_abs(lane, half)
	var flash := Panel.new()
	flash.position = rect.position
	flash.size = rect.size
	flash.pivot_offset = rect.size * 0.5
	flash.mouse_filter = Control.MOUSE_FILTER_IGNORE
	flash.add_theme_stylebox_override("panel", U.box(Color(col.r, col.g, col.b, 0.16), 10, col, 3))
	_fx_layer.add_child(flash)
	var tw := flash.create_tween()
	tw.set_parallel(true)
	tw.tween_property(flash, "scale", Vector2(1.06, 1.06), _t(0.28)).set_trans(Tween.TRANS_QUAD).set_ease(Tween.EASE_OUT)
	tw.tween_property(flash, "modulate:a", 0.0, _t(0.28))
	tw.chain().tween_callback(func(): flash.queue_free())
	var node = _cell_nodes.get("%s:%s" % [lane, half], null)
	if node != null and is_instance_valid(node):
		_punch(node, 1.09, 0.18)


func _screen_flash(col: Color, alpha: float) -> void:
	if not _anim_on():
		return
	var cr := ColorRect.new()
	cr.color = Color(col.r, col.g, col.b, alpha)
	cr.position = Vector2.ZERO
	cr.size = Vector2(DESIGN.x, _vh)
	cr.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fx_layer.add_child(cr)
	var tw := cr.create_tween()
	tw.tween_property(cr, "modulate:a", 0.0, _t(0.42))
	tw.tween_callback(func(): cr.queue_free())


## 弹一下：先在 dur*0.4 里放大到 sz，再回弹到 1.0
func _punch(node, sz: float, dur: float) -> void:
	if not _anim_on() or node == null or not is_instance_valid(node) or not (node is Control):
		return
	var c: Control = node
	c.pivot_offset = c.size * 0.5
	var tw := c.create_tween()
	tw.tween_property(c, "scale", Vector2(sz, sz), _t(dur * 0.4))
	tw.tween_property(c, "scale", Vector2.ONE, _t(dur * 0.6)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)


## 浮层面板弹出：0.94 倍 + 透明 → 正常大小
func _pop_in(panel: Control) -> void:
	if not _anim_on():
		return
	panel.pivot_offset = panel.size * 0.5
	panel.scale = Vector2(0.94, 0.94)
	panel.modulate.a = 0.0
	var tw := panel.create_tween()
	tw.set_parallel(true)
	tw.tween_property(panel, "scale", Vector2.ONE, _t(0.2)).set_trans(Tween.TRANS_BACK).set_ease(Tween.EASE_OUT)
	tw.tween_property(panel, "modulate:a", 1.0, _t(0.16))


func _end_phase() -> void:
	if _busy_anim or _replay():
		return
	session.end_phase()


# ── 对手出牌：从对面 HUD 飞一张牌过来 ──────────────────────────────────────

func _foe_deploy_fx(ev: Dictionary) -> void:
	if not _anim_on():
		return
	var lane := str(ev.get("lane", ""))
	var half := _half_key(int(ev.get("side", 0)), str(ev.get("row", "front")))
	var key := "%s:%s" % [lane, half]
	var rect := _cell_rect_abs(lane, half)
	# 单位其实已经在场上了：先藏起来，等牌飞到了再亮出来
	var node = _cell_nodes.get(key, null)
	if node != null and is_instance_valid(node):
		(node as Control).modulate.a = 0.0
	_foe_fly(str(ev.get("text", "单位")), U.BAD, Rect2(Vector2(600, 22), Vector2(104, 118)), rect, func():
		var n = _cell_nodes.get(key, null)
		if n != null and is_instance_valid(n):
			_enter_cell(key)
		_land_burst(rect))


func _foe_cast_fx(ev: Dictionary) -> void:
	if not _anim_on():
		return
	var lane := str(ev.get("lane", ""))
	var rect := Rect2(Vector2(276, 360), Vector2(CELL_W, _cell_h))
	if lane != "":
		var li := KPC.LANES.find(lane)
		if li >= 0:
			rect = _cell_rect_abs(lane, "my_front")
	_foe_fly("锦囊", U.FACTION, Rect2(Vector2(600, 22), Vector2(104, 118)), rect, func():
		_land_burst(rect)
		_float_fx("「%s」" % str(ev.get("text", "")), Vector2(DESIGN.x * 0.5, _r_hand.position.y - 12.0), U.FACTION, 22))


## 对手方的「牌」：只画一张带名字的牌背，飞得比玩家自己出牌快一点
func _foe_fly(label: String, tone: Color, src: Rect2, target: Rect2, on_land: Callable) -> void:
	var card := Panel.new()
	card.position = src.position
	card.size = src.size
	card.pivot_offset = src.size * 0.5
	card.mouse_filter = Control.MOUSE_FILTER_IGNORE
	card.add_theme_stylebox_override("panel", U.box(Color("2a1520"), 10, tone, 2))
	_lab(card, label, Rect2(6, 10, src.size.x - 12, 26), 14, Color(1, 0.85, 0.85), HORIZONTAL_ALIGNMENT_CENTER)
	_lab(card, "对手出牌", Rect2(6, src.size.y - 34, src.size.x - 12, 22), 11, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	card.z_index = 9
	card.set_meta("foe", true)
	_fx_layer.add_child(card)

	var start := src.position
	var land := target.position + (target.size - src.size) * 0.5
	var tw := card.create_tween()
	tw.tween_property(card, "scale", Vector2(0.92, 0.92), _t(0.06))
	tw.parallel().tween_property(card, "position", start + Vector2(0, 14), _t(0.06))
	tw.tween_method(_flight_step.bind(card, start + Vector2(0, 14), land), 0.0, 1.0, _t(0.2)) \
		.set_trans(Tween.TRANS_SINE).set_ease(Tween.EASE_IN_OUT)
	tw.tween_callback(_foe_fly_land.bind(card, on_land))


func _foe_fly_land(card: Control, on_land: Callable) -> void:
	if is_instance_valid(card):
		var tw := card.create_tween()
		tw.set_parallel(true)
		tw.tween_property(card, "scale", Vector2(1.1, 0.86), _t(0.08))
		tw.tween_property(card, "modulate:a", 0.0, _t(0.14)).set_delay(_t(0.03))
		tw.chain().tween_callback(func(): card.queue_free())
	on_land.call()
