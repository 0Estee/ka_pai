/**
 * 门面：机制层（所有会修改 GameState 的基础原语）的对外出入口。
 *
 * ⚠ 本文件只做转发，实现已按职责拆到：
 *   board.js    场地与单位（log / findUnit / laneUnits / allUnits / 移动 / 弹射 / destroyUnit / vanishUnit）
 *   damage.js   伤害、死亡与状态标记（dealDamage / queueTrigger / 冻结 / 伤害封顶 / 属性改写）
 *   stats.js    词条与牌库（grantKeyword / sealUnit / buffAtk / drawCards / 费用）
 *
 * 上层（effects / engine / auras 以及 app/js/*.js）继续 import 这个文件即可，一行都不用改。
 * 导出名与拆分前**完全一致**。
 *
 * 依赖方向：keywords ← mechanics ← effects ← engine
 */

import {
  log, findUnit, laneUnits, allUnitsInLane, allUnits, enemyFrontUnit, enemyCombatTarget,
  findBodyguard, removeUnitFromBoard, destroyUnit, vanishUnit, canMoveTo, moveUnitToLane, bounceUnit,
} from './board.js';
import {
  dealDamage, queueTrigger, queueKingTrigger, healUnit, healKing,
  damageCapFor, addDamageCap, freezeUnit, consumeFreeze, checkNimble, checkAllNimble,
  debuffMaxHp, setUnitStats, advanceStatStep,
} from './damage.js';
import {
  grantKeyword, expireTimedKeywords, sealUnit, isSealed, revokeKeyword, returnCardsToDeck,
  buffAtk, buffMaxHp, drawCards, gainManaCap, gainMana, transformUnit, lockAtk, buffKeywordX,
} from './stats.js';

export {
  log, findUnit, laneUnits, allUnitsInLane, allUnits, enemyFrontUnit, enemyCombatTarget,
  findBodyguard, removeUnitFromBoard, canMoveTo, moveUnitToLane, bounceUnit,
  destroyUnit, vanishUnit, dealDamage, queueTrigger, queueKingTrigger, healUnit, healKing,
  damageCapFor, addDamageCap, freezeUnit, consumeFreeze, checkNimble, checkAllNimble,
  grantKeyword, expireTimedKeywords, sealUnit, isSealed, revokeKeyword, returnCardsToDeck,
  buffAtk, buffMaxHp, debuffMaxHp, setUnitStats, advanceStatStep, drawCards, gainManaCap, gainMana, lockAtk, buffKeywordX,
  transformUnit,
};
