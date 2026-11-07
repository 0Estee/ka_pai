## 游戏常量 —— 移植自 engine/src/constants.js（对应《规则书 v0.2》§5 战场）
##
## 纯常量，不依赖任何其它脚本。
class_name KPConstants
extends RefCounted

## 四条线路，顺序即开战结算顺序：山地 → 平地(左) → 平地(右) → 水路
const LANES: Array[String] = ["mountain", "plainL", "plainR", "water"]

const LANE_NAME := {
	"mountain": "山地",
	"plainL": "平地(左)",
	"plainR": "平地(右)",
	"water": "水路",
}

## 相邻线路（用于「溅射」）。山地与平地(左)相邻，水路与平地(右)相邻。
const ADJACENT_LANES := {
	"mountain": ["plainL"],
	"plainL": ["mountain", "plainR"],
	"plainR": ["plainL", "water"],
	"water": ["plainR"],
}

## 两条排。front = 前排（可被普通交战命中），back = 后排（只受溅射/穿透影响）
const ROWS: Array[String] = ["front", "back"]
const ROW_NAME := {"front": "前排", "back": "后排"}

## 默认不可放置的线路（除非拥有 两栖 / 水生）
const DEFAULT_FORBIDDEN_LANES: Array[String] = ["water"]

## 玩家编号的中性名称。
## 注意：不要把玩家编号当成「先手/后手」—— 先后手由 state.first_player 决定。
const SIDE_NAME := {0: "玩家0", 1: "玩家1"}

## 一回合内的阶段顺序（对应规则书 §7）
const PHASES: Array[String] = [
	"TURN_START",    # 0. 上回合遗留效果结算（淬毒/疾病）+ 抽牌
	"DEPLOY_FIRST",  # 1. 先手放置单位
	"DEPLOY_SECOND", # 2. 后手放置单位
	"SPELL_FIRST",   # 3. 先手打出锦囊
	"SPELL_SECOND",  # 4. 后手打出锦囊
	"COMBAT",        # 5. 开战：山地 → 平地(左) → 平地(右) → 水路
	"TURN_END",      # 回合结束
]

## 阶段 → 该阶段允许打出的卡牌类型
const PHASE_ALLOWED_CARD_TYPE := {
	"DEPLOY_FIRST": "unit",
	"DEPLOY_SECOND": "unit",
	"SPELL_FIRST": "spell",
	"SPELL_SECOND": "spell",
}

## 卡牌类型
const CARD_TYPE := {"UNIT": "unit", "SPELL": "spell", "TRAP": "trap"}

## 国王初始生命值
const KING_MAX_HP := 20

## 「复生」复活时回复到几点生命。
## 作者已裁决：**回满血**，且复活**不触发**「被消灭:」异能。
const REBIRTH_HP := INF

## 第 1 回合是否也执行「回合开始各抽 1 张」。
const DRAW_ON_FIRST_TURN := true

## 回合上限：超过后按国王血量判胜负（裁决 A5）
const MAX_TURNS := 30

## 数值规范化（作者 2026-10-18 报的「强化加成会有浮点数」）。
##
## 强化按 0.1 一档累加、锦囊精通按 0.25 减费，而 IEEE754 的二进制小数存不下 0.1。
## 所以**所有写进单位 / 国王 / 费用的数值都必须过这一道**。保留两位小数足够。
static func fix_num(v: Variant) -> float:
	var n := 0.0
	if v is int or v is float:
		n = float(v)
	elif v is String:
		n = float(v) if v.is_valid_float() else 0.0
	if not is_finite(n):
		return 0.0
	var r := roundf(n * 100.0) / 100.0
	return 0.0 if r == 0.0 else r

## 第 N 回合的费用上限 = N（规则书 §6）
static func mana_cap_for_turn(turn: int) -> int:
	return turn

## 某个玩家在这一局里扮演先手还是后手
static func role_name(state, side: int) -> String:
	return "先手" if int(state.first_player) == side else "后手"
