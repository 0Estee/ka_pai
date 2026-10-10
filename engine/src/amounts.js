/**
 * 动态数值与阵营工具：resolveAmount（动态数值）、resolveSide（阵营解析），
 * 以及把单位/国王包成「目标引用」的 asUnit / asKing。
 *
 * 从 effects.js 拆出（纯搬移，行为不变）：
 *   resolveAmount / resolveSide / asUnit / asKing
 *
 * 依赖方向：mechanics ← amounts ← targets/actions
 */

import { LANES, ADJACENT_LANES, LANE_NAME, SIDE_NAME } from './constants.js';
import { matchesTargetFilter } from './keywords.js';
import { filterCtx, hasRooted, getKeyword } from './auras.js';
import {
  dealDamage, destroyUnit, healUnit, healKing, buffAtk, buffMaxHp, debuffMaxHp,
  drawCards, gainMana, gainManaCap, laneUnits, allUnitsInLane, allUnits, log, freezeUnit,
  canMoveTo, moveUnitToLane, grantKeyword, vanishUnit, bounceUnit, setUnitStats,
  sealUnit, returnCardsToDeck, advanceStatStep, addDamageCap, revokeKeyword,
} from './mechanics.js';

/** 把单位包成「目标引用」 */
export const asUnit = (u) => (u ? { kind: 'unit', unit: u } : null);
export const asKing = (side) => ({ kind: 'king', side });

/**
 * 动态数值：`amount` 不再只能是裸数字。
 *
 *   { perOwnUnit: 2 }           己方场上单位数 × 2      （力量光波、宝藏）
 *   { perEnemyUnit: 1 }       敌方场上单位数 * 1    （万剑归宗）
 *   { perAllUnits: 1 }          场上**双方**单位总数 × 1 （石中剑）
 *   { perKeywordOfTarget: 1 }   目标的词条数 × 1        （第3补给营）
 *   { perKeywordOfTarget: { id:'combo', per: 1 } }      只看某个词条
 *   { perOwnEntry: 1 }          本局这张牌**进入战场**的次数 × 1（扫地僧）
 *   { sourceCostDelta: true }   来源单位当初打出来时的费用修正（僵尸）
 *   { sacrificedAtk: true }     刚被献祭单位的当前攻击力（鲜血祭典的回复量）
 *   { plus: 1 }                 在其它表达式的计算结果上再加 1（僵尸的「增加1」）
 *
 * 「队友」= 自己场上，「单位」= 场上双方（沿用裁决 D29 的「场上」口径）。
 * target 只在需要看目标的选择器里传；`perOwnEntry` / `sourceCostDelta` 看的是
 * **触发来源**（ctx.source）。裸数字不能用 `plus`（要写就直接写相加后的数）。
 */
export function resolveAmount(state, ctx, amount, target) {
  if (typeof amount === 'number') return amount;
  if (amount === null || amount === undefined) return 0;
  if (typeof amount !== 'object') throw new Error(`未知的 amount: ${amount}`);
  return resolveAmountBase(state, ctx, amount, target) + (amount.plus || 0);
}

function resolveAmountBase(state, ctx, amount, target) {
  const me = ctx.controller;
  const ownCount = () => allUnits(state).filter((u) => u.side === me).length;

  if (amount.perOwnUnit !== undefined) return amount.perOwnUnit * ownCount();
  /** 场上**敌方**单位数 * N（卡牌「万剑归宗」：对敌方单位造成的伤害 = 敌方单位数） */
  if (amount.perEnemyUnit !== undefined) {
    const foeCount = allUnits(state).filter((u) => u.side !== me).length;
    return amount.perEnemyUnit * foeCount;
  }
  if (amount.perAllUnits !== undefined) return amount.perAllUnits * allUnits(state).length;
  if (amount.perKeywordOfTarget !== undefined) {
    const u = target && target.unit;
    if (!u) return 0;
    const spec = amount.perKeywordOfTarget;
    const kws = u.keywords || [];
    const n = (typeof spec === 'object')
      ? kws.filter((k) => k.id === spec.id).length
      : kws.length;
    return (typeof spec === 'object' ? (spec.per || 1) : spec) * n;
  }
  /**
   * 本局**这张牌**进入战场的次数（各方各算自己的，作者 2026-09 裁决）。
   * 计数在 instantiateUnit 里自增，所以轮到「打出」异能结算时，这一次进场**已经算进去了**
   * —— 第一次打出就是 +1，第二次 +2。
   */
  if (amount.perOwnEntry !== undefined) {
    const src = ctx.source;
    const owner = src && state.players && state.players[me];
    const n = (owner && owner.entries && owner.entries[src.cardId]) || 0;
    return amount.perOwnEntry * n;
  }
  /** 来源单位当初从手牌打出来时，手牌上挂着多少费用修正（僵尸换代要继承它） */
  if (amount.sourceCostDelta) {
    const src = ctx.source;
    return src ? (src.paidCostDelta || 0) : 0;
  }
  /** 来源单位当前的攻击力（罪恶「色欲」的攻击时伤害 = 自己的攻击力） */
  if (amount.perSelfAtk !== undefined) {
    const src = ctx.source;
    return amount.perSelfAtk * (src ? (src.atk || 0) : 0);
  }
  if (amount.fixed !== undefined) return amount.fixed;
  /**
   * 被献祭单位的攻击力（卡牌「鲜血祭典」的回复量）。
   * 由 actions.js 的 sacrifice 动作记在 ctx 上：献祭与回复在同一条效果链里，
   * 所以 ctx.sacrificed 就是刚被献祭的那个单位（拿不到就是 0）。
   */
  if (amount.sacrificedAtk) return (ctx && ctx.sacrificed) ? (ctx.sacrificed.atk || 0) : 0;
  throw new Error(`未知的动态数值表达式: ${JSON.stringify(amount)}`);
}

export function resolveSide(side, controller) {
  if (side === undefined || side === null || side === 'controller') return controller;
  if (side === 'opponent') return 1 - controller;
  if (side === 'first') return 0;
  if (side === 'second') return 1;
  if (typeof side === 'number') return side;
  throw new Error(`未知的 side: ${side}`);
}
