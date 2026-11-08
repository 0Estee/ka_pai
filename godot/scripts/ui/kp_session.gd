## 对局会话：把规则引擎与 AI 包成「订阅 + 动作」的接口给界面用。
##
## 职责划分与 Web 版 web/src/game/controller.ts 一一对应：
##   · 规则、合法性、AI 决策全在 engine/ 与 ai/ 里；
##   · 这里只管「什么时候轮到谁」「挂起的提问怎么喂回去」「什么时候通知界面重绘」；
##   · 顺便把每次动作新增的引擎日志翻成演出事件（见本文件 fx_from_log）。
##
## 与 JS 版的唯一实质差别：引擎是协程。所以这里的动作都是 async，
##   界面 fire-and-forget 调用即可（不 await），完成时靠 changed / fx 信号通知。
class_name KPSession
extends RefCounted

signal changed
signal fx(events: Array)
signal finished
## 出牌失败等提示（界面上飘一行字）
signal notice(text: String)

const KPGame := preload("res://scripts/engine/kp_game.gd")
const KPAi := preload("res://scripts/ai/kp_ai.gd")
const KPC := preload("res://scripts/engine/kp_constants.gd")
const DATA := preload("res://scripts/ui/kp_data.gd")

## 回合每推进一步给界面留一点喘息时间（秒），否则一屏会瞬间刷完
var pace := 0.09

var game = null
var ai = null
var human_side := 0
var ai_side := 1
var difficulty := "normal"
var game_seed := 0
var human_faction := ""
var ai_faction := ""
var busy := false

## 回放：记录「人类这侧的动作序列」（引擎确定性 ⇒ 几 KB 就能复现整局）
var recording := true
var record: Array = []
var replay_mode := false
var deck_size := 80
var _replay_actions: Array = []
var _replay_i := 0

var _log_mark := 0
var _pos_mark: Dictionary = {}
var _fx_seq := 1


# ── 开局 ────────────────────────────────────────────────────────────────────

func start(cfg: Dictionary = {}) -> void:
	game_seed = int(cfg.get("seed", randi() % 1000000000))
	difficulty = str(cfg.get("difficulty", "normal"))
	human_side = int(cfg.get("humanSide", 0))
	ai_side = 1 - human_side
	human_faction = str(cfg.get("humanFaction", ""))
	ai_faction = str(cfg.get("aiFaction", ""))
	deck_size = int(cfg.get("deckSize", 80))
	pace = float(cfg.get("pace", pace))

	var factions: Array = []
	factions.resize(2)
	factions[human_side] = null if human_faction == "" else human_faction
	factions[ai_side] = null if ai_faction == "" else ai_faction

	game = KPGame.create({
		"seed": game_seed,
		"firstPlayer": game_seed % 2,
		"deck": DATA.build_deck(deck_size, game_seed),
		"cardLib": DATA.lib(),
		"shuffleDeck": true,
		"factions": factions,
	})

	game.choice_needed.connect(Callable(self, "_on_choice_needed"))

	# 人类那一侧的问题「挂起等人点」，AI 那一侧的问题由引擎自己算
	game.state["autoResolveChoices"] = false
	game.state["humanSide"] = human_side
	game.state["aiSides"] = [ai_side]

	ai = KPAi.new(game, difficulty)
	ai.install_target_picker()
	ai.apply_difficulty_bonus(ai_side, difficulty)

	changed.emit()  # 先把空棋盘画出来，再开始发牌
	_mark()
	await game.start_game()
	_harvest()
	await _drive_ai()
	changed.emit()
	if game.is_over():
		finished.emit()


# ── 查询 ────────────────────────────────────────────────────────────────────

func is_over() -> bool:
	return game != null and game.is_over()

func pending():
	if game == null:
		return null
	return game.pending_request

## 引擎挂起了一次提问：立刻让界面把选项面板画出来
func _on_choice_needed(_request: Dictionary) -> void:
	changed.emit()


## 现在轮到人类行动（且没有挂起）
func is_my_turn() -> bool:
	if game == null or is_over() or game.has_pending():
		return false
	return game.get_actor() == human_side

func my_hand() -> Array:
	if game == null:
		return []
	return game.state.players[human_side].hand

func legal_plays() -> Array:
	if game == null:
		return []
	return game.get_legal_plays(human_side)

func def_of(card_id) -> Dictionary:
	return DATA.card(card_id)

func cost_of_hand_card(iid: int) -> float:
	var p: Dictionary = game.state.players[human_side]
	for c in p.hand:
		if int(c.iid) == iid:
			return game.cost_of(c)
	return 0.0

## 拖拽出牌用：这张牌能指向哪些单位、能不能指向敌方国王（空 = 不是指向性锦囊）
func drag_targets(card_id: String) -> Dictionary:
	if game == null:
		return {"uids": [], "king": false}
	var def = game.state.cardLib.get(card_id, null)
	if def == null:
		return {"uids": [], "king": false}
	return game.card_target_uids(int(human_side), def)


## 某一方这一回合是否被锁住不能出牌（用于界面提示）
func phase_allow_type() -> String:
	return str(KPC.PHASE_ALLOWED_CARD_TYPE.get(str(game.state.phase), ""))


# ── 动作 ────────────────────────────────────────────────────────────────────

func play_card(iid: int, opts: Dictionary = {}) -> bool:
	if busy or not is_my_turn():
		return false
	busy = true
	_mark()
	# 先记账再执行：这一手可能会在半路挂起提问，若等执行完再记，
	# 录下来的顺序会变成「提问 … 出牌」，重放时就对不上了。
	var slot := _rec_begin({"t": "play", "iid": iid, "opts": opts})
	var ok: bool = await game.play_card(human_side, iid, opts)
	_harvest()
	changed.emit()
	if ok:
		await _drive_ai()
	else:
		_rec_abort(slot)
	busy = false
	if not ok:
		notice.emit(str(game.last_error))
	changed.emit()
	if is_over():
		finished.emit()
	return ok


func end_phase() -> void:
	if busy or is_over() or game.has_pending():
		return
	busy = true
	_mark()
	var slot := _rec_begin({"t": "end"})
	await game.advance()
	_harvest()
	changed.emit()
	await _drive_ai()
	busy = false
	changed.emit()
	if is_over():
		finished.emit()


## 回答引擎的提问（点选项面板）。注意：这个动作本身不能 await，
## 因为引擎正挂在那一次提问里，喂回答案后由引擎自己继续跑。
func answer_choice(answer: Dictionary) -> void:
	if game == null or not game.has_pending():
		return
	_mark()
	_rec({"t": "choice", "answer": answer})
	game.resolve_choice(answer)
	_harvest()
	changed.emit()


func surrender() -> void:
	if game == null or is_over():
		return
	_rec({"t": "surrender"})
	game.surrender(human_side)
	changed.emit()
	finished.emit()


func brew(iids: Array) -> Dictionary:
	if game == null or busy:
		return {"error": "正在结算"}
	busy = true
	_mark()
	var r: Dictionary = await game.brew(human_side, iids)
	_harvest()
	await _drive_ai()
	busy = false
	changed.emit()
	return r


# ── 回放 ────────────────────────────────────────────────────────────────────

## 用一份回放重开一局并自动演下去（界面调它，不 await）
func start_replay(rec: Dictionary) -> void:
	replay_mode = true
	recording = false
	_replay_actions = rec.get("actions", [])
	_replay_i = 0
	await start({
		"seed": int(rec.get("seed", 0)),
		"difficulty": str(rec.get("difficulty", "normal")),
		"humanFaction": str(rec.get("humanFaction", "")),
		"aiFaction": str(rec.get("aiFaction", "")),
		"deckSize": int(rec.get("deckSize", 80)),
		"humanSide": int(rec.get("humanSide", 0)),
		"pace": float(rec.get("pace", 0.2)),
	})
	await _replay_drive()


## 把这一局打包成可存档的回放
func make_record() -> Dictionary:
	var res := {}
	if game != null:
		var st: Dictionary = game.state
		res = {
			"winner": st.get("winner", null),
			"winReason": str(st.get("winReason", "")),
			"turns": int(st.get("turn", 0)),
			"cardsPlayed": int(st.get("stats", {}).get("cardsPlayed", 0)),
			"kingHp": [float(st.players[0].kingHp), float(st.players[1].kingHp)],
		}
	return {
		"seed": game_seed,
		"difficulty": difficulty,
		"humanFaction": human_faction,
		"aiFaction": ai_faction,
		"deckSize": deck_size,
		"humanSide": human_side,
		"actions": record.duplicate(true),
		"result": res,
	}


func _rec(d: Dictionary) -> void:
	if replay_mode or not recording:
		return
	record.append(d)


## 先占位记账，返回下标；执行失败用 _rec_abort(slot) 撤回
func _rec_begin(d: Dictionary) -> int:
	if replay_mode or not recording:
		return -1
	record.append(d)
	return record.size() - 1


func _rec_abort(slot: int) -> void:
	if slot >= 0 and slot < record.size():
		record.remove_at(slot)


func _peek_action() -> Dictionary:
	if _replay_i >= _replay_actions.size():
		return {}
	var a = _replay_actions[_replay_i]
	return a if a is Dictionary else {}


func _pop_action() -> Dictionary:
	var a := _peek_action()
	if not a.is_empty():
		_replay_i += 1
	return a


## 回放的驱动器：按录下来的动作喂回去，AI 自己照原路走。
##
## 出牌跟界面一样是「点火即走」——不能 await，因为一手牌可能半路挂起提问，
## 而答案在后面的动作里；await 会把整条驱动器一起挂死（这正是第一版的 bug）。
func _replay_drive() -> void:
	var guard := 0
	while not is_over() and guard < 6000:
		guard += 1
		if game.has_pending():
			var peek := _peek_action()
			if str(peek.get("t", "")) == "choice":
				_pop_action()
				game.resolve_choice(peek.get("answer", {}))
				_harvest()
				changed.emit()
			else:
				# 录下来的动作里没有这一问（AI 自己该答的）——兜底。
				_auto_answer()
				changed.emit()
			await _settle()
			continue
		if is_my_turn():
			var next := _peek_action()
			var t := str(next.get("t", ""))
			if t == "play":
				_pop_action()
				_mark()
				game.play_card(human_side, int(next.get("iid", -1)), next.get("opts", {}))
				await _settle()
				continue
			elif t == "end":
				_pop_action()
				_mark()
				game.advance()
				await _settle()
				continue
			elif t == "surrender":
				_pop_action()
				game.surrender(human_side)
				changed.emit()
				break
			else:
				break
		else:
			await _drive_ai()
			await _settle()
			continue
	changed.emit()
	if is_over():
		finished.emit()


## 让引擎里那些被点着的协程跑几帧
func _settle() -> void:
	await _pause()
	var loop := Engine.get_main_loop()
	if loop is SceneTree:
		await loop.process_frame


# ── 内部：推进到人类可行动为止（对应 controller.ts 的 driveAi） ──────────────

func _drive_ai() -> void:
	var guard := 0
	while not is_over() and guard < 200:
		guard += 1
		if game.has_pending():
			var req: Dictionary = game.pending_request
			var side := int(req.get("side", human_side))
			if side == human_side and game.get_actor() == human_side:
				game.state["autoResolveChoices"] = false
				changed.emit()
				return  # 留给玩家点
			_auto_answer()
			continue

		var actor = game.get_actor()
		if actor == null:
			_mark()
			await game.advance()
			_harvest()
			changed.emit()
			await _pause()
			continue

		if int(actor) != ai_side:
			game.state["autoResolveChoices"] = false
			return

		game.state["autoResolveChoices"] = true
		_mark()
		await ai.take_turn(ai_side)
		_harvest()
		changed.emit()
		if game.has_pending():
			_auto_answer()
			continue
		if is_over():
			break
		_mark()
		await game.advance()
		_harvest()
		changed.emit()
		await _pause()

	game.state["autoResolveChoices"] = false


## 没人接管的问题按第一个选项兜底（引擎自己带 choose 回调时优先用它的口径）
func _auto_answer() -> void:
	var req = game.pending_request
	if not (req is Dictionary):
		return
	var options: Array = req.get("options", [])
	var answer: Variant = options[0] if options.size() > 0 else {}
	var choose = req.get("choose", null)
	if choose != null and choose is Callable:
		var picked = choose.call()
		if picked != null:
			answer = picked
	game.resolve_choice(answer)


func _pause() -> void:
	if pace <= 0.0:
		return
	var loop := Engine.get_main_loop()
	if loop is SceneTree and loop.get_root() != null:
		await loop.create_timer(pace).timeout


# ── 内部：演出事件的采集 ────────────────────────────────────────────────────

func _mark() -> void:
	_log_mark = game.state.log.size()
	_pos_mark = _positions()


func _harvest() -> void:
	var entries: Array = game.state.log.slice(_log_mark)
	var evs: Array = fx_from_log(entries, _pos_mark)
	_log_mark = game.state.log.size()
	_pos_mark = _positions()
	if not evs.is_empty():
		fx.emit(evs)


func _positions() -> Dictionary:
	var out := {}
	for lane in KPC.LANES:
		for side in 2:
			for row in KPC.ROWS:
				var u = game.state.board[lane].units[side][row]
				if u != null:
					out[int(u.uid)] = {"lane": lane, "row": row, "side": side}
	return out


## 记下每个单位的坐标（动作前拍一张，动作用完对照着定位飘字）
func snapshot_positions() -> Dictionary:
	return _positions()


# ── 日志 → 演出事件（对应 web/src/game/fx.ts） ──────────────────────────────

func fx_from_log(entries: Array, before: Dictionary) -> Array:
	var out: Array = []
	for e in entries:
		if not (e is Dictionary) or not e.has("type"):
			continue
		var t := str(e.type)
		var pos = before.get(int(e.get("uid", -1)), null) if e.get("uid", null) != null else null
		match t:
			"deploy":
				out.append(_fx("deploy", e.get("lane", null), e.get("row", null), e.get("side", null), str(e.get("name", "单位")), 0, "good"))
			"cast":
				out.append(_fx("cast", e.get("lane", null), null, e.get("side", null), str(e.get("name", "锦囊")), 0, "neutral"))
			"damage":
				if pos != null:
					var amt := float(e.get("amount", 0))
					out.append(_fx("damage", pos.lane, pos.row, pos.side, "-" + _num_s(amt), amt, "bad"))
			"poison-tick", "burn-tick", "disease-tick":
				if pos != null:
					var label := "毒" if t == "poison-tick" else ("灼" if t == "burn-tick" else "病")
					out.append(_fx("damage", pos.lane, pos.row, pos.side, label, float(e.get("x", 0)), "bad"))
			"heal":
				if pos != null:
					var d := float(e.get("to", 0)) - float(e.get("from", 0))
					if d > 0.0:
						out.append(_fx("heal", pos.lane, pos.row, pos.side, "+" + _num_s(d), d, "good"))
			"king-damage":
				out.append(_fx("king-damage", null, null, e.get("side", null), "-" + _num_s(float(e.get("amount", 0))), float(e.get("amount", 0)), "bad"))
			"king-heal":
				var kh := float(e.get("amount", 0))
				if kh > 0.0:
					out.append(_fx("king-heal", null, null, e.get("side", null), "+" + _num_s(kh), kh, "good"))
			"destroy":
				out.append(_fx("destroy", e.get("lane", null), e.get("row", null), e.get("side", null), str(e.get("name", "单位")), 0, "bad"))
			"turn-start":
				out.append(_fx("banner", null, null, null, "第 %s 回合" % _num_s(int(e.get("turn", 0))), 0, "neutral"))
			"combat-start":
				out.append(_fx("banner", null, null, null, "开战", 0, "neutral"))
	return out


func _fx(kind: String, lane, row, side, text: String, amount: float, tone: String) -> Dictionary:
	_fx_seq += 1
	return {"id": _fx_seq, "kind": kind, "lane": lane, "row": row, "side": side, "text": text, "amount": amount, "tone": tone}


static func _num_s(v) -> String:
	var f := KPC.fix_num(v if (v is int or v is float) else 0.0)
	if is_equal_approx(f, roundf(f)):
		return str(int(roundf(f)))
	return "%.1f" % f
