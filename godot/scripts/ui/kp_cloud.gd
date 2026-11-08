## 云存档客户端：账号登录 / 存档双向同步（docs/云存档协议.md 的 GDScript 实现）。
##
## 与旧版 app/js/cloud.js 同一份契约，但按手机端的用法收窄了：
##   · token 只存在本机 user://cloud.json；
##   · 所有网络失败都收敛成中文提示放进返回值，**不抛异常** —— 云存档坏掉最多是
##     「这次没同步上」，不能让首页 / 对局崩；
##   · 存档冲突（409）绝不自动覆盖，交给玩家在账户页里二选一。
class_name KPCloud
extends Node

const SET := preload("res://scripts/ui/kp_settings.gd")

## 登录态落盘位置（测试会改到临时文件，别覆盖玩家的）
static var auth_path := "user://cloud.json"
## 单次请求超时：手机上弱网很常见，不能让「正在同步」永远转圈
const REQ_TIMEOUT := 16.0
## 服务端上限 64 KB（回放不同步，profile 正常只有几 KB）
const SAVE_MAX_BYTES := 64 * 1024

## 默认 API 根地址（APK 直连公网 Worker；网页端同源，但手机端没有同源概念）
const DEFAULT_BASE := "https://wangzuo.icu"

var auth: Dictionary = {}      # { token, username, role }
var version := 0               # 已知的云端版本号（PUT 的 baseVersion）
var last_sync_at := 0          # 最近一次成功同步的毫秒时间戳
var last_error := ""
var last_notice := ""
var conflict: Dictionary = {}  # { save: {data,version,updatedAt} }｜空=没有冲突

var _http: HTTPRequest
var _busy := false


func _ready() -> void:
	_http = HTTPRequest.new()
	_http.timeout = REQ_TIMEOUT
	add_child(_http)
	_load_auth()


# ── 地址与登录态 ─────────────────────────────────────────────

func base_url() -> String:
	return SET.cloud_base()


func set_base_url(url: String) -> void:
	SET.set_v(SET.CLOUD_BASE, url.strip_edges().trim_suffix("/"))


func logged_in() -> bool:
	return not str(auth.get("token", "")).is_empty()


func username() -> String:
	return str(auth.get("username", ""))


func role() -> String:
	return str(auth.get("role", ""))


func _load_auth() -> void:
	if not FileAccess.file_exists(auth_path):
		return
	var f := FileAccess.open(auth_path, FileAccess.READ)
	if f == null:
		return
	var txt := f.get_as_text()
	f.close()
	var data = JSON.parse_string(txt)
	if not (data is Dictionary):
		return
	auth = {
		"token": str(data.get("token", "")),
		"username": str(data.get("username", "")),
		"role": str(data.get("role", "")),
	}
	version = int(data.get("version", 0))
	last_sync_at = int(data.get("lastSyncAt", 0))


func _save_auth() -> void:
	var f := FileAccess.open(auth_path, FileAccess.WRITE)
	if f == null:
		return
	f.store_string(JSON.stringify({
		"token": str(auth.get("token", "")),
		"username": str(auth.get("username", "")),
		"role": str(auth.get("role", "")),
		"version": version,
		"lastSyncAt": last_sync_at,
	}))
	f.close()


func _clear_auth() -> void:
	auth = {}
	version = 0
	last_sync_at = 0
	conflict = {}
	if FileAccess.file_exists(auth_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(auth_path))


# ── 底层请求 ────────────────────────────────────────────────

func _url(path: String) -> String:
	return base_url() + path


func _req(method: String, path: String, body = null, with_token := true) -> Dictionary:
	if _http == null:
		return _fail("网络没准备好")
	# HTTPRequest 一次只能挂一个请求：撞上了就等前一个落地
	while _busy:
		await get_tree().process_frame
	_busy = true
	var headers := PackedStringArray(["Content-Type: application/json", "Accept: application/json"])
	if with_token and logged_in():
		headers.append("Authorization: Bearer " + str(auth["token"]))
	var payload := ""
	if body != null:
		payload = JSON.stringify(body)
	var m := HTTPClient.METHOD_GET
	match method:
		"POST":
			m = HTTPClient.METHOD_POST
		"PUT":
			m = HTTPClient.METHOD_PUT
		"DELETE":
			m = HTTPClient.METHOD_DELETE
	var err := _http.request(_url(path), headers, m, payload)
	if err != OK:
		_busy = false
		return _fail(_net_text(err))
	var res: Array = await _http.request_completed
	_busy = false
	var result := int(res[0])
	var code := int(res[1])
	var raw: PackedByteArray = res[3]
	if result != HTTPRequest.RESULT_SUCCESS:
		return _fail(_net_text(result))
	var text := raw.get_string_from_utf8()
	var data = JSON.parse_string(text)
	if not (data is Dictionary):
		data = {}
	var out := {"ok": code >= 200 and code < 300 and bool(data.get("ok", false)),
		"status": code, "data": data}
	if not bool(out["ok"]):
		out["error"] = str(data.get("error", "http-%d" % code))
		out["message"] = str(data.get("message", "服务器返回 %d" % code))
		last_error = str(out["message"])
	return out


func _fail(message: String) -> Dictionary:
	last_error = message
	return {"ok": false, "status": 0, "error": "net", "message": message, "data": {}}


func _net_text(code: int) -> String:
	match code:
		HTTPRequest.RESULT_CANT_CONNECT:
			return "连不上服务器，检查网络或服务器地址"
		HTTPRequest.RESULT_CANT_RESOLVE:
			return "域名解析失败，检查网络"
		HTTPRequest.RESULT_CONNECTION_ERROR:
			return "连接中断，稍后再试"
		HTTPRequest.RESULT_TIMEOUT:
			return "服务器没响应（超时）"
		_:
			return "网络错误（%d）" % code


# ── 账号 ────────────────────────────────────────────────────

func register(user: String, password: String) -> Dictionary:
	var r := await _req("POST", "/api/auth/register", {"username": user, "password": password}, false)
	if bool(r.get("ok", false)):
		_adopt(r["data"])
	return r


func login(user: String, password: String) -> Dictionary:
	var r := await _req("POST", "/api/auth/login", {"username": user, "password": password}, false)
	if bool(r.get("ok", false)):
		_adopt(r["data"])
	return r


func me() -> Dictionary:
	return await _req("GET", "/api/auth/me")


func logout() -> Dictionary:
	var r := await _req("POST", "/api/auth/logout")
	_clear_auth()
	return r


func change_password(current: String, next: String) -> Dictionary:
	var r := await _req("POST", "/api/auth/password",
		{"currentPassword": current, "newPassword": next})
	if bool(r.get("ok", false)):
		_adopt(r["data"])
	return r


func _adopt(data: Dictionary) -> void:
	var user = data.get("user", {})
	auth = {
		"token": str(data.get("token", "")),
		"username": str(user.get("username", "")) if user is Dictionary else "",
		"role": str(user.get("role", "")) if user is Dictionary else "",
	}
	version = 0
	last_sync_at = 0
	last_error = ""
	_save_auth()


# ── 存档 ────────────────────────────────────────────────────

## 拉云端存档：{ok, save: {data, version, updatedAt} 或 null}
func fetch_save() -> Dictionary:
	var r := await _req("GET", "/api/save")
	if not bool(r.get("ok", false)):
		return r
	var save = r["data"].get("save", null)
	if save is Dictionary:
		version = int(save.get("version", 0))
		_save_auth()
	return {"ok": true, "save": save, "status": int(r.get("status", 200))}


## 推本地存档：{ok, save} ；版本冲突时 {ok:false, conflict:true, save}
func push_save(profile: Dictionary, base_version: int) -> Dictionary:
	var payload := JSON.stringify(profile)
	if payload.to_utf8_buffer().size() > SAVE_MAX_BYTES:
		return _fail("存档太大（上限 64 KB）")
	var r := await _req("PUT", "/api/save", {"data": profile, "baseVersion": base_version})
	if bool(r.get("ok", false)):
		var save = r["data"].get("save", {})
		if save is Dictionary:
			version = int(save.get("version", 0))
			last_sync_at = Time.get_unix_time_from_system() * 1000
			_save_auth()
		return {"ok": true, "save": save}
	if int(r.get("status", 0)) == 409:
		var save = r["data"].get("save", {})
		conflict = {"save": save}
		return {"ok": false, "conflict": true, "save": save, "message": "云端存档比本机新"}
	return r


## 一局结束后自动上传：没登录就静默跳过，冲突记进 conflict 等玩家裁决
func auto_push(profile: Dictionary) -> Dictionary:
	if not logged_in():
		return {"ok": false, "skipped": true}
	return await push_save(profile, version)


## 玩家选了「用云端」：把云端 data 交出去，并把版本对齐
func take_remote() -> Dictionary:
	var save = conflict.get("save", {})
	conflict = {}
	if not (save is Dictionary):
		return {}
	version = int(save.get("version", 0))
	_save_auth()
	var data = save.get("data", {})
	return data if data is Dictionary else {}


## 玩家选了「用本地」：拿云端当前版本当 baseVersion 再推一次
func force_push(profile: Dictionary) -> Dictionary:
	var f := await fetch_save()
	if not bool(f.get("ok", false)):
		return f
	var r := await push_save(profile, version)
	conflict = {}
	return r
