## 联机锁步会话（docs/联机协议.md §3 / §4 / §8）。
##
## 职责：把 KPSession 的每一手操作先本地落地、再按序号广播；收到对手的操作同样执行一次。
## 引擎是确定性的，所以两端只交换操作，不交换棋盘。每 8 步互发一次状态指纹，
## 一旦对不上立刻停下并提示（而不是各自跑飞）。
class_name KPNet
extends Node

signal sig_status(text: String)         # 连接状态（给大厅显示）
signal sig_peer(text: String)           # 对手信息（进房/换阵营）
signal sig_started                      # 开局了：界面该进对局屏（session 已经建好）
signal sig_left                         # 对手离开
signal sig_conflict(text: String)       # 两端跑飞
signal sig_restart                      # 对手请求重开（只有房主收得到）

const ROOM := preload("res://scripts/ui/kp_room.gd")
const KPSession := preload("res://scripts/ui/kp_session.gd")
const KPC := preload("res://scripts/engine/kp_constants.gd")

## 每执行多少步互发一次指纹（协议 §5）
const HASH_EVERY := 8

var who := "host"
var my_side := 0
var is_host := true
var room = null                 # KPRoom
var session = null              # KPSession
var player_name := "玩家"
var local_faction := ""
var peer_name := ""
var peer_faction := ""
var peer_enhance = null
## 自己这一侧的工坊增量表（进房时 hello 带过去，房主开局时拼进 start）
var local_enhance: Dictionary = {}
var status := "idle"
var conflict := ""
var started := false
## 已经应用过的 start 轮次（重开时房主发 r+1；同一个 r 重复到达要忽略）
var applied_r := -1
var step := 0
var history: Array = []
var early: Array = []
var running := false
var watchers := 0

var _queue: Array = []
var _worker_on := false
var _out: Array = []
var _sender_on := false
var debug_trace := false
## 每落地一步就记一条 {step, k, h}：自检时两端逐条比对（步数+操作+指纹）
var trace: Array = []
var _catchup_at := 0
var _pending_cfg: Dictionary = {}


# ── 进房 ────────────────────────────────────────────────────────────────────

func open(who_: String, code: String, name_: String, base_url: String = "") -> void:
	who = "guest" if who_ == "guest" else "host"
	is_host = who == "host"
	my_side = 0 if is_host else 1
	player_name = name_ if name_.strip_edges() != "" else "玩家"
	room = ROOM.new()
	add_child(room)
	room.setup(who, code, player_name, base_url)
	running = true
	_set_status("连接中…")
	_worker_on = true
	_worker()
	_sender_on = true
	_sender()
	_receive()


func site() -> String:
	return room.site() if room != null else ""

func room_code() -> String:
	return room.room_code if room != null else ""


func hello() -> void:
	_send({"t": "hello", "name": player_name, "faction": local_faction,
		"forge": not local_enhance.is_empty(), "enhance": local_enhance})


func set_faction(key: String) -> void:
	local_faction = key
	_send({"t": "faction", "key": key})


# ── 开局 ────────────────────────────────────────────────────────────────────

## 房主开局：先把 start 发出去（等服务器确认），再本地建局（协议 §8.1）
func begin(cfg: Dictionary) -> void:
	if not is_host:
		return
	var msg := {
		"t": "start", "r": int(cfg.get("r", 0)),
		"seed": int(cfg.get("seed", 0)),
		"firstPlayer": int(cfg.get("firstPlayer", 0)),
		"deck": cfg.get("deck", []),
		"factions": cfg.get("factions", []),
		"hostFaction": str(cfg.get("hostFaction", "")),
		"guestFaction": str(cfg.get("guestFaction", "")),
		"enhance": cfg.get("enhance", []),
		"mode": str(cfg.get("mode", "normal")),
	}
	await room.start_room()
	var ack: Dictionary = await room.send_msg(msg)
	if not bool(ack.get("ok", false)):
		_set_status("开局消息没发出去：%s" % str(ack.get("message", "网络错误")))
		return
	await _start_session(cfg)


func _start_session(cfg: Dictionary) -> void:
	_pending_cfg = cfg.duplicate(true)
	applied_r = int(cfg.get("r", 1))
	started = true
	step = 0
	history.clear()
	session = KPSession.new()
	session.net = self
	await session.start(cfg)
	sig_started.emit()
	# start 之前抢跑到的操作：现在有棋盘了，按原顺序补执行
	var queued := early.duplicate()
	early.clear()
	for a in queued:
		if a is Dictionary:
			_enqueue({"a": a, "n": int(a.get("n", step)), "item": null})
	_auto_pump()


## 本地要执行一条操作：进队列 → 落地 → 广播（串行，保证序号一致）
func submit(a: Dictionary) -> bool:
	if conflict != "" or session == null or not started:
		return false
	var item := {"ok": false, "done": false}
	_enqueue({"a": a, "n": -1, "item": item})
	var loop := Engine.get_main_loop()
	var guard := 0
	while not bool(item.get("done", false)):
		if not (loop is SceneTree):
			return false
		guard += 1
		if guard > 3000:
			# 队列卡住（对手掉线 / 已中止）：不能让界面一直等下去
			_set_status("操作没有落地，请检查网络")
			return false
		if conflict != "":
			return false
		await loop.process_frame
	return bool(item.get("ok", false))


## 答案 / 认输这类不能 await 的动作（界面回调里用）
func submit_nowait(a: Dictionary) -> void:
	if conflict != "" or session == null:
		return
	_enqueue({"a": a, "n": -1, "item": null})


# ── 队列与发送 ──────────────────────────────────────────────────────────────

func _enqueue(job: Dictionary) -> void:
	_queue.append(job)
	if not _worker_on:
		_worker_on = true
		_worker()


func _worker() -> void:
	while _queue.size() > 0 and running:
		var job: Dictionary = _queue.pop_front()
		var a: Dictionary = job.get("a", {})
		var n := int(job.get("n", -1))
		if n >= 0:
			if n < step:
				_set_item(job, true)      # 重复（重连补发）：忽略
				continue
			if n > step:
				_request_catch_up()       # 中间缺包：不硬执行
				_set_item(job, false)
				continue
		var ok: bool = await session.net_apply(a)
		if ok:
			var send_n := step
			history.append(a)
			if history.size() > 400:
				history = history.slice(history.size() - 400)
			step += 1
			_send({"t": "act", "a": a, "n": send_n})
			if step % HASH_EVERY == 0:
				_send({"t": "hash", "step": step, "h": state_hash(session.game.state)})
		_set_item(job, ok)
		if session != null and session.game != null:
			trace.append({"n": step, "k": str(a.get("k", "")), "h": state_hash(session.game.state)})
			if trace.size() > 2000:
				trace = trace.slice(trace.size() - 1500)
		if debug_trace:
			var ph := "-"
			var hh := "-"
			if session != null and session.game != null:
				ph = str(session.game.state.get("phase", ""))
				hh = state_hash(session.game.state)
			print("[trace:%s] step=%d k=%s ok=%s n=%d phase=%s h=%s" % [who, step, str(a.get("k", "")), str(ok), n, ph, hh])
		_maybe_auto()
	_worker_on = false


## 请求重开（客人也能发；重开由房主执行）
func ask_restart() -> void:
	_send({"t": "restart-req"})


## 房主重开：沿用同一份开局参数，轮次 +1（对端看到 start 就重建一局）
func restart() -> void:
	if not is_host or _pending_cfg.is_empty():
		return
	var cfg: Dictionary = _pending_cfg.duplicate(true)
	cfg["r"] = int(cfg.get("r", 1)) + 1
	await begin(cfg)


func _set_item(job: Dictionary, ok: bool) -> void:
	var item = job.get("item", null)
	if item is Dictionary:
		item["ok"] = ok
		item["done"] = true


## 自动阶段（回合开始 / 开战 / 回合结束）只由房主推进，客人只跟着执行（协议 §8）
func _maybe_auto() -> void:
	if not is_host or session == null or not started or conflict != "":
		return
	if session.is_over() or session.game.has_pending():
		return
	if session.game.get_actor() == null:
		_enqueue({"a": {"k": "a"}, "n": -1, "item": null})


func _auto_pump() -> void:
	_maybe_auto()


func _send(msg: Dictionary) -> void:
	if room == null or not running:
		return
	_out.append(msg)
	if not _sender_on:
		_sender_on = true
		_sender()


func _sender() -> void:
	while _out.size() > 0 and running:
		var msg: Dictionary = _out.pop_front()
		var r: Dictionary = await room.send_msg(msg)
		if not bool(r.get("ok", false)):
			_set_status("发送失败：%s" % str(r.get("message", "网络错误")))
	_sender_on = false


# ── 收消息 ──────────────────────────────────────────────────────────────────

func _receive() -> void:
	var fails := 0
	while running:
		var r: Dictionary = await room.poll(12000)
		if not running:
			break
		if not bool(r.get("ok", false)):
			if str(r.get("error", "")) == "peer-left":
				_peer_left("对手离开了房间")
				break
			fails += 1
			_set_status("重连中…（%s）" % str(r.get("message", "网络错误")))
			var loop := Engine.get_main_loop()
			if loop is SceneTree:
				await loop.create_timer(minf(2.0, 0.4 * fails)).timeout
			continue
		fails = 0
		if status != "已连接":
			_set_status("已连接")
		watchers = int(r.get("watchers", watchers))
		for m in r.get("msgs", []):
			if m is Dictionary:
				handle_message(m.get("msg", {}), str(m.get("from", "")))


func handle_message(msg: Dictionary, from: String) -> void:
	if msg.is_empty() or from == who:
		return
	match str(msg.get("t", "")):
		"hello":
			peer_name = str(msg.get("name", ""))
			if msg.get("enhance", null) is Dictionary:
				peer_enhance = msg.get("enhance", {})
			if peer_faction == "":
				peer_faction = str(msg.get("faction", ""))
			_signal_peer()
		"faction":
			peer_faction = str(msg.get("key", ""))
			_signal_peer()
		"start":
			var r := int(msg.get("r", 1))
			if started and r <= applied_r:
				return
			await _start_session(msg)
		"act":
			if not started:
				if early.size() < 400:
					early.append(msg.get("a", {}))
				return
			_enqueue({"a": msg.get("a", {}), "n": int(msg.get("n", step)), "item": null})
		"need":
			if not started:
				return
			var from_i := maxi(0, int(msg.get("from", 0)))
			_send({"t": "give", "from": from_i, "list": history.slice(from_i, from_i + 400)})
		"give":
			if not started or int(msg.get("from", -1)) != step:
				return
			for a in msg.get("list", []):
				if a is Dictionary:
					_enqueue({"a": a, "n": -1, "item": null})
		"hash":
			if not started or conflict != "":
				return
			if int(msg.get("step", -1)) > step:
				_request_catch_up()
				return
			if int(msg.get("step", -1)) == step:
				var mine := state_hash(session.game.state)
				if mine != str(msg.get("h", "")):
					_conflict("与对手的进度不一致（第 %d 步：%s vs %s）" % [step, mine, str(msg.get("h", ""))])
		"bye":
			_peer_left("对手已退出")
		"restart-req":
			if is_host:
				sig_restart.emit()
		"ping":
			pass


func _signal_peer() -> void:
	var who_text := peer_name if peer_name != "" else "对手"
	if peer_faction != "":
		who_text += "（%s）" % peer_faction
	sig_peer.emit(who_text)


func _request_catch_up() -> void:
	var now := Time.get_ticks_msec()
	if now - _catchup_at < 2500:
		return
	_catchup_at = now
	_send({"t": "need", "from": step})


func _peer_left(text: String) -> void:
	if conflict != "":
		return
	running = false
	_set_status("已断开")
	sig_left.emit()


func _conflict(text: String) -> void:
	conflict = text
	running = false
	_set_status("已中止")
	sig_conflict.emit(text)


func _set_status(text: String) -> void:
	if status == text:
		return
	status = text
	sig_status.emit(text)


func close(reason: String = "") -> void:
	if not running:
		return
	# 先把告别消息真正发出去再收工：_send 在 running=false 之后会直接丢弃，
	# 对端就只能等服务器判定掉线（或被当成失步），所以这里直接走 room.send_msg。
	if room != null:
		await room.send_msg({"t": "bye", "reason": reason})
	running = false
	if room != null:
		await room.leave()


# ── 状态指纹（协议 §5，与 app/js/multiplayer.js 的 stateHash 同算法） ────────

static func state_signature(st: Dictionary) -> String:
	var parts: Array = []
	parts.append(str(int(st.get("turn", 0))))
	parts.append(str(st.get("phase", "")))
	var w = st.get("winner", null)
	parts.append("-" if w == null else str(int(w)))
	var p0: Dictionary = st.players[0]
	var p1: Dictionary = st.players[1]
	parts.append(_num_text(p0.kingHp))
	parts.append(_num_text(p1.kingHp))
	parts.append(str(p0.hand.size()))
	parts.append(str(p1.hand.size()))
	for lane in KPC.LANES:
		for side in 2:
			for row in KPC.ROWS:
				var u = st.board[lane].units[side][row]
				if u == null:
					parts.append("-")
				else:
					parts.append("%s:%s:%s:%s" % [str(u.cardId), _num_text(u.atk), _num_text(u.hp), _num_text(u.maxHp)])
	return "|".join(PackedStringArray(parts))


static func _num_text(v) -> String:
	var f := float(v)
	if absf(f - roundf(f)) < 0.000001:
		return str(int(roundf(f)))
	return "%.2f" % f


static func state_hash(st: Dictionary) -> String:
	var s := state_signature(st)
	var h := 2166136261
	for i in s.length():
		h = (h ^ s.unicode_at(i)) & 0xFFFFFFFF
		h = _imul(h, 16777619)
	return _hex(h)


static func _hex(v: int) -> String:
	const DIGITS := "0123456789abcdef"
	var out := ""
	var n := v & 0xFFFFFFFF
	for i in 8:
		out = DIGITS[n & 0xF] + out
		n = n >> 4
	return out.lstrip("0") if out.lstrip("0") != "" else "0"


## 32 位乘法（GDScript 的 int 是 64 位，直接乘会溢出成另一套结果）
static func _imul(a: int, b: int) -> int:
	var ah := (a >> 16) & 0xFFFF
	var al := a & 0xFFFF
	return ((ah * b << 16) + al * b) & 0xFFFFFFFF
