/**
 * 回合与阶段：阶段机、回合开始/结束的结算、各种终局判定。
 *
 * 从 engine.js 拆出（纯搬移，行为不变）：
 *   startGame / getActor / isOver / enterPhase / advance / onTurnStart / onTurnEnd /
 *   resolveByDeckOut / resolveMarks / resolveByTurnLimit / checkGameOver /
 *   triggerInHandEffects / applyHandStatDelta
 *
 * ⚠️ startGame 放这里而不是 setup.js：它一开头就要调 enterPhase，
 *    放在 setup.js 会把 setup ←→ turns 绕成环。
 *
 * 依赖方向：mechanics ← setup ← turns ← play/choices/combat
 */

import {
  LANES, ROWS, SIDE, SIDE_NAME, LANE_NAME, PHASES, PHASE_ACTOR,
  PHASE_ALLOWED_CARD_TYPE, CARD_TYPE, KING_MAX_HP, MAX_TURNS, ADJACENT_LANES,
  manaCapForTurn, DRAW_ON_FIRST_TURN, roleName,
} from './constants.js';
import { createRng, shuffle } from './rng.js';
import { parseKeyword, getKw, hasKw, canPlaceInLane } from './keywords.js';
import * as M from './mechanics.js';
import { giveStartingSuperpowers } from './factions.js';
import { effectiveAtk, hasRooted, hasKeyword, getKeyword, isSealedByAura } from './auras.js';
import { execActions } from './effects.js';
import { runCombat, apiFor } from './combat.js';
import { returnExpiredTraps, expireRevealedTraps, sacrificeUnitOnBoard } from './board.js';
import { flushTriggers, driveGenerator } from './choices.js';
import { PENDING } from './setup.js';

// ══════════════════════════════════════════════════════════
// 回合与阶段
// ══════════════════════════════════════════════════════════

/**
 * 当前可以行动的玩家。
 *
 * 注意：必须在运行时按 state.firstPlayer 解析，不能查 PHASE_ACTOR 常量表。
 * 「先手/后手」是开局随机决定后**固定不变**的角色（规则书 §4），
 * 而 DEPLOY_FIRST 里的 "FIRST" 指的是「先手」这个角色，不是玩家编号 0。
 * 早期版本硬编码成了玩家 0，导致 firstPlayer=1 时先后手完全颠倒。
 */
export function getActor(state) {
  switch (state.phase) {
    case 'DEPLOY_FIRST':
    case 'SPELL_FIRST':
      return state.firstPlayer;
    case 'DEPLOY_SECOND':
    case 'SPELL_SECOND':
      return 1 - state.firstPlayer;
    default:
      return null; // 抽牌 / 开战 / 回合结束等自动阶段
  }
}

export function isOver(state) {
  return state.winner !== null;
}

export function enterPhase(state, phase) {
  if (isOver(state)) return state.phase;
  state.phase = phase;
  // 陷阱：到了「下一回合的同类型阶段」还没触发就回手（作者 2026-10 口径）
  if (phase === 'DEPLOY_FIRST' || phase === 'DEPLOY_SECOND') returnExpiredTraps(state, 'deploy');
  else if (phase === 'SPELL_FIRST' || phase === 'SPELL_SECOND') returnExpiredTraps(state, 'spell');
  if (phase === 'TURN_START') onTurnStart(state);
  /**
   * 开战结算是一条 generator 链：因为「拟定目标攻击」（强化士兵）要求
   * **轮到它出手时**由玩家指定目标（作者裁决），结算到一半必须能停下来问人。
   *
   * 停下来走引擎既有的挂起协议：driveGenerator 返回 PENDING 时，
   * `state.pending = { request, gen }` 已经由 driveGenerator 挂好，
   * 玩家答完由 choices.js 的 resolveChoice 接着驱动这条链。
   * 此时阶段**保持在 COMBAT**，所以重入（例如又点了一次「结束阶段」）
   * 不会从头再结算一遍。
   */
  else if (phase === 'COMBAT') {
    const r = driveGenerator(state, runCombat(state));
    if (r === PENDING) return state.phase;
  } else if (phase === 'TURN_END') onTurnEnd(state);
  flushTriggers(state);
  checkGameOver(state);
  return state.phase;
}

/** 推进到下一阶段；TURN_END 之后进入下一回合 */
export function advance(state) {
  if (isOver(state)) return state.phase;
  if (state.pending) throw new Error('存在待处理的交互请求，无法推进');

  if (state.phase === 'TURN_END') {
    if (state.turn >= MAX_TURNS) {
      resolveByTurnLimit(state);
      return state.phase;
    }
    state.turn += 1;
    enterPhase(state, 'TURN_START');
    return state.phase;
  }

  const idx = PHASES.indexOf(state.phase);
  if (idx < 0) throw new Error(`未知阶段: ${state.phase}`);
  enterPhase(state, PHASES[idx + 1]);
  return state.phase;
}

export function onTurnStart(state) {
  state.extraAttackUsed = {};
  state._pendingDeaths = [];

  // 费用重置（规则书 §6）：上限 = 回合数 + 本回合的临时加成 + 固定加成
  // flatManaBonus 是给「噩梦难度 AI」这类需要每回合稳定多几点费用的场景用的，
  // 普通对局里它始终是 0（见 app/js/ai.js 的 applyDifficultyBonus）。
  for (const p of state.players) {
    p.manaCapBonus = 0;
    // 「对方下回合少 1 费」（卡牌「盗贼」）：上回合记下的欠费在这一刻结清，然后清零。
    // 必须在**重置费用时**扣 —— 减在别处会被这次重置直接覆盖掉。
    const penalty = p.manaPenalty || 0;
    p.manaPenalty = 0;
    p.manaCap = Math.max(0, manaCapForTurn(state.turn) + (p.flatManaBonus || 0) - penalty);
    p.mana = p.manaCap;
  }
  // 「拟定目标攻击」是每回合重新指定的（沿用旧目标会打错人）
  state.combatPlans = {};
  // 同一回合里一个单位只问一次选目标（先制 + 追击共用第一次的答案）
  state.combatTargetAsked = {};
  M.log(state, { type: 'turn-start', turn: state.turn });

  // 「下个大回合开始时召唤」（阵营超能力「召唤仪式」）
  if (Array.isArray(state.delayedSummons) && state.delayedSummons.length) {
    const due = state.delayedSummons.filter((d) => d.atTurn <= state.turn);
    state.delayedSummons = state.delayedSummons.filter((d) => d.atTurn > state.turn);
    for (const d of due) {
      apiFor(state).summonToken(state, { cardId: d.cardId, side: d.side, lane: d.lane, row: d.row || 'front' });
    }
  }

  // 上回合遗留效果（淬毒 / 疾病）—— 裁决 B8：回合开始、费用重置那一刻结算
  resolveMarks(state);

  // 抽牌：后手先抽、先手后抽（规则书 §2）
  if (!(state.turn === 1 && !DRAW_ON_FIRST_TURN)) {
    M.drawCards(state, 1 - state.firstPlayer, 1);
    M.drawCards(state, state.firstPlayer, 1);
  }

  /**
   * 「回合开始:」异能（卡牌「第5伞兵旅：回合开始:抽两张牌,弃置一张手牌」）。
   *
   * 排在标准抽牌**之后**：标准抽牌是规则的一部分，
   * 卡牌的「回合开始」异能是在这个基础上再发生的事。
   * 顺序固定为 allUnits 的顺序（山地→水路、前排→后排），保证可复现。
   */
  for (const unit of M.allUnits(state)) {
    if (unit.removed) continue;
    if ((unit.effects || []).some((e) => e.trigger === 'onTurnStart')) {
      M.queueTrigger(state, unit, 'onTurnStart', { turn: state.turn });
    }
  }
}

export function onTurnEnd(state) {
  M.log(state, { type: 'turn-end', turn: state.turn });

  // 陷阱：已经触发过（本回合生效）的，效果结束就消失（作者 2026-10 口径）
  expireRevealedTraps(state);

  // 「本回合获得…」的临时词条到期（卡牌「炫彩糖果」）
  M.expireTimedKeywords(state);

  // 「无法选中」这类带到期回合的标记（卡牌「神威」）也要在回合结束时摘掉
  for (const unit of M.allUnits(state)) {
    if (unit.removed) continue;
    unit.marks = unit.marks.filter((m) => !(m.untilTurn && state.turn >= m.untilTurn));
  }
  // 伤害封顶到期（卡牌「反应装甲」）
  if (Array.isArray(state.damageCaps)) {
    state.damageCaps = state.damageCaps.filter((c) => c.turn >= state.turn);
  }

  // 线路封锁到期（卡牌「氢弹」）
  for (const lane of Object.keys(state.laneLocks || {})) {
    if (state.turn > state.laneLocks[lane]) delete state.laneLocks[lane];
  }

  // 牌库抽空 → 本回合结束时按国王血量判定（裁决 D13）
  if (state.deckEmpty) resolveByDeckOut(state);
}

/**
 * 牌库抽空时的终局判定（裁决 D13）：
 * 双方都抽不到牌之后，在**回合结束时**比较国王生命，高者获胜；相同则平局。
 */
export function resolveByDeckOut(state) {
  const [a, b] = state.players;
  if (a.kingHp === b.kingHp) {
    state.winner = 'draw';
    state.winReason = `牌库抽空，双方国王生命相同（${a.kingHp}）`;
  } else {
    state.winner = a.kingHp > b.kingHp ? 0 : 1;
    state.winReason = `牌库抽空，国王生命更高（${a.kingHp} vs ${b.kingHp}）`;
  }
  M.log(state, { type: 'game-over', winner: state.winner, reason: state.winReason });
}

export function resolveMarks(state) {
  for (const unit of M.allUnits(state)) {
    if (unit.removed) continue;
    const marks = unit.marks.splice(0);
    for (const mark of marks) {
      if (unit.removed) break;
      if (mark.type === 'poison') {
        M.log(state, { type: 'poison-tick', uid: unit.uid, x: mark.x });
        // 「无视任何机制」但「无敌」仍然生效（裁决 B7）
        M.dealDamage(state, null, { kind: 'unit', unit }, mark.x, {
          ignoreMechanisms: true, noKeywords: true,
        });
      } else if (mark.type === 'disease') {
        M.log(state, { type: 'disease-tick', uid: unit.uid });
        M.destroyUnit(state, unit, 'disease');
      }
    }
    // 淬毒/疾病导致的死亡之后再做轻灵检查
    M.checkNimble(state, unit);
  }

  // 国王也会中毒（作者 2026-10 要求）。国王没有 marks 容器，标记记在玩家对象上。
  // 与单位中毒同口径：下一次 TURN_START 结算一次，然后标记被消费掉。
  for (const p of state.players) {
    const kingMarks = (p.kingMarks || []).splice(0);
    for (const mark of kingMarks) {
      if (mark.type !== 'poison') continue;
      M.log(state, { type: 'poison-tick', kingSide: p.side, x: mark.x });
      M.dealDamage(state, null, { kind: 'king', side: p.side }, mark.x, {
        ignoreMechanisms: true, noKeywords: true,
      });
    }
  }
}

export function resolveByTurnLimit(state) {
  const [a, b] = state.players;
  if (a.kingHp === b.kingHp) {
    state.winner = 'draw';
    state.winReason = `第 ${MAX_TURNS} 回合结束，国王生命相同（${a.kingHp}）`;
  } else {
    state.winner = a.kingHp > b.kingHp ? 0 : 1;
    state.winReason = `第 ${MAX_TURNS} 回合结束，国王生命更高（${a.kingHp} vs ${b.kingHp}）`;
  }
  M.log(state, { type: 'game-over', winner: state.winner, reason: state.winReason });
}

export function checkGameOver(state) {
  if (state.winner !== null) return true;
  const [a, b] = state.players;
  if (a.kingHp <= 0 && b.kingHp <= 0) {
    state.winner = 'draw';
    state.winReason = '双方国王同时归零（裁决 A3：判平局）';
  } else if (a.kingHp <= 0) {
    state.winner = 1;
    state.winReason = '先手国王被击破';
  } else if (b.kingHp <= 0) {
    state.winner = 0;
    state.winReason = '后手国王被击破';
  }
  if (state.winner !== null) M.log(state, { type: 'game-over', winner: state.winner, reason: state.winReason });
  return state.winner !== null;
}

// ══════════════════════════════════════════════════════════
// 开局
// ══════════════════════════════════════════════════════════

/** 开局：发起始手牌并进入第 1 回合 */
/**
 * 献祭（恶魔阵营「结束回合」左边那个按钮走这里）。
 *
 * 献祭算作被消灭  会触发「被消灭」与「有队友被献祭」两类观察者，
 * 所以和 playCard 一样要当场把触发队列结算完，不能只排进队列就返回。
 */
export function sacrificeUnit(state, side, uid) {
  const ok = sacrificeUnitOnBoard(state, side, uid);
  if (ok) flushTriggers(state);
  return ok;
}

export function startGame(state) {
  state.turn = 1;
  // 起手从共享牌库取：先手 5 张、后手 4 张（规则书 §2）
  M.drawCards(state, state.firstPlayer, 5);
  M.drawCards(state, 1 - state.firstPlayer, 4);
  // 阵营超能力：对局开始时双方各抽一张（作者 2026-10-03）
  giveStartingSuperpowers(state);
  enterPhase(state, 'TURN_START');
  return state;
}

// ══════════════════════════════════════════════════════════
// 手牌内被动（卡牌「黑龙」）
// ══════════════════════════════════════════════════════════

/**
 * 「在手牌中:在你出牌时…」——手牌里的牌也能有被动（卡牌「黑龙」）。
 *
 * 写法（卡牌定义上的 `inHand` 数组）：
 *   inHand: [{
 *     buff: { atk: 1, maxHp: 1 },      // 默认：每次出牌给这张手牌累积 +1⚔+1♥
 *     ifAtkAbove: 6,                   // 一旦（卡面攻击 + 已累积）**超过**这个数…
 *     thenInstead: { costDelta: -1 },  // …就改成降 1 费，不再加身材
 *   }]
 *
 * 累积值存在**手牌实例**上（`statDelta` / `costDelta`），
 * 打出时由 playCard 应用到落地后的单位上 —— 同一张卡的不同副本互不影响。
 */
export function triggerInHandEffects(state, side) {
  const p = state.players[side];
  for (const hc of p.hand) {
    const def = state.cardLib[hc.cardId];
    if (!def || !Array.isArray(def.inHand)) continue;
    for (const eff of def.inHand) {
      const delta = hc.statDelta || (hc.statDelta = { atk: 0, maxHp: 0 });
      const atkNow = (def.atk || 0) + (delta.atk || 0);
      if (eff.ifAtkAbove !== undefined && atkNow > eff.ifAtkAbove && eff.thenInstead) {
        hc.costDelta = (hc.costDelta || 0) + (eff.thenInstead.costDelta || 0);
        M.log(state, { type: 'in-hand', cardId: hc.cardId, branch: 'cost', costDelta: hc.costDelta });
      } else if (eff.buff) {
        delta.atk += eff.buff.atk || 0;
        delta.maxHp += eff.buff.maxHp || 0;
        M.log(state, { type: 'in-hand', cardId: hc.cardId, branch: 'stats', atk: delta.atk, maxHp: delta.maxHp });
      }
    }
  }
}

/** 把手上累积的数值修正应用到刚落地的单位上（见 triggerInHandEffects） */
export function applyHandStatDelta(state, unit, handCard) {
  const d = handCard && handCard.statDelta;
  if (!d) return;
  if (d.atk) M.buffAtk(state, unit, d.atk);
  if (d.maxHp) M.buffMaxHp(state, unit, d.maxHp);
}
