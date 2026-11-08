## 房间传输层：把 docs/联机协议.md 的 HTTP 接口包成三个方法。
##
## 走的是公网房间服务（cloudflare/src/room.js）：每条请求都要带 room=房间号。
## 长轮询是协议里的「回落路径」——WebSocket 更省电，但长轮询在两代服务端上都可用，
## 所以手机端先用它，界面与锁步逻辑不受影响。
class_name KPRoom
extends Node

const DEFAULT_BASE := "https://wangzuo.icu"
## 服务端把长轮询挂起的上限（协议 §2.4）
const POLL_MAX_MS := 20000

var base := DEFAULT_BASE
var who := "host"          # 'host' | 'guest'
var room_code := ""
var player_name := ""
## 已经处理到第几条消息（下一轮 poll 从这里要）
var since := 0
var last_error := ""
var stopped := false


func setup(who_: String, code: String, name_: String, base_: String = "") -> void:
	who = "guest" if who_ == "guest" else "host"
	room_code = code.strip_edges().to_upper()
	player_name = name_
	var b := base_
	if b.strip_edges() == "":
		b = DEFAULT_BASE
	b = b.strip_edges()
	while b.ends_with("/"):
		b = b.substr(0, b.length() - 1)
	base = b


func site() -> String:
	return base


func url(path: String, extra: Dictionary = {}) -> String:
	var q := "who=%s&room=%s" % [who.uri_encode(), room_code.uri_encode()]
	if player_name != "":
		q += "&name=" + player_name.uri_encode()
	for k in extra.keys():
		q += "&%s=%s" % [str(k).uri_encode(), str(extra[k]).uri_encode()]
	return "%s%s?%s" % [base, path, q]


## 一条 HTTP 请求。返回服务端的 JSON（失败时带 ok=false 与中文 message）。
func _go(method: int, url_text: String, body: String = "", timeout_s: float = 16.0) -> Dictionary:
	if stopped:
		return {"ok": false, "error": "stopped", "message": "已经离开房间"}
	var http := HTTPRequest.new()
	http.timeout = timeout_s
	add_child(http)
	# 刚 new 出来、还没进树时 request() 会直接失败（ERR_UNCONFIGURED）：等一帧再发
	if not http.is_inside_tree():
		var loop := Engine.get_main_loop()
		if loop is SceneTree:
			await loop.process_frame
	if not is_instance_valid(http):
		return {"ok": false, "error": "gone", "message": "连接已关闭"}
	var headers := PackedStringArray(["Content-Type: application/json"])
	var err := http.request(url_text, headers, method, body)
	if err != OK:
		http.queue_free()
		last_error = "网络请求发不出去"
		return {"ok": false, "error": "request", "message": "网络请求发不出去（%d）" % err}
	var res: Array = await http.request_completed
	if not is_instance_valid(http):
		return {"ok": false, "error": "gone", "message": "连接已关闭"}
	http.queue_free()
	var result := int(res[0])
	var http_code := int(res[1])
	var raw: PackedByteArray = res[3]
	if result != HTTPRequest.RESULT_SUCCESS:
		var text := _result_text(result)
		last_error = text
		return {"ok": false, "status": http_code, "error": "net", "message": text}
	var data: Variant = JSON.parse_string(raw.get_string_from_utf8())
	if not (data is Dictionary):
		last_error = "服务端返回的不是 JSON"
		return {"ok": false, "status": http_code, "error": "json", "message": "服务端返回的不是 JSON"}
	if http_code >= 400 and not data.has("ok"):
		data["ok"] = false
	data["http"] = http_code
	return data


func _result_text(result: int) -> String:
	match result:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "连不上房间服务器"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "解析不了服务器地址"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "网络连接断开"
		HTTPRequest.RESULT_TIMEOUT:
			return "请求超时"
		HTTPRequest.RESULT_TLS_HANDSHAKE_ERROR:
			return "安全连接失败"
	return "网络错误（%d）" % result


## 发一条协议消息（POST /api/send）
func send_msg(msg: Dictionary) -> Dictionary:
	var r: Dictionary = await _go(HTTPClient.METHOD_POST, url("/api/send"), JSON.stringify(msg))
	return r


## 收消息（长轮询 GET /api/poll）。timeout_ms 传 0 表示「只收不挂起」。
func poll(timeout_ms: int = 12000) -> Dictionary:
	var t := clampi(timeout_ms, 0, POLL_MAX_MS)
	var r: Dictionary = await _go(
		HTTPClient.METHOD_GET,
		url("/api/poll", {"since": since, "timeout": t}),
		"",
		float(t) / 1000.0 + 9.0,
	)
	if bool(r.get("ok", false)):
		# 服务端按 seq > since（不含等号）过滤，所以 since 要停在「最后一条已收的 seq」上，
		# 不能 +1 —— 否则两条消息连发时后一条会被永久跳过。
		var msgs: Array = r.get("msgs", [])
		if msgs.is_empty():
			since = maxi(since, int(r.get("now", since)))
		else:
			for m in msgs:
				if m is Dictionary:
					since = maxi(since, int(m.get("seq", since)))
	return r


func info() -> Dictionary:
	return await _go(HTTPClient.METHOD_GET, url("/api/room"), "", 12.0)


func start_room() -> Dictionary:
	return await _go(HTTPClient.METHOD_POST, url("/api/start"), "", 12.0)


func leave() -> void:
	if stopped:
		return
	stopped = true
	await _go(HTTPClient.METHOD_POST, url("/api/leave"), "", 8.0)
