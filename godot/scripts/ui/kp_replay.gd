## 对局回放：记录「种子 + 人类那一侧的动作序列」，回放时用同一副牌重跑一遍。
##
## 为什么这样够用：引擎是确定性的（同 seed 同牌库同动作 ⇒ 同结果，已由
## tests/parity.gd 与 JS 原版逐字节对拍验证过）。AI 不用录，重放时它自己会照
## 同一路走。所以一份回放只有几 KB。
class_name KPReplay
extends RefCounted

const DATA := preload("res://scripts/ui/kp_data.gd")

const DIR := "user://replays"
const VERSION := 1
const MAX_KEEP := 24


## 注意：这个 Godot 版本里 DirAccess.open("user://…") 会返回 null
## （FileAccess 用 user:// 没问题），所以目录操作一律走绝对路径。
static func _abs(path: String) -> String:
	return ProjectSettings.globalize_path(path)


static func ensure_dir() -> void:
	if not DirAccess.dir_exists_absolute(_abs(DIR)):
		DirAccess.make_dir_recursive_absolute(_abs(DIR))


## 存一份回放，返回文件路径
static func save(rec: Dictionary) -> String:
	ensure_dir()
	var r := rec.duplicate(true)
	r["version"] = VERSION
	r["savedAt"] = Time.get_datetime_string_from_system(false, false).replace(" ", "T")
	var name := "%s_seed%d_%d.json" % [r["savedAt"].replace(":", "").replace("T", "-"), int(r.get("seed", 0)), r.get("actions", []).size()]
	var path := DIR + "/" + name
	var f := FileAccess.open(path, FileAccess.WRITE)
	if f == null:
		return ""
	f.store_string(JSON.stringify(r))
	f.close()
	_trim()
	return path


static func _trim() -> void:
	var all := list()
	if all.size() <= MAX_KEEP:
		return
	for i in range(MAX_KEEP, all.size()):
		DirAccess.remove_absolute(_abs(str(all[i].path)))


## 新的在前
static func list() -> Array:
	ensure_dir()
	var out: Array = []
	var d := DirAccess.open(_abs(DIR))
	if d == null:
		return out
	for f in d.get_files():
		if not f.ends_with(".json"):
			continue
		var rec := _read(DIR + "/" + f)
		if rec.is_empty():
			continue
		out.append({"path": DIR + "/" + f, "rec": rec})
	out.sort_custom(func(a, b): return str(a.rec.get("savedAt", "")) > str(b.rec.get("savedAt", "")))
	return out


static func remove(path: String) -> void:
	DirAccess.remove_absolute(_abs(path))


static func count() -> int:
	return list().size()


static func _read(path: String) -> Dictionary:
	if not FileAccess.file_exists(path):
		return {}
	var f := FileAccess.open(path, FileAccess.READ)
	if f == null:
		return {}
	var txt := f.get_as_text()
	f.close()
	var parsed = JSON.parse_string(txt)
	return parsed if parsed is Dictionary else {}


# ── 展示用的摘要 ─────────────────────────────────────────────────────────────

static func headline(rec: Dictionary) -> String:
	var res: Dictionary = rec.get("result", {})
	var mine := int(rec.get("humanSide", 0))
	var win = res.get("winner", null)
	var verdict := "未完成"
	if win != null:
		verdict = "胜" if int(win) == mine else "负"
	return "种子 %d · %s · %d 回合 · %s" % [
		int(rec.get("seed", 0)), _diff_name(str(rec.get("difficulty", "normal"))),
		int(res.get("turns", 0)), verdict]


static func detail(rec: Dictionary) -> String:
	var res: Dictionary = rec.get("result", {})
	var bits: Array = []
	bits.append("我方 %s" % _faction_name(str(rec.get("humanFaction", ""))))
	bits.append("对手 %s" % _faction_name(str(rec.get("aiFaction", ""))))
	bits.append("%d 手操作" % rec.get("actions", []).size())
	var reason := str(res.get("winReason", ""))
	if reason != "":
		bits.append(reason)
	var at := str(rec.get("savedAt", "")).replace("T", " ")
	if at != "":
		bits.append(at.substr(5, 11))
	return " · ".join(bits)


static func _diff_name(key: String) -> String:
	for d in DATA.difficulties():
		if str(d.key) == key:
			return str(d.name)
	return key


static func _faction_name(key: String) -> String:
	if key == "":
		return "随机"
	var lib: Array = DATA.factions()
	for f in lib:
		if str(f.key) == key:
			return str(f.name)
	return key
