## 占位页：还没做的入口先摊开说清楚，不装样子。
##
## 首页「更多」里已经有位置，但功能排在后面的批次里（强化 / 登录 / 靶场 / 观战）。
## 用同一套光球语言的页面壳，写清「要做什么 / 现在做到哪 / 什么时候有」。
class_name KPTodoPage
extends "res://scripts/ui/kp_page.gd"


var head_text := "还 在 做"
var crumb_line := ""
var lines: Array = []        # [{text, col, size}]
var note_text := ""
var when_text := ""


func _init() -> void:
	title_text = "还 在 做"


func _fill() -> void:
	anim = SET.anim_scale()
	var card := _row(0, 300, head_text, crumb_line, U.GOLD)
	_reveal(card)
	var y := 58.0
	for item in lines:
		var l := U.label(str(item.get("text", "")), int(item.get("size", 14)),
			item.get("col", U.TEXT))
		l.position = Vector2(18, y)
		l.size = Vector2(620, float(item.get("h", 24)))
		l.clip_text = true
		l.autowrap_mode = TextServer.AUTOWRAP_WORD_SMART
		card.add_child(l)
		y += float(item.get("h", 24)) + 6.0

	if when_text != "":
		_note(when_text, 320, U.DIM, 13, 22)
	if note_text != "":
		_note(note_text, 348, Color(U.DIM, 0.8), 12, 20)

	var back := _button("回 首 页", Vector2(220, 52), Vector2(250, 540), func(): close_requested.emit(), U.LINE)
	_reveal(back)
