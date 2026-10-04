/**
 * 光环层：卡牌对**其他单位**（或对自身按条件）产生的持续影响。
 *
 * 为什么单独一层、而不是像「造成伤害:获得+1/+1」那样直接改 unit.atk？
 *
 *   永久加成（吸血鬼的 +1/+1）写进 unit.atk 就对了，因为它一旦获得就不会消失。
 *   光环不同 —— 拷问官一死，-3 攻就该立刻消失；密命王牌旁边一有队友，
 *   +3 攻就该立刻消失。如果也直接改 unit.atk，就必须在每次棋盘变动时
 *   「撤销上一次、再重新加上」，一旦某个时机漏了就永久错值。
 *
 * 所以这里采取**读取时计算**：unit.atk 永远只存「永久值」，
 * 需要真实攻击力时调用 effectiveAtk() 现场叠加光环。
 * 棋盘最多 8 个单位，重复计算的开销可以忽略。
 *
 * 依赖方向：keywords ← mechanics ← auras ← engine
 */

import { ADJACENT_LANES } from './constants.js';
import { allUnits, buffMaxHp, debuffMaxHp } from './mechanics.js';
import { hasKw } from './keywords.js';

/**
 * 卡牌定义里的光环写法（放在 def.auras）。
 *
 *   {
 *     kind: 'buffAtk',        // 改攻击力（amount 可为负 = 减攻）
 *     amount: -3,
 *     to: 'laneEnemies',      // 作用对象
 *     condition: 'noOtherAllies',  // 可选，附加条件
 *   }
 *   {
 *     kind: 'grantKeyword',
 *     keyword: 'rooted',      // 授予某词条
 *     to: 'laneEnemies',
 *   }
 *
 * to 的取值：
 *   'self'           自身
 *   'laneEnemies'    同线路上、光环来源的敌对单位
 *   'rootedEnemies'  全场上所有敌方「扎根」单位
 */

/** 收集棋盘上全部生效中的光环（来源已离场的、被封印的自动忽略） */
function liveAuras(state) {
  const out = [];
  for (const source of allUnits(state)) {
    if (source.removed) continue;
    // 被封印的单位光环也停（卡牌「大封印碑：封印敌方所有单位的特殊效果」）
    if (source.sealed) continue;
    const def = state.cardLib[source.cardId];
    if (!def || !def.auras) continue;
    for (const aura of def.auras) out.push({ source, aura });
  }
  return out;
}

/** 光环来源是否满足自身条件 */
function conditionMet(state, source, condition) {
  if (!condition) return true;
  if (condition === 'noOtherAllies') {
    // 「场上没有队友时」—— 定义成全场（而不是同线路）没有其他友方单位
    return !allUnits(state).some((u) => u !== source && u.side === source.side);
  }
  // 「♥>2 时获得…」（卡牌「格斗家」）：按条件写成 { hpAbove: 2 } 或 { hpAtLeast: 3 }
  if (condition.hpAbove !== undefined) return source.hp > condition.hpAbove;
  if (condition.hpAtLeast !== undefined) return source.hp >= condition.hpAtLeast;
  throw new Error(`未知的光环条件: ${JSON.stringify(condition)}`);
}

/** 某条线路的相邻线路（不含自己）*/
const adjacentOf = (lane) => ADJACENT_LANES[lane] || [];

/** 「自己和相邻线」= 自身所在线路 + 相邻线路（作者补充规则）*/
export const selfAndAdjacentLanes = (lane) => [lane, ...adjacentOf(lane)];

/** 光环的作用对象判定（不含 rootedEnemies，那个要看 rootedSet） */
function appliesTo(state, source, aura, target) {
  if (target.removed) return false;
  if (!conditionMet(state, source, aura.condition)) return false;
  switch (aura.to) {
    case 'self':
      return target === source;
    case 'laneEnemies':
      return target.side !== source.side && target.lane === source.lane;
    /** 全场所有敌人（卡牌「大封印碑：在场:封印敌方所有单位的特殊效果」） */
    case 'allEnemies':
      return target.side !== source.side;
    /** 「自己和相邻线上的队友」（卡牌「战棋」）—— 含自己 */
    case 'selfAndAdjacentLaneAllies':
      return target.side === source.side && selfAndAdjacentLanes(source.lane).includes(target.lane);
    case 'laneAllies':
      return target.side === source.side && target.lane === source.lane;
    /** 「后方的队友」（卡牌「永恒秘典」）—— 同线路后排的友军，不含自己 */
    case 'laneBackRowAllies':
      return target.side === source.side && target.lane === source.lane
        && target.row === 'back' && target !== source;
    case 'rootedEnemies':
      return target.side !== source.side && rootedSet(state).has(target);
    default:
      throw new Error(`未知的光环作用对象 to: ${aura.to}`);
  }
}

/**
 * 光环**授予**的词条 —— 通用版，支持任意词条，不只是「扎根」。
 *
 * 早期版本只把 grantKeyword 用在了 rooted 上（拷问官），
 * 于是「♥>2 时获得穿透」这类卡会**静默失效**：光环挂上了，但没人读。
 * 现在所有授予都进这张表，需要判词条时用 hasKeyword / getKeyword / allKeywordsOf。
 *
 * 返回 Map<单位, [{id, x}]>。
 */
export function grantedKeywordMap(state) {
  const out = new Map();
  for (const { source, aura } of liveAuras(state)) {
    if (aura.kind !== 'grantKeyword') continue;
    if (aura.to === 'rootedEnemies') {
      throw new Error('授予类光环不能以 rootedEnemies 为对象（会无限递归）');
    }
    if (!conditionMet(state, source, aura.condition)) continue;
    for (const target of allUnits(state)) {
      if (target.removed) continue;
      const hit = auraTargetHit(source, aura, target);
      if (!hit) continue;
      if (!out.has(target)) out.set(target, []);
      const list = out.get(target);
      if (!list.some((k) => k.id === aura.keyword)) list.push({ id: aura.keyword, x: aura.x || 0 });
    }
  }
  return out;
}

/** 光环的作用对象是否命中某单位（不含 rootedEnemies，那个要看 rootedSet） */
function auraTargetHit(source, aura, target) {
  switch (aura.to) {
    case 'self': return target === source;
    case 'laneEnemies': return target.side !== source.side && target.lane === source.lane;
    case 'allEnemies': return target.side !== source.side;
    case 'laneAllies': return target.side === source.side && target.lane === source.lane;
    case 'laneBackRowAllies':
      return target.side === source.side && target.lane === source.lane
        && target.row === 'back' && target !== source;
    case 'selfAndAdjacentLaneAllies':
      return target.side === source.side && selfAndAdjacentLanes(source.lane).includes(target.lane);
    default: return false;
  }
}

/** 单位身上的**全部有效词条** = 自带的 + 光环授予的 */
export function allKeywordsOf(state, unit) {
  if (!unit || unit.removed) return [];
  /**
   * 被封印的单位：**除攻击力、生命之外的一切都不生效**（作者 2026-09 裁决）。
   *
   * 两种封印都要算：
   *   · 一次性 `sealUnit`（禁军 / 卫兵 / 感染「清空其本身的异能」）—— 看 `unit.sealed`
   *   · 「在场」式封印光环（大封印碑）—— 看 isSealedByAura
   *
   * 以前这里**只**处理了光环封印，一次性封印只停 effects，于是
   * 「被封印的战棋仍然给相邻队友加攻」—— 作者的裁决就是冲着这个来的。
   * 现在统一成「两种封印都让词条归零」，与「封印 = 特殊效果全停」一致。
   */
  if (unit.sealed || isSealedByAura(state, unit)) return [];
  const own = (unit.keywords || []).slice();
  const granted = grantedKeywordMap(state).get(unit) || [];
  for (const g of granted) if (!own.some((k) => k.id === g.id)) own.push(g);
  return own;
}

/**
 * 状态感知的「有没有某词条」——**引擎里读词条都应该走这个**，
 * 而不是 keywords.js 里那个只看单位自身的 hasKw。
 * （hasKw 仍然有用：它不依赖 state，适合卡牌定义、放置合法性这类场景。）
 */
export function hasKeyword(state, unit, id) {
  return allKeywordsOf(state, unit).some((k) => k.id === id);
}

/** 状态感知的「取某词条实例（含 x）」，没有返回 null */
export function getKeyword(state, unit, id) {
  return allKeywordsOf(state, unit).find((k) => k.id === id) || null;
}

/**
 * 被**光环式封印**的单位（卡牌「大封印碑：在场:封印敌方所有单位的特殊效果」）。
 *
 * 与一次性 `sealUnit` 的区别：这是持续效果，大封印碑一离场就立刻解封。
 * 收集时只看来源身上的 `sealed` 显式标记（不看本函数的集合），
 * 所以「两块封印碑互相封」不会递归。
 */
export function auraSealedSet(state) {
  // ⚠️ 递归防护：算这个集合本身会走到 rootedSet → allKeywordsOf → hasKeyword
  //    → 又回到本函数。重入时直接返回上一次的结果，而不是无限递归。
  if (state._sealedComputing) return state._sealedCache || new Set();
  state._sealedComputing = true;
  const set = new Set();
  try {
  for (const { source, aura } of liveAuras(state)) {
    if (aura.kind !== 'seal') continue;
    if (!conditionMet(state, source, aura.condition)) continue;
    for (const target of allUnits(state)) {
      if (target.removed || target === source) continue;
      if (auraTargetHit(source, aura, target)) set.add(target);
    }
  }
  state._sealedCache = set;
  return set;
  } finally {
    state._sealedComputing = false;
  }
}

/** 单位是否因为「封印光环」而不能发动异能 */
export function isSealedByAura(state, unit) {
  if (!unit || unit.removed) return false;
  return auraSealedSet(state).has(unit);
}

/**
 * 场上所有「扎根」单位（含光环授予的）。
 *
 * 授予类光环只允许用不依赖 rootedSet 的 to（self / laneEnemies / laneAllies /
 * selfAndAdjacentLaneAllies），否则「扎根的敌人获减攻」和「给敌人扎根」会互相递归。
 */
export function rootedSet(state) {
  const set = new Set();
  for (const u of allUnits(state)) {
    if (!u.removed && hasKw(u, 'rooted')) set.add(u);
  }
  for (const [unit, kws] of grantedKeywordMap(state)) {
    if (kws.some((k) => k.id === 'rooted')) set.add(unit);
  }
  return set;
}

/** 单位是否带「扎根」（含光环授予的）。「扎根」= 无法被弹射。 */
export function hasRooted(state, unit) {
  if (!unit || unit.removed) return false;
  if (hasKw(unit, 'rooted')) return true;
  return rootedSet(state).has(unit);
}

/** 单位当前受到的光环攻击力修正（可为负） */
export function auraAtkDelta(state, unit) {
  if (!unit || unit.removed) return 0;
  // 被封印的单位不吃任何光环（作者 2026-09：「除攻血之外的一切都不生效」）。
  // 少了这一句，「被封印的战棋仍然享受队友加成」就会留下来。
  if (unit.sealed || isSealedByAura(state, unit)) return 0;
  let delta = 0;
  for (const { source, aura } of liveAuras(state)) {
    if (aura.kind !== 'buffAtk') continue;
    if (!appliesTo(state, source, aura, unit)) continue;
    delta += aura.amount;
  }
  return delta;
}

/**
 * 单位的**有效攻击力** = 永久值 + 光环修正，且不会低于 0。
 * 交战、伤害计算、界面显示、AI 评估都必须走这里，
 * 不能直接读 unit.atk（那是永久值，不含光环）。
 */
export function effectiveAtk(state, unit) {
  if (!unit) return 0;
  return Math.max(0, unit.atk + auraAtkDelta(state, unit));
}

/**
 * 供 matchesTargetFilter 用的上下文。
 *
 * `source` = **这道效果是谁发出的**（单位对象；锦囊/环境效果为 null）。
 * 「无法选中」靠它判「是不是它自己的效果」作者 2026-10 口径：
 * 「**不能被除自身效果以外任何效果影响**」，所以只有"来源就是它自己"才放行。
 * 不传（界面/AI/规则测试等拿不到来源的场合）→ 保守拒绝，等价于旧行为。
 */
export function filterCtx(state, source) {
  return {
    atkOf: (u) => effectiveAtk(state, u),
    isRooted: (u) => hasRooted(state, u),
    source,
  };
}
/**
 * 「在场」式**属性光环**的物化同步（卡牌「降噪耳机：在场:所有敌方单位-1攻击力-1生命」）。
 *
 * 为什么要物化：攻击力那一半是**读取时**算的（auraAtkDelta + effectiveAtk），
 * 但 maxHp / hp 是**存下来的数值**，没有读取时叠加的余地，只能真的改上去。
 * 所以这里做成**幂等对账**：
 *   want = 当前所有生效中的 buffMaxHp 光环对该单位的总和（被封印记 0，与 auraAtkDelta 一致）
 *   have = unit.auraMaxHp（上一次已经施加到身上的量）
 *   diff = want - have，少了就补、多了就还回去，最后把 auraMaxHp 记成 want
 * 于是光环来源一进场，敌方全场的生命上限与当前生命立刻 -1（1 血的当场阵亡）；
 * 来源一离场，还活着的单位把这一份还回来（已阵亡的不复活）。
 *
 * 物化的是「光环给的 maxHp/hp 修正」，与 buffAtk 那条读取时通道互不重叠，不会重复计算。
 * 调用点：凡是会改变单位集合的流程跑完一轮后都要调一次
 * （play.js 的 playCard / damage.js 的 dealDamage / combat.js 的 summonToken 与 runCombat /
 *   turns.js 的 onTurnStart 与 sacrificeUnit）。
 */
export function syncStatAuras(state) {
  if (state._syncingAuras) return;
  state._syncingAuras = true;
  try {
    for (const unit of allUnits(state)) {
      if (unit.removed) continue;
      let want = 0;
      if (!unit.sealed && !isSealedByAura(state, unit)) {
        for (const { source, aura } of liveAuras(state)) {
          if (aura.kind !== 'buffMaxHp') continue;
          if (!appliesTo(state, source, aura, unit)) continue;
          want += aura.amount || 0;
        }
      }
      const have = unit.auraMaxHp || 0;
      const diff = want - have;
      if (diff === 0) continue;
      if (diff > 0) buffMaxHp(state, unit, diff);
      else debuffMaxHp(state, unit, -diff);
      if (unit.removed) continue;
      unit.auraMaxHp = want;
    }
  } finally {
    state._syncingAuras = false;
  }
}
