/**
 * 目标选择器的解析：selector → 目标引用数组（需要玩家选择时会 yield）。
 *
 * 从 effects.js 拆出（纯搬移，行为不变）：
 *   describeTarget / resolveTargets（另含内部工具 requireLane）
 *
 * 依赖方向：mechanics/auras/keywords ← targets ← actions
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
import { asUnit, asKing } from './amounts.js';

/** 目标引用的可读名（用于日志与提示） */
export function describeTarget(t) {
  if (!t) return '无';
  if (t.kind === 'king') return `${SIDE_NAME[t.side]}国王`;
  return `${t.unit.name}#${t.unit.uid}`;
}

/**
 * 解析目标选择器，返回目标引用数组。
 * 需要玩家选择时会 yield。
 *
 * ctx 中可用：source / controller / chosenLane / chosenTargetUid
 */
export function* resolveTargets(state, ctx, selector) {
  if (!selector) return [];
  const { controller: me, source } = ctx;
  const foe = 1 - me;

  /**
   * 批量选择器统一走这里：**过滤器必须生效**。
   *
   * 早期版本让 allEnemyUnits / allOwnUnits 直接返回全部单位、**完全忽略 filter**，
   * 于是「平地上的所有敌人获得-1⚔-1♥」（酸雨）这类卡写不出正确效果 ——
   * 而且不会报错，只会安静地把整场都打一遍。现在统统过 matchesTargetFilter。
   */
  const batch = (list) => {
    /**
     * ⚠一律过 matchesTargetFilter，**不能只在写了 filter 时才过**：
     * 「无法选中」本身就是过滤器的一部分（见 keywords.js），
     * 没有 filter 的批量选择器（如「所有敌方单位」）也必须把它排除掉，
     * 否则范围伤害照样能打到它 —— 而作者的口径是「不可被影响」。
     */
    const filtered = list.filter((u) => matchesTargetFilter(u, selector.filter, filterCtx(state, source)));
    return filtered.map(asUnit);
  };

  // ── 不需要选择的选择器
  switch (selector.kind) {
    case 'self':
      return asUnit(source) ? [asUnit(source)] : [];

    case 'ownKing':
      return [asKing(me)];

    case 'enemyKing':
      return [asKing(foe)];

    case 'allOwnUnits':
      return batch(allUnits(state).filter((u) => u.side === me));

    case 'allEnemyUnits':
      return batch(allUnits(state).filter((u) => u.side === foe));

    /** 场上**双方**所有单位（卡牌「灭世：消灭场上所有单位」） */
    case 'allUnits':
      return batch(allUnits(state));

    /**
     * 「有敌人受到伤害时，对其造成X点伤害」里的那个「其」。
     * 目标来自触发事件的 payload，不需要玩家选择。
     */
    case 'triggerVictim': {
      const victim = ctx.payload && ctx.payload.victim;
      return victim && !victim.removed ? [asUnit(victim)] : [];
    }

    case 'allEnemyUnitsInLane': {
      const lane = ctx.chosenLane;
      if (!lane) yield* requireLane(ctx, selector);
      return batch(laneUnits(state, ctx.chosenLane, foe));
    }

    case 'adjacentEnemyUnits': {
      const lane = ctx.chosenLane;
      if (!lane) yield* requireLane(ctx, selector);
      const out = [];
      for (const adj of ADJACENT_LANES[ctx.chosenLane]) out.push(...laneUnits(state, adj, foe));
      return batch(out);
    }

    /**
     * 来源所在线路上的**双方**所有单位。
     * 卡面「自己线上的所有单位」用的是「单位」不是「敌人」
     * （导弹、青蛙），所以不能用只含敌方的 allEnemyUnitsInLane 顶替。
     */
    case 'allUnitsInLane': {
      const lane = ctx.chosenLane;
      if (!lane) yield* requireLane(ctx, selector);
      return batch(allUnitsInLane(state, ctx.chosenLane));
    }

    case 'allLanesEnemyUnitsInLane': {
      // 用于「溅射」：所有线路上的敌方单位
      const out = [];
      for (const lane of LANES) out.push(...laneUnits(state, lane, foe));
      return batch(out);
    }

    /**
     * 生命最低的敌方单位（卡牌「鲸鲨：打出:消灭一名♥最低的敌人」）。
     * 平手时取 uid 最小的那个 —— 结果确定，不依赖遍历顺序的记忆。
     * 不需要玩家点选。
     */
    case 'lowestHpEnemyUnit': {
      let pool = allUnits(state).filter((u) => u.side === foe);
      pool = pool.filter((u) => matchesTargetFilter(u, selector.filter, filterCtx(state, source)));
      if (pool.length === 0) return [];
      let best = pool[0];
      for (const u of pool) {
        if (u.hp < best.hp || (u.hp === best.hp && u.uid < best.uid)) best = u;
      }
      return [asUnit(best)];
    }

    case 'chosenEnemyUnit':
    case 'chosenOwnUnit':
    case 'chosenEnemyFront': {
      const wantSide = selector.kind === 'chosenOwnUnit' ? me : foe;

      // 调用方已直接指定目标（UI 点选 / AI 决策）——优先使用，不再发起交互。
      // 即便调用方直接指定，也要过一遍过滤器，保证引擎是最终权威：
      // 界面/AI 的 bug 不会让非法目标生效。
      if (ctx.chosenTargetUid != null) {
        const picked = allUnits(state).find((u) => u.uid === ctx.chosenTargetUid);
        if (!picked) return [];
        if (!matchesTargetFilter(picked, selector.filter, filterCtx(state, source))) return [];
        return [asUnit(picked)];
      }

      let options = allUnits(state).filter((u) => u.side === wantSide);
      if (selector.kind === 'chosenEnemyFront' && ctx.chosenLane) {
        options = options.filter((u) => u.lane === ctx.chosenLane && u.row === 'front');
      }
      // 统一走 matchesTargetFilter（支持 maxAtk / row / keyword 等条件，
      // 例如「滚石：消灭一名攻击力≤2的敌人」）
      if (selector.filter) {
        options = options.filter((u) => matchesTargetFilter(u, selector.filter, filterCtx(state, source)));
      }
      if (options.length === 0) return [];

      const answer = yield {
        type: 'chooseUnit',
        side: me,
        prompt: selector.prompt || `选择一个${SIDE_NAME[wantSide]}单位`,
        options: options.map((u) => ({ uid: u.uid, label: `${u.name} (${u.atk}/${u.hp}) ${LANE_NAME[u.lane]}-${u.row}` })),
      };
      const picked = options.find((u) => u.uid === answer.uid);
      return picked ? [asUnit(picked)] : [];
    }

    /**
     * 敌方单位**或敌方国王** —— 用于卡面只写「造成X点伤害」而不限定目标的牌。
     *
     * 作者裁决：这类牌可以选择国王作为目标（推翻了原先「攻击性锦囊不能指定国王」的假设）。
     * selector.allowKing === false 可以关掉打国王，只留单位。
     * selector.filter 只作用于单位，对国王无效（国王不是单位，没有攻击力/词条）。
     */
    case 'chosenEnemyTarget': {
      const allowKing = selector.allowKing !== false;

      // 调用方已直接指定目标（UI 点选 / AI 决策）——优先使用，不再发起交互。
      // allowKing:false 的卡牌即使被错误地指定了国王，也必须无效。
      if (ctx.chosenTargetIsKing) {
        return allowKing ? [asKing(foe)] : [];
      }
      if (ctx.chosenTargetUid != null) {
        const picked = allUnits(state).find((u) => u.uid === ctx.chosenTargetUid);
        if (!picked) return [];
        if (!matchesTargetFilter(picked, selector.filter, filterCtx(state, source))) return [];
        return [asUnit(picked)];
      }

      const options = [];
      for (const u of allUnits(state)) {
        if (u.side !== foe) continue;
        if (!matchesTargetFilter(u, selector.filter, filterCtx(state, source))) continue;
        options.push({
          uid: u.uid,
          label: `${u.name} (${u.atk}/${u.hp}) ${LANE_NAME[u.lane]}-${u.row === 'front' ? '前排' : '后排'}`,
        });
      }
      if (allowKing) {
        options.push({
          king: true,
          side: foe,
          label: `${SIDE_NAME[foe]}的国王（♥ ${state.players[foe].kingHp}）`,
        });
      }
      if (options.length === 0) return [];

      const answer = yield {
        type: 'chooseEnemyTarget',
        side: me,
        prompt: selector.prompt || '选择敌方单位或敌方国王',
        options,
      };
      if (answer && answer.king) return [asKing(answer.side)];
      const picked = allUnits(state).find((u) => u.uid === (answer ? answer.uid : null));
      return picked ? [asUnit(picked)] : [];
    }

    default:
      throw new Error(`未知的目标选择器: ${selector.kind}`);
  }
}

/** 需要一个线路选择时，向驱动器请求 */
function* requireLane(ctx, selector) {
  const answer = yield {
    type: 'chooseLane',
    side: ctx.controller,
    prompt: selector.prompt || '选择一条线路',
    options: LANES.map((l) => ({ lane: l, label: LANE_NAME[l] })),
  };
  ctx.chosenLane = answer.lane;
}
