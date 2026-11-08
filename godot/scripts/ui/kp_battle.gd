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

const DESIGN := Vector2(720, 1280)

const TOP_RECT := Rect2(0, 0, 720, 118)
const BANNER_RECT := Rect2(0, 122, 720, 44)
const BOARD_RECT := Rect2(8, 174, 704, 478)
const HINT_RECT := Rect2(8, 658, 704, 30)
const HAND_RECT := Rect2(0, 694, 720, 300)
const PREVIEW_RECT := Rect2(8, 1000, 704, 150)
const ACTION_RECT := Rect2(0, 1158, 720, 96)

const CELL_W := 168.0
const CELL_H := 106.0
const CELL_GAP := 6.0
const BOARD_HEADER := 28.0
const HALVES := ["foe_back", "foe_front", "my_front", "my_back"]

var session = null

var _frame: Control
var _top: Control
var _banner: Control
var _board: Control
var _hint: Label
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
	_frame.size = DESIGN
	add_child(_frame)

	_top = Panel.new()
	_top.position = TOP_RECT.position
	_top.size = TOP_RECT.size
	_frame.add_child(_top)

	_banner = Panel.new()
	_banner.position = BANNER_RECT.position
	_banner.size = BANNER_RECT.size
	_frame.add_child(_banner)

	_board = Control.new()
	_board.position = BOARD_RECT.position
	_board.size = BOARD_RECT.size
	_frame.add_child(_board)

	_hint = U.label("", 15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	_hint.position = HINT_RECT.position
	_hint.size = HINT_RECT.size
	_frame.add_child(_hint)

	var scroll := ScrollContainer.new()
	scroll.position = HAND_RECT.position
	scroll.size = HAND_RECT.size
	scroll.horizontal_scroll_mode = ScrollContainer.SCROLL_MODE_AUTO
	scroll.vertical_scroll_mode = ScrollContainer.SCROLL_MODE_DISABLED
	_frame.add_child(scroll)
	_hand_row = HBoxContainer.new()
	_hand_row.add_theme_constant_override("separation", 10)
	_hand_row.size_flags_vertical = Control.SIZE_SHRINK_CENTER
	scroll.add_child(_hand_row)

	_preview = Control.new()
	_preview.position = PREVIEW_RECT.position
	_preview.size = PREVIEW_RECT.size
	_frame.add_child(_preview)

	_action = Control.new()
	_action.position = ACTION_RECT.position
	_action.size = ACTION_RECT.size
	_frame.add_child(_action)

	_fx_layer = Control.new()
	_fx_layer.size = DESIGN
	_fx_layer.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_frame.add_child(_fx_layer)

	_overlay = Control.new()
	_overlay.size = DESIGN
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
	var s := minf(avail.x / DESIGN.x, avail.y / DESIGN.y)
	if s <= 0.0 or not is_finite(s):
		s = 1.0
	_frame.scale = Vector2(s, s)
	_frame.position = (avail - DESIGN * s) * 0.5


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


func _lab(parent: Node, text: String, rect: Rect2, fs: int, col: Color,
		align: int = HORIZONTAL_ALIGNMENT_LEFT, clip := true) -> Label:
	var l := U.label(text, fs, col, align)
	l.position = rect.position
	l.size = rect.size
	l.clip_text = clip
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(l)
	return l


## 用主题字体量一遍文字在给定宽度下的高度，好让面板按内容排版
func _text_h(parent: Control, text: String, width: float, fs: int) -> float:
	var f: Font = parent.get_theme_font("font")
	if f == null:
		return float(fs) * 1.6
	var sz: Vector2 = f.get_multiline_string_size(text, HORIZONTAL_ALIGNMENT_LEFT, width, fs)
	return sz.y


func _wrap(parent: Node, text: String, rect: Rect2, fs: int, col: Color,
		align: int = HORIZONTAL_ALIGNMENT_LEFT) -> Label:
	var l := U.label(text, fs, col, align)
	l.position = rect.position
	l.size = rect.size
	l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	l.clip_text = true
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(l)
	return l


# ── 顶部 HUD ────────────────────────────────────────────────────────────────

func _build_top(st: Dictionary, me: Dictionary, foe: Dictionary) -> void:
	_clear(_top)
	var sb := U.box(U.PANEL, 0)
	_top.add_theme_stylebox_override("panel", sb)

	_side_block(_top, me, 14.0, session.human_side, true)
	_side_block(_top, foe, 492.0, session.ai_side, false)

	var phase_name := str(KPC.PHASES.find(str(st.phase)))
	_lab(_top, "回合 %d" % int(st.turn), Rect2(288, 8, 144, 26), 17, U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(_top, _phase_name(str(st.phase)), Rect2(288, 34, 144, 34), 22, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	_lab(_top, "牌库 %d · 弃牌 %d" % [st.deck.size(), st.discard.size()],
		Rect2(288, 70, 144, 20), 12, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)
	var role := "先手" if int(st.firstPlayer) == session.human_side else "后手"
	_lab(_top, "你是" + role, Rect2(288, 90, 144, 20), 13, U.FACTION, HORIZONTAL_ALIGNMENT_CENTER)

	# 返回按钮
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


func _side_block(parent: Control, p: Dictionary, x: float, side: int, is_me: bool) -> void:
	var align := HORIZONTAL_ALIGNMENT_LEFT if is_me else HORIZONTAL_ALIGNMENT_RIGHT
	var name_text := "你" if is_me else "对手"
	var fname := DATA.faction_name(p.get("faction", ""))
	if fname != "中立":
		name_text += " · " + fname
	_lab(parent, name_text, Rect2(x, 8, 206, 24), 16, U.FACTION if fname != "中立" else U.TEXT, align)

	var hp := float(p.kingHp)
	var maxhp := maxf(1.0, float(p.kingMaxHp))
	_lab(parent, "♥ %s/%s" % [U.num(hp), U.num(maxhp)], Rect2(x, 32, 206, 28), 20,
		U.GOOD if hp > maxhp * 0.5 else (U.GOLD if hp > maxhp * 0.2 else U.BAD), align)

	var bar := U.hpbar(hp / maxhp, U.BAD if hp <= maxhp * 0.25 else U.GOOD, 12)
	bar.position = Vector2(x, 64)
	bar.size = Vector2(206, 12)
	bar.mouse_filter = Control.MOUSE_FILTER_IGNORE
	parent.add_child(bar)

	var bits: Array = []
	bits.append("费用 %s/%s" % [U.num(p.mana), U.num(p.manaCap)])
	bits.append("手牌 %d" % p.hand.size())
	if p.get("superpowers", []).size() > 0:
		bits.append("超能力 %d" % p.superpowers.size())
	_lab(parent, " · ".join(bits), Rect2(x, 82, 206, 22), 13, U.DIM, align)


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
	if session.is_over():
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
	var x0 := (BOARD_RECT.size.x - inner_w) * 0.5
	return Rect2(x0 + lane_i * (CELL_W + CELL_GAP), BOARD_HEADER + half_i * (CELL_H + CELL_GAP), CELL_W, CELL_H)


func _build_board(st: Dictionary) -> void:
	_clear(_board)
	_cell_nodes = {}
	var me_side: int = session.human_side

	# 线路表头
	var inner_w := 4.0 * CELL_W + 3.0 * CELL_GAP
	var x0 := (BOARD_RECT.size.x - inner_w) * 0.5
	for i in KPC.LANES.size():
		var lane: String = KPC.LANES[i]
		_lab(_board, str(KPC.LANE_NAME.get(lane, lane)), Rect2(x0 + i * (CELL_W + CELL_GAP), 2, CELL_W, 24),
			15, U.DIM, HORIZONTAL_ALIGNMENT_CENTER)

	var my_places: Dictionary = {}
	if _selected_iid >= 0 and _legal.has(_selected_iid):
		for pl in _legal[_selected_iid].get("places", []):
			if pl != null:
				my_places["%s:%s" % [pl.lane, pl.row]] = true

	for i in KPC.LANES.size():
		var lane: String = KPC.LANES[i]
		for h in 4:
			var half: String = HALVES[h]
			var side: int = me_side if half.begins_with("my") else session.ai_side
			var row := "front" if half.ends_with("front") else "back"
			var u = st.board[lane].units[side][row]
			var is_legal := my_places.has("%s:%s" % [lane, row])
			var node := _make_cell(lane, half, row, side, u, is_legal)
			node.position = _cell_rect(i, h).position
			node.size = _cell_rect(i, h).size
			_board.add_child(node)
			_cell_nodes["%s:%s" % [lane, half]] = node


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

func _build_hand(me: Dictionary) -> void:
	_clear(_hand_row)
	var hand: Array = me.hand
	# 一手牌尽量铺满宽度不出现横向滚动；牌太多（>8）才交给 ScrollContainer
	var n := maxf(1.0, float(hand.size()))
	var cw := clampf((HAND_RECT.size.x - 36.0 - 8.0 * (n - 1.0)) / n, 96.0, 152.0)
	for hc in hand:
		var iid := int(hc.iid)
		var entry = _legal.get(iid, null)
		_hand_row.add_child(_make_hand_card(iid, str(hc.cardId), entry, cw))


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
	_lab(card, str(def.get("name", card_id)), Rect2(46, 12, cw - 54.0, 26), 15, U.TEXT)
	var kind := "单位"
	var stat_line := ""
	if str(def.get("type", "")) == "spell":
		kind = "锦囊"
	else:
		stat_line = "  ⚔%s ♥%s" % [U.num(def.get("atk", 0)), U.num(def.get("hp", 0))]
	_lab(card, kind + stat_line, Rect2(10, 46, inner, 22), 12, U.DIM)
	var text_h := ch - 46.0 - 34.0
	_wrap(card, str(def.get("text", "")), Rect2(10, 70, inner, maxf(40.0, text_h)), 11, Color("c3cde0"))
	var kws: Array = def.get("keywords", [])
	if kws.size() > 0:
		var names: Array = []
		for k in kws:
			names.append(DATA.keyword_name(k))
		_wrap(card, " · ".join(names), Rect2(10, ch - 32.0, inner, 26), 10, U.GOLD)
	U.on_click(card, func(): _on_card_click(iid))
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
	box.size = PREVIEW_RECT.size
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
	var can_end: bool = session.is_my_turn()
	_action.add_child(_big_button("结束阶段", Rect2(12, 12, 236, 72), can_end, func(): session.end_phase()))
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

func _on_card_click(iid: int) -> void:
	if session.is_over():
		return
	if not session.is_my_turn():
		_open_detail_card(_card_id_of(iid))
		return
	var entry = _legal.get(iid, null)
	if entry == null:
		_toast("现在打不出这张牌")
		_open_detail_card(_card_id_of(iid))
		return
	if _selected_iid == iid:
		_open_detail_card(_card_id_of(iid))
		return
	var places: Array = entry.get("places", [])
	if places.size() == 1 and places[0] == null:
		_selected_iid = -1
		session.play_card(iid, {})
		return
	_selected_iid = iid
	_refresh()


func _on_cell_click(lane: String, half: String) -> void:
	var row := "front" if half.ends_with("front") else "back"
	var side: int = session.human_side if half.begins_with("my") else session.ai_side
	var u = session.game.state.board[lane].units[side][row]

	if _selected_iid >= 0 and _legal.has(_selected_iid):
		for pl in _legal[_selected_iid].get("places", []):
			if pl != null and str(pl.lane) == lane and str(pl.row) == row:
				var iid := _selected_iid
				_selected_iid = -1
				session.play_card(iid, {"lane": lane, "row": row})
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
	if pending != null:
		_build_choice(pending)
	elif _detail_card != "" or _detail_uid >= 0:
		_build_detail()
	elif session.is_over():
		_build_result(st)


func _dim_full() -> ColorRect:
	var dim := ColorRect.new()
	dim.color = Color(0, 0, 0, 0.5)
	dim.position = Vector2.ZERO
	dim.size = DESIGN
	dim.mouse_filter = Control.MOUSE_FILTER_STOP
	_overlay.add_child(dim)
	_overlay.mouse_filter = Control.MOUSE_FILTER_STOP
	return dim


func _build_choice(req: Dictionary) -> void:
	_dim_full()
	var opts: Array = req.get("options", [])
	var shown := maxi(1, mini(opts.size(), 10))
	var h := clampf(78.0 + float(shown) * 66.0 + 16.0, 210.0, 760.0)
	var panel := Panel.new()
	panel.size = Vector2(640, h)
	panel.position = Vector2(40, DESIGN.y - h - 30)
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
	panel.position = Vector2(60, maxf(40.0, (DESIGN.y - ph) * 0.5))
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

func _on_fx(events: Array) -> void:
	for ev in events:
		var kind := str(ev.get("kind", ""))
		match kind:
			"banner":
				_banner_fx(str(ev.get("text", "")))
			"king-damage", "king-heal":
				var side: int = int(ev.get("side", session.human_side))
				var x := 120.0 if side == session.human_side else 600.0
				_float_fx(str(ev.get("text", "")), Vector2(x, 96), U.BAD if kind == "king-damage" else U.GOOD, 30)
			"cast":
				_float_fx("「%s」" % str(ev.get("text", "")), Vector2(DESIGN.x * 0.5, 690), U.FACTION, 22)
			_:
				var lane := str(ev.get("lane", ""))
				if lane == "":
					continue
				var half := _half_key(int(ev.get("side", 0)), str(ev.get("row", "front")))
				var pos := _cell_center(lane, half)
				match kind:
					"deploy":
						_float_fx("上阵", pos, U.GOOD, 22)
					"destroy":
						_float_fx("消灭", pos, U.BAD, 24)
					"damage":
						_float_fx(str(ev.get("text", "-0")), pos, U.BAD, 28)
					"heal":
						_float_fx(str(ev.get("text", "+0")), pos, U.GOOD, 26)


func _half_key(side: int, row: String) -> String:
	var prefix := "my" if side == session.human_side else "foe"
	return "%s_%s" % [prefix, row]


func _cell_center(lane: String, half: String) -> Vector2:
	var node = _cell_nodes.get("%s:%s" % [lane, half], null)
	if node == null:
		return DESIGN * 0.5
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
	var l := U.label(text, 42, U.GOLD, HORIZONTAL_ALIGNMENT_CENTER)
	l.size = Vector2(DESIGN.x, 60)
	l.position = Vector2(0, DESIGN.y * 0.42)
	l.mouse_filter = Control.MOUSE_FILTER_IGNORE
	_fx_layer.add_child(l)
	var tw := l.create_tween()
	tw.set_parallel(true)
	tw.tween_property(l, "position:y", l.position.y - 30.0, 0.9)
	tw.tween_property(l, "modulate:a", 0.0, 0.9).set_delay(0.4)
	tw.chain().tween_callback(func(): l.queue_free())


func _toast(text: String) -> void:
	if text.strip_edges() == "":
		return
	var l := U.label(text, 16, U.TEXT, HORIZONTAL_ALIGNMENT_CENTER)
	l.size = Vector2(DESIGN.x - 80, 40)
	l.position = Vector2(40, DESIGN.y - 220)
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
