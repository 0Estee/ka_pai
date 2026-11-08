## 账号与云存档页（作者 m01990 第 17 条）。
##
## 未登录：用户名 + 密码 + 服务器地址，两个按钮（登 录 / 注 册）。
## 已登录：显示账号与同步状态，给「上传本机存档 / 下载云端存档 / 退出登录」。
## 存档版本冲突（409）不自动覆盖，弹一块「用云端 / 用本地」让玩家自己选。
class_name KPLoginPage
extends "res://scripts/ui/kp_page.gd"

const CLOUD := preload("res://scripts/ui/kp_cloud.gd")
const PROF := preload("res://scripts/ui/kp_profile.gd")

var cloud
var _user: LineEdit
var _pass: LineEdit
var _srv: LineEdit
var _status: Label
var _busy := false
var _conflict_box: Control


func _init() -> void:
	title_text = "登 录"
	crumb_text = "账号 · 云存档 · 同步"


func _fill() -> void:
	anim = SET.anim_scale()
	cloud = CLOUD.new()
	add_child(cloud)
	await get_tree().process_frame
	if cloud.logged_in():
		_build_account()
	else:
		_build_form()


# ── 未登录 ──────────────────────────────────────────────────

func _build_form() -> void:
	crumb_text = "账号 · 云存档 · 同步"
	var card := _row(0, 268, "登录 / 注册", "同一个账号，金币、强化与战绩跟着走", U.GOLD)
	_reveal(card)

	_field(card, "用户名", 64, "_user")
	_field(card, "密码", 128, "_pass")
	_field(card, "服务器", 192, "_srv")
	_srv.text = cloud.base_url()

	_status = U.label("", 13, U.DIM)
	_status.position = Vector2(30, 286)
	_status.size = Vector2(660, 44)
	_status.clip_text = false
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	body.add_child(_status)
	_reveal(_status)

	var login_b := _button("登 录", Vector2(318, 52), Vector2(30, 344), func(): _do_login(), U.GOLD)
	_reveal(login_b)
	var reg_b := _button("注 册", Vector2(318, 52), Vector2(372, 344), func(): _do_register(), U.FACTION)
	_reveal(reg_b)
	var back := _button("回 首 页", Vector2(318, 48), Vector2(30, 410), func(): close_requested.emit(), U.LINE)
	_reveal(back)

	var note := U.label("不登录也能玩：存档只在本机。登录后同一份档案随账号走，换手机不用重练。",
		12, U.DIM)
	note.position = Vector2(30, 480)
	note.size = Vector2(660, 60)
	note.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	note.clip_text = false
	body.add_child(note)
	_reveal(note)


func _field(parent: Control, label: String, y: float, which: String) -> void:
	var cap := U.label(label, 12, U.DIM)
	cap.position = Vector2(18, y)
	cap.size = Vector2(120, 18)
	cap.clip_text = false
	parent.add_child(cap)
	var e := LineEdit.new()
	e.position = Vector2(18, y + 20)
	e.size = Vector2(624, 44)
	e.add_theme_font_size_override("font_size", 17)
	e.add_theme_color_override("font_color", U.TEXT)
	e.add_theme_color_override("font_placeholder_color", Color(U.DIM, 0.7))
	e.add_theme_stylebox_override("normal", U.box(Color(0.06, 0.08, 0.12, 0.9), 10, Color(U.LINE, 0.7), 1))
	e.add_theme_stylebox_override("focus", U.box(Color(0.08, 0.11, 0.17, 0.95), 10, U.GOLD, 2))
	e.placeholder_text = "填手机号或昵称" if which == "_user" else ("至少 6 位" if which == "_pass" else "https://...")
	if which == "_pass":
		e.secret = true
	parent.add_child(e)
	if which == "_user":
		_user = e
	elif which == "_pass":
		_pass = e
	else:
		_srv = e


func _do_login() -> void:
	if _busy:
		return
	_busy = true
	_set_status("正在登录……", U.DIM)
	cloud.set_base_url(_srv.text)
	var r: Dictionary = await cloud.login(_user.text.strip_edges(), _pass.text)
	_busy = false
	if bool(r.get("ok", false)):
		await _after_login("登录成功")
	else:
		_set_status(_msg(r), U.BAD)


func _do_register() -> void:
	if _busy:
		return
	_busy = true
	_set_status("正在注册……", U.DIM)
	cloud.set_base_url(_srv.text)
	var r: Dictionary = await cloud.register(_user.text.strip_edges(), _pass.text)
	_busy = false
	if bool(r.get("ok", false)):
		await _after_login("注册成功")
	else:
		_set_status(_msg(r), U.BAD)


## 登录成功之后：把云端存档拉下来对齐（有云端就交给玩家选，没有就把本机推上去）
func _after_login(prefix: String) -> void:
	_set_status(prefix + "，正在对齐存档……", U.GOOD)
	var f: Dictionary = await cloud.fetch_save()
	if not bool(f.get("ok", false)):
		_set_status(prefix + "（" + _msg(f) + "）", U.GOLD)
		await _rebuild()
		return
	var save = f.get("save", null)
	var local := PROF.load_profile()
	if save == null:
		var p: Dictionary = await cloud.push_save(local, 0)
		_set_status(prefix + "，本机存档已上传" if bool(p.get("ok", false)) else prefix + "（" + _msg(p) + "）",
			U.GOOD if bool(p.get("ok", false)) else U.BAD)
	elif bool(save.get("data", {}) == local):
		cloud.version = int(save.get("version", 0))
		_set_status(prefix + "，云端与本机一致", U.GOOD)
	else:
		_set_status(prefix + "，云端已有存档，请选择用哪一份", U.GOLD)
	await _rebuild()


# ── 已登录 ──────────────────────────────────────────────────

func _build_account() -> void:
	crumb_text = "账号 · 云存档 · 同步"
	var card := _row(0, 208, cloud.username(), "已登录 · 服务器 " + cloud.base_url(), U.GOOD)
	_reveal(card)
	var role := U.label("管理员" if cloud.role() == "admin" else "普通玩家", 13, U.DIM)
	role.position = Vector2(18, 64)
	role.size = Vector2(300, 20)
	role.clip_text = false
	card.add_child(role)
	var vers := U.label(_sync_text(), 13, U.GOLD)
	vers.position = Vector2(18, 92)
	vers.size = Vector2(620, 20)
	vers.clip_text = false
	vers.set_meta("sync", true)
	card.add_child(vers)
	var info := U.label("同步范围：金币、星尘、表现分、战绩、强化记录。回放不同步（文件太大）。",
		12, U.DIM)
	info.position = Vector2(18, 120)
	info.size = Vector2(620, 60)
	info.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	info.clip_text = false
	card.add_child(info)

	_status = U.label("", 13, U.DIM)
	_status.position = Vector2(30, 226)
	_status.size = Vector2(660, 44)
	_status.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
	_status.clip_text = false
	body.add_child(_status)
	_reveal(_status)

	var up := _button("上 传 本 机 存 档", Vector2(318, 52), Vector2(30, 286), func(): _do_push(), U.GOLD)
	_reveal(up)
	var down := _button("下 载 云 端 存 档", Vector2(318, 52), Vector2(372, 286), func(): _do_pull(), U.MANA)
	_reveal(down)
	var out := _button("退 出 登 录", Vector2(318, 48), Vector2(30, 352), func(): _do_logout(), U.LINE)
	_reveal(out)
	var back := _button("回 首 页", Vector2(318, 48), Vector2(372, 352), func(): close_requested.emit(), U.LINE)
	_reveal(back)

	if not cloud.conflict.is_empty():
		_build_conflict()


func _sync_text() -> String:
	if cloud.last_sync_at <= 0:
		return "本机版本 %d · 尚未同步" % cloud.version
	var dt := Time.get_unix_time_from_system() * 1000.0 - float(cloud.last_sync_at)
	return "本机版本 %d · 上次同步 %d 分钟前" % [cloud.version, int(dt / 60000.0)]


func _do_push() -> void:
	if _busy:
		return
	_busy = true
	_set_status("正在上传……", U.DIM)
	var r: Dictionary = await cloud.push_save(PROF.load_profile(), cloud.version)
	_busy = false
	if bool(r.get("ok", false)):
		_set_status("已上传（版本 %d）" % cloud.version, U.GOOD)
		await _rebuild()
	elif bool(r.get("conflict", false)):
		_set_status("云端有更新的存档，请选择用哪一份", U.GOLD)
		await _rebuild()
	else:
		_set_status(_msg(r), U.BAD)


func _do_pull() -> void:
	if _busy:
		return
	_busy = true
	_set_status("正在下载……", U.DIM)
	var f: Dictionary = await cloud.fetch_save()
	_busy = false
	if not bool(f.get("ok", false)):
		_set_status(_msg(f), U.BAD)
		return
	var save = f.get("save", null)
	if save == null:
		_set_status("云端还没有存档", U.GOLD)
		return
	var data = save.get("data", {})
	if data is Dictionary:
		PROF.save_profile(_merge_profile(data))
		cloud.version = int(save.get("version", 0))
		cloud.last_sync_at = int(Time.get_unix_time_from_system() * 1000.0)
		_set_status("已下载云端存档", U.GOOD)
	else:
		_set_status("云端存档格式不对", U.BAD)
	await _rebuild()


func _do_logout() -> void:
	if _busy:
		return
	_busy = true
	await cloud.logout()
	_busy = false
	await _rebuild()


func _msg(r: Dictionary) -> String:
	return str(r.get("message", "失败"))


func _set_status(text: String, col: Color) -> void:
	if _status != null and is_instance_valid(_status):
		_status.text = text
		_status.add_theme_color_override("font_color", col)


func _rebuild() -> void:
	# 页面的内容全在 body 里：清掉重来最省事，也不用追踪每块控件的引用
	for c in body.get_children():
		c.queue_free()
	await get_tree().process_frame
	if cloud.logged_in():
		_build_account()
	else:
		_build_form()


# ── 冲突裁决 ────────────────────────────────────────────────

func _build_conflict() -> void:
	var box := _row(430, 196, "存档冲突", "云端与本机不是同一版，选一份覆盖另一边", U.BAD)
	_reveal(box)
	_conflict_box = box
	var remote = cloud.conflict.get("save", {})
	var note := "云端版本 %d · 更新于 %s" % [int(remote.get("version", 0)) if remote is Dictionary else 0,
		_time_text(remote.get("updatedAt", 0)) if remote is Dictionary else "—"]
	var lab := U.label(note, 12, U.DIM)
	lab.position = Vector2(18, 64)
	lab.size = Vector2(620, 20)
	lab.clip_text = false
	box.add_child(lab)
	var use_cloud := _button("用 云 端", Vector2(190, 46), Vector2(18, 100), func(): _use_cloud(), U.MANA)
	box.add_child(use_cloud)
	var use_local := _button("用 本 机", Vector2(190, 46), Vector2(226, 100), func(): _use_local(), U.GOLD)
	box.add_child(use_local)


func _time_text(ms: int) -> String:
	if ms <= 0:
		return "—"
	var sec := int(ms / 1000)
	return Time.get_datetime_string_from_unix_time(sec, true)


func _use_cloud() -> void:
	var data: Dictionary = cloud.take_remote()
	if data.is_empty():
		_set_status("云端存档是空的", U.BAD)
		return
	PROF.save_profile(_merge_profile(data))
	cloud.last_sync_at = int(Time.get_unix_time_from_system() * 1000.0)
	_set_status("已用云端存档覆盖本机", U.GOOD)
	await _rebuild()


func _use_local() -> void:
	_busy = true
	_set_status("正在上传……", U.DIM)
	var r: Dictionary = await cloud.force_push(PROF.load_profile())
	_busy = false
	if bool(r.get("ok", false)):
		_set_status("已用本机存档覆盖云端", U.GOOD)
		await _rebuild()
	else:
		_set_status(_msg(r), U.BAD)


## 云端来的 profile 只取认识的字段，缺的用默认值补齐（服务端不校验形状）
func _merge_profile(data: Dictionary) -> Dictionary:
	var out := PROF.default_profile()
	for k in ["gold", "dust", "perf", "games", "wins", "losses", "draws"]:
		if data.has(k):
			out[k] = float(data[k])
	var forge = data.get("forge", null)
	if forge is Dictionary and forge.get("cards", null) is Dictionary:
		out["forge"] = {"v": 1, "cards": forge.cards}
	return out
