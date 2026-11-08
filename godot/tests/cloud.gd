## 云存档自检：账号 / 令牌 / 存档上传下载 / 版本冲突。
##
## 需要一个本地假服务器（tools/cloud-mock.mjs），默认端口 8799：
##   node tools/cloud-mock.mjs --port 8799 &
##   node tools/godot.mjs --headless --path godot --script res://tests/cloud.gd
extends SceneTree

const CLOUD := preload("res://scripts/ui/kp_cloud.gd")
const SET := preload("res://scripts/ui/kp_settings.gd")
const PROF := preload("res://scripts/ui/kp_profile.gd")
const PAGE := preload("res://scripts/ui/kp_login_page.gd")

var base := "http://127.0.0.1:8799"
var problems: Array = []
var checks := 0


func _expect(cond: bool, what: String) -> void:
	checks += 1
	if not cond:
		problems.append(what)


func _initialize() -> void:
	for a in OS.get_cmdline_user_args():
		if a.begins_with("--base="):
			base = a.substr(7)
	_run()


func _run() -> void:
	var old_base := SET.cloud_base()
	var old_path := CLOUD.auth_path
	CLOUD.auth_path = "user://test_cloud_auth.json"
	if FileAccess.file_exists(CLOUD.auth_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(CLOUD.auth_path))
	SET.set_v(SET.CLOUD_BASE, base)

	var c = CLOUD.new()
	root.add_child(c)
	await process_frame
	_expect(c.base_url() == base, "服务器地址应取自设置，实得 %s" % c.base_url())
	_expect(not c.logged_in(), "初始应未登录")

	# 1) 注册
	var name := "qa%d" % (Time.get_ticks_usec() % 1000000)
	var r: Dictionary = await c.register(name, "secret123")
	_expect(bool(r.get("ok", false)), "注册应成功：%s" % str(r.get("message", "")))
	_expect(c.logged_in(), "注册后应已登录")
	_expect(c.username() == name, "用户名应为 %s，实得 %s" % [name, c.username()])
	_expect(FileAccess.file_exists(CLOUD.auth_path), "令牌应落盘")

	# 2) me
	var me: Dictionary = await c.me()
	_expect(bool(me.get("ok", false)), "me 应成功")
	_expect(str(me.get("data", {}).get("user", {}).get("username", "")) == name, "me 返回的用户名不对")

	# 3) 首次上传（baseVersion 0）
	var prof := PROF.default_profile()
	prof["gold"] = 321.0
	prof["forge"]["cards"] = {"U01": {"lvl": 3, "masteries": []}}
	var p1: Dictionary = await c.push_save(prof, 0)
	_expect(bool(p1.get("ok", false)), "首次上传应成功")
	_expect(c.version == 1, "上传后版本应为 1，实得 %d" % c.version)

	# 4) 用旧版本号再传：服务端必须拒绝（409）
	var p2: Dictionary = await c.push_save(prof, 0)
	_expect(not bool(p2.get("ok", true)) and bool(p2.get("conflict", false)), "旧版本号上传应判冲突")
	_expect(not c.conflict.is_empty(), "冲突应记下来等玩家裁决")

	# 5) 拉回来核对内容
	var f: Dictionary = await c.fetch_save()
	_expect(bool(f.get("ok", false)), "拉存档应成功")
	var save = f.get("save", null)
	_expect(save is Dictionary, "云端应有存档")
	if save is Dictionary:
		_expect(float(save["data"].get("gold", 0)) == 321.0, "云端金币应为 321，实得 %s" % str(save["data"].get("gold")))
		_expect(int(save.get("version", 0)) == 1, "云端版本应为 1")

	# 6) 用云端覆盖本机版本号后可以继续传
	var remote: Dictionary = c.take_remote()
	_expect(float(remote.get("gold", 0)) == 321.0, "take_remote 应返回云端数据")
	var p3: Dictionary = await c.push_save(prof, c.version)
	_expect(bool(p3.get("ok", false)), "对齐版本后上传应成功")
	_expect(c.version == 2, "版本应涨到 2，实得 %d" % c.version)

	# 7) 密码错：不能把已登录状态弄丢
	var bad: Dictionary = await c.login(name, "wrongpass")
	_expect(not bool(bad.get("ok", true)), "错密码应失败")
	_expect(c.logged_in(), "登录失败不应清掉已有的登录态")
	_expect(not str(bad.get("message", "")).is_empty(), "失败要有中文提示")

	# 8) 登出 / 再登录 / 改密码
	var lo: Dictionary = await c.logout()
	_expect(bool(lo.get("ok", false)), "登出应成功")
	_expect(not c.logged_in(), "登出后应未登录")
	_expect(not FileAccess.file_exists(CLOUD.auth_path), "登出应删掉本地令牌")

	var r2: Dictionary = await c.login(name, "secret123")
	_expect(bool(r2.get("ok", false)), "重新登录应成功")
	var f2: Dictionary = await c.fetch_save()
	_expect(bool(f2.get("ok", false)) and int((f2.get("save", {}) as Dictionary).get("version", 0)) == 2,
		"重新登录后应看到版本 2")
	var cp: Dictionary = await c.change_password("secret123", "secret456")
	_expect(bool(cp.get("ok", false)), "改密码应成功")

	# 9) 弱网 / 服务器不存在：要变成提示而不是崩
	var dead = CLOUD.new()
	root.add_child(dead)
	await process_frame
	SET.set_v(SET.CLOUD_BASE, "http://127.0.0.1:1")
	var bad2: Dictionary = await dead.login("x", "yyyyyy")
	_expect(not bool(bad2.get("ok", true)), "连不上服务器应失败")
	_expect(not str(bad2.get("message", "")).is_empty(), "连不上要有中文提示")
	SET.set_v(SET.CLOUD_BASE, base)
	dead.queue_free()

	# 10) 页面：未登录有 3 个输入框，登录后切成账户视图
	await c.logout()          # 页面要在未登录状态下建（已登录会直接进账户视图）
	var page = PAGE.new()
	root.add_child(page)
	page.size = page.DESIGN
	await process_frame
	await process_frame
	var edits := _count_type(page, "LineEdit")
	_expect(edits == 3, "未登录应有 3 个输入框，实得 %d" % edits)
	_expect(page.cloud != null and not page.cloud.logged_in(), "页面应带上自己的云端客户端")

	# 走一遍真登录：把输入框填好，点「登 录」
	page._user.text = name
	page._pass.text = "secret456"
	page._srv.text = base
	await page._do_login()
	_expect(page.cloud.logged_in(), "点登录后应已登录")
	_expect(_count_type(page, "LineEdit") == 0, "登录后应切成账户视图（没有输入框）")
	var st_text := ""
	for n in _walk(page):
		if n is Label and (str(n.text).find("上次同步") >= 0 or str(n.text).find("本机版本") >= 0):
			st_text = str(n.text)
	_expect(not st_text.is_empty(), "账户视图应显示同步状态")
	page.queue_free()
	await process_frame

	# 收尾：删掉测试账号的令牌文件、复原设置
	c.logout()
	c.queue_free()
	await process_frame
	if FileAccess.file_exists(CLOUD.auth_path):
		DirAccess.remove_absolute(ProjectSettings.globalize_path(CLOUD.auth_path))
	CLOUD.auth_path = old_path
	SET.set_v(SET.CLOUD_BASE, old_base)

	print("[cloud] checks=%d problems=%d" % [checks, problems.size()])
	for p in problems:
		print("  ✗ " + str(p))
	quit(0 if problems.is_empty() else 1)


func _walk(n: Node) -> Array:
	var out: Array = [n]
	for c in n.get_children():
		out.append_array(_walk(c))
	return out


func _count_type(n: Node, cls: String) -> int:
	var k := 0
	for x in _walk(n):
		if x.get_class() == cls:
			k += 1
	return k
