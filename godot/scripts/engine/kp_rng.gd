## 确定性伪随机数生成器（xorshift32）—— 移植自 engine/src/rng.js
##
## 为什么不用 RandomNumberGenerator：
##  1. 对局可完整复现（存一个种子就能重放整局）
##  2. 自动对战模拟需要可控的随机源
##  3. 联机时随机数可交由同一算法在两端推进，保证锁步
##
## 状态是一个 32 位无符号整数，可直接序列化进对局状态。
class_name KPRng
extends RefCounted

const DEFAULT_SEED := 0x9e3779b9

var state: int = DEFAULT_SEED


func _init(seed_: int = DEFAULT_SEED) -> void:
	seed_ = seed_ & 0xFFFFFFFF
	state = seed_ if seed_ != 0 else DEFAULT_SEED


## 推进随机数状态并返回 [0,1) 的浮点数
func next_float() -> float:
	var x: int = state & 0xFFFFFFFF
	x ^= (x << 13) & 0xFFFFFFFF
	x ^= x >> 17
	x ^= (x << 5) & 0xFFFFFFFF
	x &= 0xFFFFFFFF
	state = x
	return float(x) / 4294967296.0


## 返回 [0, max_exclusive) 的整数
func next_int(max_exclusive: int) -> int:
	if max_exclusive <= 0:
		return 0
	var v := int(floor(next_float() * float(max_exclusive)))
	return v % max_exclusive


## 以 probability 的概率返回 true
func chance(probability: float) -> bool:
	return next_float() < probability


## 在给定选项里等概率挑一个（空数组返回 null）
func pick(options: Array) -> Variant:
	if options.is_empty():
		return null
	return options[next_int(options.size())]


## Fisher-Yates 洗牌：**原地**打乱并返回同一个数组
func shuffle(arr: Array) -> Array:
	var i := arr.size() - 1
	while i > 0:
		var j := next_int(i + 1)
		var t: Variant = arr[i]
		arr[i] = arr[j]
		arr[j] = t
		i -= 1
	return arr


func snapshot() -> int:
	return state


func restore(s: int) -> void:
	state = (s & 0xFFFFFFFF) if (s & 0xFFFFFFFF) != 0 else DEFAULT_SEED
